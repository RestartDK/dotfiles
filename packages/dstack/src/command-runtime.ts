import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { Check } from "typebox/value";
import { Type } from "typebox";
import { CommandDirectory } from "./command-store.js";
import {
  parseCommandClaim, parseCommandEvidence, parseCommandReceipt,
  type CommandContext, type CommandCredentials, type CommandDescriptor,
  type CommandEvidence, type CommandReceipt, type CommandSpec,
} from "./command-wire.js";

export function commandDigest(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type CommandRuntimeOptions = {
  readonly helper: string;
  readonly systemdRun: string;
  readonly systemctl: string;
  readonly busctl: string;
  readonly credentials: CommandCredentials;
  readonly environmentNames: readonly string[];
  readonly launcher: readonly string[];
};

type ProcessResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

async function invoke(executable: string, argv: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", size = 0;
    let failure: Error | undefined;
    const deadline = setTimeout(() => { failure = new Error("Command manager request deadline"); child.kill("SIGKILL"); }, 5000);
    child.stdout.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 65536) { failure = new Error("Command manager response too large"); child.kill("SIGKILL"); }
      else stdout += bytes.toString("utf8");
    });
    child.stderr.on("data", (bytes: Buffer) => {
      size += bytes.length;
      if (size > 65536) { failure = new Error("Command manager response too large"); child.kill("SIGKILL"); }
      else stderr += bytes.toString("utf8");
    });
    child.on("error", error => { clearTimeout(deadline); reject(error); });
    child.on("close", code => { clearTimeout(deadline); if (failure) reject(failure); else resolve({ code, stdout, stderr }); });
  });
}

async function descriptor(file: FileHandle): Promise<CommandDescriptor> {
  const info = await file.stat({ bigint: true });
  const details = await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8");
  const mountId = details.match(/^mnt_id:\s+([0-9]+)$/m)?.[1];
  if (mountId === undefined) throw new Error("Command descriptor mount identity unavailable");
  return { device: info.dev.toString(), inode: info.ino.toString(), mountId };
}

export class CommandSource {
  readonly environmentSha256: string;
  #closed: Promise<void> | undefined;

  private constructor(
    readonly cwd: string,
    readonly context: CommandContext,
    private readonly files: readonly [FileHandle, FileHandle, FileHandle, FileHandle, FileHandle],
    private readonly environment: Readonly<Record<string, string>>,
    private readonly helper: string,
  ) {
    this.environmentSha256 = commandDigest(JSON.stringify(environment));
  }

