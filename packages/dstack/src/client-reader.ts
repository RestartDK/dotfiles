import { CLIENT_VERSION, MAX_CLIENT_EVENT_BYTES } from "./client-limits.js";

export class ClientReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export type ClientMessage =
  | { readonly kind: "reply"; readonly value: unknown }
  | { readonly kind: "event"; readonly value: Record<string, unknown> }
  | { readonly kind: "error"; readonly code: string; readonly message: string }
  | { readonly kind: "end"; readonly reason: string };

function invalid(): never { throw new ClientReadError("invalid_response", "Invalid or uncorrelated client response"); }

export function clientRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  return Object.fromEntries(Object.entries(value));
}

function message(text: string, id: string): ClientMessage {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return invalid(); }
  const frame = clientRecord(parsed);
  if (frame.v !== CLIENT_VERSION || (frame.id !== id && frame.id !== null)) return invalid();
  const kinds = ["result", "event", "error", "end"].filter(key => Object.hasOwn(frame, key));
  if (kinds.length !== 1 || Object.keys(frame).some(key => !["v", "id", ...kinds].includes(key))) return invalid();
  if (kinds[0] === "error") {
    const error = clientRecord(frame.error);
    if (Object.keys(error).some(key => key !== "code" && key !== "message") || typeof error.code !== "string" || error.code.length === 0 || error.code.length > 128 || typeof error.message !== "string" || error.message.length > 4096) return invalid();
    return { kind: "error", code: error.code, message: error.message };
  }
  if (frame.id !== id) return invalid();
  if (kinds[0] === "result") return { kind: "reply", value: frame.result };
  if (kinds[0] === "event") {
    const event = clientRecord(frame.event);
    if (typeof event.type !== "string" || event.type.length === 0 || event.type.length > 128) return invalid();
    return { kind: "event", value: event };
  }
  if (typeof frame.end !== "string" || !["stopped", "cancelled", "session_closed", "retired"].includes(frame.end)) return invalid();
  return { kind: "end", reason: frame.end };
}

async function* lines(response: Response): AsyncGenerator<{ readonly text: string; readonly bytes: number }> {
  if (response.body === null) return invalid();
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(8192), bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      let start = 0;
      while (start < result.value.length) {
        const newline = result.value.indexOf(10, start), end = newline === -1 ? result.value.length : newline;
        const part = result.value.subarray(start, end), needed = bytes + part.length;
        if (needed + 1 > MAX_CLIENT_EVENT_BYTES) throw new ClientReadError("response_too_large", "Client response exceeds frame byte limit");
        if (buffer.length < needed) {
          const grown = new Uint8Array(Math.min(MAX_CLIENT_EVENT_BYTES, Math.max(needed, buffer.length * 2)));
          grown.set(buffer.subarray(0, bytes)); buffer = grown;
        }
        buffer.set(part, bytes); bytes = needed;
        if (newline === -1) break;
        let text: string;
        try { text = decoder.decode(buffer.subarray(0, bytes)); } catch { return invalid(); }
        const size = bytes + 1; bytes = 0;
        yield { text, bytes: size };
        start = newline + 1;
      }
    }
    if (bytes !== 0) throw new ClientReadError("response_truncated", "Client response ended inside a frame");
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function* clientMessages(response: Response, id: string): AsyncGenerator<ClientMessage> {
  const type = response.headers.get("content-type")?.split(";")[0];
  if (type !== "application/json" && type !== "text/event-stream") return invalid();
  let data: { readonly text: string; readonly bytes: number } | undefined;
  let terminal = false;
  for await (const line of lines(response)) {
    if (terminal) return invalid();
    if (type === "application/json") {
      const value = message(line.text, id);
      if (value.kind !== "reply" && value.kind !== "error") return invalid();
      terminal = true; yield value;
    } else if (line.text === "") {
      if (data === undefined) return invalid();
      if (data.bytes + line.bytes > MAX_CLIENT_EVENT_BYTES) throw new ClientReadError("response_too_large", "Client event exceeds frame byte limit");
      const value = message(data.text, id); data = undefined;
      if (value.kind === "reply") return invalid();
      terminal = value.kind === "error" || value.kind === "end"; yield value;
    } else {
      if (data !== undefined || !line.text.startsWith("data: ")) return invalid();
      data = { text: line.text.slice(6), bytes: line.bytes };
    }
  }
  if (data !== undefined || !terminal) throw new ClientReadError("viewer_disconnected", "Viewer disconnected; attach a fresh snapshot. Work was not cancelled");
}
