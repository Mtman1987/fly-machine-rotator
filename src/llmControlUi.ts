import type { IncomingMessage, ServerResponse } from "node:http";
import { getSpmtLlmWorkerStatus, provisionSpmtLlmWorker } from "./flyLlmProvisioner.js";
import { readLlmControlState, writeLlmControlState } from "./llmControlState.js";
import { requireSpmtAdmin } from "./spmtAuth.js";

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32 * 1024) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

export async function handleLlmControlUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/llm-control" && !url.pathname.startsWith("/api/llm-control/")) return false;

  const admin = await requireSpmtAdmin(request, env).catch(() => null);
  if (!admin) {
    json(response, 401, {
      error: "SPMT administrator authorization required",
      auth: "Pass the current SPMT OAuth access token as a Bearer token or the HttpOnly spmt_access_token cookie.",
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/llm-control") {
    response.writeHead(308, { location: "/athena/llm#worker", "cache-control": "no-store" });
    response.end();
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/llm-control/state") {
    const [control, worker] = await Promise.all([
      readLlmControlState(env),
      getSpmtLlmWorkerStatus({ appName: "spmt-llm-worker" }, env)
        .catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
    ]);
    json(response, 200, { control, worker, admin: { id: admin.id, username: admin.username } });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/llm-control/toggle") {
    const body = await readBody(request);
    const state = await writeLlmControlState(env, body.enabled === true);
    json(response, 200, { ok: true, state });
    return true;
  }
  if (request.method === "POST" && url.pathname === "/api/llm-control/provision") {
    const result = await provisionSpmtLlmWorker({ appName: "spmt-llm-worker", region: "ord" }, env);
    json(response, result.ok ? 200 : 502, result);
    return true;
  }

  json(response, 404, { error: "Not found" });
  return true;
}
