return {
  "stevearc/conform.nvim",
  event = { "BufReadPre", "BufNewFile" },
  config = function()
    local conform = require("conform")

    conform.setup({
      formatters_by_ft = {
        javascript = { "oxfmt" },
        typescript = { "oxfmt" },
        javascriptreact = { "oxfmt" },
        typescriptreact = { "oxfmt" },
        vue = { "oxfmt" },
        css = { "oxfmt" },
        html = { "oxfmt" },
        json = { "oxfmt" },
        markdown = { "oxfmt" },
        nix = { "nixfmt" },
        sh = { "shfmt" },
        toml = { "taplo" },
        htmldjango = { "djlint" },
        lua = { "stylua" },
        python = { "isort", "black" },
        rust = { "rustfmt" },
      },
      format_on_save = {
        lsp_fallback = true,
        async = false,
        timeout_ms = 2500,
      },
    })

    vim.keymap.set({ "n", "v" }, "<leader>mp", function()
      conform.format({
        lsp_fallback = true,
        async = false,
        timeout_ms = 1000,
      })
    end, { desc = "Format file or range (in visual mode)" })
  end,
}
