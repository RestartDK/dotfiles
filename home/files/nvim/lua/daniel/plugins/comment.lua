return {
  "numToStr/Comment.nvim",
  keys = {
    { "gc", mode = { "n", "x" } },
    { "gb", mode = { "n", "x" } },
    { "gcc", mode = "n" },
    { "gbc", mode = "n" },
    { "gco", mode = "n" },
    { "gcO", mode = "n" },
    { "gcA", mode = "n" },
  },
  dependencies = {
    "JoosepAlviste/nvim-ts-context-commentstring",
  },
  config = function()
    local comment = require("Comment")
    local ts_context_commentstring = require("ts_context_commentstring.integrations.comment_nvim")
    local ts_pre_hook = ts_context_commentstring.create_pre_hook()

    comment.setup({
      pre_hook = function(ctx)
        local commentstring = ts_pre_hook(ctx)

        if commentstring and commentstring ~= "" then
          return commentstring
        end

        commentstring = vim.bo.commentstring

        if commentstring ~= "" then
          return commentstring
        end

        return "# %s"
      end,
    })
  end,
}
