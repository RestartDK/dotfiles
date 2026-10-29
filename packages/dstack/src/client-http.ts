import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { ClientError } from "#client-authority";
import { ClientCursorError } from "#client-history";
import { CLIENT_VERSION, MAX_CLIENT_EVENT_BYTES, MAX_CLIENT_REQUEST_BYTES, parseClientHeader, parseClientOperation } from "#client-protocol";
import { CLIENT_RESOURCES, ClientDataError, clientFrame } from "#client-wire";
import { DurableHost, type ClientObservation } from "#durable-host";
import { HostError } from "#host-protocol";

class ClientTransportError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let i = 0; i < request.rawHeaders.length; i += 2)
    if (request.rawHeaders[i]?.toLowerCase() === name) { const value = request.rawHeaders[i + 1]; if (value !== undefined) values.push(value); }
  if (values.length > 1) throw new ClientTransportError("invalid_request", "Duplicate client header", 400);
  return values[0];
}

function clientFailure(error: unknown) {
  if (error instanceof ClientError) return { status: error.code === "unauthenticated" ? 401 : error.code === "scope_denied" ? 403 : 400, code: error.code, message: error.message };
  if (error instanceof ClientCursorError) return { status: 409, code: error.code, message: error.message };
  if (error instanceof ClientDataError) return { status: error.code === "view_too_large" ? 413 : 500, code: error.code, message: error.message };
  if (error instanceof ClientTransportError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof HostError) return { status: error.code === "busy" || error.code === "request_conflict" ? 409 : error.code === "capacity" ? 429 : error.code === "unavailable" ? 503 : error.code === "not_found" ? 404 : 400, code: error.code, message: error.message };
  return { status: 500, code: "operation_failed", message: "Client operation failed" };
}

function body(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error) => {
      clearTimeout(timer); request.removeListener("data", data); request.removeListener("end", end); request.removeListener("error", failed); request.removeListener("aborted", aborted);
      if (error !== undefined) { request.pause(); reject(error); }
    };
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_CLIENT_REQUEST_BYTES) return finish(new ClientTransportError("request_too_large", "Client request exceeds byte limit", 413));
      chunks.push(chunk);
    };
    const end = () => {
      finish();
      try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)))); }
      catch { reject(new ClientTransportError("invalid_request", "Client request is not UTF8 JSON", 400)); }
    };
    const failed = () => finish(new ClientTransportError("detached", "Client connection ended", 400));
    const aborted = () => failed();
    const timer = setTimeout(() => finish(new ClientTransportError("request_timeout", "Client request timed out before admission", 408)), CLIENT_RESOURCES.requestMs);
    request.on("data", data); request.once("end", end); request.once("error", failed); request.once("aborted", aborted);
  });
}

function write(response: ServerResponse, frame: string, end = false): Promise<void> {
  if (response.destroyed || response.writableEnded) return Promise.reject(new ClientTransportError("detached", "Client connection ended", 400));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); response.removeListener("error", failed); response.removeListener("close", closed); };
    const failed = () => { cleanup(); reject(new ClientTransportError("detached", "Client writer ended", 400)); };
    const closed = () => failed();
    const timer = setTimeout(() => { cleanup(); response.destroy(); reject(new ClientTransportError("backpressure_timeout", "Client did not drain its response", 408)); }, CLIENT_RESOURCES.backpressureMs);
    response.once("error", failed); response.once("close", closed);
    const complete = (error?: Error | null) => { if (error) return failed(); cleanup(); resolve(); };
    if (end) response.end(frame, () => complete()); else response.write(frame, complete);
  });
}

function eventFrame(value: unknown): string {
  const data = clientFrame(value);
  if (Buffer.byteLength(data) + 7 > MAX_CLIENT_EVENT_BYTES) throw new ClientDataError("view_too_large", "Client event exceeds byte limit; reconnect or use paged history");
  return `data: ${data}\n`;
}

