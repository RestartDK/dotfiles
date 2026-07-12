{
  fetchurl,
  lib,
  stdenvNoCC,
}:

let
  version = "0.144.1";
  system = stdenvNoCC.hostPlatform.system;
  sources = {
    x86_64-linux = {
      npmPlatform = "linux-x64";
      vendorTriple = "x86_64-unknown-linux-musl";
      hash = "sha256-4qZNQhwQqvC348DovXG3Hkl9dYIwAzGLZ0onjXGt0Mc=";
    };
    aarch64-darwin = {
      npmPlatform = "darwin-arm64";
      vendorTriple = "aarch64-apple-darwin";
      hash = "sha256-NlpWhRcPZrrVjdHauwRi37gk+CqHC8yNmvLrCkHPLhg=";
    };
  };
  source = sources.${system} or (throw "codex-cli is not packaged for ${system} in this config");
in
stdenvNoCC.mkDerivation {
  pname = "codex";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/@openai/codex/-/codex-${version}-${source.npmPlatform}.tgz";
    inherit (source) hash;
  };

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/share/codex" "$out/bin"
    cp -R . "$out/share/codex/"

    chmod +x \
      "$out/share/codex/vendor/${source.vendorTriple}/bin/codex" \
      "$out/share/codex/vendor/${source.vendorTriple}/bin/codex-code-mode-host"

    printf '%s\n' \
      '#!/usr/bin/env bash' \
      'exec @codex@ "$@"' \
      > "$out/bin/codex"
    substituteInPlace "$out/bin/codex" \
      --replace-fail @codex@ "$out/share/codex/vendor/${source.vendorTriple}/bin/codex"
    chmod +x "$out/bin/codex"

    runHook postInstall
  '';

  meta = {
    description = "OpenAI Codex CLI binary distribution from npm";
    homepage = "https://github.com/openai/codex";
    license = lib.licenses.asl20;
    mainProgram = "codex";
    platforms = builtins.attrNames sources;
  };
}
