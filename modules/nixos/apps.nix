{ pkgs, ... }:

let
  herdr = pkgs.callPackage ../../packages/herdr.nix { };
in
{
  environment.systemPackages = with pkgs; [
    git
    curl
    wget
    vim
    neovim
    zsh
    starship
    tailscale
    openssh
    gnupg

    google-chrome
    spotify
    _1password-cli
    _1password-gui

    docker-compose
    docker-buildx

    pciutils
    usbutils
    htop
    btop
    tree
    jq
    yq
    ripgrep
    fd
    eza
    fzf
    bat
    unzip
    zip
    rsync

    nodejs
    fnm
    bun
    go
    rustup
    python3
    uv
    poetry
    lazygit
  ] ++ [
    herdr
  ];
}
