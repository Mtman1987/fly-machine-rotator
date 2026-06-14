import { loadConfig } from "./config.js";
import { sendDiscordReport } from "./discord.js";
import { runRotationOnce } from "./rotationRunner.js";
import { getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";
import { AppRotationResult } from "./types.js";

export const SUCCESS_INTERVAL_MS = 12 * 60 * 60 * 1000;
export const FAILURE_RETRY_MS = 60 * 60 * 1000;
let inFlightRotation: Promise<AppRotationResult[]> | undefined;

export async function executeTrackedRotation(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  trigger = "manual"
): Promise<AppRotationResult[]> {
  if (inFlightRotation) return inFlightRotation;
  const runPromise = executeTrackedRotationInner(argv, env, trigger);
  inFlightRotation = runPromise.finally(() => {
    if (inFlightRotation === runPromise) inFlightRotation = undefined;
  });
  return inFlightRotation;
}

async function executeTrackedRotationInner(
  argv: string[],
  env: NodeJS.ProcessEnv,
  trigger: string
): Promise<AppRotationResult[]> {
  const store = await RotatorRuntimeStateStore.load(getRuntimeStateFile(env));
  const config = loadConfig(argv, env);
  const startedAt = new Date();
  await store.markRunning(trigger, startedAt.toISOString());

  try {
    const results = await runRotationOnce(argv, env, { skipDiscordReport: true });
    const finishedAt = new Date();
    const nextRunAt = new Date(finishedAt.getTime() + computeNextIntervalMs(results)).toISOString();
    await store.markFinished(trigger, finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), results, nextRunAt);
    await sendDiscordReport(config.discordWebhookUrl, results);
    return results;
  } catch (error) {
    const finishedAt = new Date();
    const nextRunAt = new Date(finishedAt.getTime() + FAILURE_RETRY_MS).toISOString();
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    await store.markCrashed(trigger, finishedAt.toISOString(), finishedAt.getTime() - startedAt.getTime(), message, nextRunAt);
    throw error;
  }
}

export function computeNextIntervalMs(results: AppRotationResult[]): number {
  return results.every((result) => result.success) ? SUCCESS_INTERVAL_MS : FAILURE_RETRY_MS;
}
