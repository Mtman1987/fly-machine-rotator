import { StoredErrorEvent } from "./aiFixer.js";
import { FixRecord } from "./fixStore.js";

export type IncidentDisposition = "expected_user" | "auth_config" | "transient_external" | "code" | "unknown";

export interface IncidentClassification {
  key: string;
  disposition: IncidentDisposition;
  autoFixEligible: boolean;
  reason: string;
}

export function classifyIncident(event: Pick<StoredErrorEvent, "appName" | "message" | "context" | "fingerprint">): IncidentClassification {
  const evidence = [event.message, ...(event.context || [])].join("\n");
  const lower = evidence.toLowerCase();

  if (event.appName === "chat-tag-bot-new" && lower.includes("you are not in the game")) {
    return classification("chat-tag-bot-new:user-not-in-game", "expected_user", "Normal command rejection; the player must join before tagging.");
  }
  if (event.appName === "streamweaver-new" && (
    lower.includes("shared chat source-only send") ||
    lower.includes("walkonrecovery") && lower.includes("twitch client not available for sending messages")
  )) {
    return classification("streamweaver-new:outbound-shared-chat-delivery", "auth_config", "Shared-chat delivery depends on stored Twitch authorization and must not be patched automatically.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("could not resolve chatroom id")) {
    return classification("streamweaver-new:kick-chatroom-authorization", "auth_config", "The stored tenant Kick grant cannot resolve its broadcaster/chat identity; repair the API contract or re-authorize that tenant instead of generating a code patch from each log echo.");
  }
  if (event.appName === "discord-stream-hub-new" && (
    lower.includes("failed to edit message") || lower.includes("message update failed")
  ) && /\b(?:500|502|503|504)\b/.test(lower)) {
    return classification("discord-stream-hub-new:message-edit-5xx", "transient_external", "Discord returned a retryable 5xx response; retry and observe before proposing code.");
  }
  if (event.appName === "discord-stream-hub-new" && lower.includes("signature verification failed")) {
    return classification("discord-stream-hub-new:signature-verification", "auth_config", "A failed Discord signature check is a security signal and must remain visible; verify the public key, raw request body, and timestamp handling.");
  }
  if (/\b(?:429|too many requests)\b/.test(lower) && lower.includes("twitch")) {
    return classification(`${event.appName}:twitch-rate-limit`, "transient_external", "Twitch rate limiting needs shared caching, request coalescing, and bounded backoff; it must not be hidden as noise.");
  }
  if (event.appName === "chat-tag-new" && lower.includes("[announce]") && (
    lower.includes("discord webhook failed") ||
    lower.includes("failed to fetch/embed image") ||
    lower.includes("unknown scheme")
  )) {
    return classification("chat-tag-new:discord-announce-delivery", "transient_external", "The Discord announce retry and attachment fallback form one external-delivery incident.");
  }
  if (/\b(?:500|502|503|504)\b/.test(lower) || lower.includes("server error")) {
    return classification(`${event.appName}:upstream-5xx`, "transient_external", "An upstream 5xx remains observable until bounded retries succeed or the dependency recovers.");
  }
  if (lower.includes("powershell") && lower.includes("executable file not found")) {
    return classification(`${event.appName}:platform-command-mismatch`, "code", "The deployed Linux runtime attempted to invoke a Windows-only executable.");
  }
  if (/\b(?:syntaxerror|referenceerror|typeerror)\b/i.test(event.message) && /(?:\/app\/|src\/|src\\)/i.test(evidence)) {
    return { key: `${event.appName}:code:${event.fingerprint}`, disposition: "code", autoFixEligible: true, reason: "A source-backed runtime exception is eligible for a gated code proposal." };
  }
  return classification(`${event.appName}:unknown:${event.fingerprint}`, "unknown", "The incident has not been deterministically classified as code-owned.");
}

export function evaluateAutoFixEligibility(event: StoredErrorEvent, record: FixRecord): { eligible: boolean; reasons: string[] } {
  const incident = classifyIncident(event);
  const reasons: string[] = [];
  if (!incident.autoFixEligible) reasons.push(incident.reason);
  if (record.changes.length === 0) reasons.push("The proposal contains no file changes.");
  if (record.changes.length > 4) reasons.push("The proposal changes more than four files.");
  if (record.changes.some((change) => !change.reason.trim())) reasons.push("Every changed file must include a reason.");
  if ((record.confidenceScore ?? 0) < 75 && record.confidence !== "high") reasons.push("Root-cause confidence is below the automatic-apply threshold.");
  if (!record.repoSnapshot?.headCommit || record.repoSnapshot.dirty) reasons.push("The proposal is not based on a clean captured commit.");
  if (record.qualityGate?.verdict === "blocked") reasons.push("The proposal quality gate is blocked.");
  return { eligible: reasons.length === 0, reasons };
}

function classification(key: string, disposition: IncidentDisposition, reason: string): IncidentClassification {
  return { key, disposition, autoFixEligible: disposition === "code", reason };
}
