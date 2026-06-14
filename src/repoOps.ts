import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { RepoConfig } from "./repoMap.js";

export interface RepoSnapshot {
  repoPath: string;
  branch?: string;
  headCommit?: string;
  originCommit?: string;
  dirty: boolean;
}

export async function ensureRepoReady(config: RepoConfig, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const reposRoot = env.ROTATOR_REPO_CACHE_DIR ?? "/data/repos";
  const repoPath = join(reposRoot, config.cloneDirName);
  await mkdir(reposRoot, { recursive: true });

  const hasGit = await pathExists(join(repoPath, ".git"));
  if (!hasGit) {
    await runShell(`git clone ${shellQuote(authenticatedRepoUrl(config.repoUrl, env.GITHUB_TOKEN))} ${shellQuote(repoPath)}`, dirname(repoPath));
  }

  await configureGitIdentity(repoPath);
  await refreshRepoCache(repoPath);
  return repoPath;
}

export async function ensureRepoDependencies(repoPath: string, installCommand: string | undefined): Promise<void> {
  if (!installCommand) return;
  const packageJsonPath = join(repoPath, "package.json");
  const lockPath = await firstExisting([
    join(repoPath, "package-lock.json"),
    join(repoPath, "pnpm-lock.yaml"),
    join(repoPath, "yarn.lock")
  ]);
  if (!(await pathExists(packageJsonPath))) return;

  const markerPath = join(repoPath, ".rotator-install-state.json");
  const current = {
    packageJsonHash: await hashFile(packageJsonPath),
    lockHash: lockPath ? await hashFile(lockPath) : "none"
  };

  try {
    const previous = JSON.parse(await readFile(markerPath, "utf8")) as typeof current;
    if (previous.packageJsonHash === current.packageJsonHash && previous.lockHash === current.lockHash && await pathExists(join(repoPath, "node_modules"))) {
      return;
    }
  } catch {
    // Install below.
  }

  await runShell(installCommand, repoPath, 20 * 60 * 1000);
  await writeFile(markerPath, JSON.stringify(current, null, 2));
}

export async function runCheckCommands(repoPath: string, commands: string[]): Promise<Array<{ command: string; exitCode: number; output: string }>> {
  const results: Array<{ command: string; exitCode: number; output: string }> = [];
  for (const command of commands) {
    const result = await runShell(command, repoPath, 20 * 60 * 1000, false);
    results.push({ command, ...result });
    if (result.exitCode !== 0) break;
  }
  return results;
}

export async function writeRepoFiles(
  repoPath: string,
  changes: Array<{ path: string; content: string }>
): Promise<string[]> {
  const written: string[] = [];
  for (const change of changes) {
    const targetPath = join(repoPath, change.path);
    if (!isSubpath(repoPath, targetPath)) {
      throw new Error(`Refusing to write outside repo: ${change.path}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, change.content);
    written.push(change.path);
  }
  return written;
}

export async function pushRepoBranch(repoPath: string, branchName: string, message: string, env: NodeJS.ProcessEnv = process.env): Promise<{ branch: string; commit: string; output: string }> {
  if (!env.GITHUB_TOKEN) {
    throw new Error("Set GITHUB_TOKEN to enable push actions.");
  }

  await configureGitIdentity(repoPath);
  if (!(await hasWorkingTreeChanges(repoPath))) {
    throw new Error("No repo changes are staged or pending to push.");
  }
  const originUrl = (await runShell("git remote get-url origin", repoPath)).output.trim();
  const authedOrigin = authenticatedRepoUrl(originUrl, env.GITHUB_TOKEN);
  await runShell(`git remote set-url origin ${shellQuote(authedOrigin)}`, repoPath);
  await runShell(`git checkout -B ${shellQuote(branchName)}`, repoPath);
  await runShell("git add -A", repoPath);
  await runShell(`git commit -m ${shellQuote(message)}`, repoPath, 60_000, false);
  const commit = (await runShell("git rev-parse HEAD", repoPath)).output.trim();
  const pushResult = await runShell(`git push -u origin ${shellQuote(branchName)}`, repoPath, 5 * 60 * 1000);
  await runShell(`git remote set-url origin ${shellQuote(originUrl)}`, repoPath, 60_000, false).catch(() => undefined);
  return { branch: branchName, commit, output: pushResult.output };
}

export function buildFixBranchName(config: RepoConfig, appName: string, fingerprint: string): string {
  const safeApp = appName.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${config.branchPrefix}/${safeApp}-${fingerprint.slice(0, 8)}`;
}

export async function hasWorkingTreeChanges(repoPath: string): Promise<boolean> {
  const result = await runShell("git status --porcelain", repoPath, 60_000, false);
  return result.output.trim().length > 0;
}

export async function captureRepoSnapshot(repoPath: string): Promise<RepoSnapshot> {
  const branch = await readGitValue(repoPath, "git rev-parse --abbrev-ref HEAD");
  const headCommit = await readGitValue(repoPath, "git rev-parse HEAD");
  const originCommit = await readGitValue(repoPath, "git rev-parse @{upstream}");
  return {
    repoPath,
    branch,
    headCommit,
    originCommit,
    dirty: await hasWorkingTreeChanges(repoPath)
  };
}

async function configureGitIdentity(repoPath: string): Promise<void> {
  await runShell('git config user.name "Fly Rotator"', repoPath, 60_000, false);
  await runShell('git config user.email "rotator@local.invalid"', repoPath, 60_000, false);
}

async function refreshRepoCache(repoPath: string): Promise<void> {
  await runShell("git fetch --all --prune", repoPath, 5 * 60 * 1000, false);
  if (await hasWorkingTreeChanges(repoPath)) return;
  const branch = (await readGitValue(repoPath, "git rev-parse --abbrev-ref HEAD"))?.trim();
  if (!branch || branch === "HEAD") return;
  await runShell(`git pull --ff-only origin ${shellQuote(branch)}`, repoPath, 5 * 60 * 1000, false);
}

function authenticatedRepoUrl(url: string, token: string | undefined): string {
  if (!token) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol.startsWith("http")) {
      parsed.username = "x-access-token";
      parsed.password = token;
      return parsed.toString();
    }
  } catch {
    // Use original.
  }
  return url;
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    if (await pathExists(path)) return path;
  }
  return undefined;
}

async function readGitValue(repoPath: string, command: string): Promise<string | undefined> {
  const result = await runShell(command, repoPath, 60_000, false);
  const value = result.output.trim();
  return result.exitCode === 0 && value ? value : undefined;
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return process.platform === "win32"
    ? `"${value.replaceAll('"', '\\"')}"`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function isSubpath(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  const normalizedCandidate = candidate.replace(/\\/g, "/");
  return normalizedCandidate.startsWith(normalizedRoot);
}

async function runShell(
  command: string,
  cwd: string,
  timeoutMs = 10 * 60 * 1000,
  rejectOnError = true
): Promise<{ exitCode: number; output: string }> {
  const executable = process.platform === "win32" ? "cmd.exe" : "sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];

  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env: process.env });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      const exitCode = code ?? 1;
      if (rejectOnError && exitCode !== 0) {
        reject(new Error(`Command failed (${exitCode}): ${command}\n${output}`));
        return;
      }
      resolve({ exitCode, output });
    });
  });
}
