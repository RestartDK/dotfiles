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
  herdrPackage = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.herdr;
  terminalBrowserPackage =
    dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.terminal-browser;
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
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.terminalTools {
        home.packages = [
          tuicrPackage
          terminalBrowserPackage
        ];
        home.sessionVariables.TERMINAL_BROWSER_NO_TELEMETRY = "1";
        xdg.configFile = {
          "btop/btop.conf" = {
            source = ../../../config/btop/btop.conf;
            force = true;
          };
          "thefuck/settings.py" = {
            source = ../../../config/thefuck/settings.py;
            force = true;
          };
          "tuicr/config.toml" = {
            source = ../../../config/tuicr/config.toml;
            force = true;
          };
        };
      })

      (lib.mkIf cfg.groups.ghostty {
        xdg.configFile."ghostty" = {
          source = ../../../config/ghostty;
          recursive = true;
          force = true;
        };
      })

      (lib.mkIf cfg.groups.multiplexer (
        lib.mkMerge [
          {
            home.packages = [ herdrPackage ];
            xdg.configFile = {
              "herdr/config.toml" = {
                source = ../../../config/herdr/config.toml;
                force = true;
              };
              "herdr/hostname-status.py" = {
                source = ../../../config/herdr/hostname-status.py;
                force = true;
              };
              "herdr/usage-status.py" = {
                source = ../../../config/herdr/usage-status.py;
                force = true;
              };
              "herdr/sounds/haki.mp3" = {
                source = ../../../config/herdr/sounds/haki.mp3;
                force = true;
              };
              "herdr/sounds/za-warudo.mp3" = {
                source = ../../../config/herdr/sounds/za-warudo.mp3;
                force = true;
              };
            };
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
