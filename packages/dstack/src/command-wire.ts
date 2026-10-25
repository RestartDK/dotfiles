import { Type, type Static, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { isIdentityName } from "./workspace-identity.js";

const closed = { additionalProperties: false };
const decimal = Type.String({ pattern: "^(0|[1-9][0-9]{0,19})$" });
const digest = Type.String({ pattern: "^[0-9a-f]{64}$" });
const uint32 = Type.Integer({ minimum: 0, maximum: 4294967295 });
const name = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const mode = Type.Literal("trusted-user-mapped-fs");
const descriptor = Type.Object({ device: decimal, inode: decimal, mountId: decimal }, closed);
const credentials = Type.Object({
  uid: uint32, gid: uint32, groups: Type.Array(uint32, { maxItems: 128 }),
}, closed);
const context = Type.Object({
  root: descriptor, cwd: descriptor, net: descriptor, mount: descriptor, user: descriptor, credentials,
}, closed);
const activation = Type.Object({
  unit: Type.String({ pattern: "^hdj-[a-zA-Z0-9.-]+\\.service$", maxLength: 80 }),
  invocationId: Type.String({ pattern: "^[0-9a-f]{32}$" }),
  pid: Type.Integer({ minimum: 1, maximum: 2147483647 }),
  startTicks: decimal, bootId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
  executable: descriptor, commandLineSha256: digest,
  cgroup: Type.Object({
    path: Type.String({ pattern: "^/", maxLength: 4096 }), device: decimal, inode: decimal,
  }, closed),
}, closed);
const evidence = Type.Object({
  version: Type.Literal(1), executionId: name, workspaceId: name, intentId: name,
  nonce: digest, specSha256: digest, activation, mode,
}, closed);
const log = Type.Object({
  kept: Type.Integer({ minimum: 0, maximum: 131072 }),
  dropped: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  end: Type.Union([Type.Literal("eof"), Type.Literal("service-exit")]),
}, closed);
const cause = Type.Union([Type.Literal("normal"), Type.Literal("cancelled"), Type.Literal("timeout"), Type.Literal("control-error")]);
const outcome = Type.Union([
  Type.Object({ kind: Type.Literal("not-started"), reason: Type.String({ minLength: 1, maxLength: 128 }) }, closed),
  Type.Object({ kind: Type.Literal("exit"), code: Type.Integer({ minimum: 0, maximum: 255 }), cause }, closed),
  Type.Object({ kind: Type.Literal("signal"), signal: Type.Integer({ minimum: 1, maximum: 64 }), cause }, closed),
]);
const receipt = Type.Object({ evidence, outcome, stdout: log, stderr: log }, closed);
const claim = Type.Object({ evidence, context }, closed);
const parameters = Type.Object({
  argv: Type.Array(Type.String({ maxLength: 4096 }), { minItems: 1, maxItems: 128 }),
  timeoutSeconds: Type.Integer({ minimum: 1, maximum: 3600 }),
}, closed);
const spec = Type.Object({
  version: Type.Literal(1), executionId: name, workspaceId: name, intentId: name,
  nonce: digest, unit: activation.properties.unit,
  cwd: Type.String({ pattern: "^/", maxLength: 4095 }),
  ...parameters.properties,
  mode, environmentSha256: digest, context,
}, closed);

export type CommandCredentials = Static<typeof credentials>;
export type CommandContext = Static<typeof context>;
export type CommandSpec = Static<typeof spec>;
export type CommandParameters = Static<typeof parameters>;
export type CommandEvidence = Static<typeof evidence>;
export type CommandClaim = Static<typeof claim>;
export type CommandReceipt = Static<typeof receipt>;
export type CommandDescriptor = Static<typeof descriptor>;

function parse<T extends TSchema>(schema: T, bytes: string, label: string): Static<T> {
  if (Buffer.byteLength(bytes) > 32768) throw new Error(`Invalid ${label}`);
  let value: unknown;
  try { value = JSON.parse(bytes); } catch { throw new Error(`Invalid ${label}`); }
  if (!Check(schema, value)) throw new Error(`Invalid ${label}`);
  return value;
}

function identities(value: Pick<CommandEvidence, "executionId" | "workspaceId" | "intentId">): void {
  if ([value.executionId, value.workspaceId, value.intentId].some(id =>
    !isIdentityName(id) || !id.isWellFormed() || id.includes("\0") || Buffer.byteLength(id) > 128))
    throw new Error("Invalid command identity");
}

function validateContext(value: CommandContext): void {
  for (const descriptor of [value.root, value.cwd, value.net, value.mount, value.user]) {
    if ([descriptor.device, descriptor.inode, descriptor.mountId].some(id => BigInt(id) > 18446744073709551615n))
      throw new Error("Invalid command descriptor");
  }
  const { groups, gid } = value.credentials;
  if (!groups.includes(gid) || groups.some((group, index) => index > 0 && group <= (groups[index - 1] ?? -1)))
    throw new Error("Invalid canonical command groups");
}

export function parseCommandCredentials(bytes: string): CommandCredentials {
  const value = parse(credentials, bytes, "command credentials");
  const sorted = [...new Set([...value.groups, value.gid])].sort((a, b) => a - b);
  if (sorted.length > 128) throw new Error("Excessive canonical command groups");
  return { uid: value.uid, gid: value.gid, groups: sorted };
}

function validArguments(argv: readonly string[]): boolean {
  const first = argv[0];
  return first !== undefined && first.startsWith("/")
    && argv.every(arg => arg.isWellFormed() && !arg.includes("\0") && Buffer.byteLength(arg) <= 4096)
    && argv.reduce((total, arg) => total + Buffer.byteLength(arg), 0) <= 16384;
}

export function parseCommandParameters(bytes: string): CommandParameters {
  const parsed = parse(parameters, bytes, "command parameters");
  if (!validArguments(parsed.argv)) throw new Error("Invalid command parameters");
  return parsed;
}

export function parseCommandSpec(bytes: string): CommandSpec {
  const parsed = parse(spec, bytes, "command spec");
  identities(parsed);
  validateContext(parsed.context);
  if (!validArguments(parsed.argv)
    || !parsed.cwd.isWellFormed() || parsed.cwd.includes("\0") || Buffer.byteLength(parsed.cwd) > 4095) {
    throw new Error("Invalid command spec");
  }
  return parsed;
}

export function parseCommandEvidence(bytes: string): CommandEvidence {
  const value = parse(evidence, bytes, "command evidence");
  identities(value);
  return value;
}
export function parseCommandClaim(bytes: string): CommandClaim {
  const value = parse(claim, bytes, "command claim");
  identities(value.evidence);
  validateContext(value.context);
  return value;
}
export function parseCommandReceipt(bytes: string): CommandReceipt {
  const value = parse(receipt, bytes, "command receipt");
  identities(value.evidence);
  return value;
}
