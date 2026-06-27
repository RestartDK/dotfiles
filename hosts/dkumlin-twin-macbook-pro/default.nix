{ pkgs, ... }:

{
  nixpkgs.config.allowUnfree = true;

  # Nix itself is installed/managed by Determinate Nix on this Mac.
  # Keep nix-darwin from replacing that daemon/config during activation.
  nix.enable = false;

  networking.hostName = "dkumlin-twin-macbook-pro";
  networking.localHostName = "dkumlin-twin-macbook-pro";
  networking.computerName = "Daniel’s Twin MacBook Pro";

  system.primaryUser = "danielkumlin";
  users.users.danielkumlin.home = "/Users/danielkumlin";

  programs.zsh.enable = true;

  environment.systemPackages = with pkgs; [
    curl
    git
    vim
  ];

  # This host treats the Homebrew lists below as authoritative. During
  # activation, nix-darwin prunes Homebrew packages not declared here.
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = false;
      upgrade = false;
      cleanup = "uninstall";
    };

    taps = [
      "anomalyco/tap"
      "aws/tap"
      "cormacrelf/tap"
      "getsentry/tools"
      "leoafarias/fvm"
      "oven-sh/bun"
      "steipete/tap"
      "withgraphite/tap"
    ];

    brews = [
      "act"
      "agent-browser"
      "aws/tap/eksctl"
      "awscli"
      "bash"
      "bc"
      "btop"
      "caddy"
      "cloudflared"
      "cmake"
      "cocoapods"
      "coreutils"
      "cormacrelf/tap/dark-notify"
      "deno"
      "dfu-util"
      "dockutil"
      "eza"
      "fastfetch"
      "ffmpeg"
      "flyctl"
      "fnm"
      "fzf"
      "gawk"
      "gh"
      "glab"
      "gnu-sed"
      "go"
      "helm"
      "hf"
      "imagemagick"
      "jq"
      "lazygit"
      "leoafarias/fvm/fvm"
      "llvm"
      "luarocks"
      "mise"
      "neovim"
      "ninja"
      "nmap"
      "nowplaying-cli"
      "openjdk"
      "oven-sh/bun/bun"
      "pandoc"
      "perl"
      "pnpm"
      "poppler"
      "postgresql@16"
      "rbenv"
      "starship"
      "thefuck"
      "tree"
      "tree-sitter-cli"
      "uv"
      "watchman"
      "withgraphite/tap/graphite"
      "yarn"
      "zsh-autosuggestions"
      "zsh-syntax-highlighting"
      "zsh-vi-mode"
    ];

    casks = [
      "1password"
      "1password-cli"
      "betterdisplay"
      "bruno"
      "codex-app"
      "cursor"
      "figma"
      "flutter"
      "font-jetbrains-mono-nerd-font"
      "font-monaspice-nerd-font"
      "font-noto-sans-symbols-2"
      "font-sauce-code-pro-nerd-font"
      "font-source-sans-3"
      "ghostty"
      "hammerspoon"
      "helium-browser"
      "godot"
      "karabiner-elements"
      "linear"
      "obsidian"
      "orbstack"
      "raycast"
      "rustdesk"
      "skim"
      "slack"
      "spotify"
      "tailscale-app"
    ];

    # Installed manually/vendor-managed on this Mac for now. Do not add these
    # to `casks` until intentionally migrating them to Homebrew ownership,
    # otherwise `brew bundle` may try to reinstall over existing .app bundles.
    # Manual apps: affinity-designer, affinity-photo, affinity-publisher,
    # android-studio, chatgpt, discord, google-chrome,
    # nextcloud, nordvpn, ollama-app.
    # Also intentionally unmanaged for now: codexbar, emdash, warp, zulu@17.
  };

  system.defaults.dock = {
    autohide = true;
    orientation = "left";
    show-recents = false;
    tilesize = 51;
  };

  # nix-darwin's built-in Dock persistent-apps currently writes minimal Dock
  # tiles that can show up as question marks on recent macOS. Use dockutil
  # after Homebrew activation so the Dock gets proper LaunchServices entries.
  system.activationScripts.postActivation.text = ''
    runAsUser() {
      launchctl asuser "$(id -u -- danielkumlin)" sudo --user=danielkumlin --set-home -- "$@"
    }

    echo >&2 "disabling Spotlight Cmd-Space hotkeys for Raycast..."
    runAsUser /usr/bin/defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 64 '{ enabled = 0; value = { parameters = (32, 49, 1048576); type = standard; }; }'
    runAsUser /usr/bin/defaults write com.apple.symbolichotkeys AppleSymbolicHotKeys -dict-add 65 '{ enabled = 0; value = { parameters = (32, 49, 1572864); type = standard; }; }'
    if [[ -x /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings ]]; then
      runAsUser /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u || true
    fi

    dockutil=/opt/homebrew/bin/dockutil
    if [[ -x "$dockutil" ]]; then
      echo >&2 "configuring Dock items with dockutil..."
      runAsUser "$dockutil" --remove all --no-restart || true
      for app in \
        "/Applications/Slack.app" \
        "/Applications/Linear.app" \
        "/Applications/Cursor.app" \
        "/Applications/Codex.app" \
        "/Applications/Helium.app" \
        "/Applications/Ghostty.app" \
        "/Applications/Obsidian.app"
      do
        if [[ -e "$app" ]]; then
          runAsUser "$dockutil" --add "$app" --no-restart
        else
          echo >&2 "skipping missing Dock item: $app"
        fi
      done
      killall -qu danielkumlin Dock || true
    else
      echo >&2 "dockutil not found; skipping Dock item configuration"
    fi
  '';

  system.stateVersion = 6;
}
