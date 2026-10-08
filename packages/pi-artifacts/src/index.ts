import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { limits, parseInput, parseSnapshot, safeText } from "./model.js";
import { createSnapshot, snapshotPath, stateDirectory } from "./store.js";
import { ArtifactView } from "./view.js";

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "show_artifacts",
    label: "Show artifacts",
    exposure: "model-only",
    executionMode: "sequential",
    description:
      "Show compact inline image groups for previews, comparisons, galleries or storyboards. Each ordered group has an optional title and local images with optional captions. Paths resolve from the caller's working directory. Accepts .png files or .json Satori documents shaped as {width,height,tree:{type:'div',props:{style:{display:'flex',backgroundColor:'#eef2ff'},children:'Hello'}}}. Width/height are positive integers up to 4096, at most 8 million pixels. Trees use div/span with plain styles and text or element children, not browser HTML, JSX or executable code. No image elements, remote resources or CSS URLs. Satori supports constrained CSS; this tool allows a bounded subset. Call this tool directly, not inside codemode, so Pi persists and displays previews. Snapshots and bounded thumbnails are immutable PNGs in user state. Groups reflow 3/2/1 across wide/medium/narrow terminals, with roughly 12-row tiles. Non-graphics terminals return snapshot paths. Maximum 6 groups of 6 images, 16 MiB PNG or 512 KiB JSON per file. maxWidthCells optionally caps the container (24-122).",
    parameters: Type.Object(
      {
        maxWidthCells: Type.Optional(
          Type.Integer({ minimum: limits.minWidthCells, maximum: limits.maxWidthCells }),
        ),
        groups: Type.Array(
          Type.Object(
            {
              title: Type.Optional(Type.String({ maxLength: limits.label })),
              images: Type.Array(
                Type.Object(
                  {
                    path: Type.String({ minLength: 1, maxLength: limits.path }),
                    caption: Type.Optional(Type.String({ maxLength: limits.label })),
                  },
                  { additionalProperties: false },
                ),
                { minItems: 1, maxItems: limits.images },
              ),
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: limits.groups },
        ),
      },
      { additionalProperties: false },
    ),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const directory = stateDirectory();
      const snapshot = await createSnapshot(parseInput(params), ctx.cwd, directory, signal);
      const text = snapshot.groups
        .map((group) =>
          [
            group.title,
            ...group.images.map(
              (image) =>
                `${image.caption || "Image"}: ${snapshotPath(directory, image)} (${image.width}x${image.height})`,
            ),
          ]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n");
      return {
        content: [
          {
            type: "text",
            text: `Saved immutable PNG snapshots. Inline previews require a graphics-capable Pi terminal.\n${text}`,
          },
        ],
        details: snapshot,
      };
    },
    renderCall(_args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("show_artifacts")), 0, 0);
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      if (isPartial) return new Text(theme.fg("muted", "Preparing snapshots…"), 0, 0);
      if (context.isError) {
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => safeText(part.text.slice(0, 1000), 1000))
          .join("\n");
        return new Text(theme.fg("error", text || "Artifact creation failed"), 0, 0);
      }
      try {
        const view =
          context.lastComponent instanceof ArtifactView
            ? context.lastComponent
            : new ArtifactView(parseSnapshot(result.details), stateDirectory(), theme);
        view.theme = theme;
        view.showImages = context.showImages;
        view.expanded = expanded;
        return view;
      } catch (error) {
        const message =
          error instanceof Error ? error.message.slice(0, 1000) : "Invalid saved artifacts";
        return new Text(
          theme.fg(
            "warning",
            `Artifacts unavailable. ${safeText(message, 1000)}. Restore snapshots or rerun show_artifacts.`,
          ),
          0,
          0,
        );
      }
    },
  });
}
