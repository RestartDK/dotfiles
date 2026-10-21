import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { createLocalBashOperations } from "../config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js";
import { HerdrClient, expectResult } from "../config/pi/agent/extensions/pi-herdr/client.ts";
import { shellQuote } from "../config/pi/agent/extensions/pi-herdr/launch-attempt.ts";
import { observePaneForeground } from "../config/pi/agent/extensions/pi-herdr/pane-foreground.ts";
import { herdrRuntime } from "./herdr-runtime.ts";

const socket = process.env.HERDR_SOCKET_PATH;
if (!socket) throw new Error("Run this check inside Herdr");
const client = new HerdrClient(socket);
const root = resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(join(tmpdir(), "herdr-env-proof-"));
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = fixture;
const tabs: string[] = [];
const slowSeconds = Number(
  process.argv.find((arg) => arg.startsWith("--slow-seconds="))?.split("=")[1] ?? "1",
);
assert.ok(Number.isFinite(slowSeconds) && slowSeconds > 0 && slowSeconds < 590);
const nixpkgs = process.argv
  .find((arg) => arg.startsWith("--lorri-nixpkgs="))
  ?.slice("--lorri-nixpkgs=".length);
const shell = execFileSync("which", ["zsh"], { encoding: "utf8" }).trim();
const env = {
  HOME: fixture,
  ZDOTDIR: fixture,
  TMPDIR: fixture,
  XDG_CONFIG_HOME: join(fixture, "config"),
  XDG_DATA_HOME: join(fixture, "data"),
  XDG_CACHE_HOME: join(fixture, "cache"),
  SHELL: shell,
  REPO_ENV_MANAGED: "1",
};
const rc = `export PATH=${shellQuote(`${root}/bin:${process.env.PATH}`)}\nsource ${shellQuote(`${root}/config/shell/repo-env.zsh`)}\n`;
await writeFile(join(fixture, ".zshrc"), rc);
const runtime = await herdrRuntime();

async function open(cwd: string) {
  const result = expectResult(
    await client.call("tab.create", {
      workspace_id: process.env.HERDR_WORKSPACE_ID,
      cwd,
      label: "env137-proof",
      focus: false,
      env,
    }),
    "tab_created",
  );
  tabs.push(result.tab.tab_id);
  const paneId = result.root_pane.pane_id;
  await waitIdle(paneId);
  return paneId;
}

async function waitIdle(paneId: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const info = expectResult(
      await client.call("pane.process_info", { pane_id: paneId }),
      "pane_process_info",
    ).process_info;
    if ((await observePaneForeground(info)).kind === "idle") return;
    await delay(20);
  }
  throw new Error(`Fixture shell ${paneId} did not become idle`);
}

async function run(pane: string, command: string, signal?: AbortSignal) {
  const result = await runtime.call(
    { action: "run", pane, command, wait: true, timeout: 30_000, lines: 10 },
    signal,
  );
  const details = result.details;
  assert.ok(
    details && typeof details === "object" && "state" in details && details.state === "done",
    JSON.stringify(result),
  );
  assert.ok("exitCode" in details && typeof details.exitCode === "number");
  return details.exitCode;
}

async function waitFile(path: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await delay(20);
  }
  throw new Error(`Fixture did not create ${path}`);
}

function allow(repo: string) {
  execFileSync("direnv", ["allow", repo], { env: { ...process.env, ...env } });
}

