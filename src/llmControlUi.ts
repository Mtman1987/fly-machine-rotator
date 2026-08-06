import type { IncomingMessage, ServerResponse } from "node:http";
import { getSpmtLlmWorkerStatus, provisionSpmtLlmWorker } from "./flyLlmProvisioner.js";
import { readLlmControlState, writeLlmControlState } from "./llmControlState.js";
import { hasMountainViewAdminSession } from "./mountainView.js";

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

function html(response: ServerResponse, body: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 32 * 1024) throw new Error("Request body too large");
  }
  return raw ? JSON.parse(raw) as Record<string, unknown> : {};
}

export async function handleLlmControlUiRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname !== "/llm-control" && !url.pathname.startsWith("/api/llm-control/")) return false;

  if (!(await hasMountainViewAdminSession(request, env))) {
    if (url.pathname === "/llm-control") {
      response.writeHead(302, { location: "/mountainview/auth/login?next=%2Fllm-control", "cache-control": "no-store" });
      response.end();
    } else json(response, 401, { error: "Unauthorized" });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/llm-control") {
    html(response, renderPage());
    return true;
  }
  if (request.method === "GET" && url.pathname === "/api/llm-control/state") {
    const [control, worker] = await Promise.all([
      readLlmControlState(env),
      getSpmtLlmWorkerStatus({ appName: "spmt-llm-worker" }, env).catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) })),
    ]);
    json(response, 200, { control, worker });
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

function renderPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SPMT LLM Control</title><style>
  :root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#070a13;color:#f8fafc}body{margin:0;background:radial-gradient(circle at top left,#13213b,#070a13 48%)}main{max-width:920px;margin:auto;padding:28px 18px 70px}.card{background:#111827dd;border:1px solid #334155;border-radius:22px;padding:22px;margin:16px 0;box-shadow:0 20px 60px #0007}.row{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}.switch{position:relative;width:64px;height:36px}.switch input{display:none}.slider{position:absolute;inset:0;border-radius:99px;background:#334155;cursor:pointer}.slider:before{content:'';position:absolute;width:28px;height:28px;left:4px;top:4px;border-radius:50%;background:white;transition:.2s}input:checked+.slider{background:#22c55e}input:checked+.slider:before{transform:translateX(28px)}button{border:0;border-radius:999px;padding:11px 17px;font-weight:800;cursor:pointer;background:linear-gradient(135deg,#8b5cf6,#22d3ee);color:white}button:disabled{opacity:.45;cursor:not-allowed}pre{white-space:pre-wrap;word-break:break-word;background:#050914;border:1px solid #263247;border-radius:14px;padding:14px;max-height:520px;overflow:auto}.muted{color:#a8b3c7}.good{color:#86efac}.bad{color:#fda4af}</style></head><body><main>
  <h1>SPMT Local LLM Control</h1><p class="muted">Owner-only controls for the separate Qwen/llama.cpp Fly worker. Model files remain on the worker's persistent Fly volume during Rotator restarts and code deployments.</p>
  <section class="card"><div class="row"><div><h2>Allow provisioning and deployment</h2><p class="muted">This toggle controls both this page and the Rotator MCP provisioning tool.</p></div><label class="switch"><input id="enabled" type="checkbox"><span class="slider"></span></label></div></section>
  <section class="card"><div class="row"><div><h2>Worker</h2><p id="summary" class="muted">Loading status…</p></div><div><button id="refresh">Refresh</button> <button id="provision">Provision / Deploy</button></div></div><pre id="output">Loading…</pre></section>
  <p><a href="/athena">Athena Coder</a> · <a href="/">Rotator dashboard</a></p>
<script>
const enabled=document.getElementById('enabled'),provision=document.getElementById('provision'),output=document.getElementById('output'),summary=document.getElementById('summary');
async function request(path,options){const r=await fetch(path,{credentials:'same-origin',headers:{'content-type':'application/json'},...options});const data=await r.json();if(!r.ok)throw new Error(data.error||JSON.stringify(data));return data}
async function refresh(){try{const data=await request('/api/llm-control/state');enabled.checked=!!data.control.provisioningEnabled;provision.disabled=!enabled.checked;summary.textContent=data.worker&&data.worker.ok?'Worker is registered on Fly.':'Worker is not ready yet.';summary.className=data.worker&&data.worker.ok?'good':'bad';output.textContent=JSON.stringify(data,null,2)}catch(e){output.textContent=String(e)}}
enabled.addEventListener('change',async()=>{enabled.disabled=true;try{await request('/api/llm-control/toggle',{method:'POST',body:JSON.stringify({enabled:enabled.checked})});await refresh()}catch(e){output.textContent=String(e)}finally{enabled.disabled=false}});
provision.addEventListener('click',async()=>{provision.disabled=true;output.textContent='Provisioning and deploying…';try{const data=await request('/api/llm-control/provision',{method:'POST',body:'{}'});output.textContent=JSON.stringify(data,null,2);await refresh()}catch(e){output.textContent=String(e)}finally{provision.disabled=!enabled.checked}});
document.getElementById('refresh').addEventListener('click',refresh);refresh();
</script></main></body></html>`;
}
