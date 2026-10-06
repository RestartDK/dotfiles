# pi-herdr

Pi tool for orchestrating Herdr panes, tabs, workspaces, and worktrees.

Interactive sessions name their tab from the first prompt. Title generation runs in the background using `openai-codex/gpt-5.6-luna`, with `openai/gpt-5.6-luna` as the fallback. Each provider has a 15-second deadline. The OpenAI fallback needs separate OpenAI API credentials in Pi.

Generated titles use at most four words and 28 characters. Pi saves the title as the session name, restores it on resume, and mirrors manual `/name` changes to Herdr. Headless sessions do not rename tabs. Session shutdown cancels pending title work. If both providers fail, Pi shows a warning and leaves the name unchanged.

`/worktree <branch>` creates a Git checkout or reuses its registered checkout, opens a plain, flat Herdr workspace, then moves the current Pi session into it. The current transcript is forked (`pi --fork`) so the new session file lives under the worktree's own session directory, then the successor Pi closes the source tab once it is up. A bare name gets a `daniel/` prefix; pass `owner/name` to control the branch. The command needs a saved transcript and only runs in the interactive TUI.

`worktree_create` and `worktree_open` also default to flat workspaces. Only `presentation: "grouped"` uses native Herdr grouping. Flat open reuses a plain workspace by its panes' checkout, without modifying existing grouped workspaces. New checkout paths default to `~/.herdr/worktrees/<repo>/<short-slug>` and must fit within 60 bytes with a slug of at most 13 characters. Choose another explicit short path after a collision.

Flat creation resolves the base, including the default `HEAD`, in the requested checkout rather than the primary checkout. A workspace failure preserves the Git checkout and reports its recovery path. Repeating `/worktree <branch>` adopts that registered checkout instead of trying to create it again. A reused idle workspace gets a fresh shell for the successor. The command refuses a workspace that already has an agent, including the source session. `worktree_remove` remains for native managed workspaces. Flat checkout removal requires an explicit Git worktree removal and a separate workspace close after checking for unsaved work.

The Scatterer pin includes the cwd refresh on pane or tab focus changes. Bare `cd` does not trigger an immediate refresh.

The extension talks directly to Herdr's newline-delimited socket API. Protocol request and response types in `generated/` come from the JSON Schema bundled with the installed Herdr binary; they are not maintained by hand.

```bash
npm install
npm run generate         # refresh after updating Herdr
npm run check-generated # fail when generated types are stale
npm run typecheck
npm test
```

Tracked command completions carry a receipt. A synchronous wait or read of a confirmed exit consumes the result, so the background observer cannot announce it again. Reading an echoed shell command is not confirmation. A fresh result wakes its originating request once; an older request’s result is recorded without starting another turn. Receipts restore from the active session branch.

This does not make monitoring durable. The existing six-hour observation limit and shutdown behavior remain unchanged.

Requires Pi 0.84.2 or later. Run `/reload` after editing the extension.

`herdr-agent-state.ts` remains a separate Herdr-managed extension at the parent `extensions/` level. It reports Pi lifecycle and session state to Herdr; this package controls Herdr from Pi.
