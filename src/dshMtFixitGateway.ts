import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { handleAthenaChatRequest } from "./athenaChat.js";
import { handleAthenaRepairUiRequest } from "./athenaRepairUi.js";
import { handleAthenaSettingsRequest } from "./athenaSettings.js";
import { handleMcpControlRequest } from "./mcpControlServer.js";
import { handleLlmControlUiRequest } from "./llmControlUi.js";
import { handleRotatorHomeUiRequest } from "./rotatorHomeUi.js";
import { handleStreamWeaverAdminUiRequest } from "./streamweaverAdminUi.js";
import { handleRotatorSpmtAuthRequest } from "./spmtAuth.js";
import { auditOwnerMutation, authorizeOwnerMutation, isOwnerMutationPath } from "./dashboardSecurity.js";
import { handleEcosystemSnapshotRequest } from "./ecosystemSnapshot.js";

const DSH_PREFIX = "/api/dsh/mtfixit";
const MAX_DSH_JOB_BODY_BYTES = 256 * 1024;
const MAX_WORKER_JOB_BODY_BYTES = 56 * 1024;
const MAX_EMBEDDED_SNAPSHOT_CHARS = 20_000;
const MAX_EMBEDDED_COMMLINK_CHARS = 28_000;

type JsonRecord = Record<string, any>;

function secretMatches(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

function nonEmptySecrets(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

export function isDshMtFixItAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): boolean {
  const expectedSecrets = nonEmptySecrets([
    env.SPMT_API_KEY,
    env.SPMT_PLATFORM_API_KEY,
    env.DSH_MTFIXIT_KEY,
    env.CLOUDFLARE_WORKER_BRIDGE_SECRET,
    env.INTERNAL_BRIDGE_KEY,
  ]);
  const suppliedSecrets = nonEmptySecrets([
    String(request.headers["x-dsh-mtfixit-key"] || ""),
    String(request.headers["x-cloudflare-bridge-secret"] || ""),
  ]);
  return expectedSecrets.some((expected) => suppliedSecrets.some((supplied) => secretMatches(expected, supplied)));
}

export function mapDshMtFixItWorkerPath(method: string, pathname: string, search = ""): string | null {
  if (method === "POST" && (pathname === DSH_PREFIX || pathname === `${DSH_PREFIX}/jobs`)) return `/api/codex/jobs${search}`;
  if (method === "GET" && /^\/api\/dsh\/mtfixit\/jobs\/[a-zA-Z0-9_-]{8,100}$/.test(pathname)) return `${pathname.replace(DSH_PREFIX, "/api/codex")}${search}`;
  return null;
}

function sendJson(response: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(value));
}

function objectValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function compactStates(value: unknown): string {
  const states = objectValue(value);
  return Object.entries(states)
    .slice(0, 8)
    .map(([key, count]) => `${key}:${String(count)}`)
    .join(",") || "none";
}

function ecosystemLines(snapshotJson: unknown): string[] {
  if (typeof snapshotJson !== "string" || !snapshotJson.trim()) return [];
  try {
    const snapshot = JSON.parse(snapshotJson);
    const apps = objectValue(snapshot?.apps);
    const lines: string[] = [];
    for (const [appId, appValue] of Object.entries(apps)) {
      const app = objectValue(appValue);
      const services = objectValue(app.services);
      for (const [serviceId, serviceValue] of Object.entries(services)) {
        const service = objectValue(serviceValue);
        const runtime = objectValue(service.runtime);
        lines.push(
          `${String(app.name || appId)}/${String(service.flyApp || serviceId)}: status=${String(runtime.status || "unknown")}; machines=${String(runtime.machineCount ?? "?")}; failingChecks=${String(runtime.failingCheckCount ?? "?")}; states=${compactStates(runtime.states)}`,
        );
      }
    }
    return lines.slice(0, 12);
  } catch {
    return [];
  }
}

function commlinkLines(snapshotJson: unknown): string[] {
  if (typeof snapshotJson !== "string" || !snapshotJson.trim()) return [];
  try {
    const snapshot = JSON.parse(snapshotJson);
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    return items.slice(-18).map((itemValue: unknown) => {
      const item = objectValue(itemValue);
      const actor = objectValue(item.actor);
      const timestamp = String(item.timestamp || "time-unknown").replace("T", " ").replace(/\.\d{3}Z$/, "Z");
      const source = String(item.sourceApp || item.kind || "unknown").slice(0, 60);
      const eventType = String(item.eventType || item.kind || "event").slice(0, 70);
      const channel = String(item.channel || "unknown").slice(0, 80);
      const who = String(actor.displayName || actor.username || actor.id || "system").slice(0, 80);
      const text = String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 240);
      return `${timestamp} | ${source}/${eventType} | ${channel} | ${who}: ${text || "(no text)"}`;
    });
  } catch {
    return [];
  }
}

