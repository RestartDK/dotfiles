import type { ExtensionContext, SessionEntry, Theme } from "@earendil-works/pi-coding-agent";
import {
  Image,
  getCapabilities,
  getCellDimensions,
  matchesKey,
  parseKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { Resvg } from "@resvg/resvg-js";
import { parseSnapshot, type ArtifactSnapshot } from "./model.js";
import { loadSnapshot, snapshotPath, stateDirectory } from "./store.js";

interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  zoom: number;
  x: number;
  y: number;
}

const fitted: Viewport = { zoom: 1, x: 0, y: 0 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const fitScale = (image: Size, frame: Size) =>
  Math.min(frame.width / image.width, frame.height / image.height);

export function constrainViewport(view: Viewport, image: Size, frame: Size): Viewport {
  const zoom = clamp(view.zoom, 1, 32);
  const scale = fitScale(image, frame) * zoom;
  const maxX = Math.max(0, (image.width * scale - frame.width) / 2);
  const maxY = Math.max(0, (image.height * scale - frame.height) / 2);
  return {
    zoom,
    x: maxX ? clamp(view.x, -maxX, maxX) : 0,
    y: maxY ? clamp(view.y, -maxY, maxY) : 0,
  };
}

export function zoomAt(
  view: Viewport,
  image: Size,
  frame: Size,
  factor: number,
  pointer: { x: number; y: number },
): Viewport {
  const zoom = clamp(view.zoom * factor, 1, 32);
  const ratio = zoom / view.zoom;
  return constrainViewport(
    {
      zoom,
      x: view.x * ratio + (pointer.x - frame.width / 2) * (1 - ratio),
      y: view.y * ratio + (pointer.y - frame.height / 2) * (1 - ratio),
    },
    image,
    frame,
  );
}

export function resizeViewport(view: Viewport, image: Size, before: Size, after: Size): Viewport {
  const ratio = fitScale(image, after) / fitScale(image, before);
  return constrainViewport({ zoom: view.zoom, x: view.x * ratio, y: view.y * ratio }, image, after);
}

export function latestGallery(branch: readonly SessionEntry[]): ArtifactSnapshot | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== "show_artifacts" || message.isError)
      continue;
    try {
      return parseSnapshot(message.details);
    } catch {
      continue;
    }
  }
  return undefined;
}

type GalleryAction =
  | { kind: "previous" }
  | { kind: "next" }
  | { kind: "fit" }
  | { kind: "close" }
  | { kind: "zoom"; factor: number; pointer?: { x: number; y: number } }
  | { kind: "pan"; x: number; y: number };

type Source = { id: string } & ({ kind: "ready"; base64: string } | { kind: "missing" });

const buttons: { action: GalleryAction; label: string; symbol: string }[] = [
  { action: { kind: "close" }, label: "Close Esc", symbol: "x" },
  { action: { kind: "previous" }, label: "< Prev", symbol: "<" },
  { action: { kind: "next" }, label: "Next >", symbol: ">" },
  { action: { kind: "fit" }, label: "Fit 0", symbol: "0" },
];

interface GalleryState {
  items: { title: string; image: ArtifactSnapshot["groups"][number]["images"][number] }[];
  index: number;
  view: Viewport;
  drag?: { screenX: number; screenY: number; view: Viewport };
  source?: Source;
}

interface Frame extends Size {
  columns: number;
  rows: number;
  top: number;
  cellWidth: number;
  cellHeight: number;
}

export class ArtifactGallery implements Component {
  private state: GalleryState | undefined;
  private frame: Frame | undefined;
  private controls: { start: number; end: number; action: GalleryAction }[] = [];
  private raster: { key: string; image: Image } | undefined;

  constructor(
    snapshot: ArtifactSnapshot,
    index: number,
    private readonly directory: string,
    private readonly tui: Pick<TUI, "terminal" | "requestRender">,
    private readonly theme: Pick<Theme, "fg">,
    private readonly done: () => void,
    private readonly hasFocus: () => boolean = () => true,
  ) {
    const items = snapshot.groups.flatMap((group) =>
      group.images.map((image) => ({ title: group.title, image })),
    );
    this.state = { items, index: clamp(index, 0, items.length - 1), view: { ...fitted } };
  }

  close(): void {
    if (!this.state) return;
    this.dispose();
    this.done();
  }

  dispose(): void {
    this.state = undefined;
    this.raster = undefined;
    this.frame = undefined;
    this.controls = [];
  }

  invalidate(): void {
    this.raster?.image.invalidate();
  }

