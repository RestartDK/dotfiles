import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { clientRecord } from "../src/client-reader.js";
import { CLIENT_RESOURCES } from "../src/client-limits.js";

const root = await mkdtemp(join(tmpdir(), "client-browser-proof-")), session = `client-proof-${randomUUID()}`;
const fixture = spawn(process.execPath, [fileURLToPath(new URL("./client-browser-fixture.js", import.meta.url))], { stdio: "pipe" });
const ready = Promise.withResolvers<Record<string, unknown>>();
const exited = new Promise<number | null>(resolve => fixture.once("exit", resolve));
let stderr = "", fixtureRoot: string | undefined, browserStarted = false;
fixture.stderr.on("data", chunk => { stderr = (stderr + String(chunk)).slice(-65536); });
const lines = createInterface({ input: fixture.stdout });
lines.on("line", line => {
  try { const record = clientRecord(JSON.parse(line)); if (record.fixture === "client-browser-ready") ready.resolve(record); }
  catch (error) { ready.reject(error); }
});
fixture.once("error", error => ready.reject(error));
fixture.once("exit", code => ready.reject(new Error(`Browser fixture exited before readiness: ${code}`)));

async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Browser proof deadline exceeded")), ms); })]); }
  finally { clearTimeout(timer); }
}
function string(record: Record<string, unknown>, field: string): string {
  const value = record[field]; assert.equal(typeof value, "string"); if (typeof value !== "string") throw new Error("Invalid browser fixture"); return value;
}
function browser(...args: string[]): unknown {
  const command = spawnSync("agent-browser", ["--session", session, "--json", ...args], { encoding: "utf8", timeout: 35000, maxBuffer: 256 * 1024 });
  assert.equal(command.error, undefined);
  assert.equal(command.status, 0, command.stderr || command.stdout);
  const response = clientRecord(JSON.parse(command.stdout)); assert.equal(response.success, true, command.stdout);
  return clientRecord(response.data).result;
}
function evaluate(source: string): unknown { return browser("eval", source); }
function check(source: string): void { assert.equal(evaluate(source), true); }
function click(id: string): void { browser("click", `#${id}`); }
function wait(source: string): void { browser("wait", "--fn", source); }
function authenticated(principal: string): void { wait(`document.querySelector('#identity').textContent.endsWith(' · ${principal}')`); }
function idle(id: string): void { wait(`!document.querySelector('#${id}').disabled`); }
async function completed(): Promise<void> {
  const until = performance.now() + 30000;
  while (performance.now() < until) {
    click("status"); idle("status");
    if (evaluate("JSON.parse(document.querySelector('#reply').textContent).receipt?.status === 'done'") === true) return;
    await delay(100);
  }
  throw new Error("Detached SDK generation did not finish");
}

