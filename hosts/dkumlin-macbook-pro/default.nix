{ pkgs, ... }:

{
  imports = [ ../../modules/darwin/determinate-nix.nix ];

  nixpkgs.config.allowUnfree = true;

  networking = {
    hostName = "dkumlin-macbook-pro";
    localHostName = "dkumlin-macbook-pro";
    computerName = "Daniel’s MacBook Pro";
  };

  users.users.danielkumlin.home = "/Users/danielkumlin";

  programs.zsh.enable = true;

  environment.systemPackages = with pkgs; [
    curl
    git
    vim
  ];

  # This mirrors the current Mac app/tool inventory but intentionally keeps
  # cleanup disabled until we actually test nix-darwin on the Mac.
  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = false;
      upgrade = false;
      cleanup = "none";
    };

    taps = [
      "anomalyco/tap"
      "aws/tap"
      "cormacrelf/tap"
      "daytonaio/cli"
      "getsentry/tools"
      "leoafarias/fvm"
      "mongodb/brew"
      "nikitabobko/tap"
      "oven-sh/bun"
      "sst/tap"
      "steipete/tap"
      "supabase/tap"
      "withgraphite/tap"
    ];

    brews = [
      "act"
      "aws/tap/eksctl"
      "awscli"
      "azure-cli"
      "bash"
      "bc"
      "btop"
      "caddy"
      "cloudflared"
      "cmake"
      "cocoapods"
      "coreutils"
      "cormacrelf/tap/dark-notify"
      "daytonaio/cli/daytona"
      "deno"
      "dfu-util"
      "eza"
      "fastfetch"
      "fastlane"
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
      "mongodb-atlas-cli"
      "mongodb/brew/mongodb-database-tools"
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
      "spicetify-cli"
      "starship"
      "supabase"
      "thefuck"
      "tree"
      "tree-sitter-cli"
      "uv"
      "watchman"
      "withgraphite/tap/graphite"
      "yarn"
    ];

    casks = [
      "1password-cli"
      "aerospace"
      "betterdisplay"
      "bruno"
      "expo-orbit"
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
      "mactex"
      "orbstack"
      "skim"
    ];

    # Installed manually/vendor-managed on this Mac for now. Do not add these
    # to `casks` until intentionally migrating them to Homebrew ownership,
    # otherwise `brew bundle` may try to reinstall over existing .app bundles.
    # Manual apps: affinity-designer, affinity-photo, affinity-publisher,
    # android-studio, chatgpt, cursor, discord, figma, google-chrome, linear,
    # nextcloud, nordvpn, obsidian, ollama-app, raycast, rustdesk, slack,
    # spotify, tailscale-app.
    # Also intentionally unmanaged for now: codexbar, emdash, warp, zulu@17.
  };

  system = {
    primaryUser = "danielkumlin";
    defaults.dock = {
      autohide = true;
      orientation = "left";
      show-recents = false;
      tilesize = 51;
      persistent-apps = [
        "/Applications/Slack.app"
        "/Applications/Linear.app"
        "/Applications/Helium.app"
        "/Applications/Ghostty.app"
        "/Applications/Obsidian.app"
      ];
      persistent-others = [ ];
    };
    stateVersion = 6;
  };
}
