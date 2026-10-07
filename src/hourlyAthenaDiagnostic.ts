import { upsertUnifiedDiscordReport } from "./unifiedReport.js";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { classifyIncident } from "./incidentClassifier.js";
import { applyMtFixItResolutionAction } from "./mtfixitResolution.js";

const execFileAsync = promisify(execFile);
const DEFAULT_HISTORY = "/data/error-history.json";
const DEFAULT_CYCLES = "/data/hourly-repair-cycles.json";
const MAX_CYCLES = 500;

type ErrorEvent = {
  recordedAt: string;
  appName: string;
  fingerprint: string;
  message: string;
  suggestion?: string;
  context?: string[];
};

type CoderJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  appName: string;
  repoId: string;
  description: string;
  summary?: string;
  changedFiles?: string[];
  checks?: Array<{ command: string; ok: boolean; output?: string }>;
  baselineChecks?: Array<{ command: string; ok: boolean; output?: string }>;
  error?: string;
  pullRequest?: { number: number; url: string; branch: string; commit: string };
};

export type HourlyRepairCycle = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "no-actionable-incident" | "awaiting-owner-approval" | "deploying-known-fix" | "failed";
  appName?: string;
  fingerprint?: string;
  incidentRecordedAt?: string;
  jobId?: string;
  handoffId?: string;
  pullRequest?: { number: number; url: string; branch: string; commit: string };
  summary: string;
};

function cyclesFile(env: NodeJS.ProcessEnv) { return String(env.HOURLY_REPAIR_CYCLES_FILE || DEFAULT_CYCLES); }
function historyFile(env: NodeJS.ProcessEnv) { return String(env.LOG_ERROR_HISTORY_FILE || DEFAULT_HISTORY); }
function notifyMode(env: NodeJS.ProcessEnv) { return String(env.HOURLY_REPAIR_NOTIFY_MODE || "discord-and-log").toLowerCase(); }
function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function safe(value: unknown, max = 3000) {
  return String(value ?? "")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-|github_pat_)[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .slice(0, max);
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(file, "utf8")) as T; } catch { return fallback; }
}

async function readCycles(env: NodeJS.ProcessEnv) {
  const rows = await readJson<HourlyRepairCycle[]>(cyclesFile(env), []);
  return Array.isArray(rows) ? rows : [];
}

async function saveCycle(env: NodeJS.ProcessEnv, cycle: HourlyRepairCycle) {
  const file = cyclesFile(env);
  const rows = (await readCycles(env)).filter((row) => row.id !== cycle.id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify([...rows, cycle].slice(-MAX_CYCLES), null, 2));
  await upsertUnifiedDiscordReport(env.DISCORD_WEBHOOK_URL).catch(() => console.error("Hourly repair evidence report update failed"));
}

function parseCliJson(stdout: string): any {
  const trimmed = String(stdout || "").trim();
  const starts: number[] = [];
  for (let i = 0; i < trimmed.length; i += 1) if (trimmed[i] === "{") starts.push(i);
  for (const start of starts) {
    try { return JSON.parse(trimmed.slice(start)); } catch { /* keep looking */ }
  }
  return null;
}

