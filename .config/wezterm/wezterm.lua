-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

-- This is where you actually apply your config choices
config.color_scheme = "kanagawabones"
config.font = wezterm.font("MesloLGL Nerd Font Mono")
config.font_size = 14
config.window_background_opacity = 0.9
config.macos_window_background_blur = 10

config.enable_tab_bar = false

config.window_decorations = "RESIZE"

-- and finally, return the configuration to wezterm
return config
