import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { buildFixId } from "./fixStore.js";
import { getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";
import { SUCCESS_INTERVAL_MS } from "./rotationControl.js";
import { upsertUnifiedDiscordReport } from "./unifiedReport.js";

export interface AthenaIncidentAttempt {
  incidentId: string;
  appName: string;
  fingerprint: string;
  rotationKey: string;
  attemptedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "failed";
  summary?: string;
}

let triggerChain: Promise<void> = Promise.resolve();

export function scheduleAthenaForIncident(
  event: { appName: string; fingerprint: string },
  env: NodeJS.ProcessEnv = process.env
): void {
  triggerChain = triggerChain
    .then(async () => { await triggerAthenaForIncident(event, env); })
    .catch((error) => console.error("Athena incident trigger failed", error));
}

export async function triggerAthenaForIncident(
  event: { appName: string; fingerprint: string },
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
): Promise<{ triggered: boolean; attempt: AthenaIncidentAttempt }> {
  const attemptsFile = getAthenaIncidentAttemptsFile(env);
  const attempts = await readAthenaIncidentAttempts(attemptsFile);
  const runtime = (await RotatorRuntimeStateStore.load(getRuntimeStateFile(env))).snapshot();
  const rotationKey = runtime.lastStartedAt ?? `bootstrap-${Math.floor(now / SUCCESS_INTERVAL_MS)}`;
  const incidentId = buildFixId(event.appName, event.fingerprint);
  const previous = attempts.find((item) => item.incidentId === incidentId && item.rotationKey === rotationKey);
  if (previous) return { triggered: false, attempt: previous };

  const attempt: AthenaIncidentAttempt = {
    incidentId,
    appName: event.appName,
    fingerprint: event.fingerprint,
    rotationKey,
    attemptedAt: new Date(now).toISOString(),
    status: "running"
  };
  attempts.push(attempt);
  await writeAthenaIncidentAttempts(attemptsFile, attempts);
  await upsertUnifiedDiscordReport(env.DISCORD_WEBHOOK_URL).catch((error) => {
    console.error("Could not refresh Discord when Athena started", error);
  });

  const dashboardPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT ?? (Number(env.PORT ?? env.ROTATOR_DASHBOARD_PORT ?? 8080) + 2));
  const token = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN ?? "").trim();
  try {
    if (!token) throw new Error("ROTATOR_DASHBOARD_ACTION_TOKEN is not configured");
    const response = await fetch(`http://127.0.0.1:${dashboardPort}/actions/fixes/generate?id=${encodeURIComponent(incidentId)}`, {
      method: "POST",
      headers: { "x-rotator-action-token": token, "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(Number(env.ROTATOR_ATHENA_TRIGGER_TIMEOUT_MS ?? 10 * 60 * 1000))
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Athena generate returned ${response.status}: ${body.slice(0, 500)}`);
    attempt.status = "completed";
    attempt.summary = body.slice(0, 500);
  } catch (error) {
    attempt.status = "failed";
    attempt.summary = error instanceof Error ? error.message : String(error);
  }
  attempt.finishedAt = new Date().toISOString();
  await writeAthenaIncidentAttempts(attemptsFile, attempts);
  await upsertUnifiedDiscordReport(env.DISCORD_WEBHOOK_URL).catch((error) => {
    console.error("Could not refresh Discord after Athena attempt", error);
  });
  return { triggered: true, attempt };
}

export function getAthenaIncidentAttemptsFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROTATOR_ATHENA_ATTEMPTS_FILE ?? "/data/athena-incident-attempts.json";
}

export async function readAthenaIncidentAttempts(path: string): Promise<AthenaIncidentAttempt[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as AthenaIncidentAttempt[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAthenaIncidentAttempts(path: string, attempts: AthenaIncidentAttempt[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(attempts.slice(-2000), null, 2));
}
