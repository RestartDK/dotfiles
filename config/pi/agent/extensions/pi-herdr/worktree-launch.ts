import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { expectResult, type HerdrClient } from "./client.ts";

type LaunchStatus =
  | { kind: "queued" | "environment" | "pi" }
  | { kind: "exited"; phase: "environment" | "pi"; code: number };

export class HandoffLaunch {
  readonly directory: string;
  readonly statusPath: string;
  readonly logPath: string;

  constructor(claimPath: string, id: string) {
    this.directory = join(dirname(claimPath), "pi-herdr-handoff-logs", id);
    this.statusPath = join(this.directory, "status");
    this.logPath = join(this.directory, "launch.log");
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.statusPath, "queued", { flag: "wx", mode: 0o600 });
    await writeFile(this.logPath, "", { flag: "wx", mode: 0o600 });
  }

  async read(): Promise<LaunchStatus> {
    const value = (await readFile(this.statusPath, "utf8")).trim();
    switch (value) {
      case "queued":
      case "environment":
      case "pi":
        return { kind: value };
      default: {
        const exited = /^exited:(environment|pi):([0-9]{1,3})$/.exec(value);
        if (
          exited &&
          (exited[1] === "environment" || exited[1] === "pi") &&
          Number(exited[2]) <= 255
        )
          return { kind: "exited", phase: exited[1], code: Number(exited[2]) };
        throw new Error(`Invalid handoff launch status at ${this.statusPath}.`);
      }
    }
  }

  async capture(herdr: Pick<HerdrClient, "call">, paneId: string): Promise<void> {
    for (const source of ["recent_unwrapped", "visible"] as const) {
      const result = expectResult(
        await herdr.call(
          "pane.read",
          { pane_id: paneId, source, lines: 100, strip_ansi: true },
          { timeoutMs: 5000 },
        ),
        "pane_read",
      );
      await appendFile(this.logPath, `\n[${source}]\n${result.read.text.slice(-32_000)}\n`, {
        mode: 0o600,
      });
    }
  }
}

export function handoffResourceArgs(argv: string[], cwd: string): string[] {
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") break;
    if (
      [
        "-ne",
        "--no-extensions",
        "-ns",
        "--no-skills",
        "-nc",
        "--no-context-files",
        "-nt",
        "--no-tools",
        "-nbt",
        "--no-builtin-tools",
        "-a",
        "--approve",
        "-na",
        "--no-approve",
      ].includes(arg)
    )
      args.push(arg);
    if (["-t", "--tools", "-xt", "--exclude-tools"].includes(arg) && argv[i + 1] !== undefined) {
      args.push(arg, argv[++i]);
      continue;
    }
    if (
      [
        "--provider",
        "--model",
        "--api-key",
        "--system-prompt",
        "--append-system-prompt",
        "--name",
        "-n",
        "--session",
        "--session-id",
        "--fork",
        "--session-dir",
        "--models",
        "--thinking",
        "--export",
        "--skill",
        "--prompt-template",
        "--theme",
      ].includes(arg) &&
      argv[i + 1] !== undefined
    ) {
      i++;
      continue;
    }
    if (
      ["--mode", "--use-theme", "--tui-mode"].includes(arg) &&
      argv[i + 1] !== undefined &&
      !argv[i + 1].startsWith("-")
    ) {
      i++;
      continue;
    }
    if (["-e", "--extension"].includes(arg) && argv[i + 1] !== undefined) {
      const path = argv[++i];
      args.push(arg, path.startsWith("builtin:") || isAbsolute(path) ? path : resolve(cwd, path));
    }
  }
  return args;
}

export function buildPiHandoffCommand(options: {
  sessionFile: string;
  sessionName: string | undefined;
  successorId: string;
  model: Pick<NonNullable<ExtensionContext["model"]>, "provider" | "id">;
  thinking: ReturnType<ExtensionAPI["getThinkingLevel"]>;
  resourceArgs: string[];
  launch: HandoffLaunch;
  namespace?: string;
}): string {
  const args = [
    "pi",
    ...options.resourceArgs,
    "--fork",
    options.sessionFile,
    "--session-id",
    options.successorId,
    "--provider",
    options.model.provider,
    "--model",
    options.model.id,
    "--thinking",
    options.thinking,
  ];
  const name = options.sessionName?.trim();
  if (name) args.push("--name", name);
  args.push("--", `/worktree-continue ${options.successorId}`);
  const statusPath = shellQuote(options.launch.statusPath);
  const logPath = shellQuote(options.launch.logPath);
  const receipt = `code=$?; printf 'exited:%s:%s\\n' "$phase" "$code" > ${statusPath}.tmp; mv ${statusPath}.tmp ${statusPath}`;
  const script = [
    "set -e",
    "phase=environment",
    `trap ${shellQuote(receipt)} EXIT`,
    `printf 'environment' > ${statusPath}.tmp; mv ${statusPath}.tmp ${statusPath}`,
    `if [ -f .envrc ] && command -v direnv >/dev/null 2>&1; then direnv allow . >> ${logPath} 2>&1; exports="$(direnv export bash 2>> ${logPath})"; eval "$exports"; fi`,
    ...(options.namespace
      ? [
          `export PI_NETNS=${shellQuote(options.namespace)} PI_NETNS_SELECTED=${shellQuote(options.namespace)}`,
        ]
      : []),
    `phase=pi; printf 'pi' > ${statusPath}.tmp; mv ${statusPath}.tmp ${statusPath}`,
    args.map(shellQuote).join(" "),
  ].join("; ");
  return `bash -c ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
