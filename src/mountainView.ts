import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";

type JsonRecord = Record<string, unknown>;

type MountainViewConfig = {
  services: Array<{
    id: string;
    name: string;
    baseUrl: string;
    defaultHeaders?: Record<string, string>;
  }>;
  metaWearables: {
    toolkitStatus: string;
    flashControlSupported: boolean;
    notes: string[];
  };
};

const defaultConfig: MountainViewConfig = {
  services: [
    { id: "streamweaver", name: "StreamWeaver", baseUrl: "https://streamweaver-new.fly.dev" },
    { id: "discordstreamhub", name: "DiscordStreamHub", baseUrl: "https://discord-stream-hub-new.fly.dev" },
    { id: "chat-tag", name: "Chat-Tag", baseUrl: "https://chat-tag-new.fly.dev" },
    { id: "hearmeout", name: "HearMeOut", baseUrl: "https://hearmeout-main.fly.dev" }
  ],
  metaWearables: {
    toolkitStatus: "Developer preview bridge. Camera/audio/display support depends on Meta Wearables Device Access Toolkit availability for the signed-in developer account and target glasses.",
    flashControlSupported: false,
    notes: [
      "MountainView AI does not run face recognition.",
      "Image analysis is delegated to StreamWeaver or configured Spacemountain services.",
      "Direct glasses live streaming and flash control are capability-gated until exposed by the Meta SDK/API available to this app."
    ]
  }
};

export async function handleMountainViewRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/mountainview")) return false;

  const apiPath = url.pathname.replace(/^\/mountainview\/api/, "/api");
  const context = await MountainViewContext.create(env);

  if (method === "GET" && (url.pathname === "/mountainview" || url.pathname === "/mountainview/")) {
    html(response, renderMountainViewHtml());
    return true;
  }

  if (method === "GET" && apiPath === "/api/status") {
    return json(response, {
      ok: true,
      app: "MountainView AI",
      device: {
        connected: false,
        bridgeMode: "phone-side",
        supportedEvents: ["voice-command", "image", "command-trigger", "audio-event"],
        metaWearables: context.config.metaWearables
      }
    });
  }

  if (method === "POST" && apiPath === "/api/login") {
    const body = await readJson(request);
    const session = context.login(String(body.email ?? "owner@spacemountain.live"), String(body.password ?? ""));
    return json(response, session);
  }

  if (method === "GET" && apiPath === "/api/bootstrap") {
    const user = context.requireAuth(request);
    return json(response, {
      user,
      config: context.publicConfig(),
      commands: context.listCommands(user.id),
      memory: context.searchMemory(user.id, "", ""),
      logs: context.listLogs(user.id)
    });
  }

  if (method === "GET" && apiPath === "/api/commands") {
    const user = context.requireAuth(request);
    return json(response, { commands: context.listCommands(user.id) });
  }

  if (method === "POST" && apiPath === "/api/commands") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.saveCommand(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/commands/execute") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    const result = await context.executeCommand(user.id, String(body.commandId ?? ""), asRecord(body.payload));
    return json(response, result);
  }

  if (method === "POST" && apiPath === "/api/media/streamweaver") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 20 * 1024 * 1024);
    const result = await context.relayImageToStreamWeaver(user.id, body);
    return json(response, result);
  }

  if (method === "GET" && apiPath === "/api/memory") {
    const user = context.requireAuth(request);
    return json(response, {
      records: context.searchMemory(user.id, url.searchParams.get("q") ?? "", url.searchParams.get("tag") ?? "")
    });
  }

  if (method === "POST" && apiPath === "/api/memory") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.saveMemory(user.id, body));
  }

  if (method === "GET" && apiPath === "/api/logs") {
    const user = context.requireAuth(request);
    return json(response, { logs: context.listLogs(user.id) });
  }

  if (method === "GET" && apiPath === "/api/admin/integrations") {
    const user = context.requireAuth(request, true);
    return json(response, { integrations: context.listIntegrations(user.id) });
  }

  if (method === "POST" && apiPath === "/api/admin/integrations") {
    const user = context.requireAuth(request, true);
    const body = await readJson(request);
    return json(response, context.saveIntegration(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/settings/token") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.saveServiceToken(user.id, String(body.serviceId ?? ""), String(body.token ?? "")));
  }

  response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: false, error: "MountainView route not found" }));
  return true;
}

