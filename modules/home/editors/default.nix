{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  dir = path: {
    source = link path;
    recursive = false;
    force = true;
  };
in
{
  config = lib.mkIf (cfg.enable && cfg.groups.editors) {
    xdg.configFile."nvim" = dir "config/nvim";
  };
}
