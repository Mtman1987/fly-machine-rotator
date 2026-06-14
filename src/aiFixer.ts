import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { appendFixAttempt, buildFixId, FixRecord, FixStatus } from "./fixStore.js";
import { captureRepoSnapshot, ensureRepoReady } from "./repoOps.js";
import { getRepoConfigForApp } from "./repoMap.js";

export interface StoredErrorEvent {
  recordedAt: string;
  appName: string;
  fingerprint: string;
  machineId?: string;
  region?: string;
  timestamp?: string;
  message: string;
  suggestion: string;
  context: string[];
}

interface ModelFixPlan {
  summary: string;
  diagnosis: string;
  confidence: "low" | "medium" | "high";
  sourceSummary: string;
  changes: Array<{
    path: string;
    reason: string;
    content: string;
  }>;
}

export async function generateFixRecord(
  event: StoredErrorEvent,
  env: NodeJS.ProcessEnv = process.env,
  options: {
    existing?: FixRecord;
    related?: FixRecord[];
  } = {}
): Promise<FixRecord> {
  const config = getRepoConfigForApp(event.appName);
  if (!config) {
    return baseRecord(event, "error", { lastError: `No repo mapping for ${event.appName}.` });
  }
  if (!env.EDENAI_API_KEY && !env.OPENAI_API_KEY && !env.GEMINI_API_KEY) {
    return baseRecord(event, "error", {
      repoId: config.id,
      repoLabel: config.label,
      repoUrl: config.repoUrl,
      lastError: "Set EDENAI_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to generate AI fixes."
    });
  }

  const repoPath = await ensureRepoReady(config, env);
  const context = await collectRepoContext(repoPath, event);
  const repoSnapshot = await captureRepoSnapshot(repoPath);
  const plan = await requestFixPlan(config.label, repoPath, event, context, env, {
    existing: options.existing,
    related: options.related,
    repoSnapshot
  });
  const record: FixRecord = {
    id: buildFixId(event.appName, event.fingerprint),
    appName: event.appName,
    fingerprint: event.fingerprint,
    repoId: config.id,
    repoLabel: config.label,
    repoUrl: config.repoUrl,
    status: plan.changes.length > 0 ? "generated" : "error",
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosis: plan.diagnosis,
    summary: plan.summary,
    confidence: plan.confidence,
    sourceSummary: plan.sourceSummary,
    changes: plan.changes,
    attempts: options.existing?.attempts ?? [],
    repoSnapshot: {
      capturedAt: new Date().toISOString(),
      repoPath,
      branch: repoSnapshot.branch,
      headCommit: repoSnapshot.headCommit,
      originCommit: repoSnapshot.originCommit,
      dirty: repoSnapshot.dirty,
      contextPaths: context.map((item) => item.path)
    },
    lastError: plan.changes.length > 0 ? undefined : "Model did not return any safe file changes."
  };
  appendFixAttempt(record, {
    attemptedAt: record.updatedAt,
    action: "generate",
    ok: plan.changes.length > 0,
    summary: plan.changes.length > 0
      ? `Generated ${plan.changes.length} file change(s).`
      : "Model returned no safe file changes.",
    details: repoSnapshot.headCommit
      ? `repo=${repoSnapshot.branch ?? "unknown"}@${repoSnapshot.headCommit.slice(0, 12)} context=${context.map((item) => item.path).join(", ")}`
      : `context=${context.map((item) => item.path).join(", ")}`
  });
  return record;
}

function baseRecord(
  event: StoredErrorEvent,
  status: FixStatus,
  partial: Partial<FixRecord>
): FixRecord {
  return {
    id: buildFixId(event.appName, event.fingerprint),
    appName: event.appName,
    fingerprint: event.fingerprint,
    status,
    updatedAt: new Date().toISOString(),
    changes: [],
    attempts: [],
    ...partial
  };
}

