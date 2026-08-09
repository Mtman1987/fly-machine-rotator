import type { IncomingMessage, ServerResponse } from "node:http";
import { readSpmtAccessToken, requireSpmtAdmin } from "./spmtAuth.js";

const PAGE_PATH = "/athena/streamweaver";
const API_PREFIX = "/athena/api/streamweaver";
const TARGETS = {
  config: { path: "/api/user-config", methods: ["GET"] },
  bot: { path: "/api/bot-settings", methods: ["GET", "POST", "PATCH"] },
  generation: { path: "/api/gen-settings", methods: ["GET", "POST", "PATCH"] },
  research: { path: "/api/research-settings", methods: ["GET", "POST", "PATCH"] },
  avatars: { path: "/api/avatars?type=settings", methods: ["GET"] },
} as const;

type TargetName = keyof typeof TARGETS;

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendHtml(response: ServerResponse, body: string) {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<string> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 512 * 1024) throw new Error("Request body too large");
  }
  return raw;
}

function streamWeaverBaseUrl(env: NodeJS.ProcessEnv): string {
  // The Fly hostname is the canonical service origin. The streamweaver.live
  // custom domain currently has an invalid certificate chain for server-side
  // callers, which prevents the protected relay from reaching StreamWeaver.
  return String(env.STREAMWEAVER_BASE_URL || "https://streamweaver-new.fly.dev").replace(/\/$/, "");
}

async function callStreamWeaver(
  request: IncomingMessage,
  env: NodeJS.ProcessEnv,
  target: TargetName,
  methodOverride?: string,
): Promise<{ status: number; contentType: string; body: string }> {
  const definition = TARGETS[target];
  const method = String(methodOverride || request.method || "GET").toUpperCase();
  if (!(definition.methods as readonly string[]).includes(method)) {
    return { status: 405, contentType: "application/json", body: JSON.stringify({ error: "Method not allowed" }) };
  }

  const token = readSpmtAccessToken(request);
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await readBody(request);
    headers["content-type"] = String(request.headers["content-type"] || "application/json");
  }

  const upstream = await fetch(`${streamWeaverBaseUrl(env)}${definition.path}`, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return {
    status: upstream.status,
    contentType: upstream.headers.get("content-type") || "application/json",
    body: await upstream.text(),
  };
}

export async function aggregateStreamWeaverState(request: IncomingMessage, env: NodeJS.ProcessEnv) {
  const entries = await Promise.all((Object.keys(TARGETS) as TargetName[]).map(async (target) => {
    try {
      // IncomingMessage properties such as `headers` are not enumerable. Keep the
      // authenticated request intact and override only the upstream method.
      const result = await callStreamWeaver(request, env, target, "GET");
      let data: unknown = result.body;
      try { data = JSON.parse(result.body); } catch { /* retain text */ }
      return [target, { ok: result.status >= 200 && result.status < 300, status: result.status, data }] as const;
    } catch (error) {
      return [target, { ok: false, status: 502, error: error instanceof Error ? error.message : String(error) }] as const;
    }
  }));
  return Object.fromEntries(entries);
}

export async function handleStreamWeaverAdminUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== PAGE_PATH && !url.pathname.startsWith(`${API_PREFIX}/`)) return false;

  const admin = await requireSpmtAdmin(request, env).catch(() => null);
  if (!admin) {
    sendJson(response, 401, { error: "SPMT administrator or owner authorization required" });
    return true;
  }

  if (request.method === "GET" && url.pathname === PAGE_PATH) {
    sendHtml(response, renderPage(String(admin.username || admin.id || "SPMT admin"), streamWeaverBaseUrl(env)));
    return true;
  }

  if (request.method === "GET" && url.pathname === `${API_PREFIX}/state`) {
    sendJson(response, 200, {
      admin: { id: admin.id, username: admin.username },
      streamWeaverBaseUrl: streamWeaverBaseUrl(env),
      sections: await aggregateStreamWeaverState(request, env),
    });
    return true;
  }

  const target = url.pathname.slice(`${API_PREFIX}/`.length) as TargetName;
  if (!(target in TARGETS)) {
    sendJson(response, 404, { error: "Unknown StreamWeaver admin operation" });
    return true;
  }

  try {
    const result = await callStreamWeaver(request, env, target);
    response.writeHead(result.status, {
      "content-type": result.contentType,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    response.end(result.body);
  } catch (error) {
    sendJson(response, 502, { error: error instanceof Error ? error.message : "StreamWeaver is unavailable" });
  }
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character] || character);
}

