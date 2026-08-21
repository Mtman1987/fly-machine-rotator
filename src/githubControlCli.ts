import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getManagedFlyAppStates, getManagedFlyApps, sampleManagedFlyLogs } from "./flyObservability.js";
import { getSignalHintHistory, runOwnerRotation } from "./ownerRuntimeOps.js";
import { redactSensitiveText } from "./redaction.js";

const execFileAsync = promisify(execFile);
const OUTPUT_START = "__ROTATOR_CONTROL_BEGIN__";
const OUTPUT_END = "__ROTATOR_CONTROL_END__";
const MAX_DESCRIPTION = 4_000;
const MAX_LOG_LIMIT = 200;
const MAX_SIGNAL_LIMIT = 100;

type ControlPayload = {
  command?: unknown;
  appName?: unknown;
  limit?: unknown;
  errorsOnly?: unknown;
  description?: unknown;
};

function text(value: unknown, max = 120): string {
  return String(value ?? "").trim().slice(0, max);
}

function positiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
}

export function decodeControlPayload(encoded: string): ControlPayload {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(encoded)) throw new Error("Invalid control payload encoding.");
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (decoded.length > 8_000) throw new Error("Control payload is too large.");
  const payload = JSON.parse(decoded) as ControlPayload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Control payload must be an object.");
  return payload;
}

function requireManagedApp(value: unknown, env: NodeJS.ProcessEnv): string | undefined {
  const appName = text(value);
  if (!appName) return undefined;
  if (!getManagedFlyApps(env).includes(appName)) throw new Error(`App ${appName} is not in the managed Fly app allowlist.`);
  return appName;
}

async function submitRepair(payload: ControlPayload, env: NodeJS.ProcessEnv) {
  const appName = requireManagedApp(payload.appName, env);
  const description = text(payload.description, MAX_DESCRIPTION);
  if (!appName || !description) throw new Error("repair requires an allowlisted appName and description.");
  const { stdout, stderr } = await execFileAsync(
    "node",
    ["scripts/athena-code.mjs", "submit", appName, description],
    { env, timeout: 90_000, maxBuffer: 2 * 1024 * 1024, encoding: "utf8" },
  );
  const raw = String(stdout || "").trim();
  let result: unknown = raw;
  try { result = JSON.parse(raw); } catch { /* preserve bounded text */ }
  return {
    source: "athena-cli-direct",
    appName,
    result,
    stderr: stderr ? redactSensitiveText(String(stderr)).slice(0, 2_000) : undefined,
  };
}

export async function executeGithubControl(payload: ControlPayload, env: NodeJS.ProcessEnv = process.env) {
  const command = text(payload.command, 40).toLowerCase();
  if (command === "rotate") return await runOwnerRotation(env);
  if (command === "states") {
    const appName = requireManagedApp(payload.appName, env);
    return await getManagedFlyAppStates(env, appName);
  }
  if (command === "signal") {
    return await getSignalHintHistory({ limit: positiveInt(payload.limit, 25, MAX_SIGNAL_LIMIT) }, env);
  }
  if (command === "logs") {
    const appName = requireManagedApp(payload.appName, env);
    return await sampleManagedFlyLogs({
      appName,
      limit: positiveInt(payload.limit, 50, MAX_LOG_LIMIT),
      durationMs: 2_000,
      errorsOnly: payload.errorsOnly === true,
    }, env);
  }
  if (command === "repair") return await submitRepair(payload, env);
  throw new Error("Unsupported command. Use rotate, states, signal, logs, or repair.");
}

function emit(value: unknown) {
  process.stdout.write(`${OUTPUT_START}${JSON.stringify(value)}${OUTPUT_END}`);
}

async function main() {
  const encoded = String(process.argv[2] || "").trim();
  try {
    const payload = decodeControlPayload(encoded);
    const result = await executeGithubControl(payload, process.env);
    emit({ ok: true, command: text(payload.command, 40).toLowerCase(), result });
  } catch (error) {
    emit({ ok: false, error: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 4_000) });
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith("githubControlCli.js")) {
  void main();
}
