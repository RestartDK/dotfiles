import { mkdir, rmdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function withHandoffLock<T>(
  claimPath: string,
  contention: "wait" | "reject",
  operation: () => Promise<T>,
): Promise<T> {
  const lock = `${claimPath}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      if (contention === "reject" || Date.now() >= deadline)
        throw new Error(
          `This checkout has a handoff reservation being changed at ${lock}. If its operation crashed, inspect the destination and remove this lock directory only after confirming no operation still owns it.`,
        );
      await delay(25);
    }
  }
  try {
    return await operation();
  } finally {
    await rmdir(lock);
  }
}
