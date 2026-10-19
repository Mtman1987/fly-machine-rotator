import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyIncident } from "../src/incidentClassifier.js";
import {
  advanceStreamContinuityWatchState,
  probeStreamLiveState,
  type StreamContinuityWatchState,
} from "../src/streamContinuity.js";

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

  it("starts the offline grace window even when the monitor boots while Twitch is already offline", () => {
    const initial: StreamContinuityWatchState = { notified: false };
    const first = advanceStreamContinuityWatchState(initial, {
      isLive: false,
      now: 1_000,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
    });
    expect(first.shouldAttemptRecovery).toBe(false);
    expect(first.state.offlineSince).toBe(1_000);

    const afterGrace = advanceStreamContinuityWatchState(first.state, {
      isLive: false,
      now: 46_000,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
    });
    expect(afterGrace.shouldAttemptRecovery).toBe(true);
    expect(afterGrace.firstAttempt).toBe(true);
    expect(afterGrace.state.lastAttemptAt).toBe(46_000);
  });

  it("retries a failed recovery only after the bounded retry interval", () => {
    const afterFirstAttempt: StreamContinuityWatchState = {
      lastConfirmedLive: false,
      offlineSince: 1_000,
      lastAttemptAt: 46_000,
      notified: true,
    };
    const tooSoon = advanceStreamContinuityWatchState(afterFirstAttempt, {
      isLive: false,
      now: 105_999,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
    });
    expect(tooSoon.shouldAttemptRecovery).toBe(false);

    const retryReady = advanceStreamContinuityWatchState(afterFirstAttempt, {
      isLive: false,
      now: 106_000,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
    });
    expect(retryReady.shouldAttemptRecovery).toBe(true);
    expect(retryReady.firstAttempt).toBe(false);
  });

  it("clears the offline timer during a planned reset", () => {
    const current: StreamContinuityWatchState = {
      lastConfirmedLive: true,
      offlineSince: 1_000,
      lastAttemptAt: 46_000,
      notified: true,
    };
    const suppressed = advanceStreamContinuityWatchState(current, {
      isLive: false,
      now: 50_000,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
      resetSuppressed: true,
    });
    expect(suppressed.suppressed).toBe(true);
    expect(suppressed.state.offlineSince).toBeUndefined();
    expect(suppressed.state.lastAttemptAt).toBeUndefined();
    expect(suppressed.state.notified).toBe(false);
  });

  it("recognizes an offline-to-live recovery and resets retry state", () => {
    const current: StreamContinuityWatchState = {
      lastConfirmedLive: false,
      offlineSince: 1_000,
      lastAttemptAt: 46_000,
      notified: true,
    };
    const recovered = advanceStreamContinuityWatchState(current, {
      isLive: true,
      now: 47_000,
      dropGraceMs: 45_000,
      retryIntervalMs: 60_000,
    });
    expect(recovered.streamRecovered).toBe(true);
    expect(recovered.state.lastConfirmedLive).toBe(true);
    expect(recovered.state.offlineSince).toBeUndefined();
    expect(recovered.state.lastAttemptAt).toBeUndefined();
    expect(recovered.state.notified).toBe(false);
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
