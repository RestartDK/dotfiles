import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import {
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { AuthStorage } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/auth-storage.js";
import { loadExtensionFromFactory } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { HerdrClient, HerdrRequestError } from "./client.ts";
import type { Request } from "./generated/request.ts";
import type {
  PaneInfo,
  ResponseResult,
  TabInfo,
  WorkspaceInfo,
} from "./generated/success-response.ts";
import registerHerdr from "./index.ts";

const environment = {
  HERDR_ENV: "1",
  HERDR_SOCKET_PATH: "/unused-herdr-fixture.sock",
  HERDR_PANE_ID: "source:p1",
};
const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
before(() => Object.assign(process.env, environment));
after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const source: PaneInfo = {
  pane_id: "source:p1",
  tab_id: "source:t1",
  workspace_id: "source",
  terminal_id: "source-terminal",
  agent_status: "working",
  agent: "pi",
  focused: false,
  revision: 0,
};
const remote: PaneInfo = {
  ...source,
  pane_id: "remote:p1",
  tab_id: "remote:t1",
  workspace_id: "remote",
  terminal_id: "remote-terminal",
  agent: undefined,
};
const sibling: PaneInfo = { ...remote, pane_id: "remote:p2", tab_id: "remote:t2" };
const remoteTab: TabInfo = {
  tab_id: remote.tab_id,
  workspace_id: remote.workspace_id,
  agent_status: "unknown",
  focused: false,
  label: "Remote",
  number: 1,
  pane_count: 1,
};
const remoteWorkspace: WorkspaceInfo = {
  ...remoteTab,
  active_tab_id: remoteTab.tab_id,
  tab_count: 2,
};
const registry = new ModelRegistry(
  await ModelRuntime.create({
    credentials: AuthStorage.inMemory(),
    modelsPath: null,
    refreshOnCreate: false,
  }),
);

async function fixture(t: TestContext) {
  const panes = [source, remote, sibling];
  const calls: Array<Pick<Request, "method" | "params">> = [];
  const failures = new Map<string, Error>();
  t.mock.method(
    HerdrClient.prototype,
    "call",
    async (method: Request["method"], params: Request["params"]): Promise<ResponseResult> => {
      calls.push({ method, params });
      switch (method) {
        case "workspace.create":
          return {
            type: "workspace_created",
            workspace: remoteWorkspace,
            tab: remoteTab,
            root_pane: remote,
          };
        case "workspace.list":
          return { type: "workspace_list", workspaces: [remoteWorkspace] };
        case "tab.create":
          return {
            type: "tab_created",
            tab: { ...remoteTab, tab_id: sibling.tab_id },
            root_pane: sibling,
          };
        case "tab.list":
          return {
            type: "tab_list",
            tabs:
              "workspace_id" in params && params.workspace_id === source.workspace_id
                ? [{ ...remoteTab, tab_id: source.tab_id, workspace_id: source.workspace_id }]
                : [remoteTab, { ...remoteTab, tab_id: sibling.tab_id }],
          };
        case "tab.get": {
          const tabId = "tab_id" in params ? params.tab_id : undefined;
          return {
            type: "tab_info",
            tab:
              tabId === source.tab_id
                ? { ...remoteTab, tab_id: source.tab_id, workspace_id: source.workspace_id }
                : remoteTab,
          };
        }
        case "pane.get": {
          const paneId = "pane_id" in params ? params.pane_id : undefined;
          const failure = typeof paneId === "string" ? failures.get(paneId) : undefined;
          if (failure) throw failure;
          const pane = panes.find((candidate) => candidate.pane_id === paneId);
          if (!pane) throw new HerdrRequestError("pane_not_found", `Pane ${paneId} is gone`);
          return { type: "pane_info", pane };
        }
        case "pane.list":
          return {
            type: "pane_list",
            panes: panes.filter(
              (pane) => "workspace_id" in params && pane.workspace_id === params.workspace_id,
            ),
          };
        case "pane.read":
          return {
            type: "pane_read",
            read: {
              pane_id: remote.pane_id,
              tab_id: remote.tab_id,
              workspace_id: remote.workspace_id,
              revision: 0,
              format: "text",
              source: "visible",
              text: "remote output",
              truncated: false,
            },
          };
        case "pane.send_input":
        case "tab.close":
          return { type: "ok" };
        default:
          throw new Error(`Unexpected Herdr call ${method}`);
      }
    },
  );
  const cwd = "/herdr-fixture";
  const session = SessionManager.inMemory(cwd);
  const host = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(registerHerdr, cwd, createEventBus(), host);
  const runner = new ExtensionRunner([extension], host, cwd, session, registry);
  const tool = runner.getToolDefinition("herdr");
  assert.ok(tool);
  const call = (params: Parameters<typeof tool.execute>[1]) =>
    tool.execute(
      "fixture",
      params,
      undefined,
      undefined,
      runner.createToolContext("fixture", undefined),
    );
  await call({ action: "workspace_create", pane: "remote", label: "Remote" });
  return { call, calls, panes, failures };
}

test("workspace-created aliases and explicit pane IDs work outside Pi's workspace", async (t) => {
  const f = await fixture(t);
  for (const pane of ["remote", remote.pane_id]) {
    const result = await f.call({ action: "read", pane });
    assert.deepEqual(result.content, [{ type: "text", text: "remote output" }]);
  }
  assert.deepEqual(
    f.calls.filter((call) => call.method === "pane.read").map((call) => call.params.pane_id),
    [remote.pane_id, remote.pane_id],
  );
});

test("closing a remote tab clears its aliases but preserves other remote tabs", async (t) => {
  const f = await fixture(t);
  await f.call({ action: "tab_create", workspace: "remote", pane: "sibling" });
  const result = await f.call({ action: "tab_close", tab: remote.tab_id });
  assert.ok(result.details && typeof result.details === "object" && "aliases" in result.details);
  assert.deepEqual(result.details.aliases, {
    sibling: { paneId: sibling.pane_id, workspaceId: sibling.workspace_id },
  });
  assert.ok(
    f.calls.some(
      (call) => call.method === "pane.list" && call.params.workspace_id === remote.workspace_id,
    ),
  );
  assert.deepEqual(f.calls.find((call) => call.method === "tab.close")?.params, {
    tab_id: remote.tab_id,
  });
  await f.call({ action: "read", pane: "sibling" });
});

test("Pi's own pane and tab remain protected after target resolution", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.call({ action: "stop", pane: source.pane_id }),
    /Refusing to close the pane/,
  );
  await assert.rejects(
    f.call({ action: "tab_close", tab: source.tab_id }),
    /Refusing to close the tab/,
  );
  await assert.rejects(f.call({ action: "pane_split", pane: source.pane_id }), /Refusing to split/);
  assert.ok(
    !f.calls.some((call) => ["pane.close", "tab.close", "pane.split"].includes(call.method)),
  );
});

