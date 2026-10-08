# Pi artifacts

`show_artifacts` displays ordered image groups in the Pi transcript. Single previews, comparisons, galleries, and storyboards use the same input. It is a model-only tool, called directly beside codemode, never from its scripts. Nested tool calls do not persist artifact details or render inline previews.

```json
{
  "groups": [
    {
      "title": "Onboarding",
      "images": [
        { "path": "welcome.json", "caption": "Welcome" },
        { "path": "account.png", "caption": "Account" }
      ]
    }
  ]
}
```

Paths are local and relative to the caller's working directory. The optional `maxWidthCells` caps the container at 24 to 122 terminal columns, default 112. Each group wraps independently into three, two, or one columns. Tiles preserve aspect ratio within 36 columns and about 12 rows.

## Satori document format

A `.json` document contains `width`, `height`, and `tree`.

```json
{
  "width": 480,
  "height": 240,
  "tree": {
    "type": "div",
    "props": {
      "style": {
        "display": "flex",
        "width": "100%",
        "height": "100%",
        "alignItems": "center",
        "justifyContent": "center",
        "backgroundColor": "#eef2ff",
        "color": "#243a70",
        "fontSize": 36,
        "fontWeight": 700
      },
      "children": "Hello, artifacts"
    }
  }
}
```

Elements are `div` or `span`. Props contain only `style` and `children`. Children are text, a number, an element, or an array of elements. Empty children are allowed. Containers with multiple children generally need `display: "flex"` and an explicit `flexDirection`.

Satori supports constrained CSS, not general browser HTML. This package admits the layout, spacing, border, color, typography, and transform properties listed in `src/model.ts`. Unsupported styles fail visibly. There is no JSX, JavaScript, HTML, image element, SVG input, CSS URL, or network resource loading. DejaVu Sans regular and bold are packaged fonts. No host fonts or emoji downloads are used.

Limits are six groups of six images, 16 MiB per PNG, 512 KiB per JSON file, dimensions from 1 to 4096, eight million pixels, and 4,096 PNG chunks. Trees allow 1,024 elements, 32 nesting levels, and 32,000 text characters. CSS values are bounded. Both PNG and JSON inputs run in the pinned Node worker with a 15-second deadline and cancellation. The worker validates and normalizes originals and creates thumbnails up to 720 × 480 pixels and 2 MiB. Full-resolution decoding never runs in the transcript renderer.

## Snapshots and replay

Each input becomes a validated, normalized PNG under `${XDG_STATE_HOME:-~/.local/state}/pi/artifacts/v1`. Nonessential PNG metadata is discarded during normalization. Originals and thumbnails are content-addressed and read-only. Publication preserves valid targets and atomically repairs corrupt regular files owned by the current user. Concurrent writers serialize publication per hash. An interrupted Pi process can leave a lock directory; a busy-publication error names it for removal after confirming its writer has stopped. Original files can change or disappear without changing old designs.

Tool-result details store version 1, the width cap, group titles, and image IDs, dimensions, captions, and mandatory thumbnail IDs/dimensions. This unshipped version-1 contract replaces the earlier thumbnail-free preview shape. Older scratch sessions must be recreated. Replay resolves IDs in the current state directory. Moving a session to another machine also requires copying its snapshots. There is no automatic expiration or garbage collection. Deleting snapshots breaks historical previews but not session loading. The fallback names the missing original or thumbnail path and asks you to restore the PNGs and reload Pi or rerun `show_artifacts`.

The worker publishes verified originals and thumbnails before returning. Replay reads only bounded thumbnail files, cached per displayed result, and native Pi `Image` components own graphics IDs and lifecycle. Resize recomposes thumbnails rather than decoding full-resolution sources again. Expanding a result adds full captions and snapshot paths. Pi's image visibility toggle is respected.

## Terminal behavior

The flake's Pi wrapper sets `PI_IMAGE_PROTOCOL=kitty` before startup only for an interactive Herdr terminal. Explicit environment overrides, dumb terminals, and nested tmux, screen, or Zellij sessions are left alone. Pi settings take precedence over environment overrides. No extension probes or intercepts terminal input.

Other terminals use Pi's detection. Headless and unsupported terminals return snapshot paths, without a claim that images were displayed. Pi 0.99.1 disables iTerm2 images in fullscreen mode. Use regular mode for iTerm2 graphics. Explicit `--tools` allowlists must include `show_artifacts`; the extension never force-activates itself.

## Nix package

Both Pi settings profiles load `./packages/pi-artifacts`. Home Manager supplies that directory from the flake package. Satori, resvg, Node, and fonts require no per-machine npm install. The lock includes resvg's Linux x64 GNU and Darwin ARM64 optional binaries. Native Darwin execution still needs a Darwin builder.

`nix build .#pi-artifacts` compiles strict TypeScript and runs parser, real-renderer, immutable-snapshot, and native-component tests. `checks.<system>.pi-artifacts` also exercises the production wrapper constructor around a stub child in a pty, including exported environment and argument quoting. Build-time `src/runtime.ts` generation supplies the absolute pinned Node executable; Pi runs Bun, so its executable is not a substitute. Source development tests require the Nix build; an unconfigured runtime fails with explicit guidance. The package output is `lib/node_modules/pi-artifacts`, with extension `dist/index.js`.

`update-pi-packages` skips this local package. Dependency updates use its package manifest and lock. Pi 0.99.1's upstream shrinkwrap omits seven nested integrity fields. This lock fills them from the matching npm registry records; preserve integrity fields when regenerating it.
