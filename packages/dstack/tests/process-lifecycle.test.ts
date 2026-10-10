import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessFailure, releaseProcess, run } from "../src/process.ts";

for (const exitCode of [0, 7]) {
  test(`direct exit ${exitCode} cannot leave a detached inherited-pipe descendant running`, async () => {
    const root = await mkdtemp(join(tmpdir(), "dstack-process-"));
    const token = randomBytes(24).toString("hex");
    const node = process.env.DSTACK_TEST_NODE || process.execPath;
    const childScript = `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']});writeFileSync(${JSON.stringify(join(root, "pid"))},String(child.pid));process.exit(${exitCode});`;
    try {
      let failure: unknown;
      try {
        await run({ file: node, args: ["-e", childScript] }, [], {
          cwd: root,
          signal: new AbortController().signal,
          timeoutMs: exitCode === 0 ? 1000 : 5000,
          token,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ProcessFailure);
      if (!(failure instanceof ProcessFailure)) throw new Error("Expected bounded process failure");
      expect(failure.category).toBe(exitCode === 0 ? "deadline" : "exit");
      const pid = Number(await readFile(join(root, "pid"), "utf8"));
      let alive = false;
      try {
        const stat = await readFile(`/proc/${pid}/stat`, "utf8");
        alive = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
      } catch (error) {
        if (
          !(
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      expect(alive).toBe(false);
    } finally {
      await releaseProcess(token);
      await rm(root, { recursive: true });
    }
  }, 15_000);
}