  static async capture(options: CommandRuntimeOptions, cwd: string): Promise<CommandSource> {
    if (process.platform !== "linux" || process.getuid?.() !== options.credentials.uid || process.getgid?.() !== options.credentials.gid)
      throw new Error("Unsupported command source credential context");
    const groups = [...new Set([...(process.getgroups?.() ?? []), options.credentials.gid])].sort((a, b) => a - b);
    if (!isDeepStrictEqual(groups, options.credentials.groups))
      throw new Error("Mapped source management requires a host-side control adapter");
    if (await realpath(cwd) !== cwd) throw new Error("Command workspace binding changed");
    const owned: FileHandle[] = [];
    const acquire = async (path: string) => { const file = await open(path, "r"); owned.push(file); return file; };
    try {
      const root = await acquire("/");
      const directory = await acquire(cwd);
      const net = await acquire("/proc/self/ns/net");
      const mount = await acquire("/proc/self/ns/mnt");
      const user = await acquire("/proc/self/ns/user");
      const entries: Array<readonly [string, string]> = [];
      for (const name of [...new Set(options.environmentNames)].sort()) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("Invalid approved command environment name");
        const value = process.env[name];
        if (value === undefined) continue;
        if (!value.isWellFormed() || value.includes("\0")) throw new Error("Unsupported command environment encoding");
        entries.push([name, value]);
      }
      const environment = Object.fromEntries(entries);
      if (Buffer.byteLength(JSON.stringify(environment)) > 120 * 1024)
        throw new Error("Approved command environment too large");
      const context = {
        root: await descriptor(root), cwd: await descriptor(directory), net: await descriptor(net),
        mount: await descriptor(mount), user: await descriptor(user), credentials: options.credentials,
      };
      return new CommandSource(cwd, context, [root, directory, net, mount, user], environment, options.helper);
    } catch (error) {
      const cleanup = await Promise.allSettled(owned.map(file => file.close()));
      const failures = cleanup.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError([error, ...failures], "Command capture and cleanup failed");
      throw error;
    }
  }

  deliver(directory: CommandDirectory, spec: CommandSpec, digest: string): Promise<void> {
    if (this.#closed !== undefined) return Promise.reject(new Error("Command source is closed"));
    return new Promise((resolve, reject) => {
      const child = spawn(this.helper, ["send", directory.path, digest], {
        env: {}, stdio: ["pipe", "ignore", "pipe", ...this.files.map(file => file.fd)],
      });
      let failure: Error | undefined;
      const deadline = setTimeout(() => { failure = new Error("Command capture acknowledgement unavailable"); child.kill("SIGKILL"); }, 11000);
      if (child.stdin === null || child.stderr === null) {
        clearTimeout(deadline); child.kill("SIGKILL"); reject(new Error("Command sender pipes unavailable")); return;
      }
      child.stderr.resume();
      child.stdin.on("error", () => { failure = new Error("Command capture transport unavailable"); });
      child.on("error", error => { clearTimeout(deadline); reject(error); });
      child.on("close", code => {
        clearTimeout(deadline);
        if (failure || code !== 0) reject(failure ?? new Error("Command capture was not acknowledged"));
        else resolve();
      });
      child.stdin.end(JSON.stringify({ version: 1, nonce: spec.nonce, specSha256: digest, environment: this.environment }));
    });
  }

  close(): Promise<void> {
    this.#closed ??= (async () => {
      const results = await Promise.allSettled(this.files.map(file => file.close()));
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Command source cleanup failed");
    })();
    return this.#closed;
  }
}

type Unit = {
  readonly invocationId: string;
  readonly phase: "active" | "inactive" | "failed" | "transitional";
  readonly mainPid: number;
  readonly stored: number;
  readonly maximum: number;
  readonly preserve: string;
  readonly notify: string;
};

export type ContainmentWitness = {
  readonly invocationId: string;
  readonly unit: string;
  readonly observedAt: number;
  readonly source: "systemd-manager";
};

export type CommandUnknownReason =
  | "activation-missing" | "activation-transitioning" | "binding-mismatch" | "invalid-receipt"
  | "receipt-binding-mismatch" | "namespace-custody-unavailable" | "main-process-changed" | "activation-unavailable"
  | "manager-unavailable" | "containment-unproven" | "activation-changed" | "receipt-changed"
  | "observation-unavailable";

class CommandInspectionError extends Error {
  constructor(readonly reason: CommandUnknownReason) { super(reason); }
}

function checkedReceipt(bytes: string): CommandReceipt {
  try { return parseCommandReceipt(bytes); }
  catch { throw new CommandInspectionError("invalid-receipt"); }
}

export type CommandObservation = {
  readonly outcome:
    | { readonly kind: "unobserved" }
    | { readonly kind: "recorded"; readonly receipt: CommandReceipt };
  readonly containment:
    | { readonly kind: "active"; readonly evidence: CommandEvidence }
    | { readonly kind: "empty"; readonly evidence: CommandEvidence; readonly witness: ContainmentWitness }
    | { readonly kind: "unknown"; readonly reason: CommandUnknownReason };
};

const processList = Type.Object({
  type: Type.Literal("a(sus)"),
  data: Type.Tuple([Type.Array(Type.Tuple([Type.String(), Type.Integer({ minimum: 1 }), Type.String()]))]),
}, { additionalProperties: false });

export class CommandRuntime {
  constructor(readonly options: CommandRuntimeOptions) {
    for (const executable of [options.helper, options.systemdRun, options.systemctl, options.busctl]) {
      if (!isAbsolute(executable) || !executable.isWellFormed() || executable.includes("\0"))
        throw new Error("Absolute command runtime executables required");
    }
    const launcher = options.launcher[0];
    if (launcher !== undefined && !isAbsolute(launcher)) throw new Error("Absolute command launcher required");
  }

