import { spawn } from "node:child_process";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus extends GitStatus {
  cwd: string;
  timestamp: number;
}

interface ParsedGitStatus {
  branch: string | null;
  upstream: string | null;
  conflicted: number;
  deleted: number;
  renamed: number;
  modified: number;
  staged: number;
  untracked: number;
  typechanged: number;
}

const CACHE_TTL_MS = 1000;
let cachedStatus: CachedGitStatus | null = null;
let pendingFetch: Promise<void> | null = null;
let invalidationCounter = 0;
let activeCwd: string | null = null;

function emptyGitStatus(branch: string | null): GitStatus {
  return {
    branch,
    parentBranch: null,
    conflicted: 0,
    stashed: 0,
    deleted: 0,
    renamed: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    typechanged: 0,
    ahead: null,
    behind: null,
    linesAdded: 0,
    linesRemoved: 0,
  };
}

function runGit(args: string[], cwd: string, timeoutMs = 500): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.trim() : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

function applyNormalStatus(parsed: ParsedGitStatus, xy: string): void {
  const index = xy[0];
  const worktree = xy[1];

  if (index === "D") parsed.deleted++;
  if (worktree === "D") parsed.deleted++;
  if (worktree === "M" || worktree === "A") parsed.modified++;
  if (index === "M" || index === "A" || index === "T") parsed.staged++;
  if (worktree === "T") parsed.typechanged++;
}

export function parseGitStatusOutput(output: string): ParsedGitStatus {
  const parsed: ParsedGitStatus = {
    branch: null,
    upstream: null,
    conflicted: 0,
    deleted: 0,
    renamed: 0,
    modified: 0,
    staged: 0,
    untracked: 0,
    typechanged: 0,
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const branch = line.slice("# branch.head ".length);
      parsed.branch = branch === "(detached)" ? null : branch;
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      parsed.upstream = line.slice("# branch.upstream ".length);
      continue;
    }
    if (line.startsWith("1 ")) {
      applyNormalStatus(parsed, line.slice(2, 4));
      continue;
    }
    if (line.startsWith("2 ")) {
      parsed.renamed++;
      applyNormalStatus(parsed, line.slice(2, 4));
      continue;
    }
    if (line.startsWith("u ")) {
      parsed.conflicted++;
      continue;
    }
    if (line.startsWith("? ")) {
      parsed.untracked++;
    }
  }

  return parsed;
}

export function parseAheadBehindOutput(output: string): { ahead: number; behind: number } | null {
  const [behindText, aheadText] = output.trim().split(/\s+/, 2);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  return Number.isFinite(ahead) && Number.isFinite(behind) ? { ahead, behind } : null;
}

export function parseLineDiffOutput(output: string): { linesAdded: number; linesRemoved: number } {
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of output.split("\n")) {
    const [addedText, removedText] = line.split("\t", 3);
    const added = Number.parseInt(addedText ?? "", 10);
    const removed = Number.parseInt(removedText ?? "", 10);
    if (Number.isFinite(added)) linesAdded += added;
    if (Number.isFinite(removed)) linesRemoved += removed;
  }

  return { linesAdded, linesRemoved };
}

