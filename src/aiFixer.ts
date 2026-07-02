import { existsSync, readFileSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { appendFixAttempt, buildFixId, FixRecord, FixStatus } from "./fixStore.js";
import { updateFixQualityGate } from "./fixQuality.js";
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

interface RepoContextFile {
  path: string;
  content: string;
  reason: string;
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
  const repoPath = await ensureRepoReady(config, env);
  const context = await collectRepoContext(repoPath, event);
  const repoSnapshot = await captureRepoSnapshot(repoPath);
  const plan = await requestFixPlan(config.label, repoPath, event, context, env, {
    existing: options.existing,
    related: options.related,
    repoSnapshot
  });
  const confidenceEstimate = estimateFixConfidence(plan, {
    existing: options.existing,
    related: options.related,
    repoDirty: repoSnapshot.dirty,
    contextCount: context.length
  });
  const record: FixRecord = {
    id: buildFixId(event.appName, event.fingerprint),
    appName: event.appName,
    fingerprint: event.fingerprint,
    repoId: config.id,
    repoLabel: config.label,
    repoUrl: config.repoUrl,
    status: isUsablePlan(plan) ? "generated" : "error",
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosis: plan.diagnosis,
    summary: plan.summary,
    confidence: plan.confidence,
    confidenceScore: confidenceEstimate.score,
    confidenceSignals: confidenceEstimate.signals,
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
    lastError: isUsablePlan(plan) ? undefined : "No usable diagnosis or safe file changes were generated."
  };
  appendFixAttempt(record, {
    attemptedAt: record.updatedAt,
    action: "generate",
    ok: isUsablePlan(plan),
    summary: plan.changes.length > 0
      ? `Generated ${plan.changes.length} file change(s).`
      : "Generated diagnosis with no safe automatic file changes.",
    details: repoSnapshot.headCommit
      ? `repo=${repoSnapshot.branch ?? "unknown"}@${repoSnapshot.headCommit.slice(0, 12)} context=${context.map((item) => item.path).join(", ")}`
      : `context=${context.map((item) => item.path).join(", ")}`
  });
  updateFixQualityGate(record);
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
  contextFiles: RepoContextFile[],
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
      return assertUsableModelPlan(await requestEdenAiFixPlan(prompt, repoPath, env), "EdenAI");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (env.OPENAI_API_KEY) {
    try {
      return assertUsableModelPlan(await requestOpenAiFixPlan(prompt, repoPath, env), "OpenAI");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (env.GEMINI_API_KEY) {
    try {
      return assertUsableModelPlan(await requestGeminiFixPlan(prompt, repoPath, env), "Gemini");
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return buildLocalFallbackPlan(event, contextFiles, failures);
}

function estimateFixConfidence(
  plan: ModelFixPlan,
  evidence: {
    existing?: FixRecord;
    related?: FixRecord[];
    repoDirty: boolean;
    contextCount: number;
  }
): { score: number; signals: string[] } {
  const signals: string[] = [];
  let score = plan.confidence === "high" ? 74 : plan.confidence === "medium" ? 58 : 38;
  signals.push(`model confidence: ${plan.confidence}`);

  if (plan.changes.length > 0) {
    score += 8;
    signals.push(`proposes ${plan.changes.length} file change(s)`);
  } else {
    score -= 18;
    signals.push("diagnosis only; no automatic patch");
  }

  if (/local fallback/i.test(plan.sourceSummary)) {
    score -= 16;
    signals.push("local fallback used because model providers were unavailable or unusable");
  }

  if (evidence.contextCount >= 2) {
    score += 5;
    signals.push(`repo context included ${evidence.contextCount} source files`);
  }

  if (evidence.repoDirty) {
    score -= 12;
    signals.push("target repo snapshot was dirty");
  }

  const attempts = evidence.existing?.attempts ?? [];
  const failedRecent = attempts.slice(-5).filter((attempt) => !attempt.ok).length;
  if (failedRecent > 0) {
    score -= Math.min(20, failedRecent * 5);
    signals.push(`${failedRecent} recent failed attempt(s) for this fingerprint`);
  }

  const related = evidence.related ?? [];
  const relatedPassed = related.filter((record) => record.checkResult?.ok || record.status === "pushed" || record.status === "handled").length;
  const relatedFailed = related.filter((record) => record.status === "error" || record.checkResult?.ok === false).length;
  if (relatedPassed > 0) {
    score += Math.min(12, relatedPassed * 3);
    signals.push(`${relatedPassed} related fix(es) passed checks or were handled`);
  }
  if (relatedFailed > 0) {
    score -= Math.min(16, relatedFailed * 3);
    signals.push(`${relatedFailed} related fix(es) failed or remain errored`);
  }

  return {
    score: Math.max(5, Math.min(95, Math.round(score))),
    signals
  };
}

function assertUsableModelPlan(plan: ModelFixPlan, provider: string): ModelFixPlan {
  if (!isUsablePlan(plan)) {
    throw new Error(`${provider} returned an empty fix plan.`);
  }
  return plan;
}

function isUsablePlan(plan: ModelFixPlan): boolean {
  const hasDiagnosis = plan.diagnosis !== "No diagnosis provided." && plan.diagnosis.trim().length >= 20;
  const hasSummary = plan.summary !== "No summary provided." && plan.summary.trim().length >= 10;
  return plan.changes.length > 0 || hasDiagnosis || hasSummary;
}

function buildLocalFallbackPlan(
  event: StoredErrorEvent,
  contextFiles: RepoContextFile[],
  failures: string[]
): ModelFixPlan {
  const lower = event.message.toLowerCase();
  const contextPaths = contextFiles.map((file) => file.path).join(", ") || "none";
  const providerDetails = failures.length > 0
    ? `AI provider attempts were unavailable or unusable: ${failures.join(" | ").slice(0, 1800)}`
    : "No AI provider key is configured.";
  const diagnosis = [
    inferLocalRootCause(lower),
    "",
    `Repo context collected: ${contextPaths}.`,
    providerDetails,
    "No automatic file rewrite was produced because the local fallback will not guess at code edits without a validated provider plan. Use the collected paths and diagnosis to edit the proposal in the review station, or repair provider credentials and regenerate."
  ].join("\n");

  return {
    summary: `Local fallback diagnosis for ${event.appName}: ${event.message.slice(0, 180)}`,
    diagnosis,
    confidence: "low",
    sourceSummary: "Generated by rotator local fallback after AI providers were unavailable, empty, over quota, or invalid.",
    changes: []
  };
}

function inferLocalRootCause(lowerMessage: string): string {
  if (lowerMessage.includes("custom seaart models require modelno:modelverno") || lowerMessage.includes("seaart create failed")) {
    return "The image-generation path is passing an invalid SeaArt model selection or custom model payload. Inspect the SeaArt provider/model normalization path first, especially alias handling and the modelNo/modelVerNo validation branch.";
  }
  if (lowerMessage.includes("manual-shoutout") || lowerMessage.includes("twitch user not found")) {
    return "The manual shoutout flow is sending more than a Twitch login to the Twitch users lookup. Parse the command payload into username plus optional description before calling the Twitch API.";
  }
  if (lowerMessage.includes("invalid json payload")) {
    return "The Discord chat endpoint is receiving malformed JSON containing raw control characters. Harden request parsing and sanitize or reject unsafe payloads before JSON.parse cascades into log noise.";
  }
  if (lowerMessage.includes("banner generation failed") && lowerMessage.includes("ffmpeg")) {
    return "The clip-worker banner generation path is failing in the ffmpeg palette/banner pipeline. Inspect generated frame paths, ffmpeg availability, and cleanup around the temporary banner files.";
  }
  return "The rotator captured this as an actionable app error. Inspect the listed repo context paths and nearest source-owned stack frame before proposing a patch.";
}

function buildPrompt(
  repoLabel: string,
  repoPath: string,
  event: StoredErrorEvent,
  contextFiles: RepoContextFile[],
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
    ...contextFiles.map((file) => `FILE: ${file.path}\nREASON: ${file.reason}\n${file.content}`),
    "",
    `Allowed edit paths: ${contextFiles.map((file) => file.path).join(", ") || "none"}`,
    "",
    "Rules:",
    "- Return strict JSON only.",
    "- First identify the root cause from the provided code evidence, then propose the smallest safe fix.",
    "- Prefer editing an existing file already shown in the candidate source files.",
    "- Every change.path must exactly match one of the allowed edit paths unless the file already exists in the repo.",
    "- Do not rewrite an entire file with generic scaffolding.",
    "- Preserve unrelated code and return the full updated file content only for files you actually modify.",
    "- If the failure is external or config-only and no safe code fix exists, return an empty changes array.",
    "- Avoid repeating a prior failed approach unless the new context clearly invalidates the old failure."
  ].join("\n");
}

async function requestOpenAiFixPlan(prompt: string, repoPath: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
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
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = extractModelText(body.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("OpenAI response did not include content.");
  }

  return normalizeModelPlan(parseModelPlanContent(content), repoPath);
}

async function requestEdenAiFixPlan(prompt: string, repoPath: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
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
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const content = extractModelText(body.choices?.[0]?.message?.content);
  if (!content) {
    throw new Error("EdenAI response did not include content.");
  }

  return normalizeModelPlan(parseModelPlanContent(content), repoPath);
}

async function requestGeminiFixPlan(prompt: string, repoPath: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
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

  return normalizeModelPlan(parseModelPlanContent(content), repoPath);
}

export function extractJsonPayload(content: string): string {
  for (const candidate of extractJsonCandidates(content)) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Continue.
    }
  }
  return content.trim();
}

function parseModelPlanContent(content: string): Partial<ModelFixPlan> {
  const payload = extractJsonPayload(content);
  return JSON.parse(payload) as Partial<ModelFixPlan>;
}

function normalizeModelPlan(parsed: Partial<ModelFixPlan>, repoPath: string): ModelFixPlan {
  const changes = Array.isArray(parsed.changes)
    ? parsed.changes
      .filter((change): change is { path: string; reason: string; content: string } =>
        Boolean(change && typeof change.path === "string" && typeof change.reason === "string" && typeof change.content === "string"))
    : [];

  return {
    summary: String(parsed.summary ?? "No summary provided."),
    diagnosis: String(parsed.diagnosis ?? "No diagnosis provided."),
    confidence: parsed.confidence === "low" || parsed.confidence === "high" ? parsed.confidence : "medium",
    sourceSummary: String(parsed.sourceSummary ?? "Used repo-local source files and package metadata."),
    changes: filterSafeChanges(repoPath, changes)
  };
}

async function collectRepoContext(
  repoPath: string,
  event: StoredErrorEvent
): Promise<RepoContextFile[]> {
  const packageJsonPath = join(repoPath, "package.json");
  const contexts: RepoContextFile[] = [];
  const seenPaths = new Set<string>();
  const searchTerms = deriveSearchTerms(event);

  try {
    const packageJson = await readFile(packageJsonPath, "utf8");
    contexts.push({ path: "package.json", content: clipRelevantFile(packageJson, searchTerms), reason: "package metadata and scripts" });
    seenPaths.add("package.json");
  } catch {
    // No package file.
  }

  for (const relativePath of derivePriorityPaths(event)) {
    const normalizedPath = relativePath.replaceAll("\\", "/");
    if (seenPaths.has(normalizedPath)) continue;
    try {
      const content = await readFile(join(repoPath, relativePath), "utf8");
      contexts.push({
        path: normalizedPath,
        content: clipRelevantFile(content, searchTerms),
        reason: "priority path derived from app/error heuristics"
      });
      seenPaths.add(normalizedPath);
    } catch {
      // Optional priority file missing in this repo variant.
    }
  }

  const candidates = await searchFiles(repoPath, searchTerms, 8);
  for (const candidate of candidates) {
    if (seenPaths.has(candidate.path)) continue;
    contexts.push(candidate);
    seenPaths.add(candidate.path);
  }

  return contexts.slice(0, 10);
}

export function deriveSearchTerms(event: StoredErrorEvent): string[] {
  const terms = new Set<string>();
  const routeMatches = event.message.match(/\/api\/[a-z0-9/_-]+/gi) ?? [];
  for (const route of routeMatches) terms.add(route.toLowerCase());

  const hostRouteMatches = event.message.match(/[A-Za-z0-9.-]+(?:\.fly\.dev)?\/api\/[a-z0-9/_-]+/gi) ?? [];
  for (const route of hostRouteMatches) terms.add(route.toLowerCase());

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

export function derivePriorityPaths(event: StoredErrorEvent): string[] {
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
    paths.add("src/app/api/discord/manual-shoutout/route.ts");
    paths.add("src/lib/twitch-api.ts");
    paths.add("src/lib/twitch.ts");
    if (message.includes("discordcleanup") || message.includes("failed to fetch messages")) {
      paths.add("src/lib/discord-orphan-cleanup-service.ts");
      paths.add("src/lib/discord-sync-service.ts");
      paths.add("src/app/api/admin/access/route.ts");
    }
  }

  if (event.appName === "chat-tag-bot-new" || event.appName === "chat-tag-new") {
    paths.add("bot.js");
    paths.add("src/app/api/tag/route.ts");
    paths.add("src/lib/chat-tag-discord.ts");
    if (message.includes("login authentication failed")) {
      paths.add("bot.js");
      paths.add("src/app/api/twitch/oauth/status/route.ts");
      paths.add("src/app/api/twitch/oauth/callback/route.ts");
    }
  }

  if (event.appName === "streamweaver-new") {
    paths.add("src/services/chat-dispatcher.ts");
    paths.add("src/services/tts-provider.ts");
    paths.add("src/ai/flows/text-to-speech.ts");
    paths.add("src/services/checkin-sources.ts");
    paths.add("src/app/api/ai/image/route.ts");
    paths.add("src/services/image-command.ts");
    paths.add("src/services/seaart.ts");
    paths.add("src/lib/seaart.ts");
    if (message.includes("login authentication failed")) {
      paths.add("src/services/twitch.ts");
      paths.add("src/lib/twitch-oauth-service.ts");
      paths.add("src/lib/twitch-bot-oauth-storage.ts");
      paths.add("src/app/api/twitch/bot-oauth/callback/route.ts");
    }
    if (message.includes("discord public chat activity") || message.includes("unknown channel")) {
      paths.add("src/services/chat-monitor.ts");
      paths.add("src/lib/runtime-config.ts");
      paths.add("src/app/api/runtime-config/route.ts");
    }
    if (message.includes("admin access check failed") || message.includes("/api/admin/access")) {
      paths.add("src/lib/application-access.ts");
      paths.add("src/app/api/admin/access/route.ts");
      paths.add("src/app/(app)/applications/page.tsx");
      paths.add("src/app/api/discord/interactions/route.ts");
    }
  }

  if (event.appName === "hearmeout-main" || event.appName === "hmo-dj-worker") {
    paths.add("worker/src/server.js");
    paths.add("src/app/api/discord/chat/route.ts");
    if (message.includes("watchmode")) {
      paths.add("src/lib/watch/watchmode-provider.ts");
      paths.add("src/lib/watch/watch-request-service.ts");
    }
    if (message.includes("cdn chunk fetch failed")) {
      paths.add("src/app/api/youtube-audio/proxy/route.ts");
    }
    if (message.includes("conversion failed for vod")) {
      paths.add("worker/src/server.js");
    }
  }

  return [...paths];
}

async function searchFiles(
  repoPath: string,
  searchTerms: string[],
  limit: number
): Promise<RepoContextFile[]> {
  const hits: Array<RepoContextFile & { score: number }> = [];
  if (searchTerms.length === 0) return hits;

  const roots = ["src", "app", "pages", "worker", "clip-worker", "scripts"];
  for (const root of roots) {
    const absoluteRoot = join(repoPath, root);
    if (!(await exists(absoluteRoot))) continue;
    await walkFiles(absoluteRoot, async (absolutePath) => {
      if (!isTextSourceFile(absolutePath)) return false;
      const content = await readFile(absolutePath, "utf8").catch(() => "");
      const relativePath = absolutePath.slice(repoPath.length + 1).replaceAll("\\", "/");
      const haystack = `${relativePath}\n${content}`.toLowerCase();
      const matchedTerms = searchTerms.filter((term) => haystack.includes(term)).slice(0, 6);
      if (matchedTerms.length > 0) {
        const score = scoreCandidate(relativePath, content, matchedTerms);
        hits.push({
          path: relativePath,
          content: clipRelevantFile(content, matchedTerms),
          reason: `matched search terms: ${matchedTerms.join(", ")}`,
          score
        });
      }
      return false;
    });
  }

  return hits
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .map(({ score: _score, ...candidate }) => candidate);
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
  if (/\/readme\.md$/i.test(path.replaceAll("\\", "/"))) return false;
  return [".ts", ".tsx", ".js", ".jsx", ".json"].includes(extname(path).toLowerCase());
}

function clipFile(content: string): string {
  return content.length > 12_000 ? `${content.slice(0, 12_000)}\n/* truncated */` : content;
}

function clipRelevantFile(content: string, searchTerms: string[]): string {
  if (content.length <= 12_000 || searchTerms.length === 0) {
    return clipFile(content);
  }

  const lower = content.toLowerCase();
  const chunks: string[] = [];
  const seen = new Set<string>();

  for (const term of searchTerms.slice(0, 6)) {
    const index = lower.indexOf(term.toLowerCase());
    if (index < 0) continue;
    const start = Math.max(0, index - 1200);
    const end = Math.min(content.length, index + 2800);
    const chunk = content.slice(start, end).trim();
    if (!chunk || seen.has(chunk)) continue;
    seen.add(chunk);
    chunks.push(chunk);
    if (chunks.join("\n\n/* --- */\n\n").length >= 12_000) break;
  }

  if (chunks.length === 0) {
    return clipFile(content);
  }

  const combined = chunks.join("\n\n/* --- */\n\n");
  return combined.length > 12_000 ? `${combined.slice(0, 12_000)}\n/* truncated */` : combined;
}

function scoreCandidate(path: string, content: string, matchedTerms: string[]): number {
  const normalizedPath = path.toLowerCase();
  const normalizedContent = content.toLowerCase();
  let score = 0;

  score += matchedTerms.length * 8;
  score += matchedTerms.filter((term) => normalizedPath.includes(term)).length * 12;

  if (normalizedPath.includes("/api/")) score += 8;
  if (normalizedPath.includes("/lib/")) score += 6;
  if (normalizedPath.includes("/worker")) score += 7;
  if (normalizedPath.endsWith("/bot.js") || normalizedPath === "bot.js") score += 10;
  if (normalizedPath.endsWith("/route.ts")) score += 10;
  if (normalizedPath.includes("oauth")) score += 5;
  if (normalizedPath.includes("runtime-config")) score += 5;
  if (normalizedPath.includes("application-access")) score += 8;
  if (normalizedPath.includes("chat-monitor")) score += 8;
  if (normalizedPath.includes("/test") || normalizedPath.endsWith(".test.ts")) score -= 8;
  if (normalizedPath.includes("/ai/flows/")) score -= 6;
  if (normalizedPath.includes("/components/")) score -= 4;

  const exactOccurrences = matchedTerms.reduce((total, term) => {
    return total + (normalizedContent.match(new RegExp(escapeRegExp(term), "g"))?.length ?? 0);
  }, 0);
  score += Math.min(exactOccurrences, 8);

  return score;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractJsonCandidates(content: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const trimmed = content.trim();

  const push = (value: string | undefined) => {
    if (!value) return;
    const candidate = value.trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  push(trimmed);
  push(trimmed.replace(/^json\s*/i, ""));

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)) {
    push(match[1]);
  }

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char !== "{" && char !== "[") continue;
    push(findBalancedJsonPayload(trimmed, index));
  }

  return candidates;
}

