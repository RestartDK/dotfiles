import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { HostError, parseOperation } from "../src/host-protocol.js";

const authorization = {
  op: "command.authorize",
  workspaceId: "coding",
  intentId: " build-17 ",
  spec: { argv: ["/absolute/tool", "", "unchanged argument"], timeoutSeconds: 60 },
};

function invalid(value: unknown): void {
  try { parseOperation(value); }
  catch (error) {
    expect(error).toBeInstanceOf(HostError);
    expect(error instanceof HostError && error.code).toBe("invalid_request");
    return;
  }
  throw new Error("Untrusted command input was accepted");
}

test("trusted command wire keeps opaque intent bytes and cannot mint capture or actor authority", () => {
  assert.deepEqual(parseOperation(authorization), authorization);
  for (const field of ["actor", "environment", "rootId", "executionId", "sourceBootId", "captureEpoch", "cwd", "approval"])
    invalid({ ...authorization, [field]: "caller-controlled" });
  invalid({ ...authorization, spec: { ...authorization.spec, environment: {} } });
  invalid({ ...authorization, spec: { ...authorization.spec, mode: "keep-caps" } });
  invalid({ ...authorization, intentId: "\uFEFF" });
  invalid({ ...authorization, intentId: "x".repeat(129) });
  invalid({ ...authorization, intentId: String.fromCharCode(0xd800) });
  expect(parseOperation({ ...authorization, intentId: "\u0085" })).toHaveProperty("intentId", "\u0085");
});

test("authorization arguments use the helper's byte, Unicode, absolute executable and time bounds", () => {
  for (const argv of [[], ["relative-tool"], ["/tool", "\0"], ["/tool", String.fromCharCode(0xd800)], ["/tool", "é".repeat(2049)], Array.from({ length: 129 }, () => "/tool"), ["/tool", ...Array.from({ length: 5 }, () => "x".repeat(4096))]])
    invalid({ ...authorization, spec: { ...authorization.spec, argv } });
  for (const timeoutSeconds of [0, 3601, 1.5, "60", null])
    invalid({ ...authorization, spec: { ...authorization.spec, timeoutSeconds } });
  expect(parseOperation({ ...authorization, spec: { argv: ["/tool", "é".repeat(2048)], timeoutSeconds: 3600 } })).toHaveProperty("spec.timeoutSeconds", 3600);
});

test("start and control variants consume existing intent IDs, never fresh command content", () => {
  for (const op of ["command.start", "command.status", "command.inspect", "command.adopt", "command.cancel", "command.release"]) {
    const operation = { op, workspaceId: "coding", intentId: "build-17" };
    assert.deepEqual(parseOperation(operation), operation);
    invalid({ ...operation, spec: authorization.spec });
    invalid({ ...operation, argv: authorization.spec.argv });
    invalid({ ...operation, actor: "admin" });
    invalid({ ...operation, intentId: " " });
  }
  invalid({ op: "command.shell", workspaceId: "coding", argv: ["/tool"] });
  assert.deepEqual(parseOperation({ op: "execution.status", workspaceId: "coding" }), { op: "execution.status", workspaceId: "coding" });
  invalid({ op: "execution.status", workspaceId: "coding", actor: "admin" });
  invalid({ op: "execution.status", workspaceId: String.fromCharCode(0xd800) });
});

test("host cwd input is well-formed and leaves room for the getcwd NUL byte", () => {
  const create = { op: "create", requestId: "path-check", workspaceId: "coding", cwd: "/" + "x".repeat(4094) };
  assert.deepEqual(parseOperation(create), create);
  invalid({ ...create, cwd: "/" + "x".repeat(4095) });
  invalid({ ...create, cwd: "/" + String.fromCharCode(0xd800) });
  invalid({ ...create, cwd: "/path" + String.fromCharCode(0) + "suffix" });
});

test("reconciliation requires explicit bounded references and cannot assert exit outcomes", () => {
  const manager = { op: "command.reconcile", workspaceId: "coding", intentId: "build-17", reference: "operator inspected original activation", containment: { kind: "manager" } };
  const offline = { ...manager, containment: { kind: "trusted-offline", reference: "operator incident record" } };
  assert.deepEqual(parseOperation(manager), manager);
  assert.deepEqual(parseOperation(offline), offline);
  invalid({ ...manager, actor: "admin" });
  invalid({ ...manager, outcome: { kind: "exit", code: 0 } });
  invalid({ ...manager, reference: " " });
  invalid({ ...manager, reference: "x".repeat(1025) });
  invalid({ ...manager, containment: { kind: "trusted-offline" } });
  invalid({ ...manager, containment: { kind: "empty", pid: 1 } });
  const file = { op: "file.reconcile", workspaceId: "coding", effectId: "file-effect-1", reference: "operator inspected files" };
  assert.deepEqual(parseOperation(file), file);
  invalid({ ...file, actor: "admin" });
});
