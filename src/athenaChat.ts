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
  if (url.pathname === "/athena/chat" && request.method === "GET") {
    const identity = await requireSpmtIdentity(request, env);
    if (!identity) return send(response, 401, { error: "SPMT login required" });
    response.writeHead(200, privateHeaders("text/html; charset=utf-8"));
    response.end(renderChatUi(isSpmtAdmin(identity), listProviders(env)));
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
    { id: "local", label: "Local", ready: Boolean(env.SPMT_LLM_BASE_URL), model: env.ATHENA_CHAT_LOCAL_MODEL || "spmt-qwen3-4b" },
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
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { temperature: clamp(body.temperature, 0.8) } }),
  });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) throw new Error(payload?.error?.message || `Gemini returned ${upstream.status}`);
  const text = payload?.candidates?.[0]?.content?.parts?.map((part: any) => part?.text || "").join("") || "";
  return { text, model, usage: payload?.usageMetadata };
}

async function runEden(messages: ChatMessage[], body: ChatRequest, env: NodeJS.ProcessEnv) {
  const key = String(env.EDENAI_API_KEY || "");
  if (!key) throw new Error("Eden AI chat provider is not configured");
  const providerModel = body.model || env.ATHENA_CHAT_EDEN_MODEL || "openai/gpt-4.1-mini";
  const [provider, model] = providerModel.includes("/") ? providerModel.split(/\/(.+)/) : ["openai", providerModel];
  const history = messages.slice(0, -1).map((m) => ({ role: m.role, message: m.content }));
  const last = messages.at(-1)?.content || "";
  const upstream = await fetch("https://api.edenai.run/v2/text/chat", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({ providers: provider, text: last, chatbot_global_action: messages[0]?.content || BASE_SYSTEM_PROMPT, previous_history: history.slice(1), settings: { [provider]: model ? { model } : {} }, temperature: clamp(body.temperature, 0.8) }),
  });
  const payload = await upstream.json().catch(() => ({})) as any;
  if (!upstream.ok) throw new Error(payload?.error?.message || `Eden AI returned ${upstream.status}`);
  const result = payload?.[provider] || payload;
  return { text: String(result?.generated_text || result?.message || result?.text || ""), model: providerModel, usage: result?.usage };
}

function normalizeProvider(value: unknown): ChatProvider {
  return value === "openai" || value === "eden" || value === "gemini" ? value : "local";
}
function normalizeMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-40).filter((m) => m && ["user", "assistant", "system"].includes(String(m.role)) && typeof m.content === "string")
    .map((m) => ({ role: m.role as ChatMessage["role"], content: m.content.trim().slice(0, 20_000) })).filter((m) => m.content);
}
function clamp(value: unknown, fallback: number) { const n = Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(2, n)) : fallback; }
async function readJson(request: IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); if (Buffer.concat(chunks).length > 1_000_000) throw new Error("Chat request too large"); return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
function privateHeaders(type: string) { return { "content-type": type, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" }; }
function send(response: ServerResponse, status: number, value: unknown): true { response.writeHead(status, privateHeaders("application/json; charset=utf-8")); response.end(JSON.stringify(value)); return true; }

function renderChatUi(adultAllowed: boolean, providers: ReturnType<typeof listProviders>) {
  const data = JSON.stringify({ adultAllowed, providers }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Athena Chat</title><style>body{margin:0;background:#070914;color:#f8fafc;font:16px system-ui}.app{max-width:980px;margin:auto;padding:24px}.bar,.controls{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.bar{justify-content:space-between}.panel{background:#11162a;border:1px solid #29304a;border-radius:18px;padding:16px;margin-top:16px}.messages{min-height:55vh;max-height:65vh;overflow:auto}.msg{padding:12px 14px;border-radius:15px;margin:9px 0;white-space:pre-wrap}.user{background:#27345c;margin-left:15%}.assistant{background:#181f37;margin-right:15%}textarea,select,button{background:#090d1c;color:white;border:1px solid #34405f;border-radius:12px;padding:11px;font:inherit}textarea{width:100%;min-height:90px;box-sizing:border-box}button{cursor:pointer;font-weight:700}.send{background:linear-gradient(135deg,#7c3aed,#0891b2)}label{display:flex;gap:7px;align-items:center}.warn{color:#fbbf24;font-size:13px}</style></head><body><main class="app"><div class="bar"><h1>Athena Chat</h1><a href="/athena" style="color:#c4b5fd">Athena Coder</a></div><section class="panel controls"><select id="provider"></select><input id="model" placeholder="Optional model override" style="flex:1;min-width:220px"><label><input id="adult" type="checkbox" ${adultAllowed ? "" : "disabled"}> Adult mode</label></section><div id="adultConfirm" class="warn" hidden><label><input id="confirmed" type="checkbox"> I confirm I am an adult and want consensual adult fictional content enabled.</label></div><section id="messages" class="panel messages"></section><section class="panel"><textarea id="input" placeholder="Talk to Athena..."></textarea><div class="controls"><button class="send" id="send">Send</button><button id="clear">Clear</button><span id="status"></span></div></section></main><script>const cfg=${data},history=[],$=id=>document.getElementById(id),p=$('provider');cfg.providers.forEach(x=>{const o=document.createElement('option');o.value=x.id;o.textContent=x.label+(x.ready?'':' (not configured)');o.disabled=!x.ready;p.appendChild(o)});const local=cfg.providers.find(x=>x.id==='local'&&x.ready),first=local||cfg.providers.find(x=>x.ready);if(first)p.value=first.id;$('adult').onchange=()=>{$('adultConfirm').hidden=!$('adult').checked};$('clear').onclick=()=>{history.length=0;$('messages').innerHTML=''};function draw(role,text){const d=document.createElement('div');d.className='msg '+role;d.textContent=text;$('messages').appendChild(d);$('messages').scrollTop=$('messages').scrollHeight}async function send(){const text=$('input').value.trim();if(!text)return;history.push({role:'user',content:text});draw('user',text);$('input').value='';$('send').disabled=true;$('status').textContent='Thinking...';try{const r=await fetch('/athena/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({provider:p.value,model:$('model').value.trim()||undefined,messages:history,adultMode:$('adult').checked,adultConfirmed:$('confirmed').checked})});const j=await r.json();if(!r.ok)throw new Error(j.error||'Chat failed');history.push({role:'assistant',content:j.text});draw('assistant',j.text)}catch(e){draw('assistant','Error: '+e.message)}finally{$('send').disabled=false;$('status').textContent=''}}$('send').onclick=send;$('input').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send()}});</script></body></html>`;
}
