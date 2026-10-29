import { lstat, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function absolutePath(value: string): string {
  if (!value.isWellFormed() || value.includes("\0") || !isAbsolute(value) || Buffer.byteLength(value) > 4095)
    throw new Error("Invalid workspace file path");
  return resolve(value);
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function canonicalBoundary(path: string): Promise<string> {
  let candidate = path;
  const suffix: string[] = [];
  let links = 0;
  for (;;) {
    try { return resolve(await realpath(candidate), ...suffix); }
    catch (error) {
      if (!missing(error) || dirname(candidate) === candidate) throw error;
      const info = await lstat(candidate).catch(cause => { if (missing(cause)) return undefined; throw cause; });
      if (info?.isSymbolicLink()) {
        if (++links > 40) throw new Error("Protected file reference has too many symbolic links");
        candidate = resolve(dirname(candidate), await readlink(candidate));
      } else {
        suffix.unshift(basename(candidate));
        candidate = dirname(candidate);
      }
    }
  }
}

export class WorkspacePaths {
  private constructor(readonly cwd: string, private readonly protectedPaths: readonly string[]) {}

  static async open(options: { readonly cwd: string; readonly protectedPaths: readonly string[] }): Promise<WorkspacePaths> {
    const cwd = absolutePath(options.cwd);
    if (await realpath(cwd) !== cwd || !(await lstat(cwd)).isDirectory())
      throw new Error("Workspace file root must be a canonical directory");
    const protectedPaths = new Set<string>();
    for (const input of options.protectedPaths) {
      const path = absolutePath(input);
      await canonicalBoundary(path);
      protectedPaths.add(path);
    }
    return new WorkspacePaths(cwd, [...protectedPaths]);
  }

  async check(path: string, access: "read" | "write"): Promise<string> {
    const target = absolutePath(path);
    if (!contains(this.cwd, target)) throw new Error("File path escapes its coding workspace");
    for (const declared of this.protectedPaths) {
      for (const protectedPath of new Set([declared, await canonicalBoundary(declared)]))
        if (contains(protectedPath, target) || (access === "write" && contains(target, protectedPath)))
          throw new Error("File path belongs to protected host control or authorization state");
    }
    if (await realpath(this.cwd) !== this.cwd || !(await lstat(this.cwd)).isDirectory())
      throw new Error("Workspace file root changed");
    let candidate = this.cwd;
    const suffix = relative(this.cwd, target);
    if (suffix === "") {
      if (access === "write") throw new Error("File mutation requires a regular file target");
      return target;
    }
    const components = suffix.split(sep);
    for (const [index, component] of components.entries()) {
      candidate = join(candidate, component);
      let info: Awaited<ReturnType<typeof lstat>>;
      try { info = await lstat(candidate); }
      catch (error) { if (missing(error)) return target; throw error; }
      if (info.isSymbolicLink()) throw new Error("Workspace file paths cannot follow symbolic links");
      if (info.isFile() && info.nlink !== 1) throw new Error("Workspace file paths cannot use hard-linked aliases");
      if (index !== components.length - 1) {
        if (!info.isDirectory()) throw new Error("Workspace file parent is not a directory");
      } else if (!info.isFile() && !(access === "read" && info.isDirectory())) {
        throw new Error("Workspace file target has an unsupported kind");
      }
    }
    return target;
  }
}
