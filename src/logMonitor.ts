import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { connect, StringCodec } from "nats";
import { getIgnoreRulesFile, IgnoreRuleStore } from "./ignoreRules.js";
import { upsertUnifiedDiscordReport } from "./unifiedReport.js";

interface LogMonitorOptions {
  appNames: string[];
  token: string;
  orgSlug: string;
  discordWebhookUrl?: string;
  dedupeFile: string;
  historyFile: string;
  reportMessageFile: string;
  contextLines: number;
  pollIntervalMs: number;
  sampleDurationMs: number;
}

interface LogEntry {
  appName: string;
  machineId?: string;
  region?: string;
  level?: string;
  timestamp?: string;
  message: string;
  raw: unknown;
}

interface ErrorEvent {
  appName: string;
  fingerprint: string;
  errorLine: LogEntry;
  context: LogEntry[];
  suggestion: string;
}

interface StoredErrorEvent {
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

interface DiscordReportMessageState {
  messageId: string;
  createdAt: string;
  updatedAt: string;
}

const ERROR_PATTERNS = [
  /\berror\b/i,
  /\bexception\b/i,
  /\bunhandled\b/i,
  /\brejection\b/i,
  /\btraceback\b/i,
  /\bfatal\b/i,
  /\bpanic\b/i,
  /\bfailed\b/i,
  /\bsyntaxerror\b/i,
  /\btypeerror\b/i,
  /\breferenceerror\b/i,
  /\bmodule_not_found\b/i,
  /\becconnrefused\b/i,
  /\betimedout\b/i,
  /\bout of memory\b/i,
  /\boom\b/i
];

export async function runLogMonitor(options: LogMonitorOptions): Promise<void> {
  const dedupe = await DedupeStore.load(options.dedupeFile);
  const history = await ErrorHistoryStore.load(options.historyFile);
  const reportState = await DiscordReportStateStore.load(options.reportMessageFile);
  const ignoreRules = await IgnoreRuleStore.load(getIgnoreRulesFile(process.env));
  const contexts = new Map<string, LogEntry[]>();
  for (const appName of options.appNames) contexts.set(appName, []);

  const appSet = new Set(options.appNames);
  const codec = StringCodec();
  const nc = await connect({
    servers: "[fdaa::3]:4223",
    user: options.orgSlug,
    pass: options.token,
    name: "mtman-machine-rotator-log-monitor"
  });
  console.log(`connected to Fly NATS log stream for ${options.orgSlug}; watching ${options.appNames.length} apps`);

  const subscription = nc.subscribe("logs.>");
  for await (const message of subscription) {
    const payload = codec.decode(message.data);
    const subject = parseLogSubject(message.subject) ?? parseLogPayloadSubject(payload);
    if (!subject || !appSet.has(subject.appName)) continue;

    const context = contexts.get(subject.appName) ?? [];
    contexts.set(subject.appName, context);
    await handleLogLine(
      subject.appName,
      payload,
      context,
      options,
      dedupe,
      history,
      reportState,
      ignoreRules,
      undefined,
      subject
    );
  }
}

async function handleLogOutput(
  appName: string,
  output: string,
  context: LogEntry[],
  options: LogMonitorOptions,
  dedupe: DedupeStore
): Promise<{ entries: number; errors: number; sent: number }> {
  const history = await ErrorHistoryStore.load(options.historyFile);
  const reportState = await DiscordReportStateStore.load(options.reportMessageFile);
  const ignoreRules = await IgnoreRuleStore.load(getIgnoreRulesFile(process.env));
  const stats = { entries: 0, errors: 0, sent: 0 };
  const objects = splitJsonObjects(output);
  if (objects.length > 0) {
    for (const objectText of objects) {
      await handleLogLine(appName, objectText, context, options, dedupe, history, reportState, ignoreRules, stats);
    }
    return stats;
  }

  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) await handleLogLine(appName, trimmed, context, options, dedupe, history, reportState, ignoreRules, stats);
  }
  return stats;
}

