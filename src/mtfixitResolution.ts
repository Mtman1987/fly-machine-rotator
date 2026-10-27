import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listRepoConfigs } from "./repoMap.js";

type CodexJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  source: string;
  reporter: string;
  reporterId?: string;
  tenantId?: string;
  appName: string;
  repoId: string;
  description: string;
  summary?: string;
  changedFiles: string[];
  checks: Array<{ command: string; ok: boolean; output: string }>;
  error?: string;
  pullRequest?: { number: number; url: string; branch: string; commit: string };
};

type KnownFix = {
  signature: string;
  patchHash: string;
  incidentFingerprint?: string;
  repoId: string;
  normalizedReport: string;
  learnedAt: string;
  sourceJobId: string;
  pullRequestNumber: number;
  mergeCommit: string;
  successfulDeploys: number;
};

export type MtFixItResolutionState = {
  schemaVersion: "mtfixit.resolution/v1";
  jobId: string;
  status: "awaiting_analysis" | "awaiting_approval" | "deploying" | "deployed" | "failed" | "denied" | "no_change";
  updatedAt: string;
  signature?: string;
  patchHash?: string;
  knownFix?: boolean;
  message?: string;
  approvedAt?: string;
  deniedAt?: string;
  pullRequest?: { number: number; url: string; branch: string; commit: string };
  mergeCommit?: string;
  workflow?: { id: number; name: string; status: string; conclusion?: string | null; url?: string };
  feedback?: string;
  incidentFingerprint?: string;
  confidencePercent?: number;
};

type ResolutionAction = "resolve" | "approve" | "deny" | "pass" | "fail";
const RESOLUTION_ROUTE = /^\/api\/dsh\/mtfixit\/jobs\/([a-zA-Z0-9_-]{8,100})\/resolution$/;
const MAX_BODY = 16 * 1024;
const VERIFY_INTERVAL_MS = 10_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
const WORKFLOW_DISCOVERY_GRACE_MS = 90_000;
const activeDeployments = new Set<string>();

function fixerRoot(env: NodeJS.ProcessEnv) { return String(env.CODEX_FIXER_DATA_DIR || "/data/codex-fixer").trim(); }
function resolutionDir(env: NodeJS.ProcessEnv) { return String(env.MTFIXIT_RESOLUTION_DIR || "/data/codex-fixer/mtfixit-resolution").trim(); }
function knownFixFile(env: NodeJS.ProcessEnv) { return String(env.MTFIXIT_KNOWN_FIXES_FILE || "/data/codex-fixer/known-fixes.json").trim(); }
function resolutionFile(env: NodeJS.ProcessEnv, jobId: string) { return `${resolutionDir(env)}/${jobId}.json`; }
function safeText(value: unknown, max = 5000) {
  return String(value ?? "").replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]").replace(/\b(?:sk-|github_pat_)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]").slice(0, max);
}
function normalizedReport(description: string) {
  const report = String(description || "").split(/\n\nAthena diagnostic evidence/i)[0] || description;
  return report.toLowerCase().replace(/["'`]/g, "").replace(/\s+/g, " ").trim().slice(0, 1200);
}
export function mtFixItKnownFixSignature(job: Pick<CodexJob, "repoId" | "description">) {
  return createHash("sha256").update(`${String(job.repoId || "unknown").trim().toLowerCase()}\n${normalizedReport(job.description)}`).digest("hex");
}
async function jobPatchHash(env: NodeJS.ProcessEnv, jobId: string): Promise<string> {
  try {
    const patch = await readFile(`${fixerRoot(env)}/jobs/${jobId}/diff.patch`);
    return patch.length ? createHash("sha256").update(patch).digest("hex") : "";
  } catch {
    return "";
  }
}
async function readJsonFile<T>(file: string, fallback: T): Promise<T> { try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; } }
async function saveResolution(env: NodeJS.ProcessEnv, state: MtFixItResolutionState) {
  const file = resolutionFile(env, state.jobId); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}
export async function readMtFixItResolution(env: NodeJS.ProcessEnv, jobId: string) { return readJsonFile<MtFixItResolutionState | null>(resolutionFile(env, jobId), null); }
async function listKnownFixes(env: NodeJS.ProcessEnv) { const values = await readJsonFile<KnownFix[]>(knownFixFile(env), []); return Array.isArray(values) ? values : []; }
async function saveKnownFixes(env: NodeJS.ProcessEnv, values: KnownFix[]) { const file = knownFixFile(env); await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(values.slice(-500), null, 2), "utf8"); }
async function rememberKnownFix(env: NodeJS.ProcessEnv, job: CodexJob, state: MtFixItResolutionState) {
  if (!state.signature || !state.pullRequest || !state.mergeCommit || !state.patchHash) return;
  const values = await listKnownFixes(env);
  const existing = values.find((item) => item.signature === state.signature && item.patchHash === state.patchHash);
  const next: KnownFix = {
    signature: state.signature,
    patchHash: state.patchHash,
    incidentFingerprint: state.incidentFingerprint,
    repoId: job.repoId,
    normalizedReport: normalizedReport(job.description),
    learnedAt: new Date().toISOString(),
    sourceJobId: job.id,
    pullRequestNumber: state.pullRequest.number,
    mergeCommit: state.mergeCommit,
    successfulDeploys: (existing?.successfulDeploys || 0) + 1,
  };
  await saveKnownFixes(env, [...values.filter((item) => !(item.signature === state.signature && item.patchHash === state.patchHash)), next]);
}

