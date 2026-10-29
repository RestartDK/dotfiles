import { defineDoc } from "@earendil-works/pi-durable";

export const ExecutionRootDoc = defineDoc<{ rootJson: string | null }>({
  kind: "herdr.execution-root",
  version: 1,
  scope: "session",
  initial: () => ({ rootJson: null }),
});
