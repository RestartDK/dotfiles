{ config, inputs, lib, pkgs, ... }:

let
  cfg = config.my.liveConfig;
  hasScattererInput = inputs ? scatterer-src;
  herdrPackage = inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
  scattererPackage =
    if hasScattererInput then
      pkgs.callPackage ../../../packages/scatterer.nix {
        src = inputs.scatterer-src;
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
      xdg.configFile."btop/btop.conf" = file "config/btop/btop.conf";
      xdg.configFile."hunk/config.toml" = file "config/hunk/config.toml";
      xdg.configFile."thefuck/settings.py" = file "config/thefuck/settings.py";
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

          run "$herdr_bin" plugin uninstall daniel.scatterer >/dev/null 2>&1 || true
          run "$herdr_bin" plugin unlink daniel.scatterer >/dev/null 2>&1 || true
          run "$herdr_bin" plugin link "$plugin_root" >/dev/null
        '';
      })
    ]))
  ]);
}
