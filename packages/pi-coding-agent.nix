{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeBinaryWrapper,
  stdenvNoCC,
  versionCheckHook,
  writableTmpDirAsHomeHook,
  ripgrep,
  fd,
  src,
}:

let
  packageJson = builtins.fromJSON (builtins.readFile "${src}/packages/coding-agent/package.json");
in
buildNpmPackage {
  pname = "pi-coding-agent";
  version = packageJson.version;

  inherit src;

  npmDeps = importNpmLock { npmRoot = src; };
  npmConfigHook = importNpmLock.npmConfigHook;

  npmWorkspace = "packages/coding-agent";

  # Skip native module rebuild for unneeded workspaces (e.g. canvas from web-ui).
  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    makeBinaryWrapper
  ];

  # Build workspace dependencies in order, then the coding-agent.
  # We invoke tsgo directly for workspace deps to skip pi-ai's
  # generate-models script which requires network access
  # (models.generated.ts is committed to the repo).
  buildPhase = ''
    runHook preBuild

    npx tsgo -p packages/ai/tsconfig.build.json
    npx tsgo -p packages/tui/tsconfig.build.json
    npx tsgo -p packages/agent/tsconfig.build.json
    npm run build --workspace=packages/coding-agent

    runHook postBuild
  '';

  # npm workspace symlinks in the output point into packages/ which
  # doesn't exist there. Replace runtime deps with built content and
  # delete the rest.
  postInstall = ''
    local nm="$out/lib/node_modules/pi-monorepo/node_modules"

    # Replace workspace deps needed at runtime with real copies.
    for ws in @earendil-works/pi-ai:packages/ai \
              @earendil-works/pi-agent-core:packages/agent \
              @earendil-works/pi-tui:packages/tui; do
      IFS=: read -r pkg ws_src <<< "$ws"
      rm "$nm/$pkg"
      cp -r "$ws_src" "$nm/$pkg"
    done

    # Delete remaining workspace symlinks.
    find "$nm" -type l -lname '*/packages/*' -delete

    # Clean up now-dangling .bin symlinks.
    find "$nm/.bin" -xtype l -delete
  ''
  + lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
    # Remove foreign Linux binaries that make audit-tmpdir try to inspect ELF
    # RPATHs with patchelf.
    rm -rf \
      "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
      "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
  '';

  postFixup = ''
    node <<'NODE'
    const fs = require("fs");

    function replace(path, from, to) {
      const before = fs.readFileSync(path, "utf8");
      if (!before.includes(from)) {
        console.error("pattern not found in " + path);
        process.exit(1);
      }
      fs.writeFileSync(path, before.replace(from, to));
    }

    const root = process.env.out + "/lib/node_modules/pi-monorepo";
    const sessionManager = root + "/dist/core/session-manager.js";

    replace(
      sessionManager,
      `export function buildContextEntries(entries, leafId, byId) {`,
      [
        `function stripAssistantUsageForCompactionContext(entry) {`,
        `    if (entry.type !== "message" || entry.message.role !== "assistant") {`,
        `        return entry;`,
        `    }`,
        `    return {`,
        `        ...entry,`,
        `        message: {`,
        `            ...entry.message,`,
        `            usage: {`,
        `                input: 0,`,
        `                output: 0,`,
        `                cacheRead: 0,`,
        `                cacheWrite: 0,`,
        `                totalTokens: 0,`,
        `                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },`,
        `            },`,
        `        },`,
        `    };`,
        `}`,
        `export function buildContextEntries(entries, leafId, byId) {`,
      ].join("\n"),
    );

    replace(
      sessionManager,
      `            contextEntries.push(entry);`,
      `            contextEntries.push(stripAssistantUsageForCompactionContext(entry));`,
    );
    NODE

    wrapProgram $out/bin/pi --prefix PATH : ${
      lib.makeBinPath [
        ripgrep
        fd
      ]
    }
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [
    writableTmpDirAsHomeHook
    versionCheckHook
  ];
  versionCheckKeepEnvironment = [ "HOME" ];
  versionCheckProgram = "${placeholder "out"}/bin/pi";
  versionCheckProgramArg = "--version";

  meta = {
    description = "Coding agent CLI with read, bash, edit, write tools and session management";
    homepage = "https://pi.dev/";
    downloadPage = "https://www.npmjs.com/package/@earendil-works/pi-coding-agent";
    changelog = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
    license = lib.licenses.mit;
    maintainers = with lib.maintainers; [ munksgaard ];
    mainProgram = "pi";
  };
}
