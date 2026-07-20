{ pi-coding-agent }:

# Track Pi through nixpkgs' release package instead of building arbitrary
# commits from upstream main. Upstream main can contain generated TypeScript
# whose runtime JSON data is only produced during the networked release build.
pi-coding-agent.overrideAttrs (oldAttrs: {
  postFixup = (oldAttrs.postFixup or "") + ''
    node <<'NODE'
    const fs = require("fs");

    function replace(path, from, to) {
      const before = fs.readFileSync(path, "utf8");
      if (!before.includes(from)) {
        console.error("pattern not found in " + path);
        process.exit(1);
      }
      fs.writeFileSync(path, before.replace(from, to));
    }

    const root = process.env.out + "/lib/node_modules/pi-monorepo";
    const sessionManager = root + "/dist/core/session-manager.js";

    replace(
      sessionManager,
      `export function buildContextEntries(entries, leafId, byId) {`,
      [
        `function stripAssistantUsageForCompactionContext(entry) {`,
        `    if (entry.type !== "message" || entry.message.role !== "assistant") {`,
        `        return entry;`,
        `    }`,
        `    return {`,
        `        ...entry,`,
        `        message: {`,
        `            ...entry.message,`,
        `            usage: {`,
        `                input: 0,`,
        `                output: 0,`,
        `                cacheRead: 0,`,
        `                cacheWrite: 0,`,
        `                totalTokens: 0,`,
        `                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },`,
        `            },`,
        `        },`,
        `    };`,
        `}`,
        `export function buildContextEntries(entries, leafId, byId) {`,
      ].join("\n"),
    );

    replace(
      sessionManager,
      `            contextEntries.push(entry);`,
      `            contextEntries.push(stripAssistantUsageForCompactionContext(entry));`,
    );
    NODE
  '';
})
