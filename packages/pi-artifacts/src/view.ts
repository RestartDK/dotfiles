import { existsSync } from "node:fs";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Resvg } from "@resvg/resvg-js";
import {
  Image,
  getCapabilities,
  getCellDimensions,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { loadThumbnail, snapshotPath } from "./store.js";
import type { ArtifactSnapshot, SnapshotImage } from "./model.js";

interface Row {
  title: string;
  captions: string;
  image: Image;
  missing: string[];
}

type Thumbnail = { kind: "ready"; base64: string } | { kind: "missing"; path: string };

export function layoutGeometry(width: number, cap: number) {
  const available = Math.max(1, Math.min(width - 2, cap));
  const columns = Math.max(1, Math.min(3, Math.floor((available + 2) / 30)));
  const tileWidth = Math.max(
    1,
    Math.min(36, Math.floor((available - (columns - 1) * 2) / columns)),
  );
  return { columns, tileWidth };
}

function raster(svg: string): Buffer {
  return Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
}

export class ArtifactView implements Component {
  showImages = true;
  expanded = false;
  private readonly thumbnails = new Map<string, Thumbnail>();
  private layout: { key: string; rows: Row[] } | undefined;

  constructor(
    readonly snapshot: ArtifactSnapshot,
    private readonly directory: string,
    public theme: Pick<Theme, "fg">,
  ) {}

  invalidate(): void {
    for (const row of this.layout?.rows ?? []) row.image.invalidate();
  }

  private thumbnail(image: SnapshotImage): Thumbnail {
    const cached = this.thumbnails.get(image.thumbnail.id);
    if (cached) return cached;
    let thumbnail: Thumbnail;
    try {
      const png = loadThumbnail(this.directory, image);
      thumbnail = { kind: "ready", base64: png.toString("base64") };
    } catch {
      thumbnail = { kind: "missing", path: snapshotPath(this.directory, image.thumbnail) };
    }
    this.thumbnails.set(image.thumbnail.id, thumbnail);
    return thumbnail;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    if (!this.showImages || !getCapabilities().images) {
      return [
        ...wrapTextWithAnsi(
          this.theme.fg("muted", "Image preview unavailable or disabled. Open the PNG snapshots:"),
          width,
        ),
        ...this.metadata(width),
      ];
    }
    const { columns, tileWidth } = layoutGeometry(width, this.snapshot.maxWidthCells);
    const cell = getCellDimensions();
    const cellWidth = Math.max(1, Math.min(32, cell.widthPx));
    const cellHeight = Math.max(1, Math.min(64, cell.heightPx));
    const key = `${columns}:${tileWidth}:${cellWidth}:${cellHeight}:${getCapabilities().images}`;
    if (this.layout?.key !== key) {
      const rows: Row[] = [];
      for (const group of this.snapshot.groups) {
        for (let offset = 0; offset < group.images.length; offset += columns) {
          const images = group.images.slice(offset, offset + columns);
          const tilePixels = tileWidth * cellWidth;
          const height = 12 * cellHeight;
          const gap = 2 * cellWidth;
          const rowWidth = images.length * tilePixels + (images.length - 1) * gap;
          const missing: string[] = [];
          const pictures = images
            .map((image, index) => {
              const thumbnail = this.thumbnail(image);
              if (thumbnail.kind === "missing") {
                missing.push(
                  `Thumbnail unavailable. Restore original and thumbnail PNGs and reload Pi, or rerun show_artifacts.\n${thumbnail.path}`,
                );
                return "";
              }
              return `<image href="data:image/png;base64,${thumbnail.base64}" x="${index * (tilePixels + gap)}" width="${tilePixels}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`;
            })
            .join("");
          const png = raster(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${rowWidth}" height="${height}">${pictures}</svg>`,
          );
          rows.push({
            title: offset === 0 ? group.title : "",
            captions: images
              .map((image, index) => {
                const text = truncateToWidth(
                  `${offset + index + 1}. ${image.caption || "Image"}`,
                  tileWidth,
                  "",
                );
                return text + " ".repeat(Math.max(0, tileWidth - visibleWidth(text)));
              })
              .join("  "),
            image: new Image(
              png.toString("base64"),
              "image/png",
              { fallbackColor: (text) => this.theme.fg("muted", text) },
              {
                maxWidthCells: images.length * tileWidth + (images.length - 1) * 2,
                maxHeightCells: 12,
              },
              { widthPx: rowWidth, heightPx: height },
            ),
            missing,
          });
        }
      }
      this.layout = { key, rows };
    }
    const lines: string[] = [];
    for (const row of this.layout.rows) {
      if (row.title) lines.push(truncateToWidth(this.theme.fg("accent", row.title), width));
      lines.push(truncateToWidth(this.theme.fg("muted", row.captions), width));
      lines.push(...row.image.render(width));
      for (const message of row.missing)
        lines.push(...wrapTextWithAnsi(this.theme.fg("muted", message), width));
      lines.push("");
    }
    if (this.expanded) lines.push(...this.metadata(width));
    return lines;
  }

  private metadata(width: number): string[] {
    const lines: string[] = [];
    for (const group of this.snapshot.groups) {
      if (group.title) lines.push(this.theme.fg("accent", group.title));
      for (const image of group.images) {
        const path = snapshotPath(this.directory, image);
        if (!existsSync(path))
          lines.push("Snapshot unavailable. Restore the PNG or rerun show_artifacts.");
        lines.push(`${image.caption || "Image"} (${image.width} × ${image.height}) ${path}`);
      }
    }
    return lines.flatMap((line) => wrapTextWithAnsi(line, width));
  }
}
