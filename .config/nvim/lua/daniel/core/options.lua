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

if vim.fn.has("gui_running") == 1 or vim.g.neovide then
  opt.guifont = "JetBrainsMono Nerd Font Mono:h14"
end

-- backspace
opt.backspace = "indent,eol,start"

-- clipboard
opt.clipboard:append("unnamedplus")

-- Concealer for obsidian
vim.o.conceallevel = 2

vim.g.python3_host_prog = "/opt/homebrew/opt/python@3.14/bin/python3.14"

-- split windows
opt.splitright = true
opt.splitbelow = true
