{
  # Neovim keeps tokyonight.nvim for its curated highlights, and Waybar is
  # awaiting a replacement decision.
  stylix.targets = {
    # This host runs Hyprland, and tests/srv-nana/policy.nix rejects the
    # GNOME data files the target adds.
    gnome.enable = false;
    neovim.enable = false;
    waybar.enable = false;
  };
}