async function handleLogLine(
  appName: string,
  line: string,
  context: LogEntry[],
  options: LogMonitorOptions,
  dedupe: DedupeStore,
  history: ErrorHistoryStore,
  reportState: DiscordReportStateStore,
  ignoreRules: IgnoreRuleStore,
  stats?: { entries: number; errors: number; sent: number },
  subject?: LogSubject
): Promise<void> {
  const entry = parseFlyLogLine(appName, line);
  entry.machineId ??= subject?.machineId;
  entry.region ??= subject?.region;
  if (stats) stats.entries += 1;
  pushContext(context, entry, options.contextLines);

  if (!looksLikeError(entry.message)) return;
  if (stats) stats.errors += 1;

  const fingerprint = fingerprintError(appName, entry);
  if (dedupe.has(fingerprint)) {
    return;
  }

  const event: ErrorEvent = {
    appName,
    fingerprint,
    errorLine: entry,
    context: [...context],
    suggestion: suggestFix(entry.message)
  };

  if (ignoreRules.matches({
    appName,
    fingerprint,
    message: entry.message
  })) {
    return;
  }

  history.add(event);
  await history.save();
  const sent = await sendErrorReport(options.discordWebhookUrl, event, history, reportState);
  if (sent) {
    if (stats) stats.sent += 1;
    dedupe.add(fingerprint);
    await dedupe.save();
    console.log(`reported ${appName} ${fingerprint}: ${entry.message.slice(0, 180)}`);
  }
}

function splitJsonObjects(output: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const char = output[index];
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
    } else if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        objects.push(output.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return objects;
}

function parseFlyLogLine(appName: string, line: string): LogEntry {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const message = firstString(parsed.message, parsed.msg, parsed.log, parsed.event, parsed.output) ?? line;
    return {
      appName,
      machineId: firstString(parsed.machine_id, parsed.machine, parsed.instance, parsed.id),
      region: firstString(parsed.region),
      level: firstString(parsed.level),
      timestamp: firstString(parsed.timestamp, parsed.time, parsed.ts),
      message,
      raw: parsed
    };
  } catch {
    return { appName, message: line, raw: line };
  }
}

