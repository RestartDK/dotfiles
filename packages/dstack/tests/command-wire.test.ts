import { expect, test } from "bun:test";
import { parseCommandSpec } from "#command-wire";

const descriptor = { device: "1", inode: "2", mountId: "3" };
const spec = {
  version: 1, executionId: "execution", workspaceId: "workspace", intentId: "intent",
  nonce: "0".repeat(64), unit: "hdj-codec.service", cwd: "/", argv: ["/bin/true"],
  timeoutSeconds: 1, mode: "trusted-user-mapped-fs", environmentSha256: "0".repeat(64),
  context: { root: descriptor, cwd: descriptor, net: descriptor, mount: descriptor, user: descriptor,
    credentials: { uid: 1000, gid: 100, groups: [100] } },
};

test("opaque command names retain NEL and padded nonblank bytes", () => {
  for (const intentId of ["\u0085", " padded "]) {
    expect(parseCommandSpec(JSON.stringify({ ...spec, intentId })).intentId).toBe(intentId);
  }
});

test("command names reject BOM-only and ECMAScript-blank identities", () => {
  for (const intentId of ["\ufeff", " \t\ufeff\u00a0"]) {
    expect(() => parseCommandSpec(JSON.stringify({ ...spec, intentId }))).toThrow();
  }
});

test("command cwd fits the Linux getcwd buffer including its NUL byte", () => {
  const cwd = "/" + "x".repeat(4094);
  expect(parseCommandSpec(JSON.stringify({ ...spec, cwd })).cwd).toBe(cwd);
  for (const value of [cwd + "x", "/" + "ä".repeat(2048)]) {
    expect(() => parseCommandSpec(JSON.stringify({ ...spec, cwd: value }))).toThrow();
  }
});
