import { CLIENT_RESOURCES, CLIENT_VERSION, MAX_CLIENT_CONTENT_BYTES, MAX_CLIENT_REQUEST_BYTES } from "../src/client-limits.js";
import { ClientReadError, clientMessages, clientRecord } from "../src/client-reader.js";

type Grant = { readonly workspaceId: string; readonly permissions: readonly string[] };
type Session = { readonly token: string; readonly grants: readonly Grant[] };
const encoder = new TextEncoder(), displayBytes = 256 * 1024;
function element(id: string): HTMLElement { const value = document.getElementById(id); if (value === null) throw new Error("Missing console element"); return value; }
function input(id: string): HTMLInputElement { const value = element(id); if (!(value instanceof HTMLInputElement)) throw new Error("Invalid console input"); return value; }
function button(id: string): HTMLButtonElement { const value = element(id); if (!(value instanceof HTMLButtonElement)) throw new Error("Invalid console button"); return value; }
function select(id: string): HTMLSelectElement { const value = element(id); if (!(value instanceof HTMLSelectElement)) throw new Error("Invalid console select"); return value; }
function textarea(id: string): HTMLTextAreaElement { const value = element(id); if (!(value instanceof HTMLTextAreaElement)) throw new Error("Invalid console textarea"); return value; }
const workspace = select("workspace"), content = textarea("content");
const credentialInput = input("credential"), key = input("request-key"), intent = input("intent");
let session: Session | undefined, login: object | undefined, busy = false, nextCursor: string | undefined;
let viewer: AbortController | undefined;
const requests = new Set<AbortController>();
const changes: string[] = [];