export function looksLikeError(message: string): boolean {
  const normalized = stripAnsi(message);
  if (isNonActionableErrorMessage(normalized)) return false;
  return ERROR_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isNonActionableErrorMessage(message: string): boolean {
  const normalized = stripAnsi(message);
  return isExpectedApplicationResponse(normalized) || isNonActionableErrorEcho(normalized);
}

function isExpectedApplicationResponse(message: string): boolean {
  return [
    /\/api\/quackverse\/pack:\s*429\b.*(?:Daily pack limit reached|"packsRemaining":0|"dailyLimit":\d+)/i,
    /"packsRemaining":0.*"dailyLimit":\d+/i,
    /\/api\/tag:\s*400\b.*You are not it!/i,
    /\/api\/tag:\s*400\b.*"error":"You are not it![^"]+ is it\."/i,
    /\/api\/tag:\s*400\b.*"error":"[^"]+ is immune \((?:20-min cooldown|no-tagback)\)"/i,
    /\/api\/tag:\s*400\b.*"error":"[^"]+ is away\/offline"/i,
    /\[Bot\] Tag API response:.*"error":"You are not it![^"]+ is it\.".+"__status":400/i,
    /\[Bot\] Tag API response:.*"__status":400.*You are not it!/i,
    /\[Bot\] Tag API response:.*"error":"[^"]+ is immune \((?:20-min cooldown|no-tagback)\)".*"__status":400/i,
    /\[Bot\] Tag API response:.*"error":"[^"]+ is away\/offline".*"__status":400/i,
    /\[Bot\] Tag error: You are not it![^:]+ is it\./i,
    /\[Bot\] Tag error: You are not it!/i,
    /\[Bot\] Tag error: [^:]+ is immune \((?:20-min cooldown|no-tagback)\)/i,
    /\[Bot\] Tag error: [^:]+ is away\/offline/i,
    /\[Bot\] Join result: .*"error":"Already in game"/i,
    /\[API Error\]\s*\/api\/tag:\s*400\b.*"error":"Already in game"/i,
    /\[Bot\] Failed joining .+:\s*msg_banned/i,
    /\[Bot\] Auto-blacklisting banned channel:/i,
    /\[Bot\] Join failed .+: account exists \(id=\d+\) but IRC timed out/i,
    /\[Bot\] Auto-rotate failed \(\d+\/\d+\): no other live eligible players/i,
    /\[Bot\] Auto-rotate failed \d+ times for .+; triggering FFA fallback/i,
    /\[PM\d+\] machines API returned an error: "machine still attempting to start"/i,
    /\[PM\d+\] machines API returned an error: "machine ID [^"]+ lease currently held by [^"]+"/i,
    /\[PM\d+\] machines API returned an error: "rate limit exceeded"/i,
    /\[PM\d+\] machine is in a non-startable state: stopping/i,
    /\[PM\d+\] failed to change machine state: machine getting replaced, refusing to start/i,
    /\[PM\d+\] failed to change machine state: unable to start machine from current state: 'created'/i,
    /\[PM\d+\] failed to connect to machine: gave up after \d+ attempts/i,
    /\[PC\d+\] failed to connect to instance after \d+ attempts/i,
    /\[PR\d+\] could not find a good candidate within \d+ attempts? at load balancing(?:\. last error: \[(?:PM|PR)\d+\] (?:failed to connect to machine|machines API returned an error: "(?:rate limit exceeded|machine ID [^"]+ lease currently held by [^"]+)"))?/i,
    /\[PP\d+\] could not proxy TCP data.*(?:unexpected end of file|connection reset by peer)/i,
    /\[PU\d+\] could not complete HTTP request to instance:.*(?:connection closed before message completed|connection reset|connection error|tls\/http-multihop)/i,
    /\[PR\d+\] could not find a good candidate.*machine lease currently held/i,
    /\[PM\d+\].*machine lease currently held/i,
    /^\s*referer:\s*['"]?https?:\/\/[^'"]*(?:error=|error_description=)/i,
    /error umounting \/data: EBUSY: Device or resource busy, retrying in a bit/i,
    /error signaling \(SIGTERM\) main child process: ESRCH: No such process/i,
    /unexpected error executing command error="exec: "?powershell"?: executable file not found in \$PATH"/i,
    /^(?:\S+\s+)?Error: failed to pipe response$/i,
    /^\s*\[cause\]: TypeError: terminated$/i,
    /^\s*\[cause\]: Error \[SocketError\]: other side closed$/i,
    /\[PU\d+\] could not finish reading HTTP body from instance: error reading a body from connection/i,
    /\[TTS\] inworld failed .* falling back to EdenAI:/i,
    /\[TTS\] OpenAI failed .* falling back to EdenAI/i,
    /\[Kick\]\s*.+Pusher connection error .*code:\s*1006/i,
    /\[Discord Cleanup\] Message delete failed:/i,
    /Discord API 404: .*"Unknown Message".*"code":\s*10008/i,
    /\[(?:\d{2}:\d{2})\] error: Ping timeout\./i,
    /\[(?:\d{2}:\d{2})\] error: Could not connect to server\. Reconnecting in \d+ seconds?\./i,
    /\[API Error\]\s*\/api\/tag:\s*400\b.*"error":"You don't have a pass!/i,
    /Discord fetch failed .*\/members\/codex-test-user:\s*400\b.*NUMBER_TYPE_COERCE/i,
    /Failed to fetch Twitch user:\s*429 Too Many Requests/i,
    /Failed to fetch Twitch badges.*Too Many Requests/i,
    /Failed to load badges for new client: Error: Failed to fetch Twitch badges: Too Many Requests/i,
    /Failed to fetch Twitch channel info for user:/i,
    /\[(?:BRB|WalkOn)\].*Failed to fetch Twitch user: Too Many Requests/i,
    /Twitch profile lookup failed .* Failed to fetch Twitch user: Too Many Requests/i,
    /\[HTTP [^\]]+\] Sending as 'bot': .* Double or nothing failed\./i,
    /\[DiscordInteractions\] Signature verification failed/i,
    /Failed to delete message .*:\s*503\b/i,
    /<title>503 Server Error<\/title>/i,
    /<h1>Error: Server Error<\/h1>/i,
    /<h2>The service you requested is not available at this time\./i,
    /Fontconfig error: Cannot load default config file/i
  ].some((pattern) => pattern.test(message));
}

