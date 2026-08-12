import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import {
  getSpmtEmbeddingWorkerStatus,
  getSpmtLlmWorkerStatus,
  provisionSpmtEmbeddingWorker,
  provisionSpmtLlmWorker,
} from "./flyLlmProvisioner.js";
import { getFlyObservabilitySnapshot, getManagedFlyAppStates, sampleManagedFlyLogs } from "./flyObservability.js";
import { isSpmtAdmin, requireSpmtIdentity, type SpmtIdentity } from "./spmtAuth.js";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 64 * 1024;
const MCP_PROTOCOL_VERSION = "2025-03-26";

export type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function sendJson(response: ServerResponse, status: number, value: JsonRpcResponse | Record<string, unknown>) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function rpcResult(id: JsonRpcRequest["id"], result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest["id"], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

async function readJson(request: IncomingMessage): Promise<JsonRpcRequest> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new Error("Request body too large");
  }
  const parsed = JSON.parse(raw || "{}") as JsonRpcRequest;
  if (parsed.jsonrpc !== "2.0" || typeof parsed.method !== "string") throw new Error("Invalid JSON-RPC request");
  return parsed;
}

async function callInternalCodex(
  env: NodeJS.ProcessEnv,
  dashboardPort: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; payload: unknown }> {
  const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
  if (!workerSecret) throw new Error("CODEX_WORKER_SECRET is not configured");
  const serialized = body === undefined ? "" : JSON.stringify(body);
  return await new Promise((resolve, reject) => {
    const headers: IncomingHttpHeaders = {
      "x-codex-worker-secret": workerSecret,
      accept: "application/json",
      ...(serialized ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(serialized)) } : {}),
    };
    const request = httpRequest({ hostname: "127.0.0.1", port: dashboardPort, method, path, headers }, (response) => {
      let raw = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        let payload: unknown = raw;
        try { payload = JSON.parse(raw || "{}"); } catch { /* preserve text */ }
        resolve({ status: response.statusCode || 502, payload });
      });
    });
    request.on("error", reject);
    request.setTimeout(30_000, () => request.destroy(new Error("Internal coding request timed out")));
    if (serialized) request.write(serialized);
    request.end();
  });
}

const readOnlyAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function listMcpTools() {
  return [
    { name: "list_code_references", title: "List authorized code repositories", description: "List repositories the Rotator coder can inspect.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "list_coding_jobs", title: "List coding jobs", description: "List recent isolated coding jobs and their validation state.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "create_coding_job", title: "Create isolated coding job", description: "Create an isolated coding job. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", minLength: 1, maxLength: 120 }, description: { type: "string", minLength: 1, maxLength: 4000 }, context: { type: "object", additionalProperties: true } }, required: ["appName", "description"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
    { name: "get_coding_job", title: "Read coding job", description: "Read a coding job.", inputSchema: { type: "object", properties: { jobId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" } }, required: ["jobId"], additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "get_coding_job_artifact", title: "Read coding artifact", description: "Read the exact diff, raw validation checks, or model response for a coding job.", inputSchema: { type: "object", properties: { jobId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" }, artifact: { type: "string", enum: ["diff", "checks", "response"] } }, required: ["jobId", "artifact"], additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "publish_coding_job", title: "Publish validated repair", description: "Create a draft pull request for a completed coding job with changes and passing checks. Requires SPMT admin or owner; never merges or deploys.", inputSchema: { type: "object", properties: { jobId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" } }, required: ["jobId"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: "list_fly_app_states", title: "List managed Fly app states", description: "Read sanitized Machine state and health checks for every configured Fly app, or one allowlisted app. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", minLength: 1, maxLength: 120 } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "sample_fly_logs", title: "Sample managed Fly logs", description: "Sample the live Fly NATS log stream for all configured apps or one allowlisted app. Messages are redacted and bounded. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", minLength: 1, maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 500 }, durationMs: { type: "integer", minimum: 500, maximum: 10000 }, errorsOnly: { type: "boolean" } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "get_fly_observability_snapshot", title: "Get Fly state and log snapshot", description: "Return sanitized Machine states plus a short live log sample for all configured apps or one allowlisted app. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", minLength: 1, maxLength: 120 }, limit: { type: "integer", minimum: 1, maximum: 500 }, durationMs: { type: "integer", minimum: 500, maximum: 10000 }, errorsOnly: { type: "boolean" } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "get_spmt_llm_worker_status", title: "Read SPMT LLM worker status", description: "Read sanitized Fly status for the SPMT LLM worker.", inputSchema: { type: "object", properties: { appName: { type: "string", pattern: "^spmt-[a-z0-9-]{3,40}$" } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "get_spmt_embedding_worker_status", title: "Read SPMT embeddings worker status", description: "Read sanitized Fly status and the private base URL for the embeddings worker.", inputSchema: { type: "object", properties: { appName: { type: "string", pattern: "^spmt-[a-z0-9-]{3,40}$" } }, additionalProperties: false }, annotations: readOnlyAnnotations },
    { name: "provision_spmt_llm_worker", title: "Provision dedicated SPMT LLM worker", description: "Provision the allowlisted SPMT LLM worker. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", pattern: "^spmt-[a-z0-9-]{3,40}$" }, region: { type: "string", pattern: "^[a-z]{3}$" } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
    { name: "provision_spmt_embedding_worker", title: "Provision SPMT embeddings worker", description: "Provision the separate CPU embeddings worker. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { appName: { type: "string", pattern: "^spmt-[a-z0-9-]{3,40}$" }, region: { type: "string", pattern: "^[a-z]{3}$" }, modelRepo: { type: "string", minLength: 1, maxLength: 200 }, modelAlias: { type: "string", minLength: 1, maxLength: 120 }, volumeName: { type: "string", pattern: "^[a-zA-Z0-9_]{3,64}$" }, volumeGb: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } },
  ];
}

function toolRequiresAdmin(name: string): boolean {
  return new Set([
    "create_coding_job",
    "publish_coding_job",
    "list_fly_app_states",
    "sample_fly_logs",
    "get_fly_observability_snapshot",
    "provision_spmt_llm_worker",
    "provision_spmt_embedding_worker",
  ]).has(name);
}

function codingJobId(args: Record<string, unknown>): string | null {
  const jobId = String(args.jobId || "").trim();
  return /^[a-zA-Z0-9_-]{8,100}$/.test(jobId) ? jobId : null;
}

async function executeTool(name: string, args: Record<string, unknown>, identity: SpmtIdentity, env: NodeJS.ProcessEnv, dashboardPort: number) {
  if (toolRequiresAdmin(name) && !isSpmtAdmin(identity)) return { status: 403, payload: { error: "SPMT admin or owner required" } };
  if (name === "list_code_references") return await callInternalCodex(env, dashboardPort, "GET", "/api/codex/references");
  if (name === "list_coding_jobs") return await callInternalCodex(env, dashboardPort, "GET", "/api/codex/jobs");
  if (name === "create_coding_job") {
    const appName = String(args.appName || "").trim();
    const description = String(args.description || "").trim();
    if (!appName || !description) return { status: 400, payload: { error: "appName and description are required" } };
    return await callInternalCodex(env, dashboardPort, "POST", "/api/codex/jobs", { source: "chatgpt-mcp", reporter: String(identity.username || identity.id || "SPMT user"), appName: appName.slice(0, 120), description: description.slice(0, 4000), context: args.context && typeof args.context === "object" ? args.context : {} });
  }
  if (name === "get_coding_job") {
    const jobId = codingJobId(args);
    if (!jobId) return { status: 400, payload: { error: "Invalid jobId" } };
    return await callInternalCodex(env, dashboardPort, "GET", `/api/codex/jobs/${encodeURIComponent(jobId)}`);
  }
  if (name === "get_coding_job_artifact") {
    const jobId = codingJobId(args);
    const artifact = String(args.artifact || "").trim();
    if (!jobId) return { status: 400, payload: { error: "Invalid jobId" } };
    if (!new Set(["diff", "checks", "response"]).has(artifact)) return { status: 400, payload: { error: "artifact must be diff, checks, or response" } };
    return await callInternalCodex(env, dashboardPort, "GET", `/api/codex/jobs/${encodeURIComponent(jobId)}/${artifact}`);
  }
  if (name === "publish_coding_job") {
    const jobId = codingJobId(args);
    if (!jobId) return { status: 400, payload: { error: "Invalid jobId" } };
    return await callInternalCodex(env, dashboardPort, "POST", `/api/codex/jobs/${encodeURIComponent(jobId)}/publish`, {});
  }
  if (name === "list_fly_app_states") {
    const appName = String(args.appName || "").trim() || undefined;
    return { status: 200, payload: await getManagedFlyAppStates(env, appName) };
  }
  if (name === "sample_fly_logs") return { status: 200, payload: await sampleManagedFlyLogs(args, env) };
  if (name === "get_fly_observability_snapshot") return { status: 200, payload: await getFlyObservabilitySnapshot(args, env) };
  if (name === "get_spmt_llm_worker_status") return { status: 200, payload: await getSpmtLlmWorkerStatus(args, env) };
  if (name === "get_spmt_embedding_worker_status") return { status: 200, payload: await getSpmtEmbeddingWorkerStatus(args, env) };
  if (name === "provision_spmt_llm_worker") return { status: 200, payload: await provisionSpmtLlmWorker(args, env) };
  if (name === "provision_spmt_embedding_worker") return { status: 200, payload: await provisionSpmtEmbeddingWorker(args, env) };
  return { status: 404, payload: { error: `Unknown tool ${name}` } };
}

export async function handleMcpControlRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== MCP_PATH) return false;

  const identity = await requireSpmtIdentity(request, env);
  if (!identity) {
    response.setHeader("www-authenticate", 'Bearer realm="SPMT"');
    sendJson(response, 401, rpcError(null, -32001, "Valid SPMT token required"));
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, rpcError(null, -32600, "Use POST for MCP requests"));
    return true;
  }

  let rpc: JsonRpcRequest;
  try { rpc = await readJson(request); }
  catch (error) {
    sendJson(response, 400, rpcError(null, -32700, error instanceof Error ? error.message : "Invalid request"));
    return true;
  }

  if (rpc.method === "initialize") {
    sendJson(response, 200, rpcResult(rpc.id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "spmt-rotator-control", version: "0.6.0", description: "SPMT-authorized coding, Fly observability, chat-worker, and embeddings-worker control bridge" } }));
    return true;
  }
  if (rpc.method === "notifications/initialized") {
    response.writeHead(202, { "cache-control": "no-store" });
    response.end();
    return true;
  }
  if (rpc.method === "tools/list") {
    sendJson(response, 200, rpcResult(rpc.id, { tools: listMcpTools() }));
    return true;
  }
  if (rpc.method === "tools/call") {
    const params = rpc.params || {};
    const name = String(params.name || "");
    const args = params.arguments && typeof params.arguments === "object" ? params.arguments as Record<string, unknown> : {};
    try {
      const result = await executeTool(name, args, identity, env, dashboardPort);
      const isError = result.status < 200 || result.status >= 300 || Boolean((result.payload as { ok?: boolean } | undefined)?.ok === false);
      sendJson(response, 200, rpcResult(rpc.id, { content: [{ type: "text", text: JSON.stringify(result.payload, null, 2) }], structuredContent: result.payload, isError }));
    } catch (error) {
      sendJson(response, 200, rpcResult(rpc.id, { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true }));
    }
    return true;
  }

  sendJson(response, 200, rpcError(rpc.id, -32601, `Method ${rpc.method} not found`));
  return true;
}