try {
  const plain = await open(fixture);
  if (process.argv.includes("--pi-cli")) {
    const cliPane = await open(fixture);
    const cliLog = join(fixture, "pi-cli.log");
    const args = [
      "node",
      join(
        root,
        "config/pi/agent/extensions/pi-herdr/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
      ),
      "--no-session",
      "--no-extensions",
      "--no-context-files",
      "--no-skills",
      "--mode",
      "json",
      "--print",
      "--extension",
      join(root, "tests/herdr-cli-proof.ts"),
      `/env137-proof ${plain}`,
    ];
    const command = `PI_CODING_AGENT_DIR=${shellQuote(join(fixture, "agent"))} ${args.map(shellQuote).join(" ")} > ${shellQuote(cliLog)} 2>&1`;
    const code = await run(cliPane, command);
    const output = await readFile(cliLog, "utf8");
    assert.equal(code, 0, output);
    assert.match(output, /PI_CLI_HERDR_PROOF_OK/);
    console.log(
      "PASS real Pi package CLI loads the factory and invokes its production tool callback without a model call",
    );
  }
  assert.equal(await run(plain, "printf '__pi_rc_000000=0\\n'; sleep 0.2; exit 7"), 7);
  console.log(
    "PASS real package ExtensionRunner uses owned receipt plus idle foreground, not echoed exit text",
  );

  if (process.platform === "linux" && process.env.PI_NETNS_SELECTED) {
    const namespace = process.env.PI_NETNS_SELECTED;
    const output = join(fixture, "namespace");
    assert.equal(await run(plain, `readlink /proc/self/ns/net > ${shellQuote(output)}`), 0);
    const inode = (await stat(`/var/run/netns/${namespace}`)).ino;
    assert.equal((await readFile(output, "utf8")).trim(), `net:[${inode}]`);
    console.log(`PASS actual namespace equals selected ${namespace}`);
  }

  await writeFile(
    join(fixture, ".zshrc"),
    `${rc}prepare_slow() { sleep ${slowSeconds}; export SLOW_READY=yes; }\nrepo_env_hooks+=(prepare_slow)\n`,
  );
  const started = Date.now();
  assert.equal(await run(plain, 'test "$SLOW_READY" = yes'), 0);
  assert.ok(Date.now() - started >= slowSeconds * 1000);
  console.log(`PASS owned preparation blocks for ${slowSeconds}s before payload`);
  await writeFile(join(fixture, ".zshrc"), rc);

  const repo = join(fixture, "repo");
  await mkdir(repo);
  await writeFile(join(repo, ".envrc"), "export TEST_REPO_VALUE=ready\n");
  allow(repo);
  const pane = await open(repo);
  assert.equal(await run(pane, 'test "$TEST_REPO_VALUE" = ready'), 0);
  const bash = createLocalBashOperations({ shellPath: join(root, "bin/repo-bash") });
  const bashResult = await bash.exec('test "$TEST_REPO_VALUE" = ready', repo, {
    onData: () => {},
    env: { ...process.env, ...env },
    timeout: 20,
  });
  assert.equal(bashResult.exitCode, 0);
  console.log(
    "PASS Herdr run and Pi bash backend preserve target exports through the same boundary",
  );

  await writeFile(join(repo, ".envrc"), "exit 17\n");
  allow(repo);
  await assert.rejects(run(pane, "touch forbidden"), /during environment/);
  await assert.rejects(readFile(join(repo, "forbidden")), { code: "ENOENT" });
  expectResult(await client.call("pane.get", { pane_id: pane }), "pane_info");
  console.log("PASS failed environment stops payload and retains the destination handle");

  const preparing = join(fixture, "preparing");
  await writeFile(
    join(fixture, ".zshrc"),
    `${rc}prepare_slow() { touch ${shellQuote(preparing)}; sleep 30; }\nrepo_env_hooks+=(prepare_slow)\n`,
  );
  const abort = new AbortController();
  const pending = assert.rejects(run(plain, "touch forbidden", abort.signal), /cleanup exited/);
  await waitFile(preparing);
  await assert.rejects(run(plain, "touch concurrent-forbidden"), /already has a launch submission/);
  abort.abort();
  await pending;
  await assert.rejects(readFile(join(fixture, "forbidden")), { code: "ENOENT" });
  await writeFile(join(fixture, ".zshrc"), rc);
  assert.equal(await run(plain, "true"), 0);
  console.log("PASS cancellation confirms owned cleanup and the same pane remains usable");

  const trackedGate = join(fixture, "tracked-gate");
  const trackedStarted = join(fixture, "tracked-started");
  execFileSync("mkfifo", [trackedGate]);
  await runtime.call({
    action: "run",
    pane: plain,
    command: `touch ${shellQuote(trackedStarted)}; IFS= read -r release < ${shellQuote(trackedGate)}; exit 19`,
    notify: true,
  });
  await waitFile(trackedStarted);
  await assert.rejects(run(plain, "touch busy-forbidden"), /not an idle shell/);
  const tracking = await runtime.call({ action: "wait", pane: plain, notify: true });
  assert.ok(
    tracking.details &&
      typeof tracking.details === "object" &&
      "state" in tracking.details &&
      tracking.details.state === "running",
  );
  const completion = runtime.call({ action: "wait", pane: plain, wait: true, timeout: 10_000 });
  await writeFile(trackedGate, "release\n");
  const finished = await completion;
  assert.ok(
    finished.details &&
      typeof finished.details === "object" &&
      "exitCode" in finished.details &&
      finished.details.exitCode === 19,
  );
  await assert.rejects(readFile(join(fixture, "busy-forbidden")), { code: "ENOENT" });
  console.log("PASS rejected busy-pane submission preserves the existing completion handle");

  if (nixpkgs) {
    await writeFile(
      join(repo, "shell.nix"),
      `let pkgs = import ${JSON.stringify(nixpkgs)} {}; in pkgs.mkShell { packages = [ (pkgs.writeShellScriptBin "repo-env-cold-tool" "printf cold-ready") ]; }\n`,
    );
    await writeFile(
      join(repo, ".envrc"),
      'eval "$(lorri direnv)"\nrepo-env-cold-tool >/dev/null || exit 71\nexport TEST_REPO_VALUE=cold-ready\n',
    );
    allow(repo);
    await assert.rejects(run(pane, "touch cold-payload"), /during environment/);
    await assert.rejects(readFile(join(repo, "cold-payload")), { code: "ENOENT" });
    await writeFile(
      join(fixture, ".zshrc"),
      `${rc}repo_env_providers+=(${shellQuote(repo)} lorri)\n`,
    );
    await waitIdle(pane);
    assert.equal(
      await run(pane, 'test "$TEST_REPO_VALUE" = cold-ready && repo-env-cold-tool > cold-payload'),
      0,
    );
    assert.equal(await readFile(join(repo, "cold-payload"), "utf8"), "cold-ready");
    console.log(
      "PASS real cold Lorri cache fails without provider and succeeds with blocking lorri watch --once",
    );
  }
} catch (error) {
  for (const tab_id of tabs) {
    const panes = expectResult(
      await client.call("pane.list", { workspace_id: process.env.HERDR_WORKSPACE_ID }),
      "pane_list",
    ).panes;
    for (const pane of panes.filter((pane) => pane.tab_id === tab_id)) {
      const output = expectResult(
        await client.call("pane.read", {
          pane_id: pane.pane_id,
          source: "visible",
          lines: 100,
          strip_ansi: true,
        }),
        "pane_read",
      );
      console.error(output.read.text);
    }
  }
  throw error;
} finally {
  await runtime.close();
  for (const tab_id of tabs) await client.call("tab.close", { tab_id });
  if (previousTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = previousTmp;
  await rm(fixture, { recursive: true, force: true });
}
