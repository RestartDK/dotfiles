import { afterAll, afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import cachedModels from "./cached-models";

setDefaultTimeout(60000);

const binary = process.env.PI_POLICY_TEST_BINARY;
const profiles = process.env.PI_POLICY_TEST_PROFILES;
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64url")}.fixture`;
if (!binary || !profiles)
  throw new Error("CLI checks require the rebuilt binary and committed profiles");
let directory: string;
let calls = 0;
const trap = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch() {
    calls++;
    return new Response("Unexpected transport call", { status: 500 });
  },
});
const flags = [
  "--offline",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
  "--no-session",
];
const policyPath = () => join(directory, "config/dstack/models.json");
function profile(name: "personal" | "work") {
  writeFileSync(policyPath(), readFileSync(join(profiles ?? "", `${name}.json`)));
}
function cacheModels() {
  writeFileSync(
    join(directory, "agent/models-store.json"),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(cachedModels).map(([provider, models]) => [
          provider,
          { models, checkedAt: Date.now(), lastModified: Date.now() },
        ]),
      ),
    ),
  );
}
function configureAuth() {
  writeFileSync(
    join(directory, "agent/auth.json"),
    JSON.stringify({
      fireworks: { type: "api_key", key: "fixture" },
      openrouter: { type: "api_key", key: "fixture" },
      "openai-codex": {
        type: "oauth",
        access: token,
        refresh: "fixture",
        expires: Date.now() + 60 * 60 * 1000,
        accountId: "fixture",
      },
    }),
  );
}
const glmReference = "openrouter/z-ai/glm-5.3-flash";
async function run(args: string[], input = "", executable = binary) {
  if (!executable) throw new Error("Missing binary");
  const child = Bun.spawn({
    cmd: [executable, ...flags, ...args],
    cwd: directory,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      PI_CODING_AGENT_DIR: join(directory, "agent"),
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      PI_MODEL: "gpt-5.6-sol",
      PI_PROVIDER: "openai-codex",
      TERM: "dumb",
    },
  });
  child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, status };
}
async function state(args: string[] = [], executable = binary) {
  const result = await run(
    ["--mode", "rpc", ...args],
    '{"id":"fixture","type":"get_state"}\n',
    executable,
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('"provider"');
  return result.stdout;
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "pi-policy-cli-"));
  mkdirSync(join(directory, "config/dstack"), { recursive: true });
  mkdirSync(join(directory, "agent"));
  cacheModels();
  profile("personal");
  calls = 0;
});
afterEach(() => {
  try {
    expect(calls).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
afterAll(() => trap.stop(true));

test.each(["personal", "work"] as const)(
  "rebuilt binary uses %s parent default without extensions or auth",
  async (name) => {
    profile(name);
    const output = await state();
    expect(output).toContain(`"provider":"${name === "work" ? "openai-codex" : "openrouter"}"`);
    expect(output).toContain(
      `"id":"${name === "work" ? "gpt-6-astra" : "deepseek/deepseek-v4.1-flash"}"`,
    );
    expect(output).toContain(`"thinkingLevel":"${name === "work" ? "xhigh" : "max"}"`);
    expect(await state(["--thinking", "high"])).toContain('"thinkingLevel":"high"');
  },
);

test("cached parent selections retain compatible session-local effort overrides", async () => {
  profile("work");
  configureAuth();
  expect(await state(["--model", `${glmReference}:xhigh`])).toContain('"thinkingLevel":"max"');
  expect(await state(["--model", glmReference, "--thinking", "high"])).toContain(
    '"thinkingLevel":"high"',
  );
});

test.each(["missing", "malformed", "bad-parent"])(
  "%s policy cannot be bypassed with --no-extensions",
  async (mode) => {
    if (mode === "missing") rmSync(policyPath());
    else if (mode === "malformed") writeFileSync(policyPath(), "{");
    else
      writeFileSync(
        policyPath(),
        readFileSync(policyPath(), "utf8").replace(
          '"parent": "deepseek"',
          '"parent": "how-critics"',
        ),
      );
    const result = await run(["-p", "denied"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AI dispatch blocked");
  },
);

test("CLI provider/model substitution and denied native selections fail closed", async () => {
  writeFileSync(
    join(directory, "agent/models.json"),
    JSON.stringify({
      providers: {
        "openai-codex": { baseUrl: `${trap.url.origin}/codex`, apiKey: token },
        openrouter: { baseUrl: `${trap.url.origin}/openrouter`, apiKey: "fixture" },
      },
    }),
  );
  for (const args of [
    ["--model", "openai-codex/gpt-6-astra"],
    ["--model", "openrouter/deepseek/deepseek-v4.1-flash"],
    ["--provider", "openai", "--model", "gpt-6-astra"],
    ["--provider", "openai-codex"],
    ["--model", ""],
  ]) {
    const result = await run([...args, "-p", "denied"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("AI policy");
  }
});

test("an explicitly empty CLI model never becomes the profile default", async () => {
  const result = await run(["--model", "", "--mode", "rpc"], '{"type":"get_state"}\n');
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("AI policy");
});

test("a compatible parent override does not require the catalog to support the unused default effort", async () => {
  profile("work");
  writeFileSync(
    join(directory, "agent/models.json"),
    JSON.stringify({
      providers: {
        "openai-codex": {
          modelOverrides: { "gpt-6-astra": { thinkingLevelMap: { xhigh: null, max: null } } },
        },
      },
    }),
  );
  const implicit = await run(["--mode", "rpc"], '{"type":"get_state"}\n');
  expect(implicit.status).not.toBe(0);
  expect(implicit.stderr).toContain("effort downgrade");
  expect(await state(["--thinking", "high"])).toContain('"thinkingLevel":"high"');
});

test("signed binary reauthorizes native HTTP retries after policy revocation", async () => {
  profile("work");
  configureAuth();
  writeFileSync(
    join(directory, "agent/settings.json"),
    JSON.stringify({ transport: "sse", retry: { enabled: false, provider: { maxRetries: 1 } } }),
  );
  const attemptsPath = join(directory, "attempts.json");
  const extensionPath = join(directory, "transport-fixture.ts");
  const revokedPolicy = readFileSync(join(profiles ?? "", "personal.json"), "utf8");
  writeFileSync(
    extensionPath,
    `
import { writeFileSync } from "node:fs";
export default function () {
  let attempts = 0;
  globalThis.WebSocket = new Proxy(globalThis.WebSocket, { construct() { throw new Error("Unexpected fixture WebSocket"); } });
  globalThis.fetch = Object.assign(async () => {
    writeFileSync(${JSON.stringify(attemptsPath)}, JSON.stringify(++attempts));
    writeFileSync(${JSON.stringify(policyPath())}, ${JSON.stringify(revokedPolicy)});
    return new Response(JSON.stringify({ error: { type: "rate_limit_error", message: "fixture retry" } }), {
      status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  }, { preconnect: globalThis.fetch.preconnect });
}
`,
  );
  const result = await run([
    "-e",
    extensionPath,
    "--model",
    "openai-codex/gpt-6-astra",
    "--mode",
    "json",
    "-p",
    "fixture",
  ]);
  expect(result.stderr).toBe("");
  expect(readFileSync(attemptsPath, "utf8")).toBe("1");
  expect(result.stdout).toContain('"stopReason":"error"');
  expect(result.stdout).toContain("AI policy profile changed");
});
