import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs, { chmodSync, lstatSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { Compile } from "typebox/compile";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { PNG } from "pngjs";
import {
  getCapabilities,
  setCapabilities,
  setCellDimensions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { readBounded, validatePng } from "./io.js";
import { limits, parseDocument, parseInput, parseSnapshot } from "./model.js";
import { createSnapshot, loadSnapshot, loadThumbnail, snapshotPath } from "./store.js";
import { ArtifactView } from "./view.js";

const isImageLine = (line: string) => line.includes("\x1b_G");

const root = mkdtempSync(join(tmpdir(), "pi-artifacts-test-"));
const state = join(root, "state");
mkdirSync(state);
after(() => rmSync(root, { recursive: true, force: true }));
const document = {
  width: 240,
  height: 120,
  tree: {
    type: "div",
    props: {
      style: {
        display: "flex",
        width: "100%",
        height: "100%",
        backgroundColor: "#123456",
        color: "white",
        fontSize: 24,
      },
      children: "Hello",
    },
  },
};

function solidPng(): Buffer {
  const png = new PNG({ width: 40, height: 80 });
  png.data.fill(255);
  return PNG.sync.write(png);
}

test("rejects executable/resource-bearing trees and excessive work before rendering", () => {
  for (const tree of [
    { type: "img", props: { src: "https://example.com" } },
    { type: "div", props: { dangerouslySetInnerHTML: { __html: "<script/>" } } },
    { type: "div", props: { style: { backgroundColor: "url(https://example.com)" } } },
    { type: "div", props: { style: { backgroundImage: "url(file:///etc/passwd)" } } },
    { type: "div", props: { style: { color: "u\\72l(foo)" } } },
    { type: "div", props: { onClick: "process.exit()" } },
    { type: "svg", props: { children: [] } },
    { type: "div", props: { style: { width: Infinity } } },
    { type: "div", props: { style: { width: "1e100px" } } },
    { type: "div", props: { children: "x".repeat(limits.text + 1) } },
    { type: "div", props: { children: Array.from({ length: limits.nodes }, () => document.tree) } },
  ])
    assert.throws(() => parseDocument({ ...document, tree }));
  let tree: unknown = document.tree;
  for (let i = 0; i < limits.depth; i++) tree = { type: "div", props: { children: [tree] } };
  assert.throws(() => parseDocument({ ...document, tree }));
  assert.throws(() => parseDocument({ ...document, width: 4096, height: 4096 }));
  assert.throws(() => parseDocument({ ...document, width: 0 }));
  assert.equal(parseDocument(document).tree.props.children, "Hello");
});

test("input and replay boundaries reject remote paths, corrupt IDs and terminal controls", () => {
  for (const path of ["https://example.com/a.png", "file:///a.png", "x\x1b.png"]) {
    assert.throws(() => parseInput({ groups: [{ images: [{ path }] }] }));
  }
  const input = parseInput({
    groups: [{ title: "A\x1b[2J\nB", images: [{ path: "x.png", caption: "C\x9dD" }] }],
  });
  assert.doesNotMatch(JSON.stringify(input), /\\u001b|\\u009d/);
  for (const value of [
    { version: 2 },
    {
      version: 1,
      maxWidthCells: 100,
      groups: [
        {
          title: "x",
          images: [
            {
              id: "../secret",
              width: 1,
              height: 1,
              caption: "x",
              thumbnail: { id: "a".repeat(64), width: 1, height: 1 },
            },
          ],
        },
      ],
    },
  ]) {
    assert.throws(() => parseSnapshot(value));
  }
});

test("bounds files and PNG allocation before decoding, and rejects corrupt PNGs", () => {
  const path = join(root, "oversize.json");
  writeFileSync(path, " ".repeat(limits.jsonBytes + 1));
  assert.throws(() => readBounded(path, limits.jsonBytes));
  assert.throws(() => readBounded(root, limits.fileBytes));
  const png = solidPng();
  const huge = Buffer.from(png);
  huge.writeUInt32BE(0xffffffff, 16);
  assert.throws(() => validatePng(huge));
  const bomb = Buffer.from(png);
  bomb.writeUInt32BE(1, 16);
  bomb.writeUInt32BE(1, 20);
  bomb[28] = 1;
  bomb.writeUInt32BE(crc32(bomb.subarray(12, 29)), 29);
  assert.throws(() => validatePng(bomb), { code: "ERR_BUFFER_TOO_LARGE" });
  const palette = Buffer.alloc(12 + 771);
  palette.writeUInt32BE(771, 0);
  palette.write("PLTE", 4);
  assert.throws(
    () => validatePng(Buffer.concat([png.subarray(0, 33), palette, png.subarray(33)])),
    /PNG palette limit/,
  );
  const smallPalette = Buffer.alloc(15);
  smallPalette.writeUInt32BE(3, 0);
  smallPalette.write("PLTE", 4);
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([png.subarray(0, 33), smallPalette, smallPalette, png.subarray(33)]),
      ),
    /PNG palette limit/,
  );
  const chunk = Buffer.from("000000007465537400000000", "hex");
  assert.throws(
    () =>
      validatePng(
        Buffer.concat([
          png.subarray(0, 33),
          ...Array.from({ length: limits.pngChunks }, () => chunk),
          png.subarray(33),
        ]),
      ),
    /PNG chunk limit/,
  );
  const corrupt = Buffer.from(png);
  corrupt[29] = (corrupt[29] ?? 0) ^ 255;
  assert.throws(() => validatePng(corrupt));
  assert.deepEqual(PNG.sync.read(validatePng(png).png).data, PNG.sync.read(png).data);
  assert.throws(
    () => validatePng(Buffer.concat([png.subarray(0, 33), png.subarray(8)])),
    /chunk sequence/,
  );
});

