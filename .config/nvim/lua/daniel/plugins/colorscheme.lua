return {
  "rebelot/kanagawa.nvim",
  priority = 1000,
  config = function()
    require("kanagawa").setup({
      colors = {
        theme = {
          all = {
            ui = {
              bg_gutter = "none",
            },
          },
        },
      },
      transparent = true,
      terminalColors = true,
      theme = "wave",
    })
    vim.cmd("colorscheme kanagawa")
  end,
}