function isNonActionableErrorEcho(message: string): boolean {
  return [
    /\[Twitch\] Message sent via API:/i,
    /^\[DiscordChat\] Received:\s*\{/i,
    /\[Dispatcher\] Handling Twitch message:/i,
    /\[Dispatcher\] Non-command message from .+, checking mentions\./i,
    /\[BRB\] Playing clip:/i,
    /\[Twitch:[^\]]+\] Failed to join #[^:]+: msg_banned/i,
    /\[TTS API\] Request:\s*\{/i,
    /^\s*(?:textLength|textPreview|voice|tenantId):\s*/i,
    /\[HTTP [^\]]+\] Sending as .*failed to create clip!\s*\(500\)/i
  ].some((pattern) => pattern.test(message));
}

function fingerprintError(appName: string, entry: LogEntry): string {
  const normalized = normalizeErrorMessage(stripAnsi(entry.message))
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)\b/g, "<duration>")
    .replace(/\b\d+\.\d+\b/g, "<decimal>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b\d{4,}\b/g, "<num>")
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[A-Z]:\\[^)\s]+/gi, "<path>")
    .replace(/\/[^\s)]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
  return createHash("sha256").update(`${appName}:${normalized}`).digest("hex").slice(0, 16);
}

function stripAnsi(message: string): string {
  return message.replace(/\x1b\[[0-9;]*m/g, "");
}

function normalizeErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (
    lower.includes("maximum number of edits to messages older than 1 hour reached") ||
    lower.includes("failed to edit message") && lower.includes("429") ||
    lower.includes("failed to edit message: 429 too many requests")
  ) {
    return "discord message edit limit for old messages";
  }
  if (lower.includes("discord api error: 404") && lower.includes("unknown channel")) {
    return "discord configured channel missing";
  }
  if (lower.includes("discord api error: 429") && lower.includes("rate limited")) {
    return "discord chat history rate limited";
  }
  if (lower.includes("invalid authorization code") && lower.includes("twitchoauth")) {
    return "twitch oauth invalid authorization code";
  }
  if (lower.includes("oauth callback error") && lower.includes("failed to exchange code for token")) {
    return "twitch oauth invalid authorization code";
  }
  if (lower.includes("no response from twitch")) {
    return "twitch chat connection no response";
  }
  if (lower.includes("streamweaver-main.fly.dev") && lower.includes("enotfound")) {
    return "kick broadcast target host streamweaver-main.fly.dev not found";
  }
  if (lower.includes("[kick broadcast]") && lower.includes("typeerror: fetch failed")) {
    return "kick broadcast fetch failed";
  }
  if (lower.includes("/api/kick/broadcast") && lower.includes("fetch failed")) {
    return "kick broadcast api fetch failed";
  }
  if (
    lower.includes("failed to refresh token") ||
    lower.includes("invalid refresh token") ||
    lower.includes("error creating clip") ||
    lower.includes("clip creation failed")
  ) {
    return "twitch token refresh invalid";
  }
  if (lower.includes("twitch") && lower.includes("unauthorized")) {
    return "twitch api unauthorized";
  }
  if (lower.includes("clip fetch failed") && lower.includes("failed to fetch twitch user: unauthorized")) {
    return "twitch api unauthorized";
  }
  return message;
}

