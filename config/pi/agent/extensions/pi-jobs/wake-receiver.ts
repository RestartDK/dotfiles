import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { callWatches, type WatchView } from "../../lib/dstack-watches.ts";
import { isRecord } from "../../lib/model-policy.ts";

export const wakeMessageType = "dstack-wake";
export type WakeReceipt = { watchId: string; sessionId: string; token: string };
export function wakeReceipt(entries: Iterable<unknown>, watch: WatchView): string | undefined {
  if (watch.state.kind !== "delivering" && watch.state.kind !== "delivered") return undefined;
  for (const entry of entries)
    if (
      isRecord(entry) &&
      entry.type === "custom_message" &&
      entry.customType === wakeMessageType &&
      typeof entry.id === "string" &&
      isRecord(entry.details) &&
      entry.details.watchId === watch.id &&
      entry.details.sessionId === watch.sessionId &&
      entry.details.token === watch.state.token
    )
      return entry.id;
  return undefined;
}
async function persistedReceipt(file: string, watch: WatchView): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  for (const line of contents.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const entryId = wakeReceipt([entry], watch);
    if (entryId) return entryId;
  }
  return undefined;
}
export class WakeReceiver {
  readonly #sessionId: string;
  readonly #abort = new AbortController();
  #polling = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly ctx: {
      sessionManager: Pick<
        ExtensionContext["sessionManager"],
        "getSessionId" | "getSessionFile" | "getEntries"
      >;
      isIdle: ExtensionContext["isIdle"];
    },
    private readonly send: ExtensionAPI["sendMessage"],
    private readonly status: (reason: string | null) => void,
    private readonly call: typeof callWatches = callWatches,
  ) {
    this.#sessionId = ctx.sessionManager.getSessionId();
  }
  private attached(): boolean {
    return (
      !this.#abort.signal.aborted && this.ctx.sessionManager.getSessionId() === this.#sessionId
    );
  }
  start(): void {
    const poll = async () => {
      await this.tick();
      if (this.attached()) this.#timer = setTimeout(poll, 1000);
    };
    void poll();
  }
  stop(): void {
    this.#abort.abort();
    clearTimeout(this.#timer);
  }
  async tick(): Promise<void> {
    if (this.#polling || !this.attached()) return;
    this.#polling = true;
    try {
      const options = { signal: this.#abort.signal, timeoutMs: 5000 };
      const snapshot = await this.call({ op: "list", sessionId: this.#sessionId }, options);
      if (!this.attached()) return;
      this.status(null);
      const file = this.ctx.sessionManager.getSessionFile();
      if (!file) {
        this.status(
          "Scheduled wakes require a persistent native session; deliveries remain pending",
        );
        return;
      }
      let unresolved = false;
      for (const watch of snapshot.watches) {
        if (!this.attached()) return;
        if (watch.sessionId !== this.#sessionId || watch.state.kind !== "delivering") continue;
        const visible = wakeReceipt(this.ctx.sessionManager.getEntries(), watch);
        const entryId = visible ? await persistedReceipt(file, watch) : undefined;
        if (!this.attached()) return;
        if (entryId && entryId === visible)
          await this.call(
            {
              op: "ack",
              id: watch.id,
              sessionId: this.#sessionId,
              token: watch.state.token,
              entryId,
            },
            options,
          );
        else {
          unresolved = true;
          this.status(`Wake ${watch.id.slice(0, 8)} awaiting persisted receipt; replay blocked`);
        }
      }
      if (unresolved) return;
      for (const watch of snapshot.watches) {
        if (!this.attached()) return;
        if (
          watch.sessionId !== this.#sessionId ||
          watch.state.kind !== "pending" ||
          !this.ctx.isIdle()
        )
          continue;
        const token = randomUUID();
        const claimed = await this.call(
          { op: "begin", id: watch.id, sessionId: this.#sessionId, token },
          options,
        );
        if (!this.attached()) return;
        const current = claimed.watches.find((w) => w.id === watch.id);
        if (
          !current ||
          current.sessionId !== this.#sessionId ||
          current.state.kind !== "delivering" ||
          current.state.token !== token
        )
          throw new Error("Daemon did not confirm wake claim");
        if (!this.ctx.isIdle()) {
          this.status(
            `Wake ${watch.id.slice(0, 8)} claimed during activity; delivery blocked, not queued`,
          );
          return;
        }
        const details: WakeReceipt = { watchId: watch.id, sessionId: this.#sessionId, token };
        this.send(
          {
            customType: wakeMessageType,
            content: `Scheduled wake ${watch.id}\n${watch.message}\nResult: ${JSON.stringify(current.state.result)}`,
            display: true,
            details,
          },
          { triggerTurn: true },
        );
        return;
      }
    } catch (error) {
      if (this.attached())
        this.status(error instanceof Error ? error.message : "Wake receiver failed");
    } finally {
      this.#polling = false;
    }
  }
}
