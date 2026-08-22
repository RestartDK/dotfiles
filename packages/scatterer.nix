# Assembles the Herdr plugin root around the scatterer binary built by the
# upstream flake (packages.default). The upstream package is pinned by its own
# Cargo.lock, so this file no longer tracks a cargoHash.
{
  bashNonInteractive,
  lib,
  stdenvNoCC,
  # Upstream flake source tree (manifest + launcher script).
  src,
  # Built scatterer package from the upstream flake.
  scatterer,
}:

let
  manifest = builtins.fromTOML (builtins.readFile "${src}/herdr-plugin.toml");
in
stdenvNoCC.mkDerivation {
  pname = "scatterer-herdr-plugin";
  inherit (manifest) version;

  inherit src;

  dontConfigure = true;
  dontBuild = true;

  # The plugin root is immutable in /nix/store, so Herdr should execute the
  # already-built binary we install below rather than relying on cargo at
  # runtime. Link/install-time build commands are only used outside Nix.
  postPatch = ''
    substituteInPlace herdr-plugin.toml \
      --replace-fail '"bash", "scripts/scatterer.sh"' '"${bashNonInteractive}/bin/bash", "scripts/scatterer.sh"' \
      --replace-warn '"/bin/bash", "scripts/scatterer.sh"' '"${bashNonInteractive}/bin/bash", "scripts/scatterer.sh"'
  '';

  installPhase = ''
    runHook preInstall

    pluginRoot="$out/share/herdr/plugins/scatterer"
    mkdir -p "$out/bin" "$pluginRoot/target/release"
    ln -s ${lib.getExe scatterer} "$out/bin/scatterer"
    ln -s ${lib.getExe scatterer} "$pluginRoot/target/release/scatterer"
    install -Dm644 herdr-plugin.toml "$pluginRoot/herdr-plugin.toml"
    install -Dm755 scripts/scatterer.sh "$pluginRoot/scripts/scatterer.sh"

    runHook postInstall
  '';

  meta = {
    description = manifest.description or "Daniel's Herdr workflow/layout plugin";
    homepage = "https://github.com/RestartDK/scatterer";
    platforms = with lib.platforms; darwin ++ linux;
    mainProgram = "scatterer";
  };
}