test("real worker renders JSON with packaged fonts and copies PNG into immutable replay state", async () => {
  writeFileSync(join(root, "tiny.json"), JSON.stringify(document));
  writeFileSync(join(root, "input.png"), solidPng());
  const snapshot = await createSnapshot(
    parseInput({
      groups: [{ title: "Flow", images: [{ path: "tiny.json" }, { path: "input.png" }] }],
    }),
    root,
    state,
  );
  const [rendered, copied] = snapshot.groups[0]?.images ?? [];
  assert.ok(rendered && copied);
  assert.deepEqual({ width: rendered.width, height: rendered.height }, { width: 240, height: 120 });
  const pixels = PNG.sync.read(loadSnapshot(state, rendered));
  assert.deepEqual([...pixels.data.subarray(-4)], [0x12, 0x34, 0x56, 255]);
  const before = readFileSync(snapshotPath(state, copied));
  writeFileSync(join(root, "input.png"), "changed");
  writeFileSync(join(root, "tiny.json"), "changed");
  assert.deepEqual(loadSnapshot(state, copied), before);
  assert.deepEqual(parseSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
  const replay = parseSnapshot(snapshot);
  assert.ok(loadSnapshot(state, replay.groups[0]?.images[0] ?? rendered).length > 0);
});

test("one native component reflows ordered groups and survives missing snapshots with published cached thumbnails", async () => {
  writeFileSync(join(root, "layout.png"), solidPng());
  const snapshot = await createSnapshot(
    parseInput({
      groups: ["First", "Second", "Third"].map((title) => ({
        title,
        images: ["one", "two", "three"].map((caption) => ({ path: "layout.png", caption })),
      })),
    }),
    root,
    state,
  );
  const caps = getCapabilities();
  try {
    setCapabilities({ ...caps, images: "kitty" });
    setCellDimensions({ widthPx: 9, heightPx: 18 });
    const view = new ArtifactView(snapshot, state, { fg: (_color, text) => text });
    for (const [width, expectedRows] of [
      [132, 3],
      [72, 6],
      [38, 9],
      [132, 3],
    ]) {
      assert.ok(width && expectedRows);
      const lines = view.render(width);
      assert.equal(lines.filter(isImageLine).length, expectedRows);
      assert.deepEqual(
        lines.filter((line) => ["First", "Second", "Third"].includes(line)),
        ["First", "Second", "Third"],
      );
      for (const line of lines.filter((line) => !isImageLine(line)))
        assert.ok(visibleWidth(line) <= width);
      const captions = lines.filter((line) => /[123]\. (one|two|three)/.test(line)).join(" ");
      assert.equal((captions.match(/1\. one.*?2\. two.*?3\. three/g) ?? []).length, 3);
    }
    view.showImages = false;
    assert.equal(view.render(72).filter(isImageLine).length, 0);
    view.showImages = true;
    view.theme = { fg: (_color, text) => `\x1b[31m${text}\x1b[0m` };
    assert.match(view.render(132)[0] ?? "", /^\x1b\[31m/);
    const image = snapshot.groups[0]?.images[0];
    assert.ok(image);
    rmSync(snapshotPath(state, image.thumbnail));
    view.invalidate();
    assert.equal(view.render(72).filter(isImageLine).length, 6);
    const missing = new ArtifactView(snapshot, state, { fg: (_color, text) => text })
      .render(72)
      .filter((line) => !isImageLine(line))
      .join("\n");
    assert.match(missing, /rerun\s+show_artifacts/);
    setCapabilities({ ...caps, images: null });
    const fallback = view.render(72).join("\n");
    assert.doesNotMatch(fallback, /\x1b_G/);
    assert.match(fallback, /Image preview unavailable/);
  } finally {
    setCapabilities(caps);
  }
});

test("model-only exposure preserves native result persistence instead of nested codemode calls", async () => {
  const loaded = await discoverAndLoadExtensions(
    [fileURLToPath(new URL("./index.js", import.meta.url))],
    root,
    root,
  );
  assert.deepEqual(loaded.errors, []);
  const tool = loaded.extensions
    .find((value) => value.tools.has("show_artifacts"))
    ?.tools.get("show_artifacts");
  assert.ok(tool);
  assert.equal(tool.definition.exposure, "model-only");
  assert.ok(tool.definition.renderResult);
  const schema = Compile(tool.definition.parameters);
  for (const input of [
    { maxWidthCells: limits.maxWidthCells + 1, groups: [{ images: [{ path: "a.png" }] }] },
    { groups: [{ images: [{ path: "a.png", caption: "x".repeat(limits.label + 1) }] }] },
    { groups: [{ images: [{ path: "x".repeat(limits.path + 1) }] }] },
  ]) {
    assert.equal(schema.Check(input), false);
    assert.throws(() => parseInput(input));
  }
  const image = { id: "a".repeat(64), width: 1, height: 1, caption: "" };
  assert.throws(
    () =>
      parseSnapshot({
        version: 1,
        maxWidthCells: limits.defaultWidthCells,
        groups: [{ title: "", images: [image] }],
      }),
    /Saved thumbnail missing/,
  );
  assert.throws(() =>
    parseSnapshot({
      version: 1,
      maxWidthCells: limits.defaultWidthCells,
      groups: [
        {
          title: "",
          images: [
            {
              ...image,
              thumbnail: { id: "a".repeat(64), width: limits.thumbnailWidth + 1, height: 1 },
            },
          ],
        },
      ],
    }),
  );
});

test("repairs corrupted owned originals and thumbnails, preserves valid targets, and converges across writers", async () => {
  const directory = join(root, "repair-state");
  mkdirSync(directory);
  const path = join(root, "repair.png");
  writeFileSync(path, solidPng());
  const input = parseInput({ groups: [{ images: [{ path }] }] });
  const snapshot = await createSnapshot(input, root, directory);
  const image = snapshot.groups[0]?.images[0];
  assert.ok(image);
  const original = loadSnapshot(directory, image);
  const thumbnail = loadThumbnail(directory, image);
  const target = snapshotPath(directory, image);
  const thumbnailTarget = snapshotPath(directory, image.thumbnail);
  const inode = lstatSync(target).ino;
  await createSnapshot(input, root, directory);
  assert.equal(lstatSync(target).ino, inode);
  chmodSync(target, 0o600);
  writeFileSync(target, "corrupt original");
  chmodSync(thumbnailTarget, 0o600);
  writeFileSync(thumbnailTarget, "corrupt thumbnail");
  const command = `import {createSnapshot} from ${JSON.stringify(new URL("./store.js", import.meta.url).href)}; await createSnapshot(${JSON.stringify(input)},${JSON.stringify(root)},${JSON.stringify(directory)});`;
  await Promise.all(
    Array.from({ length: 3 }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", command]),
    ),
  );
  assert.deepEqual(loadSnapshot(directory, image), original);
  assert.deepEqual(loadThumbnail(directory, image), thumbnail);
  assert.deepEqual(
    readdirSync(directory).filter((name) => !name.endsWith(".png")),
    [],
  );
});

test("partial write failure removes only its owned temporary and preserves the original error", async () => {
  const directory = join(root, "write-failure-state");
  mkdirSync(directory);
  const path = join(root, "write-failure.png");
  writeFileSync(path, solidPng());
  const originalWrite = fs.writeFileSync;
  const write = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
    if (typeof args[0] === "number") {
      originalWrite(args[0], "partial");
      throw Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    }
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      createSnapshot(parseInput({ groups: [{ images: [{ path }] }] }), root, directory),
      { code: "ENOSPC" },
    );
    assert.deepEqual(readdirSync(directory), []);
  } finally {
    write.mock.restore();
    syncBuiltinESMExports();
  }
});

