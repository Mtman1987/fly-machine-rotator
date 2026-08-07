import { describe, expect, it } from "vitest";
import {
  buildAthenaGatewayHeaders,
  buildAthenaGatewayPayload,
  normalizeAthenaProxyHistory,
} from "../src/athenaOsChatProxy.js";

describe("AthenaOS Rotator chat proxy", () => {
  it("normalizes supported history and keeps the most recent forty messages", () => {
    const input = [
      { role: "tool", content: "ignored" },
      { role: "system", content: "  system context  " },
      { role: "assistant", content: " prior reply " },
      { role: "user", content: " latest question " },
      { role: "user", content: "" },
    ];

    expect(normalizeAthenaProxyHistory(input)).toEqual([
      { role: "system", content: "system context" },
      { role: "assistant", content: "prior reply" },
      { role: "user", content: "latest question" },
    ]);

    const many = Array.from({ length: 45 }, (_, index) => ({
      role: "user",
      content: `message-${index}`,
    }));
    const normalized = normalizeAthenaProxyHistory(many);
    expect(normalized).toHaveLength(40);
    expect(normalized[0]?.content).toBe("message-5");
    expect(normalized.at(-1)?.content).toBe("message-44");
  });

  it("forwards the actual SPMT OAuth token without an Athena or worker key", () => {
    expect(buildAthenaGatewayHeaders("spmt-issued-access-token")).toEqual({
      authorization: "Bearer spmt-issued-access-token",
      "content-type": "application/json",
      accept: "application/json",
    });
    expect(buildAthenaGatewayHeaders("spmt-issued-access-token")).not.toHaveProperty("x-bot-secret");
    expect(buildAthenaGatewayHeaders("spmt-issued-access-token")).not.toHaveProperty("x-athena-key");
    expect(() => buildAthenaGatewayHeaders("")).toThrow(/SPMT access token/i);
  });

  it("builds one private Rotator location envelope for the unified gateway", () => {
    const identity = {
      id: "spmt-user-1",
      twitchId: "123456789",
      username: "mtman1987",
      displayName: "M.T.",
      role: "owner",
      isAdmin: true,
    } as any;
    const built = buildAthenaGatewayPayload(identity, {
      provider: "openai",
      model: "gpt-test",
      temperature: 1.2,
      conversationId: "my-private-thread",
      messages: [
        { role: "system", content: "old UI context" },
        { role: "assistant", content: "earlier answer" },
        { role: "user", content: "what is live right now?" },
      ],
    });

    expect(built.admin).toBe(true);
    expect(built.adultMode).toBe(false);
    expect(built.payload).toMatchObject({
      tenantId: "123456789",
      message: "what is live right now?",
      visibility: "private",
      conversationId: "my-private-thread",
      executeTools: true,
      actor: {
        userId: "123456789",
        username: "mtman1987",
        displayName: "M.T.",
        isOwner: true,
        isAdmin: true,
      },
      location: {
        app: "fly-machine-rotator",
        surface: "rotator-workbench",
        live: false,
        layout: "athena-llm-workbench",
        replyMode: "structured",
      },
      metadata: {
        authentication: "forwarded-spmt-oauth",
        requestedProvider: "openai",
        requestedModel: "gpt-test",
        requestedTemperature: 1.2,
        canonicalProviderPolicy: "local-qwen-private-network",
      },
    });
    expect(built.payload.location.capabilities).toEqual(expect.arrayContaining([
      "athena.memory.public",
      "athena.memory.private",
      "rotator.read-tools",
    ]));
    expect(built.payload.transientHistory).toEqual([
      { role: "system", content: "old UI context" },
      { role: "assistant", content: "earlier answer" },
    ]);
  });

  it("uses the authenticated username when no canonical numeric identity is present", () => {
    const built = buildAthenaGatewayPayload({
      username: "captain",
      displayName: "Captain",
      role: "admin",
      isAdmin: true,
    } as any, {
      messages: [{ role: "user", content: "hello" }],
    });

    expect(built.payload.tenantId).toBe("captain");
    expect(built.payload.conversationId).toBe("rotator-workbench:captain");
    expect(built.payload.actor.userId).toBe("captain");
  });

  it("rejects a request with no user message", () => {
    expect(() => buildAthenaGatewayPayload({ username: "captain" } as any, {
      messages: [{ role: "assistant", content: "no user turn" }],
    })).toThrow(/user chat message/i);
  });
});
