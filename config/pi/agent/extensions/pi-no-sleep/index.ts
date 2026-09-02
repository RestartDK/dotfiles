import { isToolCallEventType, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { isSleepPolling } from "./classify.ts";

const REASON =
  "Blocked: bash sleep polling holds this turn and nobody can interject. " +
  "Use the herdr tool instead: `run` with `wait: true` (blocks on a real completion check and returns the exit code) " +
  "or `notify: true` (returns now; a message arrives when the command exits) for anything that finishes; " +
  "`watch` for readiness patterns; `wait_agent` for agent panes. Sleeps under 30s outside loops are allowed.";

export default function piNoSleep(pi: ExtensionAPI): void {
  pi.on("tool_call", (event) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!isSleepPolling(event.input.command)) return;
    return { block: true, reason: REASON };
  });
}
