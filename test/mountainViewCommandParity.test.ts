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
  const directory = await mkdtemp(join(tmpdir(), "mountainview-command-parity-"));
  tempDirs.push(directory);
  const server = startDashboardServer({
    NODE_ENV: "test",
    PORT: "0",
    MOUNTAINVIEW_DB_FILE: join(directory, "mountainview.db"),
    MOUNTAINVIEW_CONFIG_FILE: join(directory, "mountainview-config.json"),
    MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY: "test-encryption-key",
    MOUNTAINVIEW_AUTH_DISABLED: "true",
    MOUNTAINVIEW_AI_ROUTER_DISABLED: "true",
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
      context: { routeMode: "command", tenantId: "test-tenant", username: "test-tenant" },
    }),
  });
  expect(response.status).toBe(200);
  return await response.json() as {
    decision: {
      commandId: string;
      appId: string;
      mode: string;
      confidence?: number;
      payload: Record<string, any>;
    };
  };
}

describe("MountainView end-to-end command parity", () => {
  it("routes OBS scene language only to the paired PC Companion", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "switch OBS to BRB");
      expect(decision.commandId).toBe("cmd_companion_obs_scene");
      expect(decision.appId).toBe("spmt");
      expect(String(decision.payload.sceneName).toLowerCase()).toBe("brb");
      expect(Number(decision.confidence)).toBeGreaterThanOrEqual(0.95);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("routes a concrete Squad Goals request to HearMeOut without clarification", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const { decision } = await route(baseUrl, "play the song Squad Goals by Prof");
      expect(decision.commandId).toBe("cmd_hearmeout_song_request");
      expect(decision.appId).toBe("hearmeout");
      expect(String(decision.payload.query).toLowerCase()).toBe("squad goals by prof");
      expect(decision.payload.needsClarification).not.toBe(true);
      expect(Number(decision.confidence)).toBeGreaterThanOrEqual(0.95);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("separates Discord-wide live status from Chat Tag SPMT live", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const everyone = await route(baseUrl, "who's live");
      expect(everyone.decision.commandId).toBe("cmd_discord_live_members");
      expect(everyone.decision.appId).toBe("chat-tag");

      const chatTag = await route(baseUrl, "who's active in Chat Tag");
      expect(chatTag.decision.commandId).toBe("cmd_chat_tag_spmt_live");
      expect(chatTag.decision.appId).toBe("chat-tag");

      const explicit = await route(baseUrl, "SPMT live");
      expect(explicit.decision.commandId).toBe("cmd_chat_tag_spmt_live");
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("recognizes core PC Companion controls with deterministic payloads", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const mute = await route(baseUrl, "mute the PC companion");
      expect(mute.decision.commandId).toBe("cmd_companion_audio_mute");
      expect(mute.decision.payload.muted).toBe(true);

      const unmute = await route(baseUrl, "unmute the PC companion");
      expect(unmute.decision.commandId).toBe("cmd_companion_audio_mute");
      expect(unmute.decision.payload.muted).toBe(false);

      const volume = await route(baseUrl, "set PC companion volume to 50 percent");
      expect(volume.decision.commandId).toBe("cmd_companion_audio_volume");
      expect(volume.decision.payload.volume).toBe(0.5);
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("does not advertise dead HearMeOut routes as voice-ready commands", async () => {
    const { server, baseUrl } = await startServer();
    try {
      const response = await fetch(`${baseUrl}/mountainview/api/commands`);
      expect(response.status).toBe(200);
      const payload = await response.json() as { commands?: Array<{ id?: string }> };
      const ids = new Set((payload.commands || []).map((command) => String(command.id || "")));

      expect(ids.has("cmd_companion_obs_scene")).toBe(true);
      expect(ids.has("cmd_chat_tag_spmt_live")).toBe(true);
      expect(ids.has("cmd_discord_live_members")).toBe(true);
      expect(ids.has("cmd_hearmeout_song_request")).toBe(true);
      expect(ids.has("cmd_hearmeout_music_control")).toBe(true);

      for (const dead of [
        "cmd_hearmeout_voice_room",
        "cmd_hearmeout_voice_peers",
        "cmd_hearmeout_watch_request",
        "cmd_hearmeout_watch_control",
        "cmd_hearmeout_discord_message",
      ]) {
        expect(ids.has(dead), dead).toBe(false);
      }
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
