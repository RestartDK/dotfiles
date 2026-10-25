import { isDeepStrictEqual } from "node:util";
import { parseCommandEvidence, parseCommandReceipt, parseCommandSpec, type CommandEvidence } from "./command-wire.js";
import type { ExecutionEvent, ExecutionRecord, RecordedCommandInvocation } from "./execution-wire.js";

type Event<K extends ExecutionEvent["kind"]> = Extract<ExecutionEvent, { kind: K }>;
type Attempted = { readonly kind: "attempted"; readonly attempt: Event<"command.attempted"> };
type Activated = { readonly kind: "activated"; readonly attempt: Event<"command.attempted">; readonly activation: Event<"command.activated"> };
export type CommandState = {
  readonly authorization: Event<"command.authorized">;
  readonly cancellation: "none" | "requested";
  readonly phase:
    | { readonly kind: "authorized" }
    | Attempted
    | Activated
    | { readonly kind: "adopted"; readonly original: Activated; readonly adoption: Event<"command.adopted"> }
    | { readonly kind: "reconciled"; readonly original: Attempted | Activated; readonly reconciliation: Event<"command.reconciled"> };
};
export type FileEffectState = {
  readonly start: Event<"file.started">;
  readonly phase:
    | { readonly kind: "active" }
    | { readonly kind: "adopted" }
    | { readonly kind: "reconciled"; readonly reconciliation: Event<"file.reconciled"> };
};
export type ExecutionState = {
  readonly commands: ReadonlyMap<string, CommandState>;
  readonly files: ReadonlyMap<string, FileEffectState>;
};

export function unresolvedEffects(state: ExecutionState): readonly ({ readonly kind: "command"; readonly intentId: string } | { readonly kind: "file"; readonly effectId: string })[] {
  const pending: ({ readonly kind: "command"; readonly intentId: string } | { readonly kind: "file"; readonly effectId: string })[] = [];
  for (const [intentId, command] of state.commands)
    if (command.phase.kind === "attempted" || command.phase.kind === "activated") pending.push({ kind: "command", intentId });
  for (const [effectId, file] of state.files)
    if (file.phase.kind === "active") pending.push({ kind: "file", effectId });
  return pending;
}

function idle(state: ExecutionState): void {
  if (unresolvedEffects(state).length !== 0) throw new Error("Unresolved execution effects block new mutations");
}

function callKey(call: RecordedCommandInvocation): string {
  return JSON.stringify("callId" in call ? ["tool", call.conversationKey, call.taskKey, call.callId] : ["task", call.conversationKey, call.taskKey]);
}

function bound(authorization: Event<"command.authorized">, evidence: CommandEvidence): void {
  const spec = parseCommandSpec(authorization.specJson);
  if (evidence.executionId !== spec.executionId || evidence.workspaceId !== spec.workspaceId || evidence.intentId !== spec.intentId
    || evidence.nonce !== spec.nonce || evidence.specSha256 !== authorization.specSha256 || evidence.activation.unit !== spec.unit
    || evidence.activation.bootId !== authorization.sourceBootId)
    throw new Error("Command evidence differs from immutable authorization");
}

export function reduceExecutionRecords(records: readonly ExecutionRecord[]): ExecutionState {
  const commands = new Map<string, CommandState>();
  const files = new Map<string, FileEffectState>();
  const executions = new Set<string>();
  const units = new Set<string>();
  const epochs = new Set<string>();
  const calls = new Set<string>();
  const state: ExecutionState = { commands, files };
  for (const { event } of records) {
    switch (event.kind) {
      case "command.authorized": {
        const spec = parseCommandSpec(event.specJson);
        if (commands.has(spec.intentId) || executions.has(spec.executionId) || units.has(spec.unit) || epochs.has(event.captureEpoch))
          throw new Error("Command authorization identity already exists");
        executions.add(spec.executionId); units.add(spec.unit); epochs.add(event.captureEpoch);
        commands.set(spec.intentId, { authorization: event, cancellation: "none", phase: { kind: "authorized" } });
        break;
      }
      case "command.attempted": {
        const command = commands.get(event.intentId);
        if (command === undefined || command.phase.kind !== "authorized" || command.cancellation === "requested")
          throw new Error("Command is not available for a first attempt");
        idle(state);
        const key = callKey(event.sdk);
        if (calls.has(key)) throw new Error("SDK call already owns an effect");
        calls.add(key);
        commands.set(event.intentId, { ...command, phase: { kind: "attempted", attempt: event } });
        break;
      }
      case "command.activated": {
        const command = commands.get(event.intentId);
        if (command === undefined || command.phase.kind !== "attempted") throw new Error("Command activation has no unique attempt");
        bound(command.authorization, parseCommandEvidence(event.evidenceJson));
        commands.set(event.intentId, { ...command, phase: { kind: "activated", attempt: command.phase.attempt, activation: event } });
        break;
      }
      case "command.adopted": {
        const command = commands.get(event.intentId);
        if (command === undefined || command.phase.kind !== "activated") throw new Error("Command adoption has no original activation");
        const receipt = parseCommandReceipt(event.receiptJson);
        const original = parseCommandEvidence(command.phase.activation.evidenceJson);
        bound(command.authorization, receipt.evidence);
        if (!isDeepStrictEqual(receipt.evidence, original)) throw new Error("Receipt differs from original activation");
        commands.set(event.intentId, { ...command, phase: { kind: "adopted", original: command.phase, adoption: event } });
        break;
      }
      case "command.cancel-requested": {
        const command = commands.get(event.intentId);
        if (command === undefined) throw new Error("Cancellation has no authorized command");
        commands.set(event.intentId, { ...command, cancellation: "requested" });
        break;
      }
      case "command.reconciled": {
        const command = commands.get(event.intentId);
        if (command === undefined || (command.phase.kind !== "attempted" && command.phase.kind !== "activated"))
          throw new Error("Reconciliation has no unresolved command attempt");
        if (event.containment.kind === "manager") {
          if (command.phase.kind !== "activated") throw new Error("Manager reconciliation requires original activation");
          const original = parseCommandEvidence(command.phase.activation.evidenceJson);
          if (event.containment.witness.unit !== original.activation.unit || event.containment.witness.invocationId !== original.activation.invocationId)
            throw new Error("Reconciliation differs from original containment");
        }
        commands.set(event.intentId, { ...command, phase: { kind: "reconciled", original: command.phase, reconciliation: event } });
        break;
      }
      case "file.started": {
        if (files.has(event.effectId) || calls.has(callKey(event.sdk))) throw new Error("File effect or SDK call already exists");
        idle(state);
        calls.add(callKey(event.sdk));
        files.set(event.effectId, { start: event, phase: { kind: "active" } });
        break;
      }
      case "file.adopted": {
        const file = files.get(event.effectId);
        if (file === undefined || file.phase.kind !== "active") throw new Error("File adoption has no unresolved effect");
        files.set(event.effectId, { ...file, phase: { kind: "adopted" } });
        break;
      }
      case "file.reconciled": {
        const file = files.get(event.effectId);
        if (file === undefined || file.phase.kind !== "active") throw new Error("File reconciliation has no unresolved effect");
        files.set(event.effectId, { ...file, phase: { kind: "reconciled", reconciliation: event } });
        break;
      }
      default: {
        const exhaustive: never = event;
        throw new Error(`Unsupported execution event ${exhaustive}`);
      }
    }
  }
  return state;
}
