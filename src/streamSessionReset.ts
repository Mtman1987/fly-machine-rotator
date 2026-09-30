import type { AppRotationResult } from "./types.js";
import {
  appendStreamContinuityIncident,
  notifyStreamContinuityOwner,
  probeStreamLiveState,
  recordStreamContinuityEvent,
  type StreamLiveState,
} from "./streamContinuity.js";
import {
  readStreamSessionResetState,
  writeStreamSessionResetState,
} from "./streamSessionResetState.js";

const DEFAULT_HMO_BASE_URL = "https://hearmeout-main.fly.dev";
const DEFAULT_TARGET_HOURS = 46;
const DEFAULT_MAX_CYCLES = 4;

function apiKey(env: NodeJS.ProcessEnv) {
  return String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
}

function hmoBaseUrl(env: NodeJS.ProcessEnv) {
  return String(env.HEARMEOUT_BASE_URL || DEFAULT_HMO_BASE_URL).replace(/\/$/, "");
}

function targetHours(env: NodeJS.ProcessEnv) {
  const value = Number(env.STREAM_SESSION_RESET_TARGET_HOURS || DEFAULT_TARGET_HOURS);
  return Number.isFinite(value) ? Math.max(36, Math.min(value, 47)) : DEFAULT_TARGET_HOURS;
}

function maxCycles(env: NodeJS.ProcessEnv) {
  const value = Number(env.STREAM_SESSION_RESET_MAX_CYCLES || DEFAULT_MAX_CYCLES);
  return Number.isFinite(value) ? Math.max(2, Math.min(Math.floor(value), 8)) : DEFAULT_MAX_CYCLES;
}

function syntheticResult(success: boolean, actions: string[] = [], warnings: string[] = [], error?: string): AppRotationResult {
  return {
    appName: "twitch-stream-session",
    success,
    dryRun: false,
    before: [],
    after: [],
    actions,
    warnings,
    ...(error ? { error } : {}),
  };
}

async function restreamStatus(env: NodeJS.ProcessEnv) {
  const key = apiKey(env);
  if (!key) throw new Error("SPMT API key is not configured");
  const response = await fetch(`${hmoBaseUrl(env)}/api/internal/restream-control`, {
    headers: { authorization: `Bearer ${key}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Restream controller status failed (${response.status})`);
  return body as any;
}

async function runRestreamReset(env: NodeJS.ProcessEnv) {
  const key = apiKey(env);
  if (!key) throw new Error("SPMT API key is not configured");
  const response = await fetch(`${hmoBaseUrl(env)}/api/internal/restream-control`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      action: "reset",
      holdMs: Number(env.STREAM_SESSION_RESET_HOLD_MS || 15_000),
    }),
    signal: AbortSignal.timeout(Number(env.STREAM_SESSION_RESET_CONTROLLER_TIMEOUT_MS || 120_000)),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok === false) {
    throw new Error(String(body?.error || `Restream controlled reset failed (${response.status})`).slice(0, 800));
  }
  return body as any;
}

function sessionChanged(before: StreamLiveState, after: StreamLiveState) {
  if (!after.ok || !after.isLive) return false;
  if (before.streamId && after.streamId && before.streamId !== after.streamId) return true;
  if (before.startedAt && after.startedAt && before.startedAt !== after.startedAt) {
    const beforeAt = Date.parse(before.startedAt);
    const afterAt = Date.parse(after.startedAt);
    return !Number.isFinite(beforeAt) || !Number.isFinite(afterAt) || afterAt > beforeAt;
  }
  return false;
}

