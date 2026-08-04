import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { hasMountainViewAdminSession } from "./mountainView.js";
import { listCodeReferences, listCodexJobs, type PublicCodexJob } from "./publicCodexFixer.js";

export function startAthenaControlGateway(
  env: NodeJS.ProcessEnv = process.env,
  internalPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT || 8081),
  publicPort = Number(env.PORT || env.ROTATOR_DASHBOARD_PORT || 8080),
) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

      if (request.method === "GET" && (url.pathname === "/athena" || url.pathname === "/coder")) {
        if (!(await hasMountainViewAdminSession(request, env))) return redirectToLogin(response, url);
        const [jobs, references] = await Promise.all([listCodexJobs(env, 50), listCodeReferences(env)]);
        response.writeHead(200, securityHeaders("text/html; charset=utf-8"));
        response.end(renderAthenaHtml(jobs, references, buildConnections(env)));
        return;
      }

      if (request.method === "GET" && url.pathname === "/athena/api/connections") {
        if (!(await hasMountainViewAdminSession(request, env))) return json(response, 401, { error: "Unauthorized" });
        return json(response, 200, buildConnections(env));
      }

      await proxyToDashboard(request, response, env, internalPort);
    } catch (error) {
      console.error("Athena control gateway request failed", error);
      if (!response.headersSent) response.writeHead(500, securityHeaders("application/json; charset=utf-8"));
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(publicPort, "0.0.0.0", () => {
    console.log(`Athena SPMT control gateway listening on ${publicPort}; Rotator dashboard is internal on ${internalPort}`);
  });
  return server;
}

function redirectToLogin(response: ServerResponse, url: URL) {
  const next = encodeURIComponent(url.pathname + url.search);
  response.writeHead(302, { location: `/mountainview/auth/login?next=${next}`, "cache-control": "no-store" });
  response.end();
}

function securityHeaders(contentType: string) {
  return {
    "content-type": contentType,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "same-origin",
  };
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, securityHeaders("application/json; charset=utf-8"));
  response.end(JSON.stringify(value));
}

