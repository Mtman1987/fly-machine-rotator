import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { hasMountainViewAdminSession } from "./mountainView.js";
import { listCodeReferences, listCodexJobs, type PublicCodexJob } from "./publicCodexFixer.js";

export function startAthenaCoderGateway(
  env: NodeJS.ProcessEnv = process.env,
  internalPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT || 8081),
  publicPort = Number(env.PORT || env.ROTATOR_DASHBOARD_PORT || 8080),
) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
      if (request.method === "GET" && (url.pathname === "/athena" || url.pathname === "/coder")) {
        if (!(await hasMountainViewAdminSession(request, env))) {
          const next = encodeURIComponent(url.pathname + url.search);
          response.writeHead(302, { location: `/mountainview/auth/login?next=${next}`, "cache-control": "no-store" });
          response.end();
          return;
        }
        const [jobs, references] = await Promise.all([listCodexJobs(env, 40), listCodeReferences(env)]);
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        });
        response.end(renderAthenaCoderHtml(jobs, references));
        return;
      }

      await proxyToDashboard(request, response, env, internalPort);
    } catch (error) {
      console.error("Athena Coder gateway request failed", error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  server.listen(publicPort, "0.0.0.0", () => {
    console.log(`Athena Coder gateway listening on ${publicPort}; Rotator dashboard is internal on ${internalPort}`);
  });
  return server;
}

async function proxyToDashboard(
  incoming: IncomingMessage,
  outgoing: ServerResponse,
  env: NodeJS.ProcessEnv,
  internalPort: number,
) {
  const url = new URL(incoming.url || "/", `http://${incoming.headers.host || "localhost"}`);
  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${internalPort}` };
  const isCodexWrite = url.pathname.startsWith("/api/codex/") && incoming.method !== "GET" && incoming.method !== "HEAD";
  if (isCodexWrite && await hasMountainViewAdminSession(incoming, env)) {
    const workerSecret = String(env.CODEX_WORKER_SECRET || "").trim();
    if (workerSecret) headers["x-codex-worker-secret"] = workerSecret;
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

function renderAthenaCoderHtml(jobs: PublicCodexJob[], references: CodeReference[]) {
  const safeJobs = JSON.stringify(jobs).replaceAll("<", "\\u003c");
  const safeReferences = JSON.stringify(references).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Athena Coder</title>
  <style>
    :root { color-scheme: dark; --bg:#050712; --panel:#11162a; --panel2:#171d36; --line:rgba(255,255,255,.12); --ink:#f8fafc; --muted:#aeb8cf; --violet:#8b5cf6; --cyan:#22d3ee; --good:#34d399; --warn:#fbbf24; --bad:#fb7185; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); font-family:Inter,ui-sans-serif,system-ui,sans-serif; background:radial-gradient(circle at 12% 0%,rgba(34,211,238,.13),transparent 28%),radial-gradient(circle at 90% 0%,rgba(139,92,246,.18),transparent 30%),var(--bg); }
    body:before { content:""; position:fixed; inset:0; pointer-events:none; opacity:.22; background-image:radial-gradient(white 1px,transparent 1px); background-size:72px 72px; }
    a { color:#c4b5fd; }
    button,select,textarea,input { font:inherit; }
    button { border:0; border-radius:999px; padding:11px 16px; font-weight:800; cursor:pointer; color:white; background:linear-gradient(135deg,var(--violet),var(--cyan)); }
    button.secondary { background:rgba(255,255,255,.06); border:1px solid var(--line); }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .shell { position:relative; z-index:1; max-width:1500px; margin:auto; padding:26px 20px 70px; }
    .topbar,.row,.job-head,.section-head { display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap; }
    .brand { display:flex; align-items:center; gap:12px; font-weight:900; font-size:20px; }
    .orb { width:42px; height:42px; border-radius:14px; background:linear-gradient(135deg,var(--violet),var(--cyan)); box-shadow:0 0 30px rgba(34,211,238,.35); }
    .nav { display:flex; gap:9px; flex-wrap:wrap; }
    .nav a { text-decoration:none; color:white; border:1px solid var(--line); background:rgba(255,255,255,.05); border-radius:999px; padding:9px 13px; }
    .hero { display:grid; grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr); gap:20px; margin:26px 0 20px; }
    .panel { background:linear-gradient(180deg,rgba(23,29,54,.9),rgba(12,16,32,.9)); border:1px solid var(--line); border-radius:24px; padding:22px; box-shadow:0 22px 70px rgba(0,0,0,.35); backdrop-filter:blur(12px); }
    h1 { font-size:clamp(2.7rem,5.8vw,5.7rem); line-height:.93; margin:8px 0 16px; }
    h2,h3,p { margin-top:0; }
    .eyebrow { text-transform:uppercase; letter-spacing:.18em; font-size:11px; color:var(--muted); }
    .lead { color:var(--muted); line-height:1.65; max-width:70ch; }
    .chips,.actions { display:flex; gap:8px; flex-wrap:wrap; }
    .chip,.status { border:1px solid var(--line); border-radius:999px; padding:7px 11px; color:var(--muted); background:rgba(255,255,255,.04); font-size:12px; }
    .status.completed { color:#86efac; background:rgba(52,211,153,.13); }
    .status.failed { color:#fda4af; background:rgba(251,113,133,.13); }
    .status.running,.status.queued { color:#fde68a; background:rgba(251,191,36,.13); }
    .composer { display:grid; gap:12px; }
    label { display:grid; gap:7px; color:var(--muted); font-size:13px; }
    select,textarea,input { width:100%; color:var(--ink); background:rgba(4,7,18,.85); border:1px solid var(--line); border-radius:14px; padding:12px; }
    textarea { min-height:165px; resize:vertical; }
    .stats { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; margin-top:16px; }
    .stat { border:1px solid var(--line); border-radius:18px; padding:15px; background:rgba(255,255,255,.04); }
    .stat strong { display:block; font-size:28px; margin-top:6px; }
    .workspace { display:grid; grid-template-columns:minmax(320px,.82fr) minmax(0,1.18fr); gap:20px; }
    .jobs { display:grid; gap:12px; max-height:960px; overflow:auto; padding-right:3px; }
    .job { border:1px solid var(--line); border-radius:19px; padding:16px; background:rgba(255,255,255,.035); cursor:pointer; }
    .job.active { border-color:rgba(34,211,238,.55); box-shadow:0 0 0 2px rgba(34,211,238,.08); }
    .job p { color:var(--muted); line-height:1.45; margin:10px 0 0; }
    .muted { color:var(--muted); }
    .small { font-size:12px; }
    .detail { min-height:600px; }
    .timeline { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin:16px 0; }
    .step { border:1px solid var(--line); border-radius:15px; padding:12px; background:rgba(255,255,255,.035); }
    .step.done { border-color:rgba(52,211,153,.42); }
    .artifact { margin-top:14px; }
    pre { white-space:pre-wrap; word-break:break-word; background:#060914; border:1px solid var(--line); border-radius:16px; padding:15px; max-height:470px; overflow:auto; color:#dce7ff; }
    .notice { min-height:24px; color:#bff8ff; margin-top:10px; }
    .file-list { display:flex; flex-wrap:wrap; gap:7px; margin:12px 0; }
    .file { border:1px solid var(--line); border-radius:10px; padding:7px 9px; color:var(--muted); background:rgba(255,255,255,.04); font-family:ui-monospace,monospace; font-size:12px; }
    @media(max-width:980px){ .hero,.workspace{grid-template-columns:1fr}.jobs{max-height:none}.timeline{grid-template-columns:repeat(2,1fr)} }
    @media(max-width:620px){ .shell{padding:20px 14px 55px}.stats,.timeline{grid-template-columns:1fr}h1{font-size:2.8rem} }
  </style>
</head>
<body>
<main class="shell">
  <header class="topbar">
    <div class="brand"><span class="orb"></span><span>Athena Coder</span></div>
    <nav class="nav"><a href="/">Rotator</a><a href="/mountainview">MountainView</a><a href="/logs/errors.txt">Error log</a></nav>
  </header>

  <section class="hero">
    <div class="panel">
      <div class="eyebrow">SPMT engineering bridge</div>
      <h1>Tell Athena what needs fixing.</h1>
      <p class="lead">Athena creates a private isolated checkout, gives Codex only that workspace, runs the repository checks, and keeps GitHub publication as a separate owner action. Your existing SPMT admin session authorizes this screen—there is no second action-token prompt.</p>
      <div class="chips"><span class="chip">Restricted network</span><span class="chip">Per-job workspace</span><span class="chip">Pre-publish validation</span><span class="chip">Draft PR boundary</span></div>
      <div class="stats"><div class="stat"><span class="eyebrow">Jobs retained</span><strong id="job-count">${jobs.length}</strong></div><div class="stat"><span class="eyebrow">Repositories</span><strong>${references.length}</strong></div></div>
    </div>
    <div class="panel composer">
      <div class="section-head"><div><div class="eyebrow">New assignment</div><h2>Start a repair job</h2></div></div>
      <label>Repository<select id="repo-select"></select></label>
      <label>Describe the problem<textarea id="job-description" placeholder="Example: Finish the Athena Coder UI so an authenticated admin can submit jobs, inspect progress and artifacts, and publish a passing job as a draft PR."></textarea></label>
      <label>Helpful context (optional)<textarea id="job-context" placeholder="Paste an error, expected behavior, route, file name, or acceptance criteria."></textarea></label>
      <button id="submit-job" type="button">Send to Athena</button>
      <div id="composer-status" class="notice"></div>
    </div>
  </section>

  <section class="workspace">
    <aside class="panel"><div class="section-head"><div><div class="eyebrow">Mission queue</div><h2>Recent jobs</h2></div><button class="secondary" id="refresh-jobs">Refresh</button></div><div id="job-list" class="jobs"></div></aside>
    <section class="panel detail" id="job-detail"><div class="muted">Select a job to inspect Athena's work.</div></section>
  </section>
</main>
<script>
  const references = ${safeReferences};
  let jobs = ${safeJobs};
  let selectedJobId = jobs[0] ? jobs[0].id : '';
  let selectedArtifact = '';
  const repoSelect = document.getElementById('repo-select');
  const list = document.getElementById('job-list');
  const detail = document.getElementById('job-detail');
  const composerStatus = document.getElementById('composer-status');

  function escapeHtml(value) { return String(value == null ? '' : value).replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[ch])); }
  function fmt(value) { if (!value) return 'n/a'; const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString(); }
  function repoLabel(id) { const ref = references.find(item => item.id === id); return ref ? ref.label : id; }
  function canPublish(job) { return job.status === 'completed' && job.changedFiles && job.changedFiles.length > 0 && job.checks && job.checks.every(check => check.ok); }

  function renderRepos() {
    repoSelect.innerHTML = references.map(ref => '<option value="' + escapeHtml(ref.apps[0] || ref.id) + '">' + escapeHtml(ref.label) + '</option>').join('');
  }

  function renderJobs() {
    document.getElementById('job-count').textContent = String(jobs.length);
    if (!jobs.length) { list.innerHTML = '<div class="muted">No Athena jobs yet.</div>'; detail.innerHTML = '<div class="muted">Submit the first job above.</div>'; return; }
    if (!selectedJobId || !jobs.some(job => job.id === selectedJobId)) selectedJobId = jobs[0].id;
    list.innerHTML = jobs.map(job => '<article class="job ' + (job.id === selectedJobId ? 'active' : '') + '" data-job-id="' + escapeHtml(job.id) + '"><div class="job-head"><strong>' + escapeHtml(repoLabel(job.repoId)) + '</strong><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(job.status) + '</span></div><p>' + escapeHtml(job.description) + '</p><div class="small muted" style="margin-top:10px">' + escapeHtml(fmt(job.updatedAt)) + '</div></article>').join('');
    list.querySelectorAll('[data-job-id]').forEach(card => card.addEventListener('click', () => { selectedJobId = card.dataset.jobId; selectedArtifact = ''; renderJobs(); renderDetail(); }));
    renderDetail();
  }

  function renderDetail() {
    const job = jobs.find(item => item.id === selectedJobId);
    if (!job) return;
    const files = (job.changedFiles || []).map(path => '<span class="file">' + escapeHtml(path) + '</span>').join('') || '<span class="muted">No changed files recorded yet.</span>';
    const checkPass = job.checks && job.checks.length ? job.checks.filter(check => check.ok).length + '/' + job.checks.length + ' passed' : 'waiting';
    const steps = [
      ['Assigned', true], ['Sandbox', job.status !== 'queued'], ['Checks', job.status === 'completed' || job.status === 'failed'], ['Draft PR', Boolean(job.pullRequest)]
    ].map(step => '<div class="step ' + (step[1] ? 'done' : '') + '"><div class="eyebrow">' + step[0] + '</div><strong>' + (step[1] ? 'Ready' : 'Waiting') + '</strong></div>').join('');
    detail.innerHTML = '<div class="section-head"><div><div class="eyebrow">' + escapeHtml(repoLabel(job.repoId)) + '</div><h2>' + escapeHtml(job.description) + '</h2></div><span class="status ' + escapeHtml(job.status) + '">' + escapeHtml(job.status) + '</span></div>' +
      '<p class="muted">Created ' + escapeHtml(fmt(job.createdAt)) + ' · Updated ' + escapeHtml(fmt(job.updatedAt)) + '</p>' +
      '<div class="timeline">' + steps + '</div>' +
      '<div class="file-list">' + files + '</div>' +
      '<div class="chips"><span class="chip">Checks: ' + escapeHtml(checkPass) + '</span>' + (job.threadId ? '<span class="chip">Thread retained</span>' : '') + (job.pullRequest ? '<a class="chip" target="_blank" rel="noreferrer" href="' + escapeHtml(job.pullRequest.url) + '">PR #' + escapeHtml(job.pullRequest.number) + '</a>' : '') + '</div>' +
      '<div class="actions" style="margin-top:16px"><button class="secondary" data-artifact="response">Athena response</button><button class="secondary" data-artifact="diff">Diff</button><button class="secondary" data-artifact="checks">Checks</button><button id="publish-job" ' + (canPublish(job) && !job.pullRequest ? '' : 'disabled') + '>' + (job.pullRequest ? 'Draft PR opened' : 'Publish draft PR') + '</button></div>' +
      '<div id="detail-status" class="notice"></div><div id="artifact-view" class="artifact">' + (selectedArtifact ? '<pre>' + escapeHtml(selectedArtifact) + '</pre>' : '<p class="muted">Choose an artifact to inspect the completed work.</p>') + '</div>' +
      (job.error ? '<pre>' + escapeHtml(job.error) + '</pre>' : '') + (job.summary ? '<pre>' + escapeHtml(job.summary) + '</pre>' : '');
    detail.querySelectorAll('[data-artifact]').forEach(button => button.addEventListener('click', () => loadArtifact(job.id, button.dataset.artifact)));
    const publish = document.getElementById('publish-job'); if (publish) publish.addEventListener('click', () => publishJob(job.id));
  }

  async function submitJob() {
    const description = document.getElementById('job-description').value.trim();
    const contextText = document.getElementById('job-context').value.trim();
    if (!description) { composerStatus.textContent = 'Describe the repair first.'; return; }
    composerStatus.textContent = 'Athena is opening an isolated workspace...';
    try {
      const response = await fetch('/api/codex/jobs', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ source:'athena-coder-ui', reporter:'SPMT owner', appName:repoSelect.value, description, context:contextText ? { notes:contextText } : {} }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Job submission failed.');
      jobs.unshift(payload.job); selectedJobId = payload.job.id; document.getElementById('job-description').value = ''; document.getElementById('job-context').value = ''; composerStatus.textContent = 'Job accepted. Athena is working.'; renderJobs();
    } catch (error) { composerStatus.textContent = error instanceof Error ? error.message : String(error); }
  }

  async function refreshSelected() {
    if (!selectedJobId) return;
    try {
      const response = await fetch('/api/codex/jobs/' + encodeURIComponent(selectedJobId), { cache:'no-store' });
      if (!response.ok) return;
      const updated = await response.json(); const index = jobs.findIndex(job => job.id === updated.id); if (index >= 0) jobs[index] = updated; else jobs.unshift(updated); renderJobs();
    } catch { }
  }

  async function loadArtifact(id, kind) {
    const status = document.getElementById('detail-status'); status.textContent = 'Loading ' + kind + '...';
    try { const response = await fetch('/api/codex/jobs/' + encodeURIComponent(id) + '/' + kind, { cache:'no-store' }); const text = await response.text(); if (!response.ok) throw new Error(text || 'Artifact unavailable.'); selectedArtifact = text; status.textContent = ''; renderDetail(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }

  async function publishJob(id) {
    const status = document.getElementById('detail-status'); status.textContent = 'Publishing the validated branch and opening a draft PR...';
    try { const response = await fetch('/api/codex/jobs/' + encodeURIComponent(id) + '/publish', { method:'POST', headers:{'content-type':'application/json'}, body:'{}' }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'Publish failed.'); status.textContent = 'Draft PR opened.'; await refreshSelected(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
  }

  renderRepos(); renderJobs();
  document.getElementById('submit-job').addEventListener('click', submitJob);
  document.getElementById('refresh-jobs').addEventListener('click', refreshSelected);
  window.setInterval(() => { const job = jobs.find(item => item.id === selectedJobId); if (job && (job.status === 'queued' || job.status === 'running')) refreshSelected(); }, 3500);
</script>
</body>
</html>`;
}
