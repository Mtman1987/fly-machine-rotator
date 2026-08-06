import type { IncomingMessage, ServerResponse } from "node:http";
import { requireSpmtAdmin } from "./spmtAuth.js";

const PAGE_PATH = "/athena/repair";
const API_PREFIX = "/athena/api/repair";

type RepairRunRequest = {
  generateFixes?: boolean;
  publishSummary?: boolean;
};

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, html: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
  });
  response.end(html);
}

async function readJson(request: IncomingMessage): Promise<RepairRunRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RepairRunRequest;
}

async function runDashboardAction(
  dashboardPort: number,
  env: NodeJS.ProcessEnv,
  pathname: string,
): Promise<Record<string, unknown>> {
  const token = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN || "").trim();
  if (!token) throw new Error("ROTATOR_DASHBOARD_ACTION_TOKEN is not configured.");
  const response = await fetch(`http://127.0.0.1:${dashboardPort}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-rotator-action-token": token,
    },
    body: "{}",
    signal: AbortSignal.timeout(20 * 60_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `${pathname} failed with ${response.status}`);
  return text ? JSON.parse(text) as Record<string, unknown> : { ok: true };
}

function dashboardUrl(env: NodeJS.ProcessEnv): string {
  return String(env.PUBLIC_DASHBOARD_URL || `https://${env.FLY_APP_NAME || "mtman-machine-rotator"}.fly.dev/`).replace(/\/$/, "");
}

