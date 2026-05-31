return {
  "RestartDK/avante.nvim",
  -- dir = vim.fn.expand("/Users/danielkumlin/Projects/avante.nvim"),
  event = "VeryLazy",
  lazy = false,
  version = false, -- set this if you want to always pull the latest change
  keys = function(_, keys)
    local opts =
      require("lazy.core.plugin").values(require("lazy.core.config").spec.plugins["avante.nvim"], "opts", false)
    local mappings = {
      -- Add Transfer mapping
      {
        opts.mappings.transfer,
        function()
          require("avante.webui").transfer_chat_history()
        end,
        desc = "avante: transfer chat history",
        mode = { "n", "v" },
      },
    }
    mappings = vim.tbl_filter(function(m)
      return m[1] and #m[1] > 0
    end, mappings)
    return vim.list_extend(mappings, keys)
  end,
  opts = {
    provider = "claude",
    mappings = {
      transfer = "<leader>aT", -- transfer mapping
    },
  },
  -- if you want to build from source then do `make BUILD_FROM_SOURCE=true`
  build = "make",
  dependencies = {
    "nvim-treesitter/nvim-treesitter",
    "stevearc/dressing.nvim",
    "nvim-lua/plenary.nvim",
    "MunifTanjim/nui.nvim",
    --- The below dependencies are optional,
    "nvim-tree/nvim-web-devicons", -- or echasnovski/mini.icons
    {
      -- support for image pasting
      "HakonHarnes/img-clip.nvim",
      event = "VeryLazy",
      opts = {
        -- recommended settings
        default = {
          embed_image_as_base64 = false,
          prompt_for_file_name = false,
          drag_and_drop = {
            insert_mode = true,
          },
          -- required for Windows users
          use_absolute_path = true,
        },
      },
    },
    {
      -- Make sure to set this up properly if you have lazy=true
      "Meanderingrogrammer/render-markdown.nvim",
      opts = {
        file_types = { "markdown", "Avante" },
      },
      ft = { "markdown", "Avante" },
    },
  },
}
