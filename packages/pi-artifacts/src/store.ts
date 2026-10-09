import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readBounded, pngSize } from "./io.js";
import {
  integer,
  limits,
  safeText,
  type ArtifactInput,
  type ArtifactSnapshot,
  type PngReference,
  type SnapshotImage,
} from "./model.js";
import { bunExecutable } from "./runtime.js";

export function stateDirectory(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (/[\p{Cc}\p{Cf}]/u.test(base)) throw new Error("State path contains control characters");
  if (!isAbsolute(base)) throw new Error("XDG_STATE_HOME must be absolute");
  const path = join(base, "pi", "artifacts", "v1");
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const realAncestor = realpathSync(ancestor);
  if (realAncestor.startsWith("/nix/store/"))
    throw new Error("Artifact state cannot be in the Nix store");
  for (let directory = realAncestor; ; directory = dirname(directory)) {
    if (existsSync(join(directory, ".git")))
      throw new Error("Artifact state cannot be in a Git checkout; change XDG_STATE_HOME");
    if (directory === dirname(directory)) break;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

export function snapshotPath(directory: string, image: PngReference): string {
  return join(directory, `${image.id}.png`);
}

function loadReference(directory: string, image: PngReference, maxBytes: number): Buffer {
  const png = readBounded(snapshotPath(directory, image), maxBytes);
  if (createHash("sha256").update(png).digest("hex") !== image.id)
    throw new Error("Snapshot content changed");
  const size = pngSize(png);
  if (size.width !== image.width || size.height !== image.height)
    throw new Error("Snapshot dimensions changed");
  return png;
}

export function loadSnapshot(directory: string, image: PngReference): Buffer {
  return loadReference(directory, image, limits.fileBytes);
}

export function loadThumbnail(directory: string, image: SnapshotImage): Buffer {
  return loadReference(directory, image.thumbnail, limits.thumbnailBytes);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function renderFile(path: string, signal?: AbortSignal): Promise<Buffer> {
  const executable = bunExecutable;
  if (!executable)
    throw new Error("Pinned Bun runtime is not configured. Build pi-artifacts with Nix.");
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [fileURLToPath(new URL("./worker.js", import.meta.url)), path],
      {
        encoding: "buffer",
        maxBuffer: limits.fileBytes + limits.thumbnailBytes + 8,
        timeout: limits.workerMs,
        killSignal: "SIGKILL",
        signal,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        let message: string;
        if (signal?.aborted || error.name === "AbortError") message = "Artifact worker cancelled";
        else if (error.code === "ENOENT")
          message = `Pinned Bun runtime missing: ${executable}. Rebuild pi-artifacts with Nix`;
        else if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
          message = "Artifact worker output limit exceeded";
        else if (error.killed && error.signal === "SIGKILL")
          message = "Artifact worker timed out after 15 seconds";
        else message = `Artifact rendering failed. ${stderr.toString("utf8") || error.message}`;
        reject(new Error(safeText(message.slice(0, 1000), 1000), { cause: error }));
      },
    );
  });
}

function workerImages(output: Buffer) {
  if (output.length < 8) throw new Error("Incomplete artifact worker output");
  const originalBytes = integer(output.readUInt32BE(0), 33, limits.fileBytes);
  const thumbnailBytes = integer(output.readUInt32BE(4), 33, limits.thumbnailBytes);
  if (output.length !== 8 + originalBytes + thumbnailBytes)
    throw new Error("Invalid artifact worker output length");
  function image(png: Buffer) {
    return {
      png,
      reference: { id: createHash("sha256").update(png).digest("hex"), ...pngSize(png) },
    };
  }
  const original = image(output.subarray(8, 8 + originalBytes));
  const thumbnail = image(output.subarray(8 + originalBytes));
  integer(thumbnail.reference.width, 1, limits.thumbnailWidth);
  integer(thumbnail.reference.height, 1, limits.thumbnailHeight);
  return { original, thumbnail };
}

async function publish(
  directory: string,
  image: { png: Buffer; reference: PngReference },
  signal?: AbortSignal,
): Promise<void> {
  const target = snapshotPath(directory, image.reference);
  const temporary = join(directory, `${randomUUID()}.tmp`);
  const lock = join(directory, `${image.reference.id}.lock`);
  let temporaryOwned = false;
  let lockOwned = false;
  let fd: number | undefined;
  const errors: unknown[] = [];
  try {
    fd = openSync(temporary, "wx", 0o400);
    temporaryOwned = true;
    writeFileSync(fd, image.png);
    closeSync(fd);
    fd = undefined;
    const deadline = Date.now() + limits.workerMs;
    while (!lockOwned) {
      signal?.throwIfAborted();
      try {
        mkdirSync(lock, { mode: 0o700 });
        lockOwned = true;
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        if (Date.now() >= deadline)
          throw new Error(
            `Snapshot publication busy. Retry; if its writer crashed, remove the abandoned lock directory ${lock}`,
          );
        await setTimeout(10, undefined, { signal });
      }
    }
    try {
      linkSync(temporary, target);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      const existing = lstatSync(target);
      if (!existing.isFile() || (process.getuid && existing.uid !== process.getuid()))
        throw new Error("Refusing to replace an unowned or non-regular snapshot target");
      const valid =
        existing.size <= limits.fileBytes &&
        createHash("sha256").update(readBounded(target, limits.fileBytes)).digest("hex") ===
          image.reference.id;
      if (!valid) renameSync(temporary, target);
      if (!valid) temporaryOwned = false;
    }
  } catch (error) {
    errors.push(error);
  }
  for (const cleanup of [
    () => {
      if (fd !== undefined) closeSync(fd);
    },
    () => {
      if (temporaryOwned) unlinkSync(temporary);
    },
    () => {
      if (lockOwned) rmdirSync(lock);
    },
  ]) {
    try {
      cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Snapshot publication or cleanup failed", {
      cause: errors[0],
    });
}

export async function createSnapshot(
  input: ArtifactInput,
  cwd: string,
  directory: string,
  signal?: AbortSignal,
): Promise<ArtifactSnapshot> {
  const groups: ArtifactSnapshot["groups"] = [];
  for (const group of input.groups) {
    const images: SnapshotImage[] = [];
    for (const image of group.images) {
      signal?.throwIfAborted();
      const prepared = workerImages(await renderFile(resolve(cwd, image.path), signal));
      await publish(directory, prepared.original, signal);
      await publish(directory, prepared.thumbnail, signal);
      images.push({
        ...prepared.original.reference,
        caption: image.caption,
        thumbnail: prepared.thumbnail.reference,
      });
    }
    groups.push({ title: group.title, images });
  }
  return { version: 1, maxWidthCells: input.maxWidthCells, groups };
}