  capture(cwd: string): Promise<CommandSource> { return CommandSource.capture(this.options, cwd); }

  private async unit(name: string): Promise<Unit> {
    const result = await invoke(this.options.systemctl, ["--user", "show", name,
      "--property=LoadState,InvocationID,ActiveState,MainPID,NFileDescriptorStore,FileDescriptorStoreMax,FileDescriptorStorePreserve,NotifyAccess"])
      .catch(() => { throw new CommandInspectionError("manager-unavailable"); });
    const fields = Object.fromEntries(result.stdout.trim().split("\n").map(line => {
      const equal = line.indexOf("=");
      return [line.slice(0, equal), line.slice(equal + 1)];
    }));
    if (fields.LoadState === "not-found") throw new CommandInspectionError("activation-unavailable");
    if (result.code !== 0) throw new CommandInspectionError("manager-unavailable");
    const { InvocationID, ActiveState, MainPID, NFileDescriptorStore, FileDescriptorStoreMax, FileDescriptorStorePreserve, NotifyAccess } = fields;
    if (fields.LoadState !== "loaded" || InvocationID === undefined || !/^[a-f0-9]{32}$/.test(InvocationID)
      || MainPID === undefined || !/^[0-9]+$/.test(MainPID) || NFileDescriptorStore === undefined || !/^[0-9]+$/.test(NFileDescriptorStore)
      || FileDescriptorStoreMax === undefined || !/^[0-9]+$/.test(FileDescriptorStoreMax)
      || FileDescriptorStorePreserve === undefined || NotifyAccess === undefined)
      throw new CommandInspectionError("activation-unavailable");
    return {
      invocationId: InvocationID, mainPid: Number(MainPID), stored: Number(NFileDescriptorStore), maximum: Number(FileDescriptorStoreMax),
      phase: ActiveState === "active" || ActiveState === "inactive" || ActiveState === "failed" ? ActiveState : "transitional",
      preserve: FileDescriptorStorePreserve, notify: NotifyAccess,
    };
  }

  private binding(evidence: CommandEvidence, spec: CommandSpec, digest: string): void {
    if (evidence.executionId !== spec.executionId || evidence.workspaceId !== spec.workspaceId || evidence.intentId !== spec.intentId
      || evidence.nonce !== spec.nonce || evidence.specSha256 !== digest || evidence.activation.unit !== spec.unit)
      throw new CommandInspectionError("binding-mismatch");
  }

