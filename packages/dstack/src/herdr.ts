import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { acquireLock } from "./lock.js";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { expectResult, HerdrClient } from "../../../config/pi/agent/extensions/pi-herdr/client.ts";
import type { ParamsFor } from "../../../config/pi/agent/extensions/pi-herdr/client.ts";
import type { PaneInfo } from "../../../config/pi/agent/extensions/pi-herdr/generated/success-response.ts";
import {
  jobLine,
  socketPath,
  subscribeJobs,
  type Connection,
} from "../../../config/pi/agent/lib/dstack-jobs.js";

const ttlMs = 15_000;
type Herdr = Pick<HerdrClient, "call">;
type OwnedPane = Pick<PaneInfo, "pane_id" | "terminal_id"> & { owner: string };

function ownerToken(value: string | undefined): string | null {
  return value && /^[a-f0-9]{32}$/.test(value) ? value : null;
}
function socketKey(socket: string): string {
  return createHash("sha256").update(socket).digest("hex");
}
function liveOwner(pane: PaneInfo, socket: string): string | null {
  const owner = ownerToken(pane.tokens?.dstack_jobs_owner);
  return owner &&
    pane.tokens?.dstack_jobs_live === owner &&
    pane.tokens?.dstack_jobs_socket === socketKey(socket)
    ? owner
    : null;
}
function plain(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

export function herdrContext(env: NodeJS.ProcessEnv = process.env): {
  herdr: HerdrClient;
  paneId: string;
} {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID)
    throw new Error("Run dstack herdr inside a Herdr pane");
  return { herdr: new HerdrClient(env.HERDR_SOCKET_PATH), paneId: env.HERDR_PANE_ID };
}

export async function openJobsPane(input: {
  herdr: Herdr;
  paneId: string;
  jobsSocket: string;
  node: string;
  cli: string;
  notify: boolean;
}): Promise<PaneInfo> {
  const { herdr, jobsSocket } = input;
  const options = { timeoutMs: 2000 };
  const { pane: caller } = expectResult(
    await herdr.call("pane.get", { pane_id: input.paneId }, options),
    "pane_info",
  );
  const directory = dirname(jobsSocket);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    (await realpath(directory)) !== directory ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0
  )
    throw new Error("Jobs launch needs a canonical private state directory");
  const unlock = await acquireLock(
    directory,
    { file: process.env.DSTACK_FLOCK || "flock", args: [] },
    { name: `herdr-${socketKey(caller.workspace_id + jobsSocket)}.lock`, waitSeconds: 10 },
  );
  try {
    const { panes } = expectResult(
      await herdr.call("pane.list", { workspace_id: caller.workspace_id }, options),
      "pane_list",
    );
    for (const candidate of panes) {
      const owner = liveOwner(candidate, jobsSocket);
      if (!owner) continue;
      const { pane } = expectResult(
        await herdr.call("pane.get", { pane_id: candidate.pane_id }, options),
        "pane_info",
      );
      if (
        pane.terminal_id !== candidate.terminal_id ||
        pane.workspace_id !== caller.workspace_id ||
        liveOwner(pane, jobsSocket) !== owner
      )
        continue;
      return expectResult(
        await herdr.call("pane.focus", { pane_id: pane.pane_id }, options),
        "pane_info",
      ).pane;
    }
    const cwd = caller.foreground_cwd || caller.cwd;
    if (!cwd || !isAbsolute(cwd) || !isAbsolute(input.node) || !isAbsolute(input.cli))
      throw new Error("Jobs needs an absolute checkout and executable path");
    const owner = randomBytes(16).toString("hex");
    const { layout } = expectResult(
      await herdr.call(
        "layout.apply",
        {
          workspace_id: caller.workspace_id,
          tab_label: "Jobs",
          focus: false,
          root: {
            type: "pane",
            cwd,
            command: [input.node, input.cli, "herdr-view"],
            env: {
              DSTACK_SOCKET: jobsSocket,
              DSTACK_HERDR_OWNER: owner,
              DSTACK_HERDR_NOTIFY: input.notify ? "1" : "0",
            },
          },
        },
        options,
      ),
      "layout_apply",
    );
    const paneId = layout.focused_pane_id;
    try {
      expectResult(
        await herdr.call(
          "pane.report_metadata",
          {
            pane_id: paneId,
            source: "dstack-jobs-owner",
            seq: 1,
            tokens: { dstack_jobs_owner: owner, dstack_jobs_socket: socketKey(jobsSocket) },
          },
          options,
        ),
        "ok",
      );
      expectResult(
        await herdr.call(
          "pane.wait_for_output",
          {
            pane_id: paneId,
            match: { type: "substring", value: "Dstack jobs |" },
            source: "visible",
            timeout_ms: 5000,
          },
          { timeoutMs: 7000 },
        ),
        "output_matched",
      );
      const { pane } = expectResult(
        await herdr.call("pane.get", { pane_id: paneId }, options),
        "pane_info",
      );
      if (pane.workspace_id !== caller.workspace_id || liveOwner(pane, jobsSocket) !== owner)
        throw new Error("Jobs viewer did not claim its launch");
      return expectResult(await herdr.call("pane.focus", { pane_id: paneId }, options), "pane_info")
        .pane;
    } catch (error) {
      throw new Error(
        `Jobs pane ${paneId} was created but setup failed; inspect it before retrying`,
        { cause: error },
      );
    }
  } finally {
    await unlock();
  }
}

export function jobsViewport(text: string, columns: number, rows: number): string {
  const lines = text.split("\n");
  const height = Math.max(2, rows - 1);
  const shown =
    lines.length > height
      ? [...lines.slice(0, height - 1), `+${lines.length - height + 1} more lines | dstack list`]
      : lines;
  return shown.map((line) => truncateToWidth(line, Math.max(1, columns), "…")).join("\n");
}

