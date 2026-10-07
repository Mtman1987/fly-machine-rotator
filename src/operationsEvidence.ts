import { getFixStoreFile } from "./fixStore.js";
import { mkdir, readFile, readdir, chmod, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectMachineLoads, type MachineLoad } from "./machineLoads.js";
import { sampleManagedFlyLogs } from "./flyObservability.js";
import { writeAtomicJson } from "./atomicJson.js";
import { redactSensitiveValue } from "./redaction.js";
import { readObservationWindow } from "./observationWindow.js";
import type { AppRotationResult } from "./types.js";

async function json(file: string, fallback: unknown = []) { try { return JSON.parse(await readFile(file, "utf8")) ?? fallback; } catch { return fallback; } }
export function evidenceRoot(env: NodeJS.ProcessEnv = process.env) { return env.ROTATOR_EVIDENCE_DIR || "/data/operations-evidence"; }
export async function collectOperationsEvidence(latestResults?: AppRotationResult[], env: NodeJS.ProcessEnv = process.env) {
  const [machines, logs, window, cycles, rotations, runtime, fixes, errors, observations] = await Promise.all([
    collectMachineLoads(env).catch(() => [] as MachineLoad[]),
    sampleManagedFlyLogs({ limit: 200, durationMs: 2000 }, env).catch(() => ({ source: "fly-nats-live-log-stream", logs: [], unavailable: "live log snapshot did not complete" })),
    readObservationWindow(env),
    json(env.HOURLY_REPAIR_CYCLES_FILE || "/data/hourly-repair-cycles.json"),
    json(env.ROTATION_HISTORY_FILE || "/data/rotation-history.json"),
    json(env.ROTATOR_RUNTIME_STATE_FILE || "/data/runtime-state.json", {}),
    json(getFixStoreFile(env)),
    json(env.LOG_ERROR_HISTORY_FILE || "/data/error-history.json"),
    json(env.LOG_OBSERVATION_HISTORY_FILE || "/data/observed-incidents.json"),
  ]);
  const root = env.CODEX_FIXER_DATA_DIR || "/data/codex-fixer";
  const jobs: unknown[] = [];
  try {
    for (const name of (await readdir(join(root, "jobs"))).filter(n => /^[a-zA-Z0-9_-]+\.json$/.test(n))) {
      const job = await json(join(root, "jobs", name), null);
      if (!job || (window?.startedAt && job.createdAt < window.startedAt)) continue;
      const resolution = await json(join(env.MTFIXIT_RESOLUTION_DIR || join(root, "mtfixit-resolution"), name), null);
      const artifact = async (name: string) => { try { return await readFile(join(root,"jobs",job.id,name),"utf8"); } catch { return undefined; } };
      jobs.push({ job, resolution, diff: await artifact("diff.patch"), checks: await artifact("checks.txt"), response: await artifact("response.txt") });
    }
  } catch { /* No coder jobs yet is an empty comparison, not a successful fix. */ }
  const cutoff = window?.startedAt || new Date(Date.now()-86400000).toISOString();
  const withinWindow = (rows: any, field: string) => Array.isArray(rows) ? rows.filter(r => String(r?.[field] || "") >= cutoff) : [];
  const actualRepairs = withinWindow(await json(join(evidenceRoot(env),"actual-repairs.json")),"recordedAt");
  const comparisons = withinWindow(cycles,"startedAt").filter((cycle: any) => cycle.fingerprint).map((cycle: any) => {
    const proposal = (jobs as any[]).find(item => item.job.id === cycle.jobId);
    const actual = actualRepairs.filter((repair: any) => repair.appName === cycle.appName && repair.fingerprint === cycle.fingerprint);
    return { appName: cycle.appName, fingerprint: cycle.fingerprint, incidentRecordedAt: cycle.incidentRecordedAt, jobId: cycle.jobId,
      proposal: proposal ? { status: proposal.job.status, summary: proposal.job.summary, changedFiles: proposal.job.changedFiles, checks: proposal.job.checks, resolution: proposal.resolution } : { status: cycle.status, summary: cycle.summary },
      actualRepairs: actual.map((repair: any) => ({ ...repair, recurringIncidents: withinWindow(errors,"recordedAt").filter((event: any) => event.appName === repair.appName && event.fingerprint === repair.fingerprint && event.recordedAt > repair.recordedAt).length })) };
  });
  const evidence = redactSensitiveValue({ schemaVersion: "rotator.operations-evidence/v1", id: `${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID().slice(0,8)}`, capturedAt: new Date().toISOString(), window,
    machines, logSnapshot: logs, incidents: withinWindow(errors,"recordedAt"), observations: withinWindow(observations,"recordedAt"), runtime, latestRun: latestResults || rotations.at?.(-1)?.details || rotations.at?.(-1),
    rotations: withinWindow(rotations,"at"), hourlyCycles: withinWindow(cycles,"startedAt"),
    comparison: { coderProposals: jobs, incidentFixes: withinWindow(fixes,"updatedAt"), actualRepairs, comparisons },
    comparisonNote: "A generated proposal is not proof of a successful repair. Compare the diff and checks with approved commits, deployment results and live verification; manual repairs must be explicitly recorded with their incident fingerprint." });
  const folder = evidenceRoot(env); await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, evidence.id+".json"); await writeAtomicJson(file,evidence); await chmod(file,0o600);
  await writeAtomicJson(join(folder,"latest.json"),evidence); await chmod(join(folder,"latest.json"),0o600);
  // Retain every update throughout the observation window, plus a day of margin.
  const files = (await readdir(folder)).filter(name => /^\d{4}-.*\.json$/.test(name));
  const retentionCutoff = Date.now() - 48*3600000;
  for (const name of files) { const stamp = name.slice(0,24).replace(/T(\d\d)-(\d\d)-(\d\d)-(\d\d\d)Z/,"T$1:$2:$3.$4Z"); if (Date.parse(stamp) < retentionCutoff) await unlink(join(folder,name)).catch(() => undefined); }
  return evidence;
}
