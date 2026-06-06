return {
  "RestartDK/ghostty-navigator.nvim",
  lazy = false,
  init = function()
    if vim.env.TERM_PROGRAM == "ghostty" or vim.env.TERM == "xterm-ghostty" or vim.env.GHOSTTY_RESOURCES_DIR then
      vim.g.tmux_navigator_no_mappings = 1
    end
  end,
  opts = {
    auto_activate = true,
  },
  config = function(_, opts)
    require("ghostty-navigator").setup(opts)
  end,
}
