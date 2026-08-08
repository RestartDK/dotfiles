{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.my.darwin.spotlightHotkeys;
  disableSpotlightHotkeys = pkgs.writeShellScript "disable-spotlight-hotkeys" ''
    set -euo pipefail

    tmp_dir=$(/usr/bin/mktemp -d -t disable-spotlight-hotkeys)
    trap '/bin/rm -rf "$tmp_dir"' EXIT
    plist="$tmp_dir/com.apple.symbolichotkeys.plist"

    # Preserve unrelated shortcuts while ensuring plist values have the types
    # expected by macOS. `defaults -dict-add` stores nested values as strings.
    /usr/bin/defaults export com.apple.symbolichotkeys "$plist"

    set_hotkey() {
      local id="$1"
      local modifiers="$2"
      local value="{\"enabled\":false,\"value\":{\"parameters\":[32,49,$modifiers],\"type\":\"standard\"}}"

      /usr/bin/plutil -replace "AppleSymbolicHotKeys.$id" -json "$value" "$plist" 2>/dev/null \
        || /usr/bin/plutil -insert "AppleSymbolicHotKeys.$id" -json "$value" "$plist"
    }

    set_hotkey 64 1048576
    set_hotkey 65 1572864
    /usr/bin/defaults import com.apple.symbolichotkeys "$plist"

    if [[ -x /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings ]]; then
      /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u || true
    fi
  '';
in
{
  options.my.darwin.spotlightHotkeys.enable =
    lib.mkEnableOption "disabling the Spotlight Cmd-Space shortcuts";

  config = lib.mkIf cfg.enable {
    launchd.user.agents.disable-spotlight-hotkeys = {
      command = disableSpotlightHotkeys;
      serviceConfig.RunAtLoad = true;
    };

    system.activationScripts.postActivation.text = ''
      spotlight_user=${lib.escapeShellArg config.system.primaryUser}
      echo >&2 "disabling Spotlight Cmd-Space hotkeys..."
      launchctl asuser "$(id -u -- "$spotlight_user")" \
        sudo --user="$spotlight_user" --set-home -- ${disableSpotlightHotkeys}
      unset spotlight_user
    '';
  };
}
