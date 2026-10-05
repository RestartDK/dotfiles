{ config, lib, ... }:

let
  cfg = config.my.liveConfig;
  file = source: {
    inherit source;
    force = true;
  };
  goEnv = {
    GOPATH = "${config.xdg.dataHome}/go";
    GOBIN = config.xdg.binHome;
    GOCACHE = "${config.xdg.cacheHome}/go-build";
  };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf cfg.groups.shell {
        programs.go = {
          enable = true;
          package = null;
          env = goEnv;
        };
        home.sessionVariables = goEnv;
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
              source "${../../../config/shell/zshrc}"
            '')
            (lib.mkOrder 1001 ''
              source "${../../../config/shell/agent-refresh.zsh}"
            '')
            (lib.mkOrder 1100 ''
              [[ -r "$HOME/.config/zsh/local.zsh" ]] && source "$HOME/.config/zsh/local.zsh"
            '')
          ];
        };
        programs.starship = {
          enable = true;
          # The live zshrc runs `starship init zsh` itself.
          enableZshIntegration = false;
          settings = builtins.fromTOML (builtins.readFile ../../../config/shell/starship.toml);
        };
        xdg = {
          localBinInPath = true;
        };
      })

      (lib.mkIf cfg.groups.git {
        xdg.configFile."git/ignore" = file ../../../config/git/ignore;
      })
    ]
  );
}
