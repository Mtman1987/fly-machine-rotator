import type { StoredErrorEvent } from "./aiFixer.js";
import type { FixRecord } from "./fixStore.js";

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
  if (event.appName === "chat-tag-bot-new" && lower.includes("/api/kick/broadcast") && /\b(?:401|unauthorized)\b/.test(lower)) {
    return classification("chat-tag-bot-new:kick-broadcast-authorization", "auth_config", "The Chat Tag bot and app disagree on the internal service credential; verify the bot-facing secret contract and keep the StreamWeaver credential separate.");
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
  if (lower.includes("health check") && lower.includes("has failed") && lower.includes("app is not responding properly")) {
    return classification(`${event.appName}:fly-health-transition`, "transient_external", "Fly observed a health-check transition, commonly during a scheduled restart. Confirm recovery before escalating; a single transition is not a code-fix request.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("missing broadcaster token or refresh token")) {
    return classification("streamweaver-new:missing-broadcaster-authorization", "auth_config", "A tenant has no usable broadcaster grant. Re-authorize that tenant; do not ask the coding model to manufacture OAuth tokens.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("tts generation failed") && /\b401\b/.test(lower)) {
    return classification("streamweaver-new:tts-provider-authorization", "auth_config", "The configured TTS provider rejected its credential. Repair the tenant provider credential or routing configuration.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("seaart task timed out")) {
    return classification("streamweaver-new:seaart-generation-timeout", "transient_external", "SeaArt did not finish the generation within the polling window. Retry with bounded polling and only escalate after repeated terminal timeouts.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("failed to create webhook") && /\b404\b/.test(lower)) {
    return classification("streamweaver-new:discord-webhook-unavailable", "auth_config", "The target Discord channel cannot create or expose a webhook. Verify the channel mapping and Manage Webhooks permission; the bot fallback should remain available.");
  }
  if (event.appName === "streamweaver-new" && lower.includes("edenai returned no visible text")) {
    return classification("streamweaver-new:private-chat-empty-provider-response", "code", "The private-chat provider returned no displayable content; retry/fallback and structured content extraction belong in the app adapter.");
  }
  if (event.appName === "chat-tag-bot-new" && lower.includes("cannot read properties of null") && lower.includes("players")) {
    return classification("chat-tag-bot-new:null-live-announcement-payload", "code", "The periodic live-announcement response can be null and must be validated before reading players.");
  }
  if (event.appName === "hearmeout-main" && lower.includes("expected property name") && lower.includes("json")) {
    return classification("hearmeout-main:malformed-json-input", "code", "A request path parses malformed JSON without returning a controlled 400 response.");
  }
  if (lower.includes("could not establish signal connection") && lower.includes("websocket")) {
    return classification(`${event.appName}:websocket-signal-connect`, "transient_external", "The realtime signalling websocket failed to establish. Retry with bounded backoff before treating it as an application defect.");
  }
  if (/\[(?:pp|pu)\d+\]/i.test(evidence) && lower.includes("connection reset")) {
    return classification(`${event.appName}:fly-proxy-connection-reset`, "transient_external", "Fly proxy transport reset a connection. Keep it observable only when bounded client retry also fails.");
  }
  if (event.appName === "discord-stream-hub-new" && (
    lower.includes("failed to edit message") || lower.includes("message update failed")
  ) && /\b(?:500|502|503|504)\b/.test(lower)) {
    return classification("discord-stream-hub-new:message-edit-5xx", "transient_external", "Discord returned a retryable 5xx response; retry and observe before proposing code.");
  }
  if (event.appName === "discord-stream-hub-new" && lower.includes("signature verification failed")) {
    return classification("discord-stream-hub-new:signature-verification", "auth_config", "A failed Discord signature check is a security signal and must remain visible; verify the public key, raw request body, and timestamp handling.");
  }
  if (event.appName === "discord-stream-hub-new" && lower.includes("body is unusable") && lower.includes("already been read")) {
    return { key: "discord-stream-hub-new:request-body-double-read", disposition: "code", autoFixEligible: true, reason: "The route consumed a request body twice while attempting its JSON fallback; parse a single captured body instead." };
  }
  if (event.appName === "hmo-dj-worker" && lower.includes("sign in to confirm you're not a bot")) {
    return classification("hmo-dj-worker:youtube-bot-challenge", "auth_config", "YouTube challenged the server-side extractor; refresh the authorized extraction path or use the browser-resolved upload/cache handoff.");
  }
  if (event.appName === "hmo-dj-worker" && lower.includes("no youtube") && lower.includes("stream")) {
    return classification("hmo-dj-worker:youtube-source-unresolved", "transient_external", "The external source resolver returned no playable stream; retry through the browser-resolved handoff and keep the failure visible if all fallbacks fail.");
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