export function prepareDshMtFixItJobPayload(value: unknown): JsonRecord {
  const source = objectValue(value);
  const payload: JsonRecord = { ...source };
  const context = { ...objectValue(source.context) };
  const evidence = { ...objectValue(context.diagnosticEvidence) };
  const ecosystemSnapshot = { ...objectValue(evidence.ecosystemSnapshot) };
  const commlinkSnapshot = { ...objectValue(evidence.commlinkSnapshot) };
  const adapters = objectValue(evidence.adapters);
  const originalDescription = String(source.description || "").trim().slice(0, 2600);

  const recentCommlink = commlinkLines(commlinkSnapshot.snapshotJson);
  const diagnosticLines = ecosystemLines(ecosystemSnapshot.snapshotJson);
  const adapterLines = Object.entries(adapters).slice(0, 10).map(([name, adapterValue]) => {
    const adapter = objectValue(adapterValue);
    return `${name}: ${String(adapter.status || "unknown")}${adapter.note ? ` - ${String(adapter.note).slice(0, 180)}` : ""}`;
  });
  const brief = [
    originalDescription,
    "",
    "Athena diagnostic evidence (ecosystem-wide):",
    `tenantHint=${String(source.tenantId || evidence?.scope?.tenantId || "none; not required for evidence capture")}`,
    `source=${String(source.source || context.source || "unknown")}`,
    `commlinkScope=${String(commlinkSnapshot.scope || "unknown")}; commlinkStatus=${String(commlinkSnapshot.status || "unknown")}; commlinkItems=${String(commlinkSnapshot.itemCount ?? "?")}`,
    ...(recentCommlink.length ? ["Recent Commlink evidence:", ...recentCommlink] : []),
    ...(diagnosticLines.length ? ["Service health:", ...diagnosticLines] : []),
    ...(adapterLines.length ? ["Evidence adapters:", ...adapterLines] : []),
  ].filter(Boolean).join("\n").slice(0, 3_950);
  payload.description = brief || originalDescription;

  if (typeof ecosystemSnapshot.snapshotJson === "string" && ecosystemSnapshot.snapshotJson.length > MAX_EMBEDDED_SNAPSHOT_CHARS) {
    ecosystemSnapshot.snapshotJson = ecosystemSnapshot.snapshotJson.slice(0, MAX_EMBEDDED_SNAPSHOT_CHARS);
    ecosystemSnapshot.truncated = true;
  }
  if (typeof commlinkSnapshot.snapshotJson === "string" && commlinkSnapshot.snapshotJson.length > MAX_EMBEDDED_COMMLINK_CHARS) {
    commlinkSnapshot.snapshotJson = commlinkSnapshot.snapshotJson.slice(0, MAX_EMBEDDED_COMMLINK_CHARS);
    commlinkSnapshot.truncated = true;
  }
  if (Object.keys(ecosystemSnapshot).length) evidence.ecosystemSnapshot = ecosystemSnapshot;
  if (Object.keys(commlinkSnapshot).length) evidence.commlinkSnapshot = commlinkSnapshot;
  if (Object.keys(evidence).length) context.diagnosticEvidence = evidence;
  payload.context = context;

  let serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKER_JOB_BODY_BYTES && typeof ecosystemSnapshot.snapshotJson === "string") {
    ecosystemSnapshot.snapshotJson = "[Snapshot body trimmed by mtfixit gateway; service-state summary is embedded in description.]";
    ecosystemSnapshot.truncated = true;
    evidence.ecosystemSnapshot = ecosystemSnapshot;
    context.diagnosticEvidence = evidence;
    payload.context = context;
    serialized = JSON.stringify(payload);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKER_JOB_BODY_BYTES && typeof commlinkSnapshot.snapshotJson === "string") {
    commlinkSnapshot.snapshotJson = "[Commlink body trimmed by mtfixit gateway; recent ecosystem evidence is embedded in description.]";
    commlinkSnapshot.truncated = true;
    evidence.commlinkSnapshot = commlinkSnapshot;
    context.diagnosticEvidence = evidence;
    payload.context = context;
    serialized = JSON.stringify(payload);
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_WORKER_JOB_BODY_BYTES) {
    payload.context = {
      source: context.source || null,
      channelId: context.channelId || null,
      channelName: context.channelName || null,
      guildId: context.guildId || null,
      messageId: context.messageId || null,
      diagnosticEvidence: {
        schemaVersion: evidence.schemaVersion || null,
        capturedAt: evidence.capturedAt || null,
        scope: evidence.scope || null,
        incidentWindow: evidence.incidentWindow || null,
        ecosystemSnapshot: {
          status: ecosystemSnapshot.status || "trimmed",
          endpoint: ecosystemSnapshot.endpoint || null,
          truncated: true,
        },
        commlinkSnapshot: {
          status: commlinkSnapshot.status || "trimmed",
          endpoint: commlinkSnapshot.endpoint || null,
          scope: commlinkSnapshot.scope || "ecosystem-global",
          itemCount: commlinkSnapshot.itemCount ?? null,
          truncated: true,
        },
        adapters,
      },
    };
  }
  return payload;
}

