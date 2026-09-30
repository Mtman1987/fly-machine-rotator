import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  capNextRotationDelayForStreamReset,
  handleScheduledStreamSessionReset,
} from "../src/streamSessionReset.js";
import {
  readStreamSessionResetState,
  writeStreamSessionResetState,
} from "../src/streamSessionResetState.js";
import type { AppRotationResult } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function successResult(): AppRotationResult {
  return {
    appName: "streamweaver-new",
    success: true,
    dryRun: false,
    before: [],
    after: [],
    actions: [],
    warnings: [],
  };
}

async function testEnv(extra: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "rotator-stream-reset-"));
  return {
    SPMT_API_KEY: "test-spmt-key",
    STREAM_SESSION_RESET_STATE_FILE: join(dir, "state.json"),
    STREAM_CONTINUITY_HISTORY_FILE: join(dir, "continuity.json"),
    LOG_ERROR_HISTORY_FILE: join(dir, "errors.json"),
    STREAM_SESSION_RESET_POLL_INTERVAL_MS: "1",
    STREAM_SESSION_RESET_TWITCH_TIMEOUT_MS: "100",
    STREAM_SESSION_RESET_STABLE_CHECKS: "2",
    ...extra,
  };
}

describe("controlled Twitch session reset", () => {
  it("pulls the fourth rotation forward to the 46-hour target", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const env = await testEnv();
    await writeStreamSessionResetState({
      updatedAt: new Date(now).toISOString(),
      successfulAutoCycles: 3,
    }, env);

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      login: "spacemountainlive",
      isLive: true,
      checkedAt: new Date(now).toISOString(),
      startedAt: new Date(now - 36 * 60 * 60 * 1000).toISOString(),
      streamId: "old-stream",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const delay = await capNextRotationDelayForStreamReset(12 * 60 * 60 * 1000, env, now);
    expect(delay).toBe(10 * 60 * 60 * 1000);
  });

  it("resets on the fourth successful auto cycle and requires a new stable Twitch session", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const env = await testEnv();
    await writeStreamSessionResetState({
      updatedAt: new Date(now).toISOString(),
      successfulAutoCycles: 3,
    }, env);

    let twitchCalls = 0;
    let resetPosts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/internal/twitch/live-status")) {
        twitchCalls += 1;
        const fresh = twitchCalls >= 2;
        return new Response(JSON.stringify({
          ok: true,
          login: "spacemountainlive",
          isLive: true,
          checkedAt: new Date(now + twitchCalls).toISOString(),
          startedAt: fresh
            ? new Date(now + 1_000).toISOString()
            : new Date(now - 36 * 60 * 60 * 1000).toISOString(),
          streamId: fresh ? "new-stream" : "old-stream",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/internal/restream-control") && (init?.method || "GET") === "GET") {
        return new Response(JSON.stringify({ automationEnabled: true, state: "live" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/internal/restream-control") && init?.method === "POST") {
        resetPosts += 1;
        return new Response(JSON.stringify({ ok: true, action: "controlled-reset" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/internal/owner-dm")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Unexpected fetch " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleScheduledStreamSessionReset([successResult()], "auto", env, now);
    expect(result).toMatchObject({ appName: "twitch-stream-session", success: true });
    expect(resetPosts).toBe(1);

    const state = await readStreamSessionResetState(env);
    expect(state.successfulAutoCycles).toBe(0);
    expect(state.lastControlledResetStreamId).toBe("new-stream");
    expect(state.planned?.active).toBe(false);
  });

  it("fails closed without clicking when the Restream profile is not automation-ready", async () => {
    const now = Date.parse("2026-09-30T12:00:00.000Z");
    const env = await testEnv();
    await writeStreamSessionResetState({
      updatedAt: new Date(now).toISOString(),
      successfulAutoCycles: 3,
    }, env);

    let resetPosts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/internal/twitch/live-status")) {
        return new Response(JSON.stringify({
          ok: true,
          login: "spacemountainlive",
          isLive: true,
          checkedAt: new Date(now).toISOString(),
          startedAt: new Date(now - 47 * 60 * 60 * 1000).toISOString(),
          streamId: "old-stream",
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/internal/restream-control") && (init?.method || "GET") === "GET") {
        return new Response(JSON.stringify({ automationEnabled: false, state: "login_required" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/internal/restream-control") && init?.method === "POST") {
        resetPosts += 1;
        throw new Error("reset must not be posted");
      }
      if (url.includes("/api/internal/owner-dm")) {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("Unexpected fetch " + url);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await handleScheduledStreamSessionReset([successResult()], "auto", env, now);
    expect(result).toMatchObject({ appName: "twitch-stream-session", success: false });
    expect(resetPosts).toBe(0);
    expect(String(result?.error)).toMatch(/not enabled/i);

    const state = await readStreamSessionResetState(env);
    expect(state.successfulAutoCycles).toBe(4);
    expect(state.planned?.active).toBe(false);
    expect(state.suppressWatchUntil).toBeTruthy();
  });

  it("does nothing for manual rotations or missing service auth", async () => {
    const env = await testEnv();
    expect(await handleScheduledStreamSessionReset([successResult()], "manual", env)).toBeNull();
    expect(await handleScheduledStreamSessionReset([successResult()], "auto", {
      ...env,
      SPMT_API_KEY: "",
      SPMT_PLATFORM_API_KEY: "",
    })).toBeNull();
  });
});
