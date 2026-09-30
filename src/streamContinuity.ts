import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  kind: "pre-rotation" | "post-rotation" | "recovered" | "recovery-failed" | "watch-drop" | "watch-recovered" | "probe-error";
  appName?: string;
  login: string;
  detail?: string;
};

const DEFAULT_LOGIN = "spacemountainlive";
const DEFAULT_DSH = "https://discord-stream-hub-new.fly.dev";
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
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(rows, null, 2), "utf8");
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
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(rows.slice(-2000), null, 2), "utf8");
}
