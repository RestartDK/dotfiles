# Pi todos

The `todo` tool owns one structured task plan. A compact widget shows progress above the editor. `/todos` toggles it; `/todos show` and `/todos hide` set visibility; `/todos list` opens the complete list.

Use `replace` with `{ title, items }` to start a plan, `update` with a full item to change one step, `list` to read it, and `clear` to remove it. Items have stable positive integer ids, text, and `pending`, `doing`, `done`, `blocked`, or `skipped` status. Blocked/skipped items require a reason. Optional notes do not select a state. Retrying an update sets the same status rather than toggling it.

Each mutation persists a `dstack-todos` custom session entry before the widget updates. This works when the tool is called directly or inside codemode, where nested tool results are not transcript entries. State and visibility restore from the active branch only. The tool and widget never inject user messages or start another agent turn.

For old sessions without a native snapshot, the extension reads array-shaped `*Todos` keys from `codemode-store` entries. Only `{ step, status }` rows qualify. Exact known statuses and explicit skip/block prefixes are recognized; unfamiliar status prose becomes pending with the original text in notes. It is never guessed as completed. Deleting the selected key clears it. Native snapshots take precedence, including a deliberate clear, so legacy state cannot resurrect a cleared plan.

Dstack uses the tool as its single todo source when available. Generic codemode storage remains for other task state. A fresh Pi session or `/reload` discovers the extension. No host rebuild or planning-mode tool restrictions are required.
