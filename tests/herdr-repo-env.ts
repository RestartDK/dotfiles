import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";
import assert from "node:assert/strict";
import { createLocalBashOperations } from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { HerdrClient, expectResult } from "../config/pi/agent/extensions/pi-herdr/client.ts";
import {
  createPreparedShell,
  preparedCommand,
} from "../config/pi/agent/extensions/pi-herdr/shell-ready.ts";

const socket = process.env.HERDR_SOCKET_PATH;
if (!socket) throw new Error("Run this check inside Herdr");
const client = new HerdrClient(socket);
const root = resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "herdr-env-test-"));
const tabs: string[] = [];
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const env = {
  HOME: fixture,
  ZDOTDIR: fixture,
  XDG_CONFIG_HOME: join(fixture, "config"),
  XDG_DATA_HOME: join(fixture, "data"),
  SHELL: "/bin/zsh",
};
await writeFile(
  join(fixture, ".zshrc"),
  `export PATH=${quote(`${root}/bin:${process.env.PATH}`)}\nsource ${quote(`${root}/config/shell/repo-env.zsh`)}\nautoload -Uz add-zsh-hook\nadd-zsh-hook precmd _repo_env_prompt\nadd-zsh-hook chpwd repo_env_prepare\n`,
);

async function open(cwd: string) {
  return createPreparedShell({}, async (readyEnv) => {
    const result = expectResult(
      await client.call("tab.create", {
        workspace_id: process.env.HERDR_WORKSPACE_ID,
        cwd,
        label: "repo-env-test",
        focus: false,
        env: { ...env, ...readyEnv },
      }),
      "tab_created",
    );
    tabs.push(result.tab.tab_id);
    return result.root_pane;
  });
}

try {
  const plain = await open(fixture);
  assert.ok(plain);
  console.log("PASS real Herdr tab reaches prepared state without .envrc");

  const rcPath = join(fixture, ".zshrc");
  const originalRc = await readFile(rcPath, "utf8");
  await writeFile(
    rcPath,
    `${originalRc}\nprepare_slow() { sleep 1; }\nrepo_env_hooks+=(prepare_slow)\n`,
  );
  const slowStart = Date.now();
  await open(fixture);
  assert.ok(Date.now() - slowStart >= 900);
  await writeFile(rcPath, originalRc);
  console.log("PASS preparation longer than the old 800 ms delay is awaited");

  const repo = join(fixture, "repo");
  await mkdir(repo);
  await writeFile(join(repo, ".envrc"), "export TEST_REPO_VALUE=ready\n");
  execFileSync("direnv", ["allow", repo], { env: { ...process.env, ...env } });
  const pane = await open(repo);
  const resultFile = join(fixture, "command-result");
  await client.call("pane.send_input", {
    pane_id: pane.pane_id,
    text: preparedCommand(`printf '%s' "$TEST_REPO_VALUE" > ${quote(resultFile)}`),
    keys: ["Enter"],
  });
  let result = "";
  const deadline = Date.now() + 5000;
  while (!result && Date.now() < deadline) {
    try {
      result = await readFile(resultFile, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (!result) await setTimeout(50);
  }
  assert.equal(result, "ready");
  console.log("PASS command submitted to real Herdr pane receives repo environment");

  let bashOutput = "";
  const bash = createLocalBashOperations({ shellPath: join(root, "bin/repo-bash") });
  const bashResult = await bash.exec(
    'test "$TEST_REPO_VALUE" = ready && printf PI_BASH_READY',
    repo,
    {
      onData: (data) => {
        bashOutput += data.toString();
      },
      env: { ...process.env, ...env },
      timeout: 20,
    },
  );
  assert.equal(bashResult.exitCode, 0, bashOutput);
  assert.ok(bashOutput.includes("PI_BASH_READY"));
  console.log("PASS Pi bash backend loads the target environment through shellPath");

  await writeFile(join(repo, ".envrc"), "echo fixture-failure >&2\nexit 17\n");
  execFileSync("direnv", ["allow", repo], { env: { ...process.env, ...env } });
  await assert.rejects(open(repo), /preparation failed/);
  console.log("PASS failed activation blocks readiness in real Herdr pane");
  const failedBash = await bash.exec("touch should-not-run", repo, {
    onData: () => {},
    env: { ...process.env, ...env },
    timeout: 20,
  });
  assert.notEqual(failedBash.exitCode, 0);
  await assert.rejects(readFile(join(repo, "should-not-run")));
  console.log("PASS Pi bash backend does not execute commands after activation failure");
} finally {
  for (const tab_id of tabs) await client.call("tab.close", { tab_id });
  await rm(fixture, { recursive: true, force: true });
}
