{ pkgs, ... }:

{
  imports = [
    ../../modules/darwin/determinate-nix.nix
    ../../modules/darwin/spotlight-hotkeys.nix
  ];

  my.darwin.spotlightHotkeys.enable = true;

  nixpkgs.config.allowUnfree = true;

  networking = {
    hostName = "dkumlin-twin-macbook-pro";
    localHostName = "dkumlin-twin-macbook-pro";
    computerName = "Daniel’s Twin MacBook Pro";
  };

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

  system = {
    primaryUser = "danielkumlin";
    defaults.dock = {
      autohide = true;
      orientation = "left";
      persistent-apps = [
        "/Applications/Slack.app"
        "/Applications/Linear.app"
        "/Applications/Helium.app"
        "/Applications/Ghostty.app"
        "/Applications/Obsidian.app"
      ];
      show-recents = false;
      tilesize = 51;
    };

    stateVersion = 6;
  };
}
