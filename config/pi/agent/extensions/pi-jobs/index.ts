import { realpath } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, TruncatedText } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  callJobs,
  parseRequest,
  subscribeJobs,
  type Connection,
  type JobRequest,
} from "../../lib/dstack-jobs.ts";
import { modelContext, widgetLines } from "./view.ts";

export default function jobsExtension(pi: ExtensionAPI): void {
  let connection: Connection = { kind: "offline", reason: "not connected", last: null };
  let disconnect: (() => void) | undefined;
  const render = (ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget("dstack-jobs", (_tui, theme) => {
      const container = new Container();
      for (const [index, line] of widgetLines(connection).entries())
        container.addChild(
          new TruncatedText(theme.fg(index === 0 ? "accent" : "muted", line), 0, 0),
        );
      return container;
    });
  };
  pi.on("session_start", async (_event, ctx) => {
    disconnect?.();
    const source = await realpath(ctx.cwd);
    disconnect = subscribeJobs(
      (next) => {
        connection = next;
        render(ctx);
      },
      { source },
    );
    render(ctx);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    disconnect?.();
    disconnect = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("dstack-jobs", undefined);
  });
  pi.on("before_agent_start", () => {
    const content = modelContext(connection);
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
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
        details: snapshot,
        structuredContent: snapshot,
      };
    },
    renderResult(result, _options, theme) {
      const text = result.content.find((part) => part.type === "text");
      return new Text(theme.fg("muted", text?.type === "text" ? text.text : "No job state"), 0, 0);
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
