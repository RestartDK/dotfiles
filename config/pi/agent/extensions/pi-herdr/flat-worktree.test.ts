import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { HerdrClient } from "./client.ts";
import type { PaneInfo, TabInfo, WorkspaceInfo } from "./generated/success-response.ts";
import { ensureWorktree, presentWorktree, validateCheckoutPath } from "./flat-worktree.ts";

const exec = promisify(execFile);
const workspace: WorkspaceInfo = {
  workspace_id: "w1",
  active_tab_id: "w1:t1",
  agent_status: "unknown",
  focused: false,
  label: "task",
  number: 1,
  pane_count: 1,
  tab_count: 1,
};
const tab: TabInfo = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  agent_status: "unknown",
  focused: false,
  label: "task",
  number: 1,
  pane_count: 1,
};
const pane: PaneInfo = {
  workspace_id: "w1",
  tab_id: "w1:t1",
  pane_id: "w1:p1",
  terminal_id: "terminal",
  agent_status: "unknown",
  focused: false,
  revision: 0,
};
function client(options: { cwd?: string; grouped?: boolean; fail?: boolean } = {}) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const herdr: Pick<HerdrClient, "call"> = {
    async call(method, params) {
      calls.push(method);
      requests.push(params);
      if (method === "workspace.list")
        return {
          type: "workspace_list",
          workspaces: options.cwd
            ? [
                {
                  ...workspace,
                  worktree: options.grouped
                    ? {
                        checkout_path: options.cwd,
                        is_linked_worktree: true,
                        repo_key: "repo",
                        repo_name: "repo",
                        repo_root: options.cwd,
                      }
                    : undefined,
                },
              ]
            : [],
        };
      if (method === "pane.list")
        return { type: "pane_list", panes: [{ ...pane, foreground_cwd: options.cwd }] };
      if (method === "tab.get") return { type: "tab_info", tab };
      if (method === "workspace.create") {
        if (options.fail) throw new Error("socket refused");
        return { type: "workspace_created", workspace, tab, root_pane: pane };
      }
      if (method === "worktree.open")
        return {
          type: "worktree_opened",
          already_open: true,
          workspace,
          tab,
          root_pane: pane,
          worktree: {
            path: "/grouped",
            branch: "daniel/grouped",
            is_bare: false,
            is_detached: false,
            is_linked_worktree: true,
            is_prunable: false,
            label: "grouped",
          },
        };
      if (method === "worktree.create")
        return {
          type: "worktree_created",
          workspace,
          tab,
          root_pane: pane,
          worktree: {
            path: "/grouped",
            branch: "daniel/grouped",
            is_bare: false,
            is_detached: false,
            is_linked_worktree: true,
            is_prunable: false,
            label: "grouped",
          },
        };
      throw new Error(`Unexpected mutation: ${method}`);
    },
  };
  return { herdr, calls, requests };
}
async function repository(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "fwt-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo");
  await mkdir(repo);
  await exec("git", ["init", repo]);
  await exec("git", [
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  return { dir, repo };
}
test("create adds a real Git checkout and only a plain workspace; open reuses its pane checkout", async (t) => {
  const { dir, repo } = await repository(t);
  const path = join(dir, "task");
  const fake = client();
  const created = await presentWorktree(fake.herdr, {
    action: "create",
    cwd: repo,
    path,
    branch: "daniel/task",
  });
  assert.equal(
    (await exec("git", ["-C", path, "branch", "--show-current"])).stdout.trim(),
    "daniel/task",
  );
  assert.equal(created.worktree.path, await realpath(path));
  assert.deepEqual(fake.calls, ["workspace.list", "workspace.create"]);
  assert.equal(created.already_open, false);
  await mkdir(join(path, "nested"));
  const reuse = client({ cwd: join(path, "nested") });
  const opened = await presentWorktree(reuse.herdr, {
    action: "open",
    cwd: repo,
    branch: "daniel/task",
  });
  assert.equal(opened.already_open, true);
  assert.deepEqual(reuse.calls, ["workspace.list", "pane.list", "tab.get"]);
  const grouped = client({ cwd: path, grouped: true });
  await presentWorktree(grouped.herdr, { action: "open", cwd: repo, path });
  assert.deepEqual(grouped.calls, ["workspace.list", "workspace.create"]);
});
test("default and checkout-relative bases resolve against the requested linked checkout", async (t) => {
  const { dir, repo } = await repository(t);
  const linked = join(dir, "linked");
  await exec("git", ["-C", repo, "worktree", "add", "-b", "daniel/source", linked]);
  for (const message of ["linked one", "linked two"])
    await exec("git", [
      "-C",
      linked,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      message,
    ]);
  const bases = [undefined, "HEAD", "HEAD~1"];
  for (const [index, base] of bases.entries()) {
    const path = join(dir, `derived-${index}`);
    await presentWorktree(client().herdr, {
      action: "create",
      cwd: linked,
      branch: `daniel/derived-${index}`,
      base,
      path,
    });
    const expected = (await exec("git", ["-C", linked, "rev-parse", base ?? "HEAD"])).stdout.trim();
    const actual = (await exec("git", ["-C", path, "rev-parse", "HEAD"])).stdout.trim();
    assert.equal(actual, expected);
  }
});

test("native grouped creation is opt-in and sends exactly one parent target", async () => {
  const grouped = client();
  const result = await presentWorktree(grouped.herdr, {
    action: "create",
    presentation: "grouped",
    cwd: "/repo",
    workspaceId: "parent",
    branch: "daniel/grouped",
  });
  assert.equal(result.worktree.path, "/grouped");
  assert.deepEqual(grouped.calls, ["worktree.create"]);
  assert.deepEqual(grouped.requests[0], {
    workspace_id: "parent",
    branch: "daniel/grouped",
    path: undefined,
    label: undefined,
    focus: false,
    base: undefined,
  });
  const byCwd = client();
  await presentWorktree(byCwd.herdr, {
    action: "open",
    presentation: "grouped",
    cwd: "/repo",
    branch: "daniel/grouped",
  });
  assert.deepEqual(byCwd.calls, ["worktree.open"]);
  assert.deepEqual(byCwd.requests[0], {
    cwd: "/repo",
    branch: "daniel/grouped",
    path: undefined,
    label: undefined,
    focus: false,
  });
});
test("workspace failure preserves checkout and branch for explicit open recovery", async (t) => {
  const { dir, repo } = await repository(t);
  const path = join(dir, "task");
  const fake = client({ fail: true });
  await assert.rejects(
    presentWorktree(fake.herdr, { action: "create", cwd: repo, path, branch: "daniel/task" }),
    (error: Error) => error.message.includes(path) && error.message.includes("worktree_open"),
  );
  assert.ok((await stat(path)).isDirectory());
  assert.equal(
    (await exec("git", ["-C", path, "branch", "--show-current"])).stdout.trim(),
    "daniel/task",
  );
  assert.ok(!fake.calls.some((method) => method.includes("remove") || method.includes("close")));
  const recovered = await ensureWorktree(client().herdr, { cwd: repo, branch: "daniel/task" });
  assert.equal(recovered.worktree.path, await realpath(path));
  const reused = await ensureWorktree(client({ cwd: path }).herdr, {
    cwd: repo,
    branch: "daniel/task",
  });
  assert.equal(reused.already_open, true);
});
test("invalid branch, overlong or symlink-expanded path, and occupied directory fail before creation", async (t) => {
  const { dir, repo } = await repository(t);
  const fake = client();
  for (const branch of ["-bad", "bad..ref", "bad ref"])
    await assert.rejects(
      presentWorktree(fake.herdr, { action: "create", cwd: repo, path: join(dir, "task"), branch }),
    );
  await assert.rejects(validateCheckoutPath(join(dir, "fourteenletters")));
  const long = join(dir, "x".repeat(65));
  await mkdir(long);
  await symlink(long, join(dir, "link"));
  await assert.rejects(validateCheckoutPath(join(dir, "link", "task")));
  await assert.rejects(
    presentWorktree(fake.herdr, { action: "create", cwd: repo, path: repo, branch: "daniel/task" }),
  );
  assert.deepEqual(fake.calls, []);
  await assert.rejects(exec("git", ["-C", repo, "show-ref", "--verify", "refs/heads/daniel/task"]));
});
