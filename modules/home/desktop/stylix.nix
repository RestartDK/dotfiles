{
  # Neovim keeps tokyonight.nvim for its curated highlights, Waybar is awaiting a
  # replacement decision, and srv-nana runs no GNOME shell. The GNOME target's
  # `themes/Stylix/gnome-shell/gnome-shell.css` also trips the data file
  # assertion in tests/srv-nana/policy.nix.
  stylix.targets = {
    gnome.enable = false;
    neovim.enable = false;
    waybar.enable = false;
  };
}
