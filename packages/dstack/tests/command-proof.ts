import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { CommandDirectory } from "#command-store";
import { CommandRuntime, commandDigest, type CommandObservation } from "#command-runtime";
import { parseCommandCredentials, parseCommandSpec, type CommandEvidence, type CommandSpec } from "#command-wire";

type ProofCase = "normal" | "cancel" | "helper-loss" | "helper-term" | "capture-timeout";
type Resource = { readonly kind: "unobserved" } | { readonly kind: "observed"; readonly evidence: CommandEvidence } | { readonly kind: "released" };
const cases: readonly ProofCase[] = ["normal", "cancel", "helper-loss", "helper-term", "capture-timeout"];
const helper = process.env.DSTACK_COMMAND_HELPER_TEST;
if (helper === undefined || !helper.startsWith("/nix/store/")) throw new Error("Explicit packaged helper required");
const node = process.env.DSTACK_TEST_NODE;
if (node === undefined || !node.startsWith("/")) throw new Error("Explicit production Node required");
const cwd = await realpath(process.cwd());
await mkdir(join(cwd, ".audit"), { recursive: true, mode: 0o700 });
const root = await mkdtemp(join(cwd, ".audit/runtime-"));
const lockCommand = { file: process.env.DSTACK_FLOCK ?? "/run/current-system/sw/bin/flock", args: [] };
const store = await CommandDirectory.own({ path: root, lockCommand });
const authority = store.directory;
const results: Array<{ kind: ProofCase; directory: string; spec: CommandSpec; observed: CommandObservation }> = [];
const credentials = parseCommandCredentials(JSON.stringify({ uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.() }));
const runtime = new CommandRuntime({
  helper, credentials, systemdRun: "/run/current-system/sw/bin/systemd-run", systemctl: "/run/current-system/sw/bin/systemctl",
  busctl: "/run/current-system/sw/bin/busctl", launcher: [], environmentNames: ["PATH", "HOME", "LANG"],
});

async function until<T>(operation: () => Promise<T | undefined>, timeout = 15000): Promise<T> {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error("Runtime proof deadline");
}