function renderPage(adminName: string, baseUrl: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamWeaver Operations · Rotator</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#050812;color:#f8fafc;--solar:#ff9f1c;--blue:#38bdf8;--panel:rgba(15,23,42,.82);--border:rgba(148,163,184,.24)}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 8% 0%,rgba(56,189,248,.18),transparent 32%),radial-gradient(circle at 92% 4%,rgba(255,159,28,.16),transparent 30%),#050812}main{max-width:1180px;margin:auto;padding:30px 18px 80px}.eyebrow{color:var(--solar);font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:.76rem}.hero,.panel{background:var(--panel);border:1px solid var(--border);backdrop-filter:blur(18px);box-shadow:0 24px 80px rgba(0,0,0,.35)}.hero{border-radius:28px;padding:26px}.hero h1{font-size:clamp(2rem,5vw,3.6rem);margin:.35rem 0}.muted{color:#a8b3c7;line-height:1.65}.status{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);border-radius:999px;padding:7px 11px;background:#08101fcc}.dot{width:9px;height:9px;border-radius:50%;background:#f59e0b}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;margin-top:18px}.panel{border-radius:22px;padding:18px}.panel h2{margin:0 0 6px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}button{border:1px solid var(--border);border-radius:999px;padding:9px 14px;background:#172033;color:#fff;font-weight:750;cursor:pointer}button.primary{background:linear-gradient(135deg,#f97316,#ffb02e);color:#130b02;border:0}button:hover{filter:brightness(1.12)}textarea{width:100%;min-height:265px;resize:vertical;border-radius:14px;border:1px solid var(--border);background:#030711;color:#dbeafe;padding:13px;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.wide{grid-column:1/-1}.error{color:#fda4af}.good{color:#86efac}.nav{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.nav a{color:#dbeafe;text-decoration:none;border:1px solid var(--border);border-radius:999px;padding:8px 12px}.notice{border-left:3px solid var(--solar);padding-left:14px}</style></head><body><main>
<section class="hero"><div class="eyebrow">Fly Rotator · Admin Surface</div><h1>StreamWeaver Operations</h1><p class="muted">Internal bot identity, model/provider tuning, research controls, moderation policy, and avatar infrastructure are managed here instead of the general StreamWeaver UI.</p><div class="status"><span class="dot"></span><span>Authorized as ${escapeHtml(adminName)}</span></div><div class="nav"><a href="/athena/chat">Athena Chat</a><a href="/llm-control">LLM Worker</a><a href="/athena/streamweaver">StreamWeaver</a></div></section>
<section class="grid">
<div class="panel wide notice"><h2>Protected boundary</h2><p class="muted">Requests are relayed server-side to ${escapeHtml(baseUrl)} using the current SPMT OAuth session. No provider secret or developer token is placed in this page.</p><div class="actions"><button id="refresh" class="primary">Refresh all</button></div><div id="summary" class="muted">Loading protected configuration…</div></div>
${(["bot", "generation", "research"] as const).map((name) => `<div class="panel"><h2>${name === "bot" ? "Bot identity & voice" : name === "generation" ? "Generation & moderation" : "Research & knowledge"}</h2><p class="muted">Edit the JSON returned by StreamWeaver, then save through the protected Rotator relay.</p><textarea id="${name}"></textarea><div class="actions"><button class="primary" data-save="${name}">Save</button><button data-reset="${name}">Reload</button></div><div id="${name}-status" class="muted"></div></div>`).join("")}
<div class="panel"><h2>Tenant configuration</h2><p class="muted">Read-only effective configuration for diagnosing bot identity, voice, aliases, media slots, and feature flags.</p><textarea id="config" readonly></textarea></div>
<div class="panel"><h2>Avatar infrastructure</h2><p class="muted">Read-only avatar mode and asset-slot status. Binary uploads remain handled by StreamWeaver's authenticated avatar API; they are no longer advertised on public pages.</p><textarea id="avatars" readonly></textarea></div>
</section></main><script>
const names=['config','bot','generation','research','avatars'];let state={};
async function request(path,options={}){const response=await fetch(path,{credentials:'same-origin',headers:{'content-type':'application/json'},...options});const text=await response.text();let data=text;try{data=JSON.parse(text)}catch{}if(!response.ok)throw new Error(typeof data==='object'&&data&&data.error?data.error:text||('HTTP '+response.status));return data}
function pretty(value){return JSON.stringify(value,null,2)}
async function refresh(){const summary=document.getElementById('summary');summary.textContent='Loading…';summary.className='muted';try{const payload=await request('${API_PREFIX}/state');state=payload.sections||{};for(const name of names){const section=state[name]||{};document.getElementById(name).value=pretty(section.data??section)}const failures=names.filter(name=>!state[name]?.ok);summary.textContent=failures.length?'Loaded with failures: '+failures.join(', '):'All protected StreamWeaver sections loaded.';summary.className=failures.length?'error':'good'}catch(error){summary.textContent=String(error);summary.className='error'}}
async function save(name){const status=document.getElementById(name+'-status');status.textContent='Saving…';status.className='muted';try{const parsed=JSON.parse(document.getElementById(name).value);const payload=await request('${API_PREFIX}/'+name,{method:'POST',body:JSON.stringify(parsed)});document.getElementById(name).value=pretty(payload);status.textContent='Saved.';status.className='good'}catch(error){status.textContent=String(error);status.className='error'}}
document.querySelectorAll('[data-save]').forEach(button=>button.addEventListener('click',()=>save(button.dataset.save)));document.querySelectorAll('[data-reset]').forEach(button=>button.addEventListener('click',refresh));document.getElementById('refresh').addEventListener('click',refresh);refresh();
</script></body></html>`;
}
