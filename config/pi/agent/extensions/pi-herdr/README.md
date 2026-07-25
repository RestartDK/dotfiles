# pi-herdr

Pi tool for orchestrating Herdr panes, tabs, workspaces, and worktrees.

The extension talks directly to Herdr's newline-delimited socket API. Protocol request and response types in `generated/` come from the JSON Schema bundled with the installed Herdr binary; they are not maintained by hand.

```bash
npm install
npm run generate         # refresh after updating Herdr
npm run check-generated # fail when generated types are stale
npm run typecheck
```

`herdr-agent-state.ts` remains a separate Herdr-managed extension at the parent `extensions/` level. It reports Pi lifecycle and session state to Herdr; this package controls Herdr from Pi.
