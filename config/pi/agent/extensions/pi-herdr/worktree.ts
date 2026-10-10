import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { HandoffReadiness, worktreeState, type HandoffDestination } from "./worktree-state.ts";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

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

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function validateCheckoutPath(path: string): Promise<void> {
  if (!isAbsolute(path) || !/^[a-z0-9][a-z0-9-]{0,12}$/.test(basename(path)))
    throw new Error("Checkout path must be absolute with a 1-13 character lowercase slug.");
  for (const candidate of [path, await canonicalPath(path)])
    if (Buffer.byteLength(candidate) > 60)
      throw new Error(`Checkout path exceeds 60 bytes: ${candidate}`);
}

export async function requireCheckoutRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  try {
    return await git(cwd, ["rev-parse", "--show-toplevel"], signal, 5000);
  } catch (error) {
    throw new Error(
      `${cwd} is not inside a Git work tree. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

const ClaimOwner = Type.Object({ id: Type.String(), sourceSessionFile: Type.String() });
type ClaimOwner = Static<typeof ClaimOwner>;
export type CheckoutClaim = ClaimOwner & { path: string };

async function claimOwner(path: string): Promise<ClaimOwner> {
  const value: unknown = JSON.parse(await readFile(join(path, "owner"), "utf8"));
  if (!Check(ClaimOwner, value)) throw new Error(`Invalid handoff reservation owner at ${path}.`);
  return value;
}

async function removeClaim(claim: CheckoutClaim): Promise<void> {
  const owner = await claimOwner(claim.path);
  if (owner.id !== claim.id || owner.sourceSessionFile !== claim.sourceSessionFile)
    throw new Error(`Handoff reservation ownership changed at ${claim.path}.`);
  const files = await readdir(claim.path);
  if (files.some((file) => file !== "owner" && file !== "decision"))
    throw new Error(`Handoff reservation still has pending files at ${claim.path}.`);
  if (files.includes("decision")) await unlink(join(claim.path, "decision"));
  await unlink(join(claim.path, "owner"));
  await rmdir(claim.path);
}

export async function releaseCheckout(claim: CheckoutClaim): Promise<void> {
  const lock = `${claim.path}.lock`;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
        Date.now() >= deadline
      )
        throw error;
      await delay(25);
    }
  }
  try {
    await removeClaim(claim);
  } finally {
    await rmdir(lock);
  }
}

export async function claimCheckout(
  path: string,
  sourceSessionFile: string,
  signal?: AbortSignal,
  options: {
    id?: string;
    assertAvailable?: (previous?: HandoffDestination) => Promise<void>;
  } = {},
): Promise<CheckoutClaim> {
  const claimPath = await git(
    path,
    ["rev-parse", "--path-format=absolute", "--git-path", "pi-herdr-handoff"],
    signal,
  );
  signal?.throwIfAborted();
  const lock = `${claimPath}.lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST")
      throw new Error(`This checkout has a handoff reservation being changed at ${lock}.`);
    throw error;
  }
  try {
    await options.assertAvailable?.();
    signal?.throwIfAborted();
    try {
      await mkdir(claimPath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const owner = await claimOwner(claimPath);
        const state = worktreeState(SessionManager.open(owner.sourceSessionFile).getBranch());
        if (
          !options.assertAvailable ||
          state?.kind !== "transferred" ||
          state.id !== owner.id ||
          state.destination.claimPath !== claimPath ||
          state.destination.path !== path ||
          (await new HandoffReadiness(claimPath, owner.id).read()) !== "ready"
        )
          throw new Error("The previous launch is not confirmed complete and unoccupied.");
        await options.assertAvailable(state.destination);
        await removeClaim({ ...owner, path: claimPath });
        await mkdir(claimPath);
      } catch (cause) {
        throw new Error(
          `This checkout has a handoff reservation at ${claimPath}. Inspect its owner and destination before recovery. ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause },
        );
      }
    }
    const claim: CheckoutClaim = {
      path: claimPath,
      id: options.id ?? randomUUID(),
      sourceSessionFile,
    };
    try {
      await writeFile(
        join(claimPath, "owner"),
        JSON.stringify({ id: claim.id, sourceSessionFile }),
        { flag: "wx" },
      );
    } catch (error) {
      try {
        await unlink(join(claimPath, "owner"));
      } catch (cleanup) {
        if (!(cleanup instanceof Error && "code" in cleanup && cleanup.code === "ENOENT"))
          throw cleanup;
      }
      await rmdir(claimPath);
      throw error;
    }
    return claim;
  } finally {
    await rmdir(lock);
  }
}
