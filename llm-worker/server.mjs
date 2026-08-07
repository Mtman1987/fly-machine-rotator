import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 8080);
const upstreamBase = String(process.env.LLM_UPSTREAM_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const upstreamModel = String(process.env.LLM_DEFAULT_MODEL || "").trim();
const requestTimeoutMs = Number(process.env.LLM_REQUEST_TIMEOUT_MS || 120000);
const maxBodyBytes = Number(process.env.LLM_MAX_BODY_BYTES || 1048576);

function sameSecret(expected, supplied) {
  if (!expected || !supplied) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}

export function authorized(headers, env = process.env) {
  const expected = String(env.LLM_WORKER_TOKEN || "").trim();
  const bearer = String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  const serviceToken = String(headers["x-spmt-ai-token"] || "").trim();
  return sameSecret(expected, bearer || serviceToken);
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (Buffer.byteLength(raw) > maxBodyBytes) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { statusCode: 400 });
  }
}

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

async function proxyJson(path, payload, response) {
  const body = {
    ...payload,
    ...(upstreamModel && !payload.model ? { model: upstreamModel } : {}),
    stream: false,
  };
  const upstreamHeaders = { "content-type": "application/json" };
  const upstreamToken = String(process.env.LLM_UPSTREAM_API_KEY || "").trim();
  if (upstreamToken) upstreamHeaders.authorization = `Bearer ${upstreamToken}`;

  const upstream = await fetch(`${upstreamBase}${path}`, {
    method: "POST",
    headers: upstreamHeaders,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await upstream.text();
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-spmt-ai-upstream-status": String(upstream.status),
  });
  response.end(text);
}

export function createLlmWorkerServer(env = process.env) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return json(response, 200, {
          ok: true,
          service: "spmt-llm-worker",
          upstreamConfigured: Boolean(upstreamBase),
          defaultModelConfigured: Boolean(upstreamModel),
        });
      }
      if (!authorized(request.headers, env)) return json(response, 401, { error: "Unauthorized" });
      if (request.method === "GET" && url.pathname === "/v1/models") {
        const headers = {};
        const upstreamToken = String(env.LLM_UPSTREAM_API_KEY || "").trim();
        if (upstreamToken) headers.authorization = `Bearer ${upstreamToken}`;
        const upstream = await fetch(`${upstreamBase}/models`, { headers, signal: AbortSignal.timeout(15000) });
        const text = await upstream.text();
        response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json", "cache-control": "no-store" });
        return response.end(text);
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        return await proxyJson("/chat/completions", await readJson(request), response);
      }
      if (request.method === "POST" && url.pathname === "/v1/embeddings") {
        return await proxyJson("/embeddings", await readJson(request), response);
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      const status = Number(error?.statusCode || 502);
      console.error("llm worker request failed", error instanceof Error ? error.message : String(error));
      if (!response.headersSent) json(response, status, { error: status >= 500 ? "LLM upstream unavailable" : error.message });
      else response.end();
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  createLlmWorkerServer().listen(port, "0.0.0.0", () => {
    console.log(`SPMT LLM worker listening on ${port}`);
  });
}
