return {
  "folke/tokyonight.nvim",
  priority = 1000,
  config = function()
    require("daniel.core.theme").setup()
  end,
}
