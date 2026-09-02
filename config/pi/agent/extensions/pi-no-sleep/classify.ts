const SLEEP_RE = /\bsleep\s+(\d+(?:\.\d+)?)\s*([smh])?\b/g;
const UNBOUNDED_LOOP_RE = /\b(while|until)\b[\s\S]*?\bdo\b[\s\S]*?\bsleep\b/;
const BOUNDED_LOOP_RE =
  /\bfor\b[^;]*?(?:seq\s+(?:\d+\s+)?(\d+)|\{\d+\.\.(\d+)\})[\s\S]*?\bdo\b([\s\S]*?)\bdone\b/g;
export const LIMIT_SECONDS = 30;

function seconds(amount: string, unit: string | undefined): number {
  const n = Number(amount);
  return unit === "m" ? n * 60 : unit === "h" ? n * 3600 : n;
}

function longestSleep(command: string): number {
  let longest = 0;
  for (const match of command.matchAll(SLEEP_RE)) {
    longest = Math.max(longest, seconds(match[1], match[2]));
  }
  return longest;
}

function boundedLoopWait(command: string): number {
  let longest = 0;
  for (const match of command.matchAll(BOUNDED_LOOP_RE)) {
    const iterations = Number(match[1] ?? match[2]);
    longest = Math.max(longest, iterations * longestSleep(match[3]));
  }
  return longest;
}

export function isSleepPolling(command: string): boolean {
  if (!/\bsleep\b/.test(command)) return false;
  if (longestSleep(command) >= LIMIT_SECONDS) return true;
  if (UNBOUNDED_LOOP_RE.test(command)) return true;
  return boundedLoopWait(command) >= LIMIT_SECONDS;
}
