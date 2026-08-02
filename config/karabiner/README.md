# Karabiner configuration

This directory is the source of truth for Daniel's Karabiner-Elements rules. It was migrated from [`RestartDK/karabiner-config`](https://github.com/RestartDK/karabiner-config).

The rules live in `src/index.ts` and use [`karabiner.ts`](https://karabiner.ts.evanliu.dev/). Karabiner owns its runtime configuration at `~/.config/karabiner/karabiner.json`; Home Manager intentionally does not link or manage that file.

## Apply rules

```bash
cd config/karabiner
npm ci
npm run build
```

`npm run build` runs `tsx src/index.ts`. Its `writeToProfile("DK", ...)` call updates the live `DK` profile while preserving Karabiner-managed device and profile state.

Persistent rule changes belong in `src/index.ts`, not in the generated runtime JSON.
