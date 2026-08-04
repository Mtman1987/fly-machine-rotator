import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { hasMountainViewAdminSession } from "./mountainView.js";
import { listCodeReferences, listCodexJobs, type PublicCodexJob } from "./publicCodexFixer.js";

export function startAthenaSpmtGateway(
  env: NodeJS.ProcessEnv = process.env,
  internalPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT || 8081),
  publicPort = Number(env.PORT || env.ROTATOR_DASHBOARD_PORT || 8080),
) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(302, { location: "/athena", "cache-control": "no-store" });
        response.end();
        return;
      }

      if (request.method === "GET" && (url.pathname === "/athena" || url.pathname === "/coder")) {
        if (!(await hasMountainViewAdminSession(request, env))) return redirectToLogin(response, url);
        const [jobs, references] = await Promise.all([listCodexJobs(env, 50), listCodeReferences(env)]);
        response.writeHead(200, privateHeaders("text/html; charset=utf-8"));
        response.end(renderIde(jobs, references, connectionStatus(env)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/athena/api/jobs") {
        if (!(await hasMountainViewAdminSession(request, env))) return sendJson(response, 401, { error: "Unauthorized" });
        return sendJson(response, 200, { jobs: await listCodexJobs(env, 50) });
      }

      if (request.method === "GET" && url.pathname === "/athena/api/connections") {
        if (!(await hasMountainViewAdminSession(request, env))) return sendJson(response, 401, { error: "Unauthorized" });
        return sendJson(response, 200, { connections: connectionStatus(env) });
      }

      if (request.method === "GET" && url.pathname === "/rotator") {
        if (!(await hasMountainViewAdminSession(request, env))) return redirectToLogin(response, url);
        await proxyDashboardHtmlWithoutBrowserToken(request, response, env, internalPort);
        return;
      }

      await proxyRequest(request, response, env, internalPort);
    } catch (error) {
      console.error("Athena SPMT gateway failed", error);
      if (!response.headersSent) response.writeHead(500, privateHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(publicPort, "0.0.0.0", () => {
    console.log(`Athena SPMT IDE listening on ${publicPort}; Rotator core is internal on ${internalPort}`);
  });
  return server;
}

function redirectToLogin(response: ServerResponse, url: URL) {
  const next = encodeURIComponent(url.pathname + url.search);
  response.writeHead(302, { location: `/mountainview/auth/login?next=${next}`, "cache-control": "no-store" });
  response.end();
}

function privateHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, privateHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

async function proxyRequest(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
  pathOverride?: string,
) {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
  const headers = await authorizedProxyHeaders(incoming, env, internalPort, url.pathname);
  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({
      hostname: "127.0.0.1",
      port: internalPort,
      method: incoming.method,
      path: pathOverride || incoming.url,
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

async function authorizedProxyHeaders(
  incoming: IncomingMessage,
  env: NodeJS.ProcessEnv,
  internalPort: number,
  pathname: string,
): Promise<IncomingHttpHeaders> {
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${internalPort}` };
  const authenticated = await hasMountainViewAdminSession(incoming, env);
  const isWrite = incoming.method !== "GET" && incoming.method !== "HEAD";

  if (authenticated && pathname.startsWith("/api/codex/") && isWrite) {
    const secret = String(env.CODEX_WORKER_SECRET || "").trim();
    if (secret) headers["x-codex-worker-secret"] = secret;
  }

  if (authenticated && (pathname.startsWith("/actions/") || pathname === "/logs/errors.txt")) {
    const token = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN || "").trim();
    if (token) headers["x-rotator-action-token"] = token;
  }

  return headers;
}

async function proxyDashboardHtmlWithoutBrowserToken(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
) {
  const headers = await authorizedProxyHeaders(incoming, env, internalPort, "/");
  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({ hostname: "127.0.0.1", port: internalPort, method: "GET", path: "/", headers }, (upstream) => {
      const chunks: Buffer[] = [];
      upstream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      upstream.on("end", () => {
        let html = Buffer.concat(chunks).toString("utf8");
        html = html.replace(
          /function actionHeaders\(extra = \{\}\) \{[\s\S]*?return \{ \.\.\.extra, \.\.\.\(token \? \{ 'x-rotator-action-token': token \} : \{\}\) \};\s*\}/,
          "function actionHeaders(extra = {}) { return { ...extra }; }",
        );
        html = html
          .replace("<div class=\"eyebrow\">Action token</div>", "<div class=\"eyebrow\">Owner authorization</div>")
          .replace("<div class=\"code-box\">Actions are open.</div>", "<div class=\"code-box\">Authorized by your SPMT admin session. Browser token entry removed.</div>")
          .replaceAll('href="/"', 'href="/rotator"')
          .replace('<a href="#codex-jobs">Athena Coder</a>', '<a href="/athena">Athena Coder IDE</a>');
        outgoing.writeHead(upstream.statusCode || 200, {
          ...upstream.headers,
          ...privateHeaders("text/html; charset=utf-8"),
          "content-length": Buffer.byteLength(html),
        });
        outgoing.end(html);
        resolve();
      });
    });
    proxied.on("error", reject);
    proxied.end();
  });
}

type CodeReference = Awaited<ReturnType<typeof listCodeReferences>>[number];
type Connection = { label: string; status: "ready" | "missing" | "configured"; detail: string; href?: string };

function connectionStatus(env: NodeJS.ProcessEnv): Connection[] {
  const spmt = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
  const spaceMountain = String(env.SPACEMOUNTAIN_BASE_URL || "https://spacemountain.live").replace(/\/$/, "");
  const has = (name: string) => Boolean(String(env[name] || "").trim());
  return [
    { label: "SPMT Live", status: "configured", detail: spmt, href: spmt },
    { label: "SPMT SDK and API docs", status: "configured", detail: "OAuth helpers, event client, partner SDK, and API contracts", href: `${spmt}/docs` },
    { label: "SPMT Athena Code Bridge", status: has("SPMT_CODEX_SERVICE_SECRET") ? "ready" : "missing", detail: `${spmt}/api/athena/code-jobs` },
    { label: "SPMT / MountainView OAuth", status: has("MOUNTAINVIEW_CLIENT_SECRET") ? "ready" : "missing", detail: "One owner session protects the IDE and rotator controls" },
    { label: "Codex worker bridge", status: has("CODEX_WORKER_SECRET") ? "ready" : "missing", detail: "Server-only credential; never sent to the browser" },
    { label: "Rotator action bridge", status: has("ROTATOR_DASHBOARD_ACTION_TOKEN") ? "ready" : "missing", detail: "Server-side compatibility token; browser prompt removed" },
    { label: "OpenAI Codex", status: has("OPENAI_API_KEY") ? "ready" : "missing", detail: String(env.CODEX_FIXER_MODEL || "gpt-5.6-sol") },
    { label: "GitHub draft PR publishing", status: has("GITHUB_TOKEN") ? "ready" : "missing", detail: "Only passing jobs with changes can publish" },
    { label: "SpaceMountain", status: "configured", detail: spaceMountain, href: spaceMountain },
  ];
}

function renderIde(jobs: PublicCodexJob[], references: CodeReference[], connections: Connection[]) {
  const safeJobs = JSON.stringify(jobs).replaceAll("<", "\\u003c");
  const safeReferences = JSON.stringify(references).replaceAll("<", "\\u003c");
  const safeConnections = JSON.stringify(connections).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Athena Coder IDE</title>
<style>
:root{color-scheme:dark;--bg:#050712;--panel:#11162a;--line:rgba(255,255,255,.12);--ink:#f8fafc;--muted:#aeb8cf;--violet:#8b5cf6;--cyan:#22d3ee;--good:#34d399;--warn:#fbbf24;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font-family:Inter,system-ui,sans-serif;background:radial-gradient(circle at 12% 0%,rgba(34,211,238,.13),transparent 28%),radial-gradient(circle at 90% 0%,rgba(139,92,246,.18),transparent 30%),var(--bg)}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.2;background-image:radial-gradient(white 1px,transparent 1px);background-size:72px 72px}a{color:#c4b5fd}.shell{position:relative;z-index:1;max-width:1560px;margin:auto;padding:24px 18px 70px}.topbar,.row,.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.brand{display:flex;align-items:center;gap:12px;font-weight:900;font-size:20px}.orb{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,var(--violet),var(--cyan);box-shadow:0 0 30px rgba(34,211,238,.35)}.nav{display:flex;gap:8px;flex-wrap:wrap}.nav a,.button,button{border:1px solid var(--line);border-radius:999px;padding:10px 14px;text-decoration:none;color:white;background:rgba(255,255,255,.06);font:inherit;font-weight:800;cursor:pointer}.primary{border:0!important;background:linear-gradient(135deg,var(--violet),var(--cyan))!important}.hero{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(340px,.92fr);gap:20px;margin:24px 0 20px}.panel{background:linear-gradient(180deg,rgba(23,29,54,.92),rgba(12,16,32,.92));border:1px solid var(--line);border-radius:24px;padding:22px;box-shadow:0 22px 70px rgba(0,0,0,.35);backdrop-filter:blur(12px)}h1{font-size:clamp(2.7rem,5.4vw,5.4rem);line-height:.94;margin:8px 0 16px}h2,h3,p{margin-top:0}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:11px;color:var(--muted)}.muted,.lead{color:var(--muted)}.lead{line-height:1.65;max-width:72ch}.chips,.actions,.files{display:flex;gap:8px;flex-wrap:wrap}.chip,.status,.file{border:1px solid var(--line);border-radius:999px;padding:7px 10px;color:var(--muted);background:rgba(255,255,255,.04);font-size:12px}.ready,.completed{color:#86efac;background:rgba(52,211,153,.13)}.missing,.failed{color:#fda4af;background:rgba(251,113,133,.13)}.configured,.running,.queued{color:#fde68a;background:rgba(251,191,36,.13)}label{display:grid;gap:7px;color:var(--muted);font-size:13px}select,textarea{width:100%;color:var(--ink);background:rgba(4,7,18,.85);border:1px solid var(--line);border-radius:14px;padding:12px;font:inherit}textarea{min-height:145px;resize:vertical}.composer{display:grid;gap:12px}.connections{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px}.connection,.job,.step{border:1px solid var(--line);border-radius:18px;padding:14px;background:rgba(255,255,255,.035)}.connection p,.job p{color:var(--muted);font-size:13px;line-height:1.45;margin:8px 0 0}.workspace{display:grid;grid-template-columns:minmax(300px,.72fr) minmax(0,1.28fr);gap:20px;margin-top:20px}.jobs{display:grid;gap:10px;max-height:900px;overflow:auto}.job{cursor:pointer}.job.active{border-color:rgba(34,211,238,.55)}.detail{min-height:620px}.timeline{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:16px 0}.step.done{border-color:rgba(52,211,153,.45)}pre{white-space:pre-wrap;word-break:break-word;background:#060914;border:1px solid var(--line);border-radius:16px;padding:15px;max-height:480px;overflow:auto}.notice{min-height:24px;color:#bff8ff}.small{font-size:12px}button:disabled{opacity:.42;cursor:not-allowed}@media(max-width:980px){.hero,.workspace{grid-template-columns:1fr}.jobs{max-height:none}.timeline{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.shell{padding:16px 12px 50px}.timeline{grid-template-columns:1fr}h1{font-size:2.7rem}}
</style></head><body><main class="shell">
<header class="topbar"><div class="brand"><span class="orb"></span><span>Athena Coder IDE</span></div><nav class="nav"><a href="/athena">Coder</a><a href="/rotator">Rotator controls</a><a href="/mountainview">MountainView</a><a href="https://spmt.live/docs">SPMT SDK</a><a href="/logs/errors.txt">Error log</a></nav></header>
<section class="hero"><article class="panel"><div class="eyebrow">SPMT engineering control plane</div><h1>Tell Athena what to inspect, control, or fix.</h1><p class="lead">The same SPMT admin login now authorizes the IDE and rotator controls. The old browser action-token prompt is removed; compatibility credentials stay server-side. Athena can create an isolated checkout, run repository checks, show the diff and Codex response, then create a draft pull request only after you approve it.</p><div class="chips"><span class="chip">One admin session</span><span class="chip">No browser token prompt</span><span class="chip">Isolated workspaces</span><span class="chip">Draft PR boundary</span></div><div class="actions" style="margin-top:18px"><a class="button primary" href="#assignment">New repair</a><a class="button" href="/rotator">Fleet controls</a><a class="button" href="https://spmt.live/docs">SDK and API docs</a></div></article>
<article class="panel composer" id="assignment"><div class="head"><div><div class="eyebrow">New assignment</div><h2>Send work to Athena</h2></div></div><label>Repository<select id="repo"></select></label><label>Problem or requested change<textarea id="description" placeholder="Example: inspect StreamWeaver's command router, fix the failing route, run checks, and prepare a draft PR."></textarea></label><label>Errors, expected behavior, or context<textarea id="context" placeholder="Optional logs, routes, acceptance criteria, or related app details."></textarea></label><button class="primary" id="submit">Send to Athena</button><div class="notice" id="notice"></div></article></section>
<section class="panel"><div class="head"><div><div class="eyebrow">SPMT connections</div><h2>SDK, APIs, auth, and worker links</h2></div><button id="refresh-connections">Refresh</button></div><div class="connections" id="connections"></div></section>
<section class="workspace"><aside class="panel"><div class="head"><div><div class="eyebrow">Mission queue</div><h2>Recent jobs</h2></div><button id="refresh-jobs">Refresh</button></div><div class="jobs" id="jobs"></div></aside><section class="panel detail" id="detail"><p class="muted">Select a job to inspect Athena's work.</p></section></section>
</main><script>
const refs=${safeReferences};let jobs=${safeJobs};let connections=${safeConnections};let selected=jobs[0]?.id||'';let artifact='';const $=id=>document.getElementById(id);const esc=v=>String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));const fmt=v=>{const d=new Date(v);return!v||Number.isNaN(d.getTime())?'n/a':d.toLocaleString()};const label=id=>refs.find(r=>r.id===id)?.label||id;const publishable=j=>j.status==='completed'&&j.changedFiles?.length&&j.checks?.every(c=>c.ok);
async function api(path,options={}){const r=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const text=await r.text();if(!r.ok)throw new Error(text||('Request failed '+r.status));try{return JSON.parse(text)}catch{return text}}
function renderRefs(){$('repo').innerHTML=refs.map(r=>'<option value="'+esc(r.apps[0]||r.id)+'">'+esc(r.label)+'</option>').join('')}
function renderConnections(){$('connections').innerHTML=connections.map(c=>'<article class="connection"><div class="row"><strong>'+esc(c.label)+'</strong><span class="status '+esc(c.status)+'">'+esc(c.status)+'</span></div><p>'+esc(c.detail)+'</p>'+(c.href?'<p><a href="'+esc(c.href)+'">Open</a></p>':'')+'</article>').join('')}
function renderJobs(){if(!jobs.length){$('jobs').innerHTML='<p class="muted">No Athena jobs yet.</p>';$('detail').innerHTML='<p class="muted">Submit the first assignment above.</p>';return}if(!jobs.some(j=>j.id===selected))selected=jobs[0].id;$('jobs').innerHTML=jobs.map(j=>'<article class="job '+(j.id===selected?'active':'')+'" data-id="'+esc(j.id)+'"><div class="row"><strong>'+esc(label(j.repoId))+'</strong><span class="status '+esc(j.status)+'">'+esc(j.status)+'</span></div><p>'+esc(j.description)+'</p><div class="small muted">'+esc(fmt(j.updatedAt))+'</div></article>').join('');document.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>{selected=el.dataset.id;artifact='';renderJobs();renderDetail()}));renderDetail()}
function renderDetail(){const j=jobs.find(x=>x.id===selected);if(!j)return;const checks=(j.checks||[]).map(c=>'<div class="step '+(c.ok?'done':'')+'"><strong>'+(c.ok?'Passed':'Failed')+'</strong><div class="small muted">'+esc(c.command)+'</div></div>').join('');$('detail').innerHTML='<div class="head"><div><div class="eyebrow">'+esc(label(j.repoId))+'</div><h2>'+esc(j.description)+'</h2></div><span class="status '+esc(j.status)+'">'+esc(j.status)+'</span></div><p class="muted">'+esc(j.summary||j.error||'Athena is still working.')+'</p><div class="timeline"><div class="step done">Queued</div><div class="step '+(['running','completed','failed'].includes(j.status)?'done':'')+'">Workspace</div><div class="step '+(['completed','failed'].includes(j.status)?'done':'')+'">Checks</div><div class="step '+(j.pullRequest?'done':'')+'">Draft PR</div></div><div class="files">'+(j.changedFiles||[]).map(f=>'<span class="file">'+esc(f)+'</span>').join('')+'</div><div class="actions" style="margin-top:14px"><button data-artifact="diff">Diff</button><button data-artifact="checks">Checks</button><button data-artifact="response">Codex response</button><button class="primary" id="publish" '+(publishable(j)?'':'disabled')+'>Create draft PR</button>'+(j.pullRequest?'<a class="button" href="'+esc(j.pullRequest.url)+'">Open PR #'+esc(j.pullRequest.number)+'</a>':'')+'</div><div class="timeline">'+checks+'</div>'+(artifact?'<pre>'+esc(artifact)+'</pre>':'');document.querySelectorAll('[data-artifact]').forEach(b=>b.addEventListener('click',()=>loadArtifact(j.id,b.dataset.artifact)));$('publish')?.addEventListener('click',()=>publish(j.id))}
async function refreshJobs(){const p=await api('/athena/api/jobs');jobs=p.jobs||[];renderJobs()}async function loadArtifact(id,name){artifact=await api('/api/codex/jobs/'+encodeURIComponent(id)+'/'+name);renderDetail()}async function publish(id){if(!confirm('Create a draft pull request for this passing job?'))return;await api('/api/codex/jobs/'+encodeURIComponent(id)+'/publish',{method:'POST',body:'{}'});await refreshJobs()}
$('submit').addEventListener('click',async()=>{const description=$('description').value.trim();if(!description){$('notice').textContent='Describe the repair first.';return}$('notice').textContent='Creating isolated workspace...';try{await api('/api/codex/jobs',{method:'POST',body:JSON.stringify({source:'athena-ide',reporter:'Mtman1987',appName:$('repo').value,description,context:{notes:$('context').value}})});$('description').value='';$('notice').textContent='Job accepted.';setTimeout(refreshJobs,700)}catch(e){$('notice').textContent=e.message}});$('refresh-jobs').addEventListener('click',refreshJobs);$('refresh-connections').addEventListener('click',async()=>{connections=(await api('/athena/api/connections')).connections||[];renderConnections()});renderRefs();renderConnections();renderJobs();
</script></body></html>`;
}