async function firstExistingRef(candidates: string[], cwd: string): Promise<string | null> {
  for (const candidate of new Set(candidates.filter(Boolean))) {
    const resolved = await runGit(
      ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`],
      cwd,
    );
    if (resolved !== null) return candidate;
  }
  return null;
}

async function resolveParentBranch(parsed: ParsedGitStatus, cwd: string): Promise<string | null> {
  const branchRemote = parsed.branch
    ? await runGit(["config", "--get", `branch.${parsed.branch}.remote`], cwd)
    : null;
  const upstreamRemote = parsed.upstream?.split("/", 1)[0] ?? null;
  const remote = branchRemote && branchRemote !== "." ? branchRemote : (upstreamRemote ?? "origin");

  const [configuredBase, remoteHead] = await Promise.all([
    parsed.branch
      ? runGit(["config", "--get", `branch.${parsed.branch}.gh-merge-base`], cwd)
      : Promise.resolve(null),
    runGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], cwd),
  ]);

  const configuredCandidates = configuredBase
    ? configuredBase.includes("/")
      ? [configuredBase]
      : [`${remote}/${configuredBase}`, configuredBase]
    : [];

  return firstExistingRef(
    [
      ...configuredCandidates,
      remoteHead ?? "",
      `${remote}/main`,
      `${remote}/master`,
      "origin/main",
      "origin/master",
      "main",
      "master",
      parsed.upstream ?? "",
    ],
    cwd,
  );
}

export async function fetchGitStatus(cwd: string): Promise<GitStatus | null> {
  const output = await runGit(["status", "--porcelain=2", "--branch"], cwd, 1000);
  if (output === null) return null;

  const parsed = parseGitStatusOutput(output);
  if (!parsed.branch) {
    const sha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
    if (sha) parsed.branch = `${sha} (detached)`;
  }

  const [stashOutput, parentBranch] = await Promise.all([
    runGit(["stash", "list", "--format=%gd"], cwd),
    resolveParentBranch(parsed, cwd),
  ]);

  let ahead: number | null = null;
  let behind: number | null = null;
  let linesAdded = 0;
  let linesRemoved = 0;

  if (parentBranch) {
    const [relationOutput, mergeBase] = await Promise.all([
      runGit(["rev-list", "--left-right", "--count", `${parentBranch}...HEAD`], cwd),
      runGit(["merge-base", parentBranch, "HEAD"], cwd),
    ]);
    const relation = relationOutput ? parseAheadBehindOutput(relationOutput) : null;
    ahead = relation?.ahead ?? null;
    behind = relation?.behind ?? null;

    if (mergeBase) {
      const diffOutput = await runGit(
        ["diff", "--no-ext-diff", "--numstat", mergeBase, "--"],
        cwd,
        1500,
      );
      if (diffOutput !== null) {
        ({ linesAdded, linesRemoved } = parseLineDiffOutput(diffOutput));
      }
    }
  }

  return {
    branch: parsed.branch,
    parentBranch,
    conflicted: parsed.conflicted,
    stashed: stashOutput ? stashOutput.split("\n").filter(Boolean).length : 0,
    deleted: parsed.deleted,
    renamed: parsed.renamed,
    modified: parsed.modified,
    staged: parsed.staged,
    untracked: parsed.untracked,
    typechanged: parsed.typechanged,
    ahead,
    behind,
    linesAdded,
    linesRemoved,
  };
}

function selectCwd(cwd: string): void {
  if (activeCwd === cwd) return;
  activeCwd = cwd;
  cachedStatus = null;
  pendingFetch = null;
  invalidationCounter++;
}

export function getGitStatus(providerBranch: string | null, cwd = process.cwd()): GitStatus {
  selectCwd(cwd);
  const now = Date.now();

  if (cachedStatus && cachedStatus.cwd === cwd && now - cachedStatus.timestamp < CACHE_TTL_MS) {
    return cachedStatus;
  }

  if (!pendingFetch) {
    const fetchId = invalidationCounter;
    const fetchPromise = fetchGitStatus(cwd)
      .then((result) => {
        if (fetchId === invalidationCounter) {
          cachedStatus = {
            ...emptyGitStatus(providerBranch),
            ...result,
            cwd,
            timestamp: Date.now(),
          };
        }
      })
      .finally(() => {
        if (pendingFetch === fetchPromise) pendingFetch = null;
      });
    pendingFetch = fetchPromise;
  }

  return cachedStatus?.cwd === cwd ? cachedStatus : emptyGitStatus(providerBranch);
}

export function invalidateGitStatus(): void {
  cachedStatus = null;
  pendingFetch = null;
  invalidationCounter++;
}

export function invalidateGitBranch(): void {
  invalidateGitStatus();
}