class MountainViewContext {
  private readonly db: Database.Database;
  private readonly tokenKey: Buffer;

  private constructor(
    readonly env: NodeJS.ProcessEnv,
    readonly config: MountainViewConfig
  ) {
    const dbFile = env.MOUNTAINVIEW_DB_FILE ?? "/data/mountainview.db";
    this.db = new Database(dbFile);
    this.db.pragma("journal_mode = WAL");
    this.tokenKey = createHash("sha256").update(env.MOUNTAINVIEW_TOKEN_ENCRYPTION_KEY ?? env.FLY_API_TOKEN ?? "mountainview-dev-key").digest();
    this.migrate();
    this.seedDefaults();
  }

  static async create(env: NodeJS.ProcessEnv): Promise<MountainViewContext> {
    const configFile = env.MOUNTAINVIEW_CONFIG_FILE ?? "/data/mountainview-config.json";
    const config = await loadRuntimeConfig(configFile);
    return new MountainViewContext(env, config);
  }

  login(email: string, password: string): JsonRecord {
    const ownerPassword = this.env.MOUNTAINVIEW_OWNER_PASSWORD ?? this.env.ROTATOR_ACTION_TOKEN ?? "mountainview-dev";
    if (!safeEqual(password, ownerPassword)) throw new HttpError(401, "Invalid MountainView credentials.");
    const now = new Date().toISOString();
    const userId = "owner";
    this.db.prepare(`
      INSERT INTO users (id, email, role, created_at)
      VALUES (?, ?, 'admin', ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email
    `).run(userId, email, now);
    const token = randomBytes(32).toString("base64url");
    const tokenHash = hashToken(token);
    this.db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(tokenHash, userId, now, new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString());
    return { token, user: { id: userId, email, role: "admin" } };
  }

