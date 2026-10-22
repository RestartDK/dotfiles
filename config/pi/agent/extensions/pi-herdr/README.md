# pi-herdr

Pi tool for orchestrating Herdr panes, tabs, workspaces, and worktrees.

Interactive sessions name their tab from the first prompt. Title generation runs in the background using `openai/gpt-5.6-luna` with a 15-second deadline. It requires OpenAI API credentials in Pi.

Generated titles use at most four words and 28 characters. Pi saves the title as the session name, restores it on resume, and mirrors manual `/name` changes to Herdr. Headless sessions do not rename tabs. Session shutdown cancels pending title work. If title generation fails, Pi shows a warning and leaves the name unchanged.

`worktree_enter` moves a conversation dedicated to one active task into a plain Git worktree. The model chooses it from the task relationship, including after multi-turn discussion. It is model-only and must be called alone. Coordinators and supporting checkouts use `herdr` with `worktree_create` or `worktree_open`, which never move the current session.

`worktree_enter` creates its worktree in the repository that contains the `cwd` argument, or in the session's working directory when the argument is absent. A target outside a Git work tree fails the tool call before any handoff state is written, so the session stays usable.

`/worktree <branch>` explicitly requests the same handoff from an idle interactive session. A bare name gets a `daniel/` prefix. Both entry points need a saved transcript. The tool result is saved before `pi --fork` starts a successor. The successor keeps the selected model, thinking level, session title, explicit extension arguments, and CLI tool restrictions. It continues the original user task automatically. Only after that continuation starts does the source Pi exit. The source tab and its other panes remain intact.

Handoffs save typed `pi-herdr-worktree-v1` session entries on the active branch. An exclusive reservation under the checkout's Git directory prevents concurrent or replayed launches. Reloading or resuming a source never restarts a handoff. A failed handoff leaves the source usable and adds the failure to both the visible transcript and model context without starting another model turn.

A retry reconciles a completed or stopped reservation only after checking that the previous destination has no agent or running job. Reservation recovery finds the original attempt even after session branch navigation. Unknown ownership still blocks recovery. Readiness decisions and reservation replacement share the same lock, so an old successor cannot acknowledge a replacement attempt. `/worktree-continue` accepts only the designated pending successor and cannot replay a completed continuation.

Handoffs and generic runs share `LaunchAttempt` and `repo-exec`. Preparation runs in the shell that executes the command, inside the selected development network namespace. Environment preparation has a ten-minute deadline; Pi startup gets a separate minute after preparation. Handoffs retain metadata-only receipts under `pi-herdr-handoff-logs/<attempt-id>/` beside the checkout reservation. Provider errors stay in the terminal; pane contents and exports are not copied into logs. Failed or cancelled launches stop only their supervisor-owned process group. Unconfirmed cleanup reports `recoveryRequired` and retains the reservation. Retry requires both a confirmed exit receipt and an unoccupied destination. See [repository command environments](../../../../shell/README.md) for provider configuration, limits, and rerunnable real-Herdr proof.

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

Background command successes and failures use Pi's native message cards. The card keeps the pane and command visible, with the output tail behind the normal expand shortcut.

Tracked command completions carry a receipt. A synchronous wait or read of a confirmed exit consumes the result, so the background observer cannot announce it again. Reading an echoed shell command is not confirmation. A fresh result wakes its originating request once; an older request’s result is recorded without starting another turn. Receipts restore from the active session branch.

This does not make monitoring durable. The existing six-hour observation limit and shutdown behavior remain unchanged.

Requires Pi 0.99.1 or later. Run `/reload` after editing the extension.

`herdr-agent-state.ts` remains a separate Herdr-managed extension at the parent `extensions/` level. It reports Pi lifecycle and session state to Herdr; this package controls Herdr from Pi.
