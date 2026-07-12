-- Minimal Hyprland config for srv-nana.
-- Package/session setup lives in modules/nixos/hyprland.nix; this editable
-- runtime config is linked into ~/.config/hypr by Home Manager.

------------------
---- MONITORS ----
------------------

hl.monitor({
  output = "",
  mode = "preferred",
  position = "auto",
  scale = "auto",
})

---------------------
---- APPLICATIONS ----
---------------------

local terminal = "ghostty"
local fileManager = "thunar"
local menu = "hyprlauncher"
local powerMenu = "wlogout"
local mainMod = "SUPER"

-------------------
---- AUTOSTART ----
-------------------

hl.on("hyprland.start", function()
  -- Ensure DBus/systemd-launched desktop portals inherit the Hyprland
  -- Wayland environment. Without this, GTK file choosers can silently fail
  -- and Chrome downloads with "Ask where to save" may be cancelled.
  hl.exec_cmd("sh -lc 'export XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-Hyprland}; export XDG_SESSION_DESKTOP=${XDG_SESSION_DESKTOP:-hyprland}; export XDG_SESSION_TYPE=${XDG_SESSION_TYPE:-wayland}; export DESKTOP_SESSION=${DESKTOP_SESSION:-hyprland}; dbus-update-activation-environment --systemd DISPLAY WAYLAND_DISPLAY XDG_CURRENT_DESKTOP XDG_SESSION_TYPE XDG_SESSION_DESKTOP DESKTOP_SESSION; systemctl --user restart xdg-desktop-portal-hyprland.service xdg-desktop-portal-gtk.service xdg-desktop-portal.service'")

  hl.exec_cmd("pidof hyprpaper >/dev/null || hyprpaper")
  hl.exec_cmd("pidof hypridle >/dev/null || hypridle")
  hl.exec_cmd("waybar")
  hl.exec_cmd("hyprlauncher -d")
  hl.exec_cmd("nm-applet --indicator")
  hl.exec_cmd("pidof blueman-applet >/dev/null || blueman-applet")
  hl.exec_cmd("systemctl --user start hyprpolkitagent.service")
  hl.exec_cmd("hyprctl setcursor Adwaita 24")
end)

-------------------------------
---- ENVIRONMENT VARIABLES ----
-------------------------------

hl.env("XCURSOR_THEME", "Adwaita")
hl.env("XCURSOR_SIZE", "24")
hl.env("HYPRCURSOR_SIZE", "24")

-- NVIDIA/Wayland hints for the RTX 3080.
hl.env("LIBVA_DRIVER_NAME", "nvidia")
hl.env("__GLX_VENDOR_LIBRARY_NAME", "nvidia")
hl.env("ELECTRON_OZONE_PLATFORM_HINT", "auto")

-----------------------
---- LOOK AND FEEL ----
-----------------------

hl.config({
  general = {
    gaps_in = 4,
    gaps_out = 8,
    border_size = 2,
    layout = "dwindle",
    col = {
      active_border = "rgba(a6a6a6ff)",
      inactive_border = "rgba(3a3a3aaa)",
    },
  },

  decoration = {
    rounding = 8,
    active_opacity = 1.0,
    inactive_opacity = 1.0,
    blur = { enabled = false },
    shadow = { enabled = false },
  },

  animations = {
    enabled = false,
  },

  input = {
    kb_layout = "us",
    kb_variant = "",
    follow_mouse = 1,
    sensitivity = 0,
    touchpad = {
      natural_scroll = true,
    },
  },

  dwindle = {
    preserve_split = true,
  },

  misc = {
    disable_hyprland_logo = true,
    force_default_wallpaper = 0,
  },
})

---------------------
---- KEYBINDINGS ----
---------------------

