{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
in
{
  config = lib.mkIf (cfg.enable && cfg.groups.editors) {
    xdg.configFile."nvim" = {
      source = ../../../config/nvim;
      recursive = true;
      force = true;
    };
  };
}
