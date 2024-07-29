return {
  "nvim-treesitter/nvim-treesitter",
  event = { "BufReadPre", "BufNewFile" },
  build = ":TSUpdate",
  dependencies = {
    "windwp/nvim-ts-autotag",
  },
  config = function()
    require("nvim-ts-autotag").setup({
      sync_install = true,
      ensure_installed = {
        "html",
        "css",
        "javascript",
        "typescript",
        "markdown",
        "markdown_inline",
        "dockerfile",
        "tsx",
        "bash",
        "lua",
        "json",
        "python",
        "sql",
        "gitignore",
      },
    })
  end,
}
