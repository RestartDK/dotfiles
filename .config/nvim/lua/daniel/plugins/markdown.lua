return {
  "iamcco/markdown-preview.nvim",
  cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
  build = "cd app && yarn install",
  config = function()
    vim.g.mkdp_filetypes = { "markdown" }
    vim.keymap.set("n", "<leader>Mp", ":MarkdownPreview <CR>", {})
    vim.keymap.set("n", "<leader>Ms", ":MarkdownPreviewStop <CR>", {})
    vim.keymap.set("n", "<leader>Mt", ":MarkdownPreviewToggle <CR>", {})
  end,
  ft = { "markdown" },
}
