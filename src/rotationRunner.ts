import { loadConfig } from "./config.js";
import { sendDiscordReport } from "./discord.js";
import { FlyApiClient } from "./flyClient.js";
import { AppRotationResult } from "./types.js";
import { MachineRotator } from "./rotator.js";

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
  const results = await rotator.rotateApps(config.appNames);

  for (const result of results) {
    const prefix = result.success ? "OK" : "FAIL";
    console.log(`${prefix} ${result.appName}: ${result.previousActiveId ?? "none"} -> ${result.newActiveId ?? "none"}`);
    for (const warning of result.warnings) console.warn(`WARN ${result.appName}: ${warning}`);
    if (result.error) console.error(`ERROR ${result.appName}: ${result.error}`);
  }

  if (!options.skipDiscordReport) {
    await sendDiscordReport(config.discordWebhookUrl, results);
  }
  return results;
}
