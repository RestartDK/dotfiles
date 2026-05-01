local M = {}

local function detect_background()
  if vim.uv.os_uname().sysname ~= "Darwin" then
    return vim.o.background == "light" and "light" or "dark"
  end

  local result = vim.system({ "defaults", "read", "-g", "AppleInterfaceStyle" }, { text = true }):wait()
  if result.code == 0 and result.stdout and result.stdout:match("Dark") then
    return "dark"
  end

  return "light"
end

local function apply_tokyonight(background)
  local style = background == "light" and "day" or "night"

  if M.current_style == style and vim.o.background == background then
    return
  end

  vim.o.background = background
  M.current_style = style

  require("tokyonight").setup({
    style = style,
    light_style = "day",
    transparent = true,
    terminal_colors = true,
    on_colors = function(colors)
      colors.bg_gutter = "none"
    end,
    styles = {
      sidebars = "transparent",
      floats = "transparent",
    },
  })

  vim.cmd.colorscheme("tokyonight")
end

function M.sync_with_macos()
  apply_tokyonight(detect_background())
end

function M.setup()
  M.sync_with_macos()

  vim.api.nvim_create_autocmd("FocusGained", {
    group = vim.api.nvim_create_augroup("DanielThemeSync", { clear = true }),
    callback = M.sync_with_macos,
  })

  if vim.uv.os_uname().sysname ~= "Darwin" or M.timer then
    return
  end

  M.timer = vim.uv.new_timer()
  M.timer:start(
    0,
    2000,
    vim.schedule_wrap(function()
      M.sync_with_macos()
    end)
  )

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = vim.api.nvim_create_augroup("DanielThemeCleanup", { clear = true }),
    callback = function()
      if not M.timer then
        return
      end

      M.timer:stop()
      M.timer:close()
      M.timer = nil
    end,
  })
end

return M
