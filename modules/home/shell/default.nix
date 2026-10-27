{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  file = source: {
    inherit source;
    force = true;
  };
  repoCommands = pkgs.callPackage ../../../packages/repo-exec { };
  goEnv = {
    GOPATH = "${config.xdg.dataHome}/go";
    GOBIN = config.xdg.binHome;
    GOCACHE = "${config.xdg.cacheHome}/go-build";
  };
in
{
  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      (lib.mkIf (cfg.groups.shell || cfg.groups.agents || cfg.groups.pi) {
        home.packages = [ repoCommands ];
        home.file.".local/bin/repo-exec".source = "${repoCommands}/bin/repo-exec";
        home.file.".local/bin/repo-bash".source = "${repoCommands}/bin/repo-bash";
      })
      (lib.mkIf cfg.groups.shell {
        programs.go = {
          enable = true;
          package = null;
          env = goEnv;
        };
        home.sessionVariables = goEnv;
        programs.direnv = {
          enable = true;
          enableZshIntegration = lib.mkDefault false;
          config = {
            global = {
              hide_env_diff = true;
              warn_timeout = "0s";
              log_filter = "^direnv: (loading|using flake|export )";
            };
            whitelist.prefix = [ "${config.home.homeDirectory}/.herdr/worktrees/" ];
          };
        };
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
              source "${../../../config/shell/repo-env.zsh}"
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
          settings = import ./starship-settings.nix;
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
