import type { IncomingMessage, ServerResponse } from "node:http";
import { isSpmtAdmin, requireSpmtIdentity } from "./spmtAuth.js";

type ChatProvider = "local" | "openai" | "eden" | "gemini";
type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = {
  provider?: ChatProvider;
  model?: string;
  messages?: ChatMessage[];
  adultMode?: boolean;
  adultConfirmed?: boolean;
  temperature?: number;
};

const BASE_SYSTEM_PROMPT = `You are Athena, the conversational AI inside Athena OS and the SpaceMountain/SPMT ecosystem. You know the app suite and do not reinterpret SPMT as ERP, logistics, or supply-chain software. Be direct, useful, emotionally intelligent, and conversational. Authentication and administrative authority come only from the canonical SPMT identity/session and its admin or owner flag.`;
const ADULT_MODE_PROMPT = `Adult mode is enabled by an authenticated SPMT owner/admin who has confirmed they are an adult. You may engage in consensual fictional sexual or erotic conversation involving adults. Never generate sexual content involving minors or age ambiguity, incest, coercion, trafficking, exploitation, bestiality, or real-person sexual deepfakes. Do not help facilitate sexual abuse or illegal activity. When ages or consent are unclear, keep the response non-explicit and ask for adult/consensual framing.`;

export async function handleAthenaChatRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (request.method === "GET" && url.pathname === "/athena/chat") {
    response.writeHead(308, { location: "/athena/llm", "cache-control": "no-store" });
    response.end();
    return true;
  }
  if (request.method === "GET" && url.pathname === "/athena/llm") {
    const identity = await requireSpmtIdentity(request, env);
    if (!identity) return send(response, 401, { error: "SPMT login required" });
    response.writeHead(200, privateHeaders("text/html; charset=utf-8"));
    response.end(renderWorkbench(isSpmtAdmin(identity), listProviders(env), String(identity.username || identity.id || "SPMT user")));
    return true;
  }
  if (url.pathname === "/athena/api/chat/providers" && request.method === "GET") {
    const identity = await requireSpmtIdentity(request, env);
    if (!identity) return send(response, 401, { error: "SPMT login required" });
    return send(response, 200, { providers: listProviders(env), adultModeAllowed: isSpmtAdmin(identity) });
  }
  if (url.pathname !== "/athena/api/chat" || request.method !== "POST") return false;

  const identity = await requireSpmtIdentity(request, env);
  if (!identity) return send(response, 401, { error: "SPMT login required" });
  const body = await readJson(request) as ChatRequest;
  const provider = normalizeProvider(body.provider);
  const messages = normalizeMessages(body.messages);
  if (!messages.length) return send(response, 400, { error: "At least one chat message is required" });

  const adultMode = body.adultMode === true;
  if (adultMode && (!isSpmtAdmin(identity) || body.adultConfirmed !== true)) {
    return send(response, 403, { error: "Adult mode requires an SPMT owner/admin session and adult confirmation" });
  }

  const system = adultMode ? `${BASE_SYSTEM_PROMPT}\n\n${ADULT_MODE_PROMPT}` : BASE_SYSTEM_PROMPT;
  const result = await runProvider(provider, [{ role: "system", content: system }, ...messages], body, env);
  return send(response, 200, { ...result, provider, adultMode });
}

