#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "json-schema-to-typescript";

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const result = spawnSync("herdr", ["api", "schema", "--json"], {
  encoding: "utf8",
  maxBuffer: 8 * 1024 * 1024,
});

if (result.status !== 0) {
  process.stderr.write(result.stderr || "herdr api schema --json failed\n");
  process.exit(result.status ?? 1);
}

const document = JSON.parse(result.stdout);
const selections = [
  ["request", "request.ts"],
  ["success_response", "success-response.ts"],
  ["error_response", "error-response.ts"],
];

function rewriteRefs(value, schemaName) {
  if (Array.isArray(value)) return value.map((item) => rewriteRefs(item, schemaName));
  if (!value || typeof value !== "object") return value;

  const copy = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "$ref" && typeof child === "string") {
      copy[key] = child.replace(`#/schemas/${schemaName}/`, "#/");
    } else {
      copy[key] = rewriteRefs(child, schemaName);
    }
  }
  return copy;
}

let stale = false;
for (const [schemaName, outputName] of selections) {
  const schema = document.schemas?.[schemaName];
  if (!schema) throw new Error(`Herdr schema is missing schemas.${schemaName}`);

  const generated = await compile(rewriteRefs(schema, schemaName), schema.title, {
    bannerComment: [
      "/* eslint-disable */",
      "/**",
      ` * Generated from Herdr protocol ${document.protocol}, schema version ${document.schema_version}.`,
      " * Run `npm run generate` after updating Herdr. Do not edit by hand.",
      " */",
    ].join("\n"),
    style: { printWidth: 120, singleQuote: false, tabWidth: 2, useTabs: false },
  });
  const outputPath = join(here, "generated", outputName);

  if (check) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) {
      console.error(`${outputPath} is stale`);
      stale = true;
    }
  } else {
    await writeFile(outputPath, generated);
    console.log(`generated ${outputPath}`);
  }
}

if (stale) process.exit(1);
