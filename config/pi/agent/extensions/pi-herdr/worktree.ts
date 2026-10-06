import { execFile } from "node:child_process";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { expectResult, type HerdrClient, type ResultOfType } from "./client.ts";

const exec = promisify(execFile);
type Client = Pick<HerdrClient, "call">;
export interface WorktreeRequest {
  action: "create" | "open";
  grouped?: boolean;
  cwd: string;
  checkoutCwd?: string;
  workspaceId?: string;
  branch?: string;
  base?: string;
  path?: string;
  label?: string;
  focus?: boolean;
  signal?: AbortSignal;
}
export type WorktreeWorkspace = Pick<
  ResultOfType<"workspace_created">,
  "workspace" | "root_pane" | "tab"
> & {
  worktree: { path: string; branch?: string };
  already_open: boolean;
};

async function git(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  timeout?: number,
): Promise<string> {
  return (
    await exec("git", ["-C", cwd, ...args], { signal, timeout, maxBuffer: 1024 * 1024 })
  ).stdout.trim();
}

async function resolvedMissing(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await resolvedMissing(dirname(path)), basename(path));
  }
}

export async function validateCheckoutPath(path: string): Promise<void> {
  if (!isAbsolute(path) || !/^[a-z0-9][a-z0-9-]{0,12}$/.test(basename(path)))
    throw new Error("Checkout path must be absolute with a 1-13 character lowercase slug.");
  for (const candidate of [path, await resolvedMissing(path)])
    if (Buffer.byteLength(candidate) > 60)
      throw new Error(`Checkout path exceeds 60 bytes: ${candidate}`);
}

async function openWorkspace(
  herdr: Client,
  request: WorktreeRequest,
  path: string,
): Promise<WorktreeWorkspace> {
  const workspaces = expectResult(
    await herdr.call("workspace.list", {}, { signal: request.signal }),
    "workspace_list",
  ).workspaces;
  for (const workspace of workspaces.filter((item) => !item.worktree)) {
    const panes = expectResult(
      await herdr.call(
        "pane.list",
        { workspace_id: workspace.workspace_id },
        { signal: request.signal },
      ),
      "pane_list",
    ).panes;
    for (const pane of panes) {
      const cwd = pane.foreground_cwd ?? pane.cwd;
      if (!cwd) continue;
      let checkout: string;
      try {
        checkout = await realpath(
          await git(cwd, ["rev-parse", "--show-toplevel"], request.signal, 5000),
        );
      } catch {
        continue;
      }
      if (checkout !== path) continue;
      const tab = expectResult(
        await herdr.call("tab.get", { tab_id: pane.tab_id }, { signal: request.signal }),
        "tab_info",
      ).tab;
      if (request.focus)
        await herdr.call(
          "workspace.focus",
          { workspace_id: workspace.workspace_id },
          { signal: request.signal },
        );
      return {
        workspace,
        root_pane: pane,
        tab,
        worktree: { path, branch: request.branch },
        already_open: true,
      };
    }
  }
  const created = expectResult(
    await herdr.call(
      "workspace.create",
      {
        cwd: path,
        label: request.label ?? request.branch ?? basename(path),
        focus: request.focus ?? false,
      },
      { signal: request.signal },
    ),
    "workspace_created",
  );
  return { ...created, worktree: { path, branch: request.branch }, already_open: false };
}

export async function ensureWorktree(
  herdr: Client,
  request: Omit<WorktreeRequest, "action" | "grouped"> & { branch: string },
): Promise<WorktreeWorkspace> {
  const cwd = request.checkoutCwd ?? request.cwd;
  const fields = (await git(cwd, ["worktree", "list", "--porcelain", "-z"], request.signal)).split(
    "\0",
  );
  return presentWorktree(herdr, {
    ...request,
    action: fields.includes(`branch refs/heads/${request.branch}`) ? "open" : "create",
  });
}

export async function presentWorktree(
  herdr: Client,
  request: WorktreeRequest,
): Promise<WorktreeWorkspace> {
  const cwd = request.grouped ? request.cwd : (request.checkoutCwd ?? request.cwd);
  if (request.grouped) {
    const params = {
      ...(request.workspaceId === undefined
        ? { cwd: request.cwd }
        : { workspace_id: request.workspaceId }),
      branch: request.branch,
      path: request.path,
      label: request.label,
      focus: request.focus ?? false,
    };
    if (request.action === "create") {
      const result = expectResult(
        await herdr.call(
          "worktree.create",
          { ...params, base: request.base },
          { signal: request.signal },
        ),
        "worktree_created",
      );
      return {
        ...result,
        worktree: { path: result.worktree.path, branch: result.worktree.branch ?? undefined },
        already_open: false,
      };
    }
    const result = expectResult(
      await herdr.call("worktree.open", params, { signal: request.signal }),
      "worktree_opened",
    );
    return {
      ...result,
      worktree: { path: result.worktree.path, branch: result.worktree.branch ?? undefined },
    };
  }
  const common = await realpath(
    await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], request.signal),
  );
  const root = basename(common) === ".git" ? dirname(common) : common;
  if (request.branch) {
    if (request.branch.startsWith("-")) throw new Error("Branch cannot start with '-'.");
    await git(root, ["check-ref-format", "--branch", request.branch], request.signal);
  }
  let path: string;
  if (request.action === "open") {
    const listing = (await git(root, ["worktree", "list", "--porcelain", "-z"], request.signal))
      .split("\0\0")
      .map((record) => record.split("\0"));
    const match = listing.find((fields) =>
      request.path
        ? fields.includes(`worktree ${resolve(cwd, request.path)}`)
        : fields.includes(`branch refs/heads/${request.branch}`),
    );
    const checkout = match?.find((field) => field.startsWith("worktree "))?.slice(9);
    if (!checkout)
      throw new Error("No matching Git checkout. Supply a registered worktree path or branch.");
    path = await realpath(checkout);
  } else {
    if (!request.branch) throw new Error("branch is required to create a worktree.");
    const slug =
      request.branch
        .split("/")
        .at(-1)
        ?.toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+/, "")
        .slice(0, 13) || "task";
    path = request.path
      ? resolve(cwd, request.path)
      : join(homedir(), ".herdr", "worktrees", basename(root), slug);
    await validateCheckoutPath(path);
    try {
      await lstat(path);
      throw new Error(
        `Checkout path already exists: ${path}. Use worktree_open or choose another short path.`,
      );
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    await mkdir(dirname(path), { recursive: true });
    await validateCheckoutPath(path);
    const base = await git(
      cwd,
      ["rev-parse", "--verify", "--end-of-options", `${request.base ?? "HEAD"}^{commit}`],
      request.signal,
    );
    await git(root, ["worktree", "add", "-b", request.branch, path, base], request.signal);
    path = await realpath(path);
  }
  try {
    return await openWorkspace(herdr, request, path);
  } catch (error) {
    throw new Error(
      `Checkout preserved at ${path}, but its plain workspace could not open. Retry worktree_open with path ${path}. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
