import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, statfs } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { acquireLock } from "./lock.js";
import type { Command } from "./process.js";

export function missingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function entry(name: string): string {
  if (!/^[a-zA-Z0-9.-]{1,128}$/.test(name) || name === "." || name === "..")
    throw new Error("Invalid command evidence entry");
  return name;
}

async function directoryPath(path: string): Promise<string> {
  if (!isAbsolute(path) || !path.isWellFormed() || path.includes("\0"))
    throw new Error("Command evidence directory must be an absolute UTF-8 path");
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Error("Command evidence directory must be private and user-owned");
  const canonical = await realpath(path);
  const filesystem = await statfs(canonical, { bigint: true });
  if ([0x6969n, 0xff534d42n, 0x517bn].includes(BigInt.asUintN(32, filesystem.type)))
    throw new Error("Network command evidence storage is unsupported");
  return canonical;
}

type WriterState =
  | { readonly kind: "open"; tail: Promise<void> }
  | { readonly kind: "closing"; readonly completion: Promise<void> };

class CommandWriter {
  #state: WriterState = { kind: "open", tail: Promise.resolve() };

  constructor(private readonly unlock: () => Promise<void>) {}

  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#state.kind !== "open") return Promise.reject(new Error("Command evidence writer is closed"));
    const pending = this.#state.tail.then(operation);
    this.#state.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  close(): Promise<void> {
    if (this.#state.kind === "closing") return this.#state.completion;
    const completion = this.#state.tail.then(this.unlock);
    this.#state = { kind: "closing", completion };
    return completion;
  }
}

export class CommandDirectory {
  private constructor(readonly path: string, private readonly writer: CommandWriter) {}

  static async own(options: { readonly path: string; readonly lockCommand: Command }) {
    const canonical = await directoryPath(options.path);
    const writer = new CommandWriter(await acquireLock(canonical, options.lockCommand, { name: "writer.lock", waitSeconds: 0 }));
    const directory = new CommandDirectory(canonical, writer);
    try {
      await directory.read("writer.lock", 1);
      return { directory, close: () => writer.close() };
    } catch (error) {
      try { await writer.close(); }
      catch (closeError) { throw new AggregateError([error, closeError], "Command evidence ownership failed"); }
      throw error;
    }
  }

  async child(name: string, creation: "new" | "existing"): Promise<CommandDirectory> {
    const path = join(this.path, entry(name));
    if (creation === "new") await this.writer.run(async () => {
      await mkdir(path, { mode: 0o700 });
      await this.sync();
    });
    return new CommandDirectory(await directoryPath(path), this.writer);
  }

  async sync(): Promise<void> {
    const directory = await open(this.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  async read(name: string, limit: number): Promise<string> {
    const file = await open(join(this.path, entry(name)), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.nlink !== 1)
        throw new Error("Command evidence file must be private, single-linked and user-owned");
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (read.bytesRead === 0) break;
        length += read.bytesRead;
      }
      if (length > limit) throw new Error("Command evidence file too large");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
  }

  async optional(name: string, limit: number): Promise<string | undefined> {
    try { return await this.read(name, limit); }
    catch (error) { if (missingFile(error)) return undefined; throw error; }
  }

  private async writeNew(name: string, bytes: string): Promise<void> {
    const file = await open(join(this.path, entry(name)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await this.sync();
  }

  create(name: string, bytes: string): Promise<void> {
    return this.writer.run(() => this.writeNew(name, bytes));
  }

  publish(name: string, bytes: string): Promise<void> {
    return this.writer.run(async () => {
      const destination = entry(name);
      if (await this.optional(destination, 128 * 1024) !== undefined)
        throw new Error("Command evidence already exists");
      const temporary = `.${destination}.${randomBytes(8).toString("hex")}.pending`;
      await this.writeNew(temporary, bytes);
      await rename(join(this.path, temporary), join(this.path, destination));
      await this.sync();
    });
  }
}
