import { parseAppNames } from "./config.js";
import { FlyApiClient } from "./flyClient.js";
import { redactSensitiveText } from "./redaction.js";
import type { FlyMachine, FlyMachineCheck } from "./types.js";

export type RecentFlyLog = {
  appName: string;
  machineId?: string;
  region?: string;
  level?: string;
  timestamp?: string;
  observedAt: string;
  message: string;
};

const MAX_RECENT_LOGS = 2_000;
const recentLogs: RecentFlyLog[] = [];
const logBufferStartedAt = new Date().toISOString();

export function getManagedFlyApps(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseAppNames(env.FLY_ROTATOR_APPS ?? env.MANAGED_FLY_APPS ?? "");
}

export function recordRecentFlyLog(input: Omit<RecentFlyLog, "observedAt"> & { observedAt?: string }): void {
  const appName = String(input.appName || "").trim();
  if (!appName) return;
  recentLogs.push({
    appName,
    machineId: input.machineId ? String(input.machineId) : undefined,
    region: input.region ? String(input.region) : undefined,
    level: input.level ? String(input.level) : undefined,
    timestamp: input.timestamp ? String(input.timestamp) : undefined,
    observedAt: input.observedAt || new Date().toISOString(),
    message: redactSensitiveText(String(input.message || "")).slice(0, 4_000),
  });
  if (recentLogs.length > MAX_RECENT_LOGS) recentLogs.splice(0, recentLogs.length - MAX_RECENT_LOGS);
}

export function getRecentFlyLogs(args: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const allowed = new Set(getManagedFlyApps(env));
  const requestedApp = String(args.appName || "").trim();
  if (requestedApp && !allowed.has(requestedApp)) {
    throw new Error(`App ${requestedApp} is not in the managed Fly app allowlist.`);
  }
  const rawLimit = Number(args.limit ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, Math.floor(rawLimit))) : 100;
  const errorsOnly = args.errorsOnly === true;
  const errorPattern = /\berror\b|\bexception\b|\bfatal\b|\bpanic\b|\bfailed\b|\bunhandled\b|\brejection\b/i;
  const filtered = recentLogs.filter((entry) => {
    if (!allowed.has(entry.appName)) return false;
    if (requestedApp && entry.appName !== requestedApp) return false;
    if (errorsOnly && !errorPattern.test(entry.message)) return false;
    return true;
  });
  return {
    source: "fly-nats-live-log-stream",
    bufferStartedAt: logBufferStartedAt,
    bufferedEntries: recentLogs.length,
    appName: requestedApp || null,
    errorsOnly,
    logs: filtered.slice(-limit),
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
  const logs = getRecentFlyLogs({ appName: requestedApp, limit: args.limit ?? 100, errorsOnly: args.errorsOnly === true }, env);
  return { states, logs };
}
