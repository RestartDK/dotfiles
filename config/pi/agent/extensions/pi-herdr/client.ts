import net from "node:net";

import type { ErrorResponse } from "./generated/error-response.ts";
import type { Request } from "./generated/request.ts";
import type { ResponseResult, SuccessResponse } from "./generated/success-response.ts";

type Method = Request["method"];
type RequestFor<M extends Method> = Extract<Request, { method: M }>;
export type ParamsFor<M extends Method> = RequestFor<M>["params"];
export type ResultOfType<K extends ResponseResult["type"]> = Extract<ResponseResult, { type: K }>;

interface CallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class HerdrRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrRequestError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown, expectedId: string): ResponseResult {
  if (!isRecord(value) || value.id !== expectedId) {
    throw new Error("Herdr returned an invalid or mismatched response envelope");
  }

  if ("error" in value) {
    const response = value as unknown as ErrorResponse;
    throw new HerdrRequestError(
      response.error.code,
      response.error.message || response.error.code || "Herdr request failed",
    );
  }

  const response = value as unknown as SuccessResponse;
  if (!isRecord(response.result) || typeof response.result.type !== "string") {
    throw new Error("Herdr returned an invalid success response");
  }
  return response.result;
}

export function expectResult<K extends ResponseResult["type"]>(
  result: ResponseResult,
  expected: K,
): ResultOfType<K> {
  if (result.type !== expected) {
    throw new Error(`Expected Herdr result '${expected}', received '${result.type}'`);
  }
  return result as ResultOfType<K>;
}

export class HerdrClient {
  readonly #endpoint: string;
  #requestId = 0;

  constructor(socketPath: string) {
    this.#endpoint = process.platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
  }

  call<M extends Method>(
    method: M,
    params: ParamsFor<M>,
    options: CallOptions = {},
  ): Promise<ResponseResult> {
    const id = `pi-herdr:${process.pid}:${Date.now()}:${++this.#requestId}`;
    const request = { id, method, params } as RequestFor<M>;

    return new Promise((resolve, reject) => {
      let settled = false;
      let buffer = "";
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const socket = net.createConnection(this.#endpoint);

      const finish = (error?: Error, result?: ResponseResult) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(result!);
      };

      const onAbort = () => finish(new Error("Aborted"));
      if (options.signal?.aborted) {
        finish(new Error("Aborted"));
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (options.timeoutMs != null) {
        timeout = setTimeout(
          () => finish(new Error(`Herdr request '${method}' timed out`)),
          options.timeoutMs,
        );
        timeout.unref?.();
      }

      socket.setEncoding("utf8");
      socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        try {
          finish(undefined, parseResponse(JSON.parse(buffer.slice(0, newline)), id));
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () =>
        finish(new Error(`Herdr closed the socket before replying to '${method}'`)),
      );
    });
  }
}
