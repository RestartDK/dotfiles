local M = {}

-- Written by theme(1) from the active palette, outside config/nvim so the live
-- checkout stays the only writer of this directory. It names the plugin, the
-- option that selects the variant, and the variant, so this file holds no table
-- of its own.
local state_path = (vim.env.XDG_DATA_HOME or (vim.env.HOME .. "/.local/share")) .. "/theme/nvim.lua"

local function read_state()
  local ok, state = pcall(dofile, state_path)
  if ok and type(state) == "table" and state.plugin and state.option and state.variant then
    return state
  end
  return { plugin = "tokyonight", option = "style", variant = "night", mode = "dark" }
end

local function apply(state)
  if M.applied_plugin == state.plugin and M.applied_variant == state.variant then
    return
  end

  vim.o.background = state.mode == "light" and "light" or "dark"

  local opts = {
    [state.option] = state.variant,
    styles = { sidebars = "transparent", floats = "transparent" },
  }

  -- The two plugins spell transparency and terminal colours differently.
  if state.plugin == "catppuccin" then
    opts.transparent_background = true
    opts.term_colors = true
  else
    opts.transparent = true
    opts.terminal_colors = true
    opts.on_colors = function(colors)
      colors.bg_gutter = "none"
    end
  end

  require(state.plugin).setup(opts)

  M.applied_plugin = state.plugin
  M.applied_variant = state.variant

  vim.cmd.colorscheme(state.plugin)
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
