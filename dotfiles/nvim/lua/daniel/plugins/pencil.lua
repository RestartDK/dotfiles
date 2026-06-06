return {
  "preservim/vim-pencil",
  config = function()
    vim.g["pencil#wrapModeDefault"] = "soft"
    vim.keymap.set("n", "<leader>P", ":Pencil <CR>", {})
  end,
}
