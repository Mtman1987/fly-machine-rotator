import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/dashboardServer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), "mountainview-discord-routing-"));
  tempDirs.push(directory);
  const server = startDashboardServer({
    NODE_ENV: "test",
    PORT: "0",
    MOUNTAINVIEW_DB_FILE: join(directory, "mountainview.db"),
    MOUNTAINVIEW_CONFIG_FILE: join(directory, "mountainview-config.json"),
    MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    MOUNTAINVIEW_AUTH_DISABLED: "true",
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a TCP port");
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function route(baseUrl: string, transcript: string) {
  const response = await fetch(`${baseUrl}/mountainview/api/voice/route`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      transcript,
      dryRun: true,
      context: { routeMode: "chat", tenantId: "94371378", username: "mtman1987" },
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as { decision: { commandId: string; appId: string; mode: string; transcript: string; payload: Record<string, unknown> } };
}

describe("MountainView Discord command routing", () => {
  it("keeps Discord-bound speech on Discord commands instead of the conversational runtime", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const cases: Array<{ transcript: string; commandId: string; appId: string; message: string }> = [
        { transcript: "send a discord message that says stream is starting", commandId: "cmd_discord_message", appId: "discordstreamhub", message: "stream is starting" },
        { transcript: "post to discord that we are live", commandId: "cmd_discord_message", appId: "discordstreamhub", message: "we are live" },
        { transcript: "tell discord we are going live", commandId: "cmd_discord_message", appId: "discordstreamhub", message: "we are going live" },
        { transcript: "announce in discord that the raid is coming", commandId: "cmd_discord_message", appId: "discordstreamhub", message: "the raid is coming" },
      ];

      for (const testCase of cases) {
        const { decision } = await route(baseUrl, testCase.transcript);
        expect(decision.mode, testCase.transcript).toBe("action");
        expect(decision.commandId, testCase.transcript).toBe(testCase.commandId);
        expect(decision.appId, testCase.transcript).toBe(testCase.appId);
        expect(decision.transcript, testCase.transcript).toBe(testCase.message);
        expect(decision.payload.destination, testCase.transcript).toBe("discord");
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("keeps calendar and event language on their own DiscordStreamHub commands", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const calendar = await route(baseUrl, "post the calendar to discord");
      expect(calendar.decision.commandId).toBe("cmd_dsh_calendar_post");
      expect(calendar.decision.appId).toBe("discordstreamhub");

      const event = await route(baseUrl, "push event to discord");
      expect(event.decision.commandId).toBe("cmd_discord_event");
      expect(event.decision.payload.destination).toBe("discord");

      const mission = await route(baseUrl, "add a calendar event for friday at 8 pm mod meeting");
      expect(mission.decision.commandId).toBe("cmd_dsh_calendar_add_mission");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("marks catalog-matched Discord commands with a Discord destination", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "send discord stream message");
      expect(decision.commandId).toBe("cmd_discord_message");
      expect(decision.payload.destination).toBe("discord");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("asks for the body instead of posting the command itself", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "send a discord message");
      expect(decision.commandId).toBe("cmd_discord_message");
      expect(decision.payload.needsClarification).toBe(true);
      expect(decision.payload.missing).toBe("message");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("keeps channel nouns out of the dictated message body", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "post to the discord server: doors open at 8");
      expect(decision.commandId).toBe("cmd_discord_message");
      expect(decision.transcript).toBe("doors open at 8");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("still routes Twitch chat speech to StreamWeaver with the Discord mirror enabled", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "send a message that says hello chat");
      expect(decision.commandId).toBe("cmd_streamweaver_twitch_chat_send");
      expect(decision.payload.destination).toBe("twitch");
      expect(decision.payload.bridgeToDiscord).toBe(true);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
