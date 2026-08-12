import { connect, StringCodec } from "nats";
import { parseAppNames } from "./config.js";
import { FlyApiClient } from "./flyClient.js";
import { redactSensitiveText } from "./redaction.js";
import type { FlyMachine, FlyMachineCheck } from "./types.js";

export type SampledFlyLog = {
  appName: string;
  machineId?: string;
  region?: string;
  level?: string;
  timestamp?: string;
  observedAt: string;
  message: string;
};

export function getManagedFlyApps(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAppNames(env.FLY_ROTATOR_APPS ?? env.MANAGED_FLY_APPS ?? "");
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

function parseLogSubject(subject: string): { appName: string; region: string; machineId: string } | null {
  const [prefix, appName, region, machineId] = String(subject || "").split(".");
  if (prefix !== "logs" || !appName || !region || !machineId) return null;
  return { appName, region, machineId };
}

function sampledLog(subject: { appName: string; region: string; machineId: string }, payload: string): SampledFlyLog {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(payload);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // Plain-text Fly log lines are valid too.
  }
  const firstString = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.length > 0);
  const message = firstString(parsed?.message, parsed?.msg, parsed?.log, parsed?.event, parsed?.output) || payload;
  return {
    appName: subject.appName,
    machineId: firstString(parsed?.machine_id, parsed?.machine, parsed?.instance, parsed?.id) || subject.machineId,
    region: firstString(parsed?.region) || subject.region,
    level: firstString(parsed?.level),
    timestamp: firstString(parsed?.timestamp, parsed?.time, parsed?.ts),
    observedAt: new Date().toISOString(),
    message: redactSensitiveText(message).slice(0, 4_000),
  };
}

export async function sampleManagedFlyLogs(args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const allowedApps = getManagedFlyApps(env);
  if (!allowedApps.length) throw new Error("No managed Fly apps are configured.");
  const allowed = new Set(allowedApps);
  const requestedApp = String(args.appName || "").trim();
  if (requestedApp && !allowed.has(requestedApp)) throw new Error(`App ${requestedApp} is not in the managed Fly app allowlist.`);
  const token = String(env.FLY_LOG_TOKEN || env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_LOG_TOKEN or FLY_API_TOKEN is not configured on the rotator.");
  const org = String(env.FLY_ORG || env.ORG || "").trim();
  if (!org) throw new Error("FLY_ORG is not configured on the rotator.");

  const limit = positiveInt(args.limit, 100, 500);
  const durationMs = Math.max(500, Math.min(10_000, positiveInt(args.durationMs, 2_000, 10_000)));
  const errorsOnly = args.errorsOnly === true;
  const errorPattern = /\berror\b|\bexception\b|\bfatal\b|\bpanic\b|\bfailed\b|\bunhandled\b|\brejection\b/i;
  const codec = StringCodec();
  const logs: SampledFlyLog[] = [];
  const nc = await connect({
    servers: "[fdaa::3]:4223",
    user: org,
    pass: token,
    name: "mtman-machine-rotator-mcp-log-sample",
  });
  const subscription = nc.subscribe("logs.>");
  const timer = setTimeout(() => subscription.unsubscribe(), durationMs);
  try {
    for await (const incoming of subscription) {
      const subject = parseLogSubject(incoming.subject);
      if (!subject || !allowed.has(subject.appName)) continue;
      if (requestedApp && subject.appName !== requestedApp) continue;
      const entry = sampledLog(subject, codec.decode(incoming.data));
      if (errorsOnly && !errorPattern.test(entry.message)) continue;
      logs.push(entry);
      if (logs.length >= limit) {
        subscription.unsubscribe();
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    await nc.drain().catch(() => nc.close());
  }

  return {
    source: "fly-nats-live-log-stream",
    sampledAt: new Date().toISOString(),
    sampleDurationMs: durationMs,
    appName: requestedApp || null,
    configuredAppCount: allowedApps.length,
    errorsOnly,
    logs,
  };
}

function checksOf(machine: FlyMachine): Array<{ name?: string; status?: string; output?: string; updatedAt?: string }> {
  const raw = machine.checks;
  if (!raw) return [];
  const values: FlyMachineCheck[] = Array.isArray(raw) ? raw : Object.values(raw);
  return values.map((check) => ({
    name: check.name,
    status: check.status,
    output: check.output ? redactSensitiveText(String(check.output)).slice(0, 1_000) : undefined,
    updatedAt: check.updated_at,
  }));
}

function sanitizeMachine(machine: FlyMachine) {
  return {
    id: machine.id,
    name: machine.name || null,
    state: machine.state,
    region: machine.region || null,
    createdAt: machine.created_at || null,
    updatedAt: machine.updated_at || null,
    checks: checksOf(machine),
  };
}

function summarizeApp(appName: string, machines: FlyMachine[]) {
  const sanitizedMachines = machines.map(sanitizeMachine);
  const states = sanitizedMachines.reduce<Record<string, number>>((acc, machine) => {
    acc[machine.state] = (acc[machine.state] || 0) + 1;
    return acc;
  }, {});
  const failingChecks = sanitizedMachines.flatMap((machine) => machine.checks)
    .filter((check) => check.status && !/^(?:passing|pass|healthy|ok)$/i.test(check.status));
  const active = sanitizedMachines.some((machine) => /^(?:started|starting)$/i.test(machine.state));
  const status = failingChecks.length > 0 ? "degraded" : active ? "running" : sanitizedMachines.length ? "stopped" : "no-machines";
  return {
    appName,
    status,
    machineCount: sanitizedMachines.length,
    states,
    failingCheckCount: failingChecks.length,
    machines: sanitizedMachines,
  };
}

export async function getManagedFlyAppStates(env: NodeJS.ProcessEnv = process.env, requestedApp?: string) {
  const appNames = getManagedFlyApps(env);
  if (!appNames.length) throw new Error("No managed Fly apps are configured.");
  if (requestedApp && !appNames.includes(requestedApp)) throw new Error(`App ${requestedApp} is not in the managed Fly app allowlist.`);
  const token = String(env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is not configured on the rotator.");
  const client = new FlyApiClient({
    token,
    hostname: env.FLY_API_HOSTNAME,
    minIntervalMs: Number(env.API_MIN_INTERVAL_MS || 400),
    maxRetries: Number(env.API_MAX_RETRIES || 4),
  });
  const selected = requestedApp ? [requestedApp] : appNames;
  const apps: Array<Record<string, unknown>> = [];
  for (const appName of selected) {
    try {
      const machines = await client.listMachines(appName);
      apps.push(summarizeApp(appName, machines));
    } catch (error) {
      apps.push({
        appName,
        status: "error",
        machineCount: null,
        states: {},
        failingCheckCount: null,
        machines: [],
        error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      });
    }
  }
  return {
    source: "fly-machines-api",
    generatedAt: new Date().toISOString(),
    org: String(env.FLY_ORG || env.ORG || "") || null,
    configuredAppCount: appNames.length,
    apps,
  };
}

export async function getFlyObservabilitySnapshot(args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const requestedApp = String(args.appName || "").trim() || undefined;
  const states = await getManagedFlyAppStates(env, requestedApp);
  const logs = await sampleManagedFlyLogs({ appName: requestedApp, limit: args.limit ?? 100, durationMs: args.durationMs ?? 2_000, errorsOnly: args.errorsOnly === true }, env);
  return { states, logs };
}
