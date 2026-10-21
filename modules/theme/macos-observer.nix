{
  config,
  lib,
  pkgs,
  ...
}:

let
  # dark-notify appends the current appearance, so this runs `render dark` or
  # `render light`.
  render = "${config.home.homeDirectory}/.config/theme/render";

  darkNotify = "/opt/homebrew/bin/dark-notify";
in
{
  launchd.agents.theme-appearance = {
    enable = true;
    config = {
      ProgramArguments = [
        darkNotify
        "-c"
        render
      ];
      KeepAlive = true;
      RunAtLoad = true;

      # launchd starts an agent with a minimal PATH, so the renderer's
      # `command -v` guards would skip desktoppr and Ghostty without this.
      EnvironmentVariables.PATH = lib.concatStringsSep ":" [
        (lib.makeBinPath [ pkgs.desktoppr ])
        "/Applications/Ghostty.app/Contents/MacOS"
        "/usr/bin"
        "/bin"
        "/usr/sbin"
        "/sbin"
      ];
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/theme-appearance.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/theme-appearance-error.log";
    };
  };
}