export class JobsPresentation {
  #seq = 0;
  #snapshotAt = -1;
  #closed = false;
  #previous = new Map<string, string>();

  constructor(readonly pane: OwnedPane) {}

  close(): void {
    this.#closed = true;
  }

  update(connection: Connection): {
    text: string;
    metadata: ParamsFor<"pane.report_metadata">;
    notifications: ParamsFor<"notification.show">[];
  } | null {
    if (this.#closed) return null;
    const snapshot = connection.kind === "online" ? connection.snapshot : connection.last;
    if (snapshot && snapshot.now < this.#snapshotAt) return null;
    if (snapshot) this.#snapshotAt = snapshot.now;
    const jobs = snapshot?.jobs ?? [];
    const blocked = jobs.filter((job) => job.state.kind === "blocked").length;
    const terminal = jobs.filter((job) => job.state.kind === "terminal").length;
    const summary =
      connection.kind === "offline"
        ? "offline, cached state is stale"
        : `${jobs.length} jobs, ${blocked} blocked, ${terminal} terminal`;
    const notifications: ParamsFor<"notification.show">[] = [];
    if (connection.kind === "online") {
      for (const job of jobs) {
        const state = `${job.state.kind}:${job.state.reason}`;
        if (
          this.#previous.has(job.id) &&
          this.#previous.get(job.id) !== state &&
          (job.state.kind === "blocked" || job.state.kind === "terminal")
        ) {
          notifications.push({
            title: `Jobs: ${job.state.kind}`,
            body: plain(`${job.repo}#${job.pr} ${job.state.reason}`),
            sound: "none",
          });
        }
        this.#previous.set(job.id, state);
      }
    }
    return {
      text: [
        `Dstack jobs | ${summary} | Ctrl-C disconnects only`,
        ...(jobs.length
          ? jobs.flatMap((job) => [
              plain(jobLine(job, snapshot?.now ?? 0)),
              `  ${job.id} | ${plain(job.source)}`,
            ])
          : [connection.kind === "offline" ? "No cached snapshot." : "No jobs registered."]),
      ].join("\n"),
      metadata: {
        pane_id: this.pane.pane_id,
        source: `dstack-jobs:${this.pane.owner}`,
        seq: ++this.#seq,
        ttl_ms: ttlMs,
        title: `Jobs | ${summary}`,
        tokens: { dstack_jobs_live: this.pane.owner, dstack_jobs_status: summary },
      },
      notifications,
    };
  }
}

export async function watchJobsPane(input: {
  herdr: Herdr;
  paneId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const env = input.env ?? process.env;
  const owner = ownerToken(env.DSTACK_HERDR_OWNER);
  const options = { timeoutMs: 2000 };
  const { pane } = expectResult(
    await input.herdr.call("pane.get", { pane_id: input.paneId }, options),
    "pane_info",
  );
  if (
    !owner ||
    (pane.tokens?.dstack_jobs_owner !== undefined && pane.tokens.dstack_jobs_owner !== owner)
  )
    throw new Error("Jobs viewer requires its own marked Herdr pane");
  expectResult(
    await input.herdr.call(
      "pane.report_metadata",
      {
        pane_id: pane.pane_id,
        source: "dstack-jobs-owner",
        seq: 2,
        tokens: { dstack_jobs_owner: owner, dstack_jobs_socket: socketKey(socketPath(env)) },
      },
      options,
    ),
    "ok",
  );
  expectResult(
    await input.herdr.call(
      "pane.report_metadata",
      {
        pane_id: pane.pane_id,
        source: `dstack-jobs:${owner}`,
        seq: 0,
        ttl_ms: ttlMs,
        title: "Jobs | connecting",
        tokens: { dstack_jobs_live: owner },
      },
      options,
    ),
    "ok",
  );
  const presentation = new JobsPresentation({
    pane_id: pane.pane_id,
    terminal_id: pane.terminal_id,
    owner,
  });
  const abort = new AbortController();
  let reportFailed = false;
  const disconnect = subscribeJobs(
    (connection) => {
      const update = presentation.update(connection);
      if (!update) return;
      if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
      const text = process.stdout.isTTY
        ? jobsViewport(update.text, process.stdout.columns, process.stdout.rows)
        : update.text;
      process.stdout.write(`${text}\n`);
      void (async () => {
        try {
          const current = expectResult(
            await input.herdr.call(
              "pane.get",
              { pane_id: pane.pane_id },
              { ...options, signal: abort.signal },
            ),
            "pane_info",
          ).pane;
          if (
            current.terminal_id !== presentation.pane.terminal_id ||
            current.tokens?.dstack_jobs_owner !== owner
          ) {
            stop();
            return;
          }
          expectResult(
            await input.herdr.call("pane.report_metadata", update.metadata, {
              ...options,
              signal: abort.signal,
            }),
            "ok",
          );
          if (env.DSTACK_HERDR_NOTIFY === "1") {
            for (const notification of update.notifications)
              await input.herdr.call("notification.show", notification, {
                ...options,
                signal: abort.signal,
              });
          }
          reportFailed = false;
        } catch {
          if (!abort.signal.aborted && !reportFailed)
            process.stderr.write("Herdr display unavailable; jobs are unchanged.\n");
          reportFailed = true;
        }
      })();
    },
    { socket: socketPath(env) },
  );
  const stop = () => {
    presentation.close();
    disconnect();
    abort.abort();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGHUP", stop);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.on("SIGHUP", stop);
}
