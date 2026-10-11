{
  config,
  lib,
  pkgs,
  ...
}:

let
  # The renderer's CLI, which is the live-linked script rather than a wrapper.
  render = "${config.home.homeDirectory}/.config/theme/render";

  # macOS rewrites .GlobalPreferences.plist when Appearance changes, so this is
  # an event and not a poll.
  observer = pkgs.writeShellApplication {
    name = "theme-macos-observer";
    text = ''
      if [ "$(/usr/bin/defaults read -g AppleInterfaceStyle 2>/dev/null)" = Dark ]; then
        exec "${render}" dark
      fi
      exec "${render}" light
    '';
  };
in
{
  # Imported only by the macOS hosts. Replaces the Hammerspoon observer that
  # 914e6d7-era config used, since #309 removed Hammerspoon entirely.
  launchd.agents.theme-appearance = {
    enable = true;
    config = {
      ProgramArguments = [ (lib.getExe observer) ];
      WatchPaths = [ "${config.home.homeDirectory}/Library/Preferences/.GlobalPreferences.plist" ];
      RunAtLoad = true;
      StandardOutPath = "${config.home.homeDirectory}/Library/Logs/theme-appearance.log";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/theme-appearance-error.log";
    };
  };
}
