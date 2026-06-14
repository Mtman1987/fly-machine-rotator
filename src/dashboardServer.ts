import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { generateFixRecord, StoredErrorEvent } from "./aiFixer.js";
import { loadConfig } from "./config.js";
import { buildFixId, FixRecord, FixStore, getFixStoreFile } from "./fixStore.js";
import { buildFingerprintIgnoreRule, buildPatternIgnoreRule, getIgnoreRulesFile, IgnoreRule, IgnoreRuleStore } from "./ignoreRules.js";
import { buildFixBranchName, ensureRepoDependencies, ensureRepoReady, hasWorkingTreeChanges, pushRepoBranch, runCheckCommands, writeRepoFiles } from "./repoOps.js";
import { getRepoConfigForApp } from "./repoMap.js";
import { executeTrackedRotation } from "./rotationControl.js";
import { getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";
import { upsertUnifiedDiscordReport } from "./unifiedReport.js";

export function startDashboardServer(env: NodeJS.ProcessEnv = process.env) {
  const port = Number(env.PORT ?? env.ROTATOR_DASHBOARD_PORT ?? 8080);
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, env);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`dashboard listening on ${port}`);
  });
  return server;
}

async function routeRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (method === "GET" && url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  if (method === "GET" && url.pathname === "/logs/errors.txt") {
    const history = await readErrorHistory(env);
    response.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": 'attachment; filename="fly-errors-last-24h.txt"'
    });
    response.end(renderLast24HourReport(history));
    return;
  }

  if (method === "GET" && (url.pathname === "/brand/avatar.png" || url.pathname === "/brand/logo.png")) {
    const fileName = url.pathname.endsWith("avatar.png")
      ? "space-mountain-avatar-transparent.png"
      : "space-mountain-logo-transparent.png";
    const asset = await readBrandAsset(fileName);
    response.writeHead(200, {
      "content-type": "image/png",
      "cache-control": "public, max-age=3600"
    });
    response.end(asset);
    return;
  }

  if (method === "POST" && url.pathname === "/actions/rotate") {
    await readBody(request);
    authorizeAction(request, env);
    const results = await executeTrackedRotation([], env, "dashboard");
    await refreshUnifiedReport(env, results);
    return json(response, { ok: true, results: results.length });
  }

  if (method === "POST" && url.pathname === "/actions/errors/clear") {
    await readBody(request);
    authorizeAction(request, env);
    await clearErrorState(env);
    await refreshUnifiedReport(env);
    return json(response, { ok: true });
  }

  if (method === "POST" && url.pathname === "/actions/errors/ignore-fingerprint") {
    await readBody(request);
    authorizeAction(request, env);
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing error id.");
    const result = await ignoreErrorFingerprint(id, env);
    return json(response, { ok: true, message: result.message });
  }

  if (method === "POST" && url.pathname === "/actions/errors/ignore-pattern") {
    await readBody(request);
    authorizeAction(request, env);
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing error id.");
    const result = await ignoreErrorPattern(id, env);
    return json(response, { ok: true, message: result.message });
  }

  if (method === "POST" && url.pathname === "/actions/errors/unignore") {
    await readBody(request);
    authorizeAction(request, env);
    const ruleId = url.searchParams.get("rule");
    if (!ruleId) throw new HttpError(400, "Missing ignore rule id.");
    const result = await removeIgnoreRule(ruleId, env);
    return json(response, { ok: true, message: result.message });
  }

  if (method === "POST" && url.pathname === "/actions/fixes/review-cycle") {
    await readBody(request);
    authorizeAction(request, env);
    const result = await runReviewCycle(env);
    return json(response, { ok: true, message: result.message });
  }

  if (method === "POST" && url.pathname === "/actions/fixes/auto-fix-cycle") {
    await readBody(request);
    authorizeAction(request, env);
    const result = await runAutoFixCycle(env);
    return json(response, { ok: true, message: result.message });
  }

  if (method === "POST" && url.pathname.startsWith("/actions/fixes/")) {
    const body = await readBody(request);
    authorizeAction(request, env);
    const id = url.searchParams.get("id");
    if (!id) throw new HttpError(400, "Missing fix id.");
    const result = await handleFixAction(url.pathname, id, env, body);
    if (url.pathname.endsWith("/handled")) await refreshUnifiedReport(env);
    return json(response, result);
  }

  if (method === "GET" && url.pathname === "/") {
    const html = await renderDashboardHtml(env);
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

async function handleFixAction(pathname: string, id: string, env: NodeJS.ProcessEnv, body = ""): Promise<{ ok: boolean; message: string }> {
  const events = dedupeErrorEvents(pruneLast24Hours(await readErrorHistory(env)));
  const event = events.find((item) => buildFixId(item.appName, item.fingerprint) === id);
  const store = await FixStore.load(getFixStoreFile(env));

  if (pathname.endsWith("/generate")) {
    if (!event) throw new HttpError(404, `Error event ${id} not found.`);
    let record: FixRecord;
    try {
      record = await generateFixRecord(event, env);
    } catch (error) {
      record = {
        id,
        appName: event.appName,
        fingerprint: event.fingerprint,
        status: "error",
        updatedAt: new Date().toISOString(),
        changes: [],
        lastError: error instanceof Error ? error.message : String(error)
      };
    }
    store.upsert(record);
    await store.save();
    return { ok: true, message: record.status === "error" ? `Fix generation failed: ${record.lastError}` : `Generated fix for ${record.appName}.` };
  }

  const existing = store.get(id);
  if (!existing) throw new HttpError(404, `Fix ${id} not found.`);

  if (pathname.endsWith("/save")) {
    const payload = body ? JSON.parse(body) as { changes?: Array<{ path?: string; reason?: string; content?: string }> } : {};
    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    existing.changes = changes
      .filter((change) => typeof change?.path === "string" && typeof change?.reason === "string" && typeof change?.content === "string")
      .map((change) => ({
        path: change.path!,
        reason: change.reason!,
        content: change.content!
      }));
    existing.updatedAt = new Date().toISOString();
    existing.lastError = undefined;
    if (existing.status === "error" && existing.changes.length > 0) {
      existing.status = "generated";
    }
    store.upsert(existing);
    await store.save();
    return { ok: true, message: `Saved ${existing.changes.length} edited file change(s).` };
  }

  if (pathname.endsWith("/apply")) {
    const config = getRepoConfigForApp(existing.appName);
    if (!config) throw new HttpError(400, `No repo mapping for ${existing.appName}.`);
    if (existing.changes.length === 0) throw new HttpError(400, "No file changes available to apply.");
    const repoPath = await ensureRepoReady(config, env);
    await writeRepoFiles(repoPath, existing.changes.map((change) => ({ path: change.path, content: change.content })));
    existing.status = "applied";
    existing.updatedAt = new Date().toISOString();
    existing.lastError = undefined;
    store.upsert(existing);
    await store.save();
    return { ok: true, message: `Applied ${existing.changes.length} file change(s).` };
  }

  if (pathname.endsWith("/check")) {
    const config = getRepoConfigForApp(existing.appName);
    if (!config) throw new HttpError(400, `No repo mapping for ${existing.appName}.`);
    const repoPath = await ensureRepoReady(config, env);
    await ensureRepoDependencies(repoPath, config.installCommand);
    const commandResults = await runCheckCommands(repoPath, config.checkCommands);
    existing.checkResult = {
      ranAt: new Date().toISOString(),
      ok: commandResults.every((result) => result.exitCode === 0),
      commandResults
    };
    existing.status = existing.checkResult.ok ? "checked" : "error";
    existing.updatedAt = new Date().toISOString();
    existing.lastError = existing.checkResult.ok ? undefined : commandResults.find((result) => result.exitCode !== 0)?.output.slice(-4000);
    store.upsert(existing);
    await store.save();
    return { ok: true, message: existing.checkResult.ok ? "Checks passed." : "Checks failed." };
  }

  if (pathname.endsWith("/push")) {
    const config = getRepoConfigForApp(existing.appName);
    if (!config) throw new HttpError(400, `No repo mapping for ${existing.appName}.`);
    const repoPath = await ensureRepoReady(config, env);
    const branch = buildFixBranchName(config, existing.appName, existing.fingerprint);
    const push = await pushRepoBranch(repoPath, branch, `rotator fix: ${existing.appName} ${existing.fingerprint}`, env);
    existing.pushResult = {
      pushedAt: new Date().toISOString(),
      branch: push.branch,
      commit: push.commit,
      output: push.output.slice(-4000)
    };
    existing.status = "pushed";
    existing.updatedAt = new Date().toISOString();
    existing.lastError = undefined;
    store.upsert(existing);
    await store.save();
    return { ok: true, message: `Pushed branch ${push.branch}.` };
  }

  if (pathname.endsWith("/handled")) {
    existing.status = "handled";
    existing.handledAt = new Date().toISOString();
    existing.updatedAt = existing.handledAt;
    store.upsert(existing);
    await store.save();
    await removeFingerprintFromErrorState(existing.fingerprint, env);
    return { ok: true, message: `Marked ${existing.appName} as handled.` };
  }

  throw new HttpError(404, "Unknown fix action.");
}

async function renderDashboardHtml(env: NodeJS.ProcessEnv): Promise<string> {
  const runtime = (await RotatorRuntimeStateStore.load(getRuntimeStateFile(env))).snapshot();
  const rawErrors = pruneLast24Hours(await readErrorHistory(env));
  const ignoreStore = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  const ignoredErrors = rawErrors.filter((event) => ignoreStore.matches(event));
  const errors = dedupeErrorEvents(rawErrors.filter((event) => !ignoreStore.matches(event)));
  const counts = summarizeFailureCounts(rawErrors);
  const actionProtected = Boolean(env.ROTATOR_DASHBOARD_ACTION_TOKEN);
  const dashboardUrl = getDashboardUrl(env);
  const fixStore = await FixStore.load(getFixStoreFile(env));
  const fixesById = new Map(fixStore.list().map((fix) => [fix.id, fix]));
  const fixStatusCounts = summarizeFixStatuses(errors, fixesById);
  const ignoreRules = ignoreStore.list();
  const autoFixEnabled = env.ROTATOR_ENABLE_AUTOFIX === "true";
  const autoFixPushEnabled = env.ROTATOR_AUTOFIX_PUSH === "true";
  const activeCoder = env.EDENAI_API_KEY
    ? `EdenAI ${env.EDENAI_FIX_MODEL ?? "anthropic/claude-sonnet-4-5"}`
    : env.OPENAI_API_KEY
      ? `OpenAI ${env.OPENAI_FIX_MODEL ?? "gpt-4.1-mini"}`
      : env.GEMINI_API_KEY
        ? `Gemini ${env.GEMINI_FIX_MODEL ?? "gemini-2.5-flash"}`
        : "No AI provider configured";
  const latestRunLines = runtime.lastRunLines.join("\n") || "No rotation output recorded yet.";
  const statusTone = runtime.currentStatus === "failed"
    ? "status-bad"
    : runtime.currentStatus === "running"
      ? "status-warn"
      : runtime.currentStatus === "success"
        ? "status-good"
        : "status-idle";
  const metricCards = [
    {
      label: "Run state",
      value: runtime.currentStatus,
      detail: runtime.lastTrigger ? `trigger ${runtime.lastTrigger}` : "awaiting next command",
    },
    {
      label: "Next window",
      value: formatDashboardTimestamp(runtime.nextRunAt),
      detail: runtime.nextRunAt ? "scheduler armed" : "not scheduled yet",
    },
    {
      label: "Review targets",
      value: String(errors.length),
      detail: errors.length > 0 ? "fix cards waiting below" : "queue is clear",
    },
    {
      label: "Hidden noise",
      value: String(ignoredErrors.length),
      detail: ignoreRules.length > 0 ? `${ignoreRules.length} active ignore rules` : "no ignore rules yet",
    }
  ].map((item) => `
        <article class="metric-card">
          <div class="eyebrow">${escapeHtml(item.label)}</div>
          <div class="metric-value">${escapeHtml(item.value)}</div>
          <p class="muted small">${escapeHtml(item.detail)}</p>
        </article>
      `).join("");
  const providerChips = [
    `${activeCoder}`,
    `Eden ${env.EDENAI_API_KEY ? "ready" : "missing"}`,
    `OpenAI ${env.OPENAI_API_KEY ? "ready" : "missing"}`,
    `Gemini ${env.GEMINI_API_KEY ? "ready" : "missing"}`,
    `GitHub ${env.GITHUB_TOKEN ? "ready" : "missing"}`
  ].map((item) => `<span class="chip">${escapeHtml(item)}</span>`).join("");
  const perAppRows = counts.length === 0
    ? '<div class="muted">No current errors.</div>'
    : counts.map(([appName, count]) => `
          <div class="data-row">
            <span>${escapeHtml(appName)}</span>
            <strong>${count}</strong>
          </div>
        `).join("");
  const runtimeRows = [
    ["Trigger", runtime.lastTrigger ?? "n/a"],
    ["Started", formatDashboardTimestamp(runtime.lastStartedAt)],
    ["Finished", formatDashboardTimestamp(runtime.lastFinishedAt)],
    ["Duration", formatDuration(runtime.lastDurationMs)],
    ["Next run", formatDashboardTimestamp(runtime.nextRunAt)],
  ].map(([label, value]) => `
          <div class="data-row">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(value)}</strong>
          </div>
        `).join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fly Rotator Dashboard</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #070812;
      --panel: #111425;
      --panel-ghost: rgba(17, 20, 37, .82);
      --panel2: #171b31;
      --ink: #f8fafc;
      --muted: #a8b0c3;
      --accent: #8b5cf6;
      --accent-2: #22d3ee;
      --danger: #fb7185;
      --border: rgba(255,255,255,.12);
      --shadow: 0 22px 65px rgba(0, 0, 0, .34);
      --warm: rgba(255,255,255,.05);
      --good: #34d399;
      --warn: #fbbf24;
      --bad: #fb7185;
    }
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    html, body {
      min-height: 100%;
      font-family: Inter, Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(34,211,238,.13), transparent 28%),
        radial-gradient(circle at top right, rgba(139,92,246,.18), transparent 26%),
        var(--bg);
      color: var(--ink);
    }
    body {
      overflow-x: hidden;
    }
    a {
      color: #c4b5fd;
      text-decoration: none;
    }
    .app-shell {
      position: relative;
      z-index: 2;
      max-width: 1400px;
      margin: 0 auto;
      padding: 32px 20px 72px;
    }
    .topbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 20px;
      margin-bottom: 28px;
      flex-wrap: wrap;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 20px;
      font-weight: 800;
    }
    .orb {
      width: 42px;
      height: 42px;
      border-radius: 12px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 32px rgba(34, 211, 238, .28);
    }
    .nav {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
    }
    .nav a {
      color: white;
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
    }
    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(320px, .9fr);
      gap: 24px;
      margin-bottom: 24px;
    }
    .panel {
      background: rgba(255,255,255,.05);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 24px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(12px);
    }
    .card {
      border-radius: 24px;
      padding: 28px;
      border: 1px solid var(--border);
      background:
        linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.03)),
        rgba(255,255,255,.05);
      backdrop-filter: blur(12px);
      box-shadow: var(--shadow);
    }
    h1, h2, h3 { margin: 0; }
    h1 { font-size: clamp(2.6rem, 4.8vw, 4.8rem); line-height: .96; margin-bottom: 14px; }
    h2 { font-size: 1.2rem; }
    p, li, code, pre, button, input, textarea { font-size: 15px; }
    .eyebrow {
      text-transform: uppercase;
      letter-spacing: .16em;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 10px;
    }
    .lead {
      color: var(--muted);
      max-width: 65ch;
      line-height: 1.6;
    }
    .hero-note {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 16px;
      border: 1px dashed rgba(34,211,238,.35);
      background: rgba(34,211,238,.08);
      color: #d9fafe;
    }
    .hero-actions, .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 16px;
    }
    .overview-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 18px;
      margin-top: 24px;
    }
    .metric-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 18px;
    }
    .metric-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      background: rgba(255,255,255,.04);
    }
    .metric-value {
      font-size: 28px;
      font-weight: 800;
      margin-bottom: 6px;
    }
    .signal-board {
      display: grid;
      gap: 12px;
    }
    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 7px 12px;
      border-radius: 999px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .14em;
      border: 1px solid var(--border);
      margin-bottom: 16px;
    }
    .status-good { background: rgba(52,211,153,.16); color: #86efac; }
    .status-warn { background: rgba(251,191,36,.16); color: #fde68a; }
    .status-bad { background: rgba(251,113,133,.16); color: #fda4af; }
    .status-idle { background: rgba(168,176,195,.12); color: #d8dee9; }
    .muted { color: var(--muted); }
    .section-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: end;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    .section-copy {
      max-width: 72ch;
      line-height: 1.55;
    }
    .run-lines, .code-box, .check-box {
      white-space: pre-wrap;
      word-break: break-word;
      background: var(--warm);
      border-radius: 16px;
      padding: 14px;
      border: 1px solid var(--border);
    }
    button, .link-btn {
      appearance: none;
      border: 0;
      border-radius: 999px;
      padding: 11px 16px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: #fff;
      cursor: pointer;
      text-decoration: none;
      font-weight: 700;
    }
    button.secondary, .link-btn.secondary {
      background: rgba(255,255,255,.05);
      color: var(--ink);
      border: 1px solid var(--border);
    }
    button.danger { background: var(--danger); }
    input[type="password"], input[type="text"] {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--border);
      padding: 10px 12px;
      background: rgba(255,255,255,.05);
      color: var(--ink);
    }
    .control-grid, .two-col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
      margin-top: 14px;
    }
    .chips {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: rgba(255,255,255,.05);
      color: var(--muted);
      font-size: 13px;
    }
    textarea {
      width: 100%;
      min-height: 280px;
      border-radius: 16px;
      border: 1px solid var(--border);
      padding: 12px;
      background: rgba(6, 9, 18, .86);
      color: var(--ink);
      font-family: Consolas, "Courier New", monospace;
      resize: vertical;
    }
    .data-list {
      display: grid;
      gap: 10px;
    }
    .data-row {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 0;
      border-bottom: 1px solid var(--border);
      align-items: start;
    }
    .data-row:last-child { border-bottom: none; padding-bottom: 0; }
    .data-row strong { text-align: right; }
    .feature-list {
      display: grid;
      gap: 12px;
      margin-top: 18px;
    }
    .feature-row {
      display: grid;
      grid-template-columns: 18px 1fr;
      gap: 12px;
      color: var(--muted);
      line-height: 1.5;
    }
    .feature-row::before {
      content: "";
      width: 10px;
      height: 10px;
      margin-top: 6px;
      border-radius: 50%;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: 0 0 14px rgba(34, 211, 238, .35);
    }
    .summary-strip {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .summary-card {
      border: 1px solid var(--border);
      border-radius: 18px;
      padding: 16px;
      background: rgba(255,255,255,.04);
    }
    .summary-card strong {
      display: block;
      font-size: 24px;
      margin-bottom: 8px;
    }
    .fix-grid { display: grid; gap: 16px; }
    .fix-card {
      border: 1px solid var(--border);
      border-radius: 22px;
      padding: 20px;
      background:
        linear-gradient(180deg, rgba(23,27,49,.92), rgba(17,20,37,.88)),
        rgba(255,255,255,.05);
      box-shadow: var(--shadow);
    }
    .fix-head { display: flex; justify-content: space-between; gap: 14px; align-items: start; }
    .fix-meta { color: var(--muted); font-size: 13px; margin-top: 6px; }
    .badge {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 999px;
      background: rgba(34,211,238,.12);
      color: #bcfcff;
      border: 1px solid rgba(34,211,238,.2);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .08em;
    }
    .status-line { margin-top: 10px; color: var(--muted); min-height: 1.4em; }
    .small { font-size: 13px; }
    .star-field, .star-field-2, .star-field-3 {
      position: fixed;
      inset: 0;
      z-index: 0;
      pointer-events: none;
    }
    .star-field {
      background-image: radial-gradient(white 1px, transparent 1px);
      background-size: 70px 70px;
      animation: twinkle 5s infinite alternate;
      opacity: .3;
    }
    .star-field-2 {
      background-image: radial-gradient(cyan 1px, transparent 1px);
      background-size: 110px 110px;
      animation: twinkle 8s infinite alternate-reverse;
      opacity: .22;
    }
    .star-field-3 {
      background-image: radial-gradient(violet 1px, transparent 1px);
      background-size: 160px 160px;
      animation: drift 30s linear infinite;
      opacity: .2;
    }
    @keyframes twinkle {
      from { opacity: .18; }
      to { opacity: .62; }
    }
    @keyframes drift {
      from { transform: translateY(0); }
      to { transform: translateY(120px); }
    }
    @media (max-width: 1100px) {
      .hero, .overview-grid {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 720px) {
      .app-shell { padding: 24px 16px 56px; }
      .metric-strip, .summary-strip {
        grid-template-columns: 1fr;
      }
      h1 { font-size: 2.5rem; }
    }
  </style>
</head>
<body>
  <div class="star-field"></div>
  <div class="star-field-2"></div>
  <div class="star-field-3"></div>
  <main class="app-shell">
    <header class="topbar">
      <div class="logo">
        <div class="orb"></div>
        <span>Fly Machine Rotator</span>
      </div>
      <nav class="nav">
        <a href="#ops">Ops Deck</a>
        <a href="#fixes">Fix Queue</a>
        <a href="#noise">Noise Filters</a>
        <a href="/logs/errors.txt">Download Logs</a>
      </nav>
    </header>

    <section class="hero">
      <div class="card">
        <div class="eyebrow">Shared Cosmic Shell</div>
        <h1>Rotator observatory.</h1>
        <p class="lead">One place for the active rotation cycle, the current 24-hour failure picture, and the reviewable AI fixes that can turn those failures into repo-ready patches.</p>
        <div class="hero-note">Discord now only needs the dashboard link. The log download stays here, the review targets stay here, and the app keeps the same star-field language as the rest of the suite without losing its own control-room identity.</div>
        <div class="hero-actions">
          <a class="link-btn" href="${escapeHtml(dashboardUrl)}">Open public dashboard URL</a>
          <a class="link-btn secondary" href="/logs/errors.txt">Download 24h error log</a>
        </div>
        <div class="feature-list">
          <div class="feature-row">Run a rotation, refresh the Discord report, and inspect the latest machine handoffs from one screen.</div>
          <div class="feature-row">Generate, edit, apply, check, and push AI-authored fixes per app without leaving the dashboard.</div>
          <div class="feature-row">Silence known-noisy errors with fingerprint or pattern rules so the review queue stays honest.</div>
        </div>
      </div>

      <aside class="panel signal-board">
        <div class="eyebrow">Live signal board</div>
        <div class="status-pill ${statusTone}">${escapeHtml(runtime.currentStatus)}</div>
        <p class="lead section-copy">Public URL: <a href="${escapeHtml(dashboardUrl)}">${escapeHtml(dashboardUrl)}</a></p>
        <div class="metric-strip">
          ${metricCards}
        </div>
      </aside>
    </section>

    <section class="overview-grid" id="ops">
      <section class="panel">
        <div class="section-head">
          <div>
            <div class="eyebrow">Rotation telemetry</div>
            <h2>Run timing and cadence</h2>
          </div>
          <strong>${runtime.totalRuns}</strong>
        </div>
        <p class="muted section-copy">This panel keeps the operator-facing timing view readable even when the raw runtime state is sparse after a deploy or restart.</p>
        <div class="data-list">
          ${runtimeRows}
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <div class="eyebrow">Error constellation</div>
            <h2>24-hour app totals</h2>
          </div>
          <strong>${errors.length}</strong>
        </div>
        <p class="muted section-copy">Unique app and fingerprint groups still in play${ignoredErrors.length > 0 ? `, with ${ignoredErrors.length} already hidden by ignore rules` : "."}</p>
        <div class="data-list">
          ${perAppRows}
        </div>
        <div class="hero-actions">
          <a class="link-btn secondary" href="/logs/errors.txt">Download logs</a>
        </div>
      </section>

      <section class="panel">
        <div class="section-head">
          <div>
            <div class="eyebrow">Control deck</div>
            <h2>Run and review</h2>
          </div>
        </div>
        <div class="run-lines">${escapeHtml(latestRunLines)}</div>
        ${runtime.lastError ? `<p class="muted" style="color: var(--danger); margin-top: 12px;">${escapeHtml(runtime.lastError)}</p>` : ""}
        <div class="control-grid">
          <div>
            <label class="eyebrow" for="action-token">Action token</label>
            <input id="action-token" type="password" placeholder="${actionProtected ? "Required for mutating actions" : "Optional; actions are open"}" />
          </div>
          <div>
            <div class="eyebrow">Coder and credentials</div>
            <div class="chips">${providerChips}</div>
          </div>
        </div>
        <div class="actions">
          <button type="button" onclick="runAction('/actions/rotate')">Run rotation now</button>
          <button type="button" class="secondary" onclick="runAction('/actions/fixes/review-cycle')">Run AI review cycle</button>
          <button type="button" class="secondary" onclick="runAction('/actions/fixes/auto-fix-cycle')" ${autoFixEnabled ? "" : "disabled"}>Run auto-fix cycle</button>
          <button type="button" class="danger" onclick="runAction('/actions/errors/clear')">Clear current errors</button>
        </div>
        <div class="small muted" style="margin-top: 10px;">
          Auto-fix execution: ${autoFixEnabled ? "enabled" : "disabled"}${autoFixEnabled ? ` • push ${autoFixPushEnabled ? "enabled" : "disabled"}` : ""}
        </div>
        <div id="action-status" class="status-line"></div>
      </section>
    </section>

    <section class="panel" style="margin-top: 18px;" id="fixes">
      <div class="section-head">
        <div>
          <div class="eyebrow">AI Fix Queue</div>
          <h2>Review targets and proposed patches</h2>
        </div>
        <p class="muted small">Current review targets: ${errors.length}</p>
      </div>
      <p class="muted section-copy">Each card below is meant to move from diagnosis to editable patch to checked repo change. The dashboard keeps the raw error, the AI take, and the review station together so the final apply decision stays operator-controlled.</p>
      <div class="summary-strip">
        <div class="summary-card">
          <div class="eyebrow">Pipeline progress</div>
          <strong>${fixStatusCounts.generated}</strong>
          <div class="muted small">generated • ${fixStatusCounts.applied} applied • ${fixStatusCounts.checked} checked • ${fixStatusCounts.pushed} pushed</div>
        </div>
        <div class="summary-card">
          <div class="eyebrow">Queue health</div>
          <strong>${errors.length}</strong>
          <div class="muted small">${fixStatusCounts.new} new • ${fixStatusCounts.error} errored • ${fixStatusCounts.handled} handled</div>
        </div>
      </div>
      <div class="fix-grid">
        ${errors.length === 0 ? '<div class="muted">No current error groups to review.</div>' : errors.map((event) => renderFixCard(event, fixesById.get(buildFixId(event.appName, event.fingerprint)))).join("")}
      </div>
    </section>

    <section class="panel" style="margin-top: 18px;" id="noise">
      <div class="section-head">
        <div>
          <div class="eyebrow">Noise Filters</div>
          <h2>Ignore rules</h2>
        </div>
      </div>
      <p class="muted section-copy">Use fingerprint rules for one exact recurring event. Use app-plus-pattern rules when a whole family of already-understood errors should stay out of the live review queue.</p>
      <div class="summary-strip">
        <div class="summary-card">
          <div class="eyebrow">Active rules</div>
          <strong>${ignoreRules.length}</strong>
          <div class="muted small">Hidden current events: ${ignoredErrors.length}</div>
        </div>
        <div class="summary-card">
          <div class="eyebrow">Rule behavior</div>
          <strong>Scoped suppression</strong>
          <div class="muted small">Fingerprint hides one exact event. Pattern hides future matching app messages.</div>
        </div>
      </div>
      <div class="fix-grid">
        ${ignoreRules.length === 0 ? '<div class="muted">No ignore rules saved.</div>' : ignoreRules.map((rule) => renderIgnoreRule(rule)).join("")}
      </div>
    </section>
  </main>
  <script>
    const tokenInput = document.getElementById('action-token');
    const actionStatus = document.getElementById('action-status');
    const stored = localStorage.getItem('rotatorActionToken');
    if (stored) tokenInput.value = stored;
    tokenInput.addEventListener('change', () => localStorage.setItem('rotatorActionToken', tokenInput.value));

    async function runAction(path, label) {
      actionStatus.textContent = (label || 'Working') + '...';
      actionStatus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try {
        localStorage.setItem('rotatorActionToken', tokenInput.value);
        const response = await fetch(path, {
          method: 'POST',
          headers: tokenInput.value ? { 'x-rotator-action-token': tokenInput.value } : {}
        });
        const text = await response.text();
        if (!response.ok) throw new Error(text || ('Request failed with ' + response.status));
        const payload = text ? JSON.parse(text) : { ok: true };
        actionStatus.textContent = payload.message || 'Complete. Reloading...';
        window.setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        actionStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function runFixAction(action, id) {
      return runAction('/actions/fixes/' + action + '?id=' + encodeURIComponent(id), 'Running ' + action);
    }

    async function saveFixEdits(id) {
      const card = document.querySelector('[data-fix-id="' + CSS.escape(id) + '"]');
      if (!card) {
        actionStatus.textContent = 'Could not find fix editor for ' + id;
        return;
      }
      const textareas = card.querySelectorAll('textarea[id^="change-content-"]');
      const changes = Array.from(textareas).map((textarea, index) => {
        const pathInput = card.querySelector('#change-path-' + CSS.escape(id) + '-' + index);
        const reasonInput = card.querySelector('#change-reason-' + CSS.escape(id) + '-' + index);
        return {
          path: pathInput ? pathInput.value : '',
          reason: reasonInput ? reasonInput.value : '',
          content: textarea.value
        };
      });
      actionStatus.textContent = 'Saving edits...';
      actionStatus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      try {
        localStorage.setItem('rotatorActionToken', tokenInput.value);
        const response = await fetch('/actions/fixes/save?id=' + encodeURIComponent(id), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(tokenInput.value ? { 'x-rotator-action-token': tokenInput.value } : {})
          },
          body: JSON.stringify({ changes })
        });
        const text = await response.text();
        if (!response.ok) throw new Error(text || ('Request failed with ' + response.status));
        const payload = text ? JSON.parse(text) : { ok: true };
        actionStatus.textContent = payload.message || 'Saved edits. Reloading...';
        window.setTimeout(() => window.location.reload(), 900);
      } catch (error) {
        actionStatus.textContent = error instanceof Error ? error.message : String(error);
      }
    }

    function runErrorAction(action, id) {
      return runAction('/actions/errors/' + action + '?id=' + encodeURIComponent(id), 'Running ' + action);
    }

    function runRuleAction(ruleId) {
      return runAction('/actions/errors/unignore?rule=' + encodeURIComponent(ruleId), 'Removing ignore rule');
    }
  </script>
</body>
</html>`;
}

function renderFixCard(event: StoredErrorEvent, fix: FixRecord | undefined): string {
  const repo = getRepoConfigForApp(event.appName);
  const id = buildFixId(event.appName, event.fingerprint);
  const changes = fix?.changes.map((change) => `${change.path} - ${change.reason}`).join("\n");
  const checkText = fix?.checkResult
    ? fix.checkResult.commandResults.map((result) => `$ ${result.command}\n(exit ${result.exitCode})\n${result.output.slice(-2000)}`).join("\n\n")
    : "";
  const pushText = fix?.pushResult
    ? `Branch: ${fix.pushResult.branch}\nCommit: ${fix.pushResult.commit}\n${fix.pushResult.output.slice(-1500)}`
    : "";

  const hasChanges = Boolean(fix && fix.changes.length > 0);
  const hasAppliedChanges = Boolean(fix && (fix.status === "applied" || fix.status === "checked" || fix.status === "pushed"));
  const reviewStation = fix?.changes.length
    ? fix.changes.map((change, index) => `
        <div>
          <div class="eyebrow">File ${index + 1}</div>
          <div class="code-box">Path: ${escapeHtml(change.path)}\nReason: ${escapeHtml(change.reason)}</div>
          <div class="small muted" style="margin: 8px 0 6px;">Edit the path, reason, or file content before applying.</div>
          <input id="change-path-${escapeHtml(id)}-${index}" type="text" value="${escapeAttribute(change.path)}" style="width:100%; margin-bottom:8px; border-radius:12px; border:1px solid var(--border); padding:10px 12px; background:rgba(255,255,255,.05); color:var(--ink);" />
          <input id="change-reason-${escapeHtml(id)}-${index}" type="text" value="${escapeAttribute(change.reason)}" style="width:100%; margin-bottom:8px; border-radius:12px; border:1px solid var(--border); padding:10px 12px; background:rgba(255,255,255,.05); color:var(--ink);" />
          <textarea id="change-content-${escapeHtml(id)}-${index}">${escapeHtml(change.content)}</textarea>
        </div>
      `).join("")
    : "";

  return `<article class="fix-card" data-fix-id="${escapeAttribute(id)}">
    <div class="fix-head">
      <div>
        <h2>${escapeHtml(event.appName)}</h2>
        <div class="fix-meta">fingerprint <code>${escapeHtml(event.fingerprint)}</code> • ${escapeHtml(event.timestamp ?? event.recordedAt)}</div>
        <div class="fix-meta">${escapeHtml(repo ? repo.label : "No repo mapping")} ${repo ? `• ${escapeHtml(repo.repoUrl)}` : ""}</div>
      </div>
      <div class="badge">${escapeHtml(fix?.status ?? "new")}</div>
    </div>
    <div class="two-col">
      <div>
        <div class="eyebrow">Error</div>
        <div class="code-box">${escapeHtml(event.message)}</div>
      </div>
      <div>
        <div class="eyebrow">Current Suggestion</div>
        <div class="code-box">${escapeHtml(event.suggestion)}</div>
      </div>
    </div>
    <div class="actions">
      <button type="button" onclick="runFixAction('generate', '${escapeHtml(id)}')">${fix ? "Refresh fix" : "Generate fix"}</button>
      <button type="button" class="secondary" onclick="saveFixEdits('${escapeHtml(id)}')" ${hasChanges ? "" : "disabled"}>Save edits</button>
      <button type="button" class="secondary" onclick="runFixAction('apply', '${escapeHtml(id)}')" ${hasChanges ? "" : "disabled"}>Apply patch</button>
      <button type="button" class="secondary" onclick="runFixAction('check', '${escapeHtml(id)}')" ${hasAppliedChanges ? "" : "disabled"}>Run checks</button>
      <button type="button" class="secondary" onclick="runFixAction('push', '${escapeHtml(id)}')" ${fix?.checkResult?.ok ? "" : "disabled"}>Push branch</button>
      <button type="button" class="secondary" onclick="runErrorAction('ignore-fingerprint', '${escapeHtml(id)}')">Ignore fingerprint</button>
      <button type="button" class="secondary" onclick="runErrorAction('ignore-pattern', '${escapeHtml(id)}')">Ignore app + pattern</button>
      <button type="button" class="danger" onclick="runFixAction('handled', '${escapeHtml(id)}')">Mark handled</button>
    </div>
    ${fix ? `
      <div class="stack">
        <div>
          <div class="eyebrow">AI Summary</div>
          <div class="code-box">${escapeHtml(fix.summary ?? "No summary stored.")}</div>
        </div>
        <div>
          <div class="eyebrow">Diagnosis</div>
          <div class="code-box">${escapeHtml(fix.diagnosis ?? "No diagnosis stored.")}</div>
        </div>
        <div>
          <div class="eyebrow">Proposed File Changes${fix.confidence ? ` • ${escapeHtml(fix.confidence)} confidence` : ""}</div>
          <div class="code-box">${escapeHtml(changes || "No file changes proposed.")}</div>
        </div>
        ${reviewStation ? `
          <div>
            <div class="eyebrow">Review Station</div>
            <div class="stack">${reviewStation}</div>
          </div>
        ` : ""}
        ${fix.checkResult ? `
          <div>
            <div class="eyebrow">Check Output</div>
            <div class="check-box">${escapeHtml(checkText)}</div>
          </div>
        ` : ""}
        ${fix.pushResult ? `
          <div>
            <div class="eyebrow">Push Result</div>
            <div class="check-box">${escapeHtml(pushText)}</div>
          </div>
        ` : ""}
        ${fix.lastError ? `
          <div>
            <div class="eyebrow">Last Error</div>
            <div class="check-box">${escapeHtml(fix.lastError)}</div>
          </div>
        ` : ""}
      </div>
    ` : ""}
  </article>`;
}

function renderIgnoreRule(rule: IgnoreRule): string {
  const detail = rule.kind === "fingerprint"
    ? `${rule.appName ?? "any app"} • fingerprint ${rule.fingerprint ?? "n/a"}`
    : `${rule.appName ?? "any app"} • /${rule.pattern ?? ""}/i`;

  return `<article class="fix-card">
    <div class="fix-head">
      <div>
        <h2>${escapeHtml(rule.kind === "fingerprint" ? "Ignore fingerprint" : "Ignore app + pattern")}</h2>
        <div class="fix-meta">${escapeHtml(detail)}</div>
        <div class="fix-meta">${escapeHtml(rule.note ?? "No note")}</div>
      </div>
      <div class="badge">active</div>
    </div>
    <div class="actions">
      <button type="button" class="danger" onclick="runRuleAction('${escapeHtml(rule.id)}')">Re-enable matching errors</button>
    </div>
  </article>`;
}

function authorizeAction(request: IncomingMessage, env: NodeJS.ProcessEnv): void {
  const expected = env.ROTATOR_DASHBOARD_ACTION_TOKEN;
  if (!expected) return;
  const provided = request.headers["x-rotator-action-token"];
  if (provided !== expected) {
    throw new HttpError(401, "Unauthorized action token.");
  }
}

async function refreshUnifiedReport(env: NodeJS.ProcessEnv, latestRotationResults?: Parameters<typeof upsertUnifiedDiscordReport>[1]): Promise<void> {
  const config = loadConfig([], env);
  await upsertUnifiedDiscordReport(config.discordWebhookUrl, latestRotationResults);
}

async function ignoreErrorFingerprint(id: string, env: NodeJS.ProcessEnv): Promise<{ message: string }> {
  const event = await findErrorEventById(id, env);
  const store = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  store.add(buildFingerprintIgnoreRule(event));
  await store.save();
  await removeFingerprintFromErrorState(event.fingerprint, env);
  return { message: `Ignoring fingerprint ${event.fingerprint} for ${event.appName}.` };
}

async function ignoreErrorPattern(id: string, env: NodeJS.ProcessEnv): Promise<{ message: string }> {
  const event = await findErrorEventById(id, env);
  const store = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  store.add(buildPatternIgnoreRule(event));
  await store.save();
  await removeMatchingIgnoredEvents(env, store);
  return { message: `Ignoring matching ${event.appName} errors by message pattern.` };
}

async function removeIgnoreRule(ruleId: string, env: NodeJS.ProcessEnv): Promise<{ message: string }> {
  const store = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  if (!store.remove(ruleId)) throw new HttpError(404, `Ignore rule ${ruleId} not found.`);
  await store.save();
  return { message: `Removed ignore rule ${ruleId}.` };
}

async function runReviewCycle(env: NodeJS.ProcessEnv): Promise<{ message: string }> {
  const results = await executeTrackedRotation([], env, "dashboard-review");
  await refreshUnifiedReport(env, results);
  const generated = await generateFixesForCurrentErrors(env);
  return {
    message: `Review cycle complete. rotation=${formatRotationSummary(results)} fixes generated=${generated.generated} failed=${generated.failed}.`
  };
}

async function runAutoFixCycle(env: NodeJS.ProcessEnv): Promise<{ message: string }> {
  if (env.ROTATOR_ENABLE_AUTOFIX !== "true") {
    throw new HttpError(400, "Set ROTATOR_ENABLE_AUTOFIX=true to enable the auto-fix cycle.");
  }

  const review = await runReviewCycle(env);
  const store = await FixStore.load(getFixStoreFile(env));
  const ignoreStore = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  const currentEvents = dedupeErrorEvents(pruneLast24Hours(await readErrorHistory(env))).filter((event) => !ignoreStore.matches(event));
  let applied = 0;
  let checked = 0;
  let pushed = 0;
  let failed = 0;

  for (const event of currentEvents) {
    const record = store.get(buildFixId(event.appName, event.fingerprint));
    if (!record || record.changes.length === 0) {
      failed += 1;
      continue;
    }

    const config = getRepoConfigForApp(record.appName);
    if (!config) {
      record.status = "error";
      record.updatedAt = new Date().toISOString();
      record.lastError = `No repo mapping for ${record.appName}.`;
      store.upsert(record);
      failed += 1;
      continue;
    }

    try {
      const repoPath = await ensureRepoReady(config, env);
      await writeRepoFiles(repoPath, record.changes.map((change) => ({ path: change.path, content: change.content })));
      record.status = "applied";
      record.updatedAt = new Date().toISOString();
      record.lastError = undefined;
      applied += 1;

      await ensureRepoDependencies(repoPath, config.installCommand);
      const commandResults = await runCheckCommands(repoPath, config.checkCommands);
      record.checkResult = {
        ranAt: new Date().toISOString(),
        ok: commandResults.every((result) => result.exitCode === 0),
        commandResults
      };
      record.status = record.checkResult.ok ? "checked" : "error";
      record.updatedAt = new Date().toISOString();
      record.lastError = record.checkResult.ok ? undefined : commandResults.find((result) => result.exitCode !== 0)?.output.slice(-4000);
      if (record.checkResult.ok) {
        checked += 1;
      } else {
        failed += 1;
      }

      if (record.checkResult.ok && env.ROTATOR_AUTOFIX_PUSH === "true" && await hasWorkingTreeChanges(repoPath)) {
        const branch = buildFixBranchName(config, record.appName, record.fingerprint);
        const push = await pushRepoBranch(repoPath, branch, `rotator fix: ${record.appName} ${record.fingerprint}`, env);
        record.pushResult = {
          pushedAt: new Date().toISOString(),
          branch: push.branch,
          commit: push.commit,
          output: push.output.slice(-4000)
        };
        record.status = "pushed";
        record.updatedAt = new Date().toISOString();
        pushed += 1;
      }
    } catch (error) {
      record.status = "error";
      record.updatedAt = new Date().toISOString();
      record.lastError = error instanceof Error ? error.message : String(error);
      failed += 1;
    }

    store.upsert(record);
    await store.save();
  }

  return {
    message: `${review.message} auto-fix applied=${applied} checked=${checked} pushed=${pushed} failed=${failed}.`
  };
}

async function generateFixesForCurrentErrors(env: NodeJS.ProcessEnv): Promise<{ generated: number; failed: number }> {
  const store = await FixStore.load(getFixStoreFile(env));
  const ignoreStore = await IgnoreRuleStore.load(getIgnoreRulesFile(env));
  const events = dedupeErrorEvents(pruneLast24Hours(await readErrorHistory(env))).filter((event) => !ignoreStore.matches(event));
  let generated = 0;
  let failed = 0;

  for (const event of events) {
    try {
      const record = await generateFixRecord(event, env);
      store.upsert(record);
      if (record.status === "error") failed += 1;
      else generated += 1;
    } catch (error) {
      store.upsert({
        id: buildFixId(event.appName, event.fingerprint),
        appName: event.appName,
        fingerprint: event.fingerprint,
        status: "error",
        updatedAt: new Date().toISOString(),
        changes: [],
        lastError: error instanceof Error ? error.message : String(error)
      });
      failed += 1;
    }
  }

  await store.save();
  return { generated, failed };
}

async function clearErrorState(env: NodeJS.ProcessEnv): Promise<void> {
  const files = [
    env.LOG_ERROR_DEDUPE_FILE ?? "/data/error-fingerprints.json",
    env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json"
  ];
  for (const file of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "[]");
  }
}

async function removeMatchingIgnoredEvents(env: NodeJS.ProcessEnv, ignoreStore: IgnoreRuleStore): Promise<void> {
  const historyFile = env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json";
  const history = (await readErrorHistory(env)).filter((event) => !ignoreStore.matches(event));
  await writeFile(historyFile, JSON.stringify(history, null, 2));
}

async function removeFingerprintFromErrorState(fingerprint: string, env: NodeJS.ProcessEnv): Promise<void> {
  const historyFile = env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json";
  const dedupeFile = env.LOG_ERROR_DEDUPE_FILE ?? "/data/error-fingerprints.json";
  const history = (await readErrorHistory(env)).filter((event) => event.fingerprint !== fingerprint);
  await writeFile(historyFile, JSON.stringify(history, null, 2));

  try {
    const values = JSON.parse(await readFile(dedupeFile, "utf8")) as string[];
    await writeFile(dedupeFile, JSON.stringify((Array.isArray(values) ? values : []).filter((value) => value !== fingerprint), null, 2));
  } catch {
    await writeFile(dedupeFile, "[]");
  }
}

async function readErrorHistory(env: NodeJS.ProcessEnv): Promise<StoredErrorEvent[]> {
  const historyFile = env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json";
  try {
    const parsed = JSON.parse(await readFile(historyFile, "utf8")) as StoredErrorEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function findErrorEventById(id: string, env: NodeJS.ProcessEnv): Promise<StoredErrorEvent> {
  const events = dedupeErrorEvents(pruneLast24Hours(await readErrorHistory(env)));
  const event = events.find((item) => buildFixId(item.appName, item.fingerprint) === id);
  if (!event) throw new HttpError(404, `Error event ${id} not found.`);
  return event;
}

function dedupeErrorEvents(events: StoredErrorEvent[]): StoredErrorEvent[] {
  const seen = new Set<string>();
  const values: StoredErrorEvent[] = [];
  for (const event of [...events].reverse()) {
    const id = buildFixId(event.appName, event.fingerprint);
    if (seen.has(id)) continue;
    seen.add(id);
    values.push(event);
  }
  return values.sort((left, right) => (right.timestamp ?? right.recordedAt).localeCompare(left.timestamp ?? left.recordedAt));
}

function pruneLast24Hours(events: StoredErrorEvent[]): StoredErrorEvent[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return events.filter((event) => Date.parse(event.recordedAt) >= cutoff);
}

function summarizeFailureCounts(events: StoredErrorEvent[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const event of events) counts.set(event.appName, (counts.get(event.appName) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function summarizeFixStatuses(events: StoredErrorEvent[], fixesById: Map<string, FixRecord>): Record<string, number> {
  const counts = {
    new: 0,
    generated: 0,
    applied: 0,
    checked: 0,
    pushed: 0,
    handled: 0,
    error: 0
  };

  for (const event of events) {
    const status = fixesById.get(buildFixId(event.appName, event.fingerprint))?.status ?? "new";
    counts[status] += 1;
  }

  return counts;
}

function renderLast24HourReport(events: StoredErrorEvent[]): string {
  const pruned = pruneLast24Hours(events);
  const lines = [
    "Fly Log Monitor - errors from the last 24 hours",
    `Generated: ${new Date().toISOString()}`,
    `Count: ${pruned.length}`,
    ""
  ];
  for (const event of pruned) {
    lines.push("=".repeat(80));
    lines.push(`${event.recordedAt} ${event.appName} ${event.fingerprint}`);
    lines.push(`machine=${event.machineId ?? "unknown"} region=${event.region ?? "unknown"} log_time=${event.timestamp ?? "unknown"}`);
    lines.push(`error: ${event.message}`);
    lines.push(`suggestion: ${event.suggestion}`);
    lines.push("recent logs:");
    lines.push(...event.context.map((line) => `  ${line}`));
    lines.push("");
  }
  return lines.join("\n").slice(-900_000);
}

function getDashboardUrl(env: NodeJS.ProcessEnv): string {
  return env.PUBLIC_DASHBOARD_URL ?? `https://${env.FLY_APP_NAME ?? "mtman-machine-rotator"}.fly.dev/`;
}

function formatDashboardTimestamp(value: string | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(date).replace(",", "") + " UTC";
}

function formatDuration(value: number | undefined): string {
  if (!value || value < 0) return "n/a";
  if (value < 1000) return `${value}ms`;
  const seconds = Math.round(value / 100) / 10;
  return `${seconds}s`;
}

function formatRotationSummary(results: Array<{ success: boolean; previousActiveId?: string; newActiveId?: string }>): string {
  const ok = results.filter((result) => result.success).length;
  const failed = results.length - ok;
  const handoffs = results.filter((result) => result.previousActiveId && result.newActiveId && result.previousActiveId !== result.newActiveId).length;
  const restarts = results.filter((result) => result.previousActiveId && result.newActiveId && result.previousActiveId === result.newActiveId).length;
  return `ok=${ok} failed=${failed} handoffs=${handoffs} restarts=${restarts}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", "&#39;");
}

function json(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

async function readBrandAsset(fileName: string): Promise<Buffer> {
  return readFile(join(process.cwd(), "assets", fileName));
}
