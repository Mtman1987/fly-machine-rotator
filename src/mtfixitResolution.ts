import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { listRepoConfigs } from "./repoMap.js";

type CodexJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  updatedAt?: string;
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
  knownFix?: boolean;
  message?: string;
  approvedAt?: string;
  deniedAt?: string;
  pullRequest?: { number: number; url: string; branch: string; commit: string };
  mergeCommit?: string;
  workflow?: { id: number; name: string; status: string; conclusion?: string | null; url?: string };
};

type ResolutionAction = "resolve" | "approve" | "deny";

const RESOLUTION_ROUTE = /^\/api\/dsh\/mtfixit\/jobs\/([a-zA-Z0-9_-]{8,100})\/resolution$/;
const MAX_BODY = 16 * 1024;
const VERIFY_INTERVAL_MS = 10_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
const WORKFLOW_DISCOVERY_GRACE_MS = 90_000;
const activeDeployments = new Set<string>();

function resolutionDir(env: NodeJS.ProcessEnv) {
  return String(env.MTFIXIT_RESOLUTION_DIR || "/data/codex-fixer/mtfixit-resolution").trim();
}

function knownFixFile(env: NodeJS.ProcessEnv) {
  return String(env.MTFIXIT_KNOWN_FIXES_FILE || "/data/codex-fixer/known-fixes.json").trim();
}

function resolutionFile(env: NodeJS.ProcessEnv, jobId: string) {
  return `${resolutionDir(env)}/${jobId}.json`;
}

function safeText(value: unknown, max = 5000) {
  return String(value ?? "")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|github_pat_)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, max);
}

