import { randomBytes, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { CommandRuntime, type CommandObservation, type CommandSource, type ContainmentWitness } from "./command-runtime.js";
import { CommandDirectory } from "./command-store.js";
import { parseCommandEvidence, parseCommandSpec, type CommandEvidence } from "./command-wire.js";
import type { CommandState, ExecutionState } from "./execution-domain.js";
import { ExecutionJournal } from "./execution-journal.js";
import { executionDigest, parseExecutionEvent, type ExecutionEvent, type RecordedCommandInvocation } from "./execution-wire.js";

type Work = { readonly kind: "open"; tail: Promise<void> } | { readonly kind: "closing"; readonly completion: Promise<void> };
type Capture = { readonly kind: "live" | "retiring"; readonly source: CommandSource };
type Options = {
  readonly journal: ExecutionJournal;
  readonly directory: CommandDirectory;
  readonly runtime: CommandRuntime;
  readonly sourceBootId: string;
};
export type CommandAuthorizationInput = {
  readonly intentId: string;
  readonly argv: readonly string[];
  readonly timeoutSeconds: number;
};
export type CommandGrant = "live" | "expired" | "revoked" | "consumed";
export type TrustedReconciliation = {
  readonly intentId: string;
  readonly actor: string;
  readonly reference: string;
  readonly containment: { readonly kind: "manager" } | { readonly kind: "trusted-offline"; readonly reference: string };
};

function original(command: CommandState): CommandEvidence | undefined {
  const phase = command.phase;
  switch (phase.kind) {
    case "authorized": case "attempted": return undefined;
    case "activated": return parseCommandEvidence(phase.activation.evidenceJson);
    case "adopted": return parseCommandEvidence(phase.original.activation.evidenceJson);
    case "reconciled": return phase.original.kind === "activated" ? parseCommandEvidence(phase.original.activation.evidenceJson) : undefined;
    default: { const exhaustive: never = phase; throw new Error(`Unsupported command phase ${exhaustive}`); }
  }
}

export class ExecutionCommands {
  static readonly #owners = new WeakSet<ExecutionJournal>();
  #work: Work = { kind: "open", tail: Promise.resolve() };
  readonly #captures = new Map<string, Capture>();

  private constructor(private readonly options: Options) {}

  static async open(options: Options): Promise<ExecutionCommands> {
    if (this.#owners.has(options.journal)) throw new Error("Execution journal already has a command owner");
    this.#owners.add(options.journal);
    const owner = new ExecutionCommands(options);
    try { await owner.snapshot(); return owner; }
    catch (error) { this.#owners.delete(options.journal); throw error; }
  }

  private run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#work.kind !== "open") return Promise.reject(new Error("Execution command owner is closed"));
    const completion = this.#work.tail.then(operation);
    this.#work.tail = completion.then(() => undefined, () => undefined);
    return completion;
  }

  private async inspectState(): Promise<ExecutionState> {
    const { state } = await this.options.journal.snapshot();
    const names = new Set(await readdir(this.options.directory.path));
    if (names.size !== state.commands.size) throw new Error("Command directory history is missing or orphaned");
    for (const command of state.commands.values()) {
      const spec = parseCommandSpec(command.authorization.specJson);
      if (!names.delete(spec.executionId)) throw new Error("Authorized command directory is missing");
      const directory = await this.options.directory.child(spec.executionId, "existing");
      if (await directory.read("spec.json", 32768) !== command.authorization.specJson)
        throw new Error("Command spec differs from immutable authorization");
      if (command.phase.kind === "authorized") {
        const files = await readdir(directory.path);
        if (files.length !== 1 || files[0] !== "spec.json")
          throw new Error("Unattempted command has unexpected execution evidence");
      }
    }
    return state;
  }

  private async command(intentId: string): Promise<CommandState> {
    const command = (await this.inspectState()).commands.get(intentId);
    if (command === undefined) throw new Error("Command intent is not authorized");
    return command;
  }

  private async job(command: CommandState) {
    const spec = parseCommandSpec(command.authorization.specJson);
    const directory = await this.options.directory.child(spec.executionId, "existing");
    return { directory, spec, digest: command.authorization.specSha256 };
  }

  private grant(command: CommandState): CommandGrant {
    if (command.phase.kind !== "authorized") return "consumed";
    if (command.cancellation === "requested") return "revoked";
    return command.authorization.sourceBootId === this.options.sourceBootId && this.#captures.get(command.authorization.captureEpoch)?.kind === "live" ? "live" : "expired";
  }

  private async retire(captureEpoch: string): Promise<void> {
    const capture = this.#captures.get(captureEpoch);
    if (capture === undefined) return;
    this.#captures.set(captureEpoch, { kind: "retiring", source: capture.source });
    await capture.source.close();
    this.#captures.delete(captureEpoch);
  }

  snapshot(): Promise<ExecutionState> { return this.run(() => this.inspectState()); }

  describe(intentId: string): Promise<{ readonly command: CommandState; readonly grant: CommandGrant }> {
    return this.run(async () => { const command = await this.command(intentId); return { command, grant: this.grant(command) }; });
  }

  authorize(input: CommandAuthorizationInput): Promise<CommandState> {
    const approved = { intentId: input.intentId, argv: [...input.argv], timeoutSeconds: input.timeoutSeconds };
    const inputSha256 = executionDigest(JSON.stringify({ argv: approved.argv, timeoutSeconds: approved.timeoutSeconds }));
    return this.run(async () => {
      const existing = (await this.inspectState()).commands.get(approved.intentId);
      if (existing !== undefined) {
        if (existing.authorization.inputSha256 !== inputSha256) throw new Error("Command intent conflicts with immutable authorization");
        return existing;
      }
      const { journal, runtime, directory, sourceBootId } = this.options;
      const captureEpoch = randomBytes(32).toString("hex");
      const source = await runtime.capture(journal.root.workspace.cwd);
      this.#captures.set(captureEpoch, { kind: "retiring", source });
      try {
        const spec = parseCommandSpec(JSON.stringify({
          version: 1, executionId: randomUUID(), workspaceId: journal.root.workspace.workspaceId,
          intentId: approved.intentId, nonce: randomBytes(32).toString("hex"), unit: `hdj-${randomUUID()}.service`,
          cwd: journal.root.workspace.cwd, argv: approved.argv, timeoutSeconds: approved.timeoutSeconds,
          mode: "trusted-user-mapped-fs", environmentSha256: source.environmentSha256, context: source.context,
        }));
        const specJson = JSON.stringify(spec);
        const event = parseExecutionEvent(JSON.stringify({
          kind: "command.authorized", specJson, specSha256: executionDigest(specJson), inputSha256, sourceBootId, captureEpoch,
        }), journal.root);
        const job = await directory.child(spec.executionId, "new");
        await job.create("spec.json", specJson);
        await journal.append(event);
        const authorized = await this.command(approved.intentId);
        this.#captures.set(captureEpoch, { kind: "live", source });
        return authorized;
      } catch (error) {
        try { await this.retire(captureEpoch); }
        catch (cleanup) { throw new AggregateError([error, cleanup], "Command authorization and source cleanup failed"); }
        throw error;
      }
    });
  }

  start(intentId: string, sdk: RecordedCommandInvocation): Promise<CommandState> {
    const provenance = { ...sdk };
    return this.run(async () => {
      const command = await this.command(intentId);
      if (command.phase.kind !== "authorized") return command;
      if (this.grant(command) !== "live") throw new Error("Command source grant is expired or revoked; authorize a new intent");
      const capture = this.#captures.get(command.authorization.captureEpoch);
      if (capture?.kind !== "live") throw new Error("Live command source authority unavailable");
      const source = capture.source;
      const job = await this.job(command);
      await this.options.journal.append({ kind: "command.attempted", intentId, sdk: provenance });
      this.#captures.set(command.authorization.captureEpoch, { kind: "retiring", source });
      const failures: unknown[] = [];
      try {
        await this.options.runtime.launch({ ...job, source, activation: async evidence => {
          await this.options.journal.append({ kind: "command.activated", intentId, evidenceJson: JSON.stringify(evidence) });
        } });
      } catch (error) { failures.push(error); }
      try { await this.retire(command.authorization.captureEpoch); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Command attempt requires inspection");
      return this.command(intentId);
    });
  }

  private async observe(command: CommandState): Promise<CommandObservation> {
    if (command.phase.kind === "authorized") throw new Error("Command has no attempt to inspect");
    const observation = await this.options.runtime.inspect({ ...await this.job(command), evidence: original(command) });
    if ((observation.outcome.kind === "recorded" && observation.outcome.receipt.evidence.activation.bootId !== command.authorization.sourceBootId)
      || (observation.containment.kind !== "unknown" && observation.containment.evidence.activation.bootId !== command.authorization.sourceBootId))
      return { outcome: { kind: "unobserved" }, containment: { kind: "unknown", reason: "binding-mismatch" } };
    return observation;
  }

  inspect(intentId: string): Promise<CommandObservation> {
    return this.run(async () => this.observe(await this.command(intentId)));
  }

  adopt(intentId: string): Promise<CommandState> {
    return this.run(async () => {
      const command = await this.command(intentId);
      if (command.phase.kind !== "activated") return command;
      const observation = await this.observe(command);
      if (observation.outcome.kind !== "recorded" || observation.containment.kind !== "empty") return command;
      await this.options.journal.append({ kind: "command.adopted", intentId,
        receiptJson: JSON.stringify(observation.outcome.receipt), containment: observation.containment.witness });
      return this.command(intentId);
    });
  }

  cancel(intentId: string): Promise<CommandState> {
    return this.run(async () => {
      let command = await this.command(intentId);
      if (command.phase.kind === "adopted" || command.phase.kind === "reconciled") return command;
      if (command.cancellation !== "requested") {
        await this.options.journal.append({ kind: "command.cancel-requested", intentId });
        command = await this.command(intentId);
      }
      if (command.phase.kind === "authorized") {
        await this.retire(command.authorization.captureEpoch);
      } else await this.options.runtime.cancel(await this.job(command));
      return command;
    });
  }

  reconcile(input: TrustedReconciliation): Promise<CommandState> {
    const approved = { ...input, containment: { ...input.containment } };
    return this.run(async () => {
      const command = await this.command(approved.intentId);
      let containment: Extract<ExecutionEvent, { kind: "command.reconciled" }>["containment"];
      if (approved.containment.kind === "manager") {
        const observation = await this.observe(command);
        if (command.phase.kind !== "activated" || observation.containment.kind !== "empty")
          throw new Error("Original empty command containment is not independently proven");
        containment = { kind: "manager", witness: observation.containment.witness };
      } else containment = approved.containment;
      await this.options.journal.append({ kind: "command.reconciled", intentId: approved.intentId,
        actor: approved.actor, reference: approved.reference, containment });
      return this.command(approved.intentId);
    });
  }

  release(intentId: string): Promise<void> {
    return this.run(async () => {
      const command = await this.command(intentId);
      let witness: ContainmentWitness;
      if (command.phase.kind === "adopted") witness = command.phase.adoption.containment;
      else if (command.phase.kind === "reconciled" && command.phase.reconciliation.containment.kind === "manager")
        witness = command.phase.reconciliation.containment.witness;
      else throw new Error("Namespace release requires durable adoption or proven manager reconciliation");
      const evidence = original(command);
      if (evidence === undefined) throw new Error("Namespace release has no original activation");
      await this.options.runtime.release({ ...await this.job(command), evidence, containment: witness });
    });
  }

  close(): Promise<void> {
    if (this.#work.kind === "closing") return this.#work.completion;
    const completion = this.#work.tail.then(async () => {
      try {
        const results = await Promise.allSettled([...this.#captures.values()].map(capture => capture.source.close()));
        this.#captures.clear();
        const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
        if (failures.length) throw new AggregateError(failures, "Command grant cleanup failed");
      } finally { ExecutionCommands.#owners.delete(this.options.journal); }
    });
    this.#work = { kind: "closing", completion };
    return completion;
  }
}
