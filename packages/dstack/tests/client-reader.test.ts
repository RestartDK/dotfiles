import { test, expect } from "bun:test";
import { ClientReadError, clientMessages, type ClientMessage } from "../src/client-reader.js";
import { MAX_CLIENT_EVENT_BYTES } from "../src/client-limits.js";

const encoder = new TextEncoder();
function response(text: string, type = "application/json", fragment = false) {
  const bytes = encoder.encode(text);
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    if (fragment) for (let i = 0; i < bytes.length; i += 1) controller.enqueue(bytes.subarray(i, i + 1));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": type } });
}
async function read(input: Response): Promise<ClientMessage[]> {
  const messages: ClientMessage[] = [];
  for await (const message of clientMessages(input, "request")) messages.push(message);
  return messages;
}
function event(value: unknown) { return `data: ${JSON.stringify({ v: 1, id: "request", event: value })}\n\n`; }
const end = `data: ${JSON.stringify({ v: 1, id: "request", end: "stopped" })}\n\n`;

test("client reader keeps UTF8 across arbitrary network boundaries and exact correlation", async () => {
  expect(await read(response(`${JSON.stringify({ v: 1, id: "request", result: { text: "é😀\n漢字" } })}\n`, "application/json", true))).toEqual([{ kind: "reply", value: { text: "é😀\n漢字" } }]);
  expect(await read(response(event({ type: "snapshot", entries: [] }) + event({ type: "message_update", changes: [{ type: "text_delta", delta: "é😀" }] }) + end, "text/event-stream", true))).toHaveLength(3);
  await expect(read(response('{"v":1,"id":"other","result":{}}\n'))).rejects.toThrow(ClientReadError);
});

test("consumer bounds each event, not the size of a coalesced network chunk", async () => {
  const payload = "x".repeat(MAX_CLIENT_EVENT_BYTES - 512);
  const frames = await read(response(event({ type: "snapshot", payload }) + event({ type: "snapshot", payload }) + end, "text/event-stream"));
  expect(frames).toHaveLength(3);
  expect(frames[2]).toEqual({ kind: "end", reason: "stopped" });
  await expect(read(response("x".repeat(MAX_CLIENT_EVENT_BYTES)))).rejects.toThrow("frame byte limit");
});

test("truncation, unknown response authority and invalid UTF8 never become success", async () => {
  for (const text of ['{"v":1,"id":"request","result":{},"actor":"root"}\n', '{"v":1,"id":"request","result":{},"event":{}}\n', '{"v":1,"id":"request","result":{}}'])
    await expect(read(response(text))).rejects.toThrow(ClientReadError);
  await expect(read(response(event({ type: "snapshot" }), "text/event-stream"))).rejects.toThrow("Viewer disconnected");
  await expect(read(response(event({ type: "snapshot" }).slice(0, -1), "text/event-stream"))).rejects.toThrow(ClientReadError);
  await expect(read(new Response(new Uint8Array([0xff, 10]), { headers: { "content-type": "application/json" } }))).rejects.toThrow(ClientReadError);
});

test("typed pre-envelope failures may lack correlation, but successful replies may not", async () => {
  expect(await read(response('{"v":1,"id":null,"error":{"code":"invalid_host","message":"Refused"}}\n'))).toEqual([{ kind: "error", code: "invalid_host", message: "Refused" }]);
  await expect(read(response('{"v":1,"id":null,"result":{}}\n'))).rejects.toThrow(ClientReadError);
  await expect(read(response('{"v":1,"id":"request","error":{"code":"bad","message":"Refused","secret":"never display"}}\n'))).rejects.toThrow(ClientReadError);
});
