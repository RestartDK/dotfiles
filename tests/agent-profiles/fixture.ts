import { appendFileSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { isRecord } from "../../config/pi/agent/lib/model-policy";

const [backend, scriptPath, ...args] = process.argv.slice(2);
if (!scriptPath) throw new Error("fixture needs scenario file");
const scenario: unknown = JSON.parse(readFileSync(scriptPath, "utf8"));
if (!isRecord(scenario)) throw new Error("invalid fixture scenario");
const arg = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const promptPath = arg("--append-system-prompt-file") ?? arg("--append-system-prompt");
const prompt = promptPath ? readFileSync(promptPath, "utf8") : undefined;
appendFileSync(
  `${scriptPath}.calls`,
  JSON.stringify({ backend, args, env: process.env, prompt }) + "\n",
);
const write = (text: string) =>
  new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
const emit = async (event: unknown) => {
  const text = JSON.stringify(event) + "\n";
  if (scenario.split) {
    await write(text.slice(0, 7));
    await Bun.sleep(2);
    await write(text.slice(7));
  } else await write(text);
};
if (args.includes("auth") && backend === "pi") {
  if (scenario.piAuth === "malformed") await write("not json");
  else
    await emit({
      status:
        scenario.piAuth === "missing" ||
        (scenario.piAuth === "missing-anthropic" && arg("--provider") === "anthropic")
          ? "not_ready"
          : "ready",
      provider: scenario.piAuth === "wrong-provider" ? "wrong" : arg("--provider"),
    });
  process.exit(0);
}
if (args.includes("auth")) {
  if (scenario.auth === "malformed") await write("not json");
  else
    await write(
      JSON.stringify({
        loggedIn: scenario.auth !== "logged-out",
        authMethod: scenario.auth === "api" ? "api_key" : "claude.ai",
        apiProvider: "firstParty",
      }),
    );
  process.exit(0);
}
const input = await Bun.stdin.text();
if (!input.includes("Delegated task")) throw new Error("missing stdin task");
const model = arg("--model") ?? "missing";
const selectedMode = backend === "claude" ? scenario.claude : scenario.pi;
const mode = typeof selectedMode === "string" ? selectedMode : "success";
if (backend === "claude") {
  await emit({
    type: "system",
    subtype: "init",
    model: mode === "wrong-model" ? "wrong" : model,
    tools: mode === "extra-tool" ? ["Bash"] : (arg("--tools") ?? "").split(",").filter(Boolean),
    permissionMode: "dontAsk",
    apiKeySource: mode === "api-source" ? "apiKeyHelper" : "none",
    mcp_servers: [],
  });
}
if (backend === "claude" && mode.startsWith("synthetic")) {
  if (mode === "synthetic-after-tool") await emit({ type: "tool_progress" });
  if (mode === "synthetic-unknown-event") await emit({ type: "future_tool_execution" });
  const events: unknown[] = readFileSync(new URL("./claude-quota.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  for (const event of events.slice(1)) {
    if (!isRecord(event)) throw new Error("Malformed regression fixture");
    if (mode === "synthetic-cancelled" && event.type === "result")
      event.terminal_reason = "aborted_streaming";
    if (mode === "synthetic-mismatch" && event.type === "result") event.api_error_status = 401;
    if (mode === "synthetic-tool" && event.type === "assistant" && isRecord(event.message))
      event.message.content = [{ type: "tool_use", name: "Read" }];
    await emit(event);
  }
  process.exit(1);
}
if (mode === "unknown-event") await emit({ type: "future_tool_execution" });
if (mode === "overflow") {
  process.stdout.write("x".repeat(1024 * 1024 + 1));
  process.exit(1);
}
if (mode === "malformed") {
  process.stdout.write("not json\n");
  process.exit(1);
}
if (mode === "truncated") {
  process.stdout.write('{"type":"result"');
  process.exit(1);
}
if (mode === "hook") {
  await emit({ type: "system", subtype: "hook_started" });
  process.exit(1);
}
if (mode === "hang") {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    { stdio: "ignore" },
  );
  process.on("SIGTERM", () => {});
  await emit({
    type: "assistant",
    message: { model, content: [{ type: "text", text: `descendant=${child.pid}` }] },
  });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
if (backend === "claude") {
  if (mode === "allowed" || mode === "allowed_warning" || mode === "quota")
    await emit({
      type: "rate_limit_event",
      rate_limit_info: { status: mode === "quota" ? "rejected" : mode, resetsAt: scenario.resetAt },
    });
  if (mode === "tool-failure")
    await emit({
      type: "assistant",
      message: {
        model,
        content: [{ type: "tool_use", name: "Read", id: "1", input: { file_path: "README.md" } }],
      },
    });
  const failure = [
    "quota",
    "tool-failure",
    "unknown",
    "task-failure",
    "budget",
    "unavailable",
    "unknown-event",
    "aborted-streaming",
    "aborted-tools",
  ].includes(mode);
  const error =
    mode === "unknown"
      ? "unknown"
      : mode === "unavailable"
        ? "model_not_found"
        : failure
          ? "rate_limit"
          : undefined;
  await emit({
    type: "assistant",
    error,
    message: {
      model,
      content: [
        {
          type: "text",
          text: mode === "large-output" ? "å".repeat(100000) : failure ? "partial" : "claude-ok",
        },
      ],
    },
  });
  await emit({
    type: "result",
    subtype:
      mode === "budget"
        ? "error_max_budget_usd"
        : mode === "task-failure"
          ? "error_max_turns"
          : failure
            ? "error_during_execution"
            : "success",
    is_error: failure,
    terminal_reason:
      mode === "aborted-streaming"
        ? "aborted_streaming"
        : mode === "aborted-tools"
          ? "aborted_tools"
          : mode === "budget"
            ? "budget_exhausted"
            : mode === "task-failure"
              ? "max_turns"
              : mode === "unavailable"
                ? "model_error"
                : failure
                  ? "api_error"
                  : "completed",
    api_error_status: mode === "quota" || mode === "tool-failure" ? 429 : null,
    result: mode === "large-output" ? "å".repeat(100000) : failure ? "partial" : "claude-ok",
    num_turns: 1,
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  process.exit(failure ? 1 : 0);
}
const provider = mode === "wrong-provider" ? "wrong" : arg("--provider");
await emit({ type: "message_start", message: { role: "assistant", provider, model, content: [] } });
if (typeof scenario.piWritePath === "string") appendFileSync(scenario.piWritePath, "write\n");
if (Array.isArray(scenario.piEvents)) for (const event of scenario.piEvents) await emit(event);
if (typeof scenario.piError === "string" && provider === scenario.piErrorProvider) {
  if (scenario.piBeforeError === "tool")
    await emit({ type: "tool_execution_start", toolName: "read" });
  if (scenario.piBeforeError === "unknown-event") await emit({ type: "future_tool_execution" });
  await emit({
    type: "message_end",
    message: {
      role: "assistant",
      provider,
      model,
      content:
        scenario.piBeforeError === "tool-call"
          ? [{ type: "toolCall", name: "read", id: "1", arguments: {} }]
          : [{ type: "text", text: "native-error" }],
      stopReason: scenario.piBeforeError === "aborted" ? "aborted" : "error",
      errorMessage: scenario.piError,
    },
  });
  process.exit(0);
}
if (mode === "tool-failure") await emit({ type: "tool_execution_start", toolName: "read" });
const failure = ["quota", "tool-failure", "unknown", "unknown-event"].includes(mode);
if (mode === "stderr-quota") process.stderr.write("429 Too Many Requests");
await emit({
  type: "message_end",
  message: {
    role: "assistant",
    provider,
    model,
    content: [{ type: "text", text: mode === "stdout-quota" ? "429 Too Many Requests" : "pi-ok" }],
    stopReason: failure ? "error" : "stop",
    errorMessage: failure
      ? mode === "unknown"
        ? "tests failed: 429 Too Many Requests"
        : "429 Too Many Requests"
      : undefined,
    usage: { input: 5, output: 8 },
  },
});
process.exit(failure || mode === "stderr-quota" ? 1 : 0);
