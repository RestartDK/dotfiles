import { readFile } from "node:fs/promises";
import { CommandRuntime } from "./command-runtime.js";
import { parseCommandCredentials } from "./command-wire.js";
import type { HostCommandRuntime } from "./host-execution.js";

export async function hostCommandRuntime(): Promise<HostCommandRuntime> {
  if (process.platform !== "linux") throw new Error("Durable command ownership requires Linux");
  function executable(name: string): string {
    const value = process.env[name];
    if (value === undefined) throw new Error(`Required command executable reference missing: ${name}`);
    return value;
  }
  const uid = process.getuid?.(), gid = process.getgid?.(), groups = process.getgroups?.();
  if (uid === undefined || gid === undefined || groups === undefined) throw new Error("Host kernel credentials unavailable");
  const credentials = parseCommandCredentials(JSON.stringify({ uid, gid, groups: [...new Set([...groups, gid])].sort((a, b) => a - b) }));
  const sourceBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sourceBootId)) throw new Error("Host boot identity unavailable");
  return {
    sourceBootId,
    runtime: new CommandRuntime({
      helper: executable("DSTACK_COMMAND_HELPER"), systemdRun: executable("DSTACK_SYSTEMD_RUN"),
      systemctl: executable("DSTACK_SYSTEMCTL"), busctl: executable("DSTACK_BUSCTL"),
      credentials, environmentNames: ["PATH", "HOME", "LANG", "TMPDIR"], launcher: [],
    }),
  };
}
