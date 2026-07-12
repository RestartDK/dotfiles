return {
  "nvim-lualine/lualine.nvim",
  dependencies = { "nvim-tree/nvim-web-devicons" },
  config = function()
    local lualine = require("lualine")
    local lazy_status = require("lazy.status") -- to configure lazy pending updates count

    local function progress_status()
      if vim.ui.progress_status == nil then
        return ""
      end

      return vim.ui.progress_status()
    end

    lualine.setup({
      options = {
        theme = "auto",
      },
      sections = {
        lualine_x = {
          {
            progress_status,
            cond = function()
              return progress_status() ~= ""
            end,
          },
          {
            lazy_status.updates,
            cond = lazy_status.has_updates,
            color = function()
              local ok, colors = pcall(require, "tokyonight.colors")
              if not ok then
                return nil
              end

              return { fg = colors.setup().orange }
            end,
          },
          { "encoding" },
          { "fileformat" },
          { "filetype" },
        },
      },
    })
  end,
}
