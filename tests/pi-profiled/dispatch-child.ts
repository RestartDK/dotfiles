import { appendFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.PI_DISPATCH_TEST_DIR;
if (!directory) throw new Error("Missing dispatch test directory");
const args = process.argv.slice(2);
if (args.includes("auth")) {
  appendFileSync(join(directory, "auth.jsonl"), JSON.stringify(args) + "\n");
  console.log(JSON.stringify({ status: "ready", provider: args[args.indexOf("--provider") + 1] }));
} else if (args.includes("--dstack-worker")) {
  const invocation: unknown = JSON.parse(args[args.indexOf("--dstack-worker") + 1]);
  const task = await Bun.stdin.text();
  appendFileSync(join(directory, "workers.jsonl"), JSON.stringify({ invocation, task }) + "\n");
  const message = {
    role: "assistant",
    provider: args[args.indexOf("--provider") + 1],
    model: args[args.indexOf("--model") + 1],
    content: [{ type: "text", text: "DISPATCH_FIXTURE_ONLY" }],
    stopReason: "stop",
  };
  console.log(JSON.stringify({ type: "message_start", message }));
  if (task.includes("HOLD_UNTIL_STOP")) {
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ type: "message_end", message }));
    console.log(JSON.stringify({ type: "agent_end", messages: [message] }));
  }
} else {
  throw new Error("Unexpected dispatch fixture invocation");
}
