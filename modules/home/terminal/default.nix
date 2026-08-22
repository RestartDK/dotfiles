{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  hasScattererInput = dotfilesInputs ? scatterer;
  herdrPackage = dotfilesInputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
  tuicrPackage = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.tuicr;
  # Upstream's packages.plugin is a ready-to-link Herdr plugin root: the
  # store manifest invokes the built binary directly (no bash launcher, no
  # cargo build hook), so no local assembly package is needed.
  scattererPackage =
    if hasScattererInput then
      dotfilesInputs.scatterer.packages.${pkgs.stdenv.hostPlatform.system}.plugin
    else
      null;
  scattererPluginRoot =
    if hasScattererInput then "${scattererPackage}/share/herdr/plugins/scatterer" else null;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
  dir = path: {
    source = link path;
    recursive = false;
    force = true;
  };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.terminalTools {
        home.packages = [ tuicrPackage ];
        xdg.configFile = {
          "btop/btop.conf" = file "config/btop/btop.conf";
          "thefuck/settings.py" = file "config/thefuck/settings.py";
          "tuicr/config.toml" = file "config/tuicr/config.toml";
        };
      })

      (lib.mkIf cfg.groups.ghostty {
        xdg.configFile."ghostty" = dir "config/ghostty";
      })

      (lib.mkIf cfg.groups.multiplexer (
        lib.mkMerge [
          {
            home.packages = [ herdrPackage ];
            xdg.configFile."herdr/config.toml" = file "config/herdr/config.toml";
          }

          (lib.mkIf hasScattererInput {
            home.packages = [ scattererPackage ];

            home.activation.linkScattererHerdrPlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
              # Herdr stores its plugin registry in a plain JSON file that the
              # CLI can edit offline. Read that file directly instead of asking
              # the server, so activation never races a running-but-mismatched
              # Herdr server (CLI/server protocol_mismatch during upgrades).
              # Preserve an explicit local development link; otherwise refresh
              # the immutable Nix registration.
              registry="${config.xdg.configHome}/herdr/plugins.json"
              existing_manifest=""
              if [ -f "$registry" ]; then
                existing_manifest="$(
                  ${pkgs.jq}/bin/jq -r \
                    'map(select(.plugin_id == "daniel.scatterer")) | first | .manifest_path // empty' \
                    "$registry" 2>/dev/null || true
                )"
              fi
              if [ -n "$existing_manifest" ] && [[ "$existing_manifest" != /nix/store/* ]]; then
                echo "Preserving local Scatterer plugin link at $existing_manifest"
              elif ! run "${herdrPackage}/bin/herdr" plugin link "${scattererPluginRoot}" >/dev/null 2>&1; then
                echo "Could not refresh Scatterer plugin registration; leaving the existing registration unchanged."
              fi
            '';
          })
        ]
      ))
    ]
  );
}
