# pi-herdr

Pi tool for orchestrating Herdr panes, tabs, workspaces, and worktrees.

Interactive sessions name their tab from the first prompt. Title generation runs in the background using `openai/gpt-5.6-luna` with a 15-second deadline. It requires OpenAI API credentials in Pi.

Generated titles use at most four words and 28 characters. Pi saves the title as the session name, restores it on resume, and mirrors manual `/name` changes to Herdr. Headless sessions do not rename tabs. Session shutdown cancels pending title work. If title generation fails, Pi shows a warning and leaves the name unchanged.

`worktree_enter` moves a conversation dedicated to one active task into a plain Git worktree. The model chooses it from the task relationship, including after multi-turn discussion. It is model-only and must be called alone. Coordinators and supporting checkouts use `herdr` with `worktree_create` or `worktree_open`, which never move the current session.

`/worktree <branch>` explicitly requests the same handoff from an idle interactive session. A bare name gets a `daniel/` prefix. Both entry points need a saved transcript. The tool result is saved before `pi --fork` starts a successor. The successor keeps the selected model, thinking level, session title, explicit extension arguments, and CLI tool restrictions. It continues the original user task automatically. Only after that continuation starts does the source Pi exit. The source tab and its other panes remain intact.

Handoffs save typed `pi-herdr-worktree-v1` session entries on the active branch. An exclusive reservation under the checkout's Git directory prevents concurrent or replayed launches. Reloading or resuming a source never restarts a handoff. A failed handoff keeps the source alive and reports the destination or failure. Inspect the reported pane and reservation's `owner` file before recovery. A completed reservation is reconciled when no destination agent remains. Failures before launch input release their own reservation. Uncertain launches retain theirs and require inspection before recovery. Use `/tree` or `/new` to recover in the source. `/worktree-continue` accepts only the designated pending successor and cannot replay a completed continuation.

`worktree_create` and `worktree_open` add the Git checkout themselves and open a plain workspace at its path. `grouped: true` opts into Herdr's native worktree grouping. Plain open reuses a workspace by its panes' checkout, without modifying existing grouped workspaces. New paths default to `~/.herdr/worktrees/<repo>/<short-slug>` and must fit within 60 bytes with a slug of at most 13 characters. Choose another explicit short path after a collision.

Checkout creation resolves the base, including default `HEAD`, in the requested checkout rather than the primary checkout. Workspace failures preserve the checkout. Handoff reuses registered checkouts but refuses existing destination agents, including in grouped workspaces. A reused workspace gets a fresh successor tab rather than input into an existing shell. `worktree_remove` remains for native managed workspaces. Plain checkout removal requires explicit Git worktree removal and a separate workspace close after checking for unsaved work.

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

Requires Pi 0.99.1 or later. Run `/reload` after editing the extension.

`herdr-agent-state.ts` remains a separate Herdr-managed extension at the parent `extensions/` level. It reports Pi lifecycle and session state to Herdr; this package controls Herdr from Pi.
