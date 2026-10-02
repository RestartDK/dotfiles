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
      output="$(DOTFILES=${lib.escapeShellArg cfg.sync.checkout} ${traitorExe} sync "$@" 2>&1)" || {
        printf '%s\n' "$output" >&2
        if [[ $(uname -s) == Darwin && $output == *conflict* ]]; then
          /usr/bin/osascript -e 'display notification "Run traitor sync to inspect the conflict." with title "Dotfiles sync blocked"' >/dev/null 2>&1 || true
        elif command -v notify-send >/dev/null 2>&1; then
          notify-send "Dotfiles sync failed" "$output" >/dev/null 2>&1 || true
        fi
        exit 1
      }
      printf '%s\n' "$output"
    '';
  };
in
{
  config = lib.mkIf (cfg.enable && cfg.sync.enable && cfg.sync.checkout != null) (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = lib.mod cfg.sync.intervalSeconds 60 == 0;
            message = "my.liveConfig.sync.intervalSeconds must be a whole number of minutes";
          }
        ];
        home.packages = [ sync ];
      }

      (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
        systemd.user.services.traitor-sync = {
          Unit.Description = "Synchronize the editable dotfiles checkout";
          Service = {
            Type = "oneshot";
            ExecStart = lib.getExe sync;
            WorkingDirectory = cfg.sync.checkout;
          };
        };

        systemd.user.timers.traitor-sync = {
          Unit.Description = "Synchronize the editable dotfiles checkout";
          Timer = {
            OnBootSec = "2m";
            OnCalendar = "*:0/${toString (cfg.sync.intervalSeconds / 60)}";
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
            WorkingDirectory = cfg.sync.checkout;
            StandardOutPath = "${config.home.homeDirectory}/Library/Logs/traitor-sync.log";
            StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/traitor-sync-error.log";
          };
        };
      })
    ]
  );
}