hl.bind(mainMod .. " + Return", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + Q", hl.dsp.exec_cmd(terminal))
hl.bind(mainMod .. " + C", hl.dsp.window.close())
hl.bind(mainMod .. " + E", hl.dsp.exec_cmd(fileManager))
hl.bind(mainMod .. " + R", hl.dsp.exec_cmd(menu))
hl.bind(mainMod .. " + S", hl.dsp.exec_cmd("~/.config/hypr/scripts/settings-hub"))
hl.bind(mainMod .. " + P", hl.dsp.exec_cmd("hyprpicker -a"))
hl.bind("CTRL + SHIFT + 4", hl.dsp.exec_cmd("~/.config/hypr/scripts/screenshot-area"))
hl.bind(mainMod .. " + SHIFT + N", hl.dsp.exec_cmd("~/.config/hypr/scripts/toggle-hyprsunset"))
hl.bind(mainMod .. " + V", hl.dsp.window.float({ action = "toggle" }))
hl.bind(mainMod .. " + T", hl.dsp.layout("togglesplit"))
hl.bind(mainMod .. " + Escape", hl.dsp.exec_cmd("hyprlock"))
hl.bind("CTRL + ALT + L", hl.dsp.exec_cmd("hyprlock"))
hl.bind(mainMod .. " + SHIFT + Q", hl.dsp.exec_cmd(powerMenu))
hl.bind(mainMod .. " + SHIFT + E", hl.dsp.exec_cmd("hyprshutdown"))

-- Move focus with Super + vim keys or arrow keys.
-- Raw Ctrl+h/j/k/l is intentionally left to terminals/editors.
hl.bind(mainMod .. " + H", hl.dsp.focus({ direction = "left" }))
hl.bind(mainMod .. " + J", hl.dsp.focus({ direction = "down" }))
hl.bind(mainMod .. " + K", hl.dsp.focus({ direction = "up" }))
hl.bind(mainMod .. " + L", hl.dsp.focus({ direction = "right" }))
hl.bind(mainMod .. " + CTRL + H", hl.dsp.focus({ direction = "left" }))
hl.bind(mainMod .. " + CTRL + J", hl.dsp.focus({ direction = "down" }))
hl.bind(mainMod .. " + CTRL + K", hl.dsp.focus({ direction = "up" }))
hl.bind(mainMod .. " + CTRL + L", hl.dsp.focus({ direction = "right" }))
hl.bind(mainMod .. " + left", hl.dsp.focus({ direction = "left" }))
hl.bind(mainMod .. " + right", hl.dsp.focus({ direction = "right" }))
hl.bind(mainMod .. " + up", hl.dsp.focus({ direction = "up" }))
hl.bind(mainMod .. " + down", hl.dsp.focus({ direction = "down" }))

-- Move/rearrange windows with Super + Shift + vim keys.
hl.bind(mainMod .. " + SHIFT + H", hl.dsp.window.move({ direction = "left" }))
hl.bind(mainMod .. " + SHIFT + J", hl.dsp.window.move({ direction = "down" }))
hl.bind(mainMod .. " + SHIFT + K", hl.dsp.window.move({ direction = "up" }))
hl.bind(mainMod .. " + SHIFT + L", hl.dsp.window.move({ direction = "right" }))

-- Move/rearrange windows with Super + Shift + vim keys.
hl.bind(mainMod .. " + SHIFT + H", hl.dsp.window.move({ direction = "left" }))
hl.bind(mainMod .. " + SHIFT + J", hl.dsp.window.move({ direction = "down" }))
hl.bind(mainMod .. " + SHIFT + K", hl.dsp.window.move({ direction = "up" }))
hl.bind(mainMod .. " + SHIFT + L", hl.dsp.window.move({ direction = "right" }))

-- Workspaces: Super + 1..0 switches, Super + Shift + 1..0 moves windows.
for i = 1, 10 do
  local key = i % 10
  hl.bind(mainMod .. " + " .. key, hl.dsp.focus({ workspace = i }))
  hl.bind(mainMod .. " + SHIFT + " .. key, hl.dsp.window.move({ workspace = i }))
end

-- Mouse move/resize with Super + left/right click drag.
hl.bind(mainMod .. " + mouse:272", hl.dsp.window.drag(), { mouse = true })
hl.bind(mainMod .. " + mouse:273", hl.dsp.window.resize(), { mouse = true })

-- Media keys.
hl.bind("XF86AudioRaiseVolume", hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+"), { locked = true, repeating = true })
hl.bind("XF86AudioLowerVolume", hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"), { locked = true, repeating = true })
hl.bind("XF86AudioMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"), { locked = true })
hl.bind("XF86AudioMicMute", hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"), { locked = true })
hl.bind("XF86AudioNext", hl.dsp.exec_cmd("playerctl next"), { locked = true })
hl.bind("XF86AudioPause", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPlay", hl.dsp.exec_cmd("playerctl play-pause"), { locked = true })
hl.bind("XF86AudioPrev", hl.dsp.exec_cmd("playerctl previous"), { locked = true })
