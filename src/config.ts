import { RotationOptions } from "./types.js";

export interface AppConfig {
  appNames: string[];
  flyApiToken: string;
  flyApiHostname: string;
  discordWebhookUrl?: string;
  rotation: RotationOptions;
}

export function loadConfig(argv: string[], env: NodeJS.ProcessEnv = process.env): AppConfig {
  const appNames = parseAppNames(env.FLY_ROTATOR_APPS ?? env.MANAGED_FLY_APPS ?? "");
  if (appNames.length === 0) {
    throw new Error("Set FLY_ROTATOR_APPS to a JSON array or comma-separated list of Fly app names.");
  }

  const flyApiToken = env.FLY_API_TOKEN;
  if (!flyApiToken) {
    throw new Error("Set FLY_API_TOKEN.");
  }

  return {
    appNames,
    flyApiToken,
    flyApiHostname: env.FLY_API_HOSTNAME ?? "https://api.machines.dev",
    discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
    rotation: {
      dryRun: argv.includes("--dry-run") || env.DRY_RUN === "true",
      healthTimeoutMs: numberEnv(env.HEALTH_TIMEOUT_MS, 300_000),
      healthPollIntervalMs: numberEnv(env.HEALTH_POLL_INTERVAL_MS, 5_000),
      stopTimeoutSeconds: numberEnv(env.STOP_TIMEOUT_SECONDS, 60),
      leaseTtlSeconds: numberEnv(env.LEASE_TTL_SECONDS, 900),
      requireHealthChecks: env.REQUIRE_HEALTH_CHECKS === "true",
      allowVolumeRotation: env.ALLOW_VOLUME_ROTATION === "true",
      allowMultiMachineServices: env.ALLOW_MULTI_MACHINE_SERVICES === "true",
      restartUnsafeApps: env.RESTART_UNSAFE_APPS !== "false",
      restartStartRetries: numberEnv(env.RESTART_START_RETRIES, 8),
      restartStartRetryDelayMs: numberEnv(env.RESTART_START_RETRY_DELAY_MS, 10_000)
    }
  };
}

export function parseAppNames(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      throw new Error("FLY_ROTATOR_APPS JSON must be an array of strings.");
    }
    return normalizeAppNames(parsed);
  }
  return normalizeAppNames(trimmed.split(","));
}

function normalizeAppNames(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function numberEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Expected positive number, got ${value}.`);
  }
  return parsed;
}
