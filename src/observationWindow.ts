import { mkdir, readFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeAtomicJson } from "./atomicJson.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";

export type ObservationWindow = { startedAt: string; endsAt: string; archiveDir: string; clearedEvents: number; clearedObservations: number };
export async function readObservationWindow(env: NodeJS.ProcessEnv = process.env): Promise<ObservationWindow | undefined> {
  try { return JSON.parse(await readFile(env.ROTATOR_ERROR_BASELINE_FILE || "/data/error-baseline.json", "utf8")); } catch { return undefined; }
}
let stateChain: Promise<unknown> = Promise.resolve();
export function withObservationStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = stateChain.catch(() => undefined).then(operation);
  stateChain = result;
  return result;
}
export async function clearObservationWindow(env: NodeJS.ProcessEnv = process.env, now?: Date): Promise<ObservationWindow> {
  return withObservationStateLock(() => resetObservationWindow(env, now || new Date()));
}
async function resetObservationWindow(env: NodeJS.ProcessEnv, now: Date): Promise<ObservationWindow> {
  const archiveDir = join(env.ROTATOR_ERROR_ARCHIVE_DIR || "/data/error-archives", now.toISOString().replace(/[:.]/g, "-"));
  await mkdir(archiveDir, { recursive: true, mode: 0o700 });
  const files = [env.LOG_ERROR_HISTORY_FILE || "/data/error-history.json", env.LOG_OBSERVATION_HISTORY_FILE || "/data/observed-incidents.json", env.LOG_ERROR_DEDUPE_FILE || "/data/error-fingerprints.json"];
  const counts: number[] = [];
  for (const file of files) {
    let value: unknown = [];
    try { const raw = await readFile(file, "utf8"); try { value = redactSensitiveValue(JSON.parse(raw)); } catch { value = redactSensitiveText(raw); } }
    catch (error: any) { if (error.code !== "ENOENT") throw error; }
    counts.push(Array.isArray(value) ? value.length : 0);
    const target = join(archiveDir, file.split("/").at(-1)!.replace(/\.json$/, ".redacted.json"));
    await writeAtomicJson(target, value); await chmod(target, 0o600);
  }
  const window: ObservationWindow = { startedAt: now.toISOString(), endsAt: new Date(now.getTime() + 86400000).toISOString(), archiveDir, clearedEvents: counts[0], clearedObservations: counts[1] };
  const baseline = env.ROTATOR_ERROR_BASELINE_FILE || "/data/error-baseline.json";
  await mkdir(dirname(baseline), { recursive: true });
  // Publish the cutoff first so replayed old log lines cannot repopulate the queue.
  await writeAtomicJson(baseline, window);
  for (const file of files) { await mkdir(dirname(file), { recursive: true }); await writeAtomicJson(file, []); }
  // Fix proposals, known fixes, approvals and coder artifacts remain intact.
  return window;
}
