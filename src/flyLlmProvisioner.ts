import { spawn } from "node:child_process";
import { readLlmControlState } from "./llmControlState.js";

const DEFAULT_APP = "spmt-llm-worker";
const DEFAULT_VOLUME = "spmt_llm_models";
const DEFAULT_REGION = "ord";
const DEFAULT_VOLUME_GB = 10;
const DEFAULT_EMBED_APP = "spmt-embed-worker";
const DEFAULT_EMBED_VOLUME = "spmt_embed_models";

export type FlyCommandResult = { command: string; ok: boolean; exitCode: number; stdout: string; stderr: string };
export type LlmProvisionResult = {
  ok: boolean;
  appName: string;
  region: string;
  volumeName: string;
  /** Retained for API compatibility. SPMT-authenticated private workers never store an API key. */
  keyStored: false;
  deployed: boolean;
  authMode: "spmt-gateway-private-network";
  status?: unknown;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
};

type WorkerDefinition = {
  appName: string;
  volumeName: string;
  volumeGb: number;
  configPath: string;
  dockerfilePath: string;
  deployDirectory: string;
  modelRepo?: string;
  modelAlias?: string;
  extraSecrets?: Record<string, string>;
};

async function enabled(env: NodeJS.ProcessEnv): Promise<boolean> {
  return (await readLlmControlState(env)).provisioningEnabled;
}

function cleanAppName(value: unknown, fallback = DEFAULT_APP): string {
  const app = String(value || fallback).trim().toLowerCase();
  if (!/^spmt-[a-z0-9-]{3,40}$/.test(app)) throw new Error("App name must begin with spmt- and contain only lowercase letters, numbers, and hyphens.");
  return app;
}

function cleanVolumeName(value: unknown, fallback: string): string {
  const volume = String(value || fallback).trim();
  if (!/^[a-zA-Z0-9_]{3,64}$/.test(volume)) throw new Error("Invalid Fly volume name");
  return volume;
}

function positiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Expected an integer between ${min} and ${max}.`);
  return parsed;
}

async function runFly(args: string[], env: NodeJS.ProcessEnv, input?: string, timeoutMs = 20 * 60_000): Promise<FlyCommandResult> {
  const token = String(env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is not configured");
  return await new Promise((resolve, reject) => {
    const child = spawn("flyctl", args, { cwd: "/app", env: { ...process.env, ...env, FLY_API_TOKEN: token, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command: `flyctl ${args.join(" ")}`, ok: code === 0, exitCode: code ?? -1, stdout: stdout.slice(-40_000), stderr: stderr.slice(-40_000) });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function summarize(result: FlyCommandResult): string {
  const text = (result.ok ? result.stdout : result.stderr || result.stdout).trim();
  return text.slice(-1200) || `exit ${result.exitCode}`;
}

function resultBase(input: {
  appName: string;
  region: string;
  volumeName: string;
  deployed: boolean;
  steps: LlmProvisionResult["steps"];
  ok?: boolean;
  status?: unknown;
}): LlmProvisionResult {
  return {
    ok: input.ok ?? false,
    appName: input.appName,
    region: input.region,
    volumeName: input.volumeName,
    keyStored: false,
    deployed: input.deployed,
    authMode: "spmt-gateway-private-network",
    status: input.status,
    steps: input.steps,
  };
}

async function parseJsonCommand(args: string[], env: NodeJS.ProcessEnv): Promise<{ result: FlyCommandResult; payload?: unknown }> {
  const result = await runFly(args, env);
  if (!result.ok) return { result };
  try { return { result, payload: JSON.parse(result.stdout) }; } catch { return { result, payload: result.stdout.trim() }; }
}

function chatWorkerDefinition(args: Record<string, unknown>, env: NodeJS.ProcessEnv): WorkerDefinition {
  return {
    appName: cleanAppName(args.appName, DEFAULT_APP),
    volumeName: cleanVolumeName(args.volumeName || env.SPMT_LLM_VOLUME_NAME, DEFAULT_VOLUME),
    volumeGb: positiveInt(args.volumeGb || env.SPMT_LLM_VOLUME_GB, DEFAULT_VOLUME_GB, 1, 100),
    configPath: "/app/llm-worker/fly.toml",
    dockerfilePath: "/app/llm-worker/Dockerfile",
    deployDirectory: "/app/llm-worker",
    modelRepo: String(args.modelRepo || env.SPMT_LLM_HF_REPO || "").trim() || undefined,
    modelAlias: String(args.modelAlias || env.SPMT_LLM_MODEL || "").trim() || undefined,
  };
}

function embeddingWorkerDefinition(args: Record<string, unknown>, env: NodeJS.ProcessEnv): WorkerDefinition {
  const modelRepo = String(args.modelRepo || env.SPMT_EMBED_HF_REPO || "nomic-ai/nomic-embed-text-v1.5-GGUF").trim();
  const modelAlias = String(args.modelAlias || env.SPMT_EMBED_MODEL || "spmt-nomic-embed").trim();
  return {
    appName: cleanAppName(args.appName, String(env.SPMT_EMBED_APP || DEFAULT_EMBED_APP)),
    volumeName: cleanVolumeName(args.volumeName || env.SPMT_EMBED_VOLUME_NAME, DEFAULT_EMBED_VOLUME),
    volumeGb: positiveInt(args.volumeGb || env.SPMT_EMBED_VOLUME_GB, 5, 1, 100),
    configPath: "/app/llm-worker/fly.toml",
    dockerfilePath: "/app/llm-worker/Dockerfile",
    deployDirectory: "/app/llm-worker",
    modelRepo,
    modelAlias,
    extraSecrets: {
      LLAMA_ARG_EMBEDDINGS: "1",
      LLAMA_ARG_POOLING: String(env.SPMT_EMBED_POOLING || "mean"),
    },
  };
}

async function removeLegacyWorkerKey(appName: string, env: NodeJS.ProcessEnv): Promise<{ ok: boolean; detail: string }> {
  const result = await runFly(["secrets", "unset", "--app", appName, "LLAMA_API_KEY"], env, undefined, 2 * 60_000);
  const combined = `${result.stdout}\n${result.stderr}`;
  const alreadyAbsent = /not found|does not exist|no secret|unknown secret/i.test(combined);
  return {
    ok: result.ok || alreadyAbsent,
    detail: result.ok
      ? "Removed legacy LLAMA_API_KEY. SPMT is the only user authentication boundary."
      : alreadyAbsent
        ? "No legacy LLAMA_API_KEY was present."
        : summarize(result),
  };
}

async function provisionWorker(definition: WorkerDefinition, args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<LlmProvisionResult> {
  if (!(await enabled(env))) throw new Error("Fly provisioning is disabled in the owner LLM control panel.");
  const { appName, volumeName } = definition;
  const region = String(args.region || env.SPMT_LLM_REGION || DEFAULT_REGION).trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(region)) throw new Error("Invalid Fly region");
  const org = String(env.FLY_ORG || env.ORG || "mtman-new").trim();
  const steps: LlmProvisionResult["steps"] = [];

  const statusBefore = await runFly(["status", "--app", appName, "--json"], env, undefined, 60_000);
  if (!statusBefore.ok) {
    const created = await runFly(["apps", "create", appName, "--org", org], env, undefined, 60_000);
    const alreadyExists = /already exists|name has already been taken/i.test(`${created.stdout}\n${created.stderr}`);
    steps.push({ name: "create-app", ok: created.ok || alreadyExists, detail: alreadyExists ? "App already exists." : summarize(created) });
    if (!created.ok && !alreadyExists) return resultBase({ appName, region, volumeName, deployed: false, steps });
  } else {
    steps.push({ name: "create-app", ok: true, detail: "App already exists." });
  }

  const volumes = await parseJsonCommand(["volumes", "list", "--app", appName, "--json"], env);
  const items = Array.isArray(volumes.payload) ? volumes.payload as Array<Record<string, unknown>> : [];
  const hasVolume = items.some((item) => String(item.name || "") === volumeName);
  if (!hasVolume) {
    const createdVolume = await runFly(["volumes", "create", volumeName, "--app", appName, "--region", region, "--size", String(definition.volumeGb), "--yes"], env, undefined, 3 * 60_000);
    steps.push({ name: "create-volume", ok: createdVolume.ok, detail: summarize(createdVolume) });
    if (!createdVolume.ok) return resultBase({ appName, region, volumeName, deployed: false, steps });
  } else {
    steps.push({ name: "create-volume", ok: true, detail: "Persistent model volume already exists." });
  }

  const removedKey = await removeLegacyWorkerKey(appName, env);
  steps.push({ name: "remove-worker-api-key", ...removedKey });
  if (!removedKey.ok) return resultBase({ appName, region, volumeName, deployed: false, steps });

  const secretValues: Record<string, string> = { ...definition.extraSecrets };
  if (definition.modelRepo) secretValues.LLAMA_ARG_HF_REPO = definition.modelRepo;
  if (definition.modelAlias) secretValues.LLAMA_ARG_ALIAS = definition.modelAlias;
  if (Object.keys(secretValues).length) {
    const secretInput = Object.entries(secretValues).map(([name, value]) => `${name}=${value}`).join("\n") + "\n";
    const setSecret = await runFly(["secrets", "import", "--app", appName], env, secretInput, 2 * 60_000);
    steps.push({
      name: "set-worker-config",
      ok: setSecret.ok,
      detail: setSecret.ok
        ? "Stored model configuration only. No authentication secret was created."
        : summarize(setSecret),
    });
    if (!setSecret.ok) return resultBase({ appName, region, volumeName, deployed: false, steps });
  } else {
    steps.push({ name: "set-worker-config", ok: true, detail: "Using model configuration from fly.toml; no secrets required." });
  }

  const deploy = await runFly(["deploy", definition.deployDirectory, "--app", appName, "--config", definition.configPath, "--dockerfile", definition.dockerfilePath, "--remote-only", "--yes"], env, undefined, 30 * 60_000);
  steps.push({ name: "deploy", ok: deploy.ok, detail: summarize(deploy) });
  if (!deploy.ok) return resultBase({ appName, region, volumeName, deployed: false, steps });

  const statusAfter = await parseJsonCommand(["status", "--app", appName, "--json"], env);
  steps.push({ name: "status", ok: statusAfter.result.ok, detail: statusAfter.result.ok ? "Private worker deployment status read successfully." : summarize(statusAfter.result) });
  return resultBase({
    ok: deploy.ok && statusAfter.result.ok,
    appName,
    region,
    volumeName,
    deployed: deploy.ok,
    status: statusAfter.payload,
    steps,
  });
}

export async function getSpmtLlmWorkerStatus(args: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const appName = cleanAppName(args.appName, DEFAULT_APP);
  const status = await parseJsonCommand(["status", "--app", appName, "--json"], env);
  return {
    ok: status.result.ok,
    appName,
    status: status.payload,
    baseUrl: `http://${appName}.internal:8080/v1`,
    authMode: "spmt-gateway-private-network",
    error: status.result.ok ? undefined : summarize(status.result),
  };
}

export async function getSpmtEmbeddingWorkerStatus(args: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const appName = cleanAppName(args.appName, String(env.SPMT_EMBED_APP || DEFAULT_EMBED_APP));
  const status = await parseJsonCommand(["status", "--app", appName, "--json"], env);
  return {
    ok: status.result.ok,
    appName,
    status: status.payload,
    baseUrl: `http://${appName}.internal:8080/v1`,
    authMode: "spmt-gateway-private-network",
    error: status.result.ok ? undefined : summarize(status.result),
  };
}

export async function provisionSpmtLlmWorker(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<LlmProvisionResult> {
  return provisionWorker(chatWorkerDefinition(args, env), args, env);
}

export async function provisionSpmtEmbeddingWorker(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<LlmProvisionResult & { baseUrl: string }> {
  const definition = embeddingWorkerDefinition(args, env);
  const result = await provisionWorker(definition, args, env);
  return { ...result, baseUrl: `http://${definition.appName}.internal:8080/v1` };
}
