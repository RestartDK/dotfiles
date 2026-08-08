import assert from "node:assert/strict";
import test from "node:test";

import { detectLanguage, indexSource } from "./indexer.ts";

test("detects extensions, special filenames, and overrides", () => {
  assert.equal(detectLanguage("src/main.ts", ""), "typescript");
  assert.equal(detectLanguage("flake.nix", ""), "nix");
  assert.equal(detectLanguage("BUILD.bazel", ""), "starlark");
  assert.equal(detectLanguage("script", "#!/usr/bin/env python3\n"), "python");
  assert.equal(detectLanguage("unknown.file", "", "rs"), "rust");
});

test("indexes TypeScript structures with exact line ranges", () => {
  const source = [
    "import { readFile } from 'node:fs/promises';",
    "export interface Config { value: string; }",
    "export class Runner {",
    "  async run(input: string): Promise<string> { return input; }",
    "}",
    "export function main(args: string[]): number { return args.length; }",
  ].join("\n");

  const result = indexSource("src/main.ts", source);
  assert.equal(result.language, "typescript");
  assert.match(result.text, /imports:/);
  assert.match(result.text, /interface Config.*\[2\]/);
  assert.match(result.text, /class Runner.*\[3-5\]/);
  assert.match(result.text, /run\(input: string\).*\[4\]/);
  assert.match(result.text, /function main\(args: string\[\]\): number.*\[6\]/);
  assert.match(result.text, /Use read with offset\/limit/);
});

test("indexes Rust imports, constants, impl methods, and functions", () => {
  const source = [
    "use std::{fs, io};",
    "pub const MAX: usize = 8;",
    "pub struct Config { pub path: String }",
    "impl Config {",
    "  pub fn new(path: String) -> Self { todo!() }",
    "}",
    "pub fn run(input: &str) -> Result<(), Error> { Ok(()) }",
  ].join("\n");

  const result = indexSource("src/lib.rs", source);
  assert.match(result.text, /use std::\{fs, io\}.*\[1\]/);
  assert.match(result.text, /pub const MAX: usize = 8.*\[2\]/);
  assert.match(result.text, /struct Config.*\[3\]/);
  assert.match(result.text, /impl Config.*\[4-6\]/);
  assert.match(result.text, /new\(path: String\).*\[5\]/);
  assert.match(result.text, /pub fn run\(input: &str\).*\[7\]/);
});

test("uses Tree-sitter headings to map Markdown sections", () => {
  const source = ["# First", "intro", "## Child", "details", "# Second", "ending"].join("\n");

  const result = indexSource("README.md", source);
  assert.equal(result.language, "markdown");
  assert.match(result.text, /# First \[1-4\]/);
  assert.match(result.text, /## Child \[3-4\]/);
  assert.match(result.text, /# Second \[5-6\]/);
});

test("maps top-level Nix module bindings without dumping nested bodies", () => {
  const source = [
    "{ config, lib, pkgs, ... }:",
    "let",
    "  foo = 1;",
    "  helper = x: x + 1;",
    "in",
    "{",
    '  options.test.enable = lib.mkEnableOption "test";',
    "  config = lib.mkIf config.test.enable { environment.systemPackages = [ pkgs.git ]; };",
    "}",
  ].join("\n");

  const result = indexSource("module.nix", source);
  assert.equal(result.language, "nix");
  assert.match(result.text, /module \{ config, lib, pkgs, \.\.\. \} \[1-9\]/);
  assert.match(result.text, /helper = x:.*\[4\]/);
  assert.match(result.text, /options\.test\.enable.*\[7\]/);
  assert.match(result.text, /config.*\[8\]/);
  assert.doesNotMatch(result.text, /environment\.systemPackages/);
});
