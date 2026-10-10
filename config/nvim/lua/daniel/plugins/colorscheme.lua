return {
  {
    "folke/tokyonight.nvim",
    priority = 1000,
    dependencies = { { "catppuccin/nvim", name = "catppuccin" } },
    config = function()
      require("daniel.core.theme").setup()
    end,
  },
}
