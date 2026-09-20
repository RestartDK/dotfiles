import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRecord, loadPolicy, type Policy } from "./model-policy";

type SessionPolicyReader = Pick<SessionManager, "getEntries">;

function sessionMarkers(manager: SessionPolicyReader) {
  return manager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "dstack-model-policy");
}

export function authorizeSessionPolicy(
  manager: SessionPolicyReader,
  profile: Policy["profile"],
): void {
  const markers = sessionMarkers(manager);
  if (
    markers.length === 0 ||
    markers.some(
      (entry) => entry.type !== "custom" || !isRecord(entry.data) || entry.data.profile !== profile,
    )
  )
    throw new Error(
      "AI policy cannot resume history with a different or unknown profile. Start a new session without --continue, --resume or --session.",
    );
}

export function bindSessionPolicy(manager: SessionManager): Policy {
  const policy = loadPolicy();
  if (sessionMarkers(manager).length === 0 && manager.buildSessionContext().messages.length === 0)
    manager.appendCustomEntry("dstack-model-policy", { profile: policy.profile });
  authorizeSessionPolicy(manager, policy.profile);
  return policy;
}
