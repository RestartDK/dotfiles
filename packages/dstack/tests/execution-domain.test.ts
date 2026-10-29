import { expect, test } from "bun:test";
import { parseExecutionRecord, parseExecutionRoot, executionDigest, executionRootBytes, type ExecutionEvent, type ExecutionRecord } from "#execution-wire";
import { reduceExecutionRecords, unresolvedEffects } from "#execution-domain";
import type { CommandEvidence, CommandSpec, CommandReceipt } from "#command-wire";

const root = parseExecutionRoot(JSON.stringify({ version: 1, rootId: "workspace-generation", token: "a".repeat(64), workspace: { domain: "personal", nodeId: "node", workspaceId: "workspace", cwd: "/repo" } }));
const boot = "00000000-0000-0000-0000-000000000000";
const descriptor = { device: "1", inode: "2", mountId: "3" };
const sdk = { taskKey: "task", conversationKey: "conversation", callId: "call" };
type Authorization = Extract<ExecutionEvent, { kind: "command.authorized" }>;

function authorize(input: { intentId?: string; executionId?: string; unit?: string; epoch?: string } = {}): Authorization {
  const spec: CommandSpec = {
    version: 1, executionId: input.executionId ?? "command-execution", workspaceId: "workspace", intentId: input.intentId ?? "intent",
    nonce: "1".repeat(64), unit: input.unit ?? "hdj-domain.service", cwd: "/repo", argv: ["/bin/true"], timeoutSeconds: 1,
    mode: "trusted-user-mapped-fs", environmentSha256: "2".repeat(64),
    context: { root: descriptor, cwd: descriptor, net: descriptor, mount: descriptor, user: descriptor, credentials: { uid: 1000, gid: 100, groups: [100] } },
  };
  const specJson = JSON.stringify(spec);
  return { kind: "command.authorized", specJson, specSha256: executionDigest(specJson), inputSha256: "3".repeat(64), sourceBootId: boot, captureEpoch: input.epoch ?? "4".repeat(64) };
}

function history(events: readonly ExecutionEvent[]): ExecutionRecord[] {
  let previousSha256 = executionDigest(executionRootBytes(root));
  return events.map((event, index) => {
    const bytes = JSON.stringify({ version: 1, rootId: root.rootId, sequence: index + 1, previousSha256, event });
    const entry = parseExecutionRecord(bytes, root);
    previousSha256 = executionDigest(bytes);
    return entry;
  });
}
function state(events: readonly ExecutionEvent[]) { return reduceExecutionRecords(history(events)); }
function attempt(intentId = "intent"): ExecutionEvent { return { kind: "command.attempted", intentId, sdk }; }
function file(input: { effectId?: string; sdk?: typeof sdk; path?: string } = {}): ExecutionEvent {
  return { kind: "file.started", effectId: input.effectId ?? "5".repeat(64), tool: "write", path: input.path ?? "/repo/file", argumentsSha256: "6".repeat(64), sdk: input.sdk ?? sdk };
}
function evidence(authorization: Authorization): CommandEvidence {
  return { version: 1, executionId: "command-execution", workspaceId: "workspace", intentId: "intent", nonce: "1".repeat(64), specSha256: authorization.specSha256,
    mode: "trusted-user-mapped-fs", activation: { unit: "hdj-domain.service", invocationId: "7".repeat(32), pid: 42, startTicks: "1", bootId: boot,
      executable: descriptor, commandLineSha256: "8".repeat(64), cgroup: { path: "/fixture", device: "1", inode: "2" } } };
}
function activated(value: CommandEvidence): ExecutionEvent { return { kind: "command.activated", intentId: "intent", evidenceJson: JSON.stringify(value) }; }
function adopted(value: CommandEvidence): ExecutionEvent {
  const receipt: CommandReceipt = { evidence: value, outcome: { kind: "exit", code: 0, cause: "normal" }, stdout: { kept: 0, dropped: 0, end: "eof" }, stderr: { kept: 0, dropped: 0, end: "eof" } };
  return { kind: "command.adopted", intentId: "intent", receiptJson: JSON.stringify(receipt), containment: { source: "systemd-manager", unit: value.activation.unit, invocationId: value.activation.invocationId, observedAt: 1 } };
}

test("journal generation and command execution remain distinct; attempt blocks all other mutators", () => {
  const authorization = authorize();
  const second = authorize({ intentId: "second", executionId: "second-execution", unit: "hdj-second.service", epoch: "b".repeat(64) });
  expect(state([authorization]).commands.get("intent")?.phase.kind).toBe("authorized");
  expect(unresolvedEffects(state([authorization, attempt()]))).toEqual([{ kind: "command", intentId: "intent" }]);
  expect(() => state([authorization, attempt(), file({ sdk: { ...sdk, taskKey: "file-task", callId: "file-call" } })])).toThrow(/Unresolved/);
  expect(() => state([authorization, second, attempt(), { kind: "command.attempted", intentId: "second", sdk: { ...sdk, callId: "second" } }])).toThrow(/Unresolved/);
});

