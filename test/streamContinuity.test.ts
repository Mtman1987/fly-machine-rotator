import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyIncident } from "../src/incidentClassifier.js";
import { probeStreamLiveState } from "../src/streamContinuity.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("stream continuity", () => {
  it("uses the authenticated DSH witness and preserves a definite live state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      login: "spacemountainlive",
      isLive: true,
      checkedAt: "2026-09-30T12:00:00.000Z",
      startedAt: "2026-09-30T11:00:00.000Z",
      streamId: "abc",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const state = await probeStreamLiveState({
      SPMT_API_KEY: "secret-value",
      DSH_BASE_URL: "https://dsh.example",
      STREAM_CONTINUITY_TWITCH_LOGIN: "SpaceMountainLive",
    });
    expect(state.ok).toBe(true);
    expect(state.isLive).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/api/internal/twitch/live-status?login=spacemountainlive");
    expect((init as RequestInit).headers).toEqual({ authorization: "Bearer secret-value" });
  });

  it("does not treat a witness failure as offline", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("bad gateway", { status: 502 })));
    const state = await probeStreamLiveState({ SPMT_API_KEY: "secret-value" });
    expect(state.ok).toBe(false);
    expect(state.isLive).toBeUndefined();
  });

  it("classifies a failed rotation recovery as gated code-owned repair work", () => {
    const result = classifyIncident({
      appName: "streamweaver-new",
      fingerprint: "stream-continuity:streamweaver-new",
      message: "Twitch stream was confirmed live before rotating streamweaver-new, went offline after the rotation, and failed to recover after one bounded recovery attempt.",
      context: [],
    });
    expect(result.autoFixEligible).toBe(true);
    expect(result.key).toContain("rotation-induced-stream-continuity");
  });

  it("guards each app rotation and stops the maintenance cycle on unrecovered stream loss", () => {
    const source = readFileSync(resolve(process.cwd(), "src/rotationRunner.ts"), "utf8");
    expect(source).toContain("probeStreamLiveState(env)");
    expect(source).toContain("waitForStreamRecovery");
    expect(source).toContain("attempting one bounded recovery rotation");
    expect(source).toContain("Stopping remaining app rotations because stream continuity recovery failed");
  });
});
