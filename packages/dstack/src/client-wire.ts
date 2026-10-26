import type { AgentEvent, EntryRecord, SnapshotEvent, SubmissionRecord } from "@earendil-works/pi-durable";
import { MAX_CLIENT_EVENT_BYTES, CLIENT_RESOURCES } from "./client-limits.js";
export { CLIENT_RESOURCES } from "./client-limits.js";

export class ClientDataError extends Error {
  constructor(readonly code: "view_too_large" | "invalid_client_data", message: string) { super(message); }
}

function collection<T>(items: readonly T[]): readonly T[] {
  if (items.length > CLIENT_RESOURCES.collectionItems) throw new ClientDataError("view_too_large", "Client collection exceeds item limit; use paged history");
  return items;
}

export function clientEntry(record: EntryRecord) {
  const { id, conversationId, head, byTaskId, edits, ...body } = record;
  return {
    ...body, id: String(id), conversationId: String(conversationId),
    ...(head === undefined ? {} : { head: String(head) }),
    ...(byTaskId === undefined ? {} : { byTaskId: String(byTaskId) }),
    ...(edits === undefined ? {} : { edits: collection(edits).map(edit => ({ ...edit, target: String(edit.target) })) }),
  };
}

export function clientSubmission(record: SubmissionRecord) {
  const { id, conversationId, entry, answer, requestId: _internalRequestId, ...body } = record;
  return {
    ...body, id: String(id), conversationId: String(conversationId),
    ...(entry === undefined ? {} : { entry: String(entry) }),
    ...(answer === undefined ? {} : { answer: String(answer) }),
  };
}

function tool(slot: SnapshotEvent["tools"][number]) {
  const { taskId, entry, ...body } = slot;
  return { ...body, ...(taskId === undefined ? {} : { taskId: String(taskId) }), ...(entry === undefined ? {} : { entry: String(entry) }) };
}

export function clientSnapshot(event: SnapshotEvent) {
  return {
    ...event,
    entries: collection(event.entries).map(clientEntry),
    ...(event.run === undefined ? {} : { run: { inputs: collection(event.run.inputs).map(id => String(id)) } }),
    tools: collection(event.tools).map(tool),
    compactions: collection(event.compactions).map(item => ({ ...item, taskId: String(item.taskId) })),
    inbox: collection(event.inbox).map(item => ({ ...item, id: String(item.id) })),
  };
}

export function clientEvent(event: AgentEvent) {
  switch (event.type) {
    case "snapshot": return clientSnapshot(event);
    case "run_start": case "run_end":
      return { ...event, inputs: collection(event.inputs).map(id => String(id)) };
    case "message_end": case "entry_appended":
      return { ...event, entry: clientEntry(event.entry) };
    case "tool_execution_end":
      return { ...event, ...(event.entry === undefined ? {} : { entry: clientEntry(event.entry) }) };
    case "inbox_update":
      return { ...event, items: collection(event.items).map(item => ({ ...item, id: String(item.id) })) };
    case "submission":
      return { ...event, record: clientSubmission(event.record) };
    case "task_failed": case "compaction_start": case "compaction_end":
      return { ...event, taskId: String(event.taskId) };
    case "turn_start": case "turn_end": case "message_start": case "message_update":
    case "tool_execution_start": case "tool_execution_update": case "auto_retry_start":
    case "auto_retry_end": case "deferred_poll": case "agent_changed": case "usage_changed":
      return event;
    default: { const exhaustive: never = event; return exhaustive; }
  }
}

export type ClientEvent = ReturnType<typeof clientEvent>;

function stringBytes(value: string): number {
  let bytes = Buffer.byteLength(value) + 2;
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charCodeAt(i);
    if (char === 34 || char === 92) bytes += 1;
    else if (char < 32) bytes += char === 8 || char === 9 || char === 10 || char === 12 || char === 13 ? 1 : 5;
    else if (char >= 0xd800 && char <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) i += 1;
    else if (char >= 0xd800 && char <= 0xdfff) bytes += 3;
  }
  return bytes;
}

export function clientFrame(value: unknown): string {
  let remaining = MAX_CLIENT_EVENT_BYTES, values = CLIENT_RESOURCES.jsonValues;
  const chunks: string[] = [], ancestors = new Set<object>();
  const tooLarge = (): never => { throw new ClientDataError("view_too_large", "Client frame exceeds resource limit; reconnect or use paged history"); };
  const invalid = (): never => { throw new ClientDataError("invalid_client_data", "Client data is not a JSON value"); };
  const append = (text: string) => {
    const bytes = Buffer.byteLength(text);
    if (bytes > remaining) return tooLarge();
    remaining -= bytes; chunks.push(text);
  };
  const quoted = (text: string) => {
    if (text.length + 2 > remaining || stringBytes(text) > remaining) return tooLarge();
    append(JSON.stringify(text));
  };
  const encode = (item: unknown, depth: number): void => {
    if (--values < 0 || depth > CLIENT_RESOURCES.jsonDepth) return tooLarge();
    if (item === null) return append("null");
    switch (typeof item) {
      case "string": return quoted(item);
      case "boolean": return append(item ? "true" : "false");
      case "number": return Number.isFinite(item) ? append(String(item)) : invalid();
      case "object": {
        if (ancestors.has(item)) return invalid();
        ancestors.add(item);
        if (Array.isArray(item)) {
          append("[");
          for (let i = 0; i < item.length; i += 1) {
            if (i !== 0) append(",");
            encode(item[i] === undefined ? null : item[i], depth + 1);
          }
          append("]");
        } else {
          const prototype: unknown = Object.getPrototypeOf(item);
          if (prototype !== null && prototype !== Object.prototype) return invalid();
          append("{");
          let separator = "";
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue;
            if (--values < 0) return tooLarge();
            const descriptor = Object.getOwnPropertyDescriptor(item, key);
            if (descriptor === undefined || !("value" in descriptor)) return invalid();
            const field: unknown = descriptor.value;
            if (field === undefined) continue;
            append(separator); quoted(key); append(":"); encode(field, depth + 1); separator = ",";
          }
          append("}");
        }
        ancestors.delete(item); return;
      }
      default: return invalid();
    }
  };
  encode(value, 0); append("\n");
  return chunks.join("");
}