function suggestFix(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("admin access check failed") && lower.includes("/api/admin/access") && lower.includes("404")) {
    return "StreamWeaver is calling DiscordStreamHub /api/admin/access and getting a Next.js 404 page back. Check that the route exists in the deployed DSH app, verify the base URL points at the correct deployment, and fail closed with a compact error instead of logging the full HTML 404 response.";
  }
  if (lower.includes("discord public chat activity") && lower.includes("unknown channel")) {
    return "The stored Discord public-chat channel ID is stale or inaccessible. Remove or replace that channel mapping, and treat Discord 404 Unknown Channel for optional activity polling as a handled config warning instead of a repeating hard error.";
  }
  if (lower.includes("[discordcleanup] failed to fetch messages:") && lower.includes("500")) {
    return "Discord returned a transient 500 while the cleanup job was reading channel history. Add retry/backoff for Discord 5XX responses and downgrade a single failed channel scan to a warning so one flaky read does not stay in the live error queue.";
  }
  if (lower.includes("login authentication failed")) {
    return "A Twitch IRC login failed during reconnect. Check the token refresh and reconnect path for that app, verify the refreshed token is persisted before reconnect, and only surface this as a hard error if the retry path also fails.";
  }
  if (lower.includes("failed to get needed list: 502")) {
    return "The clip worker could not fetch /api/clips/needed because the upstream DSH route returned 502. Check the DSH route and add retry/backoff around the worker fetch so a transient upstream error does not poison the queue.";
  }
  if (lower.includes("invalid json payload")) {
    return "The Discord chat route is receiving malformed or truncated JSON. Inspect the request-body parsing path, log the raw payload length safely, and harden parsing so one bad payload does not cascade into multiple app errors.";
  }
  if (lower.includes("watchmode returned 401")) {
    return "Watchmode rejected the fallback request with 401. Verify the Watchmode API key secret and, if the app should tolerate missing Watchmode access, downgrade the fallback failure to a handled warning instead of a noisy error.";
  }
  if (lower.includes("cdn chunk fetch failed (401)")) {
    return "The proxy is reusing an expired signed CDN URL for range fetches. Refresh the media URL before later chunk requests or restart the fetch from a newly resolved source URL when the CDN returns 401.";
  }
  if (lower.includes("conversion failed for vod")) {
    return "The HLS worker hit an unexpected 4XX from the VOD source. Handle non-401/403/404 client errors explicitly, capture the exact status code, and stop retrying permanent source URLs that are no longer playable.";
  }
  if (lower.includes("tts generation failed") && lower.includes("aborterror")) {
    return "The TTS provider aborted mid-request. Catch AbortError in the TTS flow, log it as a handled provider timeout, and fall back cleanly instead of surfacing it as a hard error.";
  }
  if (lower.includes("failed to fetch crew source: 404")) {
    return "The crew source URL is returning a 404 HTML page instead of JSON. Fix the configured crew API URL and add a guard that treats HTML 404 responses as a configuration issue, not a parsing failure.";
  }
  if (lower.includes("maximum number of edits to messages older than 1 hour reached")) {
    return "Discord blocks repeated edits to messages older than one hour. Repost a fresh message instead of editing the old one, then update stored message IDs.";
  }
  if (lower.includes("streamweaver-main.fly.dev") && lower.includes("enotfound")) {
    return "The hostname streamweaver-main.fly.dev does not resolve. Update that config/env value to the current Streamweaver app hostname, likely streamweaver-new.fly.dev.";
  }
  if (lower.includes("failed to refresh token") || lower.includes("invalid refresh token")) {
    return "The Twitch refresh token is invalid. Re-authorize the broadcaster account, store the new refresh/access token pair, and restart the app.";
  }
  if (lower.includes("twitch") && lower.includes("unauthorized")) {
    return "A Twitch token is invalid or missing scope. Re-authorize the affected Twitch account, save the new token pair, and restart the app.";
  }
  if (lower.includes("discord api error: 404") && lower.includes("unknown channel")) {
    return "A stored Discord channel ID no longer exists or the bot cannot access it. Remove or update that channel mapping.";
  }
  if (lower.includes("discord api error: 429") && lower.includes("rate limited")) {
    return "Discord rate-limited the history read. Respect retry_after, retry once, and avoid parallel history loads for the same channel.";
  }
  if (lower.includes("invalid authorization code") || lower.includes("failed to exchange code for token")) {
    return "The Twitch OAuth code was invalid, expired, already used, or generated for a different redirect URI. Restart the OAuth flow and verify the configured public URL.";
  }
  if (lower.includes("no response from twitch")) {
    return "The Twitch chat connection did not receive a response. Treat this as transient unless it repeats; reconnect with backoff and check Twitch connectivity.";
  }
  if (lower.includes("module_not_found") || lower.includes("cannot find module")) {
    return "Check that the missing package is in production dependencies, the build copies compiled files into the image, and the start command points at the emitted path.";
  }
  if (lower.includes("syntaxerror") || lower.includes("unexpected token")) {
    return "Check the config or source file named in the stack trace. For env JSON, prefer comma-separated values or validate with JSON.parse locally before setting the secret.";
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return "Check the target service hostname, port, private networking, and whether the dependency is started before the app connects.";
  }
  if (lower.includes("etimedout") || lower.includes("timeout")) {
    return "Check upstream latency, retry/backoff settings, regional placement, and whether a dependency is overloaded or unreachable.";
  }
  if (lower.includes("out of memory") || lower.includes("oom")) {
    return "Check memory usage around the failing path, reduce concurrency or buffering, and consider increasing the Machine memory size.";
  }
  if (lower.includes("unauthorized") || lower.includes("forbidden") || lower.includes("401") || lower.includes("403")) {
    return "Check the relevant API token secret, token scopes, expiration, and whether the app was redeployed after secret changes.";
  }
  if (lower.includes("typeerror") || lower.includes("cannot read properties")) {
    return "Check the stack frame nearest your source code and add validation/default handling for the value that can be null or undefined.";
  }
  return "Inspect the nearest stack trace frame that points to your source code, reproduce with the same env vars, and add a narrow regression test around that path.";
}