  requireAuth(request: IncomingMessage, admin = false): { id: string; email: string; role: string } {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    const tokenHash = hashToken(token);
    const row = this.db.prepare(`
      SELECT users.id, users.email, users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(tokenHash, new Date().toISOString()) as { id: string; email: string; role: string } | undefined;
    if (!row) throw new HttpError(401, "Unauthorized.");
    if (admin && row.role !== "admin") throw new HttpError(403, "Admin access required.");
    return row;
  }

  publicConfig(): MountainViewConfig {
    return this.config;
  }

  listCommands(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM command_definitions WHERE user_id = ? OR user_id = 'system' ORDER BY updated_at DESC")
      .all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  saveCommand(userId: string, input: JsonRecord): JsonRecord {
    const id = String(input.id ?? `cmd_${Date.now()}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO command_definitions (id, user_id, app_id, name, phrase, method, url_template, payload_template, retry_count, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        app_id = excluded.app_id,
        name = excluded.name,
        phrase = excluded.phrase,
        method = excluded.method,
        url_template = excluded.url_template,
        payload_template = excluded.payload_template,
        retry_count = excluded.retry_count,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      String(input.app_id ?? input.appId ?? "streamweaver"),
      String(input.name ?? "Custom command"),
      String(input.phrase ?? ""),
      String(input.method ?? "POST").toUpperCase(),
      String(input.url_template ?? input.urlTemplate ?? "/api/events"),
      JSON.stringify(input.payload_template ?? input.payloadTemplate ?? {}),
      Number(input.retry_count ?? input.retryCount ?? 1),
      input.enabled === false ? 0 : 1,
      now
    );
    return { ok: true, command: this.db.prepare("SELECT * FROM command_definitions WHERE id = ?").get(id) as JsonRecord };
  }

  async executeCommand(userId: string, commandId: string, payload: JsonRecord): Promise<JsonRecord> {
    const command = this.db.prepare("SELECT * FROM command_definitions WHERE id = ? AND (user_id = ? OR user_id = 'system')")
      .get(commandId, userId) as JsonRecord | undefined;
    if (!command) throw new HttpError(404, "Command not found.");
    if (Number(command.enabled) !== 1) throw new HttpError(400, "Command is disabled.");
    const integration = this.getIntegration(String(command.app_id));
    const url = new URL(renderTemplate(String(command.url_template), payload), integration.baseUrl).toString();
    const method = String(command.method);
    const bodyPayload = renderJsonTemplate(String(command.payload_template ?? "{}"), payload);
    const started = Date.now();
    const retries = Math.max(0, Number(command.retry_count ?? 1));
    let lastError = "";
    let status = 0;
    let responseText = "";

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const headers = await this.authHeaders(userId, String(command.app_id), integration.defaultHeaders);
        const fetchResult = await fetch(url, {
          method,
          headers,
          body: method === "GET" ? undefined : JSON.stringify(bodyPayload)
        });
        status = fetchResult.status;
        responseText = await fetchResult.text();
        if (fetchResult.ok) {
          this.logCommand(userId, commandId, String(command.app_id), method, url, "success", status, Date.now() - started, responseText.slice(0, 4000), "");
          return { ok: true, status, response: parseMaybeJson(responseText) };
        }
        lastError = `HTTP ${fetchResult.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    this.logCommand(userId, commandId, String(command.app_id), method, url, "error", status, Date.now() - started, responseText.slice(0, 4000), lastError);
    return { ok: false, status, error: lastError, response: parseMaybeJson(responseText) };
  }

  async relayImageToStreamWeaver(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const integration = this.getIntegration("streamweaver");
    const endpoint = String(input.endpoint ?? "/api/mountainview/image-relay");
    const url = new URL(endpoint, integration.baseUrl).toString();
    const metadata = asRecord(input.metadata);
    const payload = {
      source: "mountainview-ai",
      imageBase64: String(input.imageBase64 ?? ""),
      imageUrl: input.imageUrl ? String(input.imageUrl) : undefined,
      metadata
    };
    const started = Date.now();
    let status = 0;
    let responseText = "";
    let state = "error";
    let error = "";
    try {
      const result = await fetch(url, {
        method: "POST",
        headers: await this.authHeaders(userId, "streamweaver"),
        body: JSON.stringify(payload)
      });
      status = result.status;
      responseText = await result.text();
      state = result.ok ? "uploaded" : "error";
      error = result.ok ? "" : `HTTP ${result.status}`;
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO media_uploads (id, user_id, service_id, endpoint, status, metadata_json, response_status, response_body, error, created_at)
      VALUES (?, ?, 'streamweaver', ?, ?, ?, ?, ?, ?, ?)
    `).run(`media_${Date.now()}`, userId, url, state, JSON.stringify(metadata), status, responseText.slice(0, 4000), error, now);
    this.logCommand(userId, "streamweaver-image-relay", "streamweaver", "POST", url, state === "uploaded" ? "success" : "error", status, Date.now() - started, responseText.slice(0, 4000), error);
    return { ok: state === "uploaded", status, response: parseMaybeJson(responseText), error };
  }

