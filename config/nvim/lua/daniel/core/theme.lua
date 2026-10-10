local M = {}

-- Written by theme(1) from the active palette, outside config/nvim so the live
-- checkout stays the only writer of this directory.
local state_path = (vim.env.XDG_DATA_HOME or (vim.env.HOME .. "/.local/share")) .. "/theme/nvim.lua"

local variants = {
  tokyonight = { dark = "night", light = "day" },
  catppuccin = { dark = "mocha", light = "latte" },
}

local function read_state()
  local ok, state = pcall(dofile, state_path)
  if ok and type(state) == "table" and state.family and state.mode then
    return state
  end
  return { family = "tokyo", mode = "dark" }
end

local function plugin_for(family)
  if family == "catppuccin" then
    return "catppuccin"
  end
  return "tokyonight"
end

local function apply(state)
  local plugin = plugin_for(state.family)
  local variant = (variants[plugin] or {})[state.mode] or "night"

  if M.applied_plugin == plugin and M.applied_variant == variant then
    return
  end

  vim.o.background = state.mode == "light" and "light" or "dark"

  if plugin == "catppuccin" then
    require("catppuccin").setup({
      flavour = variant,
      transparent_background = true,
      term_colors = true,
      styles = { sidebars = "transparent", floats = "transparent" },
    })
  else
    require("tokyonight").setup({
      style = variant,
      transparent = true,
      terminal_colors = true,
      on_colors = function(colors)
        colors.bg_gutter = "none"
      end,
      styles = { sidebars = "transparent", floats = "transparent" },
    })
  end

  M.applied_plugin = plugin
  M.applied_variant = variant

  vim.cmd.colorscheme(plugin)
end

-- Re-read on refocus rather than on a timer. theme(1) may have run while Neovim
-- was in the background.
function M.sync()
  apply(read_state())
end

function M.setup()
  M.sync()

  vim.api.nvim_create_autocmd("FocusGained", {
    group = vim.api.nvim_create_augroup("DanielThemeSync", { clear = true }),
    callback = M.sync,
  })
end

return M
