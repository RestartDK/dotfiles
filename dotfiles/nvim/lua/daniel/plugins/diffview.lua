return {
  "dlyongemallo/diffview.nvim",
  version = "*",
  cmd = {
    "DiffviewOpen",
    "DiffviewClose",
    "DiffviewToggleFiles",
    "DiffviewFocusFiles",
    "DiffviewFileHistory",
    "DiffviewDiffFiles",
    "DiffviewLog",
  },
  keys = {
    { "<leader>vo", "<cmd>DiffviewOpen<CR>", desc = "Open Diffview" },
    { "<leader>vO", "<cmd>DiffviewOpen origin/main...HEAD<CR>", desc = "Open branch diff vs origin/main" },
    { "<leader>vc", "<cmd>DiffviewClose<CR>", desc = "Close Diffview" },
    { "<leader>vh", "<cmd>DiffviewFileHistory<CR>", desc = "Diffview file history" },
    { "<leader>vf", "<cmd>DiffviewFocusFiles<CR>", desc = "Focus Diffview files" },
    { "<leader>vt", "<cmd>DiffviewToggleFiles<CR>", desc = "Toggle Diffview files" },
  },
  opts = {
    enhanced_diff_hl = true,
    use_icons = true,
    view = {
      default = {
        layout = "diff2_horizontal",
      },
      file_history = {
        layout = "diff2_horizontal",
      },
    },
    file_panel = {
      listing_style = "tree",
      win_config = {
        position = "left",
        width = 35,
      },
    },
  },
}
