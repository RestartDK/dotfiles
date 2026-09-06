# pi-herdr

Pi tool for orchestrating Herdr panes, tabs, workspaces, and worktrees.

Interactive sessions name their tab from the first prompt. Title generation runs in the background using `openai-codex/gpt-5.6-luna`, with `openai/gpt-5.6-luna` as the fallback. Each provider has a 15-second deadline. The OpenAI fallback needs separate OpenAI API credentials in Pi.

Generated titles use at most four words and 28 characters. Pi saves the title as the session name, restores it on resume, and mirrors manual `/name` changes to Herdr. Headless sessions do not rename tabs. Session shutdown cancels pending title work. If both providers fail, Pi shows a warning and leaves the name unchanged.

The extension talks directly to Herdr's newline-delimited socket API. Protocol request and response types in `generated/` come from the JSON Schema bundled with the installed Herdr binary; they are not maintained by hand.

```bash
npm install
npm run generate         # refresh after updating Herdr
npm run check-generated # fail when generated types are stale
npm run typecheck
npm test
```

Requires Pi 0.84.2 or later. Run `/reload` after editing the extension.

`herdr-agent-state.ts` remains a separate Herdr-managed extension at the parent `extensions/` level. It reports Pi lifecycle and session state to Herdr; this package controls Herdr from Pi.
