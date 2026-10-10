{
  lib,
  ...
}:

let
  inherit (lib.generators) mkLuaInline;

  exec = command: mkLuaInline ''hl.dsp.exec_cmd("${command}")'';

  focus = direction: mkLuaInline ''hl.dsp.focus({ direction = "${direction}" })'';

  moveWindow = direction: mkLuaInline ''hl.dsp.window.move({ direction = "${direction}" })'';

  bind = keys: dispatch: extra: {
    _args = [
      keys
      dispatch
    ]
    ++ lib.optional (extra != null) extra;
  };

  mediaKey =
    keys: command:
    bind keys (exec command) {
      locked = true;
      repeating = true;
    };

  vimDirections = [
    {
      key = "H";
      direction = "left";
    }
    {
      key = "J";
      direction = "down";
    }
    {
      key = "K";
      direction = "up";
    }
    {
      key = "L";
      direction = "right";
    }
  ];

  arrowDirections = [
    "left"
    "down"
    "up"
    "right"
  ];
in
{
  imports = [
    ./hyprlock.nix
    ./hyprpaper.nix
  ];

  # NixOS programs.hyprland owns the package, portals and the session entry,
  # so the Home Manager module only generates the configuration.
  wayland.windowManager.hyprland = {
    enable = true;
    package = null;
    portalPackage = null;
    configType = "lua";

    settings = {
      monitor = [
        {
          output = "";
          mode = "preferred";
          position = "auto";
          scale = "auto";
        }
      ];

      env = [
        {
          _args = [
            "XCURSOR_THEME"
            "Adwaita"
          ];
        }
        {
          _args = [
            "XCURSOR_SIZE"
            "24"
          ];
        }
        {
          _args = [
            "HYPRCURSOR_SIZE"
            "24"
          ];
        }
        {
          _args = [
            "LIBVA_DRIVER_NAME"
            "nvidia"
          ];
        }
        {
          _args = [
            "__GLX_VENDOR_LIBRARY_NAME"
            "nvidia"
          ];
        }
        {
          _args = [
            "ELECTRON_OZONE_PLATFORM_HINT"
            "auto"
          ];
        }
      ];

      # Border, shadow and background colors come from the Stylix Hyprland target.
      config = {
        general = {
          gaps_in = 4;
          gaps_out = 8;
          border_size = 2;
          layout = "dwindle";
        };

        decoration = {
          rounding = 8;
          active_opacity = 1.0;
          inactive_opacity = 1.0;
          blur.enabled = false;
          shadow.enabled = false;
        };

        animations.enabled = false;

        input = {
          kb_layout = "us";
          kb_variant = "";
          follow_mouse = 1;
          sensitivity = 0;
          touchpad.natural_scroll = true;
        };

        dwindle.preserve_split = true;

        misc.force_default_wallpaper = 0;
      };

      on = {
        _args = [
          "hyprland.start"
          (mkLuaInline ''
            function()
              hl.exec_cmd("waybar")
              hl.exec_cmd("hyprlauncher -d")
              hl.exec_cmd("hyprctl setcursor Adwaita 24")
            end
          '')
        ];
      };

      bind = [
        (bind "SUPER + Return" (exec "ghostty") null)
        (bind "SUPER + Q" (exec "ghostty") null)
        (bind "SUPER + C" (mkLuaInline "hl.dsp.window.close()") null)
        (bind "SUPER + E" (exec "thunar") null)
        (bind "SUPER + R" (exec "hyprlauncher") null)
        (bind "SUPER + S" (exec "~/.config/hypr/scripts/settings-hub") null)
        (bind "SUPER + P" (exec "hyprpicker -a") null)
        (bind "CTRL + SHIFT + 4" (exec "~/.config/hypr/scripts/screenshot-area") null)
        (bind "SUPER + SHIFT + N" (exec "~/.config/hypr/scripts/toggle-hyprsunset") null)
        (bind "SUPER + CTRL + T" (exec "theme toggle") null)
        (bind "SUPER + V" (mkLuaInline ''hl.dsp.window.float({ action = "toggle" })'') null)
        (bind "SUPER + T" (mkLuaInline ''hl.dsp.layout("togglesplit")'') null)
        (bind "SUPER + Escape" (exec "hyprlock") null)
        (bind "CTRL + ALT + L" (exec "hyprlock") null)
        (bind "SUPER + SHIFT + Q" (exec "wlogout") null)
        (bind "SUPER + SHIFT + E" (exec "uwsm stop") null)
        (bind "SUPER + mouse:272" (mkLuaInline "hl.dsp.window.drag()") { mouse = true; })
        (bind "SUPER + mouse:273" (mkLuaInline "hl.dsp.window.resize()") { mouse = true; })
        (mediaKey "XF86AudioRaiseVolume" "wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+")
        (mediaKey "XF86AudioLowerVolume" "wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-")
        (mediaKey "XF86AudioMute" "wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle")
        (mediaKey "XF86AudioMicMute" "wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle")
        (mediaKey "XF86AudioNext" "playerctl next")
        (mediaKey "XF86AudioPause" "playerctl play-pause")
        (mediaKey "XF86AudioPlay" "playerctl play-pause")
        (mediaKey "XF86AudioPrev" "playerctl previous")
      ]
      ++ lib.concatMap ({ key, direction }: [
        (bind "SUPER + ${key}" (focus direction) null)
        (bind "SUPER + CTRL + ${key}" (focus direction) null)
        (bind "SUPER + SHIFT + ${key}" (moveWindow direction) null)
      ]) vimDirections
      ++ map (direction: bind "SUPER + ${direction}" (focus direction) null) arrowDirections
      ++ lib.concatMap (workspace: [
        (bind "SUPER + ${toString (lib.mod workspace 10)}"
          (mkLuaInline "hl.dsp.focus({ workspace = ${toString workspace} })")
          null
        )
        (bind "SUPER + SHIFT + ${toString (lib.mod workspace 10)}"
          (mkLuaInline "hl.dsp.window.move({ workspace = ${toString workspace} })")
          null
        )
      ]) (lib.range 1 10);
    };
  };
}
