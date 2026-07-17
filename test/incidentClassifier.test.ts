import { describe, expect, it } from "vitest";
import { classifyIncident } from "../src/incidentClassifier.js";
import { deriveIgnoreRegex } from "../src/ignoreRules.js";

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

  it("groups Discord edit 5xx responses as transient external failures", () => {
    expect(classifyIncident(event("discord-stream-hub-new", "one", "Failed to edit message: 500 Internal Server Error"))).toMatchObject({ key: "discord-stream-hub-new:message-edit-5xx", disposition: "transient_external", autoFixEligible: false });
  });
});