async function sendErrorReport(
  webhookUrl: string | undefined,
  event: ErrorEvent,
  history: ErrorHistoryStore,
  reportState: DiscordReportStateStore
): Promise<boolean> {
  if (!webhookUrl) {
    console.warn(`No DISCORD_WEBHOOK_URL set; would report ${event.appName} ${event.fingerprint}`);
    return false;
  }
  await upsertUnifiedDiscordReport(webhookUrl);
  return true;
}

function formatEntry(entry: LogEntry): string {
  const parts = [
    entry.timestamp ?? new Date().toISOString(),
    entry.appName,
    entry.machineId ?? "-",
    entry.level ?? "info",
    entry.message
  ];
  return parts.join(" ");
}

function pushContext(context: LogEntry[], entry: LogEntry, limit: number): void {
  context.push(entry);
  while (context.length > limit) context.shift();
}

interface LogSubject {
  appName: string;
  region: string;
  machineId: string;
}

function parseLogSubject(subject: string): LogSubject | undefined {
  const [prefix, appName, region, machineId] = subject.split(".");
  if (prefix !== "logs" || !appName || !region || !machineId) return undefined;
  return { appName, region, machineId };
}

function parseLogPayloadSubject(payload: string): LogSubject | undefined {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const subject = firstString(parsed.subject, parsed.nats_subject, parsed.stream_subject);
    if (subject) return parseLogSubject(subject);

    const fly = isRecord(parsed.fly) ? parsed.fly : undefined;
    const flyApp = isRecord(fly?.app) ? fly.app : undefined;
    const appName = firstString(parsed.app, parsed.app_name, parsed.fly_app_name, flyApp?.name);
    const region = firstString(parsed.region, parsed.fly_region, fly?.region) ?? "unknown";
    const machineId =
      firstString(parsed.instance, parsed.machine_id, parsed.machine, parsed.fly_machine_id, flyApp?.instance) ?? "unknown";
    if (appName) return { appName, region, machineId };
  } catch {
    return undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

class DedupeStore {
  private constructor(
    private readonly path: string,
    private readonly values: Set<string>
  ) {}

  static async load(path: string): Promise<DedupeStore> {
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as string[];
      return new DedupeStore(path, new Set(parsed));
    } catch {
      return new DedupeStore(path, new Set());
    }
  }

  has(value: string): boolean {
    return this.values.has(value);
  }

  add(value: string): void {
    this.values.add(value);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify([...this.values].slice(-2000), null, 2));
  }
}

