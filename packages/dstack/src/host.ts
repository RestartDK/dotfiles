import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { array, number, record, string } from "../../../config/pi/agent/lib/dstack-jobs.js";

export type Command = { file: string; args: string[] };
export type ProcessKey = "DSTACK_PROCESS_TOKEN" | "DSTACK_PROCESS_SCOPE";
export type SignalAction = "SIGTERM" | "SIGKILL";

/**
 * `start` is opaque to TypeScript. It is compared for equality only, never parsed and never
 * used arithmetically. Linux supplies `/proc/<pid>/stat` field 20; Darwin supplies
 * `<pbi_start_tvsec>.<pbi_start_tvusec>`.
 */
export type ProcessIdentity = {
  readonly pid: number;
  readonly start: string;
  readonly token: string;
  readonly key: ProcessKey;
};

export type Host = {
  owned(token: string, key: ProcessKey): Promise<ProcessIdentity[]>;
  signal(identity: ProcessIdentity, action: SignalAction): Promise<void>;
  verify(): Promise<void>;
};

const exec = promisify(execFile);
const python = () => process.env.DSTACK_PYTHON || "python3";
const processScan = `import json, os, sys
wanted, key = sys.argv[1:]
result = []
for pid in os.listdir('/proc'):
    if not pid.isdecimal():
        continue
    path = '/proc/' + pid
    try:
        if os.stat(path).st_uid != os.getuid():
            continue
        with open(path + '/environ', 'rb') as f:
            env = f.read().split(b'\\0')
        if (key + '=' + wanted).encode() not in env:
            continue
        with open(path + '/stat') as f:
            fields = f.read().rsplit(')', 1)[1].split()
        if fields[0] != 'Z':
            result.append({'pid':int(pid), 'start':fields[19]})
    except (ProcessLookupError, FileNotFoundError, PermissionError):
        continue
print(json.dumps(result))
`;
const pidfdSignal = `import os, signal, sys
pid, started, token, key, action = sys.argv[1:]
try:
    fd = os.pidfd_open(int(pid))
    try:
        path = '/proc/' + pid
        with open(path + '/stat') as f:
            actual = f.read().rsplit(')', 1)[1].split()[19]
        with open(path + '/environ', 'rb') as f:
            env = f.read().split(b'\\0')
        if actual == started and (key + '=' + token).encode() in env and os.stat(path).st_uid == os.getuid():
            signal.pidfd_send_signal(fd, getattr(signal, action))
    finally:
        os.close(fd)
except (ProcessLookupError, FileNotFoundError):
    pass
`;
const pidfdProbe = `import os
os.pidfd_open(os.getpid())
`;

function linuxHost(): Host {
  return {
    async owned(token, key) {
      const output = await exec(python(), ["-c", processScan, token, key], {
        timeout: 3000,
        maxBuffer: 128 * 1024,
      });
      const parsed: unknown = JSON.parse(output.stdout);
      return array(parsed).map((raw) => {
        const value = record(raw);
        return { pid: number(value.pid), start: string(value.start), token, key };
      });
    },
    async signal(identity, action) {
      await exec(
        python(),
        [
          "-c",
          pidfdSignal,
          String(identity.pid),
          identity.start,
          identity.token,
          identity.key,
          action,
        ],
        { timeout: 3000, maxBuffer: 1024 },
      );
    },
    async verify() {
      await exec(python(), ["-c", pidfdProbe], { timeout: 3000, maxBuffer: 1024 });
    },
  };
}

function darwinHost(): Host {
  const proc = process.env.DSTACK_PROC || "dstack-proc";
  const runProc = (args: string[], maxBytes: number) =>
    exec(proc, args, { timeout: 3000, maxBuffer: maxBytes });
  return {
    async owned(token, key) {
      const output = await runProc(["owned", key, token], 128 * 1024);
      const parsed: unknown = JSON.parse(output.stdout);
      return array(parsed).map((raw) => {
        const value = record(raw);
        return { pid: number(value.pid), start: string(value.start), token, key };
      });
    },
    async signal(identity, action) {
      await runProc(
        ["signal", String(identity.pid), identity.start, identity.key, identity.token, action],
        1024,
      );
    },
    async verify() {
      await runProc(["verify"], 1024);
    },
  };
}

let selected: Host | null = null;

export function host(): Host {
  if (selected) return selected;
  switch (process.platform) {
    case "linux":
      return (selected = linuxHost());
    case "darwin":
      return (selected = darwinHost());
    default:
      throw new Error(`No process-ownership backend for platform ${process.platform}`);
  }
}
