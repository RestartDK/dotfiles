return {
  "nvim-treesitter/nvim-treesitter",
  branch = "main",
  lazy = false,
  build = ":TSUpdate",
  dependencies = {
    "windwp/nvim-ts-autotag",
  },
  config = function()
    local treesitter = require("nvim-treesitter")

    local parsers = {
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
      "rust",
      "toml",
    }

    treesitter.install(parsers)

    vim.api.nvim_create_autocmd("FileType", {
      group = vim.api.nvim_create_augroup("DanielTreesitter", { clear = true }),
      pattern = {
        "html",
        "css",
        "javascript",
        "javascriptreact",
        "typescript",
        "typescriptreact",
        "markdown",
        "dockerfile",
        "sh",
        "bash",
        "lua",
        "json",
        "python",
        "sql",
        "gitignore",
        "rust",
        "toml",
      },
      callback = function()
        pcall(vim.treesitter.start)
        vim.bo.indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
      end,
    })

    require("nvim-ts-autotag").setup()
  end,
}
