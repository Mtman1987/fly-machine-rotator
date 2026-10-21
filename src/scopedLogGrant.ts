import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

type ScopedClaims = {
  iss?: string; aud?: string; scope?: string; requestId?: string;
  jti?: string; sub?: string; exp?: number;
};

function equal(left: string, right: string) {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

let consumeQueue: Promise<unknown> = Promise.resolve();

export async function consumeScopedLogGrant(token: string, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; reason?: string }> {
  const secret = String(env.SPMT_DELEGATION_SIGNING_SECRET || "").trim();
  if (secret.length < 32) return { ok: false, reason: "grant_verification_not_configured" };
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed_grant" };
  const input = parts.slice(0, 2).join(".");
  const expected = createHmac("sha256", secret).update(input).digest("base64url");
  if (!equal(expected, parts[2])) return { ok: false, reason: "invalid_signature" };
  let header: any; let claims: ScopedClaims;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return { ok: false, reason: "malformed_grant" }; }
  if (header?.alg !== "HS256" || header?.typ !== "JWT") return { ok: false, reason: "invalid_algorithm" };
  if (claims.iss !== "https://spmt.live" || claims.aud !== "mtman-machine-rotator") return { ok: false, reason: "wrong_issuer_or_audience" };
  if (claims.scope !== "logs:read:last24h" || !claims.requestId || !claims.jti || !claims.sub) return { ok: false, reason: "wrong_scope_or_missing_claims" };
  if (!Number.isFinite(claims.exp) || Number(claims.exp) <= Math.floor(Date.now() / 1000)) return { ok: false, reason: "grant_expired" };

  const file = join(String(env.ROTATOR_EVIDENCE_DIR || "/data/operations-evidence"), "consumed-scoped-log-grants.json");
  const run = async () => {
    await mkdir(dirname(file), { recursive: true });
    let consumed: string[] = [];
    try { consumed = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(consumed)) consumed = []; } catch {}
    if (consumed.includes(String(claims.jti))) return { ok: false, reason: "grant_replayed" };
    consumed = [...consumed.slice(-4999), String(claims.jti)];
    await writeFile(file, JSON.stringify(consumed), { mode: 0o600 });
    return { ok: true };
  };
  const pending = consumeQueue.then(run, run);
  consumeQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

export async function storePendingScopedLogGrant(requestId: string, token: string, env: NodeJS.ProcessEnv = process.env) {
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(requestId) || !token || token.length > 8000) throw new Error("Invalid scoped grant handoff");
  const file = join(String(env.ROTATOR_EVIDENCE_DIR || "/data/operations-evidence"), "pending-scoped-log-grants.json");
  const run = async () => {
    await mkdir(dirname(file), { recursive: true });
    let items: Array<{ requestId: string; token: string; storedAt: string }> = [];
    try { items = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(items)) items = []; } catch {}
    if (items.some((item) => item.requestId === requestId)) return;
    items = [...items.slice(-99), { requestId, token, storedAt: new Date().toISOString() }];
    await writeFile(file, JSON.stringify(items), { mode: 0o600 });
  };
  const pending = consumeQueue.then(run, run);
  consumeQueue = pending.then(() => undefined, () => undefined);
  await pending;
}

export async function takePendingScopedLogGrant(env: NodeJS.ProcessEnv = process.env): Promise<{ requestId: string; token: string } | null> {
  const file = join(String(env.ROTATOR_EVIDENCE_DIR || "/data/operations-evidence"), "pending-scoped-log-grants.json");
  let result: { requestId: string; token: string } | null = null;
  const run = async () => {
    await mkdir(dirname(file), { recursive: true });
    let items: Array<{ requestId: string; token: string; storedAt: string }> = [];
    try { items = JSON.parse(await readFile(file, "utf8")); if (!Array.isArray(items)) items = []; } catch {}
    const now = Date.now();
    items = items.filter((item) => now - Date.parse(item.storedAt) < 2 * 60 * 1000);
    const item = items.shift();
    if (item) result = { requestId: item.requestId, token: item.token };
    await writeFile(file, JSON.stringify(items), { mode: 0o600 });
  };
  const pending = consumeQueue.then(run, run);
  consumeQueue = pending.then(() => undefined, () => undefined);
  await pending;
  return result;
}
