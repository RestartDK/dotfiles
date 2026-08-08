import assert from "node:assert/strict";
import test from "node:test";
import {
  ClipboardPasteProtocol,
  type ClipboardPasteProtocolCallbacks,
  type ProtocolInputResult,
} from "./protocol.ts";

const OSC_PREFIX = "\x1b]5522;";
const STRING_TERMINATOR = "\x1b\\";
const MIME_LIST = Buffer.from(".").toString("base64");

type Harness = {
  protocol: ClipboardPasteProtocol;
  writes: string[];
  notices: Array<{ message: string; level: string }>;
  savedImages: Array<{ data: Buffer; mimeType: string }>;
  support: boolean[];
};

function encode(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function packet(metadata: string, payload?: string | Uint8Array): string {
  return `${OSC_PREFIX}${metadata}${payload === undefined ? "" : `;${encode(payload)}`}${STRING_TERMINATOR}`;
}

function responseId(request: string): string {
  const match = /(?:^|:)id=([A-Za-z0-9_.+-]+)/.exec(request);
  assert.ok(match);
  const id = match[1];
  assert.ok(id);
  return id;
}

function lastWrite(harness: Harness): string {
  const value = harness.writes.at(-1);
  assert.ok(value);
  return value;
}

function createHarness(
  overrides: Partial<ClipboardPasteProtocolCallbacks> = {},
  maxClipboardBytes?: number,
): Harness {
  const writes: string[] = [];
  const notices: Array<{ message: string; level: string }> = [];
  const savedImages: Array<{ data: Buffer; mimeType: string }> = [];
  const support: boolean[] = [];
  const protocol = new ClipboardPasteProtocol(
    {
      write: (data) => writes.push(data),
      saveImage: (data, mimeType) => {
        savedImages.push({ data: Buffer.from(data), mimeType });
        return "/tmp/pasted-image.png";
      },
      notify: (message, level) => notices.push({ message, level }),
      onSupport: (supported) => support.push(supported),
      ...overrides,
    },
    { requestTimeoutMs: 0, maxClipboardBytes },
  );
  return { protocol, writes, notices, savedImages, support };
}

function completeContentRequest(
  harness: Harness,
  request: string,
  mimeType: string,
  chunks: Array<string | Uint8Array>,
): ProtocolInputResult {
  const id = responseId(request);
  harness.protocol.handleInput(packet(`type=read:status=OK:id=${id}`));
  for (const chunk of chunks) {
    harness.protocol.handleInput(
      packet(`type=read:status=DATA:id=${id}:mime=${encode(mimeType)}`, chunk),
    );
  }
  return harness.protocol.handleInput(packet(`type=read:status=DONE:id=${id}`));
}

test("enables, detects, and disables paste-event mode", () => {
  const harness = createHarness();
  harness.protocol.start();
  assert.deepEqual(harness.writes, ["\x1b[?5522$p\x1b[?5522h"]);
  assert.deepEqual(harness.protocol.handleInput("\x1b[?5522;2$y"), {
    consume: true,
  });
  assert.deepEqual(harness.support, [true]);
  harness.protocol.stop();
  assert.equal(harness.writes.at(-1), "\x1b[?5522l");
});

test("reads and inserts a Kitty paste-event image", () => {
  const harness = createHarness();
  const password = encode("one-time-password");
  assert.deepEqual(harness.protocol.handleInput(packet(`type=read:status=OK:pw=${password}`)), {
    consume: true,
  });
  harness.protocol.handleInput(
    packet(`type=read:status=DATA:mime=${MIME_LIST}`, "text/plain image/png\n"),
  );
  harness.protocol.handleInput(packet("type=read:status=DONE"));
  const request = lastWrite(harness);
  assert.match(request, new RegExp(`mime=${encode("image/png")}`));
  assert.match(request, new RegExp(`pw=${password}`));
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const result = completeContentRequest(harness, request, "image/png", [
    png.subarray(0, 8),
    png.subarray(8),
  ]);
  assert.deepEqual(result, { data: "\x1b[200~/tmp/pasted-image.png\x1b[201~" });
  assert.deepEqual(harness.savedImages, [{ data: png, mimeType: "image/png" }]);
  assert.deepEqual(harness.notices, []);
});

test("accepts an image marker from the macOS Ghostty bridge", () => {
  const harness = createHarness();
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
  const marker = `\x1b[200~PI_GHOSTTY_IMAGE_V1:image/png:${png.toString("base64")}\x1b[201~`;
  const result = harness.protocol.handleInput(marker);
  assert.deepEqual(result, {
    data: "\x1b[200~/tmp/pasted-image.png\x1b[201~",
  });
  assert.deepEqual(harness.savedImages, [{ data: png, mimeType: "image/png" }]);
});

test("rejects a malformed image marker from the macOS Ghostty bridge", () => {
  const harness = createHarness();
  const result = harness.protocol.handleInput(
    "\x1b[200~PI_GHOSTTY_IMAGE_V1:image/png:not-base64!\x1b[201~",
  );
  assert.deepEqual(result, { consume: true });
  assert.deepEqual(harness.savedImages, []);
  assert.deepEqual(harness.notices, [
    { message: "Ghostty sent invalid base64 image data", level: "error" },
  ]);
});

test("supports per-MIME paste listings and text fallback", () => {
  const harness = createHarness();
  harness.protocol.handleInput(packet(`type=read:status=OK:loc=primary:pw=${encode("token")}`));
  harness.protocol.handleInput(packet(`type=read:status=DATA:mime=${encode("text/plain")}`));
  harness.protocol.handleInput(packet("type=read:status=DONE"));
  const request = lastWrite(harness);
  assert.match(request, /loc=primary/);
  const result = completeContentRequest(harness, request, "text/plain", ["hello ", "over ssh"]);
  assert.deepEqual(result, { data: "\x1b[200~hello over ssh\x1b[201~" });
  assert.deepEqual(harness.savedImages, []);
});

test("the Ctrl+V request only accepts images", () => {
  const harness = createHarness();
  harness.protocol.requestImage();
  const listRequest = lastWrite(harness);
  assert.match(listRequest, new RegExp(`;${MIME_LIST}${STRING_TERMINATOR.replace("\\", "\\\\")}$`));
  const id = responseId(listRequest);
  harness.protocol.handleInput(packet(`type=read:status=OK:id=${id}`));
  harness.protocol.handleInput(
    packet(`type=read:status=DATA:id=${id}:mime=${MIME_LIST}`, "text/plain\n"),
  );
  const result = harness.protocol.handleInput(packet(`type=read:status=DONE:id=${id}`));
  assert.deepEqual(result, { consume: true });
  assert.equal(harness.writes.length, 1);
  assert.deepEqual(harness.notices, [
    {
      message: "The clipboard does not contain a supported image",
      level: "warning",
    },
  ]);
});

test("rejects image data that does not match its MIME type", () => {
  const harness = createHarness();
  harness.protocol.handleInput(packet("type=read:status=OK"));
  harness.protocol.handleInput(packet(`type=read:status=DATA:mime=${encode("image/png")}`));
  harness.protocol.handleInput(packet("type=read:status=DONE"));
  const result = completeContentRequest(harness, lastWrite(harness), "image/png", ["not a png"]);
  assert.deepEqual(result, { consume: true });
  assert.deepEqual(harness.savedImages, []);
  assert.deepEqual(harness.notices, [
    {
      message: "Clipboard image data does not match its MIME type",
      level: "error",
    },
  ]);
});

test("rejects clipboard content above the configured limit", () => {
  const harness = createHarness({}, 8);
  harness.protocol.handleInput(packet("type=read:status=OK"));
  harness.protocol.handleInput(packet(`type=read:status=DATA:mime=${encode("text/plain")}`));
  harness.protocol.handleInput(packet("type=read:status=DONE"));
  const request = lastWrite(harness);
  const id = responseId(request);
  harness.protocol.handleInput(packet(`type=read:status=OK:id=${id}`));
  harness.protocol.handleInput(
    packet(`type=read:status=DATA:id=${id}:mime=${encode("text/plain")}`, "123456789"),
  );
  assert.deepEqual(harness.notices, [
    { message: "Clipboard content exceeds 8 bytes", level: "error" },
  ]);
});