test("dead remote aliases are removed", async (t) => {
  const f = await fixture(t);
  f.panes.splice(f.panes.indexOf(remote), 1);
  await assert.rejects(f.call({ action: "read", pane: "remote" }), /alias 'remote'.*was removed/);
  const result = await f.call({ action: "list" });
  assert.ok(result.details && typeof result.details === "object" && "aliases" in result.details);
  assert.deepEqual(result.details.aliases, {});
});

test("pane lookup propagates daemon errors instead of removing a live alias", async (t) => {
  const f = await fixture(t);
  const failure = new HerdrRequestError("unavailable", "Daemon unavailable");
  f.failures.set(remote.pane_id, failure);
  await assert.rejects(f.call({ action: "read", pane: "remote" }), failure);
  f.failures.clear();
  await f.call({ action: "read", pane: "remote" });
});

test("starting a remote command reports the target workspace", async (t) => {
  const f = await fixture(t);
  const result = await f.call({ action: "run", pane: "remote", command: "true" });
  assert.ok(
    result.details && typeof result.details === "object" && "workspaceId" in result.details,
  );
  assert.equal(result.details.workspaceId, remote.workspace_id);
  assert.deepEqual(f.calls.find((call) => call.method === "pane.send_input")?.params, {
    pane_id: remote.pane_id,
    text: "true",
    keys: ["Enter"],
  });
});
