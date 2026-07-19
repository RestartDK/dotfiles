{ config, dotfilesInputs, lib, pkgs, ... }:

let
  cfg = config.my.liveConfig;
  hasScattererInput = dotfilesInputs ? scatterer-src;
  herdrPackage = dotfilesInputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
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
      xdg.configFile = {
        "btop/btop.conf" = file "config/btop/btop.conf";
        "hunk/config.toml" = file "config/hunk/config.toml";
        "thefuck/settings.py" = file "config/thefuck/settings.py";
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
          herdr_bin="${herdrPackage}/bin/herdr"
          plugin_root="${scattererPluginRoot}"

          # Plugin linking uses Herdr's socket API. Bootstrap a temporary
          # headless server for first-time or non-interactive activations, but
          # leave an already running Herdr session alone.
          started_herdr_server=0
          herdr_server_pid=""
          if ! "$herdr_bin" status server >/dev/null 2>&1; then
            "$herdr_bin" server >/dev/null 2>&1 &
            herdr_server_pid=$!
            started_herdr_server=1
            for _ in {1..50}; do
              "$herdr_bin" status server >/dev/null 2>&1 && break
              ${pkgs.coreutils}/bin/sleep 0.1
            done
          fi

          if ! run "$herdr_bin" plugin link "$plugin_root" >/dev/null 2>&1; then
            echo "Could not refresh Scatterer plugin registration; leaving the existing registration unchanged."
          fi

          if [ "$started_herdr_server" -eq 1 ]; then
            "$herdr_bin" server stop >/dev/null 2>&1 || true
            wait "$herdr_server_pid" 2>/dev/null || true
          fi
        '';
      })
    ]))
  ]);
}
