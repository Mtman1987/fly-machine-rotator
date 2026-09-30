import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isStreamSessionResetSuppressed } from "./streamSessionResetState.js";

export type StreamLiveState = {
  ok: boolean;
  login: string;
  isLive?: boolean;
  checkedAt: string;
  startedAt?: string | null;
  streamId?: string | null;
  error?: string;
};

export type StreamContinuityEvent = {
  at: string;
  kind: "pre-rotation" | "post-rotation" | "recovered" | "recovery-failed" | "watch-drop" | "watch-recovered" | "probe-error" | "planned-reset" | "planned-reset-complete" | "planned-reset-failed";
  appName?: string;
  login: string;
  detail?: string;
};

const DEFAULT_LOGIN = "spacemountainlive";
const DEFAULT_DSH = "https://discord-stream-hub-new.fly.dev";
const DEFAULT_HMO = "https://hearmeout-main.fly.dev";
const DEFAULT_HISTORY = "/data/stream-continuity.json";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function login(env: NodeJS.ProcessEnv) {
  return String(env.STREAM_CONTINUITY_TWITCH_LOGIN || DEFAULT_LOGIN).trim().replace(/^@/, "").toLowerCase();
}

function baseUrl(env: NodeJS.ProcessEnv) {
  return String(env.DSH_BASE_URL || DEFAULT_DSH).replace(/\/$/, "");
}

function apiKey(env: NodeJS.ProcessEnv) {
  return String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
}

function hmoBaseUrl(env: NodeJS.ProcessEnv) {
  return String(env.HEARMEOUT_BASE_URL || DEFAULT_HMO).replace(/\/$/, "");
}

function historyFile(env: NodeJS.ProcessEnv) {
  return String(env.STREAM_CONTINUITY_HISTORY_FILE || DEFAULT_HISTORY);
}

export async function probeStreamLiveState(env: NodeJS.ProcessEnv = process.env): Promise<StreamLiveState> {
  const twitchLogin = login(env);
  const key = apiKey(env);
  if (!key) {
    return { ok: false, login: twitchLogin, checkedAt: new Date().toISOString(), error: "SPMT API key is not configured" };
  }

  try {
    const response = await fetch(
      `${baseUrl(env)}/api/internal/twitch/live-status?login=${encodeURIComponent(twitchLogin)}`,
      {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(Number(env.STREAM_CONTINUITY_PROBE_TIMEOUT_MS || 10_000)),
      },
    );
    const body = await response.json().catch(() => null) as any;
    if (!response.ok || !body?.ok || typeof body?.isLive !== "boolean") {
      return {
        ok: false,
        login: twitchLogin,
        checkedAt: new Date().toISOString(),
        error: `DSH live-status probe failed (${response.status})`,
      };
    }
    return {
      ok: true,
      login: twitchLogin,
      isLive: body.isLive,
      checkedAt: String(body.checkedAt || new Date().toISOString()),
      startedAt: body.startedAt || null,
      streamId: body.streamId || null,
    };
  } catch {
    return { ok: false, login: twitchLogin, checkedAt: new Date().toISOString(), error: "DSH live-status probe did not complete" };
  }
}

export async function startStreamIfConfirmedOffline(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; reason?: string; twitch?: StreamLiveState; controller?: unknown }> {
  const before = await probeStreamLiveState(env);
  if (!before.ok) return { ok: false, reason: before.error || "Twitch live state could not be verified", twitch: before };
  if (before.isLive) return { ok: true, reason: "Twitch is already live", twitch: before };

  const key = apiKey(env);
  if (!key) return { ok: false, reason: "SPMT API key is not configured", twitch: before };

  let controller: any;
  try {
    const statusResponse = await fetch(`${hmoBaseUrl(env)}/api/internal/restream-control`, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    controller = await statusResponse.json().catch(() => null);
    if (!statusResponse.ok) {
      return { ok: false, reason: `Restream controller status failed (${statusResponse.status})`, twitch: before, controller };
    }
  } catch {
    return { ok: false, reason: "Restream controller status did not complete", twitch: before };
  }

  if (controller?.automationEnabled !== true) {
    return { ok: false, reason: "Restream automation is not enabled", twitch: before, controller };
  }
  if (controller?.state === "live") {
    return { ok: false, reason: "Restream says live while Twitch says offline; refusing an ambiguous restart", twitch: before, controller };
  }
  if (controller?.state !== "offline") {
    return { ok: false, reason: `Restream is not in a recognized offline state (state=${String(controller?.state || "unknown")})`, twitch: before, controller };
  }

  let startBody: any;
  try {
    const response = await fetch(`${hmoBaseUrl(env)}/api/internal/restream-control`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
      signal: AbortSignal.timeout(Number(env.STREAM_CONTINUITY_START_TIMEOUT_MS || 120_000)),
    });
    startBody = await response.json().catch(() => null);
    if (!response.ok || startBody?.ok === false) {
      return { ok: false, reason: String(startBody?.error || `Restream start failed (${response.status})`), twitch: before, controller: startBody || controller };
    }
  } catch {
    return { ok: false, reason: "Restream start request did not complete", twitch: before, controller };
  }

  const after = await waitForStreamRecovery(env);
  if (!after.ok || !after.isLive) {
    return { ok: false, reason: after.error || "Restream was started but Twitch did not become live", twitch: after, controller: startBody };
  }

  await recordStreamContinuityEvent({ kind: "recovered", detail: "Automatic start-only Restream recovery restored Twitch live state." }, env);
  return { ok: true, reason: "Twitch is live", twitch: after, controller: startBody };
}