test("replay paints bounded thumbnails without opening full-resolution originals", async () => {
  const directory = join(root, "thumbnail-state");
  mkdirSync(directory);
  const source = new PNG({ width: 2048, height: 1024 });
  source.data.fill(255);
  const path = join(root, "large.png");
  const bytes = PNG.sync.write(source);
  writeFileSync(path, bytes);
  const snapshot = await createSnapshot(
    parseInput({ groups: [{ images: [{ path }] }] }),
    root,
    directory,
  );
  const image = snapshot.groups[0]?.images[0];
  assert.ok(image);
  assert.equal(image.width, 2048);
  assert.equal(image.height, 1024);
  assert.ok(
    image.thumbnail.width <= limits.thumbnailWidth &&
      image.thumbnail.height <= limits.thumbnailHeight,
  );
  assert.ok(loadThumbnail(directory, image).length <= limits.thumbnailBytes);
  assert.deepEqual(readFileSync(path), bytes);
  const target = snapshotPath(directory, image);
  rmSync(target);
  const caps = getCapabilities();
  setCapabilities({ ...caps, images: "kitty" });
  const originalOpen = fs.openSync;
  const open = mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    assert.notEqual(String(args[0]), target, "render must not open an original");
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    const view = new ArtifactView(parseSnapshot(snapshot), directory, {
      fg: (_color, text) => text,
    });
    assert.equal(view.render(132).filter(isImageLine).length, 1);
    assert.equal(view.render(38).filter(isImageLine).length, 1);
  } finally {
    open.mock.restore();
    syncBuiltinESMExports();
    setCapabilities(caps);
  }
});

test("PNG preparation yields to cancellation and reports renderer failures distinctly", async () => {
  const path = join(root, "cancel.png");
  writeFileSync(path, solidPng());
  const controller = new AbortController();
  const pending = createSnapshot(
    parseInput({ groups: [{ images: [{ path }] }] }),
    root,
    state,
    controller.signal,
  );
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /Artifact worker cancelled/);
  const invalid = join(root, "invalid.json");
  writeFileSync(invalid, "{}");
  await assert.rejects(
    createSnapshot(parseInput({ groups: [{ images: [{ path: invalid }] }] }), root, state),
    /Artifact rendering failed/,
  );
});
