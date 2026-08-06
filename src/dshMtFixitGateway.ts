import { createHash, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";

const DSH_PREFIX = "/api/dsh/mtfixit";

function secretMatches(expected: string, supplied: string): boolean {
  if (!expected || !supplied) return false;
  const expectedHash = createHash("sha256").update(expected).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedHash, suppliedHash);
}

export function isDshMtFixItAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): boolean {
  const expected = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
  const supplied = String(request.headers["x-dsh-mtfixit-key"] || "").trim();
  return secretMatches(expected, supplied);
}

export function mapDshMtFixItWorkerPath(method: string, pathname: string, search = ""): string | null {
  if (method === "POST" && pathname === `${DSH_PREFIX}/jobs`) {
    return `/api/codex/jobs${search}`;
  }
  if (method === "GET" && /^\/api\/dsh\/mtfixit\/jobs\/[a-zA-Z0-9_-]{8,100}$/.test(pathname)) {
    return `${pathname.replace(DSH_PREFIX, "/api/codex")}${search}`;
  }
  return null;
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function proxyToCodexWorker(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
  workerPath: string,
) {
  const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
  if (!workerSecret) {
    sendJson(outgoing, 503, { error: "CODEX_WORKER_SECRET is not configured" });
    return;
  }

  const headers: IncomingHttpHeaders = {
    ...incoming.headers,
    host: `127.0.0.1:${internalPort}`,
    "x-codex-worker-secret": workerSecret,
  };
  delete headers["x-dsh-mtfixit-key"];
  delete headers.connection;

  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({
      hostname: "127.0.0.1",
      port: internalPort,
      method: incoming.method,
      path: workerPath,
      headers,
    }, (upstream) => {
      outgoing.writeHead(upstream.statusCode || 502, upstream.headers);
      upstream.pipe(outgoing);
      upstream.on("end", resolve);
    });
    proxied.on("error", reject);
    incoming.pipe(proxied);
  });
}

export async function handleDshMtFixItGatewayRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (!url.pathname.startsWith(`${DSH_PREFIX}/`)) return false;

  const workerPath = mapDshMtFixItWorkerPath(request.method || "GET", url.pathname, url.search);
  if (!workerPath) {
    sendJson(response, 404, { error: "Unknown DSH mtfixit operation" });
    return true;
  }
  if (!isDshMtFixItAuthorized(request, env)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return true;
  }

  await proxyToCodexWorker(request, response, env, internalPort, workerPath);
  return true;
}
