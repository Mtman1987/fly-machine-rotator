import type { IncomingMessage, ServerResponse } from "node:http";
import { approveChatGptHandoff, denyChatGptHandoff } from "./chatgptHandoff.js";

const ROUTE = /^\/api\/dsh\/mtfixit\/chatgpt-handoffs\/([A-Za-z0-9_-]{8,120})\/decision$/;
const MAX_BODY = 8 * 1024;

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<{ action?: unknown; decisionBy?: unknown }> {
  let raw = "";
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY) throw new Error("Decision body too large");
  }
  return raw.trim() ? JSON.parse(raw) : {};
}

export async function handleChatGptHandoffDecisionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const match = url.pathname.match(ROUTE);
  if (!match) return false;
  if (String(request.method || "GET").toUpperCase() !== "POST") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  try {
    const body = await readBody(request);
    const action = String(body.action || "").trim().toLowerCase();
    const decisionBy = String(body.decisionBy || "mtman-discord").trim().slice(0, 120) || "mtman-discord";
    const handoff = action === "approve"
      ? await approveChatGptHandoff(env, match[1], decisionBy)
      : action === "deny"
        ? await denyChatGptHandoff(env, match[1], decisionBy)
        : null;
    if (!handoff) {
      sendJson(response, 400, { error: "Invalid action" });
      return true;
    }
    sendJson(response, 200, {
      ok: true,
      handoff: {
        id: handoff.id,
        jobId: handoff.jobId,
        status: handoff.status,
        approvedAt: handoff.approvedAt || null,
        deniedAt: handoff.deniedAt || null,
        decisionBy: handoff.decisionBy || null,
      },
    });
  } catch (error) {
    sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
  }
  return true;
}
