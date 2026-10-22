import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { PNG } from "pngjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, setCapabilities, setCellDimensions, visibleWidth } from "@earendil-works/pi-tui";
import { ArtifactGallery, ArtifactGallerySession, constrainViewport, latestGallery, resizeViewport, zoomAt } from "../dist/gallery.js";
import { ArtifactView, layoutGeometry } from "../dist/view.js";
import register from "../dist/index.js";

const theme = { fg: (_color, text) => text, bold: (text) => text };
const directory = mkdtempSync(join(tmpdir(), "pi-artifacts-test-"));
const capabilities = getCapabilities();
const cells = getCellDimensions();
const previousStateHome = process.env.XDG_STATE_HOME;
const missing = { id: "f".repeat(64), width: 2, height: 2 };
const png = new PNG({ width: 200, height: 100 });
for (let index = 0; index < png.data.length; index += 4) {
  png.data[index] = (index / 4) % png.width;
  png.data[index + 1] = Math.floor(index / 4 / png.width) * 2;
  png.data[index + 3] = 255;
}
const bytes = PNG.sync.write(png);
const reference = { id: createHash("sha256").update(bytes).digest("hex"), width: png.width, height: png.height };
writeFileSync(join(directory, `${reference.id}.png`), bytes);
const snapshot = {
  version: 1, maxWidthCells: 122,
  groups: [
    { title: "Comparison", images: ["first", "第二 🦊", "third", "fourth"].map((caption) => ({ ...reference, caption, thumbnail: reference })) },
    { title: "Other", images: [{ ...reference, caption: "last", thumbnail: reference }] },
  ],
};
const event = (type, x = 0, y = 0, extra = {}) => ({
  type, x, y, screenX: x, screenY: y, width: 100, height: 25,
  button: "left", shift: false, alt: false, ctrl: false, ...extra,
});
const result = (details, overrides = {}) => ({
  role: "toolResult", toolCallId: "artifacts", toolName: "show_artifacts", content: [],
  isError: false, timestamp: 0, details, ...overrides,
});
const imagePoint = (view, image, frame, pointer) => {
  const scale = Math.min(frame.width / image.width, frame.height / image.height) * view.zoom;
  return {
    x: (pointer.x - frame.width / 2 - view.x) / scale + image.width / 2,
    y: (pointer.y - frame.height / 2 - view.y) / scale + image.height / 2,
  };
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

before(() => {
  setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
  setCellDimensions({ widthPx: 8, heightPx: 16 });
  process.env.XDG_STATE_HOME = directory;
});
after(() => {
  setCapabilities(capabilities);
  setCellDimensions(cells);
  if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = previousStateHome;
  rmSync(directory, { recursive: true, force: true });
});

test("pointer zoom preserves the source pixel unless an image edge constrains panning", () => {
  const image = { width: 1200, height: 800 };
  const frame = { width: 600, height: 400 };
  const view = { zoom: 2, x: 40, y: -20 };
  const pointer = { x: 410, y: 120 };
  const before = imagePoint(view, image, frame, pointer);
  const next = zoomAt(view, image, frame, 1.25, pointer);
  const after = imagePoint(next, image, frame, pointer);
  near(after.x, before.x);
  near(after.y, before.y);
  assert.equal(zoomAt(view, image, frame, 1000, pointer).zoom, 32);
  assert.deepEqual(zoomAt(next, image, frame, 0.0001, pointer), { zoom: 1, x: 0, y: 0 });
});

test("pan bounds and resizing preserve the visible center for portrait and panorama images", () => {
  for (const image of [{ width: 4000, height: 200 }, { width: 200, height: 4000 }]) {
    const frame = { width: 600, height: 400 };
    const view = constrainViewport({ zoom: 4, x: 1e8, y: -1e8 }, image, frame);
    const scale = Math.min(frame.width / image.width, frame.height / image.height) * view.zoom;
    assert.equal(view.x, Math.max(0, (image.width * scale - frame.width) / 2));
    near(view.y, -Math.max(0, (image.height * scale - frame.height) / 2));
    const nextFrame = { width: 300, height: 200 };
    const resized = resizeViewport(view, image, frame, nextFrame);
    near(resized.x, view.x / 2);
    near(resized.y, view.y / 2);
    assert.equal(resized.zoom, 4);
  }
});

test("latest gallery follows the actual active branch, ignores errors and malformed details", () => {
  const session = SessionManager.inMemory(directory);
  assert.equal(latestGallery(session.getBranch()), undefined);
  const root = session.appendMessage(result(snapshot));
  const abandoned = { ...snapshot, groups: [{ title: "Abandoned", images: snapshot.groups[0].images }] };
  session.appendMessage(result(abandoned));
  assert.equal(latestGallery(session.getBranch()).groups[0].title, "Abandoned");
  session.branch(root);
  session.appendMessage(result(abandoned, { isError: true }));
  session.appendMessage(result({ version: 999 }));
  session.appendMessage(result(abandoned, { toolName: "other_tool" }));
  session.appendCustomEntry("show_artifacts", abandoned);
  assert.deepEqual(latestGallery(session.getBranch()), snapshot);
});

test("caption and image hitboxes follow rendered group titles, rows, gaps and tiny widths", () => {
  const view = new ArtifactView(snapshot, directory, theme);
  const opened = [];
  view.onOpen = (index) => opened.push(index);
  const lines = view.render(100);
  const { tileWidth } = layoutGeometry(100, 122);
  const caption = lines.findIndex((line) => line.includes("1. first"));
  assert.ok(caption > 0);
  view.handleMouse(event("press", tileWidth + 2, caption));
  view.handleMouse(event("release", tileWidth + 2, caption));
  assert.deepEqual(opened, []);
  view.handleMouse(event("click", tileWidth + 2, caption));
  view.handleMouse(event("click", 2 * (tileWidth + 2), caption + 1));
  view.handleMouse(event("click", tileWidth, caption + 1));
  view.handleMouse(event("click", 0, caption - 1));
  const fourth = lines.findIndex((line) => line.includes("4. fourth"));
  view.handleMouse(event("click", 0, fourth));
  const last = lines.findIndex((line) => line.includes("1. last"));
  view.handleMouse(event("click", 0, last + 1));
  assert.deepEqual(opened, [1, 2, 3, 4]);
  for (const width of [1, 2, 24, 58, 90, 122]) {
    view.render(width);
    view.handleMouse(event("click", 0, 1, { width }));
    assert.equal(opened.at(-1), 0);
  }
  const count = opened.length;
  view.showImages = false;
  view.render(100);
  view.handleMouse(event("click", 0, caption));
  assert.equal(opened.length, count);
  const broken = new ArtifactView({ ...snapshot, groups: snapshot.groups.map((group) => ({
    ...group, images: group.images.map((image) => ({ ...image, thumbnail: missing })),
  })) }, directory, theme);
  broken.onOpen = (index) => opened.push(index);
  const brokenLines = broken.render(60);
  broken.handleMouse(event("click", 0, brokenLines.findIndex((line) => line.includes("1. last"))));
  assert.equal(opened.at(-1), 4);
});

test("covered thumbnails preserve row heights without leaving image lines or hit targets", () => {
  const view = new ArtifactView(snapshot, directory, theme);
  const original = view.render(100);
  view.isCovered = () => true;
  view.onOpen = () => assert.fail("covered thumbnail opened");
  const covered = view.render(100);
  assert.equal(covered.length, original.length);
  assert.ok(original.some((line) => line.includes("\x1b_G")));
  assert.ok(covered.every((line) => !line.includes("\x1b_G")));
  assert.equal(view.handleMouse(event("click", 0, 1)), undefined);
});

test("viewer uses originals without thumbnails, caches idle frames, and keeps controls alive on source failure", () => {
  const images = [{ ...reference, caption: "Full resolution", thumbnail: missing }, { ...missing, caption: "Missing source", thumbnail: reference }];
  const saved = { ...snapshot, groups: [{ title: "Sources", images }] };
  const tui = { terminal: { rows: 25 }, requestRender() {} };
  let closed = 0;
  const gallery = new ArtifactGallery(saved, 0, directory, tui, theme, () => closed++);
  const first = gallery.render(100);
  assert.ok(first.some((line) => line.includes("\x1b_G")));
  assert.deepEqual(gallery.render(100), first);
  gallery.handleInput("+");
  assert.match(gallery.render(100)[1], /125%/);
  gallery.handleInput("\x1b[43u");
  assert.match(gallery.render(100)[1], /156%/);
  assert.equal(gallery.handleMouse(event("wheel", 99, 0, { wheelDelta: -1 })).handled, true);
  gallery.handleMouse(event("wheel", 30, 12, { wheelDelta: -1 }));
  assert.equal(gallery.handleMouse(event("press", 30, 12)).capture, true);
  const beforeDrag = gallery.render(100);
  gallery.handleMouse(event("drag", 33, 12));
  assert.notDeepEqual(gallery.render(100), beforeDrag);
  gallery.handleMouse(event("release", 33, 12));
  const afterRelease = gallery.render(100);
  gallery.handleMouse(event("drag", 36, 12));
  assert.deepEqual(gallery.render(100), afterRelease);
  gallery.handleInput("0");
  assert.match(gallery.render(100)[1], /100%/);
  const nextX = first[0].indexOf("Next");
  gallery.handleMouse(event("press", nextX, 0));
  gallery.handleMouse(event("release", nextX, 0));
  gallery.handleMouse(event("click", nextX, 0));
  const failed = gallery.render(100);
  assert.match(failed[1], /2\/2/);
  assert.ok(failed.some((line) => line.includes("Snapshot unavailable or changed")));
  gallery.handleInput("\x1b[D");
  assert.match(gallery.render(100)[1], /1\/2/);
  for (const [width, height] of [[1, 1], [7, 3], [24, 8], [122, 40]]) {
    tui.terminal.rows = height;
    const rendered = gallery.render(width);
    assert.equal(rendered.length, height);
    assert.ok(rendered.every((line) => line.includes("\x1b_G") || visibleWidth(line) <= width));
  }
  gallery.handleMouse(event("press", 0, 0));
  gallery.handleMouse(event("release", 0, 0));
  gallery.handleMouse(event("click", 0, 0));
  gallery.handleMouse(event("click", 0, 0));
  gallery.handleInput("\x1b");
  assert.equal(closed, 1);
  assert.deepEqual(gallery.render(100), []);
});

test("background mouse actions cannot close a covered gallery and fresh presses discard stale drags", () => {
  let focused = true;
  let closed = 0;
  const gallery = new ArtifactGallery(snapshot, 0, directory,
    { terminal: { rows: 25 }, requestRender() {} }, theme, () => closed++, () => focused);
  gallery.render(100);
  gallery.handleInput("+");
  gallery.render(100);
  gallery.handleMouse(event("press", 30, 12));
  gallery.handleMouse(event("drag", 33, 12));
  const panned = gallery.render(100);
  focused = false;
  gallery.handleMouse(event("click", 0, 0));
  gallery.handleMouse(event("wheel", 30, 12, { wheelDelta: -1 }));
  assert.equal(closed, 0);
  assert.deepEqual(gallery.render(100), panned);
  focused = true;
  gallery.handleMouse(event("press", 10, 0));
  gallery.handleMouse(event("drag", 40, 12));
  assert.deepEqual(gallery.render(100), panned);
  gallery.handleMouse(event("release", 40, 12));
  gallery.handleMouse(event("click", 0, 0));
  assert.equal(closed, 1);
});

function uiContext(branch = [], mode = "tui") {
  const opened = [];
  const notices = [];
  const mounted = [];
  const context = {
    mode, sessionManager: { getBranch: () => branch },
    ui: {
      notify: (...notice) => notices.push(notice),
      custom: (factory, options) => new Promise((resolve) => {
        const component = factory({ terminal: { rows: 25 }, requestRender() {} }, theme, {}, resolve);
        opened.push(component);
        mounted.push(() => options.onHandle({ isFocused: () => true }));
      }),
    },
  };
  return { context, opened, notices, mounted };
}
const settled = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test("session lifecycle accepts pre-start renderers, prevents duplicate viewers and rejects stale callbacks", async () => {
  const owner = new ArtifactGallerySession();
  const beforeStart = owner.opener(snapshot);
  const ui = uiContext();
  owner.attach(ui.context);
  assert.equal(ui.opened.length, 0);
  beforeStart(1);
  beforeStart(2);
  assert.equal(ui.opened.length, 1);
  assert.match(ui.opened[0].render(100)[1], /2\/5/);
  owner.detach();
  ui.mounted[0]();
  await settled();
  assert.deepEqual(ui.opened[0].render(100), []);
  const next = uiContext();
  owner.attach(next.context);
  beforeStart(0);
  assert.equal(next.opened.length, 0);
  const open = owner.opener(snapshot);
  open(0);
  next.mounted[0]();
  owner.close();
  await settled();
  assert.equal(owner.isOpen, false);
  open(0);
  next.mounted[1]();
  assert.equal(next.opened.length, 2);
  owner.detach();
  await settled();
});

test("/artifacts notifies on an empty branch and never opens a terminal component outside TUI mode", async () => {
  const owner = new ArtifactGallerySession();
  const empty = uiContext();
  owner.attach(empty.context);
  owner.openLatest();
  assert.equal(empty.opened.length, 0);
  assert.match(empty.notices[0][0], /No saved artifact galleries/);
  const nonTui = uiContext([{ type: "message", message: result(snapshot) }], "rpc");
  owner.attach(nonTui.context);
  owner.openLatest();
  owner.opener(snapshot)(0);
  assert.equal(nonTui.opened.length, 0);
  assert.match(nonTui.notices[0][0], /requires interactive Pi/);
  owner.detach();
  await settled();
});

test("tool failure and partial renderers remain usable and never auto-open galleries", () => {
  const tools = [];
  const commands = new Map();
  const events = new Map();
  register({ on: (name, handler) => events.set(name, handler), registerTool: (tool) => tools.push(tool), registerCommand: (name, command) => commands.set(name, command) });
  const ui = uiContext();
  events.get("session_start")({}, ui.context);
  const tool = tools[0];
  assert.equal(tool.exposure, "model-only");
  assert.ok(commands.has("artifacts"));
  const failed = tool.renderResult({ content: [{ type: "text", text: "Rendering failed" }] }, { isPartial: false }, theme, { isError: true });
  assert.match(failed.render(80).join("\n"), /Rendering failed/);
  const partial = tool.renderResult({}, { isPartial: true }, theme, {});
  assert.match(partial.render(80).join("\n"), /Preparing snapshots/);
  const final = tool.renderResult({ details: snapshot }, { isPartial: false }, theme, { showImages: true });
  assert.ok(final instanceof ArtifactView);
  final.render(80);
  assert.equal(ui.opened.length, 0);
  events.get("session_shutdown")();
});
