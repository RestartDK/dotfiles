{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
in
{
  config = lib.mkIf cfg.enable (lib.mkMerge [
    (lib.mkIf cfg.groups.shell {
      home.file.".zshrc" = file "config/shell/zshrc";
      xdg.configFile."starship.toml" = file "config/shell/starship.toml";
    })

    (lib.mkIf cfg.groups.git {
      xdg.configFile."git/ignore" = file "config/git/ignore";
    })
  ]);
}
