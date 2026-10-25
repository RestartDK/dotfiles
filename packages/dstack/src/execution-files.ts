import type { Context, JsonValue } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineExtension, wrapTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import type { ExecutionJournal } from "./execution-journal.js";
import { executionDigest, type RecordedSdkCall } from "./execution-wire.js";
import type { WorkspacePaths } from "./workspace-paths.js";

type Invocation =
  | { readonly kind: "read" }
  | {
      readonly kind: "mutation";
      readonly tool: "write" | "edit";
      readonly journal: ExecutionJournal;
      readonly sdk: RecordedSdkCall;
      readonly argumentsSha256: string;
    };

export function recordedSdkCall(api: Pick<ToolExecutionApi, "taskId" | "conversationId" | "callId">): RecordedSdkCall {
  return { taskKey: String(api.taskId), conversationKey: String(api.conversationId), callId: api.callId };
}

function argumentsDigest(value: object): string {
  const bytes = JSON.stringify(value);
  if (bytes === undefined || Buffer.byteLength(bytes) > 1024 * 1024)
    throw new Error("File tool arguments exceed the execution limit");
  return executionDigest(bytes);
}

class WorkspaceFileEnvironment extends NodeExecutionEnv {
  constructor(private readonly paths: WorkspacePaths, private readonly invocation: Invocation) {
    super({ cwd: paths.cwd });
  }

  private async checked(path: string, access: "read" | "write", context: Context): Promise<string> {
    context.abortSignal?.throwIfAborted();
    if (this.cwd !== this.paths.cwd) throw new Error("File environment cwd differs from its coding workspace");
    const target = getOrThrow(await super.absolutePath(path, context));
    const checked = await this.paths.check(target, access);
    context.abortSignal?.throwIfAborted();
    return checked;
  }

  override async absolutePath(path: string, context: Context) {
    return { ok: true, value: await this.checked(path, this.invocation.kind === "read" ? "read" : "write", context) } satisfies Awaited<ReturnType<NodeExecutionEnv["absolutePath"]>>;
  }

  override async exists(path: string, context: Context) {
    return super.exists(await this.checked(path, "read", context), context);
  }

  override async fileInfo(path: string, context: Context) {
    return super.fileInfo(await this.checked(path, "read", context), context);
  }

  override async readTextFile(path: string, context: Context) {
    return super.readTextFile(await this.checked(path, "read", context), context);
  }

  override async readBinaryFile(path: string, context: Context) {
    return super.readBinaryFile(await this.checked(path, "read", context), context);
  }

  override async openBinaryReader(...[path, options, context]: Parameters<NodeExecutionEnv["openBinaryReader"]>) {
    return super.openBinaryReader(await this.checked(path, "read", context), options, context);
  }

  override async openTextLineReader(path: string, context: Context) {
    return super.openTextLineReader(await this.checked(path, "read", context), context);
  }

  override async readTextLines(...[path, options, context]: Parameters<NodeExecutionEnv["readTextLines"]>) {
    return super.readTextLines(await this.checked(path, "read", context), options, context);
  }

  override async listDir(path: string, context: Context) {
    return super.listDir(await this.checked(path, "read", context), context);
  }

  override async openDirReader(path: string, context: Context) {
    return super.openDirReader(await this.checked(path, "read", context), context);
  }

  override async canonicalPath(path: string, context: Context) {
    return super.canonicalPath(await this.checked(path, "read", context), context);
  }

  override async writeFile(...[path, content, context]: Parameters<NodeExecutionEnv["writeFile"]>) {
    if (this.invocation.kind !== "mutation") throw new Error("Read tool cannot mutate workspace files");
    const target = await this.checked(path, "write", context);
    const { journal, sdk, tool, argumentsSha256 } = this.invocation;
    const effectId = executionDigest(JSON.stringify([journal.root.rootId, sdk.conversationKey, sdk.taskKey, sdk.callId, tool]));
    await journal.append({ kind: "file.started", effectId, tool, path: target, argumentsSha256, sdk });
    const result = await super.writeFile(target, content, BACKGROUND_CONTEXT);
    if (result.ok) await journal.append({ kind: "file.adopted", effectId });
    return result;
  }

  override async exec(..._args: Parameters<NodeExecutionEnv["exec"]>): Promise<never> { throw new Error("Shell execution requires durable command ownership"); }
  override async appendFile(..._args: Parameters<NodeExecutionEnv["appendFile"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async truncateFile(..._args: Parameters<NodeExecutionEnv["truncateFile"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async flushFile(..._args: Parameters<NodeExecutionEnv["flushFile"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async renameFile(..._args: Parameters<NodeExecutionEnv["renameFile"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async createDir(..._args: Parameters<NodeExecutionEnv["createDir"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async remove(..._args: Parameters<NodeExecutionEnv["remove"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async createTempDir(..._args: Parameters<NodeExecutionEnv["createTempDir"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async createTempFile(..._args: Parameters<NodeExecutionEnv["createTempFile"]>): Promise<never> { throw new Error("Unsupported model file mutation"); }
  override async watch(..._args: Parameters<NodeExecutionEnv["watch"]>): Promise<never> { throw new Error("Model file tools cannot install filesystem watchers"); }
}

export function executionFileTools(options: { readonly journal: ExecutionJournal; readonly paths: WorkspacePaths }) {
  const { journal, paths } = options;
  if (journal.root.workspace.cwd !== paths.cwd) throw new Error("Execution journal and file workspace differ");
  const read = createReadTool(), write = createWriteTool(), edit = createEditTool();
  function scoped<TDetails extends JsonValue>(api: ToolExecutionApi<TDetails>, invocation: Invocation): ToolExecutionApi<TDetails> {
    if (!(api.env instanceof NodeExecutionEnv) || api.env.cwd !== paths.cwd)
      throw new Error("Managed file tools require the workspace's local Node environment");
    return { ...api, env: new WorkspaceFileEnvironment(paths, invocation) };
  }
  return defineExtension({
    name: "herdr-execution-files",
    tools: [read, write, edit],
    wraps: [
      wrapTool(read, tool => ({ ...tool, execute: (args, api, context) => tool.execute(args, scoped(api, { kind: "read" }), context) })),
      wrapTool(write, tool => ({ ...tool, executionMode: "sequential", execute: (args, api, context) => tool.execute(args, scoped(api, { kind: "mutation", tool: "write", journal, sdk: recordedSdkCall(api), argumentsSha256: argumentsDigest(args) }), context) })),
      wrapTool(edit, tool => ({ ...tool, executionMode: "sequential", execute: (args, api, context) => tool.execute(args, scoped(api, { kind: "mutation", tool: "edit", journal, sdk: recordedSdkCall(api), argumentsSha256: argumentsDigest(args) }), context) })),
    ],
  });
}