async function requestFixPlan(
  repoLabel: string,
  repoPath: string,
  event: StoredErrorEvent,
  contextFiles: Array<{ path: string; content: string }>,
  env: NodeJS.ProcessEnv,
  options: {
    existing?: FixRecord;
    related?: FixRecord[];
    repoSnapshot?: {
      branch?: string;
      headCommit?: string;
      originCommit?: string;
      dirty: boolean;
    };
  }
): Promise<ModelFixPlan> {
  const prompt = buildPrompt(repoLabel, repoPath, event, contextFiles, options);
  const failures: string[] = [];
  if (env.EDENAI_API_KEY) {
    try {
      return await requestEdenAiFixPlan(prompt, env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (env.OPENAI_API_KEY) {
    try {
      return await requestOpenAiFixPlan(prompt, env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (env.GEMINI_API_KEY) {
    try {
      return await requestGeminiFixPlan(prompt, env);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(failures.join("\n\n") || "No AI provider is configured.");
}

function buildPrompt(
  repoLabel: string,
  repoPath: string,
  event: StoredErrorEvent,
  contextFiles: Array<{ path: string; content: string }>,
  options: {
    existing?: FixRecord;
    related?: FixRecord[];
    repoSnapshot?: {
      branch?: string;
      headCommit?: string;
      originCommit?: string;
      dirty: boolean;
    };
  }
): string {
  const previousAttempts = (options.existing?.attempts ?? [])
    .slice(-6)
    .map((attempt) => `- ${attempt.attemptedAt} ${attempt.action} ${attempt.ok ? "ok" : "error"} ${attempt.summary}${attempt.details ? ` :: ${attempt.details}` : ""}`);
  const relatedFixes = (options.related ?? [])
    .filter((record) => record.id !== options.existing?.id)
    .slice(-5)
    .map((record) => `- ${record.appName} ${record.fingerprint} status=${record.status} summary=${record.summary ?? "n/a"} lastError=${record.lastError ?? "n/a"}`);
  return [
    `Repo: ${repoLabel}`,
    `Repo path: ${repoPath}`,
    `Error app: ${event.appName}`,
    `Fingerprint: ${event.fingerprint}`,
    `Recorded: ${event.recordedAt}`,
    `Message: ${event.message}`,
    `Suggestion from monitor: ${event.suggestion}`,
    `Repo branch: ${options.repoSnapshot?.branch ?? "unknown"}`,
    `Repo head: ${options.repoSnapshot?.headCommit ?? "unknown"}`,
    `Repo upstream head: ${options.repoSnapshot?.originCommit ?? "unknown"}`,
    `Repo dirty: ${options.repoSnapshot?.dirty ? "yes" : "no"}`,
    "",
    "Recent logs:",
    ...event.context.map((line) => `- ${line}`),
    "",
    "Previous attempts for this exact fingerprint:",
    ...(previousAttempts.length > 0 ? previousAttempts : ["- none"]),
    "",
    "Recent related fixes in this repo:",
    ...(relatedFixes.length > 0 ? relatedFixes : ["- none"]),
    "",
    "Candidate source files:",
    ...contextFiles.map((file) => `FILE: ${file.path}\n${file.content}`),
    "",
    "Return strict JSON only. Make the smallest safe fix. Prefer changing existing files over creating new ones. Do not invent missing infrastructure. Avoid repeating a prior failed approach unless the new context clearly invalidates the old failure. If you are not confident, return an empty changes array."
  ].join("\n");
}

async function requestOpenAiFixPlan(prompt: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
  const model = env.OPENAI_FIX_MODEL ?? "gpt-4.1-mini";
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a senior software engineer. Return JSON with summary, diagnosis, confidence, sourceSummary, and changes. Each change must include path, reason, and the full updated file content."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI request failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenAI response did not include content.");
  }

  return normalizeModelPlan(JSON.parse(extractJsonPayload(content)) as Partial<ModelFixPlan>);
}

async function requestEdenAiFixPlan(prompt: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
  const model = env.EDENAI_FIX_MODEL ?? "anthropic/claude-sonnet-4-5";
  const response = await fetch("https://api.edenai.run/v3/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.EDENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content: "You are a senior software engineer. Return JSON with summary, diagnosis, confidence, sourceSummary, and changes. Each change must include path, reason, and the full updated file content."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      max_tokens: 4000,
      stream: false
    })
  });

  if (!response.ok) {
    throw new Error(`EdenAI request failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("EdenAI response did not include content.");
  }

  return normalizeModelPlan(JSON.parse(extractJsonPayload(content)) as Partial<ModelFixPlan>);
}

async function requestGeminiFixPlan(prompt: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
  const model = env.GEMINI_FIX_MODEL ?? "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: [
                "You are a senior software engineer.",
                "Return JSON with summary, diagnosis, confidence, sourceSummary, and changes.",
                "Each change must include path, reason, and the full updated file content.",
                "",
                prompt
              ].join("\n")
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json"
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Gemini request failed with ${response.status}: ${await response.text()}`);
  }

  const body = await response.json() as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string }>;
      };
    }>;
  };
  const content = body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
  if (!content) {
    throw new Error("Gemini response did not include content.");
  }

  return normalizeModelPlan(JSON.parse(extractJsonPayload(content)) as Partial<ModelFixPlan>);
}