  async launch(input: {
    readonly directory: CommandDirectory;
    readonly source: CommandSource;
    readonly spec: CommandSpec;
    readonly digest: string;
    readonly activation: (evidence: CommandEvidence) => Promise<void>;
  }): Promise<CommandEvidence> {
    const { directory, source, spec, digest } = input;
    if (commandDigest(await directory.read("spec.json", 32768)) !== digest
      || source.cwd !== spec.cwd || !isDeepStrictEqual(source.context, spec.context) || source.environmentSha256 !== spec.environmentSha256)
      throw new Error("Command handoff differs from committed spec");
    const started = await invoke(this.options.systemdRun, ["--user", "--quiet", `--unit=${spec.unit}`, "--service-type=exec",
      "--property=Restart=no", "--property=KillMode=control-group", "--property=TimeoutStopSec=2s",
      `--property=RuntimeMaxSec=${spec.timeoutSeconds + 20}s`, "--property=NotifyAccess=main", "--property=FileDescriptorStoreMax=1",
      "--property=FileDescriptorStorePreserve=yes", ...this.options.launcher, this.options.helper, "service", directory.path, digest]);
    if (started.code !== 0) throw new Error("Command unit request outcome requires inspection");
    const readyDeadline = performance.now() + 6000;
    let ready: CommandEvidence | undefined;
    while (performance.now() < readyDeadline) {
      const bytes = await directory.optional("ready.json", 32768);
      if (bytes !== undefined) { ready = parseCommandEvidence(bytes); break; }
      await delay(20);
    }
    if (ready === undefined) throw new Error("Command activation acknowledgement unavailable");
    this.binding(ready, spec, digest);
    const executable = await stat(this.options.helper, { bigint: true });
    if (ready.activation.executable.device !== executable.dev.toString() || ready.activation.executable.inode !== executable.ino.toString())
      throw new Error("Unexpected command helper executable");
    const before = await this.unit(spec.unit);
    if (before.invocationId !== ready.activation.invocationId || before.mainPid !== ready.activation.pid)
      throw new Error("Command launcher did not preserve the helper as main process");
    await input.activation(ready);
    const control = await invoke(this.options.helper, ["signal", directory.path, digest, "--check"]);
    if (control.code !== 0) throw new Error("Original helper cannot be controlled from this source context");
    const sender: { phase: "pending" | "acknowledged" | "lost" } = { phase: "pending" };
    const joined = source.deliver(directory, spec, digest).then(
      () => { sender.phase = "acknowledged"; },
      () => { sender.phase = "lost"; },
    );
    try {
      const deadline = performance.now() + 4000;
      let captured: CommandEvidence | undefined;
      while (performance.now() < deadline) {
        if (sender.phase === "lost") throw new Error("Command capture refused");
        const bytes = await directory.optional("captured.json", 32768);
        if (bytes !== undefined) { captured = parseCommandEvidence(bytes); break; }
        if (await directory.optional("exit.json", 32768) !== undefined) throw new Error("Command capture did not reach custody admission");
        await delay(10);
      }
      if (captured === undefined || !isDeepStrictEqual(captured, ready)) throw new Error("Command custody evidence unavailable");
      const custody = await this.unit(spec.unit);
      if (custody.invocationId !== ready.activation.invocationId || custody.mainPid !== ready.activation.pid || custody.phase !== "active"
        || custody.stored !== 1 || custody.maximum !== 1 || custody.preserve !== "yes" || custody.notify !== "main")
        throw new Error("Manager did not accept original namespace custody");
      await directory.publish("admit.json", JSON.stringify(captured));
      await joined;
      if (sender.phase === "lost") throw new Error("Command capture acknowledgement lost");
      const claim = parseCommandClaim(await directory.read("claim.json", 32768));
      if (!isDeepStrictEqual(claim.evidence, ready) || !isDeepStrictEqual(claim.context, spec.context))
        throw new Error("Command claim binding mismatch");
      return ready;
    } finally { await joined; }
  }

