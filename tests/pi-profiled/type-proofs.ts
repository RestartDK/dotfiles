import type { NativeTarget, Policy } from "../../config/pi/agent/lib/model-policy";

type Assert<T extends true> = T;
export type ParentIsNative = Assert<Policy["parent"] extends NativeTarget ? true : false>;
export type EffortStaysClosed = Assert<string extends NativeTarget["thinking"] ? false : true>;

