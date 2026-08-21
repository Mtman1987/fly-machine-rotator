import { execFile } from "node:child_process";
import { parseAppNames } from "./config.js";
import { FlyApiClient } from "./flyClient.js";
import { redactSensitiveText } from "./redaction.js";
import { executeTrackedRotation } from "./rotationControl.js";
import { getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";
import type { AppRotationResult } from "./types.js";

const STREAMWEAVER_APP = "streamweaver-new";
const EXEC_TIMEOUT_MS = 25_000;
const OUTPUT_START = "__SIGNAL_RUNTIME_BEGIN__";
const OUTPUT_END = "__SIGNAL_RUNTIME_END__";
const DEFAULT_SIGNAL_LIMIT = 25;
const MAX_SIGNAL_LIMIT = 100;

const SIGNAL_HISTORY_SCRIPT = String.raw`
const fs=require('fs'),path=require('path');
const root=process.env.PERSIST_ROOT||path.resolve(process.cwd(),'data','runtime');
const globalRoot=path.join(root,'global');
const historyFile=path.join(globalRoot,'signal-hint-history.json');
const schedulerFile=path.join(globalRoot,'signal-scheduler.json');
const limit=Math.min(${MAX_SIGNAL_LIMIT},Math.max(1,Math.floor(Number(process.argv[1]||${DEFAULT_SIGNAL_LIMIT})||${DEFAULT_SIGNAL_LIMIT})));
function readJson(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
const historyState=readJson(historyFile,{totalPosts:0,uniqueChannelIds:[],history:[]});
const scheduler=readJson(schedulerFile,null);
const history=Array.isArray(historyState.history)?historyState.history:[];
const latestPosts=history.slice(-limit).map((entry)=>({
  at:String(entry&&entry.at||''),
  guildId:String(entry&&entry.guildId||''),
  channelId:String(entry&&entry.channelId||''),
  channelName:String(entry&&entry.channelName||'').slice(0,120),
}));
const nextAt=Number(scheduler&&scheduler.nextAt||0);
const payload={
  schedulerEnabled:process.env.SIGNAL_SCHEDULER_ENABLED!=='false',
  totalPosts:Math.max(0,Number(historyState.totalPosts||0)),
  uniqueChannelCount:Array.isArray(historyState.uniqueChannelIds)?new Set(historyState.uniqueChannelIds.map(String)).size:0,
  lastPostAt:typeof historyState.lastPostAt==='string'?historyState.lastPostAt:null,
  latestPosts,
  scheduler:scheduler?{
    guildId:String(scheduler.guildId||''),
    lastChannelId:String(scheduler.lastChannelId||''),
    bagRemaining:Array.isArray(scheduler.bag)?scheduler.bag.length:0,
    nextAt:Number.isFinite(nextAt)&&nextAt>0?nextAt:null,
    nextAtIso:Number.isFinite(nextAt)&&nextAt>0?new Date(nextAt).toISOString():null,
    dueInMs:Number.isFinite(nextAt)&&nextAt>0?nextAt-Date.now():null,
  }:null,
  historyFilePresent:fs.existsSync(historyFile),
  schedulerFilePresent:fs.existsSync(schedulerFile),
};
process.stdout.write('${OUTPUT_START}'+JSON.stringify(payload)+'${OUTPUT_END}');
`;

type ExecResult = { stdout: string; stderr: string };
type SignalHistoryEntry = { at: string; guildId: string; channelId: string; channelName: string };
type SignalSchedulerSnapshot = {
  guildId: string;
  lastChannelId: string;
  bagRemaining: number;
  nextAt: number | null;
  nextAtIso: string | null;
  dueInMs: number | null;
};
type SignalHistoryPayload = {
  schedulerEnabled: boolean;
  totalPosts: number;
  uniqueChannelCount: number;
  lastPostAt: string | null;
  latestPosts: SignalHistoryEntry[];
  scheduler: SignalSchedulerSnapshot | null;
  historyFilePresent: boolean;
  schedulerFilePresent: boolean;
};
export type OwnerFlyctlRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;
export type OwnerMachineResolver = (env: NodeJS.ProcessEnv) => Promise<string>;
export type OwnerRotationExecutor = (
  argv?: string[],
  env?: NodeJS.ProcessEnv,
  trigger?: string,
) => Promise<AppRotationResult[]>;

function defaultFlyctlRunner(args: string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "fly",
      args,
      {
        env,
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`fixed Fly Machine read failed: ${redactSensitiveText(String(stderr || error.message)).trim().slice(0, 2_000)}`));
          return;
        }
        resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
      },
    );
  });
}

