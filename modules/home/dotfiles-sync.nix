{
  config,
  dotfilesInputs,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.liveConfig;
  traitor = dotfilesInputs.self.packages.${pkgs.stdenv.hostPlatform.system}.traitor;
  traitorExe = lib.getExe' traitor "traitor";
  sync = pkgs.writeShellApplication {
    name = "traitor-sync";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
      pkgs.openssh
    ]
    ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.util-linux ];
    text = ''
      output="$(DOTFILES=${lib.escapeShellArg cfg.repoRoot} ${traitorExe} sync "$@" 2>&1)" || {
        printf '%s\n' "$output" >&2
        if [[ $(uname -s) == Darwin && $output == *conflict* ]]; then
          /usr/bin/osascript -e 'display notification "Run traitor sync to inspect the conflict." with title "Dotfiles sync blocked"' >/dev/null 2>&1 || true
        fi
        exit 1
      }
      printf '%s\n' "$output"
    '';
  };
in
{
  config = lib.mkIf (cfg.enable && cfg.sync.enable) (
    lib.mkMerge [
      {
        home.packages = [ sync ];
      }

      (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
        systemd.user.services.traitor-sync = {
          Unit.Description = "Synchronize the editable dotfiles checkout";
          Service = {
            Type = "oneshot";
            ExecStart = lib.getExe sync;
            WorkingDirectory = cfg.repoRoot;
          };
        };

        systemd.user.timers.traitor-sync = {
          Unit.Description = "Synchronize the editable dotfiles checkout";
          Timer = {
            OnBootSec = "2m";
            OnUnitActiveSec = "${toString cfg.sync.intervalSeconds}s";
            Persistent = true;
          };
          Install.WantedBy = [ "timers.target" ];
        };
      })

      (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
        launchd.agents.traitor-sync = {
          enable = true;
          config = {
            ProgramArguments = [ (lib.getExe sync) ];
            ProcessType = "Background";
            RunAtLoad = true;
            StartInterval = cfg.sync.intervalSeconds;
            WorkingDirectory = cfg.repoRoot;
            StandardOutPath = "${config.home.homeDirectory}/Library/Logs/traitor-sync.log";
            StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/traitor-sync-error.log";
          };
        };
      })
    ]
  );
}
