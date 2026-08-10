import type { IncomingMessage, ServerResponse } from "node:http";
import { requireSpmtAdmin } from "./spmtAuth.js";
import { spmtSharedUiHead, spmtSharedUiScript } from "./spmtSharedUi.js";

export async function handleRotatorHomeUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method !== "GET" || url.pathname !== "/") return false;

  const admin = await requireSpmtAdmin(request, env).catch(() => null);
  if (!admin) {
    response.writeHead(302, {
      location: "/auth/spmt/login?next=%2F",
      "cache-control": "no-store",
    });
    response.end();
    return true;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://spmt.live; frame-ancestors 'none'",
  });
  response.end(renderHome(String(admin.username || admin.id || "SPMT admin")));
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] || character);
}

function renderHome(adminName: string): string {
  const cards = [
    ["LLM Workbench", "/athena/llm", "Chat with Athena, switch providers, inspect the local worker, and control provisioning from one surface.", "Primary"],
    ["Athena Coder", "/athena", "Create isolated coding jobs, inspect diffs and checks, and publish approved draft pull requests.", "Engineering"],
    ["Repair Run", "/athena/repair", "Run the controlled Athena repair cycle, refresh proposals, and finalize verified work.", "Recovery"],
    ["Rotator Fleet", "/rotator", "Open the original machine rotation, incident, proposal, and approval dashboard.", "Infrastructure"],
    ["StreamWeaver Ops", "/athena/streamweaver", "Manage protected bot identity, generation, moderation, research, and avatar configuration.", "Bot platform"],
    ["MountainView", "/mountainview", "Open MountainView's separate mobile, glasses, and operator surface.", "Separate app"],
  ];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SpaceMountain Rotator Control</title>
<style>
:root{color-scheme:dark;--bg:#050714;--panel:rgba(17,24,48,.82);--line:rgba(255,255,255,.13);--ink:#f8fafc;--muted:#aab5cc;--violet:#8b5cf6;--cyan:#22d3ee;--orange:#fb923c}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 0,rgba(34,211,238,.16),transparent 30%),radial-gradient(circle at 92% 0,rgba(139,92,246,.22),transparent 32%),var(--bg);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif}.shell{max-width:1320px;margin:auto;padding:34px 20px 80px}.hero,.card,.status{background:var(--panel);border:1px solid var(--line);backdrop-filter:blur(18px);box-shadow:0 26px 80px rgba(0,0,0,.34)}.hero{border-radius:30px;padding:30px}.eyebrow{text-transform:uppercase;letter-spacing:.16em;font-size:.72rem;color:#c4b5fd;font-weight:850}h1{font-size:clamp(2.8rem,7vw,6rem);line-height:.92;margin:12px 0 18px;max-width:980px}.lead{color:var(--muted);font-size:1.08rem;line-height:1.7;max-width:850px}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin-top:22px}.button{display:inline-flex;text-decoration:none;color:white;padding:11px 15px;border-radius:999px;border:1px solid var(--line);font-weight:800;background:rgba(255,255,255,.06)}.button.primary{border:0;background:linear-gradient(135deg,var(--violet),var(--cyan))}.status{display:flex;justify-content:space-between;gap:14px;align-items:center;border-radius:20px;padding:15px 18px;margin:18px 0}.dot{width:10px;height:10px;border-radius:50%;display:inline-block;background:#34d399;box-shadow:0 0 18px #34d399}.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}.card{border-radius:23px;padding:22px;text-decoration:none;color:inherit;transition:transform .18s ease,border-color .18s ease}.card:hover{transform:translateY(-4px);border-color:rgba(34,211,238,.55)}.card h2{margin:10px 0 9px}.card p{color:var(--muted);line-height:1.58}.tag{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:6px 9px;color:#cbd5e1;font-size:.75rem}.arrow{font-size:1.4rem;color:#67e8f9}@media(max-width:980px){.grid{grid-template-columns:repeat(2,1fr)}}@media(max-width:650px){.grid{grid-template-columns:1fr}.shell{padding:20px 13px 55px}.hero{padding:22px}h1{font-size:3rem}}
</style>${spmtSharedUiHead("fly-machine-rotator")}</head><body><main class="shell">
<section class="hero"><div class="eyebrow">SPMT authenticated control plane</div><h1>One front door for Rotator, Athena, and the local LLM.</h1><p class="lead">The inference worker stays private and API-only. Rotator and Coder use the canonical SPMT owner session directly; MountainView keeps its own app-specific session instead of acting as the gatekeeper for everything else.</p><div class="toolbar"><a class="button primary" href="/athena/llm">Open LLM Workbench</a><a class="button" href="/athena">Open Athena Coder</a><a class="button" href="/rotator">Open fleet dashboard</a><a class="button" href="/auth/spmt/logout">Sign out Rotator</a></div></section>
<section class="status"><div><span class="dot"></span> Signed in as <strong>${escapeHtml(adminName)}</strong></div><div>SPMT owner session · MountainView separate</div></section>
<section class="grid">${cards.map(([title, href, description, tag]) => `<a class="card" href="${href}"><span class="tag">${tag}</span><h2>${title}</h2><p>${description}</p><span class="arrow">→</span></a>`).join("")}</section>
</main>${spmtSharedUiScript("fly-machine-rotator")}</body></html>`;
}
