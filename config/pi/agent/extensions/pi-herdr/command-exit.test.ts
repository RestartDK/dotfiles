import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandExit } from "./command-exit.ts";

const marker = "__pi_rc_ab1234";

test("shell echo is not proof of command completion", () => {
  assert.equal(parseCommandExit(`{ run-tests; }; echo "${marker}=$?"`, marker), null);
});

test("another command marker cannot consume this command", () => {
  assert.equal(parseCommandExit("__pi_rc_cd5678=0\n", marker), null);
});

test("actual exit lines preserve success and failure", () => {
  assert.equal(parseCommandExit(`${marker}=0\n`, marker), 0);
  assert.equal(parseCommandExit(`${marker}=7\n`, marker), 7);
});

test("the last matching marker is the observed result", () => {
  assert.equal(parseCommandExit(`${marker}=1\noutput\n${marker}=0\n`, marker), 0);
  assert.equal(parseCommandExit(`${marker}=0\n`, null), null);
});
