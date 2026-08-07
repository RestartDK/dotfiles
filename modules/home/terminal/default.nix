{ config, dotfilesInputs, lib, pkgs, ... }:

let
  cfg = config.my.liveConfig;
  hasScattererInput = dotfilesInputs ? scatterer-src;
  herdrPackage = dotfilesInputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
  tuicrPackage = dotfilesInputs.llm-agents.packages.${pkgs.stdenv.hostPlatform.system}.tuicr;
  scattererPackage =
    if hasScattererInput then
      pkgs.callPackage ../../../packages/scatterer.nix {
        src = dotfilesInputs.scatterer-src;
      }
    else
      null;
  scattererPluginRoot =
    if hasScattererInput then
      "${scattererPackage}/share/herdr/plugins/scatterer"
    else
      null;
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
  config = lib.mkIf cfg.enable (lib.mkMerge [
    (lib.mkIf cfg.groups.terminalTools {
      home.packages = [ tuicrPackage ];
      xdg.configFile = {
        "btop/btop.conf" = file "config/btop/btop.conf";
        "hunk/config.toml" = file "config/hunk/config.toml";
        "thefuck/settings.py" = file "config/thefuck/settings.py";
        "tuicr/config.toml" = file "config/tuicr/config.toml";
      };
    })

    (lib.mkIf cfg.groups.ghostty {
      xdg.configFile."ghostty" = dir "config/ghostty";
    })

    (lib.mkIf cfg.groups.multiplexer (lib.mkMerge [
      {
        home.packages = [ herdrPackage ];
        xdg.configFile."herdr/config.toml" = file "config/herdr/config.toml";
      }

      (lib.mkIf hasScattererInput {
        home.packages = [ scattererPackage ];

        home.activation.linkScattererHerdrPlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          # Herdr 0.7.5 stores one user-global plugin registry and can update it
          # while the server is offline. Never start or restore a session only
          # to refresh this declarative plugin link. Preserve an explicit local
          # development link; otherwise refresh the immutable Nix registration.
          existing_manifest="$(
            "${herdrPackage}/bin/herdr" plugin list --json 2>/dev/null \
              | ${pkgs.jq}/bin/jq -r '.result.plugins[]? | select(.plugin_id == "daniel.scatterer") | .manifest_path // empty' \
              | ${pkgs.coreutils}/bin/head -n 1
          )"
          if [ -n "$existing_manifest" ] && [[ "$existing_manifest" != /nix/store/* ]]; then
            echo "Preserving local Scatterer plugin link at $existing_manifest"
          elif ! run "${herdrPackage}/bin/herdr" plugin link "${scattererPluginRoot}" >/dev/null 2>&1; then
            echo "Could not refresh Scatterer plugin registration; leaving the existing registration unchanged."
          fi
        '';
      })
    ]))
  ]);
}
