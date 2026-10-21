import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  callJobs,
  parseRequest,
  subscribeJobs,
  type Connection,
  type JobRequest,
} from "../../lib/dstack-jobs.ts";
import { jobToolResult, modelContext } from "./view.ts";
import { callWatches } from "../../lib/dstack-watches.ts";
import { nativeWatchRequest, watchToolResult } from "./wake-tool.ts";
import { WakeReceiver } from "./wake-receiver.ts";
import { wakeOutput, wakeParameters } from "./wake-schema.ts";

export default function jobsExtension(pi: ExtensionAPI): void {
  let connection: Connection = { kind: "offline", reason: "not connected", last: null };
  let disconnect: (() => void) | undefined;
  let receiver: WakeReceiver | undefined;
  let receiverStatus: string | null = null;
  pi.on("session_start", async (_event, ctx) => {
    disconnect?.();
    receiver?.stop();
    receiverStatus = null;
    if (ctx.mode === "tui") ctx.ui.setWidget("dstack-jobs", undefined);
    receiver = new WakeReceiver(ctx, pi.sendMessage.bind(pi), (reason) => {
      receiverStatus = reason;
    });
    receiver.start();
    const source = await realpath(ctx.cwd);
    disconnect = subscribeJobs(
      (next) => {
        connection = next;
      },
      { source },
    );
  });
  pi.on("session_shutdown", (_event, ctx) => {
    disconnect?.();
    disconnect = undefined;
    receiver?.stop();
    receiver = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("dstack-jobs", undefined);
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const content = modelContext(
      connection,
      Date.now(),
      ctx.sessionManager.getSessionId(),
      receiverStatus,
    );
    if (content) return { message: { customType: "dstack-jobs", content, display: false } };
    return undefined;
  });
  pi.registerTool({
    name: "dstack_jobs",
    label: "PR jobs",
    description:
      "Register, list, inspect, or stop durable local PR jobs. Register needs an explicit observe/drive mode. Drive authorizes scoped repair commits and pushes, never merge/rebase/force-push. Use drive only when the user requested it. Stop quiesces owned processes and retains data. Do not poll this tool in a loop; passive snapshots arrive before normal turns.",
    parameters: Type.Object({
      op: Type.Union([
        Type.Literal("register"),
        Type.Literal("list"),
        Type.Literal("status"),
        Type.Literal("stop"),
      ]),
      id: Type.Optional(Type.String()),
      registration: Type.Optional(
        Type.Object({
          repo: Type.String(),
          pr: Type.Integer({ minimum: 1 }),
          source: Type.String(),
          mode: Type.Union([Type.Literal("observe"), Type.Literal("drive")]),
        }),
      ),
    }),
    outputSchema: Type.Object({
      version: Type.Literal(1),
      now: Type.Integer(),
      jobs: Type.Array(Type.Unknown()),
    }),
    async execute(_id, params, signal) {
      const snapshot = await callJobs(parseRequest(params), { signal });
      return jobToolResult(snapshot);
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((part) => part.type === "text");
      return new Text(theme.fg("muted", text?.type === "text" ? text.text : "No job state"), 0, 0);
    },
  });
  pi.registerTool({
    name: "dstack_wake",
    label: "Scheduled wake",
    description:
      "Create a session-targeted timer or pinned GitHub PR-check wake, list, inspect, or cancel it. Timer at and deadline are absolute Unix milliseconds. Checks complete only when a nonempty check set finishes, including failures. The daemon observes without model turns. Delivery waits for this native session to be idle. Never poll this tool in a loop. Creation requires a saved native session and scopes retries to this session, assistant entry, and tool-call ID. Lists prioritize active wakes and return at most 64 with an omitted count.",
    parameters: wakeParameters,
    outputSchema: wakeOutput,
    async execute(id, params, signal, _update, ctx) {
      const input = nativeWatchRequest(id, params, ctx.sessionManager);
      const snapshot = watchToolResult(await callWatches(input, { signal }));
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
        details: snapshot,
        structuredContent: snapshot,
      };
    },
  });
  pi.registerCommand("jobs", {
    description: "PR jobs: list | status ID | stop ID | register OWNER/REPO PR observe|drive",
    handler: async (args, ctx) => {
      const [op = "list", first, second, third, ...extra] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      let input: JobRequest;
      if (extra.length) throw new Error("Too many /jobs arguments");
      if (op === "register")
        input = parseRequest({
          op,
          registration: {
            repo: first,
            pr: Number(second),
            source: await realpath(ctx.cwd),
            mode: third,
          },
        });
      else {
        if (second || third) throw new Error("Unexpected /jobs arguments");
        input = parseRequest({ op, id: first });
      }
      const snapshot = await callJobs(input);
      if (ctx.hasUI) ctx.ui.notify(JSON.stringify(snapshot, null, 2), "info");
    },
  });
}