export class ClientServer {
  readonly #server = createServer({ maxHeaderSize: CLIENT_RESOURCES.headerBytes, connectionsCheckingInterval: CLIENT_RESOURCES.headerCheckMs }, (request, response) => {
    if (this.#requests.size >= CLIENT_RESOURCES.connections) { response.destroy(); return; }
    const pending = this.handle(request, response);
    this.#requests.add(pending);
    void pending.then(() => this.#requests.delete(pending), error => {
      this.#requests.delete(pending);
      this.#failure ??= error instanceof Error ? error : new Error("Client cleanup failed");
      this.seal();
    });
  });
  readonly #requests = new Set<Promise<void>>();
  readonly #reading = new Set<IncomingMessage>();
  readonly #viewers = new Set<ClientObservation>();
  #state: "open" | "sealed" = "open";
  #listenerClosed: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #origin = "";
  #host = "";
  #failure: Error | undefined;

  private constructor(private readonly host: DurableHost, private readonly assets: ReadonlyMap<string, { readonly body: string; readonly type: string }>) {
    this.#server.maxConnections = CLIENT_RESOURCES.connections;
    this.#server.maxRequestsPerSocket = CLIENT_RESOURCES.requestsPerSocket;
    this.#server.headersTimeout = CLIENT_RESOURCES.requestMs;
    this.#server.requestTimeout = CLIENT_RESOURCES.requestMs;
    this.#server.on("dropRequest", (_request, socket) => socket.destroy());
    this.#server.on("clientError", (_error, socket) => socket.destroy());
  }

  static async open(host: DurableHost): Promise<ClientServer> {
    const listen = host.config.execution?.clients?.listen;
    if (listen === undefined) throw new HostError("unavailable", "Authenticated clients are not configured");
    const assets = new Map<string, { readonly body: string; readonly type: string }>();
    const definitions = [["/", "index.html", "text/html; charset=utf-8"], ["/client.js", "client.js", "text/javascript; charset=utf-8"], ["/client.css", "client.css", "text/css; charset=utf-8"]] satisfies readonly (readonly [string, string, string])[];
    for (const [route, file, type] of definitions) {
      const body = await readFile(new URL(`./client/${file}`, import.meta.url), "utf8");
      if (Buffer.byteLength(body) > 256 * 1024) throw new Error("Client asset exceeds byte limit");
      assets.set(route, { body, type });
    }
    const server = new ClientServer(host, assets);
    host.registerClientIngress(server);
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => reject(error);
        server.#server.once("error", failed);
        server.#server.listen({ host: listen.host, port: listen.port, exclusive: true }, () => { server.#server.removeListener("error", failed); resolve(); });
      });
      server.#server.on("error", error => { server.#failure ??= error; server.seal(); });
      const address = server.#server.address();
      if (address === null || typeof address === "string") throw new Error("Client listener has no loopback address");
      const endpoint = new URL(`http://127.0.0.1:${address.port}`);
      server.#origin = endpoint.origin; server.#host = endpoint.host;
      return server;
    } catch (error) { await server.close(); throw error; }
  }

  get endpoint(): string { return this.#origin; }

  private headers(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "close");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let id: string | null = null;
    let observation: ClientObservation | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    const detached = () => { if (observation !== undefined) void observation.stop().catch(() => undefined); };
    response.once("close", detached);
    try {
      this.headers(response);
      if (this.#state !== "open") throw new ClientTransportError("unavailable", "Client admission is sealed", 503);
      if (header(request, "host") !== this.#host) throw new ClientTransportError("invalid_host", "Client Host is not the configured loopback endpoint", 403);
      const origin = header(request, "origin");
      if (origin !== undefined && origin !== this.#origin) throw new ClientTransportError("invalid_origin", "Client Origin is not this endpoint", 403);
      const asset = request.method === "GET" ? this.assets.get(request.url ?? "") : undefined;
      if (asset !== undefined) {
        response.setHeader("Content-Type", asset.type);
        await write(response, asset.body, true); return;
      }
      if (request.method !== "POST" || request.url !== "/v1") throw new ClientTransportError("not_found", "Unknown client route", 404);
      if (header(request, "content-type") !== "application/json") throw new ClientTransportError("invalid_request", "Client requests require application/json", 415);
      const authorization = header(request, "authorization");
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      this.#reading.add(request);
      const input = await body(request); this.#reading.delete(request);
      const envelope = parseClientHeader(input); id = envelope.id;
      const operation = parseClientOperation(envelope.operation);
      if (this.#state !== "open" || response.destroyed) throw new ClientTransportError("unavailable", "Client admission is sealed", 503);
      lifetime = setTimeout(() => response.destroy(), CLIENT_RESOURCES.operationMs);
      const result = await this.host.client({ token, operation });
      if (result.kind === "reply") {
        const frame = clientFrame({ v: CLIENT_VERSION, id, result: result.result });
        response.setHeader("Content-Type", "application/json"); await write(response, frame, true); return;
      }
      observation = result.observation;
      clearTimeout(lifetime);
      if (this.#state !== "open") throw new ClientTransportError("unavailable", "Client admission is sealed", 503);
      if (response.destroyed) return;
      const retirement = new Promise<{ readonly reason: "retired" }>(resolve => { lifetime = setTimeout(() => resolve({ reason: "retired" }), CLIENT_RESOURCES.viewerMs); });
      const baseline = eventFrame({ v: CLIENT_VERSION, id, event: observation.snapshot });
      this.#viewers.add(observation);
      response.setHeader("Content-Type", "text/event-stream");
      await write(response, baseline);
      if (this.#state === "open" && !response.destroyed) observation.start(event => write(response, eventFrame({ v: CLIENT_VERSION, id, event })));
      else await observation.stop();
      const end = await Promise.race([observation.closed, retirement]);
      await observation.stop();
      if (!response.destroyed) {
        const failure = end.reason === "listener_error" ? clientFailure(end.error) : undefined;
        await write(response, eventFrame({ v: CLIENT_VERSION, id, ...(failure === undefined ? { end: end.reason } : { error: { code: failure.code, message: failure.message } }) }), true);
      }
    } catch (error) {
      const failure = clientFailure(error);
      if (!response.destroyed && !response.writableEnded) {
        if (!response.headersSent) { response.statusCode = failure.status; response.setHeader("Content-Type", "application/json"); }
        const value = { v: CLIENT_VERSION, id, error: { code: failure.code, message: failure.message } };
        const streaming = response.headersSent && response.getHeader("Content-Type") === "text/event-stream";
        try { await write(response, streaming ? eventFrame(value) : clientFrame(value), true); } catch { response.destroy(); }
      }
    } finally {
      clearTimeout(lifetime); this.#reading.delete(request); response.removeListener("close", detached);
      if (observation !== undefined) { this.#viewers.delete(observation); await observation.stop(); }
      if (!request.complete) request.destroy();
    }
  }

  seal(): void {
    if (this.#state === "sealed") return;
    this.#state = "sealed";
    this.#listenerClosed = new Promise((resolve, reject) => this.#server.close(error => {
      if (error !== undefined && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) reject(error); else resolve();
    }));
    void this.#listenerClosed.catch(() => undefined);
    for (const request of this.#reading) request.destroy();
    this.#server.closeIdleConnections();
  }

  close(): Promise<void> {
    this.#closing ??= (async () => {
      this.seal();
      const views = await Promise.allSettled([...this.#viewers.keys()].map(view => view.stop()));
      const requests = await Promise.allSettled([...this.#requests]);
      await this.#listenerClosed;
      const errors = [...views, ...requests].flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (this.#failure !== undefined) errors.push(this.#failure);
      if (errors.length !== 0) throw new AggregateError(errors, "Client ingress cleanup failed", { cause: errors[0] });
    })();
    return this.#closing;
  }
}