test("immutable semantic identity, execution, unit and capture epoch cannot be reused", () => {
  const original = authorize();
  for (const duplicate of [original, authorize({ intentId: "second" }), authorize({ intentId: "second", executionId: "second" }),
    authorize({ intentId: "second", executionId: "second", unit: "hdj-second.service" })])
    expect(() => state([original, duplicate])).toThrow(/already exists/);
  expect(() => state([original, attempt(), attempt()])).toThrow(/first attempt/);
});

test("authorization cancellation and unknown IDs cannot start a command", () => {
  expect(() => state([attempt()])).toThrow(/first attempt/);
  expect(() => state([authorize(), { kind: "command.cancel-requested", intentId: "intent" }, attempt()])).toThrow(/first attempt/);
});

test("activation binds nonce, source boot, digest and original unit before adoption", () => {
  const authorization = authorize(), original = evidence(authorization);
  expect(state([authorization, attempt(), activated(original)]).commands.get("intent")?.phase.kind).toBe("activated");
  for (const changed of [{ ...original, nonce: "9".repeat(64) }, { ...original, specSha256: "9".repeat(64) },
    { ...original, activation: { ...original.activation, bootId: "11111111-1111-1111-1111-111111111111" } },
    { ...original, activation: { ...original.activation, unit: "hdj-replacement.service" } }])
    expect(() => state([authorization, attempt(), activated(changed)])).toThrow(/immutable authorization/);
});

test("only adoption of the same activation clears the gate; settled intent never starts again", () => {
  const authorization = authorize(), original = evidence(authorization), prefix = [authorization, attempt(), activated(original)];
  expect(() => state([...prefix, adopted({ ...original, activation: { ...original.activation, pid: 43 } })])).toThrow(/original activation/);
  const done = [...prefix, adopted(original)];
  expect(unresolvedEffects(state(done))).toEqual([]);
  expect(state(done).commands.get("intent")?.phase.kind).toBe("adopted");
  expect(() => state([...done, attempt()])).toThrow(/first attempt/);
});

test("explicit reconciliation preserves uncertainty instead of fabricating an exit", () => {
  const authorization = authorize(), original = evidence(authorization);
  const reconcile: ExecutionEvent = { kind: "command.reconciled", intentId: "intent", actor: "operator", reference: "acknowledged unknown effects",
    containment: { kind: "manager", witness: { source: "systemd-manager", unit: original.activation.unit, invocationId: original.activation.invocationId, observedAt: 1 } } };
  expect(() => state([authorization, attempt(), reconcile])).toThrow(/original activation/);
  const reconciled = state([authorization, attempt(), activated(original), reconcile]);
  expect(reconciled.commands.get("intent")?.phase.kind).toBe("reconciled");
  expect(unresolvedEffects(reconciled)).toEqual([]);
  expect(reconciled.commands.get("intent")?.phase).not.toHaveProperty("receipt");
});

test("fresh and reused file/SDK effects cannot bypass an unresolved mutation", () => {
  const start = file(), id = "5".repeat(64);
  expect(() => state([start, file({ effectId: "a".repeat(64), sdk: { ...sdk, callId: "second" } })])).toThrow(/Unresolved/);
  expect(() => state([start, { kind: "file.adopted", effectId: id }, start])).toThrow(/already exists/);
  expect(() => state([start, { kind: "file.adopted", effectId: id }, file({ effectId: "a".repeat(64) })])).toThrow(/already exists/);
  expect(() => state([file({ path: "/repo/../outside" })])).toThrow(/escapes/);
  expect(() => state([{ kind: "file.adopted", effectId: id }])).toThrow(/unresolved effect/);
});

test("owned SDK tasks have distinct provenance without a fabricated tool call ID", () => {
  const invocation: ExecutionEvent = { kind: "command.attempted", intentId: "intent", sdk: { kind: "task", taskKey: "task", conversationKey: "conversation" } };
  const reconciliation: ExecutionEvent = { kind: "command.reconciled", intentId: "intent", actor: "fixture", reference: "acknowledged unknown",
    containment: { kind: "trusted-offline", reference: "fixture-only" } };
  expect(state([authorize(), invocation]).commands.get("intent")?.phase.kind).toBe("attempted");
  const second = authorize({ intentId: "second", executionId: "second", unit: "hdj-second.service", epoch: "b".repeat(64) });
  expect(() => state([authorize(), invocation, reconciliation, second, { ...invocation, intentId: "second" }])).toThrow(/SDK call already owns/);
  expect(state([authorize(), invocation, reconciliation, file({ sdk: { conversationKey: "task", taskKey: "conversation", callId: "task" } })]).files.size).toBe(1);
  const encoded = history([authorize(), invocation])[1];
  expect(() => parseExecutionRecord(JSON.stringify({ ...encoded, event: { ...invocation, sdk: { ...invocation.sdk, callId: "counterfeit" } } }), root)).toThrow(/schema/);
});

test("authorization requires a live-capture epoch reference and preserves NEL identities", () => {
  const { captureEpoch, ...withoutEpoch } = authorize();
  expect(captureEpoch).toHaveLength(64);
  const bytes = JSON.stringify({ version: 1, rootId: root.rootId, sequence: 1, previousSha256: executionDigest(executionRootBytes(root)), event: withoutEpoch });
  expect(() => parseExecutionRecord(bytes, root)).toThrow(/schema/);
  expect(state([authorize({ intentId: "\u0085" })]).commands.has("\u0085")).toBe(true);
});