  private act(action: GalleryAction): void {
    const state = this.state;
    if (!state) return;
    if (action.kind === "close") {
      this.close();
      return;
    }
    state.drag = undefined;
    if (action.kind === "previous" || action.kind === "next") {
      state.index =
        (state.index + (action.kind === "next" ? 1 : -1) + state.items.length) % state.items.length;
      state.view = { ...fitted };
    } else if (action.kind === "fit") {
      state.view = { ...fitted };
    } else {
      const item = state.items[state.index];
      const frame = this.frame;
      if (!item || !frame) return;
      state.view =
        action.kind === "zoom"
          ? zoomAt(
              state.view,
              item.image,
              frame,
              action.factor,
              action.pointer ?? { x: frame.width / 2, y: frame.height / 2 },
            )
          : constrainViewport(
              { ...state.view, x: state.view.x + action.x, y: state.view.y + action.y },
              item.image,
              frame,
            );
    }
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.act({ kind: "close" });
    else if (matchesKey(data, "left")) this.act({ kind: "previous" });
    else if (matchesKey(data, "right")) this.act({ kind: "next" });
    else if (parseKey(data) === "+" || matchesKey(data, "shift+=") || matchesKey(data, "="))
      this.act({ kind: "zoom", factor: 1.25 });
    else if (matchesKey(data, "-")) this.act({ kind: "zoom", factor: 0.8 });
    else if (matchesKey(data, "0")) this.act({ kind: "fit" });
    else if (matchesKey(data, "a"))
      this.act({ kind: "pan", x: -(this.frame?.width ?? 0) / 10, y: 0 });
    else if (matchesKey(data, "d"))
      this.act({ kind: "pan", x: (this.frame?.width ?? 0) / 10, y: 0 });
    else if (matchesKey(data, "w"))
      this.act({ kind: "pan", x: 0, y: -(this.frame?.height ?? 0) / 10 });
    else if (matchesKey(data, "s"))
      this.act({ kind: "pan", x: 0, y: (this.frame?.height ?? 0) / 10 });
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    const state = this.state;
    const frame = this.frame;
    if (!state || !frame || !this.hasFocus()) return { handled: true, render: false };
    if (event.type === "press") state.drag = undefined;
    const inside =
      event.x >= 0 &&
      event.x < frame.columns &&
      event.y >= frame.top &&
      event.y < frame.top + frame.rows;
    if (event.type === "wheel") {
      if (inside && event.wheelDelta) {
        this.act({
          kind: "zoom",
          factor: 1.25 ** -clamp(event.wheelDelta, -4, 4),
          pointer: {
            x: (event.x + 0.5) * frame.cellWidth,
            y: (event.y - frame.top + 0.5) * frame.cellHeight,
          },
        });
      }
    } else if (event.type === "release") {
      state.drag = undefined;
    } else if (event.button === "left") {
      if (event.type === "press" && inside) {
        state.drag = { screenX: event.screenX, screenY: event.screenY, view: state.view };
        return { handled: true, capture: true, render: false };
      }
      if (event.type === "drag" && state.drag) {
        const item = state.items[state.index];
        if (item)
          state.view = constrainViewport(
            {
              zoom: state.drag.view.zoom,
              x: state.drag.view.x + (event.screenX - state.drag.screenX) * frame.cellWidth,
              y: state.drag.view.y + (event.screenY - state.drag.screenY) * frame.cellHeight,
            },
            item.image,
            frame,
          );
        return { handled: true, render: true };
      }
      if (event.type === "click" && event.y === 0) {
        const control = this.controls.find(
          (button) => event.x >= button.start && event.x < button.end,
        );
        if (control) this.act(control.action);
      }
    }
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    const state = this.state;
    if (!state || width < 1) return [];
    const height = Math.max(1, this.tui.terminal.rows);
    const item = state.items[state.index];
    this.controls = [];
    let bar = "";
    for (const button of buttons) {
      if (bar && width >= 7) bar += " ";
      const start = visibleWidth(bar);
      bar += width >= 37 ? `[${button.label}]` : width >= 15 ? `[${button.symbol}]` : button.symbol;
      this.controls.push({ start, end: Math.min(width, visibleWidth(bar)), action: button.action });
    }
    const lines = [truncateToWidth(this.theme.fg("accent", bar), width, "")];
    if (item && height >= 4)
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "muted",
            `${state.index + 1}/${state.items.length}  ${Math.round(state.view.zoom * 100)}% fit  ${item.image.width}×${item.image.height}  ${item.title}`,
          ),
          width,
        ),
      );
    if (item && height >= 5) lines.push(truncateToWidth(item.image.caption || "Image", width));
    if (height >= 7)
      lines.push(
        truncateToWidth(
          this.theme.fg(
            "dim",
            "←/→ previous/next · +/- zoom · WASD pan · 0 fit · Esc close · wheel zoom · drag pan",
          ),
          width,
        ),
      );
    const cell = getCellDimensions();
    const frame: Frame = {
      columns: Math.max(1, width - 2),
      rows: Math.max(0, height - lines.length),
      top: lines.length,
      cellWidth: cell.widthPx,
      cellHeight: cell.heightPx,
      width: Math.max(1, width - 2) * cell.widthPx,
      height: Math.max(1, height - lines.length) * cell.heightPx,
    };
    if (
      item &&
      this.frame &&
      (frame.width !== this.frame.width || frame.height !== this.frame.height)
    ) {
      state.view = resizeViewport(state.view, item.image, this.frame, frame);
      state.drag = undefined;
    }
    this.frame = frame;
    if (item && frame.rows > 0) {
      const path = snapshotPath(this.directory, item.image);
      if (!getCapabilities().images) {
        lines.push(
          ...wrapTextWithAnsi(`Image preview unavailable. ${path}`, width).slice(0, frame.rows),
        );
      } else {
        if (state.source?.id !== item.image.id) {
          try {
            state.source = {
              kind: "ready",
              id: item.image.id,
              base64: loadSnapshot(this.directory, item.image).toString("base64"),
            };
          } catch {
            state.source = { kind: "missing", id: item.image.id };
          }
        }
        if (state.source.kind === "missing") {
          const message = `Snapshot unavailable or changed. Restore the PNG or rerun show_artifacts. ${path}`;
          lines.push(
            ...wrapTextWithAnsi(this.theme.fg("warning", message), width).slice(0, frame.rows),
          );
        } else {
          try {
            const key = `${item.image.id}:${frame.columns}:${frame.rows}:${frame.width}:${frame.height}:${state.view.zoom}:${state.view.x}:${state.view.y}:${getCapabilities().images}`;
            if (this.raster?.key !== key) {
              const scale = fitScale(item.image, frame) * state.view.zoom;
              const x = (frame.width - item.image.width * scale) / 2 + state.view.x;
              const y = (frame.height - item.image.height * scale) / 2 + state.view.y;
              const resolution = Math.min(1, Math.sqrt(2_000_000 / (frame.width * frame.height)));
              const pixels = {
                widthPx: Math.max(1, Math.round(frame.width * resolution)),
                heightPx: Math.max(1, Math.round(frame.height * resolution)),
              };
              const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.widthPx}" height="${pixels.heightPx}" viewBox="0 0 ${frame.width} ${frame.height}"><image href="data:image/png;base64,${state.source.base64}" x="${x}" y="${y}" width="${item.image.width * scale}" height="${item.image.height * scale}"/></svg>`;
              const png = Buffer.from(
                new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng(),
              );
              this.raster = {
                key,
                image: new Image(
                  png.toString("base64"),
                  "image/png",
                  { fallbackColor: (text) => this.theme.fg("muted", text) },
                  {
                    maxWidthCells: frame.columns,
                    maxHeightCells: frame.rows,
                    imageId: this.raster?.image.getImageId(),
                  },
                  pixels,
                ),
              };
            }
            lines.push(...this.raster.image.render(width).slice(0, frame.rows));
          } catch {
            state.source = { kind: "missing", id: item.image.id };
            const message = "Image rendering failed. Navigation and close remain available.";
            lines.push(truncateToWidth(this.theme.fg("warning", message), width));
          }
        }
      }
    }
    while (lines.length < height) lines.push("");
    return lines;
  }
}