async function waitForStableNewTwitchSession(
  before: StreamLiveState,
  env: NodeJS.ProcessEnv,
): Promise<StreamLiveState> {
  const timeoutMs = Number(env.STREAM_SESSION_RESET_TWITCH_TIMEOUT_MS || 150_000);
  const intervalMs = Number(env.STREAM_SESSION_RESET_POLL_INTERVAL_MS || 5_000);
  const stableChecks = Math.max(2, Number(env.STREAM_SESSION_RESET_STABLE_CHECKS || 3));
  const deadline = Date.now() + timeoutMs;
  let last = await probeStreamLiveState(env);
  let stable = 0;
  let identity = "";

  while (Date.now() < deadline) {
    if (sessionChanged(before, last)) {
      const nextIdentity = String(last.streamId || last.startedAt || "");
      if (nextIdentity && nextIdentity === identity) stable += 1;
      else {
        identity = nextIdentity;
        stable = 1;
      }
      if (stable >= stableChecks) return last;
    } else {
      stable = 0;
      identity = "";
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    last = await probeStreamLiveState(env);
  }
  return last;
}

export async function capNextRotationDelayForStreamReset(
  defaultDelayMs: number,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<number> {
  if (env.STREAM_SESSION_RESET_ENABLED === "false" || !apiKey(env)) return defaultDelayMs;
  const state = await readStreamSessionResetState(env);
  const live = await probeStreamLiveState(env).catch(() => null);

  if (live?.ok && live.isLive && live.startedAt) {
    state.lastObservedTwitchStartedAt = live.startedAt;
    await writeStreamSessionResetState(state, env).catch(() => {});
    const startedAt = Date.parse(live.startedAt);
    if (Number.isFinite(startedAt)) {
      const targetAt = startedAt + targetHours(env) * 60 * 60 * 1000;
      return Math.max(0, Math.min(defaultDelayMs, targetAt - now));
    }
  }

  if (state.successfulAutoCycles >= maxCycles(env) - 1) {
    const fourthCycleFallback = Number(env.STREAM_SESSION_RESET_FOURTH_CYCLE_DELAY_MS || 10 * 60 * 60 * 1000);
    return Math.max(0, Math.min(defaultDelayMs, fourthCycleFallback));
  }
  return defaultDelayMs;
}

export async function handleScheduledStreamSessionReset(
  results: AppRotationResult[],
  trigger: string,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<AppRotationResult | null> {
  if (env.STREAM_SESSION_RESET_ENABLED === "false" || trigger !== "auto") return null;
  if (!results.length || results.some(result => !result.success)) return null;

  const state = await readStreamSessionResetState(env);
  state.successfulAutoCycles += 1;

  const live = await probeStreamLiveState(env);
  if (live.ok && live.isLive && live.startedAt) state.lastObservedTwitchStartedAt = live.startedAt;

  const startedAt = live.startedAt ? Date.parse(live.startedAt) : Number.NaN;
  const ageHours = Number.isFinite(startedAt) ? (now - startedAt) / (60 * 60 * 1000) : 0;
  const dueByAge = live.ok && live.isLive && ageHours >= targetHours(env);
  const dueByCycle = state.successfulAutoCycles >= maxCycles(env);
  const due = dueByAge || dueByCycle;

  if (!due) {
    await writeStreamSessionResetState(state, env);
    return null;
  }

  if (live.ok && live.isLive === false) {
    state.successfulAutoCycles = 0;
    state.lastObservedTwitchStartedAt = undefined;
    state.lastControlledResetAt = new Date(now).toISOString();
    state.planned = { active: false };
    await writeStreamSessionResetState(state, env);
    return syntheticResult(true, ["Twitch was already offline when the controlled session reset became due; no Restream click was needed."]);
  }

  if (!live.ok || !live.isLive) {
    await writeStreamSessionResetState(state, env);
    const message = "The controlled Twitch session reset is due, but current Twitch live state could not be verified. Restream was not clicked.";
    await notifyStreamContinuityOwner(`⚠️ ${message}`, env);
    return syntheticResult(false, [], ["Reset was intentionally not attempted without a verified live precondition."], message);
  }

  try {
    const controller = await restreamStatus(env);
    if (controller?.automationEnabled !== true) {
      throw new Error("Restream automation is not enabled on the Lounge worker");
    }
    if (controller?.state !== "live") {
      throw new Error(`Restream controller is not in a recognized live state (state=${String(controller?.state || "unknown")})`);
    }

    state.planned = {
      active: true,
      startedAt: new Date(now).toISOString(),
      reason: "planned-twitch-48h-session-reset",
    };
    state.suppressWatchUntil = undefined;
    await writeStreamSessionResetState(state, env);
    await recordStreamContinuityEvent({
      kind: "planned-reset",
      detail: `Starting controlled Twitch session reset after ${state.successfulAutoCycles} successful auto-rotation cycles.`,
    }, env);

    await runRestreamReset(env);
    const after = await waitForStableNewTwitchSession(live, env);
    if (!sessionChanged(live, after)) {
      throw new Error("Restream returned to its live UI, but Twitch did not confirm a new stream session");
    }

    state.successfulAutoCycles = 0;
    state.lastObservedTwitchStartedAt = after.startedAt || undefined;
    state.lastControlledResetAt = new Date().toISOString();
    state.lastControlledResetStreamId = after.streamId || undefined;
    state.planned = { active: false };
    state.suppressWatchUntil = undefined;
    await writeStreamSessionResetState(state, env);
    await recordStreamContinuityEvent({
      kind: "planned-reset-complete",
      detail: `Controlled reset succeeded; new Twitch stream id=${after.streamId || "unknown"} startedAt=${after.startedAt || "unknown"}.`,
    }, env);
    await notifyStreamContinuityOwner(
      `✅ Controlled Twitch session reset completed. Restream was stopped and restarted intentionally, and Twitch confirmed a new stable live session for **${after.login}**.`,
      env,
    );

    return syntheticResult(true, [
      "Completed the planned pre-48-hour Restream stop/start.",
      "Verified Twitch returned with a new stream session.",
      "Reset the scheduled-session cycle counter to 0.",
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.planned = { active: false };
    state.suppressWatchUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await writeStreamSessionResetState(state, env).catch(() => {});
    await recordStreamContinuityEvent({ kind: "planned-reset-failed", detail: message }, env);
    await appendStreamContinuityIncident(
      "hearmeout-main",
      `Planned pre-48-hour Restream/Twitch session reset failed: ${message}`,
      env,
    );
    await notifyStreamContinuityOwner(
      `🚨 The planned Twitch session reset failed before the 48-hour limit. The rotator stopped the maintenance cycle instead of blind-clicking Restream. Reason: ${message}`,
      env,
    );
    return syntheticResult(false, [], ["No additional Restream clicks will be attempted during this run."], message);
  }
}