class DiscordReportStateStore {
  private constructor(
    private readonly path: string,
    private value?: DiscordReportMessageState
  ) {}

  static async load(path: string): Promise<DiscordReportStateStore> {
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as DiscordReportMessageState;
      if (typeof parsed.messageId === "string" && parsed.messageId.trim()) {
        return new DiscordReportStateStore(path, parsed);
      }
    } catch {
      // Missing state just means the next alert creates the rolling report.
    }
    return new DiscordReportStateStore(path);
  }

  get(): DiscordReportMessageState | undefined {
    return this.value;
  }

  async set(value: DiscordReportMessageState): Promise<void> {
    this.value = value;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(value, null, 2));
  }

  async clear(): Promise<void> {
    this.value = undefined;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({}, null, 2));
  }
}

class ErrorHistoryStore {
  private constructor(
    private readonly path: string,
    private readonly values: StoredErrorEvent[]
  ) {}

  static async load(path: string): Promise<ErrorHistoryStore> {
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as StoredErrorEvent[];
      return new ErrorHistoryStore(path, Array.isArray(parsed) ? parsed : []);
    } catch {
      return new ErrorHistoryStore(path, []);
    }
  }

  add(event: ErrorEvent): void {
    this.prune();
    this.values.push({
      recordedAt: new Date().toISOString(),
      appName: event.appName,
      fingerprint: event.fingerprint,
      machineId: event.errorLine.machineId,
      region: event.errorLine.region,
      timestamp: event.errorLine.timestamp,
      message: event.errorLine.message,
      suggestion: event.suggestion,
      context: event.context.map(formatEntry)
    });
    this.prune();
  }

  renderLast24Hours(): string {
    this.prune();
    const lines = [
      `Fly Log Monitor - errors from the last 24 hours`,
      `Generated: ${new Date().toISOString()}`,
      `Count: ${this.values.length}`,
      ""
    ];

    for (const event of this.values) {
      lines.push("=".repeat(80));
      lines.push(`${event.recordedAt} ${event.appName} ${event.fingerprint}`);
      lines.push(`machine=${event.machineId ?? "unknown"} region=${event.region ?? "unknown"} log_time=${event.timestamp ?? "unknown"}`);
      lines.push(`error: ${event.message}`);
      lines.push(`suggestion: ${event.suggestion}`);
      lines.push("recent logs:");
      lines.push(...event.context.map((line) => `  ${line}`));
      lines.push("");
    }

    return lines.join("\n").slice(-900_000);
  }

  renderDiscordSummary(): string {
    this.prune();
    const latest = this.values.slice(-10).reverse();
    const counts = new Map<string, number>();
    for (const event of this.values) {
      counts.set(event.appName, (counts.get(event.appName) ?? 0) + 1);
    }
    const countText = [...counts.entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([appName, count]) => `${appName}: ${count}`)
      .join(", ");

    const lines = [
      `count=${this.values.length}${countText ? ` (${countText})` : ""}`,
      ...latest.map((event) => {
        const when = event.timestamp ?? event.recordedAt;
        return `${when} ${event.appName} ${event.fingerprint} ${event.message}`.slice(0, 260);
      })
    ];
    return lines.join("\n").slice(0, 3800);
  }

  async save(): Promise<void> {
    this.prune();
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.values.slice(-2000), null, 2));
  }

  private prune(): void {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    while (this.values.length > 0 && Date.parse(this.values[0].recordedAt) < cutoff) {
      this.values.shift();
    }
  }
}
