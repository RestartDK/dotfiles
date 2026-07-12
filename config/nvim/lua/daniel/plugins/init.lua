return {
  "nvim-lua/plenary.nvim", -- lua functions that many plugins use
  {
    "christoomey/vim-tmux-navigator",
    lazy = false,
    init = function()
      vim.g.tmux_navigator_no_mappings = 1
    end,
    config = function()
      require("daniel.core.herdr_nav")
    end,
  },
}
