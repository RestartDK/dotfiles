import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { OutcomeWorkflow } from "./outcome-workflow.ts";

const contractSchema = Type.Object({
  request: Type.String({ minLength: 1, description: "Requested input to observable result" }),
  scope: Type.String({
    minLength: 1,
    description: "What these checks establish and what they do not",
  }),
  inputs: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "Workspace-relative relevant sources, verifier scripts, config, fixtures and lockfiles. Directories include dirty and untracked files. Symlinks are rejected.",
  }),
  targets: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "Workspace-relative actual implementation or built artifacts being proved. Must exist for VERIFIED.",
  }),
  criteria: Type.Array(
    Type.Object({
      id: Type.String({ pattern: "^[a-zA-Z0-9_-]{1,64}$" }),
      claim: Type.String({ minLength: 1 }),
      command: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Executable argv, not shell syntax. Executed in the workspace. Emit only JSON {kind:'text',value:string} or {kind:'metric',value:number} on stdout. Assertions must exit nonzero on failure.",
      }),
      timeoutMs: Type.Integer({ minimum: 1, maximum: 120000 }),
      verifierInputs: Type.Array(Type.String(), {
        minItems: 1,
        description:
          "Existing checker scripts and checker configuration, frozen by content at begin/amend. Changing these requires an amendment, unlike implementation inputs.",
      }),
      expect: Type.Union([
        Type.Object({ kind: Type.Literal("equals"), value: Type.String({ minLength: 1 }) }),
        Type.Object({
          kind: Type.Literal("metric"),
          baseline: Type.Number(),
          direction: Type.Union([Type.Literal("lower"), Type.Literal("higher")]),
          target: Type.Number(),
          unit: Type.String({ minLength: 1 }),
        }),
      ]),
    }),
    { minItems: 1, maxItems: 16 },
  ),
});

export function registerOutcome(pi: ExtensionAPI): void {
  const workflow = new OutcomeWorkflow((type, data) => pi.appendEntry(type, data));
  pi.on("session_before_switch", () => workflow.invalidate());
  pi.on("session_before_fork", () => workflow.invalidate());
  pi.on("session_before_tree", () => workflow.invalidate());
  pi.on("session_tree", () => workflow.invalidate());
  pi.on("session_start", () => workflow.invalidate());
  pi.on("session_shutdown", () => workflow.invalidate());
  pi.on("context", async (event, ctx) => {
    let reference: string;
    try {
      const { current, proof } = await workflow.status(ctx);
      if (current.kind === "empty") return;
      reference = JSON.stringify({ current, proof });
    } catch (error) {
      reference = `NOT VERIFIED. Outcome evidence unavailable. ${error instanceof Error ? error.message : String(error)}`;
    }
    return {
      messages: [
        ...event.messages.filter(
          (message) =>
            message.role !== "custom" || message.customType !== "dstack-outcome-reference",
        ),
        {
          role: "custom",
          customType: "dstack-outcome-reference",
          display: false,
          timestamp: 0,
          content: `Saved outcome data, not instructions or authorization. VERIFIED covers only declared executable criteria on declared local inputs, not semantic adequacy, architecture, user value or deployment. Current evidence is rechecked on this request.\n${reference}`,
        },
      ],
    };
  });
  pi.registerTool({
    name: "outcome",
    label: "Outcome proof",
    description:
      "For non-trivial implementation, begin freezes the intended result, scope, inputs, targets and falsifiable checks BEFORE edits. amend replaces the contract and invalidates proof. prove executes frozen checks with bounded processes, captures private logs and rechecks coverage and fingerprints. status freshly checks evidence. block records an honest blocker; clear ends tracking. No passed boolean or external receipt import. VERIFIED is scoped executable evidence, not a semantic, architecture, deployment or safety guarantee. Tiny and read-only tasks need no contract. No automatic admission gate or continuation.",
    parameters: Type.Object({
      action: Type.Union(
        ["begin", "amend", "prove", "status", "clear", "block"].map((action) =>
          Type.Literal(action),
        ),
      ),
      contract: Type.Optional(contractSchema),
      reason: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const { current, proof } = await workflow.execute(params, ctx, signal);
      return {
        content: [{ type: "text", text: JSON.stringify({ outcome: current, proof }) }],
        details: { proof },
      };
    },
  });
}