  saveMemory(userId: string, input: JsonRecord): JsonRecord {
    const id = `mem_${Date.now()}`;
    const now = new Date().toISOString();
    const tags = normalizeTags(input.tags);
    this.db.prepare(`
      INSERT INTO memory_records (id, user_id, kind, title, body, tags_json, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, String(input.kind ?? "note"), String(input.title ?? "Untitled memory"), String(input.body ?? ""), JSON.stringify(tags), JSON.stringify(asRecord(input.metadata)), now);
    return { ok: true, record: normalizeRow(this.db.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) as JsonRecord) };
  }

  searchMemory(userId: string, query: string, tag: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM memory_records WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId) as JsonRecord[];
    return rows.map(normalizeRow).filter((row) => {
      const haystack = `${row.title ?? ""} ${row.body ?? ""}`.toLowerCase();
      const tags = Array.isArray(row.tags) ? row.tags.map(String) : [];
      return (!query || haystack.includes(query.toLowerCase())) && (!tag || tags.includes(tag));
    });
  }

  listLogs(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM command_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  listIntegrations(_userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT id, name, base_url, default_headers_json, updated_at FROM service_integrations ORDER BY name").all() as JsonRecord[];
    return rows.map(normalizeRow);
  }

  saveIntegration(_userId: string, input: JsonRecord): JsonRecord {
    const id = String(input.id ?? "").trim();
    if (!id) throw new HttpError(400, "Integration id is required.");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO service_integrations (id, name, base_url, default_headers_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, base_url = excluded.base_url, default_headers_json = excluded.default_headers_json, updated_at = excluded.updated_at
    `).run(id, String(input.name ?? id), String(input.baseUrl ?? input.base_url ?? ""), JSON.stringify(asRecord(input.defaultHeaders ?? input.default_headers)), now);
    return { ok: true, integration: normalizeRow(this.db.prepare("SELECT * FROM service_integrations WHERE id = ?").get(id) as JsonRecord) };
  }

