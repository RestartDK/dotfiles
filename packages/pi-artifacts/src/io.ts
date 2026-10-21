import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { dimensions, limits } from "./model.js";

export function readBounded(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Expected a bounded regular file");
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > stat.size || length > maxBytes)
      throw new Error("File grew while reading; retry with a stable file");
    return buffer.subarray(0, length);
  } finally {
    closeSync(fd);
  }
}

export function pngSize(png: Buffer): { width: number; height: number } {
  if (
    png.length < 33 ||
    png.length > limits.fileBytes ||
    png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
    png.readUInt32BE(8) !== 13 ||
    png.toString("ascii", 12, 16) !== "IHDR"
  ) {
    throw new Error("Expected a PNG with an IHDR header");
  }
  return dimensions(png.readUInt32BE(16), png.readUInt32BE(20));
}

export function validatePng(png: Buffer): { width: number; height: number; png: Buffer } {
  const size = pngSize(png);
  const data: Buffer[] = [];
  let ended = false;
  let chunks = 0;
  let palette = false;
  for (let offset = 8; offset < png.length; ) {
    if (++chunks > limits.pngChunks) throw new Error("PNG chunk limit exceeded");
    if (offset + 12 > png.length) throw new Error("Truncated PNG chunk");
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length || ended || (type === "IHDR" && offset !== 8))
      throw new Error("Invalid PNG chunk sequence");
    if (type === "PLTE") {
      if (palette || length === 0 || length > 768 || length % 3 !== 0)
        throw new Error("PNG palette limit exceeded");
      palette = true;
    }
    if (type === "IDAT") data.push(png.subarray(offset + 8, end - 4));
    if (type === "IEND") ended = true;
    offset = end;
  }
  if (!ended || data.length === 0) throw new Error("Incomplete PNG");
  inflateSync(Buffer.concat(data), {
    maxOutputLength: size.width * size.height * 8 + size.height * 7,
  });
  const decoded = PNG.sync.read(png, { checkCRC: true });
  const normalized = PNG.sync.write(decoded);
  if (normalized.length > limits.fileBytes) throw new Error("Normalized PNG exceeds 16 MiB");
  return { ...size, png: normalized };
}
