{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  link = path: config.lib.file.mkOutOfStoreSymlink "${cfg.repoRoot}/${path}";
  file = path: {
    source = link path;
    force = true;
  };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.shell {
        home.packages = [
          (pkgs.runCommandLocal "repo-exec" { } ''
            mkdir -p "$out/bin"
            ln -s ${lib.escapeShellArg "${cfg.repoRoot}/bin/repo-exec"} "$out/bin/repo-exec"
          '')
        ];
        programs.zsh = {
          enable = true;
          enableCompletion = true;
          autosuggestion.enable = true;
          syntaxHighlighting.enable = true;
          # Register user completion directories before Home Manager runs compinit,
          # then load the substantive live-editable configuration.
          initContent = lib.mkMerge [
            (lib.mkOrder 550 ''
              [[ -d "$HOME/.zfunc" ]] && fpath+=("$HOME/.zfunc")
              [[ -d "$HOME/.local/share/zsh/site-functions" ]] && fpath=("$HOME/.local/share/zsh/site-functions" $fpath)
            '')
            (lib.mkOrder 1000 ''
              source "${cfg.repoRoot}/config/shell/zshrc"
            '')
          ];
        };
        xdg.configFile."starship.toml" = file "config/shell/starship.toml";
      })

      (lib.mkIf cfg.groups.git {
        xdg.configFile."git/ignore" = file "config/git/ignore";
      })
    ]
  );
}
