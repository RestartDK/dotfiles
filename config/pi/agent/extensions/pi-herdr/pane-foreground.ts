import { readFile, readlink } from "node:fs/promises";
import { basename } from "node:path";
import type { PaneProcessInfo } from "./generated/success-response.ts";

export type ForegroundObservation =
  { kind: "idle" } | { kind: "initializing" } | { kind: "busy"; reason: string };

export interface ProcProcess {
  pid: number;
  parentPid: number;
  groupId: number;
  tty: number;
  foregroundGroupId: number;
  shell: "interactive" | "other";
}

const shells = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "nu"]);

export function parseProcStat(stat: string): Omit<ProcProcess, "shell"> & { name: string } {
  const end = stat.lastIndexOf(")");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(stat.slice(0, stat.indexOf(" ")));
  const values = [pid, ...[1, 2, 4, 5].map((index) => Number(fields[index]))];
  if (
    end < 0 ||
    fields.length < 20 ||
    values.some((value) => !Number.isSafeInteger(value)) ||
    pid <= 0
  )
    throw new Error("Invalid Linux process stat record.");
  return {
    pid,
    name: stat.slice(stat.indexOf("(") + 1, end),
    parentPid: values[1],
    groupId: values[2],
    tty: values[3],
    foregroundGroupId: values[4],
  };
}

export async function readProcTree(rootPid: number): Promise<ProcProcess[]> {
  const records: ProcProcess[] = [];
  const pending = [rootPid];
  const seen = new Set<number>();
  while (pending.length) {
    const pid = pending.pop();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const path = `/proc/${pid}`;
    try {
      const stat = parseProcStat(await readFile(`${path}/stat`, "utf8"));
      const children = (await readFile(`${path}/task/${pid}/children`, "utf8")).trim();
      if (children) {
        const pids = children.split(/\s+/).map(Number);
        if (pids.some((child) => !Number.isSafeInteger(child) || child <= 0))
          throw new Error("Invalid Linux process children record.");
        pending.push(...pids);
      }
      let shell: ProcProcess["shell"] = "other";
      if (shells.has(stat.name) && stat.tty !== 0) {
        const executable = basename(await readlink(`${path}/exe`));
        const argv = (await readFile(`${path}/cmdline`, "utf8")).split("\0").filter(Boolean);
        if (
          shells.has(executable) &&
          argv.length &&
          argv
            .slice(1)
            .every(
              (arg) =>
                /^-[il]+$/.test(arg) ||
                ["--login", "--interactive", "--norc", "--noprofile"].includes(arg),
            )
        )
          shell = "interactive";
      }
      records.push({ ...stat, shell });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return records;
}

export async function observePaneForeground(
  info: PaneProcessInfo,
  options: { platform?: NodeJS.Platform; readTree?: typeof readProcTree } = {},
): Promise<ForegroundObservation> {
  if (info.shell_pid == null || info.foreground_process_group_id == null)
    return { kind: "initializing" };
  if (info.foreground_process_group_id !== info.shell_pid)
    return {
      kind: "busy",
      reason: `Foreground process group ${info.foreground_process_group_id} is running.`,
    };
  if ((options.platform ?? process.platform) !== "linux") return { kind: "idle" };
  const records = await (options.readTree ?? readProcTree)(info.shell_pid);
  if (!records.some((record) => record.pid === info.shell_pid)) return { kind: "initializing" };
  const interactive = records.filter((record) => record.shell === "interactive");
  if (!interactive.length) return { kind: "initializing" };
  for (const shell of interactive) {
    if (shell.groupId !== shell.pid) return { kind: "initializing" };
    if (
      shell.foregroundGroupId !== shell.groupId &&
      !interactive.some(
        (foreground) =>
          foreground.tty === shell.tty && foreground.groupId === shell.foregroundGroupId,
      )
    )
      return {
        kind: "busy",
        reason: `Shell ${shell.pid} has foreground process group ${shell.foregroundGroupId}.`,
      };
  }
  const byPid = new Map(records.map((record) => [record.pid, record]));
  const ancestors = new Set<number>();
  for (const shell of interactive) {
    let parent = byPid.get(shell.parentPid);
    while (parent && !ancestors.has(parent.pid)) {
      ancestors.add(parent.pid);
      parent = byPid.get(parent.parentPid);
    }
  }
  const foregroundJob = records.find(
    (record) =>
      record.tty !== 0 &&
      record.pid === record.foregroundGroupId &&
      record.shell === "other" &&
      !ancestors.has(record.pid),
  );
  return foregroundJob
    ? { kind: "busy", reason: `Foreground job ${foregroundJob.pid} is running.` }
    : { kind: "idle" };
}