async function readJsonBody(incoming: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of incoming) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_DSH_JOB_BODY_BYTES) throw new Error("DSH mtfixit request body too large");
  }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function proxyRequest(incoming: IncomingMessage, outgoing: ServerResponse, port: number, path: string, headers: IncomingHttpHeaders) {
  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({ hostname: "127.0.0.1", port, method: incoming.method, path, headers }, (upstream) => {
      outgoing.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(outgoing);
      upstream.on("end", resolve);
    });
    proxied.on("error", reject);
    incoming.pipe(proxied);
  });
}

async function proxyJsonRequest(outgoing: ServerResponse, port: number, path: string, headers: IncomingHttpHeaders, value: unknown) {
  const body = JSON.stringify(value);
  const forwardedHeaders: IncomingHttpHeaders = {
    ...headers,
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(body, "utf8")),
  };
  delete forwardedHeaders["transfer-encoding"];
  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({ hostname: "127.0.0.1", port, method: "POST", path, headers: forwardedHeaders }, (upstream) => {
      outgoing.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(outgoing);
      upstream.on("end", resolve);
    });
    proxied.on("error", reject);
    proxied.end(body);
  });
}

async function proxyToCodexWorker(incoming: IncomingMessage, outgoing: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number, workerPath: string) {
  const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
  if (!workerSecret) { sendJson(outgoing, 503, { error: "CODEX_WORKER_SECRET is not configured" }); return; }
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${dashboardPort}`, "x-codex-worker-secret": workerSecret };
  delete headers["x-dsh-mtfixit-key"];
  delete headers["x-cloudflare-bridge-secret"];
  delete headers.connection;

  if (String(incoming.method || "GET").toUpperCase() === "POST" && workerPath.split("?")[0] === "/api/codex/jobs") {
    try {
      const parsed = await readJsonBody(incoming);
      const prepared = prepareDshMtFixItJobPayload(parsed);
      await proxyJsonRequest(outgoing, dashboardPort, workerPath, headers, prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid DSH mtfixit request";
      sendJson(outgoing, message.includes("too large") ? 413 : 400, { error: message });
    }
    return;
  }
  await proxyRequest(incoming, outgoing, dashboardPort, workerPath, headers);
}

async function proxyToAthenaGateway(incoming: IncomingMessage, outgoing: ServerResponse, athenaPort: number) {
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${athenaPort}` };
  delete headers.connection;
  await proxyRequest(incoming, outgoing, athenaPort, incoming.url || "/", headers);
}

export async function handleDshMtFixItGatewayRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== DSH_PREFIX && !url.pathname.startsWith(`${DSH_PREFIX}/`)) return false;
  const workerPath = mapDshMtFixItWorkerPath(request.method || "GET", url.pathname, url.search);
  if (!workerPath) { sendJson(response, 404, { error: "Unknown DSH mtfixit operation" }); return true; }
  if (!isDshMtFixItAuthorized(request, env)) { sendJson(response, 401, { error: "Unauthorized" }); return true; }
  await proxyToCodexWorker(request, response, env, dashboardPort, workerPath);
  return true;
}

async function guardOwnerMutation(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const method = String(request.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (!isOwnerMutationPath(url.pathname)) return false;

  const authorization = await authorizeOwnerMutation(request, env);
  if (!authorization.ok) {
    await auditOwnerMutation(request, env, url.pathname, "denied", authorization.status).catch(() => undefined);
    sendJson(
      response,
      authorization.status,
      { error: authorization.error },
      authorization.retryAfter ? { "retry-after": String(authorization.retryAfter) } : {},
    );
    return true;
  }

  response.once("finish", () => {
    const outcome = response.statusCode >= 400 ? "failed" : "completed";
    void auditOwnerMutation(request, env, url.pathname, outcome, response.statusCode).catch(() => undefined);
  });
  return false;
}

export function startDshMtFixItOuterGateway(env: NodeJS.ProcessEnv, dashboardPort: number, athenaPort: number, publicPort: number) {
  const server = createServer(async (request, response) => {
    try {
      if (await handleEcosystemSnapshotRequest(request, response, env)) return;
      if (await handleRotatorSpmtAuthRequest(request, response, env)) return;
      if (await guardOwnerMutation(request, response, env)) return;
      if (await handleRotatorHomeUiRequest(request, response, env)) return;
      if (await handleAthenaSettingsRequest(request, response, env)) return;
      if (await handleAthenaChatRequest(request, response, env)) return;
      if (await handleAthenaRepairUiRequest(request, response, env, dashboardPort)) return;
      if (await handleStreamWeaverAdminUiRequest(request, response, env)) return;
      if (await handleLlmControlUiRequest(request, response, env)) return;
      if (await handleMcpControlRequest(request, response, env, dashboardPort)) return;
      if (await handleDshMtFixItGatewayRequest(request, response, env, dashboardPort)) return;
      await proxyToAthenaGateway(request, response, athenaPort);
    } catch (error) {
      console.error("DSH mtfixit outer gateway failed", error);
      if (!response.headersSent) sendJson(response, 502, { error: error instanceof Error ? error.message : "Rotator gateway unavailable" }); else response.end();
    }
  });
  server.listen(publicPort, "0.0.0.0", () => console.log(`Fly Rotator Athena operations gateway listening on ${publicPort}; Athena gateway is internal on ${athenaPort}`));
  return server;
}