function normalizedReport(description: string) {
  const report = String(description || "").split(/\n\nAthena diagnostic evidence/i)[0] || description;
  return report
    .toLowerCase()
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

export function mtFixItKnownFixSignature(job: Pick<CodexJob, "repoId" | "description">) {
  return createHash("sha256")
    .update(`${String(job.repoId || "unknown").trim().toLowerCase()}\n${normalizedReport(job.description)}`)
    .digest("hex");
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function saveResolution(env: NodeJS.ProcessEnv, state: MtFixItResolutionState) {
  const file = resolutionFile(env, state.jobId);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

export async function readMtFixItResolution(env: NodeJS.ProcessEnv, jobId: string): Promise<MtFixItResolutionState | null> {
  return readJsonFile<MtFixItResolutionState | null>(resolutionFile(env, jobId), null);
}

async function listKnownFixes(env: NodeJS.ProcessEnv): Promise<KnownFix[]> {
  const values = await readJsonFile<KnownFix[]>(knownFixFile(env), []);
  return Array.isArray(values) ? values : [];
}

async function saveKnownFixes(env: NodeJS.ProcessEnv, values: KnownFix[]) {
  const file = knownFixFile(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(values.slice(-500), null, 2), "utf8");
}

async function rememberKnownFix(env: NodeJS.ProcessEnv, job: CodexJob, state: MtFixItResolutionState) {
  if (!state.signature || !state.pullRequest || !state.mergeCommit) return;
  const values = await listKnownFixes(env);
  const existing = values.find((item) => item.signature === state.signature);
  const next: KnownFix = {
    signature: state.signature,
    repoId: job.repoId,
    normalizedReport: normalizedReport(job.description),
    learnedAt: new Date().toISOString(),
    sourceJobId: job.id,
    pullRequestNumber: state.pullRequest.number,
    mergeCommit: state.mergeCommit,
    successfulDeploys: (existing?.successfulDeploys || 0) + 1,
  };
  const filtered = values.filter((item) => item.signature !== state.signature);
  filtered.push(next);
  await saveKnownFixes(env, filtered);
}

async function workerRequest(env: NodeJS.ProcessEnv, dashboardPort: number, path: string, init: RequestInit = {}) {
  const secret = String(env.CODEX_WORKER_SECRET || "").trim();
  if (!secret) throw new Error("CODEX_WORKER_SECRET is not configured");
  const response = await fetch(`http://127.0.0.1:${dashboardPort}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      "x-codex-worker-secret": secret,
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.error || `Coder worker HTTP ${response.status}`);
  return payload;
}

async function readJob(env: NodeJS.ProcessEnv, dashboardPort: number, jobId: string): Promise<CodexJob> {
  const payload = await workerRequest(env, dashboardPort, `/api/codex/jobs/${encodeURIComponent(jobId)}`);
  if (!payload?.id) throw new Error("Coder job was not found");
  return payload as CodexJob;
}

function repoSlug(job: CodexJob) {
  const repo = listRepoConfigs().find((item) => item.id === job.repoId);
  if (!repo) throw new Error(`Unknown repository ${job.repoId}`);
  return new URL(repo.repoUrl).pathname.replace(/^\//, "").replace(/\.git$/, "");
}

async function githubRequest(env: NodeJS.ProcessEnv, path: string, init: RequestInit = {}) {
  const token = String(env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "spmt-mtfixit-resolution",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.message || `GitHub HTTP ${response.status}`);
  return payload;
}

async function ensurePublished(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number) {
  if (job.pullRequest) return job.pullRequest;
  const payload = await workerRequest(env, dashboardPort, `/api/codex/jobs/${encodeURIComponent(job.id)}/publish`, { method: "POST" });
  if (!payload?.pullRequest?.number) throw new Error("Athena could not publish a repair pull request");
  return payload.pullRequest as NonNullable<CodexJob["pullRequest"]>;
}

async function markReady(repo: string, pullNumber: number, env: NodeJS.ProcessEnv) {
  try {
    await githubRequest(env, `/repos/${repo}/pulls/${pullNumber}/ready_for_review`, { method: "POST", body: "{}" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/not a draft|unprocessable/i.test(message)) throw error;
  }
}

async function mergePullRequest(repo: string, pullNumber: number, env: NodeJS.ProcessEnv) {
  return githubRequest(env, `/repos/${repo}/pulls/${pullNumber}/merge`, {
    method: "PUT",
    body: JSON.stringify({ merge_method: "squash" }),
  }) as Promise<{ merged?: boolean; sha?: string; message?: string }>;
}

async function workflowRuns(repo: string, sha: string, env: NodeJS.ProcessEnv) {
  const payload = await githubRequest(env, `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`);
  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs as any[] : [];
}

async function verifyDeployment(repo: string, sha: string, env: NodeJS.ProcessEnv, state: MtFixItResolutionState) {
  const started = Date.now();
  let discoveredAt = 0;
  while (Date.now() - started < VERIFY_TIMEOUT_MS) {
    const runs = await workflowRuns(repo, sha, env).catch(() => [] as any[]);
    const meaningful = runs.filter((run) => !/retain newest merged branch backup/i.test(String(run.name || "")));
    if (meaningful.length > 0) {
      discoveredAt ||= Date.now();
      const failed = meaningful.find((run) => run.status === "completed" && run.conclusion && run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped");
      const pending = meaningful.find((run) => run.status !== "completed");
      const selected = failed || pending || meaningful[0];
      state.workflow = {
        id: Number(selected.id || 0),
        name: String(selected.name || "GitHub Actions"),
        status: String(selected.status || "unknown"),
        conclusion: selected.conclusion ?? null,
        url: String(selected.html_url || ""),
      };
      state.updatedAt = new Date().toISOString();
      await saveResolution(env, state);
      if (failed) throw new Error(`Deployment workflow failed: ${failed.name || failed.id} (${failed.conclusion})`);
      if (!pending && meaningful.every((run) => ["success", "neutral", "skipped"].includes(String(run.conclusion || "")))) return;
    } else if (Date.now() - started >= WORKFLOW_DISCOVERY_GRACE_MS) {
      throw new Error("No deployment workflow was discovered for the merged repair commit.");
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  throw new Error("Deployment verification timed out.");
}

async function deployInBackground(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number, state: MtFixItResolutionState) {
  if (activeDeployments.has(job.id)) return;
  activeDeployments.add(job.id);
  try {
    const pullRequest = await ensurePublished(job, env, dashboardPort);
    const repo = repoSlug(job);
    state.pullRequest = pullRequest;
    state.status = "deploying";
    state.message = `Athena published PR #${pullRequest.number} and is merging/deploying it.`;
    state.updatedAt = new Date().toISOString();
    await saveResolution(env, state);

    await markReady(repo, pullRequest.number, env);
    const merged = await mergePullRequest(repo, pullRequest.number, env);
    if (!merged?.merged || !merged.sha) throw new Error(merged?.message || "GitHub did not merge the repair pull request");
    state.mergeCommit = String(merged.sha);
    state.updatedAt = new Date().toISOString();
    await saveResolution(env, state);

    await verifyDeployment(repo, state.mergeCommit, env, state);
    state.status = "deployed";
    state.message = "Fix merged and deployment checks completed successfully.";
    state.updatedAt = new Date().toISOString();
    await saveResolution(env, state);
    await rememberKnownFix(env, job, state);
  } catch (error) {
    state.status = "failed";
    state.message = safeText(error instanceof Error ? error.message : error, 1200);
    state.updatedAt = new Date().toISOString();
    await saveResolution(env, state);
  } finally {
    activeDeployments.delete(job.id);
  }
}

async function resolveJob(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<MtFixItResolutionState> {
  const signature = mtFixItKnownFixSignature(job);
  if (job.status === "failed") {
    const state: MtFixItResolutionState = {
      schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "failed", updatedAt: new Date().toISOString(), signature,
      message: safeText(job.error || job.summary || "Athena could not produce a fix."),
    };
    await saveResolution(env, state);
    return state;
  }
  if (job.status !== "completed") {
    const existing = await readMtFixItResolution(env, job.id);
    return existing || {
      schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "awaiting_analysis", updatedAt: new Date().toISOString(), signature,
      message: "Athena is still analyzing the report.",
    };
  }
  const checksPass = job.checks.length > 0 && job.checks.every((check) => check.ok);
  if (job.changedFiles.length === 0) {
    const state: MtFixItResolutionState = {
      schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "no_change", updatedAt: new Date().toISOString(), signature,
      message: safeText(job.summary || "Athena did not find a code change to apply."),
    };
    await saveResolution(env, state);
    return state;
  }
  if (!checksPass) {
    const state: MtFixItResolutionState = {
      schemaVersion: "mtfixit.resolution/v1", jobId: job.id, status: "failed", updatedAt: new Date().toISOString(), signature,
      message: "Athena found a possible fix, but validation did not pass.",
    };
    await saveResolution(env, state);
    return state;
  }

  const existing = await readMtFixItResolution(env, job.id);
  if (existing && ["awaiting_approval", "deploying", "deployed", "failed", "denied"].includes(existing.status)) return existing;
  const known = (await listKnownFixes(env)).some((item) => item.signature === signature && item.repoId === job.repoId);
  const state: MtFixItResolutionState = {
    schemaVersion: "mtfixit.resolution/v1",
    jobId: job.id,
    status: known ? "deploying" : "awaiting_approval",
    updatedAt: new Date().toISOString(),
    signature,
    knownFix: known,
    message: known
      ? "This exact report matches a previously approved successful fix. Athena is applying the validated repair automatically."
      : "Athena found and validated a new fix. mtman approval is required before merge/deployment.",
  };
  await saveResolution(env, state);
  if (known) void deployInBackground(job, env, dashboardPort, state);
  return state;
}

async function applyAction(jobId: string, action: ResolutionAction, env: NodeJS.ProcessEnv, dashboardPort: number) {
  const job = await readJob(env, dashboardPort, jobId);
  if (action === "resolve") return resolveJob(job, env, dashboardPort);
  const state = await resolveJob(job, env, dashboardPort);
  if (action === "deny") {
    const denied: MtFixItResolutionState = {
      ...state,
      status: "denied",
      deniedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      message: "mtman denied automatic deployment. The repair is waiting for further instructions.",
    };
    await saveResolution(env, denied);
    return denied;
  }
  if (state.status === "deployed" || state.status === "deploying") return state;
  if (job.status !== "completed" || job.changedFiles.length === 0 || !job.checks.length || !job.checks.every((check) => check.ok)) {
    throw new Error("This repair is not eligible for approval because Athena has not produced a validated code change.");
  }
  const approved: MtFixItResolutionState = {
    ...state,
    status: "deploying",
    knownFix: Boolean(state.knownFix),
    approvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    message: "mtman approved the validated fix. Athena is merging and deploying it now.",
  };
  await saveResolution(env, approved);
  void deployInBackground(job, env, dashboardPort, approved);
  return approved;
}

async function readBody(request: IncomingMessage): Promise<any> {
  let raw = "";
  for await (const chunk of request) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (raw.length > MAX_BODY) throw new Error("Request body too large");
  }
  return JSON.parse(raw || "{}");
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(body));
}

export async function handleMtFixItResolutionRequest(
  request: IncomingMessage,
  response: ServerResponse,
  env: NodeJS.ProcessEnv,
  dashboardPort: number,
): Promise<boolean> {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const match = url.pathname.match(RESOLUTION_ROUTE);
  if (!match) return false;
  const jobId = match[1];
  const method = String(request.method || "GET").toUpperCase();
  try {
    if (method === "GET") {
      const state = await readMtFixItResolution(env, jobId);
      return sendJson(response, state ? 200 : 404, state || { error: "Resolution state not found" }), true;
    }
    if (method !== "POST") return sendJson(response, 405, { error: "Method not allowed" }), true;
    const body = await readBody(request);
    const action = String(body?.action || "resolve").toLowerCase() as ResolutionAction;
    if (!(["resolve", "approve", "deny"] as string[]).includes(action)) return sendJson(response, 400, { error: "Invalid resolution action" }), true;
    const state = await applyAction(jobId, action, env, dashboardPort);
    return sendJson(response, 200, { ok: true, state }), true;
  } catch (error) {
    return sendJson(response, 409, { error: safeText(error instanceof Error ? error.message : error, 1200) }), true;
  }
}
