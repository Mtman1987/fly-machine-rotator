import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { handleAthenaChatRequest } from "./athenaChat.js";
import { handleAthenaRepairUiRequest } from "./athenaRepairUi.js";
import { handleAthenaSettingsRequest } from "./athenaSettings.js";
import { handleMcpControlRequest } from "./mcpControlServer.js";
import { handleLlmControlUiRequest } from "./llmControlUi.js";
import { handleRotatorHomeUiRequest } from "./rotatorHomeUi.js";
import { handleStreamWeaverAdminUiRequest } from "./streamweaverAdminUi.js";
import { handleRotatorSpmtAuthRequest, requireSpmtService } from "./spmtAuth.js";
import { auditOwnerMutation, authorizeOwnerMutation, isOwnerMutationPath } from "./dashboardSecurity.js";

const DSH_PREFIX = "/api/dsh/mtfixit";

export async function isDshMtFixItAuthorized(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<boolean> {
  return Boolean(await requireSpmtService(request, env, { clientId: 'discord-stream-hub', scope: 'athena:write' }));
}

export function mapDshMtFixItWorkerPath(method: string, pathname: string, search = ""): string | null {
  if (method === "POST" && pathname === `${DSH_PREFIX}/jobs`) return `/api/codex/jobs${search}`;
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

async function proxyToCodexWorker(incoming: IncomingMessage, outgoing: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number, workerPath: string) {
  const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
  if (!workerSecret) { sendJson(outgoing, 503, { error: "CODEX_WORKER_SECRET is not configured" }); return; }
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${dashboardPort}`, "x-codex-worker-secret": workerSecret };
  delete headers["x-dsh-mtfixit-key"]; delete headers.authorization; delete headers.connection;
  await proxyRequest(incoming, outgoing, dashboardPort, workerPath, headers);
}

async function proxyToAthenaGateway(incoming: IncomingMessage, outgoing: ServerResponse, athenaPort: number) {
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${athenaPort}` };
  delete headers.connection;
  await proxyRequest(incoming, outgoing, athenaPort, incoming.url || "/", headers);
}

export async function handleDshMtFixItGatewayRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (!url.pathname.startsWith(`${DSH_PREFIX}/`)) return false;
  const workerPath = mapDshMtFixItWorkerPath(request.method || "GET", url.pathname, url.search);
  if (!workerPath) { sendJson(response, 404, { error: "Unknown DSH mtfixit operation" }); return true; }
  if (!(await isDshMtFixItAuthorized(request, env))) { sendJson(response, 401, { error: "SPMT service authorization required" }); return true; }
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