async function publishAdminSummary(env: NodeJS.ProcessEnv, summary: string) {
  const webhook = String(env.DISCORD_ADMIN_DM_WEBHOOK_URL || env.DISCORD_DM_WEBHOOK_URL || "").trim();
  if (!webhook) return { posted: false, reason: "No admin DM webhook configured." };
  const url = dashboardUrl(env);
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Athena Repair Station",
      content: summary,
      embeds: [{
        title: "Review Athena repair run",
        url,
        description: "Open the Rotator dashboard to edit proposals, approve and apply changes, run checks, push branches, and verify the repair before clearing the rolling logs.",
        color: 0x8b5cf6,
        fields: [
          { name: "Approval required", value: "Athena never applies a proposed file change from this run without an explicit approval action.", inline: false },
          { name: "Working-fix memory", value: "Approved fix records and their attempt history remain in the Rotator fix store for reuse on matching incidents.", inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Admin DM webhook failed with ${response.status}: ${await response.text()}`);
  return { posted: true };
}

export async function handleAthenaRepairUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
  dashboardPort: number,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== PAGE_PATH && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;

  const identity = await requireSpmtAdmin(request, env);
  if (!identity) {
    sendJson(response, 403, { ok: false, error: "SPMT admin or owner access is required." });
    return true;
  }

  if ((request.method || "GET") === "GET" && url.pathname === PAGE_PATH) {
    sendHtml(response, renderPage(dashboardUrl(env)));
    return true;
  }

  if ((request.method || "GET") === "POST" && url.pathname === `${API_PREFIX}/run`) {
    const options = await readJson(request);
    const startedAt = new Date().toISOString();
    const rotation = await runDashboardAction(dashboardPort, env, "/actions/rotate");
    const review = options.generateFixes === false
      ? { ok: true, message: "Proposal generation skipped." }
      : await runDashboardAction(dashboardPort, env, "/actions/fixes/review-cycle");
    const summary = `Athena manual repair run completed. Rotation: ${String(rotation.results ?? "complete")}. ${String(review.message ?? "Repair proposals refreshed.")}`;
    const delivery = options.publishSummary === false
      ? { posted: false, reason: "Summary publishing disabled for this run." }
      : await publishAdminSummary(env, summary);
    sendJson(response, 200, {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary,
      rotation,
      review,
      delivery,
      dashboardUrl: dashboardUrl(env),
      approvalRequired: true,
    });
    return true;
  }

  if ((request.method || "GET") === "POST" && url.pathname === `${API_PREFIX}/finalize`) {
    const result = await runDashboardAction(dashboardPort, env, "/actions/errors/clear");
    const summary = `Athena repair run finalized. ${String(result.message ?? "The rolling 24-hour error state was archived and cleared.")}`;
    const delivery = await publishAdminSummary(env, summary);
    sendJson(response, 200, {
      ok: true,
      summary,
      result,
      delivery,
      dashboardUrl: dashboardUrl(env),
    });
    return true;
  }

  sendJson(response, 404, { ok: false, error: "Unknown Athena repair operation." });
  return true;
}

function renderPage(rotatorDashboardUrl: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Athena Manual Repair Run</title>
<style>
:root{color-scheme:dark;--bg:#070812;--panel:#121528;--ink:#f8fafc;--muted:#a8b0c3;--accent:#8b5cf6;--cyan:#22d3ee;--border:rgba(255,255,255,.13);--danger:#fb7185;--good:#34d399}*{box-sizing:border-box}body{margin:0;font-family:Inter,Arial,sans-serif;background:radial-gradient(circle at 10% 0,rgba(34,211,238,.14),transparent 30%),radial-gradient(circle at 90% 0,rgba(139,92,246,.2),transparent 28%),var(--bg);color:var(--ink);min-height:100vh}.shell{max-width:1100px;margin:auto;padding:36px 20px 80px}.panel{background:rgba(18,21,40,.86);border:1px solid var(--border);border-radius:24px;padding:26px;box-shadow:0 24px 70px rgba(0,0,0,.35);margin-bottom:20px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:11px;color:var(--muted)}h1{font-size:clamp(2.4rem,6vw,4.7rem);line-height:.96;margin:12px 0 16px}p{line-height:1.65;color:var(--muted}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.card{border:1px solid var(--border);border-radius:18px;padding:18px;background:rgba(255,255,255,.04)}button,a.button{border:0;border-radius:14px;padding:13px 17px;font-weight:800;cursor:pointer;text-decoration:none;display:inline-block;background:linear-gradient(135deg,var(--accent),var(--cyan));color:white}button.secondary,a.secondary{background:rgba(255,255,255,.07);border:1px solid var(--border)}button.danger{background:rgba(251,113,133,.14);border:1px solid rgba(251,113,133,.4);color:#fecdd3}.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}.toggle{display:flex;gap:10px;align-items:center;margin:10px 0;color:var(--ink)}#status{white-space:pre-wrap;background:#080a14;border:1px solid var(--border);border-radius:16px;padding:16px;min-height:120px;color:#dbeafe}.good{color:var(--good)}@media(max-width:760px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body><main class="shell">
<section class="panel"><div class="eyebrow">SPMT admin operations</div><h1>Athena Manual Repair Run</h1><p>Trigger one controlled rotation. Athena reads the current rolling error set, refreshes repair proposals, and publishes a summary. Every proposed file change remains approval-gated in the Rotator dashboard, regardless of how many attempts are needed.</p><div class="actions"><button id="run">Run Athena rotation</button><a class="button secondary" href="${rotatorDashboardUrl}">Open approval dashboard</a></div></section>
<section class="grid">
<div class="card"><div class="eyebrow">1 · Inspect</div><h2>Rotate and read errors</h2><p>Runs the tracked rotation and refreshes the unified app and Discord report.</p></div>
<div class="card"><div class="eyebrow">2 · Repair</div><h2>Generate and test</h2><p>Creates or refreshes reusable fix records. Use Edit, Approve and apply, Run checks, Push branch, and Verify quiet on the dashboard.</p></div>
<div class="card"><div class="eyebrow">3 · Finalize</div><h2>Archive and clear</h2><p>After approved fixes are verified, archive the prior baseline and clear the rolling 24-hour errors and proposal queue.</p></div>
</section>
<section class="panel"><label class="toggle"><input id="generate" type="checkbox" checked /> Generate or refresh repair proposals</label><label class="toggle"><input id="publish" type="checkbox" checked /> Post the run summary to the configured admin DM webhook</label><div class="actions"><button id="finalize" class="danger">Finalize verified fixes and clear 24-hour logs</button></div><p>This final action is intentionally separate. Do not use it until the approval dashboard shows the fixes as verified or handled.</p></section>
<section class="panel"><div class="eyebrow">Run result</div><div id="status">Ready.</div></section>
</main>
<script>
const statusBox=document.getElementById('status');
async function call(path,body){statusBox.textContent='Working…';const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})});const text=await response.text();let payload;try{payload=JSON.parse(text)}catch{payload={error:text}}if(!response.ok)throw new Error(payload.error||payload.message||text||('Request failed '+response.status));statusBox.textContent=JSON.stringify(payload,null,2);return payload}
document.getElementById('run').onclick=()=>call('/athena/api/repair/run',{generateFixes:document.getElementById('generate').checked,publishSummary:document.getElementById('publish').checked}).catch(error=>statusBox.textContent=error.message);
document.getElementById('finalize').onclick=()=>{if(!confirm('Archive and clear the rolling 24-hour error and proposal state now? Only continue after approved fixes are verified.'))return;call('/athena/api/repair/finalize',{}).catch(error=>statusBox.textContent=error.message)};
</script></body></html>`;
}
