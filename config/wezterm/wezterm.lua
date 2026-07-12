-- Pull in the wezterm API
local wezterm = require("wezterm")

-- This will hold the configuration.
local config = wezterm.config_builder()

local function scheme_for_appearance(appearance)
  if appearance:find("Dark") then
    return "Tokyo Night"
  end

  return "Tokyo Night Day"
end

-- This is where you actually apply your config choices
config.color_scheme = scheme_for_appearance(wezterm.gui and wezterm.gui.get_appearance() or "Dark")
config.font = wezterm.font("JetBrainsMono Nerd Font Mono")
config.font_size = 14
config.window_background_opacity = 0.9
config.macos_window_background_blur = 10

config.enable_tab_bar = false

config.window_decorations = "RESIZE"

-- and finally, return the configuration to wezterm
return config
