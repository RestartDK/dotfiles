return {
  "neovim/nvim-lspconfig",
  event = { "BufReadPre", "BufNewFile" },
  dependencies = {
    "hrsh7th/cmp-nvim-lsp",
    { "antosha417/nvim-lsp-file-operations", config = true },
    { "folke/neodev.nvim", opts = {} },
  },
  config = function()
    -- import cmp-nvim-lsp plugin
    local cmp_nvim_lsp = require("cmp_nvim_lsp")

    local keymap = vim.keymap -- for conciseness

    vim.api.nvim_create_autocmd("LspAttach", {
      group = vim.api.nvim_create_augroup("UserLspConfig", {}),
      callback = function(ev)
        -- Buffer local mappings.
        -- See `:help vim.lsp.*` for documentation on any of the below functions
        local opts = { buffer = ev.buf, silent = true }

        -- set keybinds
        opts.desc = "Show LSP references"
        keymap.set("n", "gR", "<cmd>Telescope lsp_references<CR>", opts) -- show definition, references

        opts.desc = "Go to declaration"
        keymap.set("n", "gD", vim.lsp.buf.declaration, opts) -- go to declaration

        opts.desc = "Show LSP definitions"
        keymap.set("n", "gd", "<cmd>Telescope lsp_definitions<CR>", opts) -- show lsp definitions

        opts.desc = "Show LSP implementations"
        keymap.set("n", "gi", "<cmd>Telescope lsp_implementations<CR>", opts) -- show lsp implementations

        opts.desc = "Show LSP type definitions"
        keymap.set("n", "gt", "<cmd>Telescope lsp_type_definitions<CR>", opts) -- show lsp type definitions

        opts.desc = "See available code actions"
        keymap.set({ "n", "v" }, "<leader>ca", vim.lsp.buf.code_action, opts) -- see available code actions, in visual mode will apply to selection

        opts.desc = "Smart rename"
        keymap.set("n", "<leader>rn", vim.lsp.buf.rename, opts) -- smart rename

        opts.desc = "Show buffer diagnostics"
        keymap.set("n", "<leader>D", "<cmd>Telescope diagnostics bufnr=0<CR>", opts) -- show  diagnostics for file

        opts.desc = "Show line diagnostics"
        keymap.set("n", "<leader>d", vim.diagnostic.open_float, opts) -- show diagnostics for line

        opts.desc = "Go to previous diagnostic"
        keymap.set("n", "[d", vim.diagnostic.goto_prev, opts) -- jump to previous diagnostic in buffer

        opts.desc = "Go to next diagnostic"
        keymap.set("n", "]d", vim.diagnostic.goto_next, opts) -- jump to next diagnostic in buffer

        opts.desc = "Show diagnostics or documentation for what is under cursor"
        keymap.set("n", "K", function()
          local cursor_diagnostics = vim.diagnostic.get(ev.buf, { lnum = vim.fn.line(".") - 1 })
          if #cursor_diagnostics > 0 then
            vim.diagnostic.open_float(nil, {
              border = "rounded",
              focus = false,
              scope = "cursor",
            })
          else
            vim.lsp.buf.hover({ border = "rounded" })
          end
        end, opts)

        opts.desc = "Restart LSP"
        keymap.set("n", "<leader>rs", ":LspRestart<CR>", opts) -- mapping to restart lsp if necessary
      end,
    })

    -- used to enable autocompletion (assign to every lsp server config)
    local capabilities = cmp_nvim_lsp.default_capabilities()

    vim.diagnostic.config({
      float = {
        border = "rounded",
        source = "if_many",
      },
    })

    -- Change the Diagnostic symbols in the sign column (gutter)
    -- (not in youtube nvim video)
    local signs = { Error = " ", Warn = " ", Hint = "󰠠 ", Info = " " }
    for type, icon in pairs(signs) do
      local hl = "DiagnosticSign" .. type
      vim.fn.sign_define(hl, { text = icon, texthl = hl, numhl = "" })
    end

    -- helper function to find the python path for the lsp
    local function find_python()
      -- Check for activated virtual environment first
      if vim.env.VIRTUAL_ENV then
        local path = vim.fs.joinpath(vim.env.VIRTUAL_ENV, "bin", "python")
        return path
      end

      -- -- Check for Poetry environment
      -- local poetry_env = vim.fn.trim(vim.fn.system("poetry env info -p 2>/dev/null"))
      -- if vim.v.shell_error == 0 and poetry_env ~= "" then
      --   local path = vim.fs.joinpath(poetry_env, "bin", "python")
      --   return path
      -- end

      -- Check for .venv in the current directory or parent directories
      local venv = vim.fs.find(".venv", {
        upward = true,
        type = "directory",
        path = vim.fn.getcwd(),
      })[1]
      if venv then
        local path = vim.fs.joinpath(venv, "bin", "python")
        return path
      end

      -- Fallback to system Python
      local path = vim.fn.exepath("python3") or vim.fn.exepath("python") or "python"
      return path
    end

    local servers = {
      "ts_ls",
      "html",
      "cssls",
      "tailwindcss",
      "lua_ls",
      "emmet_ls",
      "clangd",
      "pyright",
      "vue_ls",
      "texlab",
      "yamlls",
      "gopls",
      "rust_analyzer",
    }

    for _, server_name in ipairs(servers) do
      if server_name == "pyright" then
        -- configure python language server for different virtual envs with poetry
        vim.lsp.config("pyright", {
          capabilities = capabilities,
          before_init = function(_, config)
            local python_path = find_python()
            config.settings.python.pythonPath = python_path
          end,
          settings = {
            python = {
              analysis = {
                autoSearchPaths = true,
                diagnosticMode = "workspace",
                typeCheckingMode = "basic",
                useLibraryCodeForTypes = true,
                disableOrganizeImports = true,
              },
            },
          },
        })
      elseif server_name == "emmet_ls" then
        vim.lsp.config("emmet_ls", {
          capabilities = capabilities,
          filetypes = { "html", "typescriptreact", "javascriptreact", "css" },
        })
      elseif server_name == "yamlls" then
        vim.lsp.config("yamlls", {
          capabilities = capabilities,
          on_attach = function(client, _)
            client.server_capabilities.documentFormattingProvider = true
          end,
        })
      elseif server_name == "lua_ls" then
        vim.lsp.config("lua_ls", {
          capabilities = capabilities,
          settings = {
            Lua = {
              diagnostics = {
                globals = { "vim" },
              },
              completion = {
                callSnippet = "Replace",
              },
            },
          },
        })
      elseif server_name == "rust_analyzer" then
        vim.lsp.config("rust_analyzer", {
          capabilities = capabilities,
          settings = {
            ["rust-analyzer"] = {
              cargo = {
                allFeatures = true,
              },
              check = {
                command = "clippy",
              },
            },
          },
        })
      else
        vim.lsp.config(server_name, {
          capabilities = capabilities,
        })
      end

      vim.lsp.enable(server_name)
    end

    vim.lsp.enable({ "bicep", "stylua", "golangci_lint_ls" }, false)
  end,
}