async function coderCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ payload: any; ok: boolean; error?: string }> {
  try {
    const result = await execFileAsync("node", ["scripts/athena-code.mjs", ...args], {
      cwd: process.cwd(), env, encoding: "utf8", timeout: 12 * 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    return { payload: parseCliJson(result.stdout), ok: true };
  } catch (error: any) {
    return {
      payload: parseCliJson(String(error?.stdout || "")),
      ok: false,
      error: safe(`${error?.stderr || ""}\n${error?.message || error}`, 5000),
    };
  }
}

function unwrapJob(payload: any): CoderJob | null {
  const job = payload?.job || payload;
  return job?.id ? job as CoderJob : null;
}

function incidentKey(event: ErrorEvent) { return `${event.appName}:${event.fingerprint}:${event.recordedAt}`; }

async function pickIncident(env: NodeJS.ProcessEnv): Promise<ErrorEvent | null> {
  const events = await readJson<ErrorEvent[]>(historyFile(env), []);
  const cycles = await readCycles(env);
  const attempted = new Set(cycles.map((cycle) => `${cycle.appName || ""}:${cycle.fingerprint || ""}:${cycle.incidentRecordedAt || ""}`));
  return (Array.isArray(events) ? events : [])
    .filter((event) => Boolean(event?.appName && event?.fingerprint && event?.recordedAt && event?.message))
    .sort((a, b) => String(b.recordedAt).localeCompare(String(a.recordedAt)))
    .find((event) => classifyIncident({ ...event, context: event.context || [] }).autoFixEligible && !attempted.has(incidentKey(event))) || null;
}

export async function notifyOwner(env: NodeJS.ProcessEnv, input: { message: string; jobId?: string; fileContent?: string }) {
  if (notifyMode(env) === "log-only") return;
  const key = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
  if (!key) {
    console.error("Hourly repair notification failed: SPMT API key is not configured");
    return;
  }
  const buttons = input.jobId ? [
    { label: "Approve & Deploy", customId: `mtfixit_approve:${input.jobId}`, style: 3 },
    { label: "Deny / Hold", customId: `mtfixit_deny:${input.jobId}`, style: 4 },
  ] : undefined;
  try {
    const response = await fetch(String(env.DSH_BASE_URL || "https://discord-stream-hub-new.fly.dev").replace(/\/$/, "") + "/api/internal/owner-dm", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: safe(input.message, 1800),
      buttons,
      ...(input.fileContent ? { fileName: "athena-hourly-repair.txt", fileContent: safe(input.fileContent, 120_000) } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      console.error(`Hourly repair notification failed: owner-dm HTTP ${response.status}`);
    }
    await response.body?.cancel();
  } catch {
    // Never log request headers, message contents, or a provider response body.
    console.error("Hourly repair notification failed: owner-dm network request did not complete");
  }
}

export async function runHourlyAthenaDiagnostic(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<HourlyRepairCycle> {
  const cycle: HourlyRepairCycle = {
    id: `hourly-${now.toISOString().replace(/[:.]/g, "-")}`,
    startedAt: now.toISOString(),
    status: "running",
    summary: "Athena hourly diagnostic started.",
  };
  await saveCycle(env, cycle);
  try {
    const event = await pickIncident(env);
    if (!event) {
      cycle.status = "no-actionable-incident";
      cycle.summary = "No new auto-fix-eligible incident was found.";
      cycle.finishedAt = new Date().toISOString();
      await saveCycle(env, cycle);
      return cycle;
    }
    cycle.appName = event.appName;
    cycle.fingerprint = event.fingerprint;
    cycle.incidentRecordedAt = event.recordedAt;
    await saveCycle(env, cycle);

    const description = `Hourly Athena diagnostic for ${event.appName}. Fix this current actionable incident and add regression coverage.\n\nError: ${event.message}\nSuggestion: ${event.suggestion || "none"}\nContext:\n${(event.context || []).slice(-12).join("\n")}`.slice(0, 4000);
    const submitted = await coderCli(["submit", event.appName, description, "--wait", "--timeout", "720"], env);
    const job = unwrapJob(submitted.payload);
    cycle.jobId = job?.id;

    const repairValidated = Boolean(job && job.status === "completed" && (job.changedFiles || []).length && (job.checks || []).length && (job.checks || []).every((check) => check.ok));
    if (repairValidated && job) {
      const dashboardPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT || Number(env.PORT || 8080) + 2);
      const resolution = await applyMtFixItResolutionAction(job.id, "resolve", env, dashboardPort);
      cycle.status = resolution.status === "deploying" ? "deploying-known-fix" : "awaiting-owner-approval";
      cycle.summary = resolution.status === "deploying"
        ? `Athena matched a previously approved repair for ${event.appName}; deployment is running automatically.`
        : `Athena found and validated a repair for ${event.appName}; owner approval is required before merge/deployment.`;
      cycle.finishedAt = new Date().toISOString();
      await saveCycle(env, cycle);
      await notifyOwner(env, {
        message: resolution.status === "deploying"
          ? `Athena found an actionable ${event.appName} incident and regenerated an exact previously approved fix. Job **${job.id}** is deploying automatically and will verify GitHub Actions before being recorded as successful.`
          : `Athena found an actionable ${event.appName} incident and produced a validated repair. Review the attached evidence, then approve to merge/deploy or deny to hold it. Job: **${job.id}**`,
        ...(resolution.status === "awaiting_approval" ? { jobId: job.id } : {}),
        fileContent: JSON.stringify({ cycle, resolution, job: { id: job.id, appName: job.appName, repoId: job.repoId, summary: job.summary, changedFiles: job.changedFiles, checks: job.checks } }, null, 2),
      });
      return cycle;
    }

    const failure = safe(job?.error || submitted.error || job?.summary || "The autonomous coder did not produce a validated repair.", 6000);
    cycle.status = "failed";
    cycle.summary = `Athena detected an actionable ${event.appName} incident, but the autonomous coder did not produce a validated patch. The incident remains durable for retry/review.`;
    cycle.finishedAt = new Date().toISOString();
    await saveCycle(env, cycle);
    await notifyOwner(env, {
      message: `Athena found an actionable ${event.appName} incident but could not produce a validated repair automatically. No deployment was attempted. Job: **${job?.id || "none"}**`,
      fileContent: JSON.stringify({ cycle, error: event.message, context: event.context || [], coderFailure: failure }, null, 2),
    });
    return cycle;
  } catch (error) {
    cycle.status = "failed";
    cycle.summary = safe(error instanceof Error ? error.message : String(error), 2000);
    cycle.finishedAt = new Date().toISOString();
    await saveCycle(env, cycle);
    await notifyOwner(env, { message: `Athena hourly diagnostic failed before it could prepare a safe repair: ${cycle.summary}` });
    return cycle;
  }
}

function msUntilNextMinute50(now = new Date()) {
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setMinutes(50);
  if (next.getTime() <= now.getTime()) next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

export async function startHourlyAthenaDiagnosticLoop(env: NodeJS.ProcessEnv = process.env): Promise<never> {
  for (;;) {
    await delay(msUntilNextMinute50());
    await runHourlyAthenaDiagnostic(env).catch((error) => console.error("[HourlyAthena] diagnostic failed", error));
  }
}
