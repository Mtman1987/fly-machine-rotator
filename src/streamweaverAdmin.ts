import type { IncomingMessage, ServerResponse } from "node:http";
import { isSpmtAdmin, readSpmtAccessToken, requireSpmtIdentity } from "./spmtAuth.js";

const PREFIX = "/athena/streamweaver";
const ALLOWED = new Set(["/api/user-config", "/api/bot-settings", "/api/gen-settings", "/api/research-settings", "/api/avatars"]);

function send(response: ServerResponse, status: number, body: string, contentType = "text/html; charset=utf-8") {
  response.writeHead(status, { "content-type": contentType, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  response.end(body);
}

function page() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>StreamWeaver Operations | Athena</title><style>
:root{color-scheme:dark;--bg:#070a12;--panel:rgba(20,27,44,.76);--line:rgba(148,163,184,.2);--text:#eef4ff;--muted:#9da9bd;--solar:#ff8a2a;--blue:#4da3ff;--danger:#ff647c;--ok:#55d6a6}*{box-sizing:border-box}body{margin:0;font:14px/1.5 Inter,ui-sans-serif,system-ui;background:radial-gradient(circle at 15% 0,rgba(77,163,255,.16),transparent 34%),radial-gradient(circle at 85% 0,rgba(255,138,42,.13),transparent 30%),var(--bg);color:var(--text)}main{max-width:1280px;margin:auto;padding:28px}.hero,.card{border:1px solid var(--line);background:var(--panel);backdrop-filter:blur(18px);border-radius:22px;box-shadow:0 24px 70px rgba(0,0,0,.24)}.hero{padding:26px;margin-bottom:18px}.eyebrow{color:var(--solar);font-weight:800;letter-spacing:.12em;text-transform:uppercase;font-size:12px}h1{font-size:clamp(28px,4vw,46px);margin:8px 0}p{color:var(--muted);max-width:78ch}.badge{display:inline-flex;border:1px solid rgba(85,214,166,.35);color:var(--ok);border-radius:999px;padding:5px 10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}.card{padding:20px}.wide{grid-column:1/-1}h2{margin:0 0 6px;font-size:18px}label{display:block;color:var(--muted);margin:12px 0 6px}input,textarea,select{width:100%;border:1px solid var(--line);border-radius:12px;background:#090e1a;color:var(--text);padding:10px 12px}textarea{min-height:130px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.row>*{flex:1}.actions{display:flex;gap:9px;margin-top:14px;flex-wrap:wrap}button{border:0;border-radius:11px;padding:10px 14px;background:linear-gradient(135deg,var(--solar),#ff6b35);color:#111;font-weight:800;cursor:pointer}button.secondary{background:#16233a;color:var(--text);border:1px solid var(--line)}button:disabled{opacity:.55;cursor:not-allowed}.status{min-height:22px;margin-top:10px;color:var(--muted);white-space:pre-wrap}.status.error{color:var(--danger)}.status.ok{color:var(--ok)}code{color:#b9d8ff}.notice{border-left:3px solid var(--blue);padding-left:12px}</style></head><body><main>
<section class="hero"><div class="eyebrow">Athena Operations Console</div><h1>StreamWeaver administration</h1><span class="badge">SPMT admin / owner only</span><p class="notice">System prompts, provider tuning, research sources, media infrastructure, and developer controls live here. StreamWeaver's public Bot Functions page now describes capabilities without exposing operational configuration.</p></section>
<div class="grid">
<section class="card wide"><h2>Bot identity and behavior</h2><p>Name, aliases, interests, voice, shoutout behavior, and the complete system personality.</p><div class="row"><div><label>Bot name</label><input id="botName"></div><div><label>Voice</label><input id="voice"></div></div><div class="row"><div><label>Aliases</label><input id="aliases"></div><div><label>Interests</label><input id="interests"></div></div><label><input id="skip" type="checkbox" style="width:auto"> Skip shoutout overlay</label><label>Personality / system prompt</label><textarea id="personality" style="min-height:260px"></textarea><div class="actions"><button onclick="saveBot()">Save bot configuration</button><button class="secondary" onclick="loadAll()">Reload</button></div><div id="botStatus" class="status"></div></section>
<section class="card"><h2>Image generation</h2><p>Provider, model, moderation, prompt optimization, LoRA, sampling, and output settings.</p><textarea id="generation"></textarea><div class="actions"><button onclick="saveJson('gen-settings','generation','genStatus')">Save generation settings</button></div><div id="genStatus" class="status"></div></section>
<section class="card"><h2>Research system</h2><p>Live search, knowledge packs, allowlists, result limits, and caching.</p><textarea id="research"></textarea><div class="actions"><button onclick="saveJson('research-settings','research','researchStatus')">Save research settings</button></div><div id="researchStatus" class="status"></div></section>
<section class="card"><h2>Avatar assets</h2><p>Upload tenant-owned idle or talking avatar media. StreamWeaver remains the media source of truth.</p><label>Asset type</label><select id="avatarType"><option value="idle">Idle</option><option value="talking">Talking</option></select><label>MP4, GIF, or Lottie JSON</label><input id="avatarFile" type="file"><div class="actions"><button onclick="uploadAvatar()">Upload avatar asset</button><button class="secondary" onclick="openAvatar('idle')">Preview idle</button><button class="secondary" onclick="openAvatar('talking')">Preview talking</button></div><div id="avatarStatus" class="status"></div></section>
<section class="card"><h2>Raw tenant configuration</h2><p>Developer view for diagnosis. Secrets are redacted by StreamWeaver's API policy and should never be pasted into this console.</p><textarea id="rawConfig" readonly></textarea><div class="actions"><button class="secondary" onclick="loadConfig()">Refresh configuration</button></div><div id="configStatus" class="status"></div></section>
</div></main><script>
const proxy=(name,query='')=>'/athena/streamweaver/api/'+name+query; const el=id=>document.getElementById(id);
function status(id,message,ok=true){const n=el(id);n.textContent=message;n.className='status '+(ok?'ok':'error')}
async function request(name,options={}){const r=await fetch(proxy(name),options);const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}if(!r.ok)throw new Error(typeof data==='string'?data:(data.error||data.message||JSON.stringify(data)));return data}
function unwrap(data){return data?.data||data?.config||data?.settings||data||{}}
async function loadConfig(){try{const data=await request('user-config');const cfg=unwrap(data);el('rawConfig').value=JSON.stringify(cfg,null,2);el('botName').value=cfg.AI_BOT_NAME||'';el('voice').value=cfg.TTS_VOICE||'';el('aliases').value=cfg.AI_BOT_ALIASES||'';el('interests').value=cfg.AI_BOT_INTERESTS||'';el('personality').value=cfg.AI_BOT_PERSONALITY||'';el('skip').checked=String(cfg.SKIP_SHOUTOUT_OVERLAY)==='true';status('configStatus','Configuration loaded')}catch(e){status('configStatus',String(e),false)}}
async function loadAll(){await Promise.allSettled([loadConfig(),loadJson('gen-settings','generation','genStatus'),loadJson('research-settings','research','researchStatus')]);try{const mode=unwrap(await request('bot-settings'));el('skip').checked=mode.skipShoutoutOverlay===true}catch(e){status('botStatus',String(e),false)}}
async function loadJson(name,target,statusId){try{const data=await request(name);el(target).value=JSON.stringify(unwrap(data),null,2);status(statusId,'Loaded')}catch(e){status(statusId,String(e),false)}}
async function saveBot(){try{await request('bot-settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:el('botName').value,voice:el('voice').value,aliases:el('aliases').value,interests:el('interests').value,personality:el('personality').value,skipShoutoutOverlay:el('skip').checked})});status('botStatus','Bot configuration saved');await loadConfig()}catch(e){status('botStatus',String(e),false)}}
async function saveJson(name,target,statusId){try{const body=JSON.parse(el(target).value);await request(name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});status(statusId,'Saved')}catch(e){status(statusId,String(e),false)}}
async function uploadAvatar(){try{const file=el('avatarFile').files[0];if(!file)throw new Error('Choose a file first');const form=new FormData();form.append('file',file);form.append('type',el('avatarType').value);await request('avatars',{method:'POST',body:form});status('avatarStatus','Avatar uploaded')}catch(e){status('avatarStatus',String(e),false)}}
function openAvatar(type){window.open(proxy('avatars','?type='+encodeURIComponent(type)),'_blank','noopener,noreferrer')}
loadAll();</script></body></html>`;
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function proxy(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, targetPath: string, search: string) {
  if (!ALLOWED.has(targetPath)) { send(response, 404, JSON.stringify({ error: "Unknown StreamWeaver operation" }), "application/json; charset=utf-8"); return; }
  const base = String(env.STREAMWEAVER_BASE_URL || "https://streamweaver.live").replace(/\/$/, "");
  const token = readSpmtAccessToken(request);
  const headers: Record<string, string> = { accept: String(request.headers.accept || "application/json"), authorization: `Bearer ${token}` };
  if (request.headers["content-type"]) headers["content-type"] = String(request.headers["content-type"]);
  if (request.headers.cookie) headers.cookie = request.headers.cookie;
  const body = ["GET", "HEAD"].includes(String(request.method)) ? undefined : await readBody(request);
  const upstream = await fetch(`${base}${targetPath}${search}`, { method: request.method, headers, body, redirect: "manual", signal: AbortSignal.timeout(30_000) }).catch((error) => ({ ok: false, status: 502, headers: new Headers({ "content-type": "application/json" }), arrayBuffer: async () => Buffer.from(JSON.stringify({ error: error instanceof Error ? error.message : "StreamWeaver unavailable" })) } as Response));
  const bytes = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  response.end(bytes);
}

export async function handleStreamWeaverAdminRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) return false;
  const identity = await requireSpmtIdentity(request, env);
  if (!identity) { send(response, 401, JSON.stringify({ error: "SPMT sign-in required" }), "application/json; charset=utf-8"); return true; }
  if (!isSpmtAdmin(identity)) { send(response, 403, JSON.stringify({ error: "SPMT admin or owner access required" }), "application/json; charset=utf-8"); return true; }
  if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) { send(response, 200, page()); return true; }
  const match = url.pathname.match(/^\/athena\/streamweaver\/api\/(user-config|bot-settings|gen-settings|research-settings|avatars)$/);
  if (!match) { send(response, 404, JSON.stringify({ error: "Not found" }), "application/json; charset=utf-8"); return true; }
  await proxy(request, response, env, `/api/${match[1]}`, url.search);
  return true;
}
