import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import {
  configure,
  createRegistry,
  defineDoc,
  Harness,
  type Conversation,
  type ModelRef,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ExecutionRootDoc } from "./execution-binding.js";
import { executionRootBytes, parseExecutionRoot, type ExecutionRoot } from "./execution-wire.js";
import { acquireLock } from "./lock.js";
import type { Command } from "./process.js";
import { isIdentityName } from "./workspace-identity.js";

export type CodingWorkspace = {
  readonly domain: "personal" | "work";
  readonly nodeId: string;
  readonly workspaceId: string;
  readonly cwd: string;
};

export const CodingWorkspaceDoc = defineDoc<{ workspace: CodingWorkspace | null }>({
  kind: "herdr.coding-workspace",
  version: 1,
  scope: "session",
  initial: () => ({ workspace: null }),
});

export type OpenCodingWorkspaceOptions = {
  readonly stateDirectory: string;
  readonly workspace: CodingWorkspace;
  readonly models: Models;
  readonly model: ModelRef;
  readonly initialThinkingLevel?: ModelThinkingLevel;
  readonly execution: "trusted-user";
  readonly startup?: "automatic" | "deferred";
  readonly lockCommand: Command;
} & (
  | { readonly registry?: Registry; readonly management?: undefined }
  | { readonly registry: Registry; readonly management: { readonly root: ExecutionRoot; readonly initialization: "new" | "existing" } }
);

function parseWorkspace(value: unknown): CodingWorkspace {
  if (
    typeof value !== "object" ||
    value === null ||
    !("domain" in value) ||
    (value.domain !== "personal" && value.domain !== "work") ||
    !("nodeId" in value) ||
    !isIdentityName(value.nodeId) ||
    !("workspaceId" in value) ||
    !isIdentityName(value.workspaceId) ||
    !("cwd" in value) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd)
  )
    throw new Error("Invalid coding workspace binding");
  return Object.freeze({
    domain: value.domain,
    nodeId: value.nodeId,
    workspaceId: value.workspaceId,
    cwd: value.cwd,
  });
}

async function privateStateDirectory(path: string, initialization: "open" | "new" | "existing"): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Coding state directory must be absolute");
  if (initialization !== "existing") await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error("Coding state directory must be private and owned by this user");
  const directory = await realpath(path);
  try {
    await lstat(join(directory, "jobs.sqlite"));
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return directory;
    throw error;
  }
  throw new Error("Coding state must be separate from jobs.sqlite");
}

