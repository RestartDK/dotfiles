import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let stateDir: string | null = null;

export function getPromptStateDir(): string {
  if (stateDir) return stateDir;

  const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
  const promptDir = join(homeDir, ".pi", "agent", "pi-prompt");
  const legacyDir = join(homeDir, ".pi", "agent", "powerline-footer");

  if (!existsSync(promptDir) && existsSync(legacyDir)) {
    try {
      renameSync(legacyDir, promptDir);
    } catch (error) {
      console.debug(`[pi-prompt] Failed to migrate state from ${legacyDir} to ${promptDir}:`, error);
      stateDir = legacyDir;
      return stateDir;
    }
  }

  stateDir = promptDir;
  return stateDir;
}
