import { Type } from "typebox";

const timer = Type.Object({ kind: Type.Literal("timer"), at: Type.Integer({ minimum: 0 }) });
const checks = {
  kind: Type.Literal("github-checks"),
  repo: Type.String(),
  pr: Type.Integer({ minimum: 1 }),
};
const result = Type.Union([
  timer,
  Type.Object({
    kind: Type.Literal("checks"),
    head: Type.String(),
    total: Type.Integer(),
    failed: Type.Integer(),
  }),
]);
const state = Type.Union([
  Type.Object({
    kind: Type.Literal("watching"),
    nextAt: Type.Integer(),
    observations: Type.Integer(),
    error: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({ kind: Type.Literal("pending"), result }),
  Type.Object({
    kind: Type.Literal("delivering"),
    result,
    token: Type.String(),
    startedAt: Type.Integer(),
  }),
  Type.Object({
    kind: Type.Literal("delivered"),
    result,
    token: Type.String(),
    entryId: Type.String(),
  }),
  Type.Object({
    kind: Type.Union([
      Type.Literal("cancelled"),
      Type.Literal("expired"),
      Type.Literal("superseded"),
      Type.Literal("error"),
    ]),
    reason: Type.String(),
  }),
]);
export const wakeParameters = Type.Union([
  Type.Object({
    op: Type.Literal("create"),
    trigger: Type.Union([timer, Type.Object(checks)]),
    deadline: Type.Integer({ minimum: 0 }),
    message: Type.String({ minLength: 1, maxLength: 4000 }),
  }),
  Type.Object({ op: Type.Literal("list") }),
  Type.Object({
    op: Type.Union([Type.Literal("status"), Type.Literal("cancel")]),
    id: Type.String(),
  }),
]);
export const wakeOutput = Type.Object({
  version: Type.Literal(1),
  now: Type.Integer(),
  omitted: Type.Integer({ minimum: 0 }),
  watches: Type.Array(
    Type.Object({
      id: Type.String(),
      requestId: Type.String(),
      sessionId: Type.String(),
      trigger: Type.Union([timer, Type.Object({ ...checks, head: Type.String() })]),
      deadline: Type.Integer(),
      message: Type.String(),
      createdAt: Type.Integer(),
      updatedAt: Type.Integer(),
      state,
    }),
    { maxItems: 64 },
  ),
});
