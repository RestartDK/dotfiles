import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function run(name: "client-sdk-proof" | "client-http-proof" | "client-http-start-race-proof" | "client-http-bind-proof" | "client-resources-proof" | "client-paused-recovery-live") {
  const proof = fileURLToPath(new URL(`../dist/tests/${name}.js`, import.meta.url));
  const result = spawnSync(process.env.DSTACK_TEST_NODE ?? "node", [proof], { encoding: "utf8", timeout: 40000, maxBuffer: 128 * 1024 });
  if (result.status !== 0) throw new Error(`Client owner proof failed: ${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`);
  return result.stdout;
}

test("authenticated owner projects SDK progress, scopes original cursors and joins detached listeners", () => {
  const result = run("client-sdk-proof");
  expect(result).toContain('"proof":"client-sdk-owner"');
  expect(result).toContain('"stopJoinsOwnedListener":true');
}, 45000);

test("actual viewer expiry retires truthfully, slow TCP readers drain finitely and oversized SDK baselines refuse before SSE", () => {
  const result = run("client-resources-proof");
  expect(result).toContain('"plannedExpiryRetired":true');
  expect(result).toContain('"oversizedBaselineRefusedBeforeSse":true');
  expect(result).toContain('"oversizedCommittedEventRefused":true');
  expect(result).toContain('"cliOriginalPidfdSignals":["SIGINT","SIGTERM"]');
  expect(result).toContain('"cliBrokenOutputRetired":true');
  expect(result).toContain('"closedStderrWithoutUncaught":true');
}, 45000);

test("read-only authenticated clients observe actual physically interrupted SDK work without scheduling or settling it", () => {
  const result = run("client-paused-recovery-live");
  expect(result).toContain('"readOnlyDidNotScheduleOrInfer":true');
  expect(result).toContain('"startupFailureOriginalChildrenJoined":true');
}, 45000);

test("a port conflict retains its real bind cause and closes only the failed owner", () => {
  expect(run("client-http-bind-proof")).toContain('"originalErrorPreserved":true');
}, 45000);

test("shutdown after the real SSE baseline write seam cannot start a stopped watcher or corrupt framing", () => {
  expect(run("client-http-start-race-proof")).toContain('"snapshotThenTypedStoppedEnd":true');
}, 45000);

test("loopback ingress retains admitted work after lost ACK and drains viewers on stdio EOF", () => {
  const result = run("client-http-proof");
  expect(result).toContain('"proof":"client-http-owner"');
  expect(result).toContain('"stdioEofDuringAdmittedWatchOwnershipRead":true');
}, 45000);