function managedApps(env: NodeJS.ProcessEnv): string[] {
  return parseAppNames(env.FLY_ROTATOR_APPS ?? env.MANAGED_FLY_APPS ?? "");
}

function requireRuntimeConfiguration(env: NodeJS.ProcessEnv): string {
  if (!managedApps(env).includes(STREAMWEAVER_APP)) {
    throw new Error(`${STREAMWEAVER_APP} is not in the Rotator managed Fly app allowlist.`);
  }
  const token = String(env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is not configured on the Rotator.");
  return token;
}

async function activeStreamWeaverMachine(env: NodeJS.ProcessEnv): Promise<string> {
  const token = requireRuntimeConfiguration(env);
  const client = new FlyApiClient({
    token,
    hostname: env.FLY_API_HOSTNAME,
    minIntervalMs: Number(env.API_MIN_INTERVAL_MS || 400),
    maxRetries: Number(env.API_MAX_RETRIES || 4),
  });
  const machines = await client.listMachines(STREAMWEAVER_APP);
  const machine = machines.find((candidate) => candidate.state === "started")
    ?? machines.find((candidate) => candidate.state === "starting");
  if (!machine?.id) throw new Error(`${STREAMWEAVER_APP} has no running Machine available for signal history inspection.`);
  return machine.id;
}

function positiveSignalLimit(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SIGNAL_LIMIT;
  return Math.min(MAX_SIGNAL_LIMIT, Math.max(1, Math.floor(parsed)));
}

function parseMarkedJson<T>(stdout: string): T {
  const start = stdout.indexOf(OUTPUT_START);
  const end = stdout.indexOf(OUTPUT_END, start + OUTPUT_START.length);
  if (start < 0 || end < 0) throw new Error("Fly Machine returned an invalid signal-history response.");
  return JSON.parse(stdout.slice(start + OUTPUT_START.length, end)) as T;
}

function sanitizeRotationResult(result: AppRotationResult): AppRotationResult {
  return {
    ...result,
    actions: result.actions.map((value) => redactSensitiveText(String(value)).slice(0, 1_000)),
    warnings: result.warnings.map((value) => redactSensitiveText(String(value)).slice(0, 1_000)),
    error: result.error ? redactSensitiveText(result.error).slice(0, 2_000) : undefined,
  };
}

export async function runOwnerRotation(
  env: NodeJS.ProcessEnv = process.env,
  executor: OwnerRotationExecutor = executeTrackedRotation,
) {
  const startedAt = new Date().toISOString();
  const results = (await executor([], env, "mcp-owner")).map(sanitizeRotationResult);
  const finishedAt = new Date().toISOString();
  const state = await RotatorRuntimeStateStore.load(getRuntimeStateFile(env));
  const runtimeState = state.snapshot();
  const succeeded = results.filter((result) => result.success).length;
  return {
    ok: results.every((result) => result.success),
    trigger: "mcp-owner",
    startedAt,
    finishedAt,
    appCount: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
    runtimeState: {
      ...runtimeState,
      lastError: runtimeState.lastError ? redactSensitiveText(runtimeState.lastError).slice(0, 2_000) : undefined,
      lastRunLines: runtimeState.lastRunLines.map((line) => redactSensitiveText(line).slice(0, 1_000)),
    },
  };
}

export async function getSignalHintHistory(
  args: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
  runner: OwnerFlyctlRunner = defaultFlyctlRunner,
  machineResolver: OwnerMachineResolver = activeStreamWeaverMachine,
) {
  const token = requireRuntimeConfiguration(env);
  const machineId = await machineResolver(env);
  const limit = positiveSignalLimit(args.limit);
  const childEnv = {
    ...env,
    FLY_API_TOKEN: token,
    FLY_ACCESS_TOKEN: token,
  };
  const result = await runner([
    "machine",
    "exec",
    "--app",
    STREAMWEAVER_APP,
    "--timeout",
    "20",
    machineId,
    "node",
    "-e",
    SIGNAL_HISTORY_SCRIPT,
    String(limit),
  ], childEnv);
  const payload = parseMarkedJson<SignalHistoryPayload>(result.stdout);
  return {
    source: "fixed-readonly-fly-machine-exec",
    appName: STREAMWEAVER_APP,
    machineId,
    readAt: new Date().toISOString(),
    limit,
    ...payload,
  };
}

export const ownerRuntimePolicy = {
  streamWeaverApp: STREAMWEAVER_APP,
  defaultSignalLimit: DEFAULT_SIGNAL_LIMIT,
  maxSignalLimit: MAX_SIGNAL_LIMIT,
  acceptsArbitraryApp: false,
  acceptsArbitraryPath: false,
  acceptsArbitraryCommand: false,
} as const;
