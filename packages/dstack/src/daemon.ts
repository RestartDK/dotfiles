#!/usr/bin/env node
import { defaultConfig, startDaemon } from "./server.js";

if (process.argv.includes("--help")) {
  console.log(
    "dstackd\nPrivate Linux PR job daemon. Configuration: DSTACK_STATE_DIR, DSTACK_SOCKET, DSTACK_WORKTREE_ROOT, DSTACK_PI, DSTACK_OBSERVER, DSTACK_GH, DSTACK_GIT, XDG_CONFIG_HOME.",
  );
} else {
  try {
    const daemon = await startDaemon(defaultConfig());
    const shutdown = () => {
      void daemon.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    console.log("dstackd ready");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "dstackd startup failed");
    process.exitCode = 1;
  }
}