export function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const unfenced = fenced?.[1]?.trim() || trimmed;
  return findBalancedJsonPayload(unfenced) ?? unfenced;
}

function findBalancedJsonPayload(value: string): string | undefined {
  const firstBrace = value.indexOf("{");
  const firstBracket = value.indexOf("[");
  const startCandidates = [firstBrace, firstBracket].filter((index) => index >= 0);
  if (startCandidates.length === 0) return undefined;
  const start = Math.min(...startCandidates);
  const open = value[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) {
      return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function normalizeModelPlan(parsed: Partial<ModelFixPlan>): ModelFixPlan {
  return {
    summary: String(parsed.summary ?? "No summary provided."),
    diagnosis: String(parsed.diagnosis ?? "No diagnosis provided."),
    confidence: parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium",
    sourceSummary: String(parsed.sourceSummary ?? "Used repo-local source files and package metadata."),
    changes: Array.isArray(parsed.changes)
      ? parsed.changes
        .filter((change): change is { path: string; reason: string; content: string } =>
          Boolean(change && typeof change.path === "string" && typeof change.reason === "string" && typeof change.content === "string"))
      : []
  };
}

async function collectRepoContext(
  repoPath: string,
  event: StoredErrorEvent
): Promise<Array<{ path: string; content: string }>> {
  const packageJsonPath = join(repoPath, "package.json");
  const contexts: Array<{ path: string; content: string }> = [];
  const seenPaths = new Set<string>();

  try {
    const packageJson = await readFile(packageJsonPath, "utf8");
    contexts.push({ path: "package.json", content: clipFile(packageJson) });
    seenPaths.add("package.json");
  } catch {
    // No package file.
  }

  for (const relativePath of derivePriorityPaths(event)) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (seenPaths.has(normalizedPath)) continue;
    try {
      const content = await readFile(join(repoPath, relativePath), "utf8");
      contexts.push({ path: normalizedPath, content: clipFile(content) });
      seenPaths.add(normalizedPath);
    } catch {
      // Optional priority file missing in this repo variant.
    }
  }

  const searchTerms = deriveSearchTerms(event);
  const candidates = await searchFiles(repoPath, searchTerms, 5);
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;
    contexts.push(candidate);
    seenPaths.add(candidate.path);
  }

  return contexts.slice(0, 8);
}

