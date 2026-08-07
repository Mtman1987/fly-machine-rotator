import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";
import { requireSpmtAdmin } from "./spmtAuth.js";

const buckets = new Map<string, number[]>();
let auditChain = Promise.resolve();

function header(request: Pick<IncomingMessage, "headers">, name: string): string {
  const value = request.headers[name];
  return String(Array.isArray(value) ? value[0] : value || "").trim();
}

function requesterKey(request: IncomingMessage): string {
  const authorization = header(request, "authorization");
  const cookie = header(request, "cookie");
  const forwarded = header(request, "x-forwarded-for").split(",")[0]?.trim();
  const address = forwarded || request.socket.remoteAddress || "unknown";
  return createHash("sha256").update(`${authorization}\n${cookie}\n${address}`).digest("hex").slice(0, 24);
}

export function isOwnerMutationPath(pathname: string): boolean {
  return pathname.startsWith("/actions/")
    || pathname.startsWith("/api/codex/")
    || pathname.startsWith("/api/llm-control/")
    || pathname.startsWith("/api/mcp/")
    || pathname.startsWith("/mcp/");
}

export function isSameOriginMutation(request: IncomingMessage): boolean {
  if (header(request, "authorization").toLowerCase().startsWith("bearer ")) return true;
  const origin = header(request, "origin");
  const host = header(request, "host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function consumeOwnerMutationRate(request: IncomingMessage, env: NodeJS.ProcessEnv, now = Date.now()): { ok: boolean; retryAfter: number } {
  const max = Math.max(5, Math.min(300, Number(env.ROTATOR_MUTATION_RATE_LIMIT || 60)));
  const windowMs = Math.max(10_000, Math.min(10 * 60_000, Number(env.ROTATOR_MUTATION_RATE_WINDOW_MS || 60_000)));
  const key = requesterKey(request);
  const recent = (buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - recent[0])) / 1000)) };
  }
  recent.push(now);
  buckets.set(key, recent);
  return { ok: true, retryAfter: 0 };
}

export async function authorizeOwnerMutation(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; status: number; error: string; retryAfter?: number }> {
  if (!isSameOriginMutation(request)) return { ok: false, status: 403, error: "Owner mutation requires a same-origin browser request or SPMT bearer token." };
  const identity = await requireSpmtAdmin(request, env).catch(() => null);
  if (!identity) return { ok: false, status: 401, error: "SPMT owner/admin session required." };
  const rate = consumeOwnerMutationRate(request, env);
  if (!rate.ok) return { ok: false, status: 429, error: "Too many Rotator mutations.", retryAfter: rate.retryAfter };
  return { ok: true };
}

export async function auditOwnerMutation(request: IncomingMessage, env: NodeJS.ProcessEnv, pathname: string, outcome: string, status: number): Promise<void> {
  const file = String(env.ROTATOR_ACTION_AUDIT_FILE || "/data/rotator-action-audit.jsonl");
  const record = {
    at: new Date().toISOString(),
    requester: requesterKey(request),
    method: String(request.method || "GET").toUpperCase(),
    pathname: pathname.slice(0, 500),
    outcome: outcome.slice(0, 80),
    status,
  };
  auditChain = auditChain.catch(() => undefined).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  });
  await auditChain;
}
