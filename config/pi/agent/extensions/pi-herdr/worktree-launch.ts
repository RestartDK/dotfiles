import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { LaunchAttempt } from "./launch-attempt.ts";

export function handoffLaunchDirectory(claimPath: string, id: string): string {
  return join(dirname(claimPath), "pi-herdr-handoff-logs", id);
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
  launch: LaunchAttempt;
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
  return options.launch.command(args);
}
