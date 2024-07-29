return {
  "dmmulroy/ts-error-translator.nvim",
  config = function()
    local ts_error_translator = require("ts-error-translator")
    ts_error_translator.setup()
  end,
}