export async function waitForStreamRecovery(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = Number(env.STREAM_CONTINUITY_RECOVERY_TIMEOUT_MS || 90_000),
  intervalMs = Number(env.STREAM_CONTINUITY_POLL_INTERVAL_MS || 5_000),
): Promise<StreamLiveState> {
  const deadline = Date.now() + Math.max(intervalMs, timeoutMs);
  let last: StreamLiveState = await probeStreamLiveState(env);
  if (last.ok && last.isLive) return last;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    last = await probeStreamLiveState(env);
    if (last.ok && last.isLive) return last;
  }
  return last;
}

export async function recordStreamContinuityEvent(
  event: Omit<StreamContinuityEvent, "at" | "login"> & { login?: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = historyFile(env);
  const row: StreamContinuityEvent = {
    at: new Date().toISOString(),
    login: event.login || login(env),
    kind: event.kind,
    appName: event.appName,
    detail: event.detail?.slice(0, 1000),
  };
  let rows: StreamContinuityEvent[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed)) rows = parsed;
  } catch {}
  rows.push(row);
  rows = rows.slice(-1000);
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(rows, null, 2), "utf8");
  } catch {
    // Continuity evidence is diagnostic; it must never break rotation/recovery.
  }
}

export async function notifyStreamContinuityOwner(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const key = apiKey(env);
  if (!key) return;
  try {
    const response = await fetch(`${baseUrl(env)}/api/internal/owner-dm`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message: String(message).slice(0, 1800) }),
      signal: AbortSignal.timeout(15_000),
    });
    await response.body?.cancel();
  } catch {}
}

export async function appendStreamContinuityIncident(
  appName: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = String(env.LOG_ERROR_HISTORY_FILE || "/data/error-history.json");
  let rows: any[] = [];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed)) rows = parsed;
  } catch {}
  rows.push({
    recordedAt: new Date().toISOString(),
    appName,
    fingerprint: `stream-continuity:${appName}`,
    message: String(message).slice(0, 2000),
    suggestion: "Inspect the app rotation/restart path, machine readiness, and stream continuity around the maintenance event.",
    context: [],
  });
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(rows.slice(-2000), null, 2), "utf8");
  } catch {
    // Keep the stream alert path alive even if durable incident storage is briefly unavailable.
  }
}


export async function startStreamContinuityWatchLoop(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  if (!apiKey(env) || env.STREAM_CONTINUITY_ENABLED === "false") {
    for (;;) await sleep(60_000);
  }
  const intervalMs = Number(env.STREAM_CONTINUITY_WATCH_INTERVAL_MS || 30_000);
  const dropGraceMs = Number(env.STREAM_CONTINUITY_DROP_GRACE_MS || 45_000);
  let lastConfirmedLive: boolean | undefined;
  let offlineSince: number | undefined;
  let notified = false;

  for (;;) {
    const state = await probeStreamLiveState(env);
    if (state.ok) {
      if (state.isLive) {
        if (lastConfirmedLive === false && notified) {
          await recordStreamContinuityEvent({ kind: "watch-recovered", detail: "Twitch live state recovered outside rotation." }, env);
          await notifyStreamContinuityOwner(`Twitch stream continuity recovered for **${state.login}** after an offline period.`, env);
        }
        lastConfirmedLive = true;
        offlineSince = undefined;
        notified = false;
      } else {
        const resetSuppressed = await isStreamSessionResetSuppressed(env);
        if (resetSuppressed) {
          offlineSince = undefined;
          notified = false;
          await sleep(intervalMs);
          continue;
        }
        if (lastConfirmedLive === true && offlineSince === undefined) offlineSince = Date.now();
        if (offlineSince !== undefined && !notified && Date.now() - offlineSince >= dropGraceMs) {
          lastConfirmedLive = false;
          notified = true;
          await recordStreamContinuityEvent({ kind: "watch-drop", detail: `Confirmed offline for at least ${dropGraceMs}ms outside a rotation.` }, env);
          await appendStreamContinuityIncident(
            String(env.STREAM_CONTINUITY_DEFAULT_APP || "streamweaver-new"),
            `Twitch stream ${state.login} dropped outside a planned rotation and remained offline past the continuity grace window.`,
            env,
          );
          const recovery = await startStreamIfConfirmedOffline(env);
          if (recovery.ok && recovery.twitch?.isLive) {
            await notifyStreamContinuityOwner(
              `✅ Twitch stream **${state.login}** was confirmed offline and Restream was started automatically. Twitch is live again.`,
              env,
            );
            lastConfirmedLive = true;
            offlineSince = undefined;
            notified = false;
          } else {
            await recordStreamContinuityEvent({ kind: "recovery-failed", detail: recovery.reason || "Automatic Restream start failed." }, env);
            await notifyStreamContinuityOwner(
              `🚨 Twitch stream **${state.login}** is offline and the one-shot automatic Restream start did not recover it. Reason: ${recovery.reason || "unknown"}`,
              env,
            );
          }
        }
      }
    } else {
      await recordStreamContinuityEvent({ kind: "probe-error", detail: state.error || "Continuity watch probe failed." }, env);
    }
    await sleep(intervalMs);
  }
}
