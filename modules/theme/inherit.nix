{
  lib,
  osConfig ? null,
  ...
}:

{
  # Home Manager sees the palette the host declared, the same way Stylix copies
  # its system options down. Standalone Home Manager hosts declare it directly.
  config = lib.mkIf (osConfig != null && osConfig ? my.theme) {
    my.theme = {
      active = lib.mkDefault osConfig.my.theme.active;
      stylix.enable = lib.mkDefault osConfig.my.theme.stylix.enable;
    };
  };
}
