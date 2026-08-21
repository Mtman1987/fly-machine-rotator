import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { approveChatGptHandoff, readChatGptHandoff, writeChatGptHandoff } from "./chatgptHandoff.js";
import { classifyIncident } from "./incidentClassifier.js";
import { loadEcosystemOperatorContext } from "./ecosystemContext.js";

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
  status: "running" | "no-actionable-incident" | "qwen-reviewed" | "awaiting-owner-approval" | "failed";
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

async function notifyOwner(env: NodeJS.ProcessEnv, input: { message: string; handoffId?: string; fileContent?: string }) {
  if (notifyMode(env) === "log-only") return;
  const key = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
  if (!key) return;
  const buttons = input.handoffId ? [
    { label: "Approve ChatGPT Repair", customId: `chatgpt_approve:${input.handoffId}`, style: 3 },
    { label: "Decline / Hold", customId: `chatgpt_deny:${input.handoffId}`, style: 4 },
  ] : undefined;
  await fetch(String(env.DSH_BASE_URL || "https://discord-stream-hub-new.fly.dev").replace(/\/$/, "") + "/api/internal/owner-dm", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: safe(input.message, 1800),
      buttons,
      ...(input.fileContent ? { fileName: "athena-hourly-repair.txt", fileContent: safe(input.fileContent, 120_000) } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

async function ensureFallbackHandoff(env: NodeJS.ProcessEnv, event: ErrorEvent, job: CoderJob | null, failure: string) {
  const jobId = job?.id || `hourly_${Date.now()}_${event.fingerprint.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24)}`;
  const id = `chatgpt-${jobId}`;
  const existing = await readChatGptHandoff(env, id);
  if (existing) return existing;
  const operatorContext = await loadEcosystemOperatorContext(env);
  return writeChatGptHandoff(env, {
    jobId,
    appName: event.appName,
    repoId: job?.repoId || event.appName,
    repoLabel: job?.repoId || event.appName,
    repoUrl: "",
    description: `${event.message}\n\n${(event.context || []).slice(-12).join("\n")}`.slice(0, 4000),
    userContext: { source: "hourly-athena-diagnostic", fingerprint: event.fingerprint, recordedAt: event.recordedAt, suggestion: event.suggestion || "" },
    qwenFailure: failure,
    baselineChecks: (job?.baselineChecks || job?.checks || []).map((check) => ({ command: check.command, ok: check.ok, output: String(check.output || "") })),
    operatorContext,
    repositoryContext: "Fresh ChatGPT worker must fetch current main and AGENTS.md through the connected GitHub tools before changing code.",
    validationCommands: (job?.checks || []).map((check) => check.command),
  });
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

    const qwenSucceeded = Boolean(job && job.status === "completed" && (job.changedFiles || []).length && (job.checks || []).length && (job.checks || []).every((check) => check.ok));
    if (qwenSucceeded && job) {
      const published = await coderCli(["publish", job.id], env);
      const publishedJob = unwrapJob(published.payload) || job;
      const pullRequest = published.payload?.pullRequest || publishedJob.pullRequest;
      if (!published.ok || !pullRequest?.number) throw new Error(`Validated Qwen repair could not be published as a draft PR: ${published.error || "no pull request returned"}`);
      cycle.pullRequest = pullRequest;
      const handoff = await ensureFallbackHandoff(env, event, publishedJob, "Qwen produced a validated draft repair. ChatGPT must review its diff, regression coverage, deployment, and live behavior before completion.");
      const approved = await approveChatGptHandoff(env, handoff.id, "hourly-athena-standing-policy");
      cycle.handoffId = approved.id;
      cycle.status = "qwen-reviewed";
      cycle.summary = `Qwen produced a validated draft PR #${pullRequest.number}; queued for top-of-hour ChatGPT review.`;
      cycle.finishedAt = new Date().toISOString();
      await saveCycle(env, cycle);
      await notifyOwner(env, { message: `Athena hourly diagnostic prepared validated draft PR #${pullRequest.number} for ${event.appName}. ChatGPT will review it at the top of the hour.`, fileContent: JSON.stringify(cycle, null, 2) });
      return cycle;
    }

    const failure = safe(job?.error || submitted.error || job?.summary || "Qwen did not produce a validated repair.", 6000);
    const marker = failure.match(/awaiting-chatgpt:(chatgpt-[A-Za-z0-9_-]{8,120})/);
    const handoff = marker ? await readChatGptHandoff(env, marker[1]) : await ensureFallbackHandoff(env, event, job, failure);
    if (!handoff) throw new Error("ChatGPT fallback handoff could not be loaded.");
    cycle.handoffId = handoff.id;
    cycle.status = "awaiting-owner-approval";
    cycle.summary = `Qwen did not produce a validated repair; ${handoff.id} awaits owner approval.`;
    cycle.finishedAt = new Date().toISOString();
    await saveCycle(env, cycle);
    await notifyOwner(env, {
      message: `Athena's hourly diagnostic found an actionable ${event.appName} incident, but local Qwen could not produce a validated repair. Approve once to let the next hourly ChatGPT Business pass take over, or decline to hold it.`,
      handoffId: handoff.id,
      fileContent: JSON.stringify({ cycle, error: event.message, context: event.context || [], qwenFailure: failure }, null, 2),
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
