import { loadConfig } from "./config.js";
import { sendDiscordReport } from "./discord.js";
import { FlyApiClient } from "./flyClient.js";
import { AppRotationResult } from "./types.js";
import { MachineRotator } from "./rotator.js";
import {
  appendStreamContinuityIncident,
  notifyStreamContinuityOwner,
  probeStreamLiveState,
  recordStreamContinuityEvent,
  waitForStreamRecovery,
} from "./streamContinuity.js";

export async function runRotationOnce(
  argv: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
  options: { skipDiscordReport?: boolean } = {}
): Promise<AppRotationResult[]> {
  const config = loadConfig(argv, env);
  const fly = new FlyApiClient({
    token: config.flyApiToken,
    hostname: config.flyApiHostname,
    minIntervalMs: Number(env.API_MIN_INTERVAL_MS ?? 400),
    maxRetries: Number(env.API_MAX_RETRIES ?? 8)
  });
  const rotator = new MachineRotator(fly, config.rotation);
  const continuityEnabled = env.STREAM_CONTINUITY_ENABLED !== "false";

  // The owner retired this expensive worker. Monitoring may still include it,
  // but a scheduled/manual rotation must never start its stopped Machine.
  const appNames = config.appNames.filter((name) => name !== "spmt-llm-worker");
  const results: AppRotationResult[] = [];

  for (const appName of appNames) {
    let beforeLive;
    if (continuityEnabled) {
      beforeLive = await probeStreamLiveState(env);
      if (beforeLive.ok) {
        await recordStreamContinuityEvent({
          kind: "pre-rotation",
          appName,
          detail: beforeLive.isLive ? "Twitch confirmed live before rotation." : "Twitch confirmed offline before rotation.",
        }, env);
      } else {
        await recordStreamContinuityEvent({ kind: "probe-error", appName, detail: beforeLive.error }, env);
      }
    }

    const result = await rotator.rotateApp(appName);
    results.push(result);

    if (continuityEnabled && beforeLive?.ok && beforeLive.isLive) {
      const immediate = await probeStreamLiveState(env);

      if (immediate.ok && immediate.isLive) {
        await recordStreamContinuityEvent({
          kind: "post-rotation",
          appName,
          detail: "Twitch remained live after rotation.",
        }, env);
      } else if (!immediate.ok) {
        result.warnings.push("Stream continuity could not be verified after rotation because the external Twitch witness was unavailable.");
        await recordStreamContinuityEvent({ kind: "probe-error", appName, detail: immediate.error }, env);
      } else {
        result.warnings.push("Twitch reported offline immediately after a rotation that began while live; waiting for recovery.");
        await recordStreamContinuityEvent({
          kind: "post-rotation",
          appName,
          detail: "Twitch reported offline immediately after rotation; recovery grace started.",
        }, env);

        let recovered = await waitForStreamRecovery(env);
        if (recovered.ok && recovered.isLive) {
          result.actions.push("Verified Twitch stream recovered within the post-rotation grace window.");
          await recordStreamContinuityEvent({
            kind: "recovered",
            appName,
            detail: "Twitch recovered during the normal post-rotation grace window.",
          }, env);
        } else {
          result.warnings.push("Twitch did not recover during the normal grace window; attempting one bounded recovery rotation.");
          const retry = await rotator.rotateApp(appName);
          result.actions.push(...retry.actions.map((action) => `Recovery: ${action}`));
          result.warnings.push(...retry.warnings.map((warning) => `Recovery: ${warning}`));
          if (!retry.success && retry.error) result.warnings.push(`Recovery rotation error: ${retry.error}`);

          recovered = await waitForStreamRecovery(
            env,
            Number(env.STREAM_CONTINUITY_SECOND_RECOVERY_TIMEOUT_MS || 120_000),
          );

          if (recovered.ok && recovered.isLive) {
            result.actions.push("Verified Twitch stream recovered after the bounded recovery rotation.");
            await recordStreamContinuityEvent({
              kind: "recovered",
              appName,
              detail: "Twitch recovered after one bounded recovery rotation.",
            }, env);
            await notifyStreamContinuityOwner(
              `Twitch stream **${recovered.login}** briefly dropped during the 12-hour rotation of **${appName}**, but the rotator recovered it automatically and confirmed the stream is live again.`,
              env,
            );
          } else {
            const message =
              `Twitch stream was confirmed live before rotating ${appName}, went offline after the rotation, and failed to recover after one bounded recovery attempt.`;
            result.success = false;
            result.error = result.error ? `${result.error}; ${message}` : message;
            await recordStreamContinuityEvent({ kind: "recovery-failed", appName, detail: message }, env);
            await appendStreamContinuityIncident(appName, message, env);
            await notifyStreamContinuityOwner(
              `🚨 Twitch stream continuity failed during the 12-hour rotation of **${appName}**. The stream was live before maintenance, remained offline after the recovery window, and one bounded recovery rotation did not restore it. The remaining app rotations were stopped and Athena/MtFixIt now has the incident evidence.`,
              env,
            );
          }
        }
      }
    }

    const prefix = result.success ? "OK" : "FAIL";
    console.log(`${prefix} ${result.appName}: ${result.previousActiveId ?? "none"} -> ${result.newActiveId ?? "none"}`);
    for (const warning of result.warnings) console.warn(`WARN ${result.appName}: ${warning}`);
    if (result.error) console.error(`ERROR ${result.appName}: ${result.error}`);

    if (!result.success && result.error?.includes("Twitch stream was confirmed live before rotating")) {
      console.error("Stopping remaining app rotations because stream continuity recovery failed.");
      break;
    }
  }

  if (!options.skipDiscordReport) {
    await sendDiscordReport(config.discordWebhookUrl, results);
  }
  return results;
}