async function workerRequest(env: NodeJS.ProcessEnv, dashboardPort: number, path: string, init: RequestInit = {}) {
  const secret = String(env.CODEX_WORKER_SECRET || "").trim(); if (!secret) throw new Error("CODEX_WORKER_SECRET is not configured");
  const response = await fetch(`http://127.0.0.1:${dashboardPort}${path}`, { ...init, headers: { accept: "application/json", "x-codex-worker-secret": secret, ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null) as any; if (!response.ok) throw new Error(payload?.error || `Coder worker HTTP ${response.status}`); return payload;
}
async function readJob(env: NodeJS.ProcessEnv, dashboardPort: number, jobId: string): Promise<CodexJob> {
  const payload = await workerRequest(env, dashboardPort, `/api/codex/jobs/${encodeURIComponent(jobId)}`); if (!payload?.id) throw new Error("Coder job was not found"); return payload as CodexJob;
}
function repoSlug(job: CodexJob) { const repo = listRepoConfigs().find((item) => item.id === job.repoId); if (!repo) throw new Error(`Unknown repository ${job.repoId}`); return new URL(repo.repoUrl).pathname.replace(/^\//, "").replace(/\.git$/, ""); }
function githubToken(env: NodeJS.ProcessEnv) { const token = String(env.GITHUB_TOKEN || "").trim(); if (!token) throw new Error("GITHUB_TOKEN is not configured"); return token; }
async function githubRequest(env: NodeJS.ProcessEnv, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, { ...init, headers: { accept: "application/vnd.github+json", authorization: `Bearer ${githubToken(env)}`, "content-type": "application/json", "user-agent": "spmt-mtfixit-resolution", "x-github-api-version": "2022-11-28", ...(init.headers || {}) }, signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null) as any; if (!response.ok) throw new Error(payload?.message || `GitHub HTTP ${response.status}`); return payload;
}
async function githubGraphql(env: NodeJS.ProcessEnv, query: string, variables: Record<string, unknown>) {
  const response = await fetch("https://api.github.com/graphql", { method: "POST", headers: { accept: "application/json", authorization: `Bearer ${githubToken(env)}`, "content-type": "application/json", "user-agent": "spmt-mtfixit-resolution" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.message || `GitHub GraphQL HTTP ${response.status}`);
  if (Array.isArray(payload?.errors) && payload.errors.length) throw new Error(payload.errors.map((item: any) => String(item?.message || "GraphQL error")).join("; "));
  return payload?.data;
}
async function ensurePublished(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number) {
  if (job.pullRequest) return job.pullRequest;
  const payload = await workerRequest(env, dashboardPort, `/api/codex/jobs/${encodeURIComponent(job.id)}/publish`, { method: "POST" });
  if (!payload?.pullRequest?.number) throw new Error("Athena could not publish a repair pull request"); return payload.pullRequest as NonNullable<CodexJob["pullRequest"]>;
}
async function markReady(repo: string, pullNumber: number, env: NodeJS.ProcessEnv) {
  const pull = await githubRequest(env, `/repos/${repo}/pulls/${pullNumber}`) as { node_id?: string; draft?: boolean };
  if (!pull.draft) return;
  const pullRequestId = String(pull.node_id || "").trim(); if (!pullRequestId) throw new Error("GitHub did not return the pull request node ID required for approval.");
  await githubGraphql(env, `mutation MarkReady($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { id isDraft } } }`, { pullRequestId });
}
async function mergePullRequest(repo: string, pullNumber: number, env: NodeJS.ProcessEnv) {
  return githubRequest(env, `/repos/${repo}/pulls/${pullNumber}/merge`, { method: "PUT", body: JSON.stringify({ merge_method: "squash" }) }) as Promise<{ merged?: boolean; sha?: string; message?: string }>;
}
async function workflowRuns(repo: string, sha: string, env: NodeJS.ProcessEnv) { const payload = await githubRequest(env, `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`); return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs as any[] : []; }
async function verifyDeployment(repo: string, sha: string, env: NodeJS.ProcessEnv, state: MtFixItResolutionState) {
  const started = Date.now();
  while (Date.now() - started < VERIFY_TIMEOUT_MS) {
    const runs = await workflowRuns(repo, sha, env).catch(() => [] as any[]);
    const meaningful = runs.filter((run) => !/retain newest merged branch backup/i.test(String(run.name || "")));
    if (meaningful.length) {
      const failed = meaningful.find((run) => run.status === "completed" && run.conclusion && !["success", "neutral", "skipped"].includes(String(run.conclusion)));
      const pending = meaningful.find((run) => run.status !== "completed"); const selected = failed || pending || meaningful[0];
      state.workflow = { id: Number(selected.id || 0), name: String(selected.name || "GitHub Actions"), status: String(selected.status || "unknown"), conclusion: selected.conclusion ?? null, url: String(selected.html_url || "") };
      state.updatedAt = new Date().toISOString(); await saveResolution(env, state);
      if (failed) throw new Error(`Deployment workflow failed: ${failed.name || failed.id} (${failed.conclusion})`);
      if (!pending && meaningful.every((run) => ["success", "neutral", "skipped"].includes(String(run.conclusion || "")))) return;
    } else if (Date.now() - started >= WORKFLOW_DISCOVERY_GRACE_MS) throw new Error("No deployment workflow was discovered for the merged repair commit.");
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  throw new Error("Deployment verification timed out.");
}

async function waitForPullRequestChecks(repo: string, pullNumber: number, env: NodeJS.ProcessEnv) {
  const started = Date.now();
  let discovered = false;
  while (Date.now() - started < VERIFY_TIMEOUT_MS) {
    const pull = await githubRequest(env, `/repos/${repo}/pulls/${pullNumber}`) as { head?: { sha?: string } };
    const sha = String(pull.head?.sha || "").trim();
    if (!sha) throw new Error("Repair pull request has no head commit SHA.");
    const [checksPayload, statusPayload] = await Promise.all([
      githubRequest(env, `/repos/${repo}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`),
      githubRequest(env, `/repos/${repo}/commits/${encodeURIComponent(sha)}/status`),
    ]);
    const checks = Array.isArray(checksPayload?.check_runs) ? checksPayload.check_runs as any[] : [];
    const statuses = Array.isArray(statusPayload?.statuses) ? statusPayload.statuses as any[] : [];
    if (checks.length || statuses.length) {
      discovered = true;
      const failedCheck = checks.find((check) => check.status === "completed" && !["success", "neutral", "skipped"].includes(String(check.conclusion || "")));
      const failedStatus = statuses.find((status) => !["success"].includes(String(status.state || "")));
      if (failedCheck) throw new Error(`Repair PR check failed: ${failedCheck.name || failedCheck.id} (${failedCheck.conclusion || failedCheck.status}).`);
      if (failedStatus) throw new Error(`Repair PR status check failed: ${failedStatus.context || failedStatus.id} (${failedStatus.state}).`);
      const checksPending = checks.some((check) => check.status !== "completed");
      const statusesPending = statuses.some((status) => !["success"].includes(String(status.state || "")));
      if (!checksPending && !statusesPending && checks.every((check) => ["success", "neutral", "skipped"].includes(String(check.conclusion || ""))) && statuses.every((status) => status.state === "success")) return;
    } else if (Date.now() - started >= WORKFLOW_DISCOVERY_GRACE_MS) {
      throw new Error("No GitHub PR checks/statuses were discovered; refusing to merge an unverified repair.");
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  throw new Error(discovered ? "Repair PR checks did not finish within the verification timeout." : "No GitHub PR checks were discovered before timeout.");
}

async function notifyOwnerForLiveFeedback(job: CodexJob, state: MtFixItResolutionState, env: NodeJS.ProcessEnv) {
  const key = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
  if (!key) return;
  const base = String(env.DSH_BASE_URL || "https://discord-stream-hub-new.fly.dev").replace(/\/$/, "");
  const report = [
    "Athena deployed a repair. Please test the live app.",
    `App: ${job.appName}`,
    `Job: ${job.id}`,
    `Summary: ${job.summary || state.message || "Deployment checks passed"}`,
    `Files: ${job.changedFiles.join(", ") || "none listed"}`,
    `Deployment: ${state.workflow?.url || "workflow verified"}`,
    "Choose PASS only if your live test confirms the issue is fixed. Choose FAIL if it still fails."
  ].join("\n");
  try {
    await fetch(`${base}/api/internal/owner-dm`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: report.slice(0, 1800),
        fileName: "athena-live-verification.txt",
        fileContent: JSON.stringify({ job, resolution: state }, null, 2).slice(0, 120000),
        buttons: [
          { label: "PASS — Fixed", customId: `mtfixit_pass:${job.id}`, style: 3 },
          { label: "FAIL — Still broken", customId: `mtfixit_fail:${job.id}`, style: 4 }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    console.error("Athena live-verification DM failed");
  }
}

async function recordResolutionFailureCycle(job: CodexJob, state: MtFixItResolutionState, env: NodeJS.ProcessEnv, summary: string) {
  const cyclesPath = String(env.HOURLY_REPAIR_CYCLES_FILE || "/data/hourly-repair-cycles.json");
  const cycles = await readJsonFile<any[]>(cyclesPath, []);
  const fingerprint = state.incidentFingerprint || job.description.match(/Incident fingerprint:\s*([a-zA-Z0-9:_-]+)/i)?.[1] || state.signature || mtFixItKnownFixSignature(job);
  const now = new Date().toISOString();
  cycles.push({ id: `resolution-fail-${job.id}-${Date.now()}`, startedAt: now, finishedAt: now, status: "failed", appName: job.appName, fingerprint, summary: safeText(`Athena confidence: ${state.confidencePercent ?? "not reported"}%; ${summary}`, 2000) });
  await mkdir(dirname(cyclesPath), { recursive: true });
  await writeFile(cyclesPath, JSON.stringify(cycles.slice(-500), null, 2), "utf8");
}

async function deployInBackground(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number, state: MtFixItResolutionState) {
  if (activeDeployments.has(job.id)) return; activeDeployments.add(job.id);
  try {
    const pullRequest = await ensurePublished(job, env, dashboardPort); const repo = repoSlug(job);
    state.pullRequest = pullRequest; state.status = "deploying"; state.message = `Athena published PR #${pullRequest.number}; waiting for pull-request checks before merge.`; state.updatedAt = new Date().toISOString(); await saveResolution(env, state);
    await waitForPullRequestChecks(repo, pullRequest.number, env);
    await markReady(repo, pullRequest.number, env);
    const merged = await mergePullRequest(repo, pullRequest.number, env); if (!merged?.merged || !merged.sha) throw new Error(merged?.message || "GitHub did not merge the repair pull request");
    state.mergeCommit = String(merged.sha); state.updatedAt = new Date().toISOString(); await saveResolution(env, state);
    await verifyDeployment(repo, state.mergeCommit, env, state);
    state.status = "deployed"; state.message = "Fix merged and deployment checks completed successfully; awaiting owner live-test PASS/FAIL."; state.updatedAt = new Date().toISOString(); await saveResolution(env, state); await notifyOwnerForLiveFeedback(job, state, env);
  } catch (error) {
    state.status = "failed"; state.message = safeText(error instanceof Error ? error.message : error, 1200); state.updatedAt = new Date().toISOString(); await saveResolution(env, state); await recordResolutionFailureCycle(job, state, env, state.message);
  } finally { activeDeployments.delete(job.id); }
}

async function resolveJob(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<MtFixItResolutionState> {
  const signature = mtFixItKnownFixSignature(job);
  const incidentFingerprint = job.description.match(/Incident fingerprint:\s*([a-zA-Z0-9:_-]+)/i)?.[1];
  if (job.status === "failed") { const state: MtFixItResolutionState = { schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "failed", updatedAt: new Date().toISOString(), signature, message: safeText(job.error || job.summary || "Athena could not produce a fix.") }; await saveResolution(env, state); return state; }
  if (job.status !== "completed") return (await readMtFixItResolution(env, job.id)) || { schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "awaiting_analysis", updatedAt: new Date().toISOString(), signature, message: "Athena is still analyzing the report." };
  if (!job.changedFiles.length) { const state: MtFixItResolutionState = { schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "no_change", updatedAt: new Date().toISOString(), signature, message: safeText(job.summary || "Athena did not find a code change to apply.") }; await saveResolution(env, state); return state; }
  const checksPass = job.checks.length > 0 && job.checks.every((check) => check.ok);
  if (!checksPass) { const state: MtFixItResolutionState = { schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "failed", updatedAt: new Date().toISOString(), signature, message: "Athena found a possible fix, but validation did not pass." }; await saveResolution(env, state); return state; }
  const existing = await readMtFixItResolution(env, job.id); if (existing && ["deploying", "deployed", "failed", "denied"].includes(existing.status)) return existing;
  const patchHash = await jobPatchHash(env, job.id);
  const known = Boolean(patchHash) && (await listKnownFixes(env)).some((item) => item.signature === signature && item.repoId === job.repoId && item.patchHash === patchHash);
  const confidenceText = `${job.summary || ""}\n${job.description || ""}`;
  const confidenceMatch = confidenceText.match(/(?:self-assessed\s+)?confidence(?:\s+(?:level|score))?\s*[:=—-]?\s*(\d{1,3})\s*%/i);
  const confidencePercent = confidenceMatch ? Math.max(0, Math.min(100, Number(confidenceMatch[1]))) : undefined;
  const confidenceThreshold = Math.max(50, Math.min(100, Number(env.MTFIXIT_CONFIDENCE_THRESHOLD || 80)));
  const state: MtFixItResolutionState = {
    schemaVersion: "mtfixit.resolution/v1",
    jobId: job.id,
    status: "deploying",
    updatedAt: new Date().toISOString(),
    signature,
    incidentFingerprint,
    patchHash: patchHash || undefined,
    confidencePercent,
    knownFix: known,
    message: known
      ? "Previously successful patch matched exactly. Automatically merging and deploying after validation."
      : "Validated repair patch produced and all configured checks passed. Automatically merging and deploying; deployment verification is required before this is marked complete.",
  };
  if (!known && (confidencePercent === undefined || confidencePercent < confidenceThreshold)) {
    state.status = "awaiting_approval";
    state.message = confidencePercent === undefined
      ? `Athena's report did not include a parseable confidence percentage. Automatic promotion is blocked until the report is reviewed; required threshold is ${confidenceThreshold}%.`
      : `Athena confidence is ${confidencePercent}%, below the ${confidenceThreshold}% automatic-promotion threshold. Review the evidence before approving deployment.`;
    await saveResolution(env, state);
    return state;
  }
  await saveResolution(env, state); void deployInBackground(job, env, dashboardPort, state); return state;
}

export async function applyMtFixItResolutionAction(jobId: string, action: ResolutionAction, env: NodeJS.ProcessEnv, dashboardPort: number, feedback = "") {
  const job = await readJob(env, dashboardPort, jobId);
  if (action === "resolve") return resolveJob(job, env, dashboardPort);
  const state = await resolveJob(job, env, dashboardPort);
  if (action === "pass") {
    if (state.status !== "deployed") throw new Error("PASS is available only after deployment verification succeeds.");
    await rememberKnownFix(env, job, state);
    const cyclesPath = String(env.HOURLY_REPAIR_CYCLES_FILE || "/data/hourly-repair-cycles.json");
    const cycles = await readJsonFile<any[]>(cyclesPath, []);
    const stableFingerprint = state.incidentFingerprint || state.signature;
    for (const cycle of cycles) {
      if (cycle.appName === job.appName && cycle.fingerprint === stableFingerprint && cycle.status === "failed") {
        cycle.status = "proven-fixed";
        cycle.summary = "Owner confirmed the live fix; previous blacklist/retry count cleared.";
      }
    }
    await mkdir(dirname(cyclesPath), { recursive: true });
    await writeFile(cyclesPath, JSON.stringify(cycles.slice(-500), null, 2), "utf8");
    const passed = { ...state, knownFix: true, feedback: "Owner confirmed the live fix.", updatedAt: new Date().toISOString(), message: "Owner confirmed the live fix. Added to the proven-fix registry and cleared its failed-attempt count." };
    await saveResolution(env, passed);
    return passed;
  }
  if (action === "fail") {
    if (state.status !== "deployed") throw new Error("FAIL feedback is available only after deployment verification completes.");
    const note = safeText(feedback || "Owner reported that the live issue is still failing.", 2000);
    const failed: MtFixItResolutionState = { ...state, status: "failed", knownFix: false, feedback: note, updatedAt: new Date().toISOString(), message: `Owner rejected the live repair: ${note}` };
    await saveResolution(env, failed);
    const historyPath = String(env.LOG_ERROR_HISTORY_FILE || "/data/error-history.json");
    const history = await readJsonFile<any[]>(historyPath, []);
    const fingerprint = state.incidentFingerprint || state.signature || mtFixItKnownFixSignature(job);
    history.push({ recordedAt: new Date().toISOString(), appName: job.appName, fingerprint, message: note, suggestion: "Owner rejected the deployed repair; research an alternate approach and use this feedback as negative evidence.", context: [`MtFixIt job ${job.id}`, `repo ${job.repoId}`, ...(job.changedFiles || []), ...(job.checks || []).filter((check) => !check.ok).map((check) => `${check.command}: ${check.output}`)] });
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, JSON.stringify(history.slice(-5000), null, 2), "utf8");
    const cyclesPath = String(env.HOURLY_REPAIR_CYCLES_FILE || "/data/hourly-repair-cycles.json");
    const cycles = await readJsonFile<any[]>(cyclesPath, []);
    const now = new Date().toISOString();
    cycles.push({
      id: `owner-fail-${job.id}-${Date.now()}`, startedAt: now, finishedAt: now, status: "failed",
      appName: job.appName, fingerprint,
      summary: `Owner marked deployed repair as failed: ${note}`
    });
    await mkdir(dirname(cyclesPath), { recursive: true });
    await writeFile(cyclesPath, JSON.stringify(cycles.slice(-500), null, 2), "utf8");
    void import("./hourlyAthenaDiagnostic.js").then(({ runHourlyAthenaDiagnostic }) => runHourlyAthenaDiagnostic(env)).catch(() => console.error("Athena retry after owner FAIL feedback did not start."));
    return failed;
  }
  if (action === "deny") { const denied: MtFixItResolutionState = { ...state, status: "denied", deniedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: "mtman denied automatic deployment. The repair is waiting for further instructions." }; await saveResolution(env, denied); return denied; }
  if (state.status === "deployed" || state.status === "deploying") return state;
  if (job.status !== "completed" || !job.changedFiles.length || !job.checks.length || !job.checks.every((check) => check.ok)) throw new Error("This repair is not eligible for approval because Athena has not produced a validated code change.");
  const approved: MtFixItResolutionState = { ...state, status: "deploying", knownFix: Boolean(state.knownFix), approvedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), message: "mtman approved the validated fix. Athena is merging and deploying it now." };
  await saveResolution(env, approved); void deployInBackground(job, env, dashboardPort, approved); return approved;
}

async function readBody(request: IncomingMessage): Promise<any> { let raw = ""; for await (const chunk of request) { raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk); if (raw.length > MAX_BODY) throw new Error("Request body too large"); } return JSON.parse(raw || "{}"); }
function sendJson(response: ServerResponse, status: number, body: unknown) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" }); response.end(JSON.stringify(body)); }
export async function handleMtFixItResolutionRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`); const match = url.pathname.match(RESOLUTION_ROUTE); if (!match) return false;
  const jobId = match[1]; const method = String(request.method || "GET").toUpperCase();
  try {
    if (method === "GET") { const state = await readMtFixItResolution(env, jobId); sendJson(response, state ? 200 : 404, state || { error: "Resolution state not found" }); return true; }
    if (method !== "POST") { sendJson(response, 405, { error: "Method not allowed" }); return true; }
    const body = await readBody(request); const action = String(body?.action || "resolve").toLowerCase() as ResolutionAction;
    if (!["resolve", "approve", "deny", "pass", "fail"].includes(action)) { sendJson(response, 400, { error: "Invalid resolution action" }); return true; }
    const state = await applyMtFixItResolutionAction(jobId, action, env, dashboardPort, safeText(body?.feedback || "", 2000)); sendJson(response, 200, { ok: true, state }); return true;
  } catch (error) { sendJson(response, 409, { error: safeText(error instanceof Error ? error.message : error, 1200) }); return true; }
}
