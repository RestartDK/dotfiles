import { expect, test } from "bun:test";
import { executionRootBytes, parseExecutionEvent, parseExecutionRoot, type ExecutionRoot } from "../src/execution-wire.js";
import { parseCommandClaim, parseCommandEvidence, parseCommandReceipt, parseCommandSpec } from "../src/command-wire.js";

const root = {
  version: 1,
  rootId: "identity-boundary",
  token: "0".repeat(64),
  workspace: { domain: "personal", nodeId: "node", workspaceId: "workspace", cwd: "/workspace" },
} satisfies ExecutionRoot;

test("execution workspace identities preserve the Host's full 200-byte contract", () => {
  for (const name of ["a".repeat(128), "a".repeat(129), "a".repeat(200), "界".repeat(66) + "ab"]) {
    const value = { ...root, workspace: { ...root.workspace, nodeId: name, workspaceId: name } };
    expect(parseExecutionRoot(JSON.stringify(value))).toEqual(value);
    expect(executionRootBytes(parseExecutionRoot(JSON.stringify(value)))).toBe(JSON.stringify(value));
  }
});

test("workspace identity bounds do not widen root IDs, intents or actors", () => {
  const parsed = parseExecutionRoot(JSON.stringify(root));
  for (const name of ["a".repeat(201), "界".repeat(67), "bad\0identity", "\ud800", "\ufeff"]) {
    expect(() => parseExecutionRoot(JSON.stringify({ ...root, workspace: { ...root.workspace, nodeId: name } }))).toThrow();
    expect(() => parseExecutionRoot(JSON.stringify({ ...root, workspace: { ...root.workspace, workspaceId: name } }))).toThrow();
  }
  expect(() => parseExecutionRoot(JSON.stringify({ ...root, rootId: "r".repeat(129) }))).toThrow();
  expect(() => parseExecutionEvent(JSON.stringify({ kind: "command.cancel-requested", intentId: "i".repeat(129) }), parsed)).toThrow();
  expect(() => parseExecutionEvent(JSON.stringify({ kind: "file.reconciled", effectId: "0".repeat(64), actor: "a".repeat(129), reference: "test-only" }), parsed)).toThrow();
});

const descriptor = { device: "1", inode: "2", mountId: "3" };
const context = { root: descriptor, cwd: descriptor, net: descriptor, mount: descriptor, user: descriptor, credentials: { uid: 1000, gid: 100, groups: [100] } };
const spec = { version: 1, executionId: "execution", workspaceId: "workspace", intentId: "intent", nonce: "0".repeat(64), unit: "hdj-boundary.service", cwd: "/", argv: ["/bin/true"], timeoutSeconds: 1, mode: "trusted-user-mapped-fs", environmentSha256: "0".repeat(64), context };
const evidence = { version: 1, executionId: spec.executionId, workspaceId: spec.workspaceId, intentId: spec.intentId, nonce: spec.nonce, specSha256: "0".repeat(64), mode: spec.mode, activation: { unit: spec.unit, invocationId: "0".repeat(32), pid: 1, startTicks: "1", bootId: "00000000-0000-0000-0000-000000000000", executable: descriptor, commandLineSha256: "0".repeat(64), cgroup: { path: "/test", device: "1", inode: "2" } } };
const log = { kept: 0, dropped: 0, end: "eof" };
function commandWires(workspaceId: string): readonly { readonly parse: (bytes: string) => unknown; readonly value: unknown }[] {
  const witness = { ...evidence, workspaceId };
  return [
    { parse: parseCommandSpec, value: { ...spec, workspaceId } },
    { parse: parseCommandEvidence, value: witness },
    { parse: parseCommandClaim, value: { evidence: witness, context } },
    { parse: parseCommandReceipt, value: { evidence: witness, outcome: { kind: "exit", code: 0, cause: "normal" }, stdout: log, stderr: log } },
  ];
}

test("command spec, evidence, claim and receipt preserve 200-byte workspace identities", () => {
  for (const name of ["w".repeat(129), "w".repeat(200), "界".repeat(66) + "ab"]) {
    for (const wire of commandWires(name)) expect(wire.parse(JSON.stringify(wire.value))).toEqual(wire.value);
  }
  for (const name of ["w".repeat(201), "界".repeat(67), "bad\0identity", "\ud800", "\ufeff"]) {
    for (const wire of commandWires(name)) expect(() => wire.parse(JSON.stringify(wire.value))).toThrow();
  }
  expect(() => parseCommandSpec(JSON.stringify({ ...spec, executionId: "e".repeat(129) }))).toThrow();
  expect(() => parseCommandSpec(JSON.stringify({ ...spec, intentId: "i".repeat(129) }))).toThrow();
});
