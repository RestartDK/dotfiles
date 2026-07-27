vim.cmd("let g:netrw_liststyle = 3")
local opt = vim.opt -- for conciseness

-- line numbers
opt.relativenumber = true
opt.number = true

-- tabs & indendation
opt.tabstop = 2
opt.shiftwidth = 2
opt.expandtab = true
opt.autoindent = true

-- line wrapping
opt.wrap = false

-- search settings
opt.ignorecase = true
opt.smartcase = true

-- cursor line
opt.cursorline = true

-- appearance
opt.termguicolors = true
opt.signcolumn = "yes"

-- Native Neovim 0.12 command-line/message UI replacement for noice.nvim.
-- This is still an experimental/internal API, so keep it guarded.
if vim.fn.has("nvim-0.12") == 1 then
  local ok, ui2 = pcall(require, "vim._core.ui2")
  if ok then
    ui2.enable()
  end

  opt.winborder = "rounded"

  if not vim.tbl_contains(opt.completeopt:get(), "popup") then
    opt.completeopt:append("popup")
  end
end

if vim.fn.has("gui_running") == 1 or vim.g.neovide then
  opt.guifont = "JetBrainsMono Nerd Font Mono:h14"
end

-- backspace
opt.backspace = "indent,eol,start"

-- clipboard
opt.clipboard:append("unnamedplus")

local homebrew_python = "/opt/homebrew/opt/python@3.14/bin/python3.14"
if vim.fn.executable(homebrew_python) == 1 then
  vim.g.python3_host_prog = homebrew_python
else
  local python3 = vim.fn.exepath("python3")
  if python3 ~= "" then
    vim.g.python3_host_prog = python3
  end
end

-- split windows
opt.splitright = true
opt.splitbelow = true
