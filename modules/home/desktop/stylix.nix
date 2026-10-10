{
  # Neovim keeps tokyonight.nvim for its curated highlights and Waybar is
  # awaiting a replacement decision. The GNOME target is inert on the system side,
  # which Stylix gates on GNOME or GDM being enabled, but its Home Manager side
  # always writes `themes/Stylix/gnome-shell/gnome-shell.css`, and that basename
  # trips the data file assertion in tests/srv-nana/policy.nix.
  stylix.targets = {
    gnome.enable = false;
    neovim.enable = false;
    waybar.enable = false;
  };
}