  saveServiceToken(userId: string, serviceId: string, token: string): JsonRecord {
    if (!serviceId || !token) throw new HttpError(400, "serviceId and token are required.");
    this.db.prepare(`
      INSERT INTO service_tokens (user_id, service_id, encrypted_token, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, service_id) DO UPDATE SET encrypted_token = excluded.encrypted_token, updated_at = excluded.updated_at
    `).run(userId, serviceId, this.encrypt(token), new Date().toISOString());
    return { ok: true };
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_integrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, default_headers_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS service_tokens (user_id TEXT NOT NULL, service_id TEXT NOT NULL, encrypted_token TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, service_id));
      CREATE TABLE IF NOT EXISTS command_definitions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phrase TEXT NOT NULL,
        method TEXT NOT NULL,
        url_template TEXT NOT NULL,
        payload_template TEXT NOT NULL,
        retry_count INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS media_uploads (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        service_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        response_status INTEGER NOT NULL,
        response_body TEXT NOT NULL,
        error TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private seedDefaults(): void {
    const now = new Date().toISOString();
    for (const service of this.config.services) {
      this.db.prepare(`
        INSERT INTO service_integrations (id, name, base_url, default_headers_json, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(service.id, service.name, service.baseUrl, JSON.stringify(service.defaultHeaders ?? {}), now);
    }
    const defaults = [
      ["cmd_streamweaver_image", "streamweaver", "Send image to StreamWeaver", "send image to streamweaver", "POST", "/api/mountainview/image-relay", { source: "meta-glasses", imageBase64: "{{imageBase64}}", metadata: "{{metadata}}" }],
      ["cmd_stream_start", "streamweaver", "Start stream workflow", "start stream workflow", "POST", "/api/stream/start", { source: "mountainview-ai", payload: "{{payload}}" }],
      ["cmd_discord_event", "discordstreamhub", "Push event to DiscordStreamHub", "push event to discord", "POST", "/api/events", { source: "mountainview-ai", event: "{{payload}}" }],
      ["cmd_chat_tag", "chat-tag", "Trigger Chat-Tag workflow", "trigger chat tag", "POST", "/api/tags/events", { source: "mountainview-ai", tag: "{{payload}}" }],
      ["cmd_hearmeout", "hearmeout", "Trigger HearMeOut workflow", "trigger hear me out", "POST", "/api/events", { source: "mountainview-ai", event: "{{payload}}" }]
    ] as const;
    for (const command of defaults) {
      this.db.prepare(`
        INSERT INTO command_definitions (id, user_id, app_id, name, phrase, method, url_template, payload_template, retry_count, enabled, updated_at)
        VALUES (?, 'system', ?, ?, ?, ?, ?, ?, 2, 1, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(command[0], command[1], command[2], command[3], command[4], command[5], JSON.stringify(command[6]), now);
    }
  }

  private getIntegration(serviceId: string): { id: string; name: string; baseUrl: string; defaultHeaders: Record<string, string> } {
    const row = this.db.prepare("SELECT * FROM service_integrations WHERE id = ?").get(serviceId) as JsonRecord | undefined;
    if (!row) throw new HttpError(404, `Integration ${serviceId} not found.`);
    return {
      id: String(row.id),
      name: String(row.name),
      baseUrl: String(row.base_url),
      defaultHeaders: parseJsonObject(String(row.default_headers_json ?? "{}")) as Record<string, string>
    };
  }

  private async authHeaders(userId: string, serviceId: string, defaults: Record<string, string> = {}): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "content-type": "application/json", ...defaults };
    const row = this.db.prepare("SELECT encrypted_token FROM service_tokens WHERE user_id = ? AND service_id = ?").get(userId, serviceId) as { encrypted_token: string } | undefined;
    if (row) headers.authorization = `Bearer ${this.decrypt(row.encrypted_token)}`;
    return headers;
  }

  private logCommand(userId: string, commandId: string, appId: string, method: string, url: string, status: string, responseStatus: number, durationMs: number, responseBody: string, error: string): void {
    this.db.prepare(`
      INSERT INTO command_logs (id, user_id, command_id, app_id, method, url, status, response_status, duration_ms, response_body, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(`log_${Date.now()}_${Math.random().toString(16).slice(2)}`, userId, commandId, appId, method, url, status, responseStatus, durationMs, responseBody, error, new Date().toISOString());
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.tokenKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString("base64url");
  }

  private decrypt(value: string): string {
    const payload = Buffer.from(value, "base64url");
    const iv = payload.subarray(0, 12);
    const tag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.tokenKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  }
}

async function loadRuntimeConfig(file: string): Promise<MountainViewConfig> {
  try {
    return { ...defaultConfig, ...JSON.parse(await readFile(file, "utf8")) as Partial<MountainViewConfig> };
  } catch {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
}

async function readJson(request: IncomingMessage, limit = 1024 * 1024): Promise<JsonRecord> {
  const body = await readBody(request, limit);
  return body ? asRecord(JSON.parse(body)) : {};
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > limit) {
        reject(new HttpError(413, "Request body is too large."));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function normalizeRow(row: JsonRecord): JsonRecord {
  const normalized = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (key.endsWith("_json") && typeof value === "string") {
      normalized[key.replace(/_json$/, "")] = parseMaybeJson(value);
    }
  }
  return normalized;
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function parseJsonObject(value: string): JsonRecord {
  const parsed = parseMaybeJson(value);
  return asRecord(parsed);
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function renderTemplate(template: string, payload: JsonRecord): string {
  return template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
    const value = readPath(payload, key);
    return encodeURIComponent(value == null ? "" : String(value));
  });
}

function renderJsonTemplate(template: string, payload: JsonRecord): unknown {
  return parseMaybeJson(template.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
    const value = readPath(payload, key);
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  }));
}

function readPath(source: JsonRecord, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => asRecord(value)[key], source);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(response: ServerResponse, payload: unknown): true {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
  return true;
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(value);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function renderMountainViewHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MountainView AI</title>
  <style>
    :root { color-scheme: dark; --bg:#050712; --panel:#10172a; --panel2:#111c35; --line:rgba(255,255,255,.12); --text:#f8fbff; --muted:#9fb1cc; --blue:#20d5ff; --violet:#8b5cf6; --good:#32d583; --bad:#ff6b8a; --warn:#ffd166; }
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0%,rgba(32,213,255,.18),transparent 26%),radial-gradient(circle at 88% 10%,rgba(139,92,246,.2),transparent 30%),linear-gradient(180deg,#050712,#090d1c 60%,#050712);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,Segoe UI,Arial,sans-serif}
    body:before{content:"";position:fixed;inset:0;background-image:radial-gradient(circle,rgba(255,255,255,.2) 1px,transparent 1px);background-size:38px 38px;opacity:.16;pointer-events:none}
    button,input,textarea,select{font:inherit} button{border:0;border-radius:8px;padding:10px 12px;color:#00131a;background:linear-gradient(135deg,var(--blue),#b9f4ff);font-weight:800;cursor:pointer} button.secondary{background:rgba(255,255,255,.07);color:var(--text);border:1px solid var(--line)} button.danger{background:rgba(255,107,138,.16);color:#ffdce4;border:1px solid rgba(255,107,138,.35)}
    .shell{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:20px 14px 90px}.top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px}.brand{display:flex;align-items:center;gap:12px}.mark{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--violet),var(--blue));box-shadow:0 0 34px rgba(32,213,255,.35)}h1{margin:0;font-size:24px;letter-spacing:0} .sub{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}.panel{background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.035));border:1px solid var(--line);border-radius:8px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.28);backdrop-filter:blur(12px)}.hero{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}.stat{border:1px solid var(--line);border-radius:8px;padding:13px;background:rgba(255,255,255,.045)}.label{text-transform:uppercase;letter-spacing:.13em;color:var(--muted);font-size:10px}.value{font-size:24px;font-weight:900;margin-top:4px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.cmd{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:8px;padding:12px;background:rgba(255,255,255,.045)}.cmd strong{display:block}.cmd span{font-size:12px;color:var(--muted)}.tabs{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;display:flex;gap:6px;background:rgba(8,12,25,.86);border:1px solid var(--line);padding:6px;border-radius:12px;backdrop-filter:blur(14px)}.tabs button{padding:9px 10px;background:transparent;color:var(--muted);border-radius:8px}.tabs button.active{background:rgba(32,213,255,.16);color:white}.screen{display:none}.screen.active{display:block}.row{display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;margin:8px 0}input,textarea,select{width:100%;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);padding:10px}textarea{min-height:88px}.log{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:pre-wrap;color:#d9e8ff;background:rgba(0,0,0,.25);border-radius:8px;border:1px solid var(--line);padding:12px;max-height:260px;overflow:auto}.timeline{display:grid;gap:10px}.memory{border-left:2px solid var(--blue);padding:8px 0 8px 12px;background:rgba(255,255,255,.035);border-radius:0 8px 8px 0}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:820px){.grid,.hero,.split{grid-template-columns:1fr}.cards{grid-template-columns:1fr}.top{align-items:flex-start}.tabs{width:calc(100% - 20px);overflow:auto}.tabs button{white-space:nowrap}.row{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="top">
      <div class="brand"><div class="mark"></div><div><h1>MountainView AI</h1><div class="sub">Spacemountain.live mobile command bridge</div></div></div>
      <button class="secondary" onclick="login()">Connect owner</button>
    </div>

    <section id="home" class="screen active">
      <div class="grid">
        <div class="panel">
          <div class="hero">
            <div>
              <div class="label">Meta glasses bridge</div>
              <div class="value warn" id="deviceState">SDK gated</div>
              <p class="sub">Phone-side bridge for events, voice commands, images, and command triggers where supported by Meta Wearables APIs.</p>
            </div>
            <div class="stat"><div class="label">No face recognition</div><div class="value good">Relay only</div><p class="sub">StreamWeaver handles AI image processing.</p></div>
            <div class="stat"><div class="label">Live stream</div><div class="value">Ready</div><p class="sub">Control plane prepared for future direct media feeds.</p></div>
            <div class="stat"><div class="label">Flashlight</div><div class="value bad">Not exposed</div><p class="sub">UI remains ready for future SDK support.</p></div>
          </div>
        </div>
        <div class="panel">
          <div class="label">Quick actions</div>
          <div class="cards" id="quickCommands"></div>
        </div>
      </div>
    </section>

    <section id="commands" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Command center</div><div id="commandList" class="timeline"></div></div>
        <div class="panel">
          <div class="label">Create command</div>
          <div class="row"><span>Name</span><input id="cmdName" value="Ask MountainView AI"></div>
          <div class="row"><span>Target app</span><select id="cmdApp"><option value="streamweaver">StreamWeaver</option><option value="discordstreamhub">DiscordStreamHub</option><option value="chat-tag">Chat-Tag</option><option value="hearmeout">HearMeOut</option></select></div>
          <div class="row"><span>Method</span><select id="cmdMethod"><option>POST</option><option>GET</option></select></div>
          <div class="row"><span>URL</span><input id="cmdUrl" value="/api/events"></div>
          <div class="row"><span>Payload</span><textarea id="cmdPayload">{"source":"mountainview-ai","message":"{{message}}"}</textarea></div>
          <button onclick="saveCommand()">Save command</button>
        </div>
      </div>
    </section>

    <section id="relay" class="screen">
      <div class="split">
        <div class="panel">
          <div class="label">StreamWeaver image relay</div>
          <textarea id="imageBase64" placeholder="Paste base64 image payload from glasses or phone capture"></textarea>
          <div class="row"><span>Image URL</span><input id="imageUrl" placeholder="Optional image URL"></div>
          <button onclick="sendImage()">Send to StreamWeaver</button>
        </div>
        <div class="panel"><div class="label">Upload status</div><div class="log" id="relayStatus">Waiting for image.</div></div>
      </div>
    </section>

    <section id="memory" class="screen">
      <div class="split">
        <div class="panel"><div class="label">AI memory</div><div class="row"><span>Title</span><input id="memTitle" value="Voice note"></div><textarea id="memBody" placeholder="Save note, command context, image metadata, or app activity"></textarea><div class="row"><span>Tags</span><input id="memTags" value="glasses,stream"></div><button onclick="saveMemory()">Save memory</button></div>
        <div class="panel"><div class="label">Timeline</div><input id="memSearch" placeholder="Search memory" oninput="loadMemory()"><div id="memoryList" class="timeline"></div></div>
      </div>
    </section>

    <section id="stream" class="screen">
      <div class="panel"><div class="label">Live stream controls</div><div class="cards">
        <button onclick="runSystemCommand('cmd_stream_start')">Start stream</button><button class="secondary" onclick="appendLog('Stop stream requested')">Stop stream</button><button class="secondary" onclick="sendImage()">Send current image/frame</button><button class="secondary" onclick="appendLog('Push to stream requested')">Push to stream</button><button class="secondary" onclick="appendLog('Overlay event triggered')">Trigger stream overlay/event</button>
      </div><p class="sub">Direct glasses live streaming is SDK/API gated. This control plane is ready for camera/audio event ingestion once available.</p></div>
    </section>

    <section id="settings" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Service token storage</div><div class="row"><span>Service</span><select id="tokenService"><option value="streamweaver">StreamWeaver</option><option value="discordstreamhub">DiscordStreamHub</option><option value="chat-tag">Chat-Tag</option><option value="hearmeout">HearMeOut</option></select></div><div class="row"><span>Token</span><input id="serviceToken" type="password"></div><button onclick="saveToken()">Store encrypted token</button></div>
        <div class="panel"><div class="label">Activity logs</div><div class="log" id="activityLog"></div></div>
      </div>
    </section>
  </main>
  <nav class="tabs"><button class="active" onclick="show('home',this)">Home</button><button onclick="show('commands',this)">Commands</button><button onclick="show('relay',this)">Relay</button><button onclick="show('memory',this)">Memory</button><button onclick="show('stream',this)">Stream</button><button onclick="show('settings',this)">Settings</button></nav>
  <script>
    let token = localStorage.mvToken || ""; let state = {commands:[], memory:[], logs:[]};
    const api = async (path, options={}) => { const res = await fetch('/mountainview/api' + path, { ...options, headers: { 'content-type':'application/json', authorization: token ? 'Bearer '+token : '', ...(options.headers||{}) } }); const data = await res.json(); if(!res.ok || data.error) throw new Error(data.error || 'Request failed'); return data; };
    async function login(){ const password = prompt('MountainView owner password'); if(!password) return; const data = await api('/login',{method:'POST',body:JSON.stringify({email:'owner@spacemountain.live',password})}); token=data.token; localStorage.mvToken=token; await load(); }
    async function load(){ if(!token) return; const data = await api('/bootstrap'); state=data; renderCommands(); renderMemory(); renderLogs(); }
    function show(id, btn){ document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active')); document.getElementById(id).classList.add('active'); document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); if(id==='memory') loadMemory(); }
    function renderCommands(){ const html = (state.commands||[]).map(c=>'<div class="cmd"><div><strong>'+esc(c.name)+'</strong><span>'+esc(c.app_id)+' • '+esc(c.method)+' '+esc(c.url_template)+'</span></div><button class="secondary" onclick="runSystemCommand(\\''+esc(c.id)+'\\')">Run</button></div>').join(''); commandList.innerHTML=html; quickCommands.innerHTML=html; }
    async function runSystemCommand(id){ const message = prompt('Payload message', 'MountainView trigger') || ''; const data = await api('/commands/execute',{method:'POST',body:JSON.stringify({commandId:id,payload:{message,payload:{message},metadata:{source:'dashboard'}}})}); appendLog(JSON.stringify(data,null,2)); await load(); }
    async function saveCommand(){ await api('/commands',{method:'POST',body:JSON.stringify({name:cmdName.value,appId:cmdApp.value,method:cmdMethod.value,urlTemplate:cmdUrl.value,payloadTemplate:JSON.parse(cmdPayload.value),phrase:cmdName.value.toLowerCase()})}); await load(); }
    async function sendImage(){ relayStatus.textContent='Uploading...'; const data = await api('/media/streamweaver',{method:'POST',body:JSON.stringify({imageBase64:imageBase64.value,imageUrl:imageUrl.value,metadata:{sentAt:new Date().toISOString(),source:'mountainview-dashboard'}})}); relayStatus.textContent=JSON.stringify(data,null,2); await load(); }
    async function saveMemory(){ await api('/memory',{method:'POST',body:JSON.stringify({title:memTitle.value,body:memBody.value,tags:memTags.value})}); memBody.value=''; await loadMemory(); }
    async function loadMemory(){ const data = await api('/memory?q='+encodeURIComponent(memSearch?.value||'')); state.memory=data.records; renderMemory(); }
    function renderMemory(){ memoryList.innerHTML=(state.memory||[]).map(m=>'<div class="memory"><strong>'+esc(m.title)+'</strong><div class="sub">'+esc(m.body)+'</div><div class="sub">'+esc((m.tags||[]).join(', '))+'</div></div>').join('') || '<p class="sub">No memory records yet.</p>'; }
    function renderLogs(){ activityLog.textContent=(state.logs||[]).map(l=>l.created_at+' '+l.app_id+' '+l.status+' '+l.method+' '+l.url+'\\n'+(l.error||'')).join('\\n\\n') || 'No activity yet.'; }
    async function saveToken(){ await api('/settings/token',{method:'POST',body:JSON.stringify({serviceId:tokenService.value,token:serviceToken.value})}); serviceToken.value=''; appendLog('Stored encrypted token for '+tokenService.value); }
    function appendLog(text){ activityLog.textContent = new Date().toISOString()+' '+text+'\\n\\n'+activityLog.textContent; }
    function esc(v){ return String(v ?? '').replace(/[&<>"]/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s])); }
    load().catch(()=>{});
  </script>
</body>
</html>`;
}
