export const limits = {
  fileBytes: 16 * 1024 * 1024,
  thumbnailBytes: 2 * 1024 * 1024,
  thumbnailWidth: 720,
  thumbnailHeight: 480,
  workerMs: 15_000,
  label: 120,
  path: 4096,
  minWidthCells: 24,
  maxWidthCells: 122,
  defaultWidthCells: 112,
  pngChunks: 4096,
  jsonBytes: 512 * 1024,
  pixels: 8_000_000,
  dimension: 4096,
  nodes: 1024,
  depth: 32,
  text: 32_000,
  groups: 6,
  images: 6,
};

export interface ArtifactInput {
  maxWidthCells: number;
  groups: { title: string; images: { path: string; caption: string }[] }[];
}

export interface PngReference {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface SnapshotImage extends PngReference {
  readonly caption: string;
  readonly thumbnail: PngReference;
}

export interface ArtifactSnapshot {
  version: 1;
  maxWidthCells: number;
  groups: { title: string; images: SnapshotImage[] }[];
}

export interface SatoriElement {
  type: "div" | "span";
  key: null;
  props: {
    style: Partial<Record<StyleProperty, string | number>>;
    children: string | SatoriElement[];
  };
}

export interface SatoriDocument {
  width: number;
  height: number;
  tree: SatoriElement;
}

const styleProperties = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "flexDirection",
  "flexWrap",
  "flexGrow",
  "flexShrink",
  "flexBasis",
  "alignItems",
  "alignSelf",
  "alignContent",
  "justifyContent",
  "gap",
  "rowGap",
  "columnGap",
  "padding",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "margin",
  "marginTop",
  "marginRight",
  "marginBottom",
  "marginLeft",
  "backgroundColor",
  "color",
  "border",
  "borderWidth",
  "borderColor",
  "borderStyle",
  "borderRadius",
  "borderTop",
  "borderBottom",
  "borderLeft",
  "borderRight",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "lineHeight",
  "letterSpacing",
  "textAlign",
  "textDecoration",
  "textTransform",
  "whiteSpace",
  "wordBreak",
  "opacity",
  "overflow",
  "transform",
  "transformOrigin",
  "aspectRatio",
] as const;
type StyleProperty = (typeof styleProperties)[number];

function isStyleProperty(key: string): key is StyleProperty {
  return styleProperties.some((property) => property === key);
}

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return Object.fromEntries(Object.entries(value));
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Allowed fields: ${keys.join(", ")}`);
  }
}

export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Expected an integer from ${min} to ${max}`);
  }
  return value;
}

export function safeText(value: unknown, max = limits.label): string {
  if (typeof value !== "string" || value.length > max)
    throw new Error(`Expected text up to ${max} characters`);
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ");
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`Expected 1 to ${max} items`);
  }
  return value;
}

export function dimensions(width: unknown, height: unknown): { width: number; height: number } {
  const size = {
    width: integer(width, 1, limits.dimension),
    height: integer(height, 1, limits.dimension),
  };
  if (size.width * size.height > limits.pixels) throw new Error("Image exceeds 8 million pixels");
  return size;
}

export function parseInput(value: unknown): ArtifactInput {
  const input = object(value);
  onlyKeys(input, ["groups", "maxWidthCells"]);
  return {
    maxWidthCells: integer(
      input.maxWidthCells ?? limits.defaultWidthCells,
      limits.minWidthCells,
      limits.maxWidthCells,
    ),
    groups: array(input.groups, limits.groups).map((item) => {
      const group = object(item);
      onlyKeys(group, ["title", "images"]);
      return {
        title: safeText(group.title ?? ""),
        images: array(group.images, limits.images).map((item) => {
          const image = object(item);
          onlyKeys(image, ["path", "caption"]);
          if (
            typeof image.path !== "string" ||
            image.path.length < 1 ||
            image.path.length > limits.path ||
            /[\p{Cc}\p{Cf}]/u.test(image.path) ||
            /^[a-z][a-z0-9+.-]*:/i.test(image.path)
          ) {
            throw new Error("Images need a local .json or .png path, without control characters");
          }
          return { path: image.path, caption: safeText(image.caption ?? "") };
        }),
      };
    }),
  };
}