  async inspect(input: { readonly directory: CommandDirectory; readonly spec: CommandSpec; readonly digest: string; readonly evidence?: CommandEvidence }): Promise<CommandObservation> {
    let outcome: CommandObservation["outcome"] = { kind: "unobserved" };
    try {
      const bytes = await input.directory.optional("exit.json", 32768);
      const receipt = bytes === undefined ? undefined : checkedReceipt(bytes);
      const original = input.evidence ?? receipt?.evidence;
      if (original === undefined) return { outcome, containment: { kind: "unknown", reason: "activation-missing" } };
      this.binding(original, input.spec, input.digest);
      if (receipt !== undefined && !isDeepStrictEqual(receipt.evidence, original)) throw new CommandInspectionError("receipt-binding-mismatch");
      if (receipt !== undefined) outcome = { kind: "recorded", receipt };
      const before = await this.unit(input.spec.unit);
      if (before.invocationId !== original.activation.invocationId) throw new CommandInspectionError("activation-changed");
      if (before.preserve !== "yes" || before.maximum !== 1 || before.notify !== "main" || before.stored !== 1)
        throw new CommandInspectionError("namespace-custody-unavailable");
      if (before.phase === "active") {
        if (before.mainPid !== original.activation.pid) throw new CommandInspectionError("main-process-changed");
        return { outcome, containment: { kind: "active", evidence: original } };
      }
      if (before.phase !== "inactive" && before.phase !== "failed")
        return { outcome, containment: { kind: "unknown", reason: "activation-transitioning" } };
      if (before.mainPid !== 0) throw new CommandInspectionError("containment-unproven");
      const result = await invoke(this.options.busctl, ["--user", "--json=short", "call", "org.freedesktop.systemd1", "/org/freedesktop/systemd1",
        "org.freedesktop.systemd1.Manager", "GetUnitProcesses", "s", input.spec.unit])
        .catch(() => { throw new CommandInspectionError("manager-unavailable"); });
      if (result.code !== 0) throw new CommandInspectionError("manager-unavailable");
      let processes: unknown;
      try { processes = JSON.parse(result.stdout); }
      catch { throw new CommandInspectionError("containment-unproven"); }
      if (!Check(processList, processes) || processes.data[0].length !== 0) throw new CommandInspectionError("containment-unproven");
      const after = await this.unit(input.spec.unit);
      if (after.invocationId !== original.activation.invocationId || after.phase !== before.phase || after.mainPid !== 0
        || after.stored !== before.stored || after.preserve !== "yes" || after.maximum !== 1 || after.notify !== "main")
        throw new CommandInspectionError("activation-changed");
      outcome = { kind: "unobserved" };
      const finalBytes = await input.directory.optional("exit.json", 32768);
      if (bytes !== undefined && finalBytes !== bytes) throw new CommandInspectionError("receipt-changed");
      const finalReceipt = finalBytes === undefined ? undefined : checkedReceipt(finalBytes);
      if (finalReceipt !== undefined && !isDeepStrictEqual(finalReceipt.evidence, original)) throw new CommandInspectionError("receipt-binding-mismatch");
      if (finalReceipt !== undefined) outcome = { kind: "recorded", receipt: finalReceipt };
      const witness: ContainmentWitness = {
        unit: input.spec.unit, invocationId: original.activation.invocationId, observedAt: Date.now(), source: "systemd-manager",
      };
      return { outcome, containment: { kind: "empty", evidence: original, witness } };
    } catch (error) {
      return { outcome, containment: { kind: "unknown", reason: error instanceof CommandInspectionError ? error.reason : "observation-unavailable" } };
    }
  }

  async cancel(input: { readonly directory: CommandDirectory; readonly spec: CommandSpec; readonly digest: string }): Promise<void> {
    const bytes = JSON.stringify({ version: 1, nonce: input.spec.nonce, specSha256: input.digest });
    const current = await input.directory.optional("cancel.json", 1024);
    if (current === undefined) await input.directory.publish("cancel.json", bytes);
    else if (!isDeepStrictEqual(JSON.parse(current), JSON.parse(bytes))) throw new Error("Command cancellation binding mismatch");
    const result = await invoke(this.options.helper, ["signal", input.directory.path, input.digest]);
    if (result.code !== 0) throw new Error("Original command signal was not confirmed; inspect status");
  }

  async release(input: { readonly spec: CommandSpec; readonly digest: string; readonly evidence: CommandEvidence; readonly containment: ContainmentWitness }): Promise<void> {
    this.binding(input.evidence, input.spec, input.digest);
    if (input.containment.unit !== input.spec.unit || input.containment.invocationId !== input.evidence.activation.invocationId)
      throw new Error("Command containment witness does not match activation");
    const before = await this.unit(input.spec.unit);
    if (before.invocationId !== input.containment.invocationId || before.mainPid !== 0 || (before.phase !== "inactive" && before.phase !== "failed")
      || before.preserve !== "yes" || before.stored !== 1)
      throw new Error("Original inactive namespace custody unavailable for release");
    if (before.phase === "failed") {
      const reset = await invoke(this.options.systemctl, ["--user", "reset-failed", input.spec.unit]);
      if (reset.code !== 0) throw new Error("Original contained failure could not be reset");
      const inactive = await this.unit(input.spec.unit);
      if (inactive.invocationId !== input.containment.invocationId || inactive.phase !== "inactive" || inactive.mainPid !== 0 || inactive.stored !== 1 || inactive.preserve !== "yes")
        throw new Error("Original namespace custody changed during failed-state cleanup");
    }
    const result = await invoke(this.options.systemctl, ["--user", "clean", "--what=fdstore", input.spec.unit]);
    if (result.code !== 0) throw new Error("Original command namespace custody was not released");
  }
}
