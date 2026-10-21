{
  config,
  lib,
  ...
}:

let
  palette = config.my.theme.palette;

  rgba = role: alpha: "rgba(${lib.removePrefix "#" role}${alpha})";
in
{
  programs.hyprlock = {
    enable = true;

    # Background and input-field colours come from the Stylix Hyprlock target.
    settings = {
      "$font" = config.stylix.fonts.monospace.name;

      general = {
        hide_cursor = false;
        ignore_empty_input = true;
      };

      animations.enabled = false;

      background = {
        monitor = "";
        blur_passes = 2;
        blur_size = 7;
      };

      input-field = {
        monitor = "";
        size = "320, 56";
        outline_thickness = 2;
        placeholder_text = "Password";
        fail_text = "$PAMFAIL";
        rounding = 8;
        fade_on_empty = false;
        dots_spacing = 0.2;
        position = "0, -20";
        halign = "center";
        valign = "center";
      };

      label = [
        {
          monitor = "";
          text = "$TIME";
          font_size = 64;
          font_family = "$font";
          color = rgba palette.foreground "ff";
          position = "0, 120";
          halign = "center";
          valign = "center";
        }
        {
          monitor = "";
          text = ''cmd[update:60000] date +"%A, %d %B %Y"'';
          font_size = 18;
          font_family = "$font";
          color = rgba palette.dark_foreground "ff";
          position = "0, 72";
          halign = "center";
          valign = "center";
        }
      ];
    };
  };
}
