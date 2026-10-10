import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "./process.js";

export async function acquireLock(
  directory: string,
  command: Command,
  lease: { name: string; waitSeconds: number } = { name: "daemon.lock", waitSeconds: 0 },
): Promise<() => Promise<void>> {
  const file = await open(
    join(directory, lease.name),
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid?.())
      throw new Error("Invalid daemon lock file");
    await new Promise<void>((resolve, reject) => {
      const flags =
        lease.waitSeconds > 0 ? ["--timeout", String(lease.waitSeconds)] : ["--nonblock"];
      const child = spawn(command.file, [...command.args, ...flags, "0"], {
        stdio: [file.fd, "ignore", "ignore"],
      });
      const timeout = setTimeout(
        () => {
          child.kill("SIGKILL");
          reject(new Error("Lock deadline exceeded"));
        },
        (lease.waitSeconds + 5) * 1000,
      );
      child.once("error", () => {
        clearTimeout(timeout);
        reject(new Error("Cannot start flock"));
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              lease.waitSeconds
                ? "Jobs launch lock deadline exceeded"
                : "Another daemon owns this state directory",
            ),
          );
      });
    });
    return () => file.close();
  } catch (error) {
    await file.close();
    throw error;
  }
}
