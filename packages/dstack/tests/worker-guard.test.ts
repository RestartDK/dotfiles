import { expect, test } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { allowedPath } from "../src/worker-guard.ts";

test("native worker cannot traverse, follow outside symlinks or alter git and automation metadata", async () => {
  const root = await mkdtemp("/tmp/dg-");
  const checkout = join(root, "checkout");
  await mkdir(checkout);
  await mkdir(join(root, "outside"));
  await writeFile(join(root, "outside/secret"), "fixture only");
  await symlink(join(root, "outside"), join(checkout, "escape"));
  await mkdir(join(checkout, ".github"));
  await symlink(join(checkout, ".github"), join(checkout, "automation"));
  expect(await allowedPath(checkout, "automation/new-workflow")).toBe(false);
  expect(await allowedPath(checkout, "../outside/secret")).toBe(false);
  expect(await allowedPath(checkout, "escape/secret")).toBe(false);
  expect(await allowedPath(checkout, "escape/new-file")).toBe(false);
  for (const path of [
    ".git/config",
    ".pi/extensions/evil.ts",
    ".github/workflows/evil.yml",
    ".gitmodules",
  ])
    expect(await allowedPath(checkout, path)).toBe(false);
  expect(await allowedPath(checkout, "src/new-file.ts")).toBe(true);
});
