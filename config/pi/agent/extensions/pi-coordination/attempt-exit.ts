import type { Attempt } from "./core.ts";

export function attemptExitCode(attempt: Pick<Attempt, "state" | "outcome" | "exitCode">): number {
  if (attempt.state === "blocked") return 75;
  switch (attempt.outcome) {
    case "completed":
      return 0;
    case "failed":
    case "cancelled":
      return attempt.exitCode === undefined || attempt.exitCode === 0 ? 1 : attempt.exitCode;
    case "unknown":
      return 1;
  }
}
