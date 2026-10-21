import { realpath } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function withinScope(path: string): boolean {
  return (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !path.split(sep).some((p) => [".git", ".pi", ".github", ".gitmodules"].includes(p))
  );
}
export async function allowedPath(root: string, input: string): Promise<boolean> {
  const absolute = resolve(root, input);
  if (!withinScope(relative(root, absolute))) return false;
  let candidate = absolute;
  while (true) {
    try {
      const actual = await realpath(candidate);
      return withinScope(relative(root, actual));
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      )
        return false;
      const parent = dirname(candidate);
      if (parent === candidate) return false;
      candidate = parent;
    }
  }
}
export default function workerGuard(pi: ExtensionAPI): void {
  let calls = 0;
  pi.on("session_start", (_event, ctx) => {
    if (
      `${ctx.model?.provider}/${ctx.model?.id}` !== process.env.DSTACK_EXPECTED_MODEL ||
      pi.getThinkingLevel() !== process.env.DSTACK_EXPECTED_THINKING ||
      !["triage", "repair"].includes(process.env.DSTACK_WORK_KIND ?? "")
    ) {
      process.stderr.write("Scoped worker startup policy mismatch\n");
      process.exit(78);
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    if (++calls > 80) return { block: true, reason: "Worker tool budget exhausted" };
    if (
      `${ctx.model?.provider}/${ctx.model?.id}` !== process.env.DSTACK_EXPECTED_MODEL ||
      pi.getThinkingLevel() !== process.env.DSTACK_EXPECTED_THINKING
    )
      return { block: true, reason: "Worker model/thinking does not match policy" };
    const permitted =
      process.env.DSTACK_WORK_KIND === "triage"
        ? ["read", "grep", "find", "ls"]
        : ["read", "grep", "find", "ls", "edit", "write"];
    if (!permitted.includes(event.toolName))
      return { block: true, reason: "Only scoped file tools are permitted" };
    const path = "path" in event.input ? event.input.path : ".";
    if (typeof path !== "string" || !(await allowedPath(await realpath(ctx.cwd), path)))
      return { block: true, reason: "Path is outside the owned repair scope" };
    return undefined;
  });
}
