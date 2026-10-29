import { expect, test } from "bun:test";
import { MAX_CLIENT_EVENT_BYTES } from "#client-protocol";
import { ClientDataError, clientFrame } from "../src/client-wire.js";

test("client frames preserve JSON Unicode and escaping without executing object hooks", () => {
  for (const text of ["plain", "\0\b\t\n\f\r", "\"\\", "😀", "\ud800", "\udc00", "\ud800😀\udc00", "\u2028\u2029"]) {
    const value = { text, optional: undefined, array: [null, false, 12, undefined] };
    expect(clientFrame(value)).toBe(`${JSON.stringify(value)}\n`);
  }
  let accessed = 0;
  const getter = Object.defineProperty({}, "secret", { enumerable: true, get() { accessed += 1; return "must not execute"; } });
  expect(() => clientFrame(getter)).toThrow(ClientDataError);
  expect(accessed).toBe(0);
});

test("client frame cap includes UTF8 bytes, JSON escapes and newline before allocating an oversized string", () => {
  const accepted = clientFrame("a".repeat(MAX_CLIENT_EVENT_BYTES - 3));
  expect(Buffer.byteLength(accepted)).toBe(MAX_CLIENT_EVENT_BYTES);
  expect(() => clientFrame("a".repeat(MAX_CLIENT_EVENT_BYTES - 2))).toThrow(ClientDataError);
  expect(() => clientFrame("\0".repeat(Math.floor((MAX_CLIENT_EVENT_BYTES - 3) / 6) + 1))).toThrow(ClientDataError);
  expect(() => clientFrame("😀".repeat(Math.floor((MAX_CLIENT_EVENT_BYTES - 3) / 4) + 1))).toThrow(ClientDataError);
});

test("client serialization bounds traversal and refuses cycles and non-JSON state", () => {
  const cycle: { next?: unknown } = {}; cycle.next = cycle;
  for (const value of [cycle, NaN, Infinity, 1n, undefined, Symbol("invalid"), new Date(), new Map(), { toJSON() { throw new Error("must not execute"); } }])
    expect(() => clientFrame(value)).toThrow(ClientDataError);
  let nested: unknown = null;
  for (let i = 0; i < 70; i += 1) nested = { nested };
  expect(() => clientFrame(nested)).toThrow(ClientDataError);
  expect(() => clientFrame(Array.from({ length: 140000 }, () => 0))).toThrow(ClientDataError);
  expect(() => clientFrame(Object.fromEntries(Array.from({ length: 140000 }, (_, i) => [String(i), undefined])))).toThrow(ClientDataError);
});