const failures: unknown[] = [];
try {
  const info = await within(ready.promise, 20000); assert.equal(info.productionModel, false);
  fixtureRoot = string(info, "root");
  const endpoint = new URL(string(info, "endpoint"));
  assert.equal(endpoint.protocol, "http:"); assert.equal(endpoint.hostname, "127.0.0.1"); assert.equal(endpoint.pathname, "/");
  assert.equal(endpoint.username + endpoint.password + endpoint.search + endpoint.hash, "");
  const writer = string(info, "writerFile"), reader = string(info, "readerFile"), foreign = string(info, "foreignFile");
  assert.equal(writer, join(fixtureRoot, "writer.key")); assert.equal(reader, join(fixtureRoot, "reader.key")); assert.equal(foreign, join(fixtureRoot, "foreign.key"));
  browserStarted = true; browser("open", endpoint.href);
  browser("upload", "#credential", foreign); wait("document.querySelector('#notice').textContent.includes('Client authentication failed')");
  check("document.querySelector('#identity').textContent === 'Not authenticated' && document.querySelector('#submit').disabled");
  browser("upload", "#credential", reader); authenticated("reader");
  check("['open','submit','abort','cancel'].every(id => document.getElementById(id).disabled)");
  browser("upload", "#credential", writer); authenticated("writer");
  click("open"); wait("(() => {try{return typeof JSON.parse(document.querySelector('#reply').textContent).conversationId === 'string'}catch{return false}})()");
  click("watch"); wait("document.querySelector('#viewer-state').textContent.startsWith('Attached')");
  check("(() => {const value=JSON.parse(document.querySelector('#baseline').textContent); return value.type==='snapshot' && !Object.hasOwn(value,'seq') && value.entries.length===0;})()");
  click("new-request"); browser("fill", "#content", "Exercise the actual corrected browser consumer and durable owner."); click("submit");
  wait("document.querySelector('#changes').textContent.includes('message_update')");
  check("(() => {const receipt=JSON.parse(document.querySelector('#reply').textContent).receipt; window.__clientProof={first:receipt.id}; return typeof receipt.id==='string';})()");
  click("detach"); await completed();
  check("JSON.parse(document.querySelector('#reply').textContent).receipt.id === window.__clientProof.first");
  click("history"); wait("document.querySelector('#history-view').textContent.includes('<img src=x onerror=alert(1)>')");
  check("document.querySelectorAll('img').length===0");
  click("watch"); wait("document.querySelector('#baseline').textContent.includes('Browser fixture:')");
  check("!Object.hasOwn(JSON.parse(document.querySelector('#baseline').textContent),'seq')");
  assert.equal(evaluate("(() => {try{return JSON.parse(document.querySelector('#reply').textContent).receipt.id===window.__clientProof.first && document.querySelector('#history-view').textContent.includes('Browser fixture:')}catch{return false}})()"), true, "Viewer attach must retain the actual owner reply and requested history");
  click("new-request"); browser("fill", "#content", "Explicitly abort the second ordinary SDK generation, not an independent business attempt."); click("submit");
  wait("document.querySelector('#changes').textContent.includes('message_update')");
  check("(() => {const receipt=JSON.parse(document.querySelector('#reply').textContent).receipt; window.__clientProof.second=receipt.id; window.__clientProof.key=document.querySelector('#request-key').value; return typeof receipt.id==='string';})()");
  click("abort"); wait("document.querySelector('#reply').textContent.includes('ordinarySdkWorkStopped')");
  click("status"); idle("status"); check("JSON.parse(document.querySelector('#reply').textContent).receipt.status === 'unanswered'");
  click("logout"); browser("upload", "#credential", writer); authenticated("writer");
  check("document.querySelector('#request-key').value === window.__clientProof.key");
  click("status"); idle("status");
  check("(() => {const receipt=JSON.parse(document.querySelector('#reply').textContent).receipt; return receipt.id===window.__clientProof.second && receipt.status==='unanswered';})()");
  browser("upload", "#credential", reader); authenticated("reader"); click("status"); idle("status");
  check("JSON.parse(document.querySelector('#reply').textContent).receipt === null && ['open','submit','abort','cancel'].every(id=>document.getElementById(id).disabled)");
  click("history"); wait("document.querySelector('#history-view').textContent.includes('<img src=x onerror=alert(1)>')");
  check("document.querySelectorAll('img').length===0 && localStorage.length===0 && sessionStorage.length===0 && document.cookie==='' && document.querySelector('#credential').value===''");
  browser("set", "viewport", "1280", "900"); browser("set", "media", "light"); browser("screenshot", join(root, "reader.png"), "--full");
  browser("upload", "#credential", writer); authenticated("writer"); browser("fill", "#request-key", "k".repeat(200));
  browser("fill", "#content", "王秀英 👩🏽‍💻 Seán O’Brien <script>literal</script> ".repeat(40)); click("status"); idle("status");
  browser("set", "viewport", "320", "860"); browser("set", "media", "dark");
  check("JSON.parse(document.querySelector('#reply').textContent).requestId.length===200 && JSON.parse(document.querySelector('#reply').textContent).receipt===null && document.documentElement.scrollWidth <= innerWidth");
  browser("screenshot", join(root, "narrow-dark.png"), "--full");
  click("logout"); check("document.querySelector('#request-key').value === 'k'.repeat(200)");
  check("(() => {const p={read:File.prototype.arrayBuffer,fetch:window.fetch,digest:crypto.subtle.digest,held:false,calls:0,digested:false,release:undefined}; window.__credentialProbe=p; File.prototype.arrayBuffer=async function(){const value=await p.read.call(this); p.held=true; await new Promise(resolve=>p.release=resolve); return value;}; crypto.subtle.digest=function(...args){return p.digest.apply(this,args).then(value=>{p.digested=true;return value;});}; window.fetch=function(...args){if(typeof args[1]?.body==='string' && JSON.parse(args[1].body).operation.op==='discover')p.calls++; return p.fetch.apply(window,args);}; return true;})()");
  browser("upload", "#credential", writer); wait("window.__credentialProbe.held"); click("logout"); evaluate("window.__credentialProbe.release(); true"); wait("window.__credentialProbe.digested");
  check("(async()=>{await new Promise(requestAnimationFrame);const p=window.__credentialProbe;File.prototype.arrayBuffer=p.read;crypto.subtle.digest=p.digest;window.fetch=p.fetch;delete window.__credentialProbe;return p.calls===0 && document.querySelector('#identity').textContent==='Not authenticated';})()");
  browser("upload", "#credential", reader); authenticated("reader");
  check(`(() => {window.__viewerClock=window.setTimeout;window.setTimeout=function(...args){if(args[1]===${CLIENT_RESOURCES.operationMs + CLIENT_RESOURCES.viewerMs})args[1]=50;return window.__viewerClock.apply(window,args);};return true;})()`);
  click("watch"); wait("document.querySelector('#viewer-state').textContent.startsWith('Viewer expired locally')");
  check("(() => {window.setTimeout=window.__viewerClock;delete window.__viewerClock;return document.querySelector('#viewer-state').textContent.includes('work not cancelled');})()");
  await writeFile(join(root, "browser.json"), JSON.stringify({ ownerReplyAndHistorySurviveAttach: true, localExpiryLabelTruthful: true, wrongAudienceRefused: true, actualAtomicEmptySnapshot: true, committedProgress: true, detachWithoutCancellation: true, freshSnapshotReconnect: true, actualHistoryAndLiteralHtml: true, activeSdkAbort: true, businessOutcomeClaimed: false, reauthenticationRecoversSameSubmission: true, principalRequestIsolation: true, noBrowserStorage: true, noLateAuthenticationAfterForget: true, keyRetention: true, acceptedBoundaryKeyBytes: 200, narrowDarkViewport: 320, nativeZoomAcceptance: false, productionModel: false }, null, 2), { flag: "wx", mode: 0o600 });
} catch (error) { failures.push(error); }
finally {
  if (browserStarted) { try { browser("close"); } catch (error) { failures.push(error); } }
  fixture.stdin.end();
  try { assert.equal(await within(exited, 15000), 0, stderr); } catch (error) { failures.push(error); }
  lines.close();
  await writeFile(join(root, "fixture-stderr.log"), stderr, { flag: "wx", mode: 0o600 });
}
if (fixtureRoot !== undefined && failures.length === 0) {
  const closed = clientRecord(JSON.parse(await readFile(join(fixtureRoot, "closed.json"), "utf8")));
  assert.equal(closed.providerCalls, 2); assert.equal(closed.productionModel, false);
  await writeFile(join(root, "result.json"), JSON.stringify({ proof: "client-browser-real-owner", root, fixtureRoot, providerCalls: closed.providerCalls, browserSessionClosed: true, ownerClosed: true, productionModel: false }, null, 2), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ proof: "client-browser-real-owner", root, fixtureRoot, providerCalls: 2, productionModel: false })}\n`);
}
if (failures.length !== 0) throw new AggregateError(failures, `Browser acceptance failed; preserve ${root} and ${fixtureRoot}`, { cause: failures[0] });
