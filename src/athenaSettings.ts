import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readSpmtAccessToken, requireSpmtIdentity } from "./spmtAuth.js";

type LocalSettings = {
  useSharedUi: boolean;
  appearance: {
    glassOpacity: number;
    blurStrength: number;
    glowIntensity: number;
    cornerRadius: number;
    animations: boolean;
  };
};

const defaults: LocalSettings = {
  useSharedUi: true,
  appearance: { glassOpacity: 0.82, blurStrength: 18, glowIntensity: 0.7, cornerRadius: 22, animations: true },
};

export async function handleAthenaSettingsRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (!url.pathname.startsWith("/athena/api/settings")) return false;
  const identity = await requireSpmtIdentity(request, env).catch(() => null);
  if (!identity) return send(response, 401, { error: "SPMT login required" });

  if (request.method === "GET") {
    const local = await readLocal(env);
    const shared = await fetchShared(request, env).catch((error) => ({ ok: false, error: message(error) }));
    return send(response, 200, { local, shared });
  }

  if (request.method === "PATCH" && url.pathname === "/athena/api/settings/local") {
    const body = await readJson(request);
    const next = normalizeLocal(body);
    await saveLocal(env, next);
    return send(response, 200, { ok: true, local: next });
  }

  if (request.method === "PATCH" && url.pathname === "/athena/api/settings/shared") {
    return send(response, 410, {
      error: "Shared workspace settings are edited only through the canonical SPMT surface.",
      surface: "settings",
    });
  }

  return send(response, 404, { error: "Not found" });
}

function settingsFile(env: NodeJS.ProcessEnv) {
  return env.ATHENA_LOCAL_SETTINGS_FILE || join(env.ROTATOR_DATA_DIR || "/data", "athena-local-settings.json");
}
async function readLocal(env: NodeJS.ProcessEnv): Promise<LocalSettings> {
  try { return normalizeLocal(JSON.parse(await readFile(settingsFile(env), "utf8"))); } catch { return defaults; }
}
async function saveLocal(env: NodeJS.ProcessEnv, value: LocalSettings) {
  const file = settingsFile(env); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2));
}
function normalizeLocal(value: any): LocalSettings {
  const a = value?.appearance || {};
  return {
    useSharedUi: value?.useSharedUi !== false,
    appearance: {
      glassOpacity: number(a.glassOpacity, defaults.appearance.glassOpacity, 0.25, 1),
      blurStrength: number(a.blurStrength, defaults.appearance.blurStrength, 0, 40),
      glowIntensity: number(a.glowIntensity, defaults.appearance.glowIntensity, 0, 1),
      cornerRadius: number(a.cornerRadius, defaults.appearance.cornerRadius, 4, 40),
      animations: a.animations !== false,
    },
  };
}
function number(value: unknown, fallback: number, min: number, max: number) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }

function surfaceList(payload: any) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.surfaces)) return payload.surfaces;
  return [];
}

async function fetchShared(request: IncomingMessage, env: NodeJS.ProcessEnv) {
  const token = readSpmtAccessToken(request); if (!token) throw new Error("SPMT access token missing");
  const base = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const [profileResponse, surfacesResponse, personalResponse, publicResponse] = await Promise.all([
    fetch(`${base}/api/workspace-profile`, { headers, signal: AbortSignal.timeout(12_000) }),
    fetch(`${base}/api/platform/surfaces`, { headers, signal: AbortSignal.timeout(12_000) }),
    fetch(`${base}/api/personal-overlay-launch`, { headers, signal: AbortSignal.timeout(12_000) }),
    fetch(`${base}/api/tenant-scene?output=public`, { headers, signal: AbortSignal.timeout(12_000) }),
  ]);
  const [payload, surfacesPayload, personalPayload, publicPayload] = await Promise.all([
    profileResponse.json().catch(() => ({})),
    surfacesResponse.json().catch(() => ({})),
    personalResponse.json().catch(() => ({})),
    publicResponse.json().catch(() => ({})),
  ]);
  if (!profileResponse.ok) throw new Error((payload as any)?.error || `SPMT shared settings load failed (${profileResponse.status})`);

  const personalOverlayUrl = personalResponse.ok ? String((personalPayload as any)?.url || "") : "";
  const publicOverlayUrl = publicResponse.ok ? String((publicPayload as any)?.urls?.public || "") : "";
  const surfaces = surfacesResponse.ok ? surfaceList(surfacesPayload) : [];

  return {
    ok: true,
    ...(payload as object),
    canonical: {
      origin: base,
      surfaces,
      outputs: {
        public: publicOverlayUrl,
        personal: personalOverlayUrl,
      },
    },
    surfaces,
    tenantOutputs: {
      public: publicOverlayUrl,
      personal: personalOverlayUrl,
    },
    personalOverlayUrl,
  };
}

async function readJson(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const raw = Buffer.concat(chunks).toString("utf8"); return raw ? JSON.parse(raw) : {}; }
function message(error: unknown) { return error instanceof Error ? error.message : String(error); }
function send(response: ServerResponse, status: number, value: unknown): true { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(value)); return true; }
