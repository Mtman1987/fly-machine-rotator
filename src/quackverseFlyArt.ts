import { execFile } from "node:child_process";
import path from "node:path";
import { FlyApiClient } from "./flyClient.js";
import { parseAppNames } from "./config.js";

const CHAT_TAG_APP = "chat-tag-new";
const QUACKVERSE_ART_ROOT = "/data/quackverse-card-art";
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 25_000;
const OUTPUT_START = "__QVA_BEGIN__";
const OUTPUT_END = "__QVA_END__";

const INVENTORY_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT='/data/quackverse-card-art';
const allowed=new Set(['.png','.jpg','.jpeg','.webp','.gif','.avif']);
function walk(dir,out=[]){
  if(!fs.existsSync(dir)) return out;
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full,out);
    else if(entry.isFile()&&allowed.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}
const assets=walk(ROOT).sort().map((file)=>{
  const stat=fs.statSync(file);
  const bytes=fs.readFileSync(file);
  return {
    fileName:path.relative(ROOT,file).split(path.sep).join('/'),
    size:stat.size,
    sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
    modifiedAt:stat.mtime.toISOString()
  };
});
process.stdout.write('${OUTPUT_START}'+JSON.stringify({root:ROOT,assets})+'${OUTPUT_END}');
`;

const READ_SCRIPT = String.raw`
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const ROOT='/data/quackverse-card-art';
const MAX=${MAX_ASSET_BYTES};
const rel=String(process.argv[1]||'');
const full=path.resolve(ROOT,rel);
const rootPrefix=path.resolve(ROOT)+path.sep;
if(!full.startsWith(rootPrefix)) throw new Error('path outside Quackverse art root');
const ext=path.extname(full).toLowerCase();
const mime={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif'}[ext];
if(!mime) throw new Error('unsupported image type');
const stat=fs.statSync(full);
if(!stat.isFile()) throw new Error('asset is not a file');
if(stat.size>MAX) throw new Error('asset exceeds read limit');
const bytes=fs.readFileSync(full);
process.stdout.write('${OUTPUT_START}'+JSON.stringify({
  fileName:rel,
  size:bytes.length,
  mimeType:mime,
  sha256:crypto.createHash('sha256').update(bytes).digest('hex'),
  base64:bytes.toString('base64')
})+'${OUTPUT_END}');
`;

export type QuackverseArtInventoryEntry = {
  fileName: string;
  size: number;
  sha256: string;
  modifiedAt: string;
};

export type QuackverseArtInventory = {
  appName: string;
  machineId: string;
  root: string;
  assetCount: number;
  assets: QuackverseArtInventoryEntry[];
};

export type QuackverseArtAsset = {
  appName: string;
  machineId: string;
  fileName: string;
  size: number;
  mimeType: string;
  sha256: string;
  base64: string;
};

type ExecResult = { stdout: string; stderr: string };
export type FlyctlRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<ExecResult>;
export type MachineResolver = (env: NodeJS.ProcessEnv) => Promise<string>;

function defaultFlyctlRunner(args: string[], env: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "fly",
      args,
      {
        env,
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`fly machine exec failed: ${String(stderr || error.message).trim().slice(0, 2_000)}`));
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

function requireConfiguration(env: NodeJS.ProcessEnv): string {
  if (!managedApps(env).includes(CHAT_TAG_APP)) {
    throw new Error(`${CHAT_TAG_APP} is not in the Rotator managed Fly app allowlist.`);
  }
  const token = String(env.FLY_API_TOKEN || "").trim();
  if (!token) throw new Error("FLY_API_TOKEN is not configured on the Rotator.");
  return token;
}

function safeAssetName(value: unknown): string {
  const fileName = String(value || "").trim().replace(/\\/g, "/");
  if (!fileName || fileName.length > 240) throw new Error("fileName is required.");
  if (fileName.startsWith("/") || fileName.includes("../") || fileName === ".." || fileName.includes("\0")) {
    throw new Error("Invalid Quackverse art fileName.");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(fileName)) throw new Error("Invalid Quackverse art fileName.");
  if (!/\.(?:png|jpe?g|webp|gif|avif)$/i.test(fileName)) throw new Error("Unsupported Quackverse art file type.");
  return path.posix.normalize(fileName);
}

function parseMarkedJson<T>(stdout: string): T {
  const start = stdout.indexOf(OUTPUT_START);
  const end = stdout.indexOf(OUTPUT_END, start + OUTPUT_START.length);
  if (start < 0 || end < 0) throw new Error("Fly Machine returned an invalid Quackverse art response.");
  const raw = stdout.slice(start + OUTPUT_START.length, end);
  return JSON.parse(raw) as T;
}

async function activeChatTagMachine(env: NodeJS.ProcessEnv): Promise<string> {
  const token = requireConfiguration(env);
  const client = new FlyApiClient({
    token,
    hostname: env.FLY_API_HOSTNAME,
    minIntervalMs: Number(env.API_MIN_INTERVAL_MS || 400),
    maxRetries: Number(env.API_MAX_RETRIES || 4),
  });
  const machines = await client.listMachines(CHAT_TAG_APP);
  const machine = machines.find((candidate) => candidate.state === "started") ?? machines.find((candidate) => candidate.state === "starting");
  if (!machine?.id) throw new Error(`${CHAT_TAG_APP} has no running Machine available for read-only volume inspection.`);
  return machine.id;
}

async function runReadOnlyScript(
  machineId: string,
  script: string,
  scriptArgs: string[],
  env: NodeJS.ProcessEnv,
  runner: FlyctlRunner,
): Promise<string> {
  const token = requireConfiguration(env);
  const childEnv = {
    ...env,
    FLY_API_TOKEN: token,
    FLY_ACCESS_TOKEN: token,
  };
  const args = [
    "machine",
    "exec",
    "--app",
    CHAT_TAG_APP,
    "--timeout",
    "20",
    machineId,
    "node",
    "-e",
    script,
    ...scriptArgs,
  ];
  const result = await runner(args, childEnv);
  return result.stdout;
}

export async function getQuackverseArtInventory(
  env: NodeJS.ProcessEnv = process.env,
  runner: FlyctlRunner = defaultFlyctlRunner,
  machineResolver: MachineResolver = activeChatTagMachine,
): Promise<QuackverseArtInventory> {
  const machineId = await machineResolver(env);
  const stdout = await runReadOnlyScript(machineId, INVENTORY_SCRIPT, [], env, runner);
  const payload = parseMarkedJson<{ root?: unknown; assets?: unknown }>(stdout);
  const assets = Array.isArray(payload.assets)
    ? payload.assets.filter((entry): entry is QuackverseArtInventoryEntry => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.fileName === "string"
          && typeof candidate.size === "number"
          && Number.isFinite(candidate.size)
          && typeof candidate.sha256 === "string"
          && typeof candidate.modifiedAt === "string";
      })
    : [];
  return {
    appName: CHAT_TAG_APP,
    machineId,
    root: String(payload.root || QUACKVERSE_ART_ROOT),
    assetCount: assets.length,
    assets,
  };
}

export async function readQuackverseArtAsset(
  args: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
  runner: FlyctlRunner = defaultFlyctlRunner,
  machineResolver: MachineResolver = activeChatTagMachine,
): Promise<QuackverseArtAsset> {
  const fileName = safeAssetName(args.fileName);
  const machineId = await machineResolver(env);
  const stdout = await runReadOnlyScript(machineId, READ_SCRIPT, [fileName], env, runner);
  const payload = parseMarkedJson<Omit<QuackverseArtAsset, "appName" | "machineId">>(stdout);
  if (payload.fileName !== fileName || !Number.isFinite(payload.size) || payload.size < 0 || payload.size > MAX_ASSET_BYTES) {
    throw new Error("Fly Machine returned invalid Quackverse asset metadata.");
  }
  if (typeof payload.base64 !== "string" || typeof payload.sha256 !== "string" || typeof payload.mimeType !== "string") {
    throw new Error("Fly Machine returned an invalid Quackverse asset payload.");
  }
  return { appName: CHAT_TAG_APP, machineId, ...payload };
}

export const quackverseFlyArtPolicy = {
  appName: CHAT_TAG_APP,
  root: QUACKVERSE_ART_ROOT,
  maxAssetBytes: MAX_ASSET_BYTES,
  allowedExtensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"],
} as const;