async function privateDatabase(path: string, initialization: "open" | "new" | "existing"): Promise<void> {
  const creation = initialization === "existing" ? 0 : constants.O_CREAT | (initialization === "new" ? constants.O_EXCL : 0);
  const file = await open(path, creation | constants.O_RDWR | constants.O_NOFOLLOW, 0o600).catch(error => {
    if (initialization === "new" && error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error("Refusing to initialize execution ownership in an existing coding store");
    throw error;
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
      throw new Error("Coding database must be private and owned by this user");
    if (info.nlink !== 1) throw new Error("Coding database must not have hard-linked aliases");
  } finally {
    await file.close();
  }
}

export class PreparedCodingWorkspace {
  #opening: Promise<CodingWorkspaceOwner> | null = null;
  #closing: Promise<void> | null = null;

  constructor(
    private readonly activate: (context: Context) => Promise<CodingWorkspaceOwner>,
    private readonly release: () => Promise<void>,
  ) {}

  open(context: Context): Promise<CodingWorkspaceOwner> {
    if (this.#closing !== null) return Promise.reject(new Error("Prepared coding workspace is closed"));
    this.#opening ??= this.activate(context).catch(async error => {
      try { await this.release(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Coding workspace open and cleanup failed"); }
      throw error;
    });
    return this.#opening;
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      await this.#opening?.catch(() => undefined);
      await this.release();
    })();
    return this.#closing;
  }
}

async function inspectCodingStorage(
  storage: Storage,
  workspace: CodingWorkspace,
  management: OpenCodingWorkspaceOptions["management"],
  context: Context,
): Promise<void> {
  async function document(definition: { readonly kind: string; readonly version: number }) {
    const record = await storage.findDocument({ kind: definition.kind, scope: { kind: "session" } }, "current", context);
    if (record === undefined) return undefined;
    const stored = await storage.document(record.id, "current", context);
    if (stored === undefined || stored.version !== definition.version)
      throw new Error("Coding workspace document version is missing or changed");
    return stored.value;
  }
  const execution = await document(ExecutionRootDoc.definition);
  const coding = await document(CodingWorkspaceDoc.definition);
  const conversations = await storage.scanConversations({}, 1, undefined, context);
  if (execution !== undefined && (Object.keys(execution).length !== 1 || !("rootJson" in execution) || (execution.rootJson !== null && typeof execution.rootJson !== "string")))
    throw new Error("Invalid coding execution marker");
  if (management === undefined) {
    if (execution !== undefined && execution.rootJson !== null)
      throw new Error("Managed coding workspace requires execution ownership");
  } else if (management.initialization === "new") {
    if (execution !== undefined || coding !== undefined || conversations.items.length !== 0)
      throw new Error("Refusing to initialize execution ownership in an existing coding store");
  } else if (execution?.rootJson !== executionRootBytes(management.root) || coding?.workspace === undefined || coding.workspace === null || conversations.items.length === 0) {
    throw new Error("Managed coding execution identity is missing or changed");
  }
  if (coding?.workspace !== undefined && coding.workspace !== null) {
    if (!isDeepStrictEqual(parseWorkspace(coding.workspace), workspace))
      throw new Error("Coding workspace binding mismatch");
  } else if (conversations.items.length !== 0) {
    throw new Error("Refusing to bind an existing unbound conversation store");
  }
}

export class CodingWorkspaceOwner {
  readonly execution = "trusted-user";
  #closing: Promise<void> | null = null;

  private constructor(
    readonly workspace: CodingWorkspace,
    readonly stateDirectory: string,
    readonly databasePath: string,
    readonly harness: Harness,
    readonly conversation: Conversation,
    private readonly closeResources: () => Promise<void>,
  ) {}

  static async open(options: OpenCodingWorkspaceOptions, context: Context): Promise<CodingWorkspaceOwner> {
    return (await this.prepare(options, context)).open(context);
  }

  static async prepare(
    options: OpenCodingWorkspaceOptions,
    context: Context,
  ): Promise<PreparedCodingWorkspace> {
    context.abortSignal?.throwIfAborted();
    if (options.execution !== "trusted-user")
      throw new Error("Node execution requires explicit trusted-user access; it is not a sandbox");
    const requested = parseWorkspace(options.workspace);
    const management = options.management === undefined ? undefined : {
      root: parseExecutionRoot(executionRootBytes(options.management.root)), initialization: options.management.initialization,
    };
    if (management !== undefined && options.registry === undefined)
      throw new Error("Managed coding workspaces require an explicit tool registry");
    const cwd = await realpath(requested.cwd);
    if (!(await lstat(cwd)).isDirectory()) throw new Error("Coding workspace cwd must be a directory");
    const workspace: CodingWorkspace = Object.freeze({ ...requested, cwd });
    if (management !== undefined && !isDeepStrictEqual(management.root.workspace, workspace))
      throw new Error("Managed execution root differs from its coding workspace");
    const initialization = management?.initialization ?? "open";
    const stateDirectory = await privateStateDirectory(options.stateDirectory, initialization);
    const unlock = await acquireLock(stateDirectory, options.lockCommand, {
      name: "conversation.lock",
      waitSeconds: 0,
    });
    const databasePath = join(stateDirectory, "conversation.sqlite");
    const environment = new NodeExecutionEnv({ cwd });
    let closeStorage: (() => Promise<void>) | null = null;
    let closing: Promise<void> | null = null;
    const closeResources = () => closing ??= (async () => {
      const steps = [
        ...(closeStorage === null ? [] : [closeStorage]),
        () => environment.cleanup(BACKGROUND_CONTEXT),
        unlock,
      ];
      const errors: unknown[] = [];
      for (const close of steps) {
        try {
          await close();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1)
        throw new AggregateError(errors, "Coding workspace cleanup failed");
    })();
    try {
      await privateDatabase(databasePath, initialization);
      const database = await openNodeSqliteDatabase(databasePath);
      closeStorage = () => database.close();
      await database.exec("PRAGMA synchronous = FULL");
      const storage = await SqliteStorage.open(database);
      closeStorage = () => storage.close(BACKGROUND_CONTEXT);
      const journal = await database.get<{ journal_mode: unknown }>("PRAGMA journal_mode");
      const synchronization = await database.get<{ synchronous: unknown }>("PRAGMA synchronous");
      if (journal?.journal_mode !== "wal" || (synchronization?.synchronous !== 2 && synchronization?.synchronous !== 3))
        throw new Error("Coding storage requires WAL SQLite with FULL synchronization");
      await inspectCodingStorage(storage, workspace, management, context);
      const registry = options.registry ?? createRegistry();
      if (options.registry === undefined) registry.install(CodingTools);
      return new PreparedCodingWorkspace(async context => {
      const harness = await Harness.open(
        storage,
        {
          models: options.models,
          registry,
          env: (target) => {
            if (target.cwd !== undefined && target.cwd !== workspace.cwd)
              throw new Error("Conversation cwd differs from its immutable coding workspace");
            return environment;
          },
          conversationCreated: (tx, conversation) => configure(tx, conversation.id, { cwd }),
        },
        context,
      );
      closeStorage = () => harness.close(BACKGROUND_CONTEXT);
      await harness.commit(async (tx) => {
        const conversations = await tx.scanConversations({}, 1);
        const doc = await tx.doc(CodingWorkspaceDoc);
        const execution = await tx.doc(ExecutionRootDoc);
        if (management === undefined) {
          if (execution.rootJson !== null)
            throw new Error("Managed coding workspace requires execution ownership");
        } else if (management.initialization === "new") {
          if (execution.rootJson !== null || doc.workspace !== null || conversations.items.length !== 0)
            throw new Error("Refusing to initialize execution ownership in an existing coding store");
          execution.rootJson = executionRootBytes(management.root);
        } else if (execution.rootJson !== executionRootBytes(management.root) || doc.workspace === null || conversations.items.length === 0) {
          throw new Error("Managed coding execution identity is missing or changed");
        }
        if (doc.workspace === null) {
          if (conversations.items.length !== 0)
            throw new Error("Refusing to bind an existing unbound conversation store");
          doc.workspace = { ...workspace };
          return;
        }
        const stored = parseWorkspace(doc.workspace);
        if (
          stored.domain !== workspace.domain ||
          stored.nodeId !== workspace.nodeId ||
          stored.workspaceId !== workspace.workspaceId ||
          stored.cwd !== workspace.cwd
        )
          throw new Error("Coding workspace binding mismatch");
      }, context);
      const conversation = await harness.root(context, {
        agent: { model: options.model, thinkingLevel: options.initialThinkingLevel, cwd },
        init: () => {
          if (options.models.getModel(options.model.provider, options.model.modelId) === undefined)
            throw new Error("Coding model is not installed in the supplied Models");
        },
      });
      const agent = await conversation.agent(context);
      if (agent.cwd !== cwd)
        throw new Error("Stored conversation cwd differs from its immutable coding workspace");
      if (
        agent.model === undefined ||
        options.models.getModel(agent.model.provider, agent.model.modelId) === undefined
      )
        throw new Error("Stored coding model is not installed in the supplied Models");
      const owner = new CodingWorkspaceOwner(
        workspace,
        stateDirectory,
        databasePath,
        harness,
        conversation,
        closeResources,
      );
      if (management === undefined && options.startup !== "deferred") harness.resume();
      return owner;
      }, closeResources);
    } catch (error) {
      try {
        await closeResources();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Coding workspace open and cleanup failed");
      }
      throw error;
    }
  }

  close(): Promise<void> {
    this.#closing ??= this.closeResources();
    return this.#closing;
  }
}