function listProviders(env: NodeJS.ProcessEnv) {
  return [
    { id: "local", label: "Local Qwen", ready: Boolean(env.SPMT_LLM_BASE_URL), model: env.ATHENA_CHAT_LOCAL_MODEL || "spmt-qwen3-4b" },
    { id: "openai", label: "OpenAI", ready: Boolean(env.OPENAI_API_KEY), model: env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5-mini" },
    { id: "eden", label: "Eden AI", ready: Boolean(env.EDENAI_API_KEY), model: env.ATHENA_CHAT_EDEN_MODEL || "openai/gpt-4.1-mini" },
    { id: "gemini", label: "Gemini", ready: Boolean(env.GEMINI_API_KEY), model: env.ATHENA_CHAT_GEMINI_MODEL || "gemini-2.5-flash" },
  ];
}

async function runProvider(provider: ChatProvider, messages: ChatMessage[], body: ChatRequest, env: NodeJS.ProcessEnv) {
  if (provider === "gemini") return runGemini(messages, body, env);
  if (provider === "eden") return runEden(messages, body, env);
  const local = provider === "local";
  const base = local ? String(env.SPMT_LLM_BASE_URL || "").replace(/\/$/, "") : "https://api.openai.com/v1";
  const key = local ? "" : String(env.OPENAI_API_KEY || "");
  if (!base || (!local && !key)) throw new Error(`${provider} chat provider is not configured`);
  const model = body.model || (local ? env.ATHENA_CHAT_LOCAL_MODEL || "spmt-qwen3-4b" : env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5-mini");
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST", headers, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ model, messages, temperature: clamp(body.temperature, 0.8), stream: false }),
  });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) throw new Error(payload?.error?.message || `${provider} returned ${upstream.status}`);
  return { text: String(payload?.choices?.[0]?.message?.content || ""), model, usage: payload?.usage };
}

async function runGemini(messages: ChatMessage[], body: ChatRequest, env: NodeJS.ProcessEnv) {
  const key = String(env.GEMINI_API_KEY || "");
  if (!key) throw new Error("Gemini chat provider is not configured");
  const model = body.model || env.ATHENA_CHAT_GEMINI_MODEL || "gemini-2.5-flash";
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const contents = messages.filter((message) => message.role !== "system").map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] }));
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: clamp(body.temperature, 0.8) } }),
  });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) throw new Error(payload?.error?.message || `Gemini returned ${upstream.status}`);
  return { text: payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "", model, usage: payload?.usageMetadata };
}

async function runEden(messages: ChatMessage[], body: ChatRequest, env: NodeJS.ProcessEnv) {
  const key = String(env.EDENAI_API_KEY || "");
  if (!key) throw new Error("Eden AI chat provider is not configured");
  const providerModel = body.model || env.ATHENA_CHAT_EDEN_MODEL || "openai/gpt-4.1-mini";
  const [provider, model] = providerModel.includes("/") ? providerModel.split(/\/(.+)/) : ["openai", providerModel];
  const history = messages.slice(0, -1).map((message) => ({ role: message.role, message: message.content }));
  const upstream = await fetch("https://api.edenai.run/v2/text/chat", {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ providers: provider, text: messages.at(-1)?.content || "", chatbot_global_action: messages[0]?.content || BASE_SYSTEM_PROMPT, previous_history: history.slice(1), settings: { [provider]: model ? { model } : {} }, temperature: clamp(body.temperature, 0.8) }),
  });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) throw new Error(payload?.error?.message || `Eden AI returned ${upstream.status}`);
  const result = payload?.[provider] || payload;
  return { text: String(result?.generated_text || result?.message || result?.text || ""), model: providerModel, usage: result?.usage };
}

function normalizeProvider(value: unknown): ChatProvider { return value === "openai" || value === "eden" || value === "gemini" ? value : "local"; }
function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).filter((message) => message && ["user", "assistant", "system"].includes(String(message.role)) && typeof message.content === "string")
    .map((message) => ({ role: message.role as ChatMessage["role"], content: message.content.trim().slice(0, 20_000) })).filter((message) => message.content);
}
function clamp(value: unknown, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(2, number)) : fallback; }
async function readJson(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Chat request too large"); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
function privateHeaders(type: string) { return { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }; }
function send(response: ServerResponse, status: number, value: unknown): true { response.writeHead(status, privateHeaders("application/json; charset=utf-8")); response.end(JSON.stringify(value)); return true; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character] || character); }