export function parsePngReference(value: unknown): PngReference {
  const image = object(value);
  if (typeof image.id !== "string" || !/^[a-f0-9]{64}$/.test(image.id))
    throw new Error("Invalid snapshot ID");
  return { id: image.id, ...dimensions(image.width, image.height) };
}

export function parseSnapshot(value: unknown): ArtifactSnapshot {
  const snapshot = object(value);
  if (snapshot.version !== 1)
    throw new Error("Unsupported artifact snapshot version; update pi-artifacts");
  return {
    version: 1,
    maxWidthCells: integer(snapshot.maxWidthCells, limits.minWidthCells, limits.maxWidthCells),
    groups: array(snapshot.groups, limits.groups).map((item) => {
      const group = object(item);
      return {
        title: safeText(group.title),
        images: array(group.images, limits.images).map((item) => {
          const image = object(item);
          if (image.thumbnail === undefined)
            throw new Error(
              "Saved thumbnail missing; restore updated snapshots or rerun show_artifacts",
            );
          const thumbnail = parsePngReference(image.thumbnail);
          integer(thumbnail.width, 1, limits.thumbnailWidth);
          integer(thumbnail.height, 1, limits.thumbnailHeight);
          return {
            ...parsePngReference(image),
            caption: safeText(image.caption),
            thumbnail,
          };
        }),
      };
    }),
  };
}

export function parseDocument(value: unknown): SatoriDocument {
  const document = object(value);
  onlyKeys(document, ["width", "height", "tree"]);
  const size = dimensions(document.width, document.height);
  let nodes = 0;
  let textLength = 0;
  function element(value: unknown, depth: number): SatoriElement {
    if (++nodes > limits.nodes || depth > limits.depth)
      throw new Error("Satori tree exceeds node or nesting limit");
    const node = object(value);
    onlyKeys(node, ["type", "props"]);
    if (node.type !== "div" && node.type !== "span")
      throw new Error("Only div and span elements are supported");
    const props = object(node.props);
    onlyKeys(props, ["style", "children"]);
    const style: SatoriElement["props"]["style"] = {};
    for (const [key, value] of Object.entries(object(props.style ?? {}))) {
      if (!isStyleProperty(key)) throw new Error(`Unsupported style property: ${safeText(key)}`);
      if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8192) {
        style[key] = value;
      } else if (
        typeof value === "string" &&
        value.length <= 256 &&
        /^[a-z0-9#.,%() +-]*$/i.test(value) &&
        !/url|image|expression|import/i.test(value)
      ) {
        const numbers =
          value.replace(/#[0-9a-f]{3,8}\b/gi, "").match(/[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi) ?? [];
        if (
          numbers.some(
            (number) => !Number.isFinite(Number(number)) || Math.abs(Number(number)) > 8192,
          )
        )
          throw new Error("CSS number exceeds limit");
        style[key] = value;
      } else {
        throw new Error(
          "Style values must be bounded numbers or plain CSS values without resources",
        );
      }
    }
    let children: SatoriElement["props"]["children"];
    if (typeof props.children === "string" || typeof props.children === "number") {
      children = safeText(String(props.children), limits.text);
      textLength += children.length;
      if (textLength > limits.text) throw new Error("Satori text exceeds limit");
    } else if (props.children === undefined) {
      children = [];
    } else {
      const input = Array.isArray(props.children) ? props.children : [props.children];
      if (input.length > limits.nodes) throw new Error("Too many children");
      children = input.map((child: unknown) => element(child, depth + 1));
    }
    return { type: node.type, key: null, props: { style, children } };
  }
  return { ...size, tree: element(document.tree, 1) };
}
