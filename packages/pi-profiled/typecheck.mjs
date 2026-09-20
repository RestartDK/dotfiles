import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const [sdkPath, sourcePath, bunTypesPath] = process.argv.slice(2);
if (!sdkPath || !sourcePath || !bunTypesPath)
  throw new Error("Usage: node typecheck.mjs <pinned Pi SDK> <dotfiles root> <bun-types>");
const sdk = resolve(sdkPath);
const root = resolve(sourcePath);
const require = createRequire(join(sdk, "package.json"));
const directory = mkdtempSync(join(tmpdir(), "pi-policy-types-"));
const config = join(directory, "tsconfig.json");
const declarations = join(directory, "dist/core");
const compilerOptions = {
  strict: true,
  skipLibCheck: true,
  target: "ESNext",
  module: "ESNext",
  moduleResolution: "Bundler",
  baseUrl: sdk,
  typeRoots: [join(sdk, "node_modules/@types")],
  types: ["node", join(resolve(bunTypesPath), "index.d.ts")],
  paths: {
    "@earendil-works/pi-coding-agent": [sdk],
    "@earendil-works/*": [join(sdk, "node_modules/@earendil-works/*")],
    typebox: [join(sdk, "node_modules/typebox")],
  },
};
const projects = [
  {
    compilerOptions: {
      ...compilerOptions,
      declaration: true,
      emitDeclarationOnly: true,
      noEmitOnError: true,
      rootDir: join(root, "config/pi/agent/lib"),
      outDir: declarations,
    },
    include: [join(root, "config/pi/agent/lib/**/*.ts")],
  },
  {
    compilerOptions: {
      ...compilerOptions,
      noEmit: true,
      rootDirs: [root, directory, sdk],
    },
    include: [
      join(root, "config/pi/agent/extensions/pi-no-default-model.ts"),
      join(root, "config/pi/agent/extensions/subagents/**/*.ts"),
      join(root, "config/pi/agent/lib/**/*.ts"),
      join(root, "tests/agent-profiles/**/*.ts"),
      join(root, "tests/pi-profiled/**/*.ts"),
    ],
  },
];
try {
  mkdirSync(declarations, { recursive: true });
  writeFileSync(join(declarations, "dstack-policy.d.ts"), 'export * from "./pi-policy.js";\n');
  for (const project of projects) {
    writeFileSync(config, JSON.stringify(project));
    const result = spawnSync(
      process.execPath,
      [require.resolve("typescript/lib/tsc.js"), "--project", config],
      { stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