async function proxyToDashboard(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
) {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${internalPort}` };
  const authenticated = await hasMountainViewAdminSession(incoming, env);
  const isWrite = incoming.method !== "GET" && incoming.method !== "HEAD";
  const isCodexWrite = url.pathname.startsWith("/api/codex/") && isWrite;
  const isRotatorOwnerAction = url.pathname.startsWith("/actions/") || url.pathname === "/logs/errors.txt";

  if (authenticated && isCodexWrite) {
    const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
    if (workerSecret) headers["x-codex-worker-secret"] = workerSecret;
  }

  if (authenticated && isRotatorOwnerAction) {
    const actionToken = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN || "").trim();
    if (actionToken) headers["x-rotator-action-token"] = actionToken;
  }

  await new Promise<void>((resolve, reject) => {
    const proxied = httpRequest({
      hostname: "127.0.0.1",
      port: internalPort,
      method: incoming.method,
      path: incoming.url,
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

type CodeReference = Awaited<ReturnType<typeof listCodeReferences>>[number];

type ConnectionRecord = {
  id: string;
  label: string;
  kind: "site" | "api" | "sdk" | "auth" | "worker";
  status: "ready" | "missing" | "configured";
  detail: string;
  href?: string;
};

function buildConnections(env: NodeJS.ProcessEnv): ConnectionRecord[] {
  const spmt = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
  const spaceMountain = String(env.SPACEMOUNTAIN_BASE_URL || "https://spacemountain.live").replace(/\/$/, "");
  const has = (name: string) => Boolean(String(env[name] || "").trim());
  return [
    { id: "spmt-site", label: "SPMT Live", kind: "site", status: "configured", detail: spmt, href: spmt },
    { id: "spmt-sdk", label: "SPMT SDK", kind: "sdk", status: "configured", detail: "Partner SDK, event client, OAuth helpers, and API contracts", href: `${spmt}/docs` },
    { id: "athena-code-api", label: "Athena Code Bridge", kind: "api", status: has("SPMT_CODEX_SERVICE_SECRET") ? "ready" : "missing", detail: `${spmt}/api/athena/code-jobs` },
    { id: "spmt-auth", label: "SPMT OAuth", kind: "auth", status: has("MOUNTAINVIEW_CLIENT_SECRET") ? "ready" : "missing", detail: "Existing MountainView/SPMT admin session protects the IDE and owner controls" },
    { id: "codex-worker", label: "Codex Worker", kind: "worker", status: has("CODEX_WORKER_SECRET") ? "ready" : "missing", detail: "Server-only bridge used between authenticated UI routes and the isolated worker" },
    { id: "github", label: "GitHub Publishing", kind: "api", status: has("GITHUB_TOKEN") ? "ready" : "missing", detail: "Creates draft pull requests after checks pass" },
    { id: "openai", label: "OpenAI Codex", kind: "api", status: has("OPENAI_API_KEY") ? "ready" : "missing", detail: String(env.CODEX_FIXER_MODEL || "gpt-5.6-sol") },
    { id: "spacemountain", label: "SpaceMountain", kind: "site", status: "configured", detail: spaceMountain, href: spaceMountain },
  ];
}

function renderAthenaHtml(jobs: PublicCodexJob[], references: CodeReference[], connections: ConnectionRecord[]) {
  const safeJobs = JSON.stringify(jobs).replaceAll("<", "\\u003c");
  const safeReferences = JSON.stringify(references).replaceAll("<", "\\u003c");
  const safeConnections = JSON.stringify(connections).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Athena Coder</title>
<style>
:root{color-scheme:dark;--bg:#050712;--panel:#11162a;--line:rgba(255,255,255,.12);--ink:#f8fafc;--muted:#aeb8cf;--violet:#8b5cf6;--cyan:#22d3ee;--good:#34d399;--warn:#fbbf24;--bad:#fb7185}*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:radial-gradient(circle at 12% 0%,rgba(34,211,238,.13),transparent 28%),radial-gradient(circle at 90% 0%,rgba(139,92,246,.18),transparent 30%),var(--bg)}body:before{content:"";position:fixed;inset:0;pointer-events:none;opacity:.2;background-image:radial-gradient(white 1px,transparent 1px);background-size:72px 72px}a{color:#c4b5fd}button,select,textarea,input{font:inherit}button,.button{border:0;border-radius:999px;padding:11px 16px;font-weight:800;cursor:pointer;color:white;background:linear-gradient(135deg,var(--violet),var(--cyan));text-decoration:none;display:inline-flex;align-items:center}.secondary{background:rgba(255,255,255,.06)!important;border:1px solid var(--line)!important}.danger{background:var(--bad)!important}button:disabled{opacity:.45;cursor:not-allowed}.shell{position:relative;z-index:1;max-width:1550px;margin:auto;padding:24px 18px 70px}.topbar,.row,.job-head,.section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}.brand{display:flex;align-items:center;gap:12px;font-weight:900;font-size:20px}.orb{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,var(--violet),var(--cyan));box-shadow:0 0 30px rgba(34,211,238,.35)}.nav{display:flex;gap:9px;flex-wrap:wrap}.nav a{text-decoration:none;color:white;border:1px solid var(--line);background:rgba(255,255,255,.05);border-radius:999px;padding:9px 13px}.hero{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(340px,.9fr);gap:20px;margin:24px 0 20px}.panel{background:linear-gradient(180deg,rgba(23,29,54,.92),rgba(12,16,32,.92));border:1px solid var(--line);border-radius:24px;padding:22px;box-shadow:0 22px 70px rgba(0,0,0,.35);backdrop-filter:blur(12px)}h1{font-size:clamp(2.7rem,5.5vw,5.5rem);line-height:.94;margin:8px 0 16px}h2,h3,p{margin-top:0}.eyebrow{text-transform:uppercase;letter-spacing:.18em;font-size:11px;color:var(--muted)}.lead,.muted{color:var(--muted)}.lead{line-height:1.65;max-width:72ch}.chips,.actions{display:flex;gap:8px;flex-wrap:wrap}.chip,.status{border:1px solid var(--line);border-radius:999px;padding:7px 11px;color:var(--muted);background:rgba(255,255,255,.04);font-size:12px}.status.ready,.status.completed{color:#86efac;background:rgba(52,211,153,.13)}.status.missing,.status.failed{color:#fda4af;background:rgba(251,113,133,.13)}.status.running,.status.queued,.status.configured{color:#fde68a;background:rgba(251,191,36,.13)}.composer{display:grid;gap:12px}label{display:grid;gap:7px;color:var(--muted);font-size:13px}select,textarea,input{width:100%;color:var(--ink);background:rgba(4,7,18,.85);border:1px solid var(--line);border-radius:14px;padding:12px}textarea{min-height:150px;resize:vertical}.workspace{display:grid;grid-template-columns:minmax(320px,.75fr) minmax(0,1.25fr);gap:20px}.jobs{display:grid;gap:12px;max-height:920px;overflow:auto}.job{border:1px solid var(--line);border-radius:19px;padding:16px;background:rgba(255,255,255,.035);cursor:pointer}.job.active{border-color:rgba(34,211,238,.55);box-shadow:0 0 0 2px rgba(34,211,238,.08)}.job p{color:var(--muted);line-height:1.45;margin:10px 0 0}.detail{min-height:620px}.timeline{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin:16px 0}.step{border:1px solid var(--line);border-radius:15px;padding:12px;background:rgba(255,255,255,.035)}.step.done{border-color:rgba(52,211,153,.42)}pre{white-space:pre-wrap;word-break:break-word;background:#060914;border:1px solid var(--line);border-radius:16px;padding:15px;max-height:480px;overflow:auto;color:#dce7ff}.notice{min-height:24px;color:#bff8ff;margin-top:10px}.file-list,.connection-grid{display:flex;flex-wrap:wrap;gap:8px}.file{border:1px solid var(--line);border-radius:10px;padding:7px 9px;color:var(--muted);background:rgba(255,255,255,.04);font-family:ui-monospace,monospace;font-size:12px}.connection-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));margin-top:14px}.connection{border:1px solid var(--line);border-radius:18px;padding:15px;background:rgba(255,255,255,.035)}.connection p{color:var(--muted);font-size:13px;line-height:1.5;margin:9px 0 0}.small{font-size:12px}@media(max-width:980px){.hero,.workspace{grid-template-columns:1fr}.jobs{max-height:none}.timeline{grid-template-columns:repeat(2,1fr)}}@media(max-width:620px){.shell{padding:18px 12px 50px}.timeline{grid-template-columns:1fr}h1{font-size:2.8rem}}
</style>
</head>
<body><main class="shell">
<header class="topbar"><div class="brand"><span class="orb"></span><span>Athena Coder</span></div><nav class="nav"><a href="/">Rotator</a><a href="/athena">Coder</a><a href="/mountainview">MountainView</a><a href="https://spmt.live/docs">SPMT SDK</a><a href="/logs/errors.txt">Error log</a></nav></header>
<section class="hero"><div class="panel"><div class="eyebrow">SPMT engineering bridge</div><h1>Control, inspect, and repair the fleet.</h1><p class="lead">Your existing SPMT/MountainView admin session authorizes this IDE. Browser actions no longer need a second action-token prompt; the gateway attaches server-only credentials after authentication. Codex still works in isolated per-job checkouts, and publishing remains a separate draft-PR action.</p><div class="chips"><span class="chip">SPMT OAuth session</span><span class="chip">Server-side action authorization</span><span class="chip">Isolated Codex workspace</span><span class="chip">Draft PR boundary</span></div><div class="actions" style="margin-top:18px"><a class="button" href="#new-job">New repair job</a><a class="button secondary" href="/">Open rotator controls</a><a class="button secondary" href="https://spmt.live/docs">Open SDK docs</a></div></div>
<div class="panel composer" id="new-job"><div class="section-head"><div><div class="eyebrow">New assignment</div><h2>Send work to Athena</h2></div></div><label>Repository<select id="repo-select"></select></label><label>Describe the problem<textarea id="job-description" placeholder="Example: inspect the StreamWeaver command router, fix the failing route, run checks, and prepare a draft PR."></textarea></label><label>Helpful context<textarea id="job-context" placeholder="Paste an error, route, expected behavior, or acceptance criteria."></textarea></label><button id="submit-job" type="button">Send to Athena</button><div id="composer-status" class="notice"></div></div></section>
<section class="panel" style="margin-bottom:20px"><div class="section-head"><div><div class="eyebrow">SPMT connections</div><h2>SDK, APIs, auth, and worker links</h2></div><button class="secondary" id="refresh-connections">Refresh</button></div><div id="connection-grid" class="connection-grid"></div></section>
<section class="workspace"><aside class="panel"><div class="section-head"><div><div class="eyebrow">Mission queue</div><h2>Recent jobs</h2></div><button class="secondary" id="refresh-jobs">Refresh</button></div><div id="job-list" class="jobs"></div></aside><section class="panel detail" id="job-detail"><div class="muted">Select a job to inspect Athena's work.</div></section></section>
</main><script>
const references=${safeReferences};let jobs=${safeJobs};let connections=${safeConnections};let selectedJobId=jobs[0]?.id||'';let selectedArtifact='';const repoSelect=document.getElementById('repo-select');const list=document.getElementById('job-list');const detail=document.getElementById('job-detail');const composerStatus=document.getElementById('composer-status');
function esc(v){return String(v??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]))}function fmt(v){if(!v)return'n/a';const d=new Date(v);return Number.isNaN(d.getTime())?v:d.toLocaleString()}function repoLabel(id){return references.find(r=>r.id===id)?.label||id}function canPublish(j){return j.status==='completed'&&j.changedFiles?.length&&j.checks?.every(c=>c.ok)}
function renderRepos(){repoSelect.innerHTML=references.map(r=>'<option value="'+esc(r.apps[0]||r.id)+'">'+esc(r.label)+'</option>').join('')}
function renderConnections(){document.getElementById('connection-grid').innerHTML=connections.map(c=>'<article class="connection"><div class="job-head"><strong>'+esc(c.label)+'</strong><span class="status '+esc(c.status)+'">'+esc(c.status)+'</span></div><p>'+esc(c.detail)+'</p>'+(c.href?'<p><a href="'+esc(c.href)+'">Open connection</a></p>':'')+'</article>').join('')}
function renderJobs(){if(!jobs.length){list.innerHTML='<div class="muted">No Athena jobs yet.</div>';detail.innerHTML='<div class="muted">Submit the first job above.</div>';return}if(!selectedJobId||!jobs.some(j=>j.id===selectedJobId))selectedJobId=jobs[0].id;list.innerHTML=jobs.map(j=>'<article class="job '+(j.id===selectedJobId?'active':'')+'" data-id="'+esc(j.id)+'"><div class="job-head"><strong>'+esc(repoLabel(j.repoId))+'</strong><span class="status '+esc(j.status)+'">'+esc(j.status)+'</span></div><p>'+esc(j.description)+'</p><div class="small muted">'+esc(fmt(j.updatedAt))+'</div></article>').join('');list.querySelectorAll('[data-id]').forEach(el=>el.addEventListener('click',()=>{selectedJobId=el.dataset.id;selectedArtifact='';renderJobs();renderDetail()}));renderDetail()}
function renderDetail(){const j=jobs.find(x=>x.id===selectedJobId);if(!j)return;const checks=(j.checks||[]).map(c=>'<div class="step '+(c.ok?'done':'')+'"><strong>'+(c.ok?'Passed':'Failed')+'</strong><div class="small muted">'+esc(c.command)+'</div></div>').join('');detail.innerHTML='<div class="section-head"><div><div class="eyebrow">'+esc(repoLabel(j.repoId))+'</div><h2>'+esc(j.description)+'</h2></div><span class="status '+esc(j.status)+'">'+esc(j.status)+'</span></div><p class="muted">'+esc(j.summary||j.error||'Athena is still working on this assignment.')+'</p><div class="timeline"><div class="step done">Queued</div><div class="step '+(['running','completed','failed'].includes(j.status)?'done':'')+'">Workspace</div><div class="step '+(['completed','failed'].includes(j.status)?'done':'')+'">Checks</div><div class="step '+(j.pullRequest?'done':'')+'">Draft PR</div></div><div class="file-list">'+(j.changedFiles||[]).map(f=>'<span class="file">'+esc(f)+'</span>').join('')+'</div><div class="actions"><button class="secondary" data-artifact="diff">Diff</button><button class="secondary" data-artifact="checks">Checks</button><button class="secondary" data-artifact="response">Codex response</button><button id="publish-job" '+(canPublish(j)?'':'disabled')+'>Create draft PR</button>'+(j.pullRequest?'<a class="button secondary" href="'+esc(j.pullRequest.url)+'">Open PR #'+esc(j.pullRequest.number)+'</a>':'')+'</div><div id="artifact" style="margin-top:14px">'+(selectedArtifact?'<pre>'+esc(selectedArtifact)+'</pre>':'')+'</div>';detail.querySelectorAll('[data-artifact]').forEach(b=>b.addEventListener('click',()=>loadArtifact(j.id,b.dataset.artifact)));document.getElementById('publish-job')?.addEventListener('click',()=>publishJob(j.id))}
async function api(path,options={}){const r=await fetch(path,{...options,headers:{'content-type':'application/json',...(options.headers||{})}});const text=await r.text();if(!r.ok)throw new Error(text||('Request failed '+r.status));try{return JSON.parse(text)}catch{return text}}
async function refreshJobs(){const payload=await api('/api/codex/jobs');jobs=Array.isArray(payload)?payload:(payload.jobs||[]);renderJobs()}
async function loadArtifact(id,name){selectedArtifact=await api('/api/codex/jobs/'+encodeURIComponent(id)+'/'+name);renderDetail()}
async function publishJob(id){if(!confirm('Create a draft pull request for this passing job?'))return;await api('/api/codex/jobs/'+encodeURIComponent(id)+'/publish',{method:'POST',body:'{}'});await refreshJobs()}
document.getElementById('submit-job').addEventListener('click',async()=>{const description=document.getElementById('job-description').value.trim();if(!description){composerStatus.textContent='Describe the repair first.';return}composerStatus.textContent='Creating isolated job...';try{await api('/api/codex/jobs',{method:'POST',body:JSON.stringify({source:'athena-ide',reporter:'Mtman1987',appName:repoSelect.value,description,context:{notes:document.getElementById('job-context').value}})});document.getElementById('job-description').value='';composerStatus.textContent='Job accepted.';setTimeout(refreshJobs,600)}catch(e){composerStatus.textContent=e.message}});document.getElementById('refresh-jobs').addEventListener('click',refreshJobs);document.getElementById('refresh-connections').addEventListener('click',async()=>{connections=await api('/athena/api/connections');renderConnections()});renderRepos();renderConnections();renderJobs();
</script></body></html>`;
}
