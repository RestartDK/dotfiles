type ProviderPayload = {
  input?: unknown;
};

type MessageWithContent = {
  role?: unknown;
  content?: unknown;
};

type ContentBlock = {
  type?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReasoningPayloadItem(value: unknown): boolean {
  return isRecord(value) && value.type === "reasoning";
}

function hasEncryptedReasoningPayload(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.encrypted_content === "string" &&
    value.encrypted_content.length > 0
  );
}

function isUnreplayableReasoningBlock(value: unknown): boolean {
  if (!isRecord(value) || value.type !== "thinking") return false;

  const signature = value.thinkingSignature;
  if (typeof signature !== "string") return true;

  try {
    return !hasEncryptedReasoningPayload(JSON.parse(signature));
  } catch {
    return true;
  }
}

function isUnreplayableReasoningPayloadItem(value: unknown): boolean {
  return isReasoningPayloadItem(value) && !hasEncryptedReasoningPayload(value);
}

export function stripUnreplayableReasoningBlocksFromMessages<T>(messages: T[]): T[] | undefined {
  let changed = false;
  const stripped = messages.map((message) => {
    if (!isRecord(message)) return message;

    const candidate = message as MessageWithContent;
    if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return message;

    const content = candidate.content.filter(
      (block: ContentBlock) => !isUnreplayableReasoningBlock(block),
    );
    if (content.length === candidate.content.length) return message;

    changed = true;
    return { ...message, content } as T;
  });

  return changed ? stripped : undefined;
}

export function stripUnreplayableReasoningItemsFromPayload(payload: unknown): unknown | undefined {
  if (!isRecord(payload)) return undefined;

  const candidate = payload as ProviderPayload;
  if (!Array.isArray(candidate.input)) return undefined;

  const input = candidate.input.filter((item) => !isUnreplayableReasoningPayloadItem(item));
  if (input.length === candidate.input.length) return undefined;

  return { ...payload, input };
}
