import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_APP = "spmt-llm-worker";
const DEFAULT_VOLUME = "spmt_llm_models";
const DEFAULT_REGION = "ord";
const DEFAULT_VOLUME_GB = 10;
const DEFAULT_KEY_FILE = "/data/spmt-llm-worker-api-key";

export type FlyCommandResult = {
  command: string;
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type LlmProvisionResult = {
  ok: boolean;
  appName: string;
  region: string;
  volumeName: string;
  keyStored: boolean;
  deployed: boolean;
  status?: unknown;
  steps: Array<{ name: string; ok: boolean; detail: string }>;
};

function enabled(env: NodeJS.ProcessEnv): boolean {
  return String(env.MCP_ALLOW_FLY_PROVISIONING || "").trim().toLowerCase() === "true";
}

function cleanAppName(value: unknown): string {
  const app = String(value || DEFAULT_APP).trim().toLowerCase();
  if (!/^spmt-[a-z0-9-]{3,40}$/.test(app)) throw new Error("App name must begin with spmt- and contain only lowercase letters, numbers, and hyphens.");
  return app;
}

async function runFly(args: string[], env: NodeJS.ProcessEnv, input?: string, timeoutMs = 20 * 60_000): Promise<FlyCommandResult> {
  const token = String(env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is not configured");
  return await new Promise((resolve, reject) => {
    const child = spawn("fly", args, {
      cwd: "/app",
      env: { ...process.env, ...env, FLY_API_TOKEN: token, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      resolve({
        command: `fly ${args.join(" ")}`,
        ok: code === 0,
        exitCode: code ?? -1,
        stdout: stdout.slice(-40_000),
        stderr: stderr.slice(-40_000),
      });
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function summarize(result: FlyCommandResult): string {
  const text = (result.ok ? result.stdout : result.stderr || result.stdout).trim();
  return text.slice(-1200) || `exit ${result.exitCode}`;
}

async function ensureKey(env: NodeJS.ProcessEnv): Promise<{ value: string; created: boolean; file: string }> {
  const file = String(env.SPMT_LLM_KEY_FILE || DEFAULT_KEY_FILE);
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing.length >= 32) return { value: existing, created: false, file };
  } catch { /* create below */ }
  const value = randomBytes(32).toString("hex");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${value}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
  return { value, created: true, file };
}

async function parseJsonCommand(args: string[], env: NodeJS.ProcessEnv): Promise<{ result: FlyCommandResult; payload?: unknown }> {
  const result = await runFly(args, env);
  if (!result.ok) return { result };
  try { return { result, payload: JSON.parse(result.stdout) }; }
  catch { return { result, payload: result.stdout.trim() }; }
}

export async function getSpmtLlmWorkerStatus(args: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  if (!enabled(env)) throw new Error("Fly provisioning tools are disabled. Set MCP_ALLOW_FLY_PROVISIONING=true on Rotator to enable them.");
  const appName = cleanAppName(args.appName);
  const status = await parseJsonCommand(["status", "--app", appName, "--json"], env);
  return {
    ok: status.result.ok,
    appName,
    status: status.payload,
    error: status.result.ok ? undefined : summarize(status.result),
  };
}

export async function provisionSpmtLlmWorker(args: Record<string, unknown>, env: NodeJS.ProcessEnv): Promise<LlmProvisionResult> {
  if (!enabled(env)) throw new Error("Fly provisioning tools are disabled. Set MCP_ALLOW_FLY_PROVISIONING=true on Rotator to enable them.");
  const appName = cleanAppName(args.appName);
  const region = String(args.region || env.SPMT_LLM_REGION || DEFAULT_REGION).trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(region)) throw new Error("Invalid Fly region");
  const org = String(env.FLY_ORG || env.ORG || "mtman-new").trim();
  const volumeName = String(env.SPMT_LLM_VOLUME_NAME || DEFAULT_VOLUME).trim();
  const sizeGb = Number(env.SPMT_LLM_VOLUME_GB || DEFAULT_VOLUME_GB);
  const steps: LlmProvisionResult["steps"] = [];

  const statusBefore = await runFly(["status", "--app", appName, "--json"], env, undefined, 60_000);
  if (!statusBefore.ok) {
    const created = await runFly(["apps", "create", appName, "--org", org], env, undefined, 60_000);
    const alreadyExists = /already exists|name has already been taken/i.test(`${created.stdout}\n${created.stderr}`);
    steps.push({ name: "create-app", ok: created.ok || alreadyExists, detail: alreadyExists ? "App already exists." : summarize(created) });
    if (!created.ok && !alreadyExists) return { ok: false, appName, region, volumeName, keyStored: false, deployed: false, steps };
  } else {
    steps.push({ name: "create-app", ok: true, detail: "App already exists." });
  }

  const volumes = await parseJsonCommand(["volumes", "list", "--app", appName, "--json"], env);
  const items = Array.isArray(volumes.payload) ? volumes.payload as Array<Record<string, unknown>> : [];
  const hasVolume = items.some((item) => String(item.name || "") === volumeName);
  if (!hasVolume) {
    const createdVolume = await runFly(["volumes", "create", volumeName, "--app", appName, "--region", region, "--size", String(sizeGb), "--yes"], env, undefined, 3 * 60_000);
    steps.push({ name: "create-volume", ok: createdVolume.ok, detail: summarize(createdVolume) });
    if (!createdVolume.ok) return { ok: false, appName, region, volumeName, keyStored: false, deployed: false, steps };
  } else {
    steps.push({ name: "create-volume", ok: true, detail: "Persistent model volume already exists." });
  }

  const key = await ensureKey(env);
  const setSecret = await runFly(["secrets", "import", "--app", appName], env, `LLAMA_API_KEY=${key.value}\n`, 2 * 60_000);
  steps.push({ name: "set-api-key", ok: setSecret.ok, detail: setSecret.ok ? `API key stored in Fly and ${key.created ? "created" : "reused"} in Rotator secure storage.` : summarize(setSecret) });
  if (!setSecret.ok) return { ok: false, appName, region, volumeName, keyStored: true, deployed: false, steps };

  const deploy = await runFly([
    "deploy",
    "/app/llm-worker",
    "--app", appName,
    "--config", "/app/llm-worker/fly.toml",
    "--dockerfile", "/app/llm-worker/Dockerfile",
    "--remote-only",
    "--yes",
  ], env, undefined, 30 * 60_000);
  steps.push({ name: "deploy", ok: deploy.ok, detail: summarize(deploy) });
  if (!deploy.ok) return { ok: false, appName, region, volumeName, keyStored: true, deployed: false, steps };

  const statusAfter = await parseJsonCommand(["status", "--app", appName, "--json"], env);
  steps.push({ name: "status", ok: statusAfter.result.ok, detail: statusAfter.result.ok ? "Deployment status read successfully." : summarize(statusAfter.result) });
  return {
    ok: deploy.ok && statusAfter.result.ok,
    appName,
    region,
    volumeName,
    keyStored: true,
    deployed: deploy.ok,
    status: statusAfter.payload,
    steps,
  };
}
