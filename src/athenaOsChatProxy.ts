import type { IncomingMessage, ServerResponse } from "node:http";
import { isSpmtAdmin, requireSpmtIdentity, type SpmtIdentity } from "./spmtAuth.js";

export type AthenaProxyChatMessage = {
  role?: unknown;
  content?: unknown;
};

export type AthenaProxyChatRequest = {
  messages?: AthenaProxyChatMessage[];
  provider?: string;
  model?: string;
  temperature?: number;
  adultMode?: boolean;
  adultConfirmed?: boolean;
  conversationId?: string;
  confirmedActionId?: string;
};

export type NormalizedAthenaHistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

function sendJson(response: ServerResponse, status: number, value: unknown): true {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
  return true;
}

async function readJson(request: IncomingMessage): Promise<AthenaProxyChatRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 1_000_000) throw new Error("Chat request is too large");
    chunks.push(value);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) as AthenaProxyChatRequest : {};
}

function firstIdentityString(identity: SpmtIdentity, keys: string[]): string {
  for (const key of keys) {
    const value = identity[key];
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }
  return "";
}

export function normalizeAthenaProxyHistory(value: unknown): NormalizedAthenaHistoryMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-40)
    .map((entry: any) => ({
      role: String(entry?.role || "") as NormalizedAthenaHistoryMessage["role"],
      content: typeof entry?.content === "string" ? entry.content.trim().slice(0, 20_000) : "",
    }))
    .filter((entry) => ["user", "assistant", "system"].includes(entry.role) && entry.content);
}

function gatewayUrl(env: NodeJS.ProcessEnv): string {
  const explicit = String(env.STREAMWEAVER_ATHENA_URL || "").trim();
  if (explicit) return explicit;
  const base = String(env.STREAMWEAVER_BASE_URL || "https://streamweaver-new.fly.dev").replace(/\/$/, "");
  return `${base}/api/athena/respond`;
}

function serviceKey(env: NodeJS.ProcessEnv): string {
  return String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
}

function mapGatewayError(payload: any, fallback: string): string {
  return String(payload?.error || payload?.message || fallback).trim() || fallback;
}

export function buildAthenaGatewayPayload(identity: SpmtIdentity, body: AthenaProxyChatRequest) {
  const history = normalizeAthenaProxyHistory(body.messages);
  const latestUserIndex = history.map((entry) => entry.role).lastIndexOf("user");
  if (latestUserIndex < 0) throw new Error("At least one user chat message is required");
  const latest = history[latestUserIndex];
  const transientHistory = history
    .filter((_, index) => index !== latestUserIndex)
    .slice(-24);

  const username = firstIdentityString(identity, ["username", "displayName", "display_name", "handle"]) || "SPMT user";
  const displayName = firstIdentityString(identity, ["displayName", "display_name", "username"]) || username;
  const identityId = firstIdentityString(identity, ["twitchId", "twitch_id", "userId", "user_id", "id"]) || username;
  const admin = isSpmtAdmin(identity);
  const adultMode = body.adultMode === true;

  return {
    adultMode,
    admin,
    payload: {
      tenantId: identityId,
      message: latest.content,
      actor: {
        userId: identityId,
        username,
        displayName,
        isOwner: String(identity.role || "").toLowerCase() === "owner",
        isAdmin: admin,
      },
      location: {
        app: "fly-machine-rotator",
        surface: "rotator-workbench",
        live: false,
        layout: "athena-llm-workbench",
        replyMode: "structured",
        capabilities: [
          "athena.memory.public",
          "athena.memory.private",
          "spmt.read-tools",
          "rotator.read-tools",
          "image.generate.private",
        ],
      },
      visibility: "private",
      conversationId: String(body.conversationId || `rotator-workbench:${identityId}`).slice(0, 256),
      transientHistory,
      executeTools: true,
      confirmedActionId: body.confirmedActionId,
      additionalContext: adultMode
        ? "Adult mode is enabled by an authenticated SPMT owner/admin who confirmed they are an adult. Adult fictional content must involve consenting adults only."
        : undefined,
      metadata: {
        client: "rotator-athena-workbench",
        requestedProvider: body.provider || null,
        requestedModel: body.model || null,
        requestedTemperature: Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : null,
        canonicalProviderPolicy: "local-qwen-primary",
      },
    },
  };
}

export async function handleAthenaOsChatProxy(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method !== "POST" || url.pathname !== "/athena/api/chat") return false;

  const identity = await requireSpmtIdentity(request, env);
  if (!identity) return sendJson(response, 401, { error: "SPMT login required" });

  let body: AthenaProxyChatRequest;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid chat request" });
  }

  let built: ReturnType<typeof buildAthenaGatewayPayload>;
  try {
    built = buildAthenaGatewayPayload(identity, body);
  } catch (error) {
    return sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid chat request" });
  }
  if (built.adultMode && (!built.admin || body.adultConfirmed !== true)) {
    return sendJson(response, 403, { error: "Adult mode requires an SPMT owner/admin session and adult confirmation" });
  }

  const key = serviceKey(env);
  if (!key) return sendJson(response, 503, { error: "SPMT_API_KEY is required for the Athena gateway" });

  const upstream = await fetch(gatewayUrl(env), {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(built.payload),
    signal: AbortSignal.timeout(120_000),
  }).catch((error) => {
    console.error("Unified Athena gateway request failed", error);
    return null;
  });

  if (!upstream) return sendJson(response, 502, { error: "Unified Athena gateway is unavailable" });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) {
    return sendJson(response, upstream.status, { error: mapGatewayError(payload, `Athena gateway returned ${upstream.status}`) });
  }

  return sendJson(response, 200, {
    text: String(payload.response || ""),
    provider: String(payload.provider || "local-qwen"),
    model: String(payload.model || "spmt-qwen3-4b"),
    usage: null,
    adultMode: built.adultMode,
    visibility: payload.visibility,
    surface: payload.surface,
    conversationId: payload.conversationId,
    decision: payload.decision,
    images: payload.images,
    memorySources: payload.memorySources,
  });
}
