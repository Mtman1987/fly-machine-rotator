import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export interface StreamSessionResetState {
  updatedAt: string;
  successfulAutoCycles: number;
  lastObservedTwitchStartedAt?: string;
  lastControlledResetAt?: string;
  lastControlledResetStreamId?: string;
  planned?: {
    active: boolean;
    startedAt?: string;
    reason?: string;
  };
  suppressWatchUntil?: string;
}

const DEFAULT_STATE: StreamSessionResetState = {
  updatedAt: new Date(0).toISOString(),
  successfulAutoCycles: 0,
};

export function getStreamSessionResetStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.STREAM_SESSION_RESET_STATE_FILE || "/data/stream-session-reset-state.json");
}

export async function readStreamSessionResetState(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StreamSessionResetState> {
  try {
    const parsed = JSON.parse(await readFile(getStreamSessionResetStateFile(env), "utf8")) as Partial<StreamSessionResetState>;
    return {
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : DEFAULT_STATE.updatedAt,
      successfulAutoCycles:
        typeof parsed.successfulAutoCycles === "number" && Number.isFinite(parsed.successfulAutoCycles)
          ? Math.max(0, Math.floor(parsed.successfulAutoCycles))
          : 0,
      lastObservedTwitchStartedAt:
        typeof parsed.lastObservedTwitchStartedAt === "string" ? parsed.lastObservedTwitchStartedAt : undefined,
      lastControlledResetAt:
        typeof parsed.lastControlledResetAt === "string" ? parsed.lastControlledResetAt : undefined,
      lastControlledResetStreamId:
        typeof parsed.lastControlledResetStreamId === "string" ? parsed.lastControlledResetStreamId : undefined,
      planned: parsed.planned && typeof parsed.planned === "object"
        ? {
            active: parsed.planned.active === true,
            startedAt: typeof parsed.planned.startedAt === "string" ? parsed.planned.startedAt : undefined,
            reason: typeof parsed.planned.reason === "string" ? parsed.planned.reason : undefined,
          }
        : undefined,
      suppressWatchUntil:
        typeof parsed.suppressWatchUntil === "string" ? parsed.suppressWatchUntil : undefined,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function writeStreamSessionResetState(
  state: StreamSessionResetState,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const file = getStreamSessionResetStateFile(env);
  const next = { ...state, updatedAt: new Date().toISOString() };
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2), "utf8");
}

export async function isStreamSessionResetSuppressed(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<boolean> {
  const state = await readStreamSessionResetState(env);
  if (state.planned?.active) return true;
  const until = state.suppressWatchUntil ? Date.parse(state.suppressWatchUntil) : Number.NaN;
  return Number.isFinite(until) && until > now;
}