type GalleryContext = Pick<ExtensionContext, "mode" | "ui" | "sessionManager">;

export class ArtifactGallerySession {
  private session: { context: GalleryContext; interaction?: AbortController } | undefined;
  private generation = 0;

  get isOpen(): boolean {
    return this.session?.interaction !== undefined;
  }

  attach(context: GalleryContext): void {
    if (this.session) this.detach();
    this.session = { context };
  }

  close(): void {
    this.session?.interaction?.abort();
  }

  detach(): void {
    const session = this.session;
    if (session) this.generation++;
    this.session = undefined;
    session?.interaction?.abort();
  }

  opener(snapshot: ArtifactSnapshot): (index: number) => void {
    const generation = this.generation;
    return (index) => {
      const session = this.session;
      if (
        !session ||
        generation !== this.generation ||
        session.interaction ||
        session.context.mode !== "tui"
      )
        return;
      const interaction = new AbortController();
      session.interaction = interaction;
      let gallery: ArtifactGallery | undefined;
      let hasFocus = () => false;
      const close = () => gallery?.close();
      void (async () => {
        try {
          await session.context.ui.custom<void>(
            (tui, theme, _keys, done) => {
              gallery = new ArtifactGallery(
                snapshot,
                index,
                stateDirectory(),
                tui,
                theme,
                done,
                () => hasFocus(),
              );
              return gallery;
            },
            {
              overlay: true,
              overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
              onHandle: (handle) => {
                hasFocus = () => handle.isFocused();
                if (interaction.signal.aborted) close();
                else interaction.signal.addEventListener("abort", close, { once: true });
              },
            },
          );
        } catch {
          if (session === this.session)
            session.context.ui.notify("Could not open the artifact gallery.", "error");
        } finally {
          interaction.signal.removeEventListener("abort", close);
          gallery?.dispose();
          if (session.interaction === interaction) session.interaction = undefined;
        }
      })();
    };
  }

  openLatest(): void {
    const context = this.session?.context;
    if (!context) return;
    if (context.mode !== "tui") {
      context.ui.notify(
        "The artifact viewer requires interactive Pi. Use the saved PNG paths in tool output.",
        "info",
      );
      return;
    }
    const snapshot = latestGallery(context.sessionManager.getBranch());
    if (!snapshot) context.ui.notify("No saved artifact galleries on this branch.", "info");
    else this.opener(snapshot)(0);
  }
}
