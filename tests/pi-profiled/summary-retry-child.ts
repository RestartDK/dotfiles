import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, mode, ...args] = process.argv.slice(2);
if (!directory) throw new Error("Missing summary replay directory");
if (args.includes("auth")) {
  appendFileSync(join(directory, "auth.jsonl"), JSON.stringify(args) + "\n");
  console.log(JSON.stringify({ status: "ready", provider: args[args.indexOf("--provider") + 1] }));
} else {
  await Bun.stdin.text();
  appendFileSync(join(directory, "workers.jsonl"), JSON.stringify(args) + "\n");
  if (args.includes("--tools")) appendFileSync(join(directory, "writes.txt"), "write\n");
  const frames = args.includes("gpt-6-astra") ? "fallback.jsonl" : "events.jsonl";
  process.stdout.write(readFileSync(join(directory, frames), "utf8"));
  if (mode === "hold") setInterval(() => {}, 1000);
}
