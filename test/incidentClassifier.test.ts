import { describe, expect, it } from "vitest";
import { classifyIncident, evaluateAutoFixEligibility } from "../src/incidentClassifier.js";
import { deriveIgnoreRegex, isUnsafeIgnoreRule } from "../src/ignoreRules.js";
import type { FixRecord } from "../src/fixStore.js";

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

  it("classifies the July 23 TTS, Twitch identifier, and leaderboard families", () => {
    expect(classifyIncident(event("streamweaver-new", "leaked", "[TTS] gemini failed: API key was reported as leaked: 403"))).toMatchObject({ key: "streamweaver-new:tts-provider-authorization", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "quota", "[TTS] Gemini TTS failed: 429 RESOURCE_EXHAUSTED quota"))).toMatchObject({ key: "streamweaver-new:tts-provider-quota", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "fallback", "TTS error: Error: Fallback TTS failed: 401"))).toMatchObject({ key: "streamweaver-new:legacy-tts-fallback-authorization", disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("streamweaver-new", "login", "Failed to fetch Twitch user: 400 Bad Identifiers"))).toMatchObject({ key: "streamweaver-new:twitch-login-normalization", disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("streamweaver-new", "login-cascade", "[WalkOn] Twitch profile lookup failed for madired29:; using fallback persona Error: Failed to fetch Twitch user: Bad Request", ["Failed to fetch Twitch user: 400 Bad Identifiers"]))).toMatchObject({ key: "streamweaver-new:twitch-login-normalization", disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("streamweaver-new", "shared-auth", "[SharedChat] Broadcaster lookup failed for nephalem2 (401)"))).toMatchObject({ key: "streamweaver-new:outbound-shared-chat-delivery", disposition: "auth_config" });
    expect(classifyIncident(event("discord-stream-hub-new", "render", "[generateLeaderboardImage] Failed: Error [TimeoutError]: Waiting failed: 20000ms exceeded"))).toMatchObject({ key: "discord-stream-hub-new:leaderboard-render-timeout", disposition: "transient_external" });
  });

  it("routes current source-owned null and JSON failures to AI review", () => {
    expect(classifyIncident(event("chat-tag-bot-new", "null", "Periodic loop failed: Cannot read properties of null (reading 'players')"))).toMatchObject({ disposition: "code", autoFixEligible: true });
    expect(classifyIncident(event("hearmeout-main", "json", "SyntaxError: Expected property name or '}' in JSON at position 1"))).toMatchObject({ disposition: "code", autoFixEligible: true });
  });

  it("groups the current transport, permission, and controlled-input families without code patches", () => {
    expect(classifyIncident(event("hearmeout-main", "peer", "message: 'peer signaling error | remote=abc | Error: Lost connection to server.'"))).toMatchObject({ key: "hearmeout-main:livekit-peer-signaling", disposition: "transient_external" });
    expect(classifyIncident(event("hearmeout-main", "invite", "[WatchRequest] Discord activity invite failed: 404 { message: 'Unknown Channel' }"))).toMatchObject({ disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "pusher", "[Kick] Pusher connection error", ["code: 4200, message: 'Please reconnect immediately'"]))).toMatchObject({ disposition: "transient_external" });
    expect(classifyIncident(event("streamweaver-new", "json", "[Next.js ERROR] [Discord Chat] Salvaged malformed JSON payload"))).toMatchObject({ disposition: "expected_user" });
    expect(classifyIncident(event("chat-tag-bot-new", "scope", "Unauthorized: broadcaster must authorize channel:bot scope"))).toMatchObject({ disposition: "auth_config" });
    expect(classifyIncident(event("hearmeout-main", "pu02", "[PU02] could not complete HTTP request to instance: legacy hyper error: http2 error: stream error sent by user: stream no longer needed"))).toMatchObject({ key: "hearmeout-main:fly-proxy-http2-cancellation", disposition: "transient_external", autoFixEligible: false });
    const malformedBridgeContext = ["'guildId',", "'channelId',", "'messageId',", "'userAvatar'"];
    expect(classifyIncident(event("chat-tag-new", "json-child", "error: \"Expected ',' or '}' after property value in JSON at position 95\"", malformedBridgeContext))).toMatchObject({ key: "chat-tag-new:controlled-discord-chat-json", disposition: "expected_user", autoFixEligible: false });
    expect(classifyIncident(event("streamweaver-new", "json-child", "error: \"Expected ',' or '}' after property value in JSON at position 95\"", malformedBridgeContext))).toMatchObject({ key: "streamweaver-new:controlled-discord-chat-json", disposition: "expected_user", autoFixEligible: false });
  });

  it("classifies post-hardening transport, lifecycle, and credential families without model guessing", () => {
    expect(classifyIncident(event("hearmeout-main", "ping", "[09:15] error: Ping timeout."))).toMatchObject({ key: "hearmeout-main:twitch-chat-transport", disposition: "transient_external" });
    expect(classifyIncident(event("streamweaver-new", "login", "[Twitch:community-bot] Disconnected: Login authentication failed"))).toMatchObject({ key: "streamweaver-new:twitch-chat-authentication", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "eventsub", "[EventSub:47145728] Socket closed: 4002 failed ping pong"))).toMatchObject({ key: "streamweaver-new:eventsub-ping-timeout", disposition: "transient_external" });
    expect(classifyIncident(event("streamweaver-new", "banned", "[SharedChat] Join before send failed for #infuse_carnage: msg_banned"))).toMatchObject({ key: "streamweaver-new:shared-chat-channel-banned", disposition: "auth_config" });
    expect(classifyIncident(event("streamweaver-new", "gone", "[Next.js ERROR] [Discord Cleanup] Message delete failed: {\"status\":404,\"error\":\"Unknown Message\"}"))).toMatchObject({ key: "streamweaver-new:discord-cleanup-already-deleted", disposition: "expected_user" });
    expect(classifyIncident(event("streamweaver-new", "pipe", "[PP03] could not proxy TCP data: Broken pipe (os error 32)"))).toMatchObject({ key: "streamweaver-new:fly-proxy-connection-reset", disposition: "transient_external" });
    expect(classifyIncident(event("hearmeout-main", "action", "Error: Failed to find Server Action \"abc\". This request might be from an older or newer deployment."))).toMatchObject({ key: "hearmeout-main:stale-server-action-client", disposition: "transient_external" });
    expect(classifyIncident(event("hearmeout-main", "gemini", "Error fetching from https://generativelanguage.googleapis.com: API key not valid."))).toMatchObject({ key: "hearmeout-main:gemini-api-authorization", disposition: "auth_config" });
    expect(classifyIncident(event("hearmeout-main", "eof", "ERROR unexpected error replying to request error=EOF ok=true"))).toMatchObject({ key: "hearmeout-main:fly-client-disconnect", disposition: "transient_external" });
    expect(classifyIncident(event("hearmeout-main", "media", "message: 'outgoing media call failed | remote=voice | Error: Negotiation of connection failed.'"))).toMatchObject({ key: "hearmeout-main:livekit-peer-signaling", disposition: "transient_external" });
    expect(classifyIncident(event("hmo-dj-worker", "rate", "[VoiceBridge] start failed for mtman: ws failure: HTTP error: 429 Too Many Requests"))).toMatchObject({ key: "hmo-dj-worker:livekit-voice-bridge-rate-limit", disposition: "transient_external" });
    expect(classifyIncident(event("hmo-dj-worker", "channel", "[VoiceBridge] start failed for discord-activity: Unknown Channel"))).toMatchObject({ key: "hmo-dj-worker:discord-voice-channel", disposition: "auth_config" });
  });

  it("requires a ready or verified quality verdict before automatic application", () => {
    const current = {
      recordedAt: new Date().toISOString(),
      appName: "chat-tag-bot-new",
      fingerprint: "null",
      message: "Periodic loop failed: Cannot read properties of null (reading 'players')",
      suggestion: "guard the payload",
      context: [],
    };
    const record = {
      id: "chat-tag-bot-new::null",
      appName: "chat-tag-bot-new",
      fingerprint: "null",
      status: "generated",
      updatedAt: new Date().toISOString(),
      confidence: "high",
      confidenceScore: 90,
      changes: [{ path: "bot.js", reason: "validate response", content: "const safe = true;\n" }],
      attempts: [],
      repoSnapshot: { capturedAt: new Date().toISOString(), repoPath: "/repo", headCommit: "abc", dirty: false, contextPaths: ["bot.js"] },
      qualityGate: {
        updatedAt: new Date().toISOString(), overallConfidence: 80, rootCauseConfidence: 90, patchConfidence: 85,
        testConfidence: 80, rollbackConfidence: 80, postDeployConfidence: 35, verdict: "review", signals: [],
      },
    } as FixRecord;
    expect(evaluateAutoFixEligibility(current, record)).toMatchObject({ eligible: false });
    record.qualityGate!.verdict = "ready";
    expect(evaluateAutoFixEligibility(current, record)).toMatchObject({ eligible: true });
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