function extractModelText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          return firstString(record.text, record.content, record.output_text);
        }
        return undefined;
      })
      .filter((item): item is string => Boolean(item))
      .join("\n")
      .trim();
    return text || undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return firstString(record.text, record.content, record.output_text);
  }
  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function findBalancedJsonPayload(value: string, start: number): string | undefined {
  const open = value[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return value.slice(start, index + 1);
  }

  return undefined;
}

function estimateLineCount(value: string): number {
  return value.split(/\r?\n/).length;
}

function filterSafeChanges(
  repoPath: string,
  changes: Array<{ path: string; reason: string; content: string }>
): Array<{ path: string; reason: string; content: string }> {
  return changes.filter((change) => isSafeChange(repoPath, change));
}

function isSafeChange(
  repoPath: string,
  change: { path: string; reason: string; content: string }
): boolean {
  const normalizedPath = change.path.replaceAll("\\", "/");
  if (normalizedPath.startsWith("../") || normalizedPath.startsWith("/") || normalizedPath.includes("/../")) {
    return false;
  }

  const absolutePath = join(repoPath, change.path);
  if (!existsSync(absolutePath)) {
    return false;
  }

  let currentContent = "";
  try {
    currentContent = readFileSync(absolutePath, "utf8");
  } catch {
    return false;
  }

  const currentLines = estimateLineCount(currentContent);
  const proposedLines = estimateLineCount(change.content);
  if (currentLines >= 120 && proposedLines < Math.floor(currentLines * 0.4)) {
    return false;
  }

  if (currentContent.length >= 4000 && change.content.length < Math.floor(currentContent.length * 0.35)) {
    return false;
  }

  if (!change.content.includes("\n") || !change.content.trim()) {
    return false;
  }

  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
