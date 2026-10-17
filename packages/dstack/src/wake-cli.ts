import { randomUUID } from "node:crypto";
import {
  callWatches,
  parseWatchRequest,
  type WatchRequest,
} from "../../../config/pi/agent/lib/dstack-watches.js";

function timestamp(value: string | undefined): number {
  if (!value || !/(Z|[+-]\d\d:\d\d)$/.test(value))
    throw new Error("Use an ISO timestamp with timezone");
  const at = Date.parse(value);
  if (!Number.isSafeInteger(at) || at < 0) throw new Error("Invalid timestamp");
  return at;
}
export function duration(value: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(value);
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };
  const unit = match?.[2] ? units[match[2]] : undefined;
  if (!match?.[1] || !unit) throw new Error("Use a positive duration such as 30s, 5m, 2h, or 1d");
  const ms = Number(match[1]) * unit;
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error("Invalid duration");
  return ms;
}
export async function wakeCommand(args: string[]): Promise<void> {
  const [op, ...rest] = args;
  let input: WatchRequest;
  if (op === "status" || op === "cancel") {
    if (rest.length !== 1) throw new Error("Expected one watch ID");
    input = parseWatchRequest({ op, id: rest[0] });
  } else {
    if (op !== "create" && op !== "list")
      throw new Error("Expected wake create|list|status|cancel");
    const flags = new Map<string, string>();
    while (rest.length) {
      const key = rest.shift();
      const value = rest.shift();
      if (
        !key ||
        value === undefined ||
        flags.has(key) ||
        !(
          op === "list"
            ? ["--session"]
            : [
                "--session",
                "--request-id",
                "--in",
                "--at",
                "--repo",
                "--pr",
                "--deadline",
                "--message",
              ]
        ).includes(key)
      )
        throw new Error("Invalid wake arguments");
      flags.set(key, value);
    }
    if (op === "list") input = parseWatchRequest({ op, sessionId: flags.get("--session") });
    else {
      const requestId = flags.get("--request-id") ?? randomUUID();
      if (flags.size === 1 && flags.has("--request-id")) {
        const snapshot = await callWatches({ op: "list" });
        const watch = snapshot.watches.find((w) => w.requestId === requestId);
        if (!watch)
          throw new Error("Retry key not found; provide the original absolute create arguments");
        console.log(JSON.stringify({ ...snapshot, watches: [watch] }));
        return;
      }
      const now = Date.now();
      const timerCount = Number(flags.has("--in")) + Number(flags.has("--at"));
      const checks = flags.has("--repo") || flags.has("--pr");
      if ((checks && timerCount !== 0) || (!checks && timerCount !== 1))
        throw new Error("Choose --in, --at, or --repo with --pr");
      const trigger = checks
        ? { kind: "github-checks", repo: flags.get("--repo"), pr: Number(flags.get("--pr")) }
        : {
            kind: "timer",
            at: flags.has("--in")
              ? now + duration(flags.get("--in") ?? "")
              : timestamp(flags.get("--at")),
          };
      input = parseWatchRequest({
        op,
        registration: {
          requestId,
          sessionId: flags.get("--session") ?? process.env.PI_SESSION_ID,
          trigger,
          deadline: flags.has("--deadline")
            ? timestamp(flags.get("--deadline"))
            : (trigger.kind === "timer" && trigger.at !== undefined ? trigger.at : now) + 3600_000,
          message: flags.get("--message"),
        },
      });
    }
  }
  console.log(JSON.stringify(await callWatches(input)));
}
