import { extname } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { readBounded, validatePng } from "./io.js";
import { limits, parseDocument, safeText } from "./model.js";
import { renderDocument } from "./renderer.js";

try {
  const path = process.argv[2];
  if (!path) throw new Error("Expected a local PNG or Satori JSON path");
  const extension = extname(path).toLowerCase();
  let source: Buffer;
  if (extension === ".json") {
    const value: unknown = JSON.parse(readBounded(path, limits.jsonBytes).toString("utf8"));
    source = await renderDocument(parseDocument(value));
  } else if (extension === ".png") {
    source = readBounded(path, limits.fileBytes);
  } else {
    throw new Error("Only local .json Satori documents and .png files are supported");
  }
  const original = validatePng(source);
  const scale = Math.min(
    limits.thumbnailWidth / original.width,
    limits.thumbnailHeight / original.height,
    1,
  );
  const width = Math.max(1, Math.round(original.width * scale));
  const height = Math.max(1, Math.round(original.height * scale));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><image href="data:image/png;base64,${original.png.toString("base64")}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/></svg>`;
  const thumbnail = validatePng(
    Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng()),
  );
  if (thumbnail.png.length > limits.thumbnailBytes) throw new Error("Thumbnail exceeds 2 MiB");
  const header = Buffer.alloc(8);
  header.writeUInt32BE(original.png.length, 0);
  header.writeUInt32BE(thumbnail.png.length, 4);
  process.stdout.write(Buffer.concat([header, original.png, thumbnail.png]));
} catch (error) {
  process.stderr.write(
    safeText(error instanceof Error ? error.message.slice(0, 1000) : "Rendering failed", 1000),
  );
  process.exitCode = 1;
}
