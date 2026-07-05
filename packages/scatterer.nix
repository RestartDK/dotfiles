{ bashNonInteractive, lib, rustPlatform, src }:

let
  manifest = builtins.fromTOML (builtins.readFile "${src}/herdr-plugin.toml");
in
rustPlatform.buildRustPackage {
  pname = "scatterer-herdr-plugin";
  inherit (manifest) version;

  inherit src;
  cargoHash = "sha256-bc1/N1R4bt5RfGgK0ISRNDA7uw54LGIMY1wgCrzVycg=";

  # The plugin root is immutable in /nix/store, so Herdr should execute the
  # already-built binary we install below rather than relying on cargo at
  # runtime. Link/install-time build commands are only used outside Nix.
  doCheck = false;

  postPatch = ''
    substituteInPlace herdr-plugin.toml \
      --replace-fail '"bash", "scripts/scatterer.sh"' '"${bashNonInteractive}/bin/bash", "scripts/scatterer.sh"'
  '';

  installPhase = ''
    runHook preInstall

    binary="$(find target -type f -path '*/release/scatterer' -perm -111 | head -n 1)"
    if [ -z "$binary" ]; then
      echo "failed to find built scatterer binary" >&2
      exit 1
    fi

    pluginRoot="$out/share/herdr/plugins/scatterer"
    install -Dm755 "$binary" "$out/bin/scatterer"
    install -Dm644 herdr-plugin.toml "$pluginRoot/herdr-plugin.toml"
    install -Dm755 scripts/scatterer.sh "$pluginRoot/scripts/scatterer.sh"
    install -Dm755 "$binary" "$pluginRoot/target/release/scatterer"

    runHook postInstall
  '';

  meta = {
    description = manifest.description or "Daniel's Herdr workflow/layout plugin";
    homepage = "https://github.com/RestartDK/scatterer";
    platforms = with lib.platforms; darwin ++ linux;
    mainProgram = "scatterer";
  };
}
