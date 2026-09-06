import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { setTimeout } from "node:timers/promises";

export class ShellReady {
  private readonly directory: string;

  private constructor(directory: string) {
    this.directory = directory;
  }

  static async create(): Promise<ShellReady> {
    return new ShellReady(await mkdtemp(join(homedir(), ".pi-shell-ready-")));
  }

  get env(): Record<string, string> {
    return { PI_HERDR_READY_FILE: join(this.directory, "result") };
  }

  async wait(signal?: AbortSignal, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      let result: string | undefined;
      try {
        result = await readFile(this.env.PI_HERDR_READY_FILE, "utf8");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      if (result?.trim() === "0") return;
      if (result?.trim()) {
        throw new Error(
          `Shell environment preparation failed with status ${result.trim()}. Read the pane for the error; no command was submitted.`,
        );
      }
      await setTimeout(50, undefined, { signal });
    }
    throw new Error(
      "Shell environment preparation timed out. Read the pane for pending evaluation or missing repo-env shell integration; no command was submitted.",
    );
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

export async function createPreparedShell<T>(
  environment: NodeJS.ProcessEnv,
  create: (env: Record<string, string>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const ready = await ShellReady.create();
  try {
    const created = await create({ ...shellLaunchEnv(environment), ...ready.env });
    await ready.wait(signal);
    return created;
  } finally {
    await ready.dispose();
  }
}

export function shellLaunchEnv(environment: NodeJS.ProcessEnv): Record<string, string> {
  const namespace = environment.PI_NETNS_SELECTED?.trim();
  if (!namespace) return {};
  return {
    PI_HERDR_ENTER_NETNS: namespace,
    PI_NETNS: namespace,
    PI_NETNS_SELECTED: namespace,
    PI_NETNS_RUN_DEV_NETNS:
      environment.PI_NETNS_RUN_DEV_NETNS?.trim() || "/run/current-system/sw/bin/run-dev-netns",
  };
}

export function preparedCommand(command: string): string {
  return `repo_env_prepare && { ${command}\n}`;
}
