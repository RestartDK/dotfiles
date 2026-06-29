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

    function replaceRegex(path, pattern, to) {
      const before = fs.readFileSync(path, "utf8");
      const after = before.replace(pattern, to);
      if (after === before) {
        console.error("pattern not found in " + path);
        process.exit(1);
      }
      fs.writeFileSync(path, after);
    }

    const root = process.env.out + "/lib/node_modules/pi-monorepo";

    for (const file of [
      root + "/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js",
      root + "/node_modules/@earendil-works/pi-ai/dist/api/azure-openai-responses.js",
    ]) {
      replaceRegex(
        file,
        /if \(options\?\.maxTokens\) \{\n\s*params\.max_output_tokens = options\?\.maxTokens;\n\s*\}/,
        `if (options?.maxTokens) {
        if (options.maxTokens < 16) {
            throw new Error("context_length_exceeded: available output token budget is below OpenAI Responses minimum (16)");
        }
        params.max_output_tokens = options?.maxTokens;
    }`,
      );
    }

    replace(
      root + "/node_modules/@earendil-works/pi-ai/dist/utils/overflow.js",
      `/exceeds the context window/i, // OpenAI (Completions & Responses API)`,
      `/exceeds the context window/i, // OpenAI (Completions & Responses API)
    /Invalid 'max_output_tokens': integer below minimum value/i, // OpenAI Responses API output budget exhausted`,
    );

    replaceRegex(
      root + "/dist/core/session-manager.js",
      /const messages = \[];\n\s*const appendMessage = \(entry\) => \{\n\s*if \(entry\.type === "message"\) \{\n\s*messages\.push\(entry\.message\);\n\s*\}/,
      `const messages = [];
    const appendMessage = (entry, options = {}) => {
        if (entry.type === "message") {
            if (options.stripAssistantUsage && entry.message.role === "assistant") {
                messages.push({
                    ...entry.message,
                    usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                });
            }
            else {
                messages.push(entry.message);
            }
        }`,
    );

    replaceRegex(
      root + "/dist/core/session-manager.js",
      /if \(foundFirstKept\) \{\n\s*appendMessage\(entry\);\n\s*\}/,
      `if (foundFirstKept) {
                appendMessage(entry, { stripAssistantUsage: true });
            }`,
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
