import type { Backend, NativeTarget, Policy } from "../../config/pi/agent/lib/model-policy";

type Assert<T extends true> = T;
export type ParentIsNative = Assert<Policy["parent"] extends NativeTarget ? true : false>;
export type ClaudeCannotBeParent = Assert<
  Extract<Backend, { kind: "claude-cli" }> extends Policy["parent"] ? false : true
>;
export type EffortStaysClosed = Assert<string extends NativeTarget["thinking"] ? false : true>;

export type ProviderStaysNative = Assert<
  "claude-cli" extends NativeTarget["provider"] ? false : true
>;

import type { ProviderRequestOptions, SimpleStreamOptions } from "@earendil-works/pi-ai";
type AttemptGate = NonNullable<ProviderRequestOptions["beforeRequest"]>;
export type AttemptIsSynchronous = Assert<ReturnType<AttemptGate> extends undefined ? true : false>;
export type AttemptReceivesSerializedIntent = Assert<
  Parameters<AttemptGate>[0] extends string ? true : false
>;
export type SimpleForwardsAttemptGate = Assert<
  NonNullable<SimpleStreamOptions["beforeRequest"]> extends AttemptGate ? true : false
>;