function notice(text: string, error = false): void { const node = element("notice"); node.textContent = text; node.dataset.state = error ? "error" : "normal"; }
function safeError(error: unknown): string { return error instanceof ClientReadError ? error.message : "Client operation failed or detached. Admission may be unknown; check the request key. No cancellation was sent."; }
function text(value: unknown, bytes: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0") || value.trim().length === 0 || encoder.encode(value).length > bytes) throw new ClientReadError("invalid_input", "Invalid credential or client input");
  return value;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = clientRecord(value); if (Object.keys(result).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(result, key))) throw new ClientReadError("invalid_credential", "Invalid credential file"); return result;
}
async function bearer(file: File): Promise<string> {
  if (file.size > 4096) throw new ClientReadError("invalid_credential", "Credential file exceeds byte limit");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer())); } catch { throw new ClientReadError("invalid_credential", "Credential file is not UTF8 JSON"); }
  const value = closed(parsed, ["version", "identity", "principalId", "secret"]), identity = closed(value.identity, ["deploymentId", "domain", "nodeId"]);
  if (value.version !== 1 || (identity.domain !== "work" && identity.domain !== "personal")) throw new ClientReadError("invalid_credential", "Unsupported credential file");
  text(value.principalId, 200);
  const secret = text(value.secret, 43);
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new ClientReadError("invalid_credential", "Invalid credential secret");
  const decoded = atob(secret.replaceAll("-", "+").replaceAll("_", "/") + "=");
  if (decoded.length !== 32 || btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "") !== secret) throw new ClientReadError("invalid_credential", "Invalid credential secret");
  const audience = JSON.stringify([text(identity.deploymentId, 200), identity.domain, text(identity.nodeId, 200)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(audience)));
  return `hpc1.${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}.${secret}`;
}
function pretty(value: unknown): string {
  const result = JSON.stringify(value, null, 2);
  if (result === undefined || encoder.encode(result).length > displayBytes) throw new ClientReadError("view_too_large", "View exceeds this console’s display budget. Detach and use paged history or the CLI; no partial baseline is displayed.");
  return result;
}
function selected(): string { return text(workspace.value, 200); }
function permission(name: string): boolean { return session?.grants.find(grant => grant.workspaceId === workspace.value)?.permissions.includes(name) ?? false; }
function controls(): void {
  workspace.disabled = session === undefined || busy;
  button("logout").disabled = session === undefined && login === undefined;
  for (const [id, scope] of [["open", "submit"], ["submit", "submit"], ["status", "read"], ["history", "read"], ["execution", "read"], ["abort", "abort"], ["cancel", "command.cancel"]] satisfies readonly (readonly [string, string])[]) {
    button(id).disabled = busy || !permission(scope);
  }
  button("older").disabled = busy || !permission("read") || nextCursor === undefined;
  button("watch").disabled = busy || !permission("read") || viewer !== undefined;
  button("detach").disabled = viewer === undefined;
  element("permissions").textContent = session?.grants.find(grant => grant.workspaceId === workspace.value)?.permissions.join(" · ") ?? "No permissions loaded.";
}
function detach(): void { const current = viewer; viewer = undefined; current?.abort(); element("viewer-state").textContent = "Detached · work not cancelled"; controls(); }
function clearViewer(): void {
  changes.length = 0;
  element("baseline").textContent = "No viewer attached."; element("changes").textContent = "No events.";
}
function clearViews(): void {
  nextCursor = undefined; clearViewer();
  element("history-view").textContent = "No history displayed."; element("reply").textContent = "No owner reply displayed. Query status using the request key.";
}
function forget(): void {
  login = undefined; session = undefined; busy = false; detach();
  for (const controller of requests) controller.abort();
  clearViews(); content.value = ""; intent.value = "";
  workspace.replaceChildren(new Option("Authenticate first", "")); element("identity").textContent = "Not authenticated"; credentialInput.value = ""; controls();
}
async function exchange(operation: Record<string, unknown>, token: string, controller: AbortController): Promise<{ response: Response; id: string }> {
  const id = crypto.randomUUID(), body = JSON.stringify({ v: CLIENT_VERSION, id, operation });
  if (encoder.encode(body).length > MAX_CLIENT_REQUEST_BYTES) throw new ClientReadError("request_too_large", "Encoded request exceeds byte limit");
  const response = await fetch("/v1", { method: "POST", mode: "same-origin", credentials: "omit", cache: "no-store", redirect: "error", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body, signal: controller.signal });
  return { response, id };
}
async function rpc(operation: Record<string, unknown>, token: string): Promise<unknown> {
  const controller = new AbortController(); requests.add(controller);
  const timer = setTimeout(() => controller.abort(), CLIENT_RESOURCES.operationMs);
  try {
    const { response, id } = await exchange(operation, token, controller);
    let value: unknown, received = false;
    for await (const message of clientMessages(response, id)) {
      if (message.kind === "error") throw new ClientReadError(message.code, message.message);
      if (message.kind !== "reply") throw new ClientReadError("invalid_response", "Expected a correlated owner reply");
      value = message.value; received = true;
    }
    if (!received) throw new ClientReadError("invalid_response", "Owner reply was missing"); return value;
  } finally { clearTimeout(timer); controller.abort(); requests.delete(controller); }
}
async function action(operation: Record<string, unknown>, history = false): Promise<void> {
  const current = session, scope = workspace.value; if (current === undefined || busy) return;
  busy = true; controls(); notice("Waiting for the existing owner. Disconnecting does not cancel an admitted operation.");
  try {
    const value = await rpc(operation, current.token);
    if (session !== current || workspace.value !== scope) return;
    const rendered = pretty(value);
    if (history) { const result = clientRecord(value); nextCursor = result.cursor === undefined ? undefined : text(result.cursor, 4096); element("history-view").textContent = rendered; }
    else element("reply").textContent = rendered;
    notice(operation.op === "submit" ? "Owner reply received. Admission is not business completion; inspect the receipt and request status." : "Owner reply received. Unknown outcomes remain unknown.");
  } catch (error) {
    if (session !== current || workspace.value !== scope) return;
    if (history) nextCursor = undefined;
    notice(safeError(error), true);
  } finally { if (session === current) { busy = false; controls(); } }
}
async function attach(): Promise<void> {
  const current = session; if (current === undefined || viewer !== undefined) return;
  const scope = selected(), controller = new AbortController(); viewer = controller; requests.add(controller);
  const timer = setTimeout(() => {
    if (session === current && viewer === controller) element("viewer-state").textContent = "Viewer expired locally · work not cancelled";
    controller.abort();
  }, CLIENT_RESOURCES.operationMs + CLIENT_RESOURCES.viewerMs);
  clearViewer(); controls(); element("viewer-state").textContent = "Acquiring fresh atomic snapshot";
  try {
    const { response, id } = await exchange({ op: "watch", workspaceId: scope }, current.token, controller);
    let baseline = false;
    for await (const message of clientMessages(response, id)) {
      if (session !== current || viewer !== controller || workspace.value !== scope) return;
      if (message.kind === "error") throw new ClientReadError(message.code, message.message);
      if (message.kind === "end") { element("viewer-state").textContent = `Viewer ended: ${message.reason} · work not cancelled`; continue; }
      if (message.kind !== "event") throw new ClientReadError("invalid_response", "Expected committed SDK observation");
      const rendered = pretty(message.value);
      if (message.value.type === "snapshot") { element("baseline").textContent = rendered; changes.length = 0; element("changes").textContent = "No events after this baseline."; baseline = true; }
      else {
        if (!baseline) throw new ClientReadError("invalid_response", "Viewer received a change without an atomic baseline");
        changes.push(rendered); while (changes.length > 12 || encoder.encode(changes.join("\n\n")).length > displayBytes) changes.shift();
        element("changes").textContent = changes.join("\n\n");
      }
      element("viewer-state").textContent = "Attached · committed public SDK state";
    }
  } catch (error) {
    if (session === current && viewer === controller && !controller.signal.aborted) {
      if (error instanceof ClientReadError && error.code === "view_too_large") clearViewer();
      element("viewer-state").textContent = "Viewer failed · work not cancelled"; notice(safeError(error), true);
    }
  } finally { clearTimeout(timer); controller.abort(); requests.delete(controller); if (viewer === controller) { viewer = undefined; controls(); } }
}

