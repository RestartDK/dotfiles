import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { DurableHost } from "#durable-host";
import {
  frames,
  HostError,
  HOST_VERSION,
  MAX_FRAME_BYTES,
  parseEnvelope,
  parseOperation,
  writeFrame,
} from "#host-protocol";

export async function serveHost(
  host: DurableHost,
  input: Readable,
  output: Writable,
): Promise<void> {
  let closing: Promise<void> | undefined;
  const seal = () => {
    closing ??= host.close();
    void closing.catch(() => undefined);
  };
  input.once("end", seal);
  input.once("close", seal);
  const brokenOutput = () => {
    seal();
    input.destroy();
  };
  output.once("error", brokenOutput);
  try {
    await writeFrame(output, {
      v: HOST_VERSION,
      type: "ready",
      identity: host.config.identity,
      bootId: randomUUID(),
      maxFrameBytes: MAX_FRAME_BYTES,
      maxInFlight: 1,
      tools: ["read", "write", "edit"],
    });
    for await (const frame of frames(input)) {
      const request = parseEnvelope(frame);
      try {
        const result = await host.handle(parseOperation(request.operation));
        await writeFrame(output, { v: HOST_VERSION, id: request.id, result });
      } catch (error) {
        await writeFrame(output, {
          v: HOST_VERSION,
          id: request.id,
          error: {
            code: error instanceof HostError ? error.code : "operation_failed",
            message: error instanceof Error ? error.message : "Host operation failed",
          },
        });
      }
    }
  } finally {
    seal();
    try {
      await closing;
    } finally {
      input.removeListener("end", seal);
      input.removeListener("close", seal);
      output.removeListener("error", brokenOutput);
    }
  }
}
