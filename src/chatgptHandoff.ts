import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ecosystemOperatorContextSource } from "./ecosystemContext.js";

export type ChatGptHandoffStatus = "awaiting-owner-approval" | "awaiting-chatgpt" | "denied" | "resolved";

export interface ChatGptHandoff {
  id: string;
  jobId: string;
  status: ChatGptHandoffStatus;
  createdAt: string;
  updatedAt: string;
  approvedAt?: string;
  deniedAt?: string;
  resolvedAt?: string;
  decisionBy?: string;
  appName: string;
  repoId: string;
  repoLabel: string;
  repoUrl: string;
  description: string;
  userContext?: unknown;
  qwenFailure: string;
  baselineChecks: Array<{ command: string; ok: boolean; output: string }>;
  operatorContextSource: string;
  operatorContext: string;
  repositoryContext: string;
  validationCommands: string[];
  resolution?: string;
  instructions: string[];
}

type CreateHandoffInput = Omit<ChatGptHandoff,
  "id" | "status" | "createdAt" | "updatedAt" | "approvedAt" | "deniedAt" | "resolvedAt" | "decisionBy" | "operatorContextSource" | "instructions"
>;

function rootDir(env: NodeJS.ProcessEnv): string {
  return resolve(String(env.CODEX_FIXER_DATA_DIR || "/data/codex-fixer"));
}

function handoffDir(env: NodeJS.ProcessEnv): string {
  return join(rootDir(env), "chatgpt-handoffs");
}

function safeId(value: string): string {
  return /^[A-Za-z0-9_-]{8,120}$/.test(value) ? value : "";
}

function redact(value: string): string {
  return String(value || "")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/FlyV1\s*[A-Za-z0-9._~+/=-]{8,}/gi, "FlyV1 [redacted]")
    .slice(0, 120_000);
}

function sanitizeChecks(checks: Array<{ command: string; ok: boolean; output: string }>): Array<{ command: string; ok: boolean; output: string }> {
  return checks.map((check) => ({
    command: String(check.command || "").slice(0, 1000),
    ok: Boolean(check.ok),
    output: redact(check.output).slice(0, 20_000),
  }));
}

async function writeHandoff(env: NodeJS.ProcessEnv, handoff: ChatGptHandoff): Promise<ChatGptHandoff> {
  await mkdir(handoffDir(env), { recursive: true });
  await writeFile(join(handoffDir(env), `${handoff.id}.json`), JSON.stringify(handoff, null, 2));
  return handoff;
}

export async function writeChatGptHandoff(env: NodeJS.ProcessEnv, input: CreateHandoffInput): Promise<ChatGptHandoff> {
  const now = new Date().toISOString();
  const id = `chatgpt-${input.jobId}`;
  if (!safeId(id)) throw new Error("Unable to create a safe ChatGPT handoff ID.");

  const handoff: ChatGptHandoff = {
    ...input,
    id,
    status: "awaiting-owner-approval",
    createdAt: now,
    updatedAt: now,
    description: String(input.description || "").slice(0, 4000),
    qwenFailure: redact(input.qwenFailure).slice(0, 12_000),
    baselineChecks: sanitizeChecks(input.baselineChecks || []),
    operatorContextSource: ecosystemOperatorContextSource(),
    operatorContext: redact(input.operatorContext).slice(0, 60_000),
    repositoryContext: redact(input.repositoryContext).slice(0, 86_000),
    validationCommands: (input.validationCommands || []).map((value) => String(value).slice(0, 1000)).slice(0, 20),
    instructions: [
      "Wait for explicit mtman Discord approval before a normal ChatGPT conversation may claim this repair.",
      "After approval, use a normal ChatGPT Business conversation with the connected GitHub tools.",
      "Read the canonical operator context and the target repository's AGENTS.md/current main.",
      "Reproduce the reported failure and add a regression test before or with the fix.",
      "Make the smallest justified change and run the repository validation commands.",
      "Open and merge a PR only when validation passes and the handoff was owner-approved.",
      "Verify the deploy workflow and live runtime after merge; do not call a repair successful without live evidence when live checks are available.",
      "Mark this handoff resolved through the bounded Rotator GitHub control bridge after completion.",
    ],
  };

  return writeHandoff(env, handoff);
}

export async function readChatGptHandoff(env: NodeJS.ProcessEnv, id: string): Promise<ChatGptHandoff | null> {
  if (!safeId(id)) return null;
  try {
    return JSON.parse(await readFile(join(handoffDir(env), `${id}.json`), "utf8")) as ChatGptHandoff;
  } catch {
    return null;
  }
}

export async function listChatGptHandoffs(env: NodeJS.ProcessEnv, limit = 25): Promise<ChatGptHandoff[]> {
  try {
    const names = (await readdir(handoffDir(env))).filter((name) => name.endsWith(".json"));
    const rows = await Promise.all(names.map(async (name) => {
      try { return JSON.parse(await readFile(join(handoffDir(env), name), "utf8")) as ChatGptHandoff; }
      catch { return null; }
    }));
    return rows
      .filter((row): row is ChatGptHandoff => Boolean(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(100, Math.max(1, Math.floor(limit))));
  } catch {
    return [];
  }
}

export async function approveChatGptHandoff(env: NodeJS.ProcessEnv, id: string, decisionBy = "mtman-discord"): Promise<ChatGptHandoff> {
  const current = await readChatGptHandoff(env, id);
  if (!current) throw new Error("ChatGPT handoff was not found.");
  if (current.status === "resolved") throw new Error("ChatGPT handoff is already resolved.");
  if (current.status === "denied") throw new Error("ChatGPT handoff was denied and cannot be approved without a new repair packet.");
  if (current.status === "awaiting-chatgpt") return current;
  const now = new Date().toISOString();
  return writeHandoff(env, {
    ...current,
    status: "awaiting-chatgpt",
    approvedAt: now,
    decisionBy: String(decisionBy || "mtman-discord").slice(0, 120),
    updatedAt: now,
  });
}

export async function denyChatGptHandoff(env: NodeJS.ProcessEnv, id: string, decisionBy = "mtman-discord"): Promise<ChatGptHandoff> {
  const current = await readChatGptHandoff(env, id);
  if (!current) throw new Error("ChatGPT handoff was not found.");
  if (current.status === "resolved") throw new Error("ChatGPT handoff is already resolved.");
  if (current.status === "denied") return current;
  const now = new Date().toISOString();
  return writeHandoff(env, {
    ...current,
    status: "denied",
    deniedAt: now,
    decisionBy: String(decisionBy || "mtman-discord").slice(0, 120),
    updatedAt: now,
  });
}

export async function resolveChatGptHandoff(env: NodeJS.ProcessEnv, id: string, resolution: string): Promise<ChatGptHandoff> {
  const current = await readChatGptHandoff(env, id);
  if (!current) throw new Error("ChatGPT handoff was not found.");
  if (current.status !== "awaiting-chatgpt" && current.status !== "resolved") {
    throw new Error("ChatGPT handoff is not owner-approved.");
  }
  if (current.status === "resolved") return current;
  const now = new Date().toISOString();
  const next: ChatGptHandoff = {
    ...current,
    status: "resolved",
    updatedAt: now,
    resolvedAt: now,
    resolution: redact(resolution).slice(0, 4000),
  };
  return writeHandoff(env, next);
}
