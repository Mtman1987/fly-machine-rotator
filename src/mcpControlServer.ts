import { createHash, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 64 * 1024;

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

function secretMatches(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export function isMcpAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): boolean {
  const expected = String(env.MCP_CONTROL_TOKEN || "").trim();
  const authorization = String(request.headers.authorization || "").trim();
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : "";
  const headerToken = String(request.headers["x-mcp-control-token"] || "").trim();
  return secretMatches(expected, bearer || headerToken);
}

export function isAllowedMcpOrigin(origin: string, env: NodeJS.ProcessEnv): boolean {
  if (!origin) return true;
  const configured = String(env.MCP_ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!configured.length) return false;
  return configured.includes(origin);
}

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
      ...(serialized ? { "content-type": "application/json", "content-length": Buffer.byteLength(serialized) } : {}),
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
    request.setTimeout(30_000, () => request.destroy(new Error("Internal Codex request timed out")));
    if (serialized) request.write(serialized);
    request.end();
  });
}

export function listMcpTools() {
  return [
    {
      name: "list_code_references",
      title: "List authorized code repositories",
      description: "List repositories that Athena Coder is authorized to inspect and modify in isolated workspaces.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "create_coding_job",
      title: "Create isolated Athena coding job",
      description: "Create an isolated coding job. This may edit only the job sandbox and run repository checks. It does not publish, merge, deploy, or access secrets.",
      inputSchema: {
        type: "object",
        properties: {
          appName: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 4000 },
          context: { type: "object", additionalProperties: true },
        },
        required: ["appName", "description"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: "get_coding_job",
      title: "Read Athena coding job",
      description: "Read the current status, summary, changed files, and validation checks for one Athena coding job.",
      inputSchema: {
        type: "object",
        properties: { jobId: { type: "string", pattern: "^[a-zA-Z0-9_-]{8,100}$" } },
        required: ["jobId"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
  ];
}

async function executeTool(name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv, dashboardPort: number) {
  if (name === "list_code_references") {
    return await callInternalCodex(env, dashboardPort, "GET", "/api/codex/references");
  }
  if (name === "create_coding_job") {
    const appName = String(args.appName || "").trim();
    const description = String(args.description || "").trim();
    if (!appName || !description) return { status: 400, payload: { error: "appName and description are required" } };
    return await callInternalCodex(env, dashboardPort, "POST", "/api/codex/jobs", {
      source: "chatgpt-mcp",
      reporter: "ChatGPT MCP",
      appName: appName.slice(0, 120),
      description: description.slice(0, 4000),
      context: args.context && typeof args.context === "object" ? args.context : {},
    });
  }
  if (name === "get_coding_job") {
    const jobId = String(args.jobId || "").trim();
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(jobId)) return { status: 400, payload: { error: "Invalid jobId" } };
    return await callInternalCodex(env, dashboardPort, "GET", `/api/codex/jobs/${encodeURIComponent(jobId)}`);
  }
  return { status: 404, payload: { error: `Unknown tool ${name}` } };
}

export async function handleMcpControlRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
  dashboardPort: number,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== MCP_PATH) return false;

  const origin = String(request.headers.origin || "").trim();
  if (!isAllowedMcpOrigin(origin, env)) {
    sendJson(response, 403, rpcError(null, -32003, "Origin is not allowed"));
    return true;
  }
  if (!isMcpAuthorized(request, env)) {
    response.setHeader("www-authenticate", 'Bearer realm="SPMT Rotator MCP"');
    sendJson(response, 401, rpcError(null, -32001, "Unauthorized"));
    return true;
  }
  if (request.method === "GET") {
    sendJson(response, 405, rpcError(null, -32600, "Use POST for MCP requests"));
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, rpcError(null, -32600, "Method not allowed"));
    return true;
  }

  let rpc: JsonRpcRequest;
  try { rpc = await readJson(request); }
  catch (error) {
    sendJson(response, 400, rpcError(null, -32700, error instanceof Error ? error.message : "Invalid request"));
    return true;
  }

  if (rpc.method === "initialize") {
    sendJson(response, 200, rpcResult(rpc.id, {
      protocolVersion: "2025-11-25",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "spmt-rotator-control", version: "0.1.0", description: "Owner-controlled Athena Coder bridge" },
    }));
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
      const result = await executeTool(name, args, env, dashboardPort);
      const isError = result.status < 200 || result.status >= 300;
      sendJson(response, 200, rpcResult(rpc.id, {
        content: [{ type: "text", text: JSON.stringify(result.payload, null, 2) }],
        structuredContent: result.payload,
        isError,
      }));
    } catch (error) {
      sendJson(response, 200, rpcResult(rpc.id, {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      }));
    }
    return true;
  }

  sendJson(response, 200, rpcError(rpc.id, -32601, `Method ${rpc.method} not found`));
  return true;
}
