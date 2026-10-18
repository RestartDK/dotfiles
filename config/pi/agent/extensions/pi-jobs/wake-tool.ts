import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import {
  parseWatchRequest,
  type WatchRequest,
  type WatchSnapshot,
} from "../../lib/dstack-watches.ts";
import { prioritizedWatches } from "./view.ts";
import type { wakeParameters } from "./wake-schema.ts";

export function nativeWatchRequest(
  id: string,
  params: Static<typeof wakeParameters>,
  session: Pick<
    ExtensionContext["sessionManager"],
    "getSessionId" | "getSessionFile" | "getBranch"
  >,
): WatchRequest {
  const sessionId = session.getSessionId();
  switch (params.op) {
    case "create": {
      if (!session.getSessionFile())
        throw new Error("Scheduled wakes require a persistent native session");
      const origin = session
        .getBranch()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      if (!origin) throw new Error("Cannot identify the native tool-call origin");
      const requestId = `pi:${createHash("sha256")
        .update(JSON.stringify([sessionId, origin.id, id]))
        .digest("hex")}`;
      return parseWatchRequest({
        op: params.op,
        registration: {
          requestId,
          sessionId,
          trigger: params.trigger,
          deadline: params.deadline,
          message: params.message,
        },
      });
    }
    case "list":
      return { op: params.op, sessionId };
    case "status":
    case "cancel":
      return parseWatchRequest(params);
  }
}
export function watchToolResult(snapshot: WatchSnapshot): WatchSnapshot & { omitted: number } {
  return {
    ...snapshot,
    watches: prioritizedWatches(snapshot.watches).slice(0, 64),
    omitted: Math.max(0, snapshot.watches.length - 64),
  };
}
