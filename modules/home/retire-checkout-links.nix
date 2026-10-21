{ config, lib, ... }:

let
  # Home Manager removes a stale link only when the new generation has nothing
  # at that path. A directory is never absent, so a target that changes from a
  # directory symlink into a real directory keeps the old link, and linking the
  # new leaves then writes through it into whatever it pointed at. Every
  # directory below used to point into the checkout, so drop the link first and
  # let Home Manager create the directory itself.
  checkoutLinkedDirectories = [
    ".agents/agents"
    ".agents/skills"
    ".claude/skills"
    ".config/amp"
    ".config/ghostty"
    ".config/hypr"
    ".config/nvim"
    ".config/opencode/plugins"
    ".config/sketchybar"
    ".config/waybar"
    ".config/wlogout"
    ".pi/agent/bin"
    ".pi/agent/extensions"
    ".pi/agent/lib"
    ".pi/agent/prompts"
    ".pi/agent/themes"
  ];
in
{
  config = lib.mkIf config.my.liveConfig.enable {
    home.activation.retireCheckoutDirectoryLinks = lib.hm.dag.entryBefore [ "linkGeneration" ] ''
      for relative in ${lib.concatMapStringsSep " " lib.escapeShellArg checkoutLinkedDirectories}; do
        target="$HOME/$relative"
        if [[ -L "$target" ]]; then
          # The link chain runs through the store generation and ends in the
          # checkout, so resolve all of it before deciding.
          linked="$(readlink -f "$target" || true)"
          case "$linked" in
            */.config/dotfiles/*)
              verboseEcho "Retiring checkout directory link $target"
              run rm "$target"
              ;;
          esac
        fi
      done
    '';
  };
}
