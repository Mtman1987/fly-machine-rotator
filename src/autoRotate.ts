import { readFile } from "node:fs/promises";
import { executeTrackedRotation, FAILURE_RETRY_MS, SUCCESS_INTERVAL_MS } from "./rotationControl.js";
import { getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";

type RotationHistoryEntry = { at?: string };

export async function startAutoRotationLoop(argv: string[] = [], env: NodeJS.ProcessEnv = process.env): Promise<never> {
  const historyFile = env.ROTATION_HISTORY_FILE ?? "/data/rotation-history.json";
  const runtime = await RotatorRuntimeStateStore.load(getRuntimeStateFile(env));

  for (;;) {
    let nextDelayMs = await getNextRotationDelayMs(historyFile);
    if (nextDelayMs > 0) {
      console.log(`auto-rotation sleeping for ${Math.ceil(nextDelayMs / 1000)}s`);
    }
    while (nextDelayMs > 0) {
      await runtime.setNextRunAt(new Date(Date.now() + nextDelayMs).toISOString());
      await sleep(Math.min(nextDelayMs, 60_000));
      nextDelayMs = await getNextRotationDelayMs(historyFile);
    }

    console.log("auto-rotation starting");
    try {
      const results = await executeTrackedRotation(argv, env, "auto");
      const allSucceeded = results.every((result) => result.success);
      nextDelayMs = allSucceeded ? SUCCESS_INTERVAL_MS : FAILURE_RETRY_MS;
      await runtime.setNextRunAt(new Date(Date.now() + nextDelayMs).toISOString());
      console.log(`auto-rotation finished; next run in ${Math.ceil(nextDelayMs / 1000)}s`);
    } catch (error) {
      nextDelayMs = FAILURE_RETRY_MS;
      await runtime.setNextRunAt(new Date(Date.now() + nextDelayMs).toISOString());
      console.error(`auto-rotation failed; retrying in ${Math.ceil(nextDelayMs / 1000)}s`);
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    }
  }
}

export async function getNextRotationDelayMs(
  historyFile: string,
  now = Date.now(),
  intervalMs = SUCCESS_INTERVAL_MS
): Promise<number> {
  const lastRotationAt = await readLatestRotationAt(historyFile);
  if (!lastRotationAt) return 0;
  return Math.max(0, lastRotationAt + intervalMs - now);
}

export async function readLatestRotationAt(historyFile: string): Promise<number | undefined> {
  try {
    const content = await readFile(historyFile, "utf8");
    const parsed = JSON.parse(content) as RotationHistoryEntry[];
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const latest = parsed.at(-1)?.at;
    if (!latest) return undefined;
    const timestamp = Date.parse(latest);
    return Number.isFinite(timestamp) ? timestamp : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