function deriveSearchTerms(event: StoredErrorEvent): string[] {
  const terms = new Set<string>();
  const routeMatches = event.message.match(/\/api\/[a-z0-9/_-]+/gi) ?? [];
  for (const route of routeMatches) terms.add(route.toLowerCase());

  const pathMatches = `${event.message}\n${event.context.join("\n")}`.match(/[A-Za-z0-9/_-]+\.(?:ts|tsx|js|jsx)/g) ?? [];
  for (const filePath of pathMatches) terms.add(filePath.toLowerCase());

  const bracketMatches = event.message.match(/\[([^\]]+)\]/g) ?? [];
  for (const match of bracketMatches) {
    terms.add(match.replace(/^\[|\]$/g, "").toLowerCase());
  }

  const wordMatches = `${event.message}\n${event.context.join("\n")}`
    .match(/[A-Za-z][A-Za-z0-9/_-]{3,}/g) ?? [];
  for (const word of wordMatches) {
    const normalized = word.toLowerCase();
    if ([
      "error",
      "failed",
      "status",
      "response",
      "trace",
      "stack",
      "machine",
      "region",
      "help",
      "ticket"
    ].includes(normalized)) continue;
    terms.add(normalized);
    if (terms.size >= 12) break;
  }

  return [...terms];
}

function derivePriorityPaths(event: StoredErrorEvent): string[] {
  const message = event.message.toLowerCase();
  const paths = new Set<string>();

  if (event.appName === "dsh-clip-worker") {
    paths.add("clip-worker/worker.js");
    if (message.includes("needed list") || message.includes("/api/clips/needed")) {
      paths.add("src/app/api/clips/needed/route.ts");
    }
  }

  if (event.appName === "discord-stream-hub-new") {
    paths.add("src/app/api/discord/chat/route.ts");
  }

  if (event.appName === "chat-tag-bot-new" || event.appName === "chat-tag-new") {
    paths.add("bot.js");
    paths.add("src/app/api/tag/route.ts");
    paths.add("src/lib/chat-tag-discord.ts");
  }

  if (event.appName === "streamweaver-new") {
    paths.add("src/services/chat-dispatcher.ts");
    paths.add("src/services/tts-provider.ts");
    paths.add("src/ai/flows/text-to-speech.ts");
    paths.add("src/services/checkin-sources.ts");
  }

  if (event.appName === "hearmeout-main" || event.appName === "hmo-dj-worker") {
    paths.add("server.js");
    paths.add("src/server.js");
    paths.add("worker.js");
    paths.add("worker/src/server.js");
    if (message.includes("watchmode")) {
      paths.add("watchmode.js");
      paths.add("src/services/watchmode.js");
      paths.add("src/lib/watchmode.js");
    }
  }

  return [...paths];
}

async function searchFiles(
  repoPath: string,
  searchTerms: string[],
  limit: number
): Promise<Array<{ path: string; content: string }>> {
  const hits: Array<{ path: string; content: string }> = [];
  if (searchTerms.length === 0) return hits;

  const roots = ["src", "app", "pages", "worker", "clip-worker", "scripts", "."];
  for (const root of roots) {
    const absoluteRoot = join(repoPath, root);
    if (!(await exists(absoluteRoot))) continue;
    await walkFiles(absoluteRoot, async (absolutePath) => {
      if (hits.length >= limit) return true;
      if (!isTextSourceFile(absolutePath)) return false;
      const content = await readFile(absolutePath, "utf8").catch(() => "");
      const haystack = content.toLowerCase();
      if (searchTerms.some((term) => haystack.includes(term))) {
        hits.push({
          path: absolutePath.slice(repoPath.length + 1).replaceAll("\\", "/"),
          content: clipFile(content)
        });
      }
      return false;
    });
    if (hits.length >= limit) break;
  }

  return hits;
}

async function walkFiles(
  root: string,
  visit: (absolutePath: string) => Promise<boolean>
): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".next" || entry.name === "dist") continue;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await walkFiles(absolutePath, visit)) return true;
      continue;
    }
    if (entry.isFile() && await visit(absolutePath)) return true;
  }
  return false;
}

function isTextSourceFile(path: string): boolean {
  return [".ts", ".tsx", ".js", ".jsx", ".json", ".md"].includes(extname(path).toLowerCase());
}

function clipFile(content: string): string {
  return content.length > 12_000 ? `${content.slice(0, 12_000)}\n/* truncated */` : content;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
