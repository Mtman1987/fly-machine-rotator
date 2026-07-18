import { describe, expect, it } from "vitest";
import { classifyIncident } from "../src/incidentClassifier.js";
import { deriveIgnoreRegex, isUnsafeIgnoreRule } from "../src/ignoreRules.js";

const event = (appName: string, fingerprint: string, message: string, context: string[] = []) => ({ appName, fingerprint, message, context });

describe("incident classifier", () => {
  it("classifies Chat-Tag not-in-game responses as expected user state", () => {
    expect(classifyIncident(event("chat-tag-bot-new", "one", '[API Error] /api/tag: 404 {"error":"You are not in the game!"}'))).toMatchObject({ key: "chat-tag-bot-new:user-not-in-game", disposition: "expected_user", autoFixEligible: false });
  });

  it("derives one reusable ignore rule for every not-in-game log echo", () => {
    const pattern = deriveIgnoreRegex('[API Error] /api/tag: 404 {"error":"You are not in the game! Use spmt join first."}');
    expect(new RegExp(pattern, "i").test('[Bot] Tag error: You are not in the game! Use spmt join first.')).toBe(true);
  });

  it("groups StreamWeaver shared-chat and walk-on cascades", () => {
    const direct = classifyIncident(event("streamweaver-new", "one", "Shared chat source-only send failed (permission)"));
    const cascade = classifyIncident(event("streamweaver-new", "two", "[WalkOnRecovery] Retry failed: Twitch client not available for sending messages"));
    expect(cascade.key).toBe(direct.key);
    expect(direct).toMatchObject({ key: "streamweaver-new:outbound-shared-chat-delivery", disposition: "auth_config", autoFixEligible: false });
  });

  it("groups Kick chatroom resolution echoes as one tenant authorization incident", () => {
    const direct = classifyIncident(event("streamweaver-new", "one", "[Kick] Connection error: Could not resolve chatroom ID for ladyheidi."));
    const cascade = classifyIncident(event("streamweaver-new", "two", "[MultiPlatform] Event error: {", ["error: Could not resolve chatroom ID for ladyheidi."]));
    expect(cascade.key).toBe(direct.key);
    expect(direct).toMatchObject({ key: "streamweaver-new:kick-chatroom-authorization", disposition: "auth_config", autoFixEligible: false });
  });

  it("groups Discord edit 5xx responses as transient external failures", () => {
    expect(classifyIncident(event("discord-stream-hub-new", "one", "Failed to edit message: 500 Internal Server Error"))).toMatchObject({ key: "discord-stream-hub-new:message-edit-5xx", disposition: "transient_external", autoFixEligible: false });
  });

  it("groups Chat-Tag announce retry and attachment fallback echoes", () => {
    const first = classifyIncident(event("chat-tag-new", "one", "[Announce] Discord webhook failed: 500"));
    const fallback = classifyIncident(event("chat-tag-new", "two", "[Announce] failed to fetch/embed image", ["[cause]: Error: unknown scheme"]));
    expect(fallback.key).toBe(first.key);
    expect(first).toMatchObject({ key: "chat-tag-new:discord-announce-delivery", disposition: "transient_external" });
  });

  it("keeps auth failures, rate limits, and platform command mismatches visible without guessing", () => {
    expect(classifyIncident(event("discord-stream-hub-new", "sig", "[DiscordInteractions] Signature verification failed"))).toMatchObject({ disposition: "auth_config", autoFixEligible: false });
    expect(classifyIncident(event("streamweaver-new", "rate", "Failed to fetch Twitch user: 429 Too Many Requests"))).toMatchObject({ disposition: "transient_external", autoFixEligible: false });
    expect(classifyIncident(event("discord-stream-hub-new", "shell", "powershell executable file not found"))).toMatchObject({ disposition: "code", autoFixEligible: true });
  });

  it("classifies the current Gate 0 production incident families", () => {
    expect(classifyIncident(event("chat-tag-bot-new", "kick", "[API Error] /api/kick/broadcast: 401 Unauthorized"))).toMatchObject({ disposition: "auth_config", autoFixEligible: false });
    expect(classifyIncident(event("discord-stream-hub-new", "body", "[ForwardForum] Error: TypeError: Body is unusable: Body has already been read"))).toMatchObject({ disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("hmo-dj-worker", "bot", "ERROR: Sign in to confirm you're not a bot"))).toMatchObject({ disposition: "auth_config", autoFixEligible: false });
    expect(classifyIncident(event("hmo-dj-worker", "bot-curly", "ERROR: Sign in to confirm you’re not a bot"))).toMatchObject({ key: "hmo-dj-worker:youtube-bot-challenge", disposition: "auth_config", autoFixEligible: false });
    expect(classifyIncident(event("hmo-dj-worker", "source", "No YouTube audio/video stream resolved"))).toMatchObject({ disposition: "transient_external", autoFixEligible: false });
  });

  it("keeps restart, auth, and external provider incidents away from the coding model", () => {
    expect(classifyIncident(event("streamweaver-new", "health", "Health check 'servicecheck-00-http-3000' on port 3000 has failed. Your app is not responding properly."))).toMatchObject({ disposition: "transient_external", autoFixEligible: false });
    expect(classifyIncident(event("streamweaver-new", "oauth", "Missing broadcaster token or refresh token"))).toMatchObject({ key: "streamweaver-new:missing-broadcaster-authorization", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "tts", "TTS generation failed: HTTP 401"))).toMatchObject({ key: "streamweaver-new:tts-provider-authorization", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "seaart", "SeaArt task timed out"))).toMatchObject({ key: "streamweaver-new:seaart-generation-timeout", disposition: "transient_external" });
  });

  it("routes current source-owned null and JSON failures to AI review", () => {
    expect(classifyIncident(event("chat-tag-bot-new", "null", "Periodic loop failed: Cannot read properties of null (reading 'players')"))).toMatchObject({ disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("hearmeout-main", "json", "SyntaxError: Expected property name or '}' in JSON at position 1"))).toMatchObject({ disposition: "code", autoFixEligible: true });
  });

  it("does not let nearby auth logs contaminate the current error classification", () => {
    expect(classifyIncident(event("streamweaver-new", "webhook", "Webhook send failed: Failed to create webhook: 404", ["Could not resolve chatroom ID for ladyheidi"]))).toMatchObject({ key: "streamweaver-new:discord-webhook-unavailable" });
    expect(classifyIncident(event("streamweaver-new", "empty", "[Private Chat API] EdenAI returned no visible text", ["TTS generation failed: HTTP 401"]))).toMatchObject({ key: "streamweaver-new:private-chat-empty-provider-response", disposition: "code" });
  });

  it("prunes historical rules that hide actionable incidents", () => {
    const createdAt = new Date().toISOString();
    expect(isUnsafeIgnoreRule({ id: "sig", kind: "app_message_regex", pattern: "Signature verification failed", createdAt })).toBe(true);
    expect(isUnsafeIgnoreRule({ id: "rate", kind: "app_message_regex", note: "429 Too Many Requests", createdAt })).toBe(true);
    expect(isUnsafeIgnoreRule({ id: "noise", kind: "app_message_regex", pattern: "You are not in the game!", createdAt })).toBe(false);
  });
});
