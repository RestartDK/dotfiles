import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ClientError, clientToken, loadClientCredential, newClientCredential } from "#client-authority";
import { parseClientOperation } from "#client-protocol";
import { CLIENT_RESOURCES, CLIENT_VERSION, MAX_CLIENT_CONTENT_BYTES, MAX_CLIENT_REQUEST_BYTES } from "./client-limits.js";
import { ClientReadError, clientMessages } from "./client-reader.js";

const help = `dstack-client key --deployment ID --domain work|personal --node ID --principal ID --out FILE

dstack-client COMMAND --endpoint http://127.0.0.1:PORT --credential FILE [OPTIONS]
  discover
  open             --workspace ID
  submit           --workspace ID --request KEY       (UTF8 content from stdin)
  status           --workspace ID --request KEY
  snapshot         --workspace ID [--cursor TOKEN]
  watch            --workspace ID
  abort            --workspace ID                     (ordinary SDK work only)
  execution.status --workspace ID
  command.cancel   --workspace ID --intent ID          (existing business intent only)

Credentials stay in private local files and request headers, never argv or URLs.
A lost ACK does not cancel work. Query status with the same request key before retrying.
Watch reconnect is explicit and attaches a fresh snapshot; it never submits or resumes.
Use an SSH forward with the same local and remote loopback port for a remote host.`;

class UsageError extends Error { constructor() { super("Invalid client arguments; run dstack-client --help"); } }

function flags(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (flag === undefined || !/^--[a-z-]+$/.test(flag) || value === undefined || values.has(flag.slice(2))) throw new UsageError();
    values.set(flag.slice(2), value);
  }
  return values;
}
function allow(values: ReadonlyMap<string, string>, names: readonly string[]): void {
  if ([...values.keys()].some(key => !names.includes(key))) throw new UsageError();
}
function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name); if (value === undefined || value.length === 0) throw new UsageError(); return value;
}
function endpoint(value: string): URL {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") throw new UsageError();
    return new URL("/v1", url);
  } catch { throw new UsageError(); }
}
async function content(): Promise<string> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const part of process.stdin) {
    if (!Buffer.isBuffer(part)) throw new UsageError();
    bytes += part.length; if (bytes > MAX_CLIENT_CONTENT_BYTES) throw new ClientReadError("content_too_large", "Client content exceeds byte limit"); chunks.push(part);
  }
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, bytes)); }
  catch { throw new ClientReadError("invalid_content", "Client content must be well-formed UTF8"); }
}
function output(value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.stdout.destroy(); reject(new ClientReadError("output_timeout", "Client output did not drain; viewer detached")); }, CLIENT_RESOURCES.backpressureMs);
    process.stdout.write(`${JSON.stringify(value)}\n`, error => { clearTimeout(timer); if (error) reject(new ClientReadError("output_failed", "Client output ended")); else resolve(); });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === undefined || command === "--help" || command === "help") { if (args.length !== 0) throw new UsageError(); process.stdout.write(`${help}\n`); return; }
  const options = flags(args);
  if (command === "key") {
    allow(options, ["deployment", "domain", "node", "principal", "out"]);
    if (process.getuid?.() === undefined || process.getuid?.() === 0) throw new ClientReadError("invalid_credential", "Client credentials require a nonroot local user");
    const domain = required(options, "domain"); if (domain !== "work" && domain !== "personal") throw new UsageError();
    const credential = newClientCredential({ identity: { deploymentId: required(options, "deployment"), domain, nodeId: required(options, "node") }, principalId: required(options, "principal") });
    const file = resolve(required(options, "out"));
    try { await writeFile(file, `${JSON.stringify(credential)}\n`, { flag: "wx", mode: 0o600, flush: true }); }
    catch { throw new ClientReadError("credential_not_created", "Credential file was not created; existing files are never replaced"); }
    await output({ created: true, credentialFile: file, identity: credential.identity, principalId: credential.principalId }); return;
  }
  const common = ["endpoint", "credential", "workspace"];
  let operation: unknown;
  switch (command) {
    case "discover": allow(options, ["endpoint", "credential"]); operation = { op: command }; break;
    case "open": case "watch": case "abort": case "execution.status":
      allow(options, common); operation = { op: command, workspaceId: required(options, "workspace") }; break;
    case "status": case "submit":
      allow(options, [...common, "request"]);
      operation = { op: command, workspaceId: required(options, "workspace"), requestId: required(options, "request"), ...(command === "submit" ? { content: await content() } : {}) }; break;
    case "snapshot":
      allow(options, [...common, "cursor"]); operation = { op: command, workspaceId: required(options, "workspace"), ...(options.has("cursor") ? { cursor: options.get("cursor") } : {}) }; break;
    case "command.cancel": allow(options, [...common, "intent"]); operation = { op: command, workspaceId: required(options, "workspace"), intentId: required(options, "intent") }; break;
    default: throw new UsageError();
  }
  const parsed = parseClientOperation(operation), url = endpoint(required(options, "endpoint"));
  const credential = await loadClientCredential(resolve(required(options, "credential"))), id = randomUUID();
  const body = JSON.stringify({ v: CLIENT_VERSION, id, operation: parsed });
  if (Buffer.byteLength(body) > MAX_CLIENT_REQUEST_BYTES) throw new ClientReadError("request_too_large", "Encoded client request exceeds byte limit");
  const controller = new AbortController(), detach = () => controller.abort();
  process.once("SIGINT", detach); process.once("SIGTERM", detach);
  const timer = setTimeout(detach, command === "watch" ? CLIENT_RESOURCES.operationMs + CLIENT_RESOURCES.viewerMs : CLIENT_RESOURCES.operationMs);
  try {
    let response: Response;
    try { response = await fetch(url, { method: "POST", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${clientToken(credential)}` }, body, signal: controller.signal }); }
    catch { throw new ClientReadError("acknowledgment_unknown", "Client detached or request failed; admission may be unknown. Query status before manually retrying. No cancellation was sent"); }
    for await (const message of clientMessages(response, id)) {
      switch (message.kind) {
        case "reply": await output(message.value); break;
        case "event": await output(message.value); break;
        case "error": throw new ClientReadError(message.code, message.message);
        case "end": await output({ viewerEnded: message.reason, workCancelled: false }); break;
      }
    }
  } finally { clearTimeout(timer); detach(); process.removeListener("SIGINT", detach); process.removeListener("SIGTERM", detach); }
}

process.umask(0o077);
process.stdout.on("error", () => undefined);
try { await main(); }
catch (error) {
  const safe = error instanceof UsageError || error instanceof ClientError || error instanceof ClientReadError ? error.message : "Client connection or operation failed; acknowledgment may be unknown. No cancellation was sent";
  process.stderr.write(`${safe}\n`); process.exitCode = 1;
}
