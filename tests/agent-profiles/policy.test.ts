import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendModel,
  authorizeNative,
  nativeTargets,
  loadPolicy,
  parsePolicy,
  parseWorkerInvocation,
  resolveWorkerInvocation,
  resolveRoute,
} from "../../config/pi/agent/lib/model-policy";

const root = join(import.meta.dir, "../../config/agents/model-profiles");
const policy = (profile: string) =>
  parsePolicy(JSON.parse(readFileSync(join(root, `${profile}.json`), "utf8")));

describe("profile routing", () => {
  test("work preserves billing providers and ordered subscription-first fallback", () => {
    const work = policy("work");
    expect(resolveRoute(work, { role: "feature" }).chain).toEqual([
      { kind: "pi", provider: "openai", id: "gpt-6-astra", thinking: "xhigh" },
    ]);
    expect(resolveRoute(work, { role: "how-explorer" }).chain).toEqual([
      {
        kind: "pi",
        provider: "fireworks",
        id: "accounts/fireworks/models/deepseek-v4p1-flash",
        thinking: "max",
      },
    ]);
    expect(resolveRoute(work, { role: "review" }).chain).toEqual([
      { kind: "claude-cli", model: "claude-fable-5-1", thinking: "xhigh" },
      { kind: "pi", provider: "anthropic", id: "claude-fable-5-1", thinking: "xhigh" },
      { kind: "pi", provider: "openai", id: "gpt-6-astra", thinking: "xhigh" },
    ]);
  });

  test("personal selects only its three families", () => {
    const personal = policy("personal");
    expect(backendModel(resolveRoute(personal, { role: "feature" }).chain[0])).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
    expect(resolveRoute(personal, { role: "review" }).chain.map(backendModel)).toEqual([
      "claude-fable-5-1",
      "openai-codex/gpt-6-astra",
    ]);
    expect(() => resolveRoute(personal, { model: "anthropic/claude-fable-5-1:xhigh" })).toThrow(
      "not allowed",
    );
  });

  test("panels require an explicit member or seat", () => {
    const work = policy("work");
    expect(() => resolveRoute(work, { role: "arena-runners" })).toThrow("member or seat");
    expect(
      backendModel(resolveRoute(work, { role: "arena-runners", member: "sol" }).chain[0]),
    ).toBe("openai/gpt-5.6-sol");
    expect(backendModel(resolveRoute(work, { role: "arena-runners", seat: 2 }).chain[0])).toBe(
      "fireworks/accounts/fireworks/models/deepseek-v4p1-flash",
    );
    for (const input of [
      { role: "review", model: "x" },
      { role: "review", thinking: "high" },
      { role: "review", seat: 0 },
      { role: "arena-runners", seat: 0, member: "fable" },
    ]) {
      expect(() => resolveRoute(work, input)).toThrow();
    }
  });

  test.each(["work", "personal"])("%s complete effective role matrix", (profile) => {
    const selected = policy(profile);
    const work = profile === "work";
    const expected = new Map<string, string>();
    const group = (roles: string, route: string) => {
      for (const role of roles.split(" ")) expected.set(role, route);
    };
    group("feature refactoring swarm-workers", work ? "astra" : "deepseek");
    group("bug-fix perf-issue hillclimb reflect-tooling", "astra");
    group("how-explorer", "deepseek");
    group("why-investigators fast-code", work ? "glm" : "deepseek");
    group("precise-code", work ? "sol" : "astra");
    group(
      "prose judgment review hardest how-explainer why-synthesizer reflect-judgment reflect-divergent reflect-synthesizer",
      "fable",
    );
    for (const [role, member] of expected)
      expect(resolveRoute(selected, { role }).selection).toEqual({ kind: "role", role, member });
    const panels: Record<string, [string, ...string[]]> = {
      "how-critics": ["fable"],
      "arena-runners": work ? ["fable", "sol", "deepseek"] : ["fable", "astra", "deepseek"],
      "arena-cross-judge": work ? ["fable", "sol"] : ["fable", "astra", "deepseek"],
      "architect-runners": work ? ["fable", "sol", "glm", "opus"] : ["fable", "astra", "deepseek"],
      "interrogate-reviewers": work ? ["fable", "sol", "glm"] : ["fable", "astra", "deepseek"],
    };
    for (const [role, members] of Object.entries(panels)) {
      expect(selected.roles.get(role)).toEqual({ kind: "panel", members });
      members.forEach((member, seat) =>
        expect(resolveRoute(selected, { role, seat }).selection).toEqual({
          kind: "role",
          role,
          member,
        }),
      );
    }
    expect([...selected.roles.keys()].sort()).toEqual(
      [...expected.keys(), ...Object.keys(panels)].sort(),
    );
  });

  test("raw requests use declared chains without skipping subscription priority", () => {
    const work = policy("work");
    expect(resolveRoute(work, { model: "anthropic/claude-fable-5-1:xhigh" }).chain[0].kind).toBe(
      "claude-cli",
    );
    expect(resolveRoute(work, { model: "openai/gpt-6-astra:xhigh" }).chain).toHaveLength(1);
    expect(() => resolveRoute(work, { model: "openai-codex/gpt-6-astra:xhigh" })).toThrow(
      "not allowed",
    );
    expect(() => resolveRoute(work, { model: "openai/gpt-6-astra:high" })).toThrow("not allowed");
  });

  test("global policy is reloaded and honors XDG_CONFIG_HOME", () => {
    const directory = mkdtempSync(join(tmpdir(), "profile-policy-"));
    const original = process.env.XDG_CONFIG_HOME;
    try {
      mkdirSync(join(directory, "dstack"));
      process.env.XDG_CONFIG_HOME = directory;
      const path = join(directory, "dstack/models.json");
      writeFileSync(path, readFileSync(join(root, "personal.json")));
      expect(loadPolicy().profile).toBe("personal");
      writeFileSync(path, readFileSync(join(root, "work.json")));
      expect(loadPolicy().profile).toBe("work");
      writeFileSync(path, "{");
      expect(() => loadPolicy()).toThrow("dispatch blocked");
    } finally {
      if (original === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = original;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("shared dstack instructions contain no executable model slugs", () => {
    const directory = join(import.meta.dir, "../../config/agents/skills/dstack");
    for (const path of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
      if (path.endsWith(".md"))
        expect(readFileSync(join(directory, path), "utf8")).not.toMatch(
          /(?:anthropic|openai|openai-codex|openrouter|fireworks)\/(?:claude-|gpt-|deepseek\/|z-ai\/|accounts\/fireworks\/models\/)/,
        );
    }
  });

  test("missing and malformed policy fail closed", () => {
    expect(() => loadPolicy("/nonexistent-profile-config")).toThrow("models.json");
    const personal = policy("personal");
    const valid = {
      version: 1,
      profile: personal.profile,
      parent: "astra",
      routes: Object.fromEntries(
        [...personal.routes].map(([name, chain]) => [
          name,
          chain.map((backend) => ({
            kind: backend.kind,
            model: backendModel(backend),
            thinking: backend.thinking,
          })),
        ]),
      ),
      roles: Object.fromEntries(personal.roles),
    };
    const malformed = [
      { ...valid, version: 2 },
      { ...valid, parent: "fable" },
      { ...valid, parent: { kind: "claude-cli", model: "claude-fable-5-1", thinking: "xhigh" } },
      { ...valid, fallback: "auto" },
      { ...valid, routes: { ...valid.routes, fable: [] } },
      {
        ...valid,
        routes: {
          ...valid.routes,
          fable: [{ kind: "pi", model: "anthropic/claude-fable-5-1", thinking: "xhigh" }],
        },
      },
      {
        ...valid,
        routes: {
          ...valid.routes,
          astra: [
            { kind: "pi", model: "openai-codex/gpt-6-astra", thinking: "xhigh" },
            { thinking: "high", model: "openai-codex/gpt-6-astra", kind: "pi" },
          ],
        },
      },
      {
        ...valid,
        roles: { ...valid.roles, review: { kind: "single", route: "fable", members: ["astra"] } },
      },
      { ...valid, roles: { ...valid.roles, review: { kind: "single", route: "missing" } } },
      { ...valid, roles: { ...valid.roles, "arena-runners": { kind: "panel", members: [] } } },
    ];
    for (const value of [
      null,
      {},
      { version: 1, profile: "personal", routes: {}, roles: {} },
      ...malformed,
    ]) {
      expect(() => parsePolicy(value)).toThrow();
    }
  });
});

test.each(["work", "personal"])(
  "%s parent is native Astra and allowed targets exclude CLI backends",
  (profile) => {
    const selected = policy(profile);
    expect(selected.parent).toEqual({
      kind: "pi",
      provider: profile === "work" ? "openai" : "openai-codex",
      id: "gpt-6-astra",
      thinking: "xhigh",
    });
    for (const target of nativeTargets(selected))
      expect(() => authorizeNative(selected, target)).not.toThrow();
    expect(() =>
      authorizeNative(selected, { provider: "claude-cli", id: "claude-fable-5-1" }),
    ).toThrow();
    if (profile === "personal")
      expect(() =>
        authorizeNative(selected, { provider: "anthropic", id: "claude-fable-5-1" }),
      ).toThrow();
  },
);

test("worker invocation parses once and resolves its exact native attempt", () => {
  const input = {
    profile: "work",
    selection: { kind: "role", role: "precise-code", member: "sol" },
    attempt: 0,
  } as const;
  const invocation = parseWorkerInvocation(input);
  expect(invocation).toEqual(input);
  expect(resolveWorkerInvocation(policy("work"), invocation)).toEqual({
    kind: "pi",
    provider: "openai",
    id: "gpt-5.6-sol",
    thinking: "xhigh",
  });
  expect(() => resolveWorkerInvocation(policy("personal"), invocation)).toThrow(
    "changed worker profile",
  );
  expect(() =>
    resolveWorkerInvocation(policy("work"), {
      ...invocation,
      selection: { kind: "role", role: "review", member: "fable" },
    }),
  ).toThrow("native Pi target");
});

test("worker invocation rejects untyped extra fields and invalid attempts", () => {
  const input = {
    profile: "work",
    selection: { kind: "role", role: "precise-code", member: "sol" },
    attempt: 0,
  } as const;
  for (const invalid of [
    { ...input, profile: "other" },
    { ...input, attempt: -1 },
    { ...input, attempt: 0.5 },
    { ...input, model: "override" },
    { ...input, selection: { ...input.selection, model: "override" } },
    { ...input, selection: { kind: "unknown" } },
  ])
    expect(() => parseWorkerInvocation(invalid)).toThrow("AI policy");
});