try {
  await assert.rejects(CommandDirectory.own({ path: root, lockCommand }), /Another daemon owns/);
  const publication = await Promise.allSettled([
    authority.publish("publication-race.json", "first"),
    authority.publish("publication-race.json", "second"),
  ]);
  assert.equal(publication.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await authority.read("publication-race.json", 32), "first");
  for (const kind of cases) {
    const directory = await authority.child(kind, "new");
    const marker = join(directory.path, "effect.json");
    const source = await runtime.capture(cwd);
    const script = kind === "normal"
      ? `require('node:fs').writeFileSync(process.argv[1], 'once', {flag:'wx',mode:384}); process.stdout.write('x'.repeat(600000));`
      : kind === "cancel"
        ? `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[1], 'ready', {flag:'wx',mode:384}); setInterval(()=>{},50);`
        : `const c=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(process.argv[1],'descendant',{mode:384});setInterval(()=>{},50);",process.argv[1]],{detached:true,stdio:'ignore'}); c.unref(); process.on('SIGTERM',()=>{});setInterval(()=>{},50);`;
    const spec = parseCommandSpec(JSON.stringify({
      version: 1, executionId: randomUUID(), workspaceId: "runtime-proof", intentId: kind,
      nonce: randomBytes(32).toString("hex"), unit: `hdj-${randomUUID()}.service`, cwd,
      argv: [node, "-e", script, marker], timeoutSeconds: 15, mode: "trusted-user-mapped-fs",
      context: source.context, environmentSha256: source.environmentSha256,
    }));
    const bytes = JSON.stringify(spec), digest = commandDigest(bytes);
    await directory.create("spec.json", bytes);
    const resource: { current: Resource } = { current: { kind: "unobserved" } };
    let last: CommandObservation | undefined;
    const activation = async (evidence: CommandEvidence) => {
      resource.current = { kind: "observed", evidence };
      await directory.create("observed-activation.json", JSON.stringify(evidence));
      if (kind === "capture-timeout") throw new Error("Fixture detached before capture");
    };
    try {
      if (kind === "normal") {
        const mismatch = await authority.child("cwd-mismatch", "new");
        const altered = parseCommandSpec(JSON.stringify({ ...spec, cwd: "/", unit: `hdj-${randomUUID()}.service` }));
        const alteredBytes = JSON.stringify(altered);
        await mismatch.create("spec.json", alteredBytes);
        await assert.rejects(runtime.launch({ directory: mismatch, source, spec: altered, digest: commandDigest(alteredBytes),
          activation: async () => { throw new Error("Mismatched cwd reached activation"); } }), /handoff differs/);
      }
      if (kind === "capture-timeout") {
        await assert.rejects(runtime.launch({ directory, source, spec, digest, activation }), /Fixture detached before capture/);
        await source.close();
        const observed = await until(async () => {
          const value = await runtime.inspect({ directory, spec, digest });
          last = value;
          return value.outcome.kind === "recorded" && value.containment.kind === "unknown"
            && value.containment.reason === "activation-unavailable" ? value : undefined;
        });
        assert.equal(observed.outcome.kind, "recorded");
        if (observed.outcome.kind !== "recorded") throw new Error("Expected authenticated refusal");
        assert.deepEqual(observed.outcome.receipt.outcome, { kind: "not-started", reason: "capture-deadline" });
        assert.equal(await directory.optional("claim.json", 32768), undefined);
        assert.equal(await directory.optional("captured.json", 32768), undefined);
        assert.equal(await directory.optional("effect.json", 32768), undefined);
        await directory.create("proof-observation.json", JSON.stringify(observed));
        await directory.create("proof-cleanup.json", JSON.stringify({ captureWasNeverSent: true, namespaceWasNeverAcquired: true, originalManagerEntryGone: true, containmentProven: false }));
        resource.current = { kind: "released" };
        results.push({ kind, directory: directory.path, spec, observed });
        continue;
      }
      const started = await runtime.launch({ directory, source, spec, digest, activation });
      await source.close();
      await until(async () => {
        try { return await readFile(marker, "utf8"); }
        catch (error) { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined; throw error; }
      });
      if (kind === "cancel") {
        await runtime.cancel({ directory, spec, digest });
        await runtime.cancel({ directory, spec, digest });
      } else if (kind === "helper-loss" || kind === "helper-term") {
        const python = "import os,select,signal,sys\npid=int(sys.argv[1]); fd=os.pidfd_open(pid)\ns=open('/proc/%d/stat'%pid).read().rsplit(')',1)[1].split()[19]\nassert s==sys.argv[2]\np=select.poll();p.register(fd,select.POLLIN);assert not p.poll(0)\nsignal.pidfd_send_signal(fd,int(sys.argv[3]))\nos.close(fd)";
        const killed = spawnSync("/run/current-system/sw/bin/python3", ["-c", python, String(started.activation.pid), started.activation.startTicks, kind === "helper-term" ? "15" : "9"], { encoding: "utf8" });
        assert.equal(killed.status, 0, killed.stderr);
      }
      const observed = await until(async () => {
        const value = await runtime.inspect({ directory, spec, digest, evidence: started });
        last = value;
        return value.containment.kind === "empty" ? value : undefined;
      });
      if (observed.containment.kind !== "empty") throw new Error("Expected independently empty containment");
      if (kind === "helper-loss" || kind === "helper-term") assert.equal(observed.outcome.kind, "unobserved");
      else {
        if (observed.outcome.kind !== "recorded") throw new Error("Expected independent exit receipt");
        const receipt = observed.outcome.receipt;
        if (kind === "normal") {
          assert.deepEqual(receipt.outcome, { kind: "exit", code: 0, cause: "normal" });
          assert.equal(receipt.stdout.kept, 131072); assert.ok(receipt.stdout.dropped > 0);
          assert.equal(await readFile(marker, "utf8"), "once");
        } else {
          if (receipt.outcome.kind !== "signal") throw new Error("Expected bounded command termination");
          assert.equal(receipt.outcome.cause, "cancelled");
        }
      }
      assert.deepEqual(await runtime.inspect({ directory, spec, digest, evidence: { ...started, intentId: "forged" } }),
        { outcome: { kind: "unobserved" }, containment: { kind: "unknown", reason: "binding-mismatch" } });
      results.push({ kind, directory: directory.path, spec, observed });
      await directory.create("proof-observation.json", JSON.stringify(observed));
      await runtime.release({ spec, digest, evidence: started, containment: observed.containment.witness });
      resource.current = { kind: "released" };
      const shown = spawnSync(runtime.options.systemctl, ["--user", "show", spec.unit, "--property=InvocationID,ActiveState,NFileDescriptorStore"], { encoding: "utf8" });
      assert.match(shown.stdout, /^NFileDescriptorStore=0$/m);
      await directory.create("proof-cleanup.json", JSON.stringify({ namespaceReleased: true, failedStateHandledByRuntime: kind === "helper-loss" || kind === "helper-term" }));
    } catch (error) {
      await directory.create("proof-error.json", JSON.stringify({ message: error instanceof Error ? error.message : "Runtime proof failed", last })).catch(() => {});
      if (resource.current.kind === "observed") {
        const evidence = resource.current.evidence;
        await runtime.cancel({ directory, spec, digest }).catch(() => {});
        const settled = await until(async () => {
          const observed = await runtime.inspect({ directory, spec, digest, evidence });
          return observed.containment.kind === "empty" ? observed : undefined;
        }, 45000);
        if (settled.containment.kind !== "empty") throw new Error("Cleanup containment unproven");
        await runtime.release({ spec, digest, evidence, containment: settled.containment.witness });
      }
      throw error;
    } finally { await source.close(); }
  }
  const child = await authority.child("close-joining", "new");
  const pending = child.create("queued.json", "joined");
  const closing = store.close();
  await assert.rejects(child.create("after-close.json", "forbidden"), /writer is closed/);
  assert.equal(store.close(), closing);
  await Promise.all([pending, closing]);
  assert.equal(await child.read("queued.json", 32), "joined");
} finally { await store.close(); }
const reopened = await CommandDirectory.own({ path: root, lockCommand });
try { await reopened.directory.create("result.json", JSON.stringify({ verdict: "runtime-component-only", helper, results }, null, 2)); }
finally { await reopened.close(); }
console.log(JSON.stringify({ verdict: "runtime-component-only", root, helper, cases: results.length }));
