{ pkgs, ... }:

{
  nixpkgs.config.allowUnfree = true;
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  networking.hostName = "mac-pro";
  networking.localHostName = "Mac-Pro";
  networking.computerName = "Mac Pro";

  system.primaryUser = "danielkumlin";
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
      "agent-browser"
      "anomalyco/tap/opencode"
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
      "rustup"
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
      "zsh-autosuggestions"
      "zsh-syntax-highlighting"
      "zsh-vi-mode"
    ];

    casks = [
      "1password-cli"
      "aerospace"
      "affinity-designer"
      "affinity-photo"
      "affinity-publisher"
      "android-studio"
      "betterdisplay"
      "bruno"
      "chatgpt"
      "codex"
      "codexbar"
      "cursor"
      "discord"
      "emdash"
      "expo-orbit"
      "figma"
      "flutter"
      "font-jetbrains-mono-nerd-font"
      "font-monaspice-nerd-font"
      "font-noto-sans-symbols-2"
      "font-sauce-code-pro-nerd-font"
      "font-source-sans-3"
      "ghostty"
      "godot"
      "google-chrome"
      "karabiner-elements"
      "linear"
      "mactex"
      "nextcloud"
      "nordvpn"
      "notion-calendar"
      "notion-mail"
      "obsidian"
      "ollama-app"
      "orbstack"
      "raycast"
      "rustdesk"
      "skim"
      "slack"
      "spotify"
      "tailscale-app"
      "warp"
      "zulu@17"
    ];
  };

  system.defaults.dock = {
    autohide = true;
    tilesize = 51;
  };

  system.stateVersion = 6;
}