credentialInput.addEventListener("change", () => { void (async () => {
  const file = credentialInput.files?.[0]; forget(); if (file === undefined) return;
  const attempt = {}; login = attempt; controls(); notice("Reading the selected private file and authenticating this audience.");
  try {
    const token = await bearer(file);
    if (login !== attempt) return;
    const info = clientRecord(await rpc({ op: "discover" }, token));
    if (login !== attempt) return;
    const raw = info.workspaces; if (!Array.isArray(raw) || raw.length > 16) throw new ClientReadError("invalid_response", "Invalid workspace roster");
    const grants = raw.map(value => {
      const grant = clientRecord(value); if (!Array.isArray(grant.permissions) || !grant.permissions.every(item => typeof item === "string")) throw new ClientReadError("invalid_response", "Invalid permission roster");
      return Object.freeze({ workspaceId: text(grant.workspaceId, 200), permissions: Object.freeze(grant.permissions.map(item => text(item, 32))) });
    });
    const audience = clientRecord(info.identity);
    element("identity").textContent = `${text(audience.domain, 200)} / ${text(audience.deploymentId, 200)} / ${text(audience.nodeId, 200)} · ${text(info.principalId, 200)}`;
    session = Object.freeze({ token, grants: Object.freeze(grants) }); login = undefined;
    workspace.replaceChildren(...grants.map(grant => new Option(grant.workspaceId, grant.workspaceId)));
    notice("Authenticated. Select an explicit action; no SDK work was submitted or resumed."); controls();
  } catch (error) { if (login === attempt) { forget(); notice(safeError(error), true); } }
})(); });
button("logout").addEventListener("click", () => { forget(); notice("Credential forgotten and viewers detached. Admitted work was not cancelled. Retain request keys before leaving to recover acknowledgment."); });
workspace.addEventListener("change", () => { detach(); clearViews(); controls(); notice("Workspace selected. Attach or request history explicitly."); });
button("new-request").addEventListener("click", () => { key.value = crypto.randomUUID(); notice("New request key selected. Sending this key creates a new submission; it is not a retry."); });
button("open").addEventListener("click", () => { void action({ op: "open", workspaceId: selected() }); });
button("status").addEventListener("click", () => { void action({ op: "status", workspaceId: selected(), requestId: key.value }); });
button("submit").addEventListener("click", () => {
  if (!content.value.isWellFormed() || encoder.encode(content.value).length > MAX_CLIENT_CONTENT_BYTES) { notice("Message exceeds the UTF8 content limit or is not well-formed Unicode.", true); return; }
  void action({ op: "submit", workspaceId: selected(), requestId: key.value, content: content.value });
});
button("history").addEventListener("click", () => { void action({ op: "snapshot", workspaceId: selected() }, true); });
button("older").addEventListener("click", () => { if (nextCursor !== undefined) void action({ op: "snapshot", workspaceId: selected(), cursor: nextCursor }, true); });
button("abort").addEventListener("click", () => { void action({ op: "abort", workspaceId: selected() }); });
button("execution").addEventListener("click", () => { void action({ op: "execution.status", workspaceId: selected() }); });
button("cancel").addEventListener("click", () => { void action({ op: "command.cancel", workspaceId: selected(), intentId: intent.value }); });
button("watch").addEventListener("click", () => { void attach(); }); button("detach").addEventListener("click", detach);
window.addEventListener("pagehide", forget);
key.value = crypto.randomUUID(); controls();
