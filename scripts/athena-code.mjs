#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function usage() {
  console.log(`Athena Coder CLI

Usage:
  npm run athena -- repos
  npm run athena -- jobs
  npm run athena -- submit <app-name> <description> [--wait] [--timeout <seconds>]
  npm run athena -- status <job-id>
  npm run athena -- wait <job-id> [--timeout <seconds>]
  npm run athena -- diff|checks|response <job-id>
  npm run athena -- publish <job-id>

Authentication is selected automatically:
  SPMT_CODEX_SERVICE_SECRET calls the SPMT Athena gateway (default).
  CODEX_WORKER_SECRET calls ATHENA_CODER_BASE_URL directly for server-side/Fly use.

Fly, GitHub, and OpenAI credentials remain on their servers.`);
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  args.splice(index, 2);
  return value;
}

export function resolveClient(env = process.env) {
  let fileSecret = "";
  try { fileSecret = readFileSync("/tmp/athena-coder-worker-secret", "utf8").trim(); } catch { /* CLI may be running off-server */ }
  const directSecret = String(env.CODEX_WORKER_SECRET || fileSecret).trim();
  const gatewaySecret = String(env.SPMT_CODEX_SERVICE_SECRET || "").trim();
  if (directSecret) {
    const internalPort = Number(env.ROTATOR_INTERNAL_DASHBOARD_PORT || Number(env.PORT || 8080) + 2);
    return {
      baseUrl: String(env.ATHENA_CODER_BASE_URL || `http://127.0.0.1:${internalPort}`).replace(/\/$/, ""),
      referencesPath: "/api/codex/references",
      jobsPath: "/api/codex/jobs",
      headers: { "x-codex-worker-secret": directSecret },
    };
  }
  if (gatewaySecret) {
    return {
      baseUrl: String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, ""),
      referencesPath: "/api/athena/code-references",
      jobsPath: "/api/athena/code-jobs",
      headers: { "x-spmt-codex-secret": gatewaySecret },
    };
  }
  throw new Error("Set SPMT_CODEX_SERVICE_SECRET, or set CODEX_WORKER_SECRET for direct server-side/Fly use.");
}

export async function createClient(env = process.env) {
  const config = resolveClient(env);
  return async function request(path, options = {}) {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: {
        accept: "application/json, text/plain",
        "content-type": "application/json",
        ...config.headers,
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

function jobFrom(result) {
  return result && typeof result === "object" && result.job ? result.job : result;
}

async function waitForJob(request, jobsPath, jobId, timeoutSeconds, intervalMs) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (true) {
    const result = await request(`${jobsPath}/${encodeURIComponent(jobId)}`);
    const job = jobFrom(result);
    if (TERMINAL_STATUSES.has(String(job?.status || ""))) return result;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${jobId}.`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const [command, ...rawArgs] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") return usage();

  const args = [...rawArgs];
  const shouldWait = args.includes("--wait");
  if (shouldWait) args.splice(args.indexOf("--wait"), 1);
  const timeoutSeconds = Number(readOption(args, "--timeout", env.ATHENA_CODER_TIMEOUT_SECONDS || "1800"));
  const intervalMs = Number(env.ATHENA_CODER_POLL_INTERVAL_MS || "3000");
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number of seconds.");
  if (!Number.isFinite(intervalMs) || intervalMs < 100) throw new Error("ATHENA_CODER_POLL_INTERVAL_MS must be at least 100ms.");

  const config = resolveClient(env);
  const request = await createClient(env);
  let result;
  if (command === "repos") {
    result = await request(config.referencesPath);
  } else if (command === "jobs") {
    result = await request(config.jobsPath);
  } else if (command === "submit") {
    const [appName, ...descriptionParts] = args;
    const description = descriptionParts.join(" ").trim();
    if (!appName || !description) throw new Error("submit requires <app-name> and <description>.");
    result = await request(config.jobsPath, {
      method: "POST",
      body: JSON.stringify({ source: "athena-cli", reporter: "Mtman1987", appName, description }),
    });
    const jobId = String(jobFrom(result)?.id || "");
    if (shouldWait) {
      if (!jobId) throw new Error("Athena Coder did not return a job id.");
      result = await waitForJob(request, config.jobsPath, jobId, timeoutSeconds, intervalMs);
    }
  } else if (command === "status" || command === "wait") {
    if (!args[0]) throw new Error(`${command} requires <job-id>.`);
    result = command === "wait"
      ? await waitForJob(request, config.jobsPath, args[0], timeoutSeconds, intervalMs)
      : await request(`${config.jobsPath}/${encodeURIComponent(args[0])}`);
  } else if (["diff", "checks", "response"].includes(command)) {
    if (!args[0]) throw new Error(`${command} requires <job-id>.`);
    result = await request(`${config.jobsPath}/${encodeURIComponent(args[0])}/${command}`);
  } else if (command === "publish") {
    if (!args[0]) throw new Error("publish requires <job-id>.");
    result = await request(`${config.jobsPath}/${encodeURIComponent(args[0])}/publish`, { method: "POST", body: "{}" });
  } else {
    usage();
    throw new Error(`Unknown command: ${command}`);
  }

  console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  if ((command === "wait" || (command === "submit" && shouldWait)) && String(jobFrom(result)?.status || "") === "failed") {
    throw new Error(String(jobFrom(result)?.error || `Athena Coder job ${jobFrom(result)?.id || ""} failed.`));
  }
  return result;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