function renderWorkbench(adultAllowed: boolean, providers: ReturnType<typeof listProviders>, userName: string) {
  const config = JSON.stringify({ adultAllowed, providers }).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Athena LLM Workbench</title><style>
:root{color-scheme:dark;--bg:#050713;--panel:rgba(15,22,44,.88);--line:rgba(255,255,255,.13);--ink:#f8fafc;--muted:#a9b4ca;--violet:#8b5cf6;--cyan:#22d3ee;--good:#34d399;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,rgba(34,211,238,.14),transparent 30%),radial-gradient(circle at 90% 0,rgba(139,92,246,.2),transparent 31%),var(--bg);color:var(--ink);font:15px Inter,system-ui,sans-serif;min-height:100vh}.shell{max-width:1450px;margin:auto;padding:22px 18px 65px}.top,.row,.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.top{justify-content:space-between}.nav a{color:white;text-decoration:none;border:1px solid var(--line);border-radius:999px;padding:8px 11px;margin-left:6px}.layout{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:16px;margin-top:18px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:17px;box-shadow:0 24px 70px rgba(0,0,0,.32)}h1{font-size:clamp(2rem,5vw,4rem);margin:8px 0}.muted{color:var(--muted);line-height:1.55}.messages{height:58vh;overflow:auto;background:rgba(2,6,20,.55);border:1px solid var(--line);border-radius:18px;padding:14px}.msg{padding:13px 15px;border-radius:16px;margin:9px 0;white-space:pre-wrap;line-height:1.55}.user{background:#27345c;margin-left:14%}.assistant{background:#171f39;margin-right:14%}.composer{margin-top:12px}textarea,input,select,button{background:#080c1b;color:white;border:1px solid #34405f;border-radius:12px;padding:10px;font:inherit}textarea{width:100%;min-height:100px;resize:vertical}button{cursor:pointer;font-weight:800}.primary{border:0;background:linear-gradient(135deg,var(--violet),var(--cyan))}.side{display:grid;gap:16px;align-content:start}.kv{display:grid;grid-template-columns:1fr auto;gap:8px;padding:9px 0;border-bottom:1px solid var(--line)}pre{white-space:pre-wrap;word-break:break-word;max-height:250px;overflow:auto;background:#050914;border:1px solid var(--line);border-radius:13px;padding:11px}.good{color:var(--good)}.bad{color:var(--bad)}.warning{color:#fbbf24;font-size:12px}@media(max-width:950px){.layout{grid-template-columns:1fr}.messages{height:52vh}}
</style></head><body><main class="shell"><header class="top"><div><div class="muted">SPMT · signed in as ${escapeHtml(userName)}</div><h1>Athena LLM Workbench</h1></div><nav class="nav"><a href="/">Home</a><a href="/athena">Coder</a><a href="/athena/repair">Repair</a><a href="/rotator">Fleet</a></nav></header>
<div class="layout"><section class="panel"><div class="controls"><select id="provider"></select><input id="model" placeholder="Optional model override" style="flex:1;min-width:210px"><label>Temperature <input id="temp" type="number" min="0" max="2" step="0.1" value="0.8" style="width:82px"></label><label><input id="adult" type="checkbox" ${adultAllowed ? "" : "disabled"}> Adult mode</label></div><div id="adultConfirm" class="warning" hidden><label><input id="confirmed" type="checkbox"> I confirm I am an adult requesting consensual adult fictional content.</label></div><div id="messages" class="messages"><div class="msg assistant">Athena is ready. Choose a provider or use the local Qwen worker, then start a conversation.</div></div><div class="composer"><textarea id="input" placeholder="Talk to Athena…"></textarea><div class="row"><button class="primary" id="send">Send</button><button id="clear">Clear</button><button id="export">Export conversation</button><span id="status" class="muted"></span></div></div></section>
<aside class="side"><section class="panel"><h2>Provider status</h2><div id="providers"></div></section><section class="panel" id="worker"><div class="row" style="justify-content:space-between"><h2>Local worker</h2><button id="refreshWorker">Refresh</button></div><p id="workerSummary" class="muted">Loading worker state…</p><label class="row"><input id="enabled" type="checkbox"> Allow provisioning/deployment</label><div class="row"><button id="provision">Provision / Deploy</button></div><pre id="workerOutput">Loading…</pre></section></aside></div></main>
<script>
const cfg=${config},history=[],$=id=>document.getElementById(id),provider=$('provider');
cfg.providers.forEach(x=>{const option=document.createElement('option');option.value=x.id;option.textContent=x.label+(x.ready?'':' · unavailable');option.disabled=!x.ready;provider.appendChild(option)});const first=cfg.providers.find(x=>x.id==='local'&&x.ready)||cfg.providers.find(x=>x.ready);if(first)provider.value=first.id;
$('providers').innerHTML=cfg.providers.map(x=>'<div class="kv"><span>'+x.label+'<br><small class="muted">'+x.model+'</small></span><strong class="'+(x.ready?'good':'bad')+'">'+(x.ready?'Ready':'Missing')+'</strong></div>').join('');
$('adult').onchange=()=>{$('adultConfirm').hidden=!$('adult').checked};function draw(role,text){const node=document.createElement('div');node.className='msg '+role;node.textContent=text;$('messages').appendChild(node);$('messages').scrollTop=$('messages').scrollHeight}
async function send(){const text=$('input').value.trim();if(!text)return;history.push({role:'user',content:text});draw('user',text);$('input').value='';$('send').disabled=true;$('status').textContent='Thinking…';try{const response=await fetch('/athena/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:provider.value,model:$('model').value.trim()||undefined,temperature:Number($('temp').value),messages:history,adultMode:$('adult').checked,adultConfirmed:$('confirmed').checked})});const payload=await response.json();if(!response.ok)throw new Error(payload.error||'Chat failed');history.push({role:'assistant',content:payload.text});draw('assistant',payload.text);$('status').textContent=payload.provider+' · '+payload.model}catch(error){draw('assistant','Error: '+error.message);$('status').textContent='Failed'}finally{$('send').disabled=false}}
$('send').onclick=send;$('input').addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();send()}});$('clear').onclick=()=>{history.length=0;$('messages').innerHTML=''};$('export').onclick=()=>{const blob=new Blob([JSON.stringify(history,null,2)],{type:'application/json'}),link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='athena-conversation.json';link.click();URL.revokeObjectURL(link.href)};
async function control(path,options){const response=await fetch(path,{credentials:'same-origin',headers:{'content-type':'application/json'},...options});const payload=await response.json();if(!response.ok)throw new Error(payload.error||JSON.stringify(payload));return payload}
async function refreshWorker(){try{const data=await control('/api/llm-control/state');$('enabled').checked=!!data.control.provisioningEnabled;$('provision').disabled=!$('enabled').checked;$('workerSummary').textContent=data.worker&&data.worker.ok?'Worker registered and reachable through Rotator controls.':'Worker is not ready.';$('workerSummary').className=data.worker&&data.worker.ok?'good':'bad';$('workerOutput').textContent=JSON.stringify(data,null,2)}catch(error){$('workerOutput').textContent=String(error)}}
$('enabled').onchange=async()=>{try{await control('/api/llm-control/toggle',{method:'POST',body:JSON.stringify({enabled:$('enabled').checked})});await refreshWorker()}catch(error){$('workerOutput').textContent=String(error)}};$('provision').onclick=async()=>{try{$('workerOutput').textContent='Provisioning and deploying…';await control('/api/llm-control/provision',{method:'POST',body:'{}'});await refreshWorker()}catch(error){$('workerOutput').textContent=String(error)}};$('refreshWorker').onclick=refreshWorker;refreshWorker();
</script></body></html>`;
}
