import Database from "better-sqlite3";
import QRCode from "qrcode";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";

type JsonRecord = Record<string, unknown>;

const DEFAULT_STREAMWEAVER_TENANT_ID = "94371378";
const DEFAULT_STREAMWEAVER_USERNAME = "mtman1987";
const DEFAULT_CHAT_TAG_USER_ID = "user_94371378";
const DEFAULT_DISCORD_GUILD_ID = "1240832965865635881";
const DEFAULT_DISCORD_CHANNEL_ID = "1463633163673927732";
const DEFAULT_DISCORD_OWNER_ID = "767875979561009173";
const DEFAULT_HEARMEOUT_ROOM_ID = "spacemountain";

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
    { id: "mountainview", name: "MountainView AI", baseUrl: "https://mtman-machine-rotator.fly.dev/mountainview" },
    { id: "streamweaver", name: "StreamWeaver", baseUrl: "https://streamweaver-new.fly.dev" },
    { id: "discordstreamhub", name: "DiscordStreamHub", baseUrl: "https://discord-stream-hub-new.fly.dev" },
    { id: "chat-tag", name: "Chat-Tag", baseUrl: "https://chat-tag-new.fly.dev" },
    { id: "hearmeout", name: "HearMeOut", baseUrl: "https://hearmeout-main.fly.dev" },
    { id: "edenai", name: "EdenAI Router", baseUrl: "https://api.edenai.run" }
  ],
  metaWearables: {
    toolkitStatus: "Android-native AiMB/RDGlass bridge. Current hardware path uses Bluetooth audio, BLE notifications, Android media buttons, speech recognition, and RDGlass command research.",
    flashControlSupported: false,
    notes: [
      "Face/profile memory is explicit and owner-controlled.",
      "Image analysis can be delegated to EdenAI, StreamWeaver, or configured Spacemountain services.",
      "Direct glasses live streaming and steady flash control are capability-gated until the AiMB/RDGlass command channel exposes stable media APIs.",
      "RDGlass/AiMB research mode can scan BLE, discover GATT services, and log characteristics without sending unknown control packets."
    ]
  }
};

const EDEN_AI_FEATURE_ENDPOINTS: Record<string, string> = {
  face_detection: "/v2/image/face_detection/",
  face_recognition: "/v2/image/face_recognition/recognize/",
  logo_detection: "/v2/image/logo_detection/",
  object_detection: "/v2/image/object_detection/",
  ocr: "/v2/ocr/ocr",
  question_answer: "/v2/image/question_answer/"
};

export async function handleMountainViewRequest(request: IncomingMessage, response: ServerResponse, env: NodeJS.ProcessEnv): Promise<boolean> {
  const method = request.method ?? "GET";
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (!url.pathname.startsWith("/mountainview")) return false;

  const apiPath = url.pathname.replace(/^\/mountainview\/api/, "/api");
  const context = await MountainViewContext.create(env);

  if (method === "GET" && (url.pathname === "/mountainview/apk" || url.pathname === "/mountainview/download-apk")) {
    await streamLatestMountainViewApk(response, env);
    return true;
  }

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
      people: context.listPeople(user.id),
      mediaEvents: context.listGlassesMediaEvents(user.id),
      devices: context.listDevices(user.id),
      pollingProfiles: context.listPollingProfiles(user.id),
      logoProfiles: context.listLogoProfiles(user.id),
      qrTriggers: await context.listQrTriggers(user.id),
      roadmap: context.listRoadmap(),
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

  if (method === "POST" && apiPath === "/api/voice/route") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, await context.routeVoiceCommand(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/media/streamweaver") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 20 * 1024 * 1024);
    const result = await context.relayImageToStreamWeaver(user.id, body);
    return json(response, result);
  }

  if (method === "POST" && apiPath === "/api/glasses/media-event") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 20 * 1024 * 1024);
    const result = await context.recordGlassesMediaEvent(user.id, body);
    return json(response, result);
  }

  if (method === "POST" && apiPath === "/api/vision/analyze") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 25 * 1024 * 1024);
    return json(response, await context.analyzeVision(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/vision/route") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 25 * 1024 * 1024);
    return json(response, context.routeVisualTarget(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/vision/smart-capture") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 25 * 1024 * 1024);
    return json(response, await context.smartCapture(user.id, body));
  }

  if (method === "GET" && apiPath === "/api/people") {
    const user = context.requireAuth(request);
    return json(response, { people: context.listPeople(user.id, url.searchParams.get("q") ?? "") });
  }

  if (method === "POST" && apiPath === "/api/people") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.savePersonProfile(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/people/remember") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.rememberPerson(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/media/generate") {
    const user = context.requireAuth(request);
    const body = await readJson(request, 5 * 1024 * 1024);
    return json(response, await context.generateMedia(user.id, body));
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

  if (method === "GET" && apiPath === "/api/devices") {
    const user = context.requireAuth(request);
    return json(response, { devices: context.listDevices(user.id) });
  }

  if (method === "POST" && apiPath === "/api/devices") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.saveDevice(user.id, body));
  }

  if (method === "GET" && apiPath === "/api/polling-profiles") {
    const user = context.requireAuth(request);
    return json(response, { pollingProfiles: context.listPollingProfiles(user.id) });
  }

  if (method === "POST" && apiPath === "/api/polling-profiles") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.savePollingProfile(user.id, body));
  }

  if (method === "GET" && apiPath === "/api/logo-profiles") {
    const user = context.requireAuth(request);
    return json(response, { logoProfiles: context.listLogoProfiles(user.id) });
  }

  if (method === "POST" && apiPath === "/api/logo-profiles") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.saveLogoProfile(user.id, body));
  }

  if (method === "POST" && apiPath === "/api/logo-profiles/match") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, context.matchLogoProfile(user.id, body));
  }

  if (method === "GET" && apiPath === "/api/qr-triggers") {
    const user = context.requireAuth(request);
    return json(response, { qrTriggers: await context.listQrTriggers(user.id) });
  }

  if (method === "POST" && apiPath === "/api/qr-triggers") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, { ok: true, qrTrigger: await context.saveQrTrigger(user.id, body) });
  }

  if (method === "GET" && apiPath === "/api/roadmap") {
    return json(response, { roadmap: context.listRoadmap() });
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
    const authDisabled = this.env.MOUNTAINVIEW_AUTH_DISABLED === "true";
    const ownerPassword = this.env.MOUNTAINVIEW_OWNER_PASSWORD ?? this.env.ROTATOR_ACTION_TOKEN ?? "mountainview-dev";
    if (!authDisabled && !safeEqual(password, ownerPassword)) throw new HttpError(401, "Invalid MountainView credentials.");
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
    if (this.env.MOUNTAINVIEW_AUTH_DISABLED === "true") {
      const now = new Date().toISOString();
      this.db.prepare(`
        INSERT INTO users (id, email, role, created_at)
        VALUES ('owner', 'owner@spacemountain.live', 'admin', ?)
        ON CONFLICT(id) DO UPDATE SET email = excluded.email, role = excluded.role
      `).run(now);
      return { id: "owner", email: "owner@spacemountain.live", role: "admin" };
    }
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
    const effectivePayload = await this.prepareCommandPayload(userId, commandId, payload);
    const integration = this.getIntegration(String(command.app_id));
    const url = new URL(renderTemplate(String(command.url_template), effectivePayload), integration.baseUrl).toString();
    const method = String(command.method);
    const bodyPayload = renderJsonTemplate(String(command.payload_template ?? "{}"), effectivePayload);
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
    const fallback = this.recordLocalWorkflowFallback(userId, commandId, command, effectivePayload, {
      url,
      method,
      status,
      error: lastError,
      response: parseMaybeJson(responseText)
    });
    return {
      ok: true,
      localOnly: true,
      queued: true,
      command: fallback.event,
      status,
      error: lastError,
      response: {
        reply: fallback.reply,
        externalStatus: status,
        externalError: lastError,
        externalResponse: parseMaybeJson(responseText)
      }
    };
  }

  async routeVoiceCommand(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const transcript = readText(input, "transcript") || readText(input, "message");
    if (!transcript) throw new HttpError(400, "Transcript is required.");
    const context = asRecord(input.context);
    const decision = this.decideVoiceRoute(userId, transcript, context);
    const decisionPayload = asRecord(decision.payload);
    const decisionTranscript = String(decision.transcript ?? transcript);
    const payload = {
      ...context,
      ...decisionPayload,
      message: decisionTranscript,
      transcript: decisionTranscript,
      routingDecision: decision,
      payload: {
        ...asRecord(context.payload),
        ...decisionPayload,
        message: decisionTranscript,
        transcript: decisionTranscript,
        routingDecision: decision
      }
    };
    if (input.dryRun === true || context.dryRun === true) {
      this.recordGlassesMediaEvent(userId, {
        kind: "voice-route-dry-run",
        source: "mountainview-router",
        targetApp: String(decision.appId ?? "streamweaver"),
        status: String(decision.mode ?? "conversation"),
        metadata: { transcript, decision, payload }
      });
      return { ok: true, dryRun: true, decision, payload };
    }
    const result = await this.executeCommand(userId, String(decision.commandId), payload);
    this.recordGlassesMediaEvent(userId, {
      kind: "voice-route-decision",
      source: "mountainview-router",
      targetApp: String(decision.appId ?? "streamweaver"),
      status: String(decision.mode ?? "conversation"),
      metadata: { transcript, decision, result: summarizeCommandResult(result) }
    });
    return { ok: true, decision, result };
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

  recordGlassesMediaEvent(userId: string, input: JsonRecord): JsonRecord {
    const id = `glasses_media_${Date.now()}`;
    const kind = String(input.kind ?? "event");
    const source = String(input.source ?? "android-glasses");
    const targetApp = String(input.targetApp ?? input.target_app ?? "streamweaver");
    const status = String(input.status ?? "received");
    const metadata = asRecord(input.metadata);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO glasses_media_events (id, user_id, kind, source, target_app, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, kind, source, targetApp, status, JSON.stringify(metadata), now);
    this.logCommand(userId, `glasses-${kind}`, targetApp, "EVENT", source, "success", 0, 0, JSON.stringify(metadata).slice(0, 4000), "");
    return { ok: true, event: { id, kind, source, targetApp, status, metadata, created_at: now } };
  }

  async analyzeVision(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const features = normalizeVisionFeatures(input.features ?? input.feature ?? ["ocr", "logo_detection", "object_detection"]);
    const providers = String(input.providers ?? "google,amazon").trim();
    const question = String(input.question ?? "What is visible in this image?").trim();
    const results: JsonRecord = {};
    for (const feature of features) {
      results[feature] = await this.callEdenAiFeature(userId, feature, {
        ...input,
        providers,
        question
      });
    }
    const labels = extractVisionLabels(results);
    const route = this.routeVisualTarget(userId, { ...input, labels, vision: results });
    const logoText = labels.join(" ");
    const logoMatch = this.matchLogoProfile(userId, { observedText: logoText });
    const logoRoute = asRecord(logoMatch.route);
    const routeDevice = asRecord(route.device);
    const event = this.recordGlassesMediaEvent(userId, {
      kind: "vision-analysis",
      source: String(input.source ?? "mountainview-vision"),
      targetApp: String(logoRoute.appId ?? routeDevice.id ?? "mountainview"),
      status: "analyzed",
      metadata: { features, providers, labels, route, logoMatch, results }
    });
    return { ok: true, features, providers, labels, route, logoMatch, results, event: event.event };
  }

  routeVisualTarget(userId: string, input: JsonRecord): JsonRecord {
    const text = [
      String(input.observedText ?? ""),
      String(input.text ?? ""),
      String(input.message ?? ""),
      ...normalizeTags(input.labels),
      ...extractVisionLabels(input.vision)
    ].join(" ").toLowerCase();
    const devices = this.listDevices(userId);
    const preferredId =
      /\b(tablet|ipad|android tablet)\b/.test(text) ? "device_tablet" :
      /\b(obs|stream machine|stream pc|overlay)\b/.test(text) ? "device_obs" :
      /\b(computer|monitor|desktop|pc|laptop|screen)\b/.test(text) ? "device_pc" :
      /\b(phone|mobile)\b/.test(text) ? "device_phone" :
      "";
    const device = devices.find((item) => String(item.id) === preferredId)
      ?? devices.find((item) => String(item.kind).includes("computer"))
      ?? devices[0]
      ?? null;
    const route = {
      targetDeviceId: device ? String(device.id) : "",
      targetDeviceName: device ? String(device.name) : "",
      channel: device ? String(device.connection_hint ?? "local") : "local",
      reason: preferredId ? "visual-device-match" : "default-companion-display"
    };
    this.recordGlassesMediaEvent(userId, {
      kind: "visual-route",
      source: String(input.source ?? "mountainview-vision"),
      targetApp: "mountainview",
      status: "routed",
      metadata: { text, route, device }
    });
    return { ok: true, route, device };
  }

  listPeople(userId: string, query = ""): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM person_profiles WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100").all(userId) as JsonRecord[];
    const q = query.trim().toLowerCase();
    return rows.map(normalizeRow).filter((row) => {
      if (!q) return true;
      const haystack = `${row.display_name ?? ""} ${row.notes ?? ""} ${JSON.stringify(row.usernames ?? {})} ${JSON.stringify(row.aliases ?? [])}`.toLowerCase();
      return haystack.includes(q);
    });
  }

  savePersonProfile(userId: string, input: JsonRecord): JsonRecord {
    const now = new Date().toISOString();
    const displayName = String(input.displayName ?? input.display_name ?? input.name ?? input.username ?? "Unknown person").trim();
    const id = String(input.id ?? `person_${slugify(displayName)}_${Date.now()}`);
    const usernames = asRecord(input.usernames);
    for (const key of ["twitchUsername", "discordUsername", "kickUsername", "youtubeUsername"]) {
      const value = input[key];
      if (value) usernames[key.replace("Username", "")] = String(value).replace(/^@+/, "");
    }
    const reminders = normalizeReminderList(input.reminders ?? input.meetings ?? []);
    const context = {
      relationship: String(input.relationship ?? ""),
      preferences: normalizeTags(input.preferences),
      boundaries: normalizeTags(input.boundaries),
      topics: normalizeTags(input.topics),
      streamLogo: String(input.streamLogo ?? input.stream_logo ?? ""),
      avatarUrl: String(input.avatarUrl ?? input.avatar_url ?? ""),
      lastSeenContext: String(input.lastSeenContext ?? input.last_seen_context ?? ""),
      source: String(input.source ?? "mountainview")
    };
    this.db.prepare(`
      INSERT INTO person_profiles (id, user_id, display_name, aliases_json, usernames_json, context_json, reminders_json, notes, consent_mode, updated_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        aliases_json = excluded.aliases_json,
        usernames_json = excluded.usernames_json,
        context_json = excluded.context_json,
        reminders_json = excluded.reminders_json,
        notes = excluded.notes,
        consent_mode = excluded.consent_mode,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      displayName,
      JSON.stringify(normalizeTags(input.aliases)),
      JSON.stringify(usernames),
      JSON.stringify(context),
      JSON.stringify(reminders),
      String(input.notes ?? input.note ?? ""),
      String(input.consentMode ?? input.consent_mode ?? "owner-memory"),
      now,
      now
    );
    const person = normalizeRow(this.db.prepare("SELECT * FROM person_profiles WHERE id = ?").get(id) as JsonRecord);
    this.saveMemory(userId, {
      kind: "person-profile",
      title: `Profile: ${displayName}`,
      body: buildPersonMemorySummary(person),
      tags: ["person", "profile", ...Object.values(usernames).map(String).filter(Boolean)],
      metadata: { personId: id, person }
    });
    return { ok: true, person };
  }

  rememberPerson(userId: string, input: JsonRecord): JsonRecord {
    const person = this.savePersonProfile(userId, input);
    const displayName = String((person.person as JsonRecord).display_name ?? input.displayName ?? input.name ?? "that person");
    const memory = this.saveMemory(userId, {
      kind: "person-note",
      title: String(input.title ?? `Remember ${displayName}`),
      body: String(input.note ?? input.notes ?? input.body ?? `Remember context for ${displayName}.`),
      tags: ["person", "meeting", "glasses", ...normalizeTags(input.tags)],
      metadata: { personId: (person.person as JsonRecord).id, source: "people/remember" }
    });
    return { ok: true, person: person.person, memory: memory.record };
  }

  async smartCapture(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const vision = await this.analyzeVision(userId, {
      ...input,
      features: input.features ?? ["ocr", "logo_detection", "object_detection", "face_detection"]
    });
    const profile = input.savePerson || input.displayName || input.twitchUsername
      ? this.rememberPerson(userId, {
        ...input,
        source: "vision-smart-capture",
        lastSeenContext: extractVisionLabels(vision.results).slice(0, 8).join(", ")
      })
      : null;
    return {
      ok: true,
      vision,
      profile,
      reply: buildSmartCaptureReply(vision, profile)
    };
  }

  async generateMedia(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const kind = String(input.kind ?? "image").toLowerCase();
    const prompt = String(input.prompt ?? input.message ?? "Create a stream-ready visual from the current glasses context.").trim();
    const commandId = kind === "video" ? "cmd_eden_video_generation" : "cmd_streamweaver_image_generate";
    return this.executeCommand(userId, commandId, {
      ...input,
      prompt,
      message: prompt,
      payload: { ...asRecord(input.payload), prompt }
    });
  }

  private async callEdenAiFeature(userId: string, feature: string, input: JsonRecord): Promise<JsonRecord> {
    const endpoint = EDEN_AI_FEATURE_ENDPOINTS[feature];
    if (!endpoint) return { ok: false, error: `Unsupported EdenAI feature: ${feature}` };
    const token = this.getServiceToken(userId, "edenai") || this.env.EDENAI_API_KEY || this.env.EDEN_AI_API_KEY || "";
    if (!token) {
      return { ok: false, feature, error: "EdenAI token is not configured. Store it under service 'edenai' in MountainView settings." };
    }
    const integration = this.getIntegration("edenai");
    const url = new URL(endpoint, integration.baseUrl).toString();
    const started = Date.now();
    let status = 0;
    let responseText = "";
    try {
      const form = new FormData();
      form.set("providers", String(input.providers ?? "google,amazon"));
      if (feature === "question_answer") form.set("question", String(input.question ?? "What is visible in this image?"));
      const imageUrl = String(input.imageUrl ?? input.image_url ?? "").trim();
      const imageBase64 = String(input.imageBase64 ?? input.image ?? input.file ?? "").trim();
      if (imageUrl) {
        form.set("file_url", imageUrl);
      } else if (imageBase64) {
        const image = decodeBase64Media(imageBase64);
        form.set("file", new Blob([image.buffer], { type: image.mimeType }), image.filename);
      } else {
        return { ok: false, feature, error: "imageBase64 or imageUrl is required." };
      }
      const result = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form
      });
      status = result.status;
      responseText = await result.text();
      const parsed = parseMaybeJson(responseText);
      this.logCommand(userId, `edenai-${feature}`, "edenai", "POST", url, result.ok ? "success" : "error", status, Date.now() - started, responseText.slice(0, 4000), result.ok ? "" : `HTTP ${status}`);
      return { ok: result.ok, feature, status, response: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logCommand(userId, `edenai-${feature}`, "edenai", "POST", url, "error", status, Date.now() - started, responseText.slice(0, 4000), message);
      return { ok: false, feature, status, error: message, response: parseMaybeJson(responseText) };
    }
  }

  private async prepareCommandPayload(userId: string, commandId: string, payload: JsonRecord): Promise<JsonRecord> {
    const next = withCommandDefaults(commandId, payload);
    if (commandId !== "cmd_chat_tag_tag" || readText(next, "targetUserId")) return next;

    const targetName = readText(next, "targetName")
      || readText(next, "target")
      || extractChatTagTarget(readText(next, "message") || readText(next, "transcript"));
    if (!targetName) return next;

    try {
      const integration = this.getIntegration("chat-tag");
      const result = await fetch(new URL("/api/tag", integration.baseUrl).toString(), {
        method: "GET",
        headers: await this.authHeaders(userId, "chat-tag", integration.defaultHeaders)
      });
      if (!result.ok) return { ...next, targetName, targetLookupError: `Chat-Tag lookup failed: HTTP ${result.status}` };
      const data = await result.json() as JsonRecord;
      const player = findChatTagPlayer(data.players, targetName);
      if (!player) return { ...next, targetName, targetLookupError: `No Chat-Tag player matched ${targetName}` };
      return {
        ...next,
        targetName,
        targetUserId: readText(player, "id"),
        targetUsername: readText(player, "twitchUsername") || readText(player, "username") || targetName
      };
    } catch (error) {
      return {
        ...next,
        targetName,
        targetLookupError: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private recordLocalWorkflowFallback(userId: string, commandId: string, command: JsonRecord, payload: JsonRecord, external: JsonRecord): { event: JsonRecord; reply: string } {
    const appId = String(command.app_id);
    const commandName = String(command.name ?? commandId);
    const now = new Date().toISOString();
    const id = `local_workflow_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = {
      commandId,
      commandName,
      payload,
      external,
      note: "Remote app endpoint did not complete, so MountainView kept this as a local workflow event for glasses/mobile testing."
    };
    this.db.prepare(`
      INSERT INTO glasses_media_events (id, user_id, kind, source, target_app, status, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, userId, "command-fallback", "mountainview-ai", appId, "queued-local", JSON.stringify(metadata), now);
    const reply = `${commandName} is queued locally for ${appDisplayName(appId)}. The live app route did not answer, but MountainView captured the action.`;
    this.logCommand(userId, `${commandId}:local-fallback`, appId, "EVENT", "mountainview-local-workflow", "success", 0, 0, JSON.stringify(metadata).slice(0, 4000), "");
    return {
      event: { id, commandId, appId, commandName, status: "queued-local", metadata, created_at: now },
      reply
    };
  }

  listGlassesMediaEvents(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM glasses_media_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  listDevices(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  saveDevice(userId: string, input: JsonRecord): JsonRecord {
    const id = String(input.id ?? `device_${Date.now()}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO devices (id, user_id, name, kind, pairing_code, connection_hint, status, capabilities_json, last_seen_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        pairing_code = excluded.pairing_code,
        connection_hint = excluded.connection_hint,
        status = excluded.status,
        capabilities_json = excluded.capabilities_json,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      String(input.name ?? "New device"),
      String(input.kind ?? "companion-display"),
      String(input.pairingCode ?? input.pairing_code ?? ""),
      String(input.connectionHint ?? input.connection_hint ?? "qr"),
      String(input.status ?? "registered"),
      JSON.stringify(input.capabilities ?? ["display", "commands"]),
      String(input.lastSeenAt ?? input.last_seen_at ?? now),
      now
    );
    return { ok: true, device: normalizeRow(this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as JsonRecord) };
  }

  listPollingProfiles(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM visual_polling_profiles WHERE user_id = ? ORDER BY updated_at DESC").all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  savePollingProfile(userId: string, input: JsonRecord): JsonRecord {
    const id = String(input.id ?? `poll_${Date.now()}`);
    const now = new Date().toISOString();
    const intervalSeconds = Math.max(10, Number(input.intervalSeconds ?? input.interval_seconds ?? 60));
    this.db.prepare(`
      INSERT INTO visual_polling_profiles (id, user_id, name, interval_seconds, battery_mode, trigger_targets_json, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        interval_seconds = excluded.interval_seconds,
        battery_mode = excluded.battery_mode,
        trigger_targets_json = excluded.trigger_targets_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      String(input.name ?? "Visual trigger polling"),
      intervalSeconds,
      String(input.batteryMode ?? input.battery_mode ?? "balanced"),
      JSON.stringify(input.triggerTargets ?? input.trigger_targets ?? ["qr", "device-marker", "scene-change"]),
      input.enabled === false ? 0 : 1,
      now
    );
    return { ok: true, pollingProfile: normalizeRow(this.db.prepare("SELECT * FROM visual_polling_profiles WHERE id = ?").get(id) as JsonRecord) };
  }

  listLogoProfiles(userId: string): JsonRecord[] {
    const rows = this.db.prepare("SELECT * FROM app_logo_profiles WHERE user_id IN (?, 'system') ORDER BY app_id, name").all(userId) as JsonRecord[];
    return rows.map(normalizeRow);
  }

  saveLogoProfile(userId: string, input: JsonRecord): JsonRecord {
    const id = String(input.id ?? `logo_${Date.now()}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO app_logo_profiles (id, user_id, app_id, name, aliases_json, command_id, confidence_threshold, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        app_id = excluded.app_id,
        name = excluded.name,
        aliases_json = excluded.aliases_json,
        command_id = excluded.command_id,
        confidence_threshold = excluded.confidence_threshold,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      String(input.appId ?? input.app_id ?? "streamweaver"),
      String(input.name ?? "App logo"),
      JSON.stringify(normalizeTags(input.aliases ?? input.aliases_json ?? [])),
      String(input.commandId ?? input.command_id ?? ""),
      Number(input.confidenceThreshold ?? input.confidence_threshold ?? 0.78),
      now
    );
    return { ok: true, logoProfile: normalizeRow(this.db.prepare("SELECT * FROM app_logo_profiles WHERE id = ?").get(id) as JsonRecord) };
  }

  matchLogoProfile(userId: string, input: JsonRecord): JsonRecord {
    const observedText = String(input.observedText ?? input.text ?? input.label ?? "").toLowerCase();
    const requestedApp = String(input.appId ?? input.app_id ?? "").toLowerCase();
    const profiles = this.listLogoProfiles(userId);
    const match = profiles.find((profile) => {
      const aliases = Array.isArray(profile.aliases) ? profile.aliases.map((alias) => String(alias).toLowerCase()) : [];
      const names = [String(profile.name ?? "").toLowerCase(), String(profile.app_id ?? "").toLowerCase(), ...aliases].filter(Boolean);
      return names.some((name) => (observedText && observedText.includes(name)) || (requestedApp && requestedApp === name));
    });
    const now = new Date().toISOString();
    this.logCommand(userId, "logo-recognition-test", String(match?.app_id ?? "mountainview"), "EVENT", "visual-polling", match ? "success" : "miss", 0, 0, JSON.stringify({ observedText, requestedApp, match }).slice(0, 4000), "");
    return {
      ok: Boolean(match),
      matched: Boolean(match),
      profile: match ?? null,
      route: match ? { appId: match.app_id, commandId: match.command_id, reason: "logo-profile-match" } : null,
      created_at: now
    };
  }

  async listQrTriggers(userId: string): Promise<JsonRecord[]> {
    const rows = this.db.prepare("SELECT * FROM qr_triggers WHERE user_id IN (?, 'system') ORDER BY updated_at DESC").all(userId) as JsonRecord[];
    return Promise.all(rows.map(async (row) => this.withQrSvg(normalizeRow(row))));
  }

  async saveQrTrigger(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const id = String(input.id ?? `qr_${Date.now()}`);
    const now = new Date().toISOString();
    const payload = String(input.payload ?? `mountainview://trigger/${id}`);
    this.db.prepare(`
      INSERT INTO qr_triggers (id, user_id, name, target_app, command_id, payload, action_type, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        target_app = excluded.target_app,
        command_id = excluded.command_id,
        payload = excluded.payload,
        action_type = excluded.action_type,
        updated_at = excluded.updated_at
    `).run(
      id,
      userId,
      String(input.name ?? "MountainView QR trigger"),
      String(input.targetApp ?? input.target_app ?? "streamweaver"),
      String(input.commandId ?? input.command_id ?? "cmd_chat_tag_qr"),
      payload,
      String(input.actionType ?? input.action_type ?? "command"),
      now
    );
    return this.withQrSvg(normalizeRow(this.db.prepare("SELECT * FROM qr_triggers WHERE id = ?").get(id) as JsonRecord));
  }

  private async withQrSvg(row: JsonRecord): Promise<JsonRecord> {
    const payload = String(row.payload ?? "");
    const qrSvg = await QRCode.toString(payload, { type: "svg", margin: 1, width: 180, color: { dark: "#050712", light: "#f8fbff" } });
    return { ...row, qr_svg: qrSvg };
  }

  listRoadmap(): JsonRecord[] {
    return [
      { title: "Companion HUD", status: "available", description: "Phone/tablet/browser display for glasses results, commands, memory, and transcripts." },
      { title: "Device Mesh", status: "available", description: "QR/Bluetooth/Wi-Fi pairing records for phone, tablet, PC, OBS, and stream machines." },
      { title: "Visual Polling", status: "available-config", description: "Battery-aware snapshot schedules for QR, device, and scene triggers without 24/7 streaming." },
      { title: "App Logo Recognition", status: "test-bed", description: "Polling snapshots can route detected app logos to StreamWeaver, HearMeOut, DiscordStreamHub, or Chat-Tag commands." },
      { title: "QR Trigger Maker", status: "available", description: "Create scannable QR commands for AR avatars, phone/tablet pairing, stream overlays, tags, and room actions." },
      { title: "Screen Read", status: "test-bed", description: "Route a glasses/phone snapshot to StreamWeaver or EdenAI OCR so the app can read visible screen text." },
      { title: "Twitch Screen Assist", status: "test-bed", description: "When a Twitch logo is detected, MountainView can route speech-to-text, posting, and stream actions through StreamWeaver or another token-owning app." },
      { title: "StreamWeaver Flow Runner", status: "available", description: "Run StreamWeaver commands and flow endpoints from glasses voice or snapshot events." },
      { title: "HearMeOut Voice Bridge", status: "available", description: "Route glasses audio events toward rooms, chats, song requests, audiobooks, and watch-party controls." },
      { title: "RDGlass / AiMB BLE Discovery", status: "test-bed", description: "Android research mode scans candidate glasses, connects by MAC, discovers services, and logs BLE characteristics for the direct connection path." },
      { title: "EdenAI Vision Lab", status: "coming-soon", description: "Provider picker for scene analysis, OCR, image editing, avatar insertion, and generation." },
      { title: "On-Device Recognition", status: "coming-soon", description: "Local device/person/context matching with explicit profile controls." },
      { title: "Glasses Flashlight", status: "sdk-gated", description: "UI is ready, but current public DAT docs do not expose glasses torch control." },
      { title: "Always-On Stream", status: "battery-risk", description: "Reserved for short sessions. Default design favors polling and event-triggered capture." }
    ];
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

  private getServiceToken(userId: string, serviceId: string): string {
    const row = this.db.prepare("SELECT encrypted_token FROM service_tokens WHERE user_id = ? AND service_id = ?").get(userId, serviceId) as { encrypted_token: string } | undefined;
    return row ? this.decrypt(row.encrypted_token) : "";
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
      CREATE TABLE IF NOT EXISTS person_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        usernames_json TEXT NOT NULL,
        context_json TEXT NOT NULL,
        reminders_json TEXT NOT NULL,
        notes TEXT NOT NULL,
        consent_mode TEXT NOT NULL,
        updated_at TEXT NOT NULL,
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
      CREATE TABLE IF NOT EXISTS glasses_media_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source TEXT NOT NULL,
        target_app TEXT NOT NULL,
        status TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        pairing_code TEXT NOT NULL,
        connection_hint TEXT NOT NULL,
        status TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS visual_polling_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        interval_seconds INTEGER NOT NULL,
        battery_mode TEXT NOT NULL,
        trigger_targets_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_logo_profiles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        command_id TEXT NOT NULL,
        confidence_threshold REAL NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS qr_triggers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        target_app TEXT NOT NULL,
        command_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        action_type TEXT NOT NULL,
        updated_at TEXT NOT NULL
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
      ["cmd_vision_smart_capture", "mountainview", "Smart glasses vision capture", "smart capture what i see", "POST", "/api/vision/smart-capture", { source: "mountainview-ai", imageBase64: "{{imageBase64}}", imageUrl: "{{imageUrl}}", features: "{{features}}", providers: "{{providers}}", question: "{{question}}", message: "{{message}}", savePerson: "{{savePerson}}", displayName: "{{displayName}}", twitchUsername: "{{twitchUsername}}" }],
      ["cmd_vision_route_device", "mountainview", "Route visual result to best device", "send this where i am looking", "POST", "/api/vision/route", { source: "mountainview-ai", observedText: "{{message}}", labels: "{{labels}}", vision: "{{vision}}" }],
      ["cmd_vision_face_detect", "mountainview", "Detect faces with EdenAI", "detect faces", "POST", "/api/vision/analyze", { source: "mountainview-ai", imageBase64: "{{imageBase64}}", imageUrl: "{{imageUrl}}", features: ["face_detection"], providers: "{{providers}}" }],
      ["cmd_vision_logo_detect", "mountainview", "Detect stream/app logos with EdenAI", "detect logo", "POST", "/api/vision/analyze", { source: "mountainview-ai", imageBase64: "{{imageBase64}}", imageUrl: "{{imageUrl}}", features: ["logo_detection"], providers: "{{providers}}" }],
      ["cmd_vision_object_detect", "mountainview", "Detect objects with EdenAI", "detect objects", "POST", "/api/vision/analyze", { source: "mountainview-ai", imageBase64: "{{imageBase64}}", imageUrl: "{{imageUrl}}", features: ["object_detection"], providers: "{{providers}}" }],
      ["cmd_vision_screen_read", "mountainview", "Read visible screen with EdenAI OCR", "read what i see", "POST", "/api/vision/analyze", { source: "mountainview-ai", imageBase64: "{{imageBase64}}", imageUrl: "{{imageUrl}}", features: ["ocr"], providers: "{{providers}}" }],
      ["cmd_profile_save_person", "mountainview", "Save person/profile memory", "save this person", "POST", "/api/people/remember", { source: "mountainview-ai", displayName: "{{displayName}}", twitchUsername: "{{twitchUsername}}", discordUsername: "{{discordUsername}}", relationship: "{{relationship}}", notes: "{{message}}", reminders: "{{reminders}}", topics: "{{topics}}", preferences: "{{preferences}}", boundaries: "{{boundaries}}", avatarUrl: "{{avatarUrl}}", streamLogo: "{{streamLogo}}" }],
      ["cmd_profile_meeting_reminder", "mountainview", "Save meeting reminder for person", "remember meeting with this person", "POST", "/api/people/remember", { source: "mountainview-ai", displayName: "{{displayName}}", notes: "{{message}}", reminders: [{ "kind": "meeting", "when": "{{meetingWhen}}", "note": "{{message}}" }], topics: "{{topics}}" }],
      ["cmd_streamweaver_image", "streamweaver", "Send image to StreamWeaver", "send image to streamweaver", "POST", "/api/ai/image", { source: "android-glasses", prompt: "{{prompt}}", tenantId: "{{tenantId}}", providerOverride: "{{providerOverride}}", providerParams: "{{providerParams}}", contextImage: "{{imageBase64}}" }],
      ["cmd_streamweaver_image_generate", "streamweaver", "Generate StreamWeaver image", "generate stream image", "POST", "/api/ai/image", { source: "mountainview-ai", prompt: "{{prompt}}", tenantId: "{{tenantId}}", providerOverride: "{{providerOverride}}", resolution: "{{resolution}}", numImages: "{{numImages}}", providerParams: "{{providerParams}}" }],
      ["cmd_streamweaver_image_regenerate", "streamweaver", "Regenerate image from glasses context", "regenerate this image", "POST", "/api/ai/image", { source: "mountainview-ai", prompt: "{{prompt}}", tenantId: "{{tenantId}}", providerOverride: "{{providerOverride}}", providerParams: { "mode": "regenerate", "contextImage": "{{imageBase64}}", "scene": "{{message}}" } }],
      ["cmd_streamweaver_tts", "streamweaver", "Speak Athena through StreamWeaver", "speak on stream", "POST", "/api/tts", { source: "mountainview-ai", text: "{{message}}", tenantId: "{{tenantId}}", voice: "{{voice}}" }],
      ["cmd_streamweaver_tts_play", "streamweaver", "Play Athena TTS audio", "play athena audio", "GET", "/api/tts/play?text={{message}}&tenantId={{tenantId}}", {}],
      ["cmd_stream_start", "streamweaver", "Start Twitch client workflow", "start stream workflow", "POST", "/api/twitch/start", { source: "mountainview-ai", tenantId: "{{tenantId}}", payload: "{{payload}}" }],
      ["cmd_stream_stop", "streamweaver", "Stop stream workflow", "stop stream workflow", "POST", "/api/stream/stop", { source: "mountainview-ai", payload: "{{payload}}" }],
      ["cmd_stream_audio", "streamweaver", "Start glasses audio relay", "start glasses audio", "POST", "/api/glasses/audio-stream/start", { source: "mountainview-ai", device: "{{device}}", roomId: "{{roomId}}", payload: "{{payload}}" }],
      ["cmd_stream_video", "streamweaver", "Start glasses video relay", "start glasses video", "POST", "/api/glasses/video-stream/start", { source: "mountainview-ai", device: "{{device}}", roomId: "{{roomId}}", payload: "{{payload}}" }],
      ["cmd_stream_overlay", "streamweaver", "Trigger stream overlay/event", "trigger stream overlay", "POST", "/api/stream/overlay", { source: "mountainview-ai", event: "{{payload}}" }],
      ["cmd_streamweaver_obs_scenes", "streamweaver", "Read StreamWeaver OBS scenes", "what obs scenes do i have", "GET", "/api/obs/scenes", {}],
      ["cmd_streamweaver_overlay_data", "streamweaver", "Read StreamWeaver overlay data", "show overlay data", "GET", "/api/overlay/{{overlayType}}?tenant={{tenantId}}", {}],
      ["cmd_streamweaver_voice_commander", "streamweaver", "Run StreamWeaver voice commander", "run voice commander", "POST", "/api/mountainview/voice-commander", { source: "mountainview-ai", transcript: "{{transcript}}", destination: "{{destination}}", wakeWord: "{{wakeWord}}", tenantId: "{{tenantId}}", username: "{{username}}", payload: "{{payload}}" }],
      ["cmd_twitch_stream_assist", "streamweaver", "Start Twitch screen assist", "start twitch assist", "POST", "/api/twitch/screen-assist/start", { source: "mountainview-ai", trigger: "twitch-logo", transcript: "{{transcript}}", payload: "{{payload}}" }],
      ["cmd_discord_event", "discordstreamhub", "Push Twitch event to DiscordStreamHub", "push event to discord", "POST", "/api/twitch/events", { source: "mountainview-ai", type: "{{eventType}}", serverId: "{{serverId}}", twitchLogin: "{{twitchUsername}}", username: "{{username}}", channel: "{{channel}}", message: "{{message}}" }],
      ["cmd_discord_message", "discordstreamhub", "Send DiscordStreamHub channel message", "send discord stream message", "POST", "/api/discord/post", { source: "mountainview-ai", channelId: "{{channelId}}", content: "{{message}}" }],
      ["cmd_dsh_calendar_add_mission", "discordstreamhub", "Add DiscordStreamHub calendar mission", "add calendar mission", "POST", "/api/calendar/add-mission", { source: "mountainview-ai", serverId: "{{serverId}}", userId: "{{discordUserId}}", missionName: "{{missionName}}", missionDate: "{{missionDate}}", missionTime: "{{missionTime}}", missionDescription: "{{missionDescription}}" }],
      ["cmd_dsh_calendar_post", "discordstreamhub", "Post DiscordStreamHub calendar", "post calendar to discord", "POST", "/api/calendar/post", { source: "mountainview-ai", serverId: "{{serverId}}", channelId: "{{channelId}}" }],
      ["cmd_dsh_calendar_generate", "discordstreamhub", "Generate DiscordStreamHub calendar embed", "generate calendar embed", "POST", "/api/calendar/generate", { source: "mountainview-ai", serverId: "{{serverId}}", channelId: "{{channelId}}", includeButtons: "{{includeButtons}}" }],
      ["cmd_chat_tag_live_members", "chat-tag", "Ask Chat-Tag who is live", "who is live", "GET", "/api/discord/live-members", {}],
      ["cmd_chat_tag_state", "chat-tag", "Read Chat-Tag game state", "chat tag status", "GET", "/api/tag", {}],
      ["cmd_chat_tag_join", "chat-tag", "Join Chat-Tag from glasses", "join chat tag", "POST", "/api/tag", { source: "mountainview-ai", action: "join", userId: "{{userId}}", twitchUsername: "{{twitchUsername}}", username: "{{username}}", performedBy: "{{performedBy}}" }],
      ["cmd_chat_tag_tag", "chat-tag", "Tag a Chat-Tag player from glasses", "tag player", "POST", "/api/tag", { source: "mountainview-ai", action: "tag", userId: "{{userId}}", twitchUsername: "{{twitchUsername}}", targetUserId: "{{targetUserId}}", streamerId: "{{streamerId}}", performedBy: "{{performedBy}}", targetLookupError: "{{targetLookupError}}" }],
      ["cmd_chat_tag", "chat-tag", "Tag a Chat-Tag player from glasses", "trigger chat tag", "POST", "/api/tag", { source: "mountainview-ai", action: "tag", userId: "{{userId}}", twitchUsername: "{{twitchUsername}}", targetUserId: "{{targetUserId}}", streamerId: "{{streamerId}}", performedBy: "{{performedBy}}", targetLookupError: "{{targetLookupError}}" }],
      ["cmd_chat_tag_qr", "chat-tag", "Trigger QR Chat-Tag join/state workflow", "scan qr trigger", "POST", "/api/tag", { source: "mountainview-ai", action: "{{action}}", userId: "{{userId}}", twitchUsername: "{{twitchUsername}}", username: "{{username}}", performedBy: "{{performedBy}}" }],
      ["cmd_hearmeout", "hearmeout", "Read HearMeOut music session", "trigger hear me out", "GET", "/api/music/session/state", {}],
      ["cmd_hearmeout_voice_room", "hearmeout", "Register MountainView in HearMeOut voice room", "join voice room", "POST", "/api/peer-voice/register", { source: "mountainview-ai", roomId: "{{roomId}}", peerId: "{{peerId}}" }],
      ["cmd_hearmeout_voice_peers", "hearmeout", "List HearMeOut voice room peers", "who is in hearmeout room", "GET", "/api/peer-voice/peers?roomId={{roomId}}", {}],
      ["cmd_hearmeout_music_control", "hearmeout", "Control HearMeOut music session", "control hear me out music", "POST", "/api/music/session/control", { source: "mountainview-ai", action: "{{action}}", position: "{{position}}" }],
      ["cmd_hearmeout_song_request", "hearmeout", "Request HearMeOut song", "request song", "POST", "/api/music/session/request", { source: "mountainview-ai", query: "{{query}}", username: "{{username}}", platform: "{{platform}}" }],
      ["cmd_hearmeout_audiobook_request", "hearmeout", "Request HearMeOut audiobook/search item", "request audiobook", "POST", "/api/music/session/request", { source: "mountainview-ai", query: "{{query}}", username: "{{username}}", platform: "{{platform}}", mediaType: "audiobook" }],
      ["cmd_hearmeout_watch_request", "hearmeout", "Request HearMeOut watch item", "request watch party item", "POST", "/api/watch/sessions/{{sessionId}}/request", { source: "mountainview-ai", query: "{{query}}", itemId: "{{itemId}}", userId: "{{userId}}", username: "{{username}}" }],
      ["cmd_hearmeout_watch_control", "hearmeout", "Control HearMeOut watch party", "control watch party", "POST", "/api/watch/sessions/{{sessionId}}/control", { source: "mountainview-ai", action: "{{action}}", position: "{{position}}", targetIndex: "{{targetIndex}}" }],
      ["cmd_eden_scene", "edenai", "Analyze current scene with EdenAI", "ask ai what am i looking at", "POST", "/v2/image/explicit_content", { source: "mountainview-ai", image: "{{imageBase64}}", providers: "{{providers}}" }],
      ["cmd_eden_screen_read", "edenai", "Read visible screen text", "read my screen", "POST", "/v2/ocr/ocr", { source: "mountainview-ai", file: "{{imageBase64}}", providers: "{{providers}}", fallbackRoute: "streamweaver" }],
      ["cmd_eden_image_generation", "edenai", "Generate image from glasses context", "generate image from what i see", "POST", "/v2/image/generation", { source: "mountainview-ai", prompt: "{{prompt}}", contextImage: "{{imageBase64}}", providers: "{{providers}}" }],
      ["cmd_eden_video_generation", "edenai", "Generate video from glasses context", "generate video from what i see", "POST", "/v2/video/generation", { source: "mountainview-ai", prompt: "{{prompt}}", image: "{{imageBase64}}", providers: "{{providers}}" }],
      ["cmd_person_memory_note", "streamweaver", "Save consent-based person memory note", "save note about this person", "POST", "/api/memory/person-note", { source: "mountainview-ai", personId: "{{personId}}", note: "{{note}}", consent: "{{consent}}", payload: "{{payload}}" }]
    ] as const;
    for (const command of defaults) {
      this.db.prepare(`
        INSERT INTO command_definitions (id, user_id, app_id, name, phrase, method, url_template, payload_template, retry_count, enabled, updated_at)
        VALUES (?, 'system', ?, ?, ?, ?, ?, ?, 2, 1, ?)
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
        WHERE command_definitions.user_id = 'system'
      `).run(command[0], command[1], command[2], command[3], command[4], command[5], JSON.stringify(command[6]), now);
    }
    const devices = [
      ["device_phone", "MountainView Phone", "phone", "phone-companion", "local", ["display", "camera", "commands", "notifications"]],
      ["device_rdglass_aimb", "AiMB / RDGlass Glasses", "glasses", "ble-scan", "android-ble-research", ["ble-scan", "gatt-discovery", "voice-event-research", "image-event-research"]],
      ["device_tablet", "Companion Tablet", "tablet", "tablet-hud", "qr", ["display", "companion-hud", "commands"]],
      ["device_pc", "Stream PC", "computer", "stream-pc", "qr-bluetooth", ["obs", "streamweaver", "browser-display"]],
      ["device_obs", "OBS / Stream Machine", "stream-machine", "obs-control", "local-network", ["obs-scenes", "overlays", "stream-control"]]
    ] as const;
    for (const device of devices) {
      this.db.prepare(`
        INSERT INTO devices (id, user_id, name, kind, pairing_code, connection_hint, status, capabilities_json, last_seen_at, updated_at)
        VALUES (?, 'owner', ?, ?, ?, ?, 'ready', ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(device[0], device[1], device[2], device[3], device[4], JSON.stringify(device[5]), now, now);
    }
    const pollingProfiles = [
      ["poll_balanced_qr", "Balanced QR/device scan", 60, "balanced", ["qr", "device-marker", "screen-marker", "app-logo"]],
      ["poll_fast_trigger", "Fast command trigger scan", 15, "high-power", ["qr", "scene-change", "stream-overlay", "screen-read"]],
      ["poll_low_power_memory", "Low power memory assist", 180, "battery-saver", ["person-card", "place", "meeting-context"]]
    ] as const;
    for (const profile of pollingProfiles) {
      this.db.prepare(`
        INSERT INTO visual_polling_profiles (id, user_id, name, interval_seconds, battery_mode, trigger_targets_json, enabled, updated_at)
        VALUES (?, 'owner', ?, ?, ?, ?, 1, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(profile[0], profile[1], profile[2], profile[3], JSON.stringify(profile[4]), now);
    }
    const logoProfiles = [
      ["logo_streamweaver", "streamweaver", "StreamWeaver", ["streamweaver", "stream weaver", "spacemountain stream"], "cmd_streamweaver_voice_commander", 0.78],
      ["logo_hearmeout", "hearmeout", "HearMeOut", ["hearmeout", "hear me out", "voice room"], "cmd_hearmeout", 0.78],
      ["logo_discordstreamhub", "discordstreamhub", "DiscordStreamHub", ["discordstreamhub", "discord stream hub", "discord"], "cmd_dsh_calendar_add_mission", 0.78],
      ["logo_chattag", "chat-tag", "Chat-Tag", ["chat-tag", "chat tag", "tag trigger"], "cmd_chat_tag_live_members", 0.78],
      ["logo_edenai", "edenai", "EdenAI", ["edenai", "eden ai", "ai router"], "cmd_eden_scene", 0.78],
      ["logo_twitch", "twitch", "Twitch", ["twitch", "twitch.tv", "purple chat", "live channel"], "cmd_twitch_stream_assist", 0.78],
      ["logo_discord", "discord", "Discord", ["discord", "discord app", "discord chat", "discord server"], "cmd_discord_message", 0.78]
    ] as const;
    for (const logo of logoProfiles) {
      this.db.prepare(`
        INSERT INTO app_logo_profiles (id, user_id, app_id, name, aliases_json, command_id, confidence_threshold, updated_at)
        VALUES (?, 'system', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(logo[0], logo[1], logo[2], JSON.stringify(logo[3]), logo[4], logo[5], now);
    }
    const qrTriggers = [
      ["qr_stream_overlay", "Stream overlay trigger", "streamweaver", "cmd_stream_overlay", "mountainview://streamweaver/overlay/default", "stream-overlay"],
      ["qr_ar_avatar", "AR avatar room anchor", "streamweaver", "cmd_eden_image_generation", "mountainview://avatar/room-anchor/default", "ar-avatar"],
      ["qr_hearmeout_audiobook", "HearMeOut audiobook request", "hearmeout", "cmd_hearmeout_audiobook_request", "mountainview://hearmeout/audiobook/request", "media-request"],
      ["qr_chat_tag_join", "Chat-Tag join trigger", "chat-tag", "cmd_chat_tag_qr", "mountainview://chat-tag/join/default", "tag-join"],
      ["qr_discord_calendar", "DiscordStreamHub calendar trigger", "discordstreamhub", "cmd_dsh_calendar_add_mission", "mountainview://discordstreamhub/calendar/add", "calendar-event"]
    ] as const;
    for (const trigger of qrTriggers) {
      this.db.prepare(`
        INSERT INTO qr_triggers (id, user_id, name, target_app, command_id, payload, action_type, updated_at)
        VALUES (?, 'system', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(trigger[0], trigger[1], trigger[2], trigger[3], trigger[4], trigger[5], now);
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
    if (serviceId === "streamweaver") headers["x-mountainview-bridge"] = "1";
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

  private decideVoiceRoute(userId: string, transcript: string, context: JsonRecord): JsonRecord {
    const lower = transcript.toLowerCase();
    const requestedDestination = normalizeVoiceDestination(readText(context, "destination"));
    const requestedMode = normalizeVoiceMode(readText(context, "voiceMode"));
    const tenantId = readText(context, "tenantId") || DEFAULT_STREAMWEAVER_TENANT_ID;
    const username = readText(context, "username") || DEFAULT_STREAMWEAVER_USERNAME;
    const visualContext = readText(context, "visualContext");

    const directMessage = extractDirectMessageIntent(transcript);
    if (directMessage) {
      const channel = directMessage.channel || readText(context, "channel") || extractTwitchChannel(visualContext) || username;
      return voiceDecision({
        mode: "action",
        commandId: "cmd_streamweaver_voice_commander",
        appId: "streamweaver",
        transcript: directMessage.message,
        confidence: 0.94,
        reason: "Natural language asked to send/post/type a message, so MountainView selected StreamWeaver dictation instead of Athena conversation.",
        payload: { destination: directMessage.destination || requestedDestination || "twitch", voiceMode: "dictation", dispatch: true, channel, tenantId, username, targetName: directMessage.targetName }
      });
    }

    if (/\b(be right back|brb|back from break|stop brb|shout\s*out|shoutout|generate|make|create)\b/.test(lower) && /\b(image|picture|photo|avatar|brb|shout)/.test(lower)) {
      return voiceDecision({
        mode: "action",
        commandId: "cmd_streamweaver_voice_commander",
        appId: "streamweaver",
        transcript,
        confidence: 0.91,
        reason: "StreamWeaver voice commander already owns built-in stream actions like shoutout, BRB, and !img image flows.",
        payload: { destination: requestedDestination || "ai", voiceMode: requestedMode || "reply", tenantId, username }
      });
    }

    if (/\b(calendar|meeting|appointment|event|reminder|schedule|date)\b/.test(lower)) {
      return voiceDecision({
        mode: "action",
        commandId: "cmd_dsh_calendar_add_mission",
        appId: "discordstreamhub",
        transcript,
        confidence: 0.9,
        reason: "Calendar/date language maps to the DiscordStreamHub mission calendar command.",
        payload: { destination: "discord", tenantId, username }
      });
    }

    if (/\b(song|audiobook|audio book|movie|watch party|queue|request|play)\b/.test(lower) && /\b(hearmeout|hear me out|song|audiobook|audio book|movie|watch party)\b/.test(lower)) {
      const commandId = /\b(audiobook|audio book)\b/.test(lower) ? "cmd_hearmeout_audiobook_request" : "cmd_hearmeout_song_request";
      return voiceDecision({
        mode: "action",
        commandId,
        appId: "hearmeout",
        transcript,
        confidence: 0.88,
        reason: "Media queue language maps to HearMeOut request routes.",
        payload: { query: transcript, tenantId, username }
      });
    }

    const catalog = this.bestCatalogMatch(userId, transcript);
    if (catalog && Number(catalog.confidence) >= 0.62) {
      return voiceDecision({
        mode: "action",
        commandId: String(catalog.commandId),
        appId: String(catalog.appId),
        transcript,
        confidence: Number(catalog.confidence),
        reason: `Matched command catalog phrase/name: ${catalog.reason}`,
        payload: { tenantId, username, destination: requestedDestination || "ai", voiceMode: requestedMode || "reply" }
      });
    }

    return voiceDecision({
      mode: "conversation",
      commandId: "cmd_streamweaver_voice_commander",
      appId: "streamweaver",
      transcript,
      confidence: 0.55,
      reason: "No high-confidence action matched, so MountainView kept this as Athena conversation.",
      payload: { destination: requestedDestination || "ai", voiceMode: requestedMode || "reply", tenantId, username }
    });
  }

  private bestCatalogMatch(userId: string, transcript: string): JsonRecord | undefined {
    const lower = transcript.toLowerCase();
    const terms = tokenizeCommandText(lower);
    if (terms.length === 0) return undefined;
    let best: JsonRecord | undefined;
    for (const command of this.listCommands(userId)) {
      if (Number(command.enabled ?? 1) !== 1) continue;
      const phrase = String(command.phrase ?? "");
      const haystack = `${command.name ?? ""} ${phrase} ${command.app_id ?? ""} ${command.url_template ?? ""}`.toLowerCase();
      const commandTerms = tokenizeCommandText(haystack);
      if (commandTerms.length === 0) continue;
      const overlap = terms.filter((term) => commandTerms.includes(term)).length;
      let score = overlap / Math.max(terms.length, 4);
      if (phrase && lower.includes(phrase.toLowerCase())) score += 0.35;
      if (String(command.app_id) === "streamweaver" && /\b(stream|twitch|voice|image|overlay|tts|shout|brb)\b/.test(lower)) score += 0.08;
      if (String(command.app_id) === "hearmeout" && /\b(hear|song|audio|room|watch|movie)\b/.test(lower)) score += 0.08;
      if (String(command.app_id) === "chat-tag" && /\b(tag|game|card|join)\b/.test(lower)) score += 0.08;
      if (!best || score > Number(best.confidence)) {
        best = { commandId: command.id, appId: command.app_id, confidence: Math.min(0.86, score), reason: `${command.name ?? command.id}` };
      }
    }
    return best;
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
    const stored = JSON.parse(await readFile(file, "utf8")) as Partial<MountainViewConfig>;
    const config = normalizeRuntimeConfig(stored);
    await writeFile(file, JSON.stringify(config, null, 2));
    return config;
  } catch {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  }
}

function normalizeRuntimeConfig(stored: Partial<MountainViewConfig>): MountainViewConfig {
  const storedServices = Array.isArray(stored.services) ? stored.services : [];
  const services = defaultConfig.services.map((service) => ({
    ...service,
    ...(storedServices.find((candidate) => candidate?.id === service.id) ?? {})
  }));
  for (const service of storedServices) {
    if (service?.id && !services.some((candidate) => candidate.id === service.id)) services.push(service);
  }

  const extraNotes = Array.isArray(stored.metaWearables?.notes)
    ? stored.metaWearables.notes.filter((note) =>
      typeof note === "string" &&
      !note.includes("does not run face recognition") &&
      !note.includes("Image analysis is delegated to StreamWeaver or configured Spacemountain services")
    )
    : [];
  const notes = [...defaultConfig.metaWearables.notes];
  for (const note of extraNotes) {
    if (!notes.includes(note)) notes.push(note);
  }

  return {
    services,
    metaWearables: {
      ...defaultConfig.metaWearables,
      ...(stored.metaWearables ?? {}),
      notes
    }
  };
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

function withCommandDefaults(commandId: string, payload: JsonRecord): JsonRecord {
  const nestedPayload = asRecord(payload.payload);
  const message = readText(payload, "message") || readText(payload, "transcript") || readText(nestedPayload, "message") || readText(nestedPayload, "transcript");
  const tenantId = readText(payload, "tenantId") || readText(nestedPayload, "tenantId") || DEFAULT_STREAMWEAVER_TENANT_ID;
  const username = readText(payload, "username") || readText(nestedPayload, "username") || DEFAULT_STREAMWEAVER_USERNAME;
  const twitchUsername = readText(payload, "twitchUsername") || readText(nestedPayload, "twitchUsername") || username;
  const channel = readText(payload, "channel") || readText(nestedPayload, "channel") || username;
  const base = {
    ...payload,
    message,
    transcript: readText(payload, "transcript") || message,
    tenantId,
    username,
    twitchUsername,
    channel,
    payload: {
      ...nestedPayload,
      message,
      tenantId,
      username,
      twitchUsername,
      channel
    }
  };

  if (commandId === "cmd_streamweaver_voice_commander") {
    return base;
  }

  if (commandId.startsWith("cmd_vision_")) {
    const feature = commandId.includes("face") ? ["face_detection"]
      : commandId.includes("logo") ? ["logo_detection"]
        : commandId.includes("object") ? ["object_detection"]
          : commandId.includes("screen") ? ["ocr"]
            : ["ocr", "logo_detection", "object_detection", "face_detection"];
    return {
      ...base,
      features: Array.isArray(payload.features) ? payload.features : feature,
      providers: readText(base, "providers") || "google,amazon",
      question: readText(base, "question") || "What is visible in this image?",
      imageBase64: readText(base, "imageBase64"),
      imageUrl: readText(base, "imageUrl"),
      labels: payload.labels ?? [],
      vision: payload.vision ?? {},
      savePerson: payload.savePerson ?? false,
      displayName: readText(base, "displayName") || extractProfileName(message)
    };
  }

  if (commandId.startsWith("cmd_profile_")) {
    const profileName = readText(base, "displayName") || extractProfileName(message) || "Unknown person";
    return {
      ...base,
      displayName: profileName,
      meetingWhen: readText(base, "meetingWhen") || extractMeetingWhen(message),
      reminders: payload.reminders ?? [],
      topics: normalizeTags(payload.topics).length ? normalizeTags(payload.topics) : extractTopics(message),
      preferences: payload.preferences ?? [],
      boundaries: payload.boundaries ?? []
    };
  }

  if (commandId === "cmd_streamweaver_image" || commandId === "cmd_streamweaver_image_generate" || commandId === "cmd_streamweaver_image_regenerate") {
    return {
      ...base,
      prompt: readText(base, "prompt") || message || "Create a stream-ready image from the current glasses context.",
      providerOverride: readText(base, "providerOverride") || "eden",
      resolution: readText(base, "resolution") || "1024x1024",
      numImages: Number(payload.numImages ?? nestedPayload.numImages ?? 1),
      providerParams: payload.providerParams ?? nestedPayload.providerParams ?? {}
    };
  }

  if (commandId === "cmd_streamweaver_tts" || commandId === "cmd_streamweaver_tts_play") {
    return {
      ...base,
      voice: readText(base, "voice"),
      message: message || "Athena is connected to the stream."
    };
  }

  if (commandId === "cmd_streamweaver_overlay_data") {
    return {
      ...base,
      overlayType: readText(base, "overlayType") || "stream"
    };
  }

  if (commandId === "cmd_discord_event") {
    return {
      ...base,
      serverId: readText(base, "serverId") || DEFAULT_DISCORD_GUILD_ID,
      eventType: readText(base, "eventType") || "chat_activity"
    };
  }

  if (commandId === "cmd_discord_message") {
    return {
      ...base,
      channelId: readText(base, "channelId") || DEFAULT_DISCORD_CHANNEL_ID
    };
  }

  if (commandId.startsWith("cmd_dsh_calendar_")) {
    const calendar = extractCalendarFields(message);
    return {
      ...base,
      serverId: readText(base, "serverId") || DEFAULT_DISCORD_GUILD_ID,
      channelId: readText(base, "channelId") || DEFAULT_DISCORD_CHANNEL_ID,
      discordUserId: readText(base, "discordUserId") || DEFAULT_DISCORD_OWNER_ID,
      missionName: readText(base, "missionName") || readText(base, "title") || calendar.title,
      missionDate: readText(base, "missionDate") || readText(base, "date") || calendar.date,
      missionTime: readText(base, "missionTime") || readText(base, "time") || calendar.time,
      missionDescription: readText(base, "missionDescription") || readText(base, "description") || message || calendar.title,
      includeButtons: payload.includeButtons ?? nestedPayload.includeButtons ?? true
    };
  }

  if (commandId === "cmd_chat_tag" || commandId === "cmd_chat_tag_tag" || commandId === "cmd_chat_tag_join" || commandId === "cmd_chat_tag_qr") {
    const action = commandId === "cmd_chat_tag_join" ? "join" : readText(base, "action") || (commandId === "cmd_chat_tag_qr" ? "join" : "tag");
    const targetName = readText(base, "targetName") || readText(base, "target") || extractChatTagTarget(message);
    return {
      ...base,
      action,
      userId: readText(base, "userId") || DEFAULT_CHAT_TAG_USER_ID,
      twitchUsername,
      streamerId: readText(base, "streamerId") || DEFAULT_STREAMWEAVER_USERNAME,
      performedBy: readText(base, "performedBy") || "mountainview-ai",
      targetName,
      targetUserId: readText(base, "targetUserId")
    };
  }

  if (commandId === "cmd_hearmeout" || commandId === "cmd_hearmeout_song_request" || commandId === "cmd_hearmeout_audiobook_request") {
    return {
      ...base,
      query: readText(base, "query") || message,
      platform: readText(base, "platform") || "mountainview-glasses"
    };
  }

  if (commandId === "cmd_hearmeout_voice_room" || commandId === "cmd_hearmeout_voice_peers") {
    return {
      ...base,
      roomId: readText(base, "roomId") || DEFAULT_HEARMEOUT_ROOM_ID,
      peerId: readText(base, "peerId") || `mountainview-${username}`
    };
  }

  if (commandId === "cmd_hearmeout_music_control") {
    return {
      ...base,
      action: readText(base, "action") || extractMusicAction(message),
      position: Number(payload.position ?? nestedPayload.position ?? 0)
    };
  }

  if (commandId === "cmd_hearmeout_watch_request") {
    return {
      ...base,
      sessionId: readText(base, "sessionId") || DEFAULT_HEARMEOUT_ROOM_ID,
      query: readText(base, "query") || message,
      itemId: readText(base, "itemId"),
      userId: readText(base, "userId") || DEFAULT_CHAT_TAG_USER_ID
    };
  }

  if (commandId === "cmd_hearmeout_watch_control") {
    return {
      ...base,
      sessionId: readText(base, "sessionId") || DEFAULT_HEARMEOUT_ROOM_ID,
      action: readText(base, "action") || extractMusicAction(message),
      position: Number(payload.position ?? nestedPayload.position ?? 0),
      targetIndex: Number(payload.targetIndex ?? nestedPayload.targetIndex ?? 0)
    };
  }

  if (commandId === "cmd_eden_video_generation" || commandId === "cmd_eden_image_generation") {
    return {
      ...base,
      prompt: readText(base, "prompt") || message || "Generate media from the current glasses context.",
      providers: readText(base, "providers") || "replicate"
    };
  }

  return {
    ...base
  };
}

function voiceDecision(input: {
  mode: "conversation" | "action";
  commandId: string;
  appId: string;
  transcript: string;
  confidence: number;
  reason: string;
  payload: JsonRecord;
}): JsonRecord {
  return {
    mode: input.mode,
    commandId: input.commandId,
    appId: input.appId,
    transcript: input.transcript,
    confidence: input.confidence,
    reason: input.reason,
    payload: input.payload,
    createdAt: new Date().toISOString()
  };
}

function summarizeCommandResult(result: JsonRecord): JsonRecord {
  const response = asRecord(result.response);
  return {
    ok: result.ok,
    status: result.status,
    routed: response.routed,
    handled: response.handled,
    dispatched: response.dispatched,
    command: response.command
  };
}

function normalizeVoiceDestination(value: string): string {
  return ["ai", "private", "twitch", "discord"].includes(value) ? value : "";
}

function normalizeVoiceMode(value: string): string {
  return ["reply", "dictation", "translation"].includes(value) ? value : "";
}

function tokenizeCommandText(value: string): string[] {
  const stop = new Set(["the", "and", "that", "with", "from", "this", "please", "athena", "annie", "command", "trigger"]);
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !stop.has(term));
}

function extractDirectMessageIntent(text: string): { message: string; targetName: string; channel: string; destination: string } | undefined {
  const quoted = text.match(/\b(?:send|post|type|say)\s+(?:a\s+)?message(?:\s+to\s+(.+?))?\s+(?:that\s+says|saying|with|:)\s+["“]?(.+?)["”]?\s*$/i);
  if (quoted?.[2]?.trim()) {
    const targetName = cleanSpokenTarget(quoted[1] ?? "");
    return {
      message: quoted[2].trim(),
      targetName,
      channel: normalizeTwitchChannel(targetName),
      destination: /\bdiscord|server\b/i.test(text) ? "discord" : "twitch"
    };
  }

  const simple = text.match(/\b(?:send|post|type)\s+["“]?(.+?)["”]?\s+(?:to|in|into)\s+(.+?)(?:\s+(?:chat|twitch|discord))?\s*$/i);
  if (simple?.[1]?.trim()) {
    const targetName = cleanSpokenTarget(simple[2] ?? "");
    return {
      message: simple[1].trim(),
      targetName,
      channel: normalizeTwitchChannel(targetName),
      destination: /\bdiscord|server\b/i.test(text) ? "discord" : "twitch"
    };
  }

  return undefined;
}

function cleanSpokenTarget(value: string): string {
  return value
    .replace(/\b(?:twitch|discord|chat|channel|server|user)\b/ig, "")
    .replace(/^@/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTwitchChannel(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/[^a-z0-9_]+/g, "")
    .slice(0, 25);
}

function extractTwitchChannel(text: string): string {
  const direct = text.match(/(?:https?:\/\/)?(?:www\.)?twitch\.tv\/([a-z0-9_]{3,25})/i);
  if (direct?.[1]) return direct[1].toLowerCase();
  const named = text.match(/\b(?:watching|locked|target|channel)\s+@?([a-z0-9_]{3,25})(?:'s)?\s+(?:twitch\s+)?(?:stream|chat)\b/i);
  return named?.[1]?.toLowerCase() ?? "";
}

function readText(source: JsonRecord, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function normalizeLookupName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/^@+/, "").replace(/[^a-z0-9_]/g, "");
}

function extractChatTagTarget(message: string): string {
  const match = message.match(/\b(?:tag|use\s+pass\s+on|pass\s+to)\s+@?([a-z0-9_][a-z0-9_.-]{1,30})/i);
  return match?.[1]?.replace(/[.,!?]+$/, "") ?? "";
}

function findChatTagPlayer(players: unknown, targetName: string): JsonRecord | null {
  if (!Array.isArray(players)) return null;
  const target = normalizeLookupName(targetName);
  if (!target) return null;
  for (const player of players) {
    const record = asRecord(player);
    const names = [
      record.id,
      record.twitchUsername,
      record.username,
      record.displayName,
      record.discordUsername,
      record.kickUsername
    ].map(normalizeLookupName).filter(Boolean);
    if (names.includes(target)) return record;
  }
  return null;
}

function extractCalendarFields(message: string): { title: string; date: string; time: string } {
  const now = new Date();
  const lower = message.toLowerCase();
  const date = extractIsoDate(message)
    || formatDateOnly(new Date(now.getTime() + (lower.includes("tomorrow") ? 1 : 0) * 24 * 60 * 60 * 1000));
  const time = extractClockTime(message);
  const cleanedTitle = message
    .replace(/\b(add|create|put|schedule)\b/ig, "")
    .replace(/\b(to|on|in)\s+(my\s+)?(discord\s+stream\s+hub|discordstreamhub|calendar)\b/ig, "")
    .replace(/\b(today|tomorrow)\b/ig, "")
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "")
    .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?\b/ig, "")
    .replace(/\b\d{1,2}\s*(am|pm)\b/ig, "")
    .replace(/\s+/g, " ")
    .trim();
  return {
    title: cleanedTitle || "MountainView reminder",
    date,
    time
  };
}

function extractIsoDate(message: string): string {
  const iso = message.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const slash = message.match(/\b(\d{1,2})[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?\b/);
  if (!slash) return "";
  const now = new Date();
  const month = Number(slash[1]);
  const day = Number(slash[2]);
  const year = slash[3] ? Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]) : now.getFullYear();
  if (month < 1 || month > 12 || day < 1 || day > 31) return "";
  return formatDateOnly(new Date(year, month - 1, day));
}

function extractClockTime(message: string): string {
  const match = message.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!match) return "";
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const suffix = match[3]?.toLowerCase();
  if (suffix === "pm" && hour < 12) hour += 12;
  if (suffix === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return "";
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatDateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function extractMusicAction(message: string): string {
  const lower = message.toLowerCase();
  if (/\b(pause|hold)\b/.test(lower)) return "pause";
  if (/\b(resume|play|start)\b/.test(lower)) return "play";
  if (/\b(skip|next)\b/.test(lower)) return "skip";
  if (/\b(stop|end)\b/.test(lower)) return "stop";
  return "play";
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

function normalizeVisionFeatures(value: unknown): string[] {
  const requested = normalizeTags(value);
  const features = requested.length ? requested : ["ocr", "logo_detection", "object_detection"];
  return features
    .map((feature) => feature.toLowerCase().replace(/[-\s]+/g, "_"))
    .filter((feature) => Boolean(EDEN_AI_FEATURE_ENDPOINTS[feature]));
}

function decodeBase64Media(value: string): { buffer: Buffer; mimeType: string; filename: string } {
  const match = value.match(/^data:([^;]+);base64,(.+)$/);
  const mimeType = match?.[1] || "image/jpeg";
  const raw = match?.[2] || value;
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  return { buffer: Buffer.from(raw, "base64"), mimeType, filename: `mountainview.${ext}` };
}

function extractVisionLabels(value: unknown): string[] {
  const labels = new Set<string>();
  const visit = (node: unknown) => {
    if (node == null) return;
    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed && trimmed.length <= 120) labels.add(trimmed);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.slice(0, 60).forEach(visit);
      return;
    }
    const record = asRecord(node);
    for (const key of ["label", "name", "text", "description", "brand", "object", "category", "displayName", "twitchUsername"]) {
      if (record[key]) visit(record[key]);
    }
    for (const key of ["items", "logos", "objects", "faces", "textAnnotations", "detections", "results"]) {
      if (record[key]) visit(record[key]);
    }
    if (record.response) visit(record.response);
  };
  visit(value);
  return [...labels].slice(0, 80);
}

function normalizeReminderList(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(asRecord).filter((item) => Object.keys(item).length > 0);
  if (typeof value === "string" && value.trim()) return [{ kind: "note", note: value.trim() }];
  return [];
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "person";
}

function buildPersonMemorySummary(person: JsonRecord): string {
  const usernames = asRecord(person.usernames);
  const context = asRecord(person.context);
  const reminders = Array.isArray(person.reminders) ? person.reminders : [];
  const handles = Object.entries(usernames).map(([key, value]) => `${key}: ${value}`).join(", ");
  const topics = Array.isArray(context.topics) ? context.topics.join(", ") : "";
  const preferences = Array.isArray(context.preferences) ? context.preferences.join(", ") : "";
  return [
    `Name: ${person.display_name}`,
    handles ? `Handles: ${handles}` : "",
    context.relationship ? `Relationship: ${context.relationship}` : "",
    topics ? `Topics: ${topics}` : "",
    preferences ? `Preferences: ${preferences}` : "",
    reminders.length ? `Reminders: ${JSON.stringify(reminders)}` : "",
    person.notes ? `Notes: ${person.notes}` : ""
  ].filter(Boolean).join("\n");
}

function buildSmartCaptureReply(vision: JsonRecord, profile: JsonRecord | null): string {
  const labels = Array.isArray(vision.labels) ? vision.labels.slice(0, 6).join(", ") : "";
  const route = asRecord(vision.route).route as JsonRecord | undefined;
  const profileName = profile ? String(asRecord(profile.person).display_name ?? "") : "";
  return [
    labels ? `I recognized: ${labels}.` : "I captured the scene.",
    route?.targetDeviceName ? `Routing to ${route.targetDeviceName}.` : "",
    profileName ? `Saved profile memory for ${profileName}.` : ""
  ].filter(Boolean).join(" ");
}

function extractProfileName(message: string): string {
  const match = message.match(/\b(?:person|profile|about|meeting with|remember)\s+@?([a-z0-9_][a-z0-9_. -]{1,50})/i);
  return match?.[1]?.replace(/\b(tomorrow|today|at|on|with)\b.*$/i, "").trim() ?? "";
}

function extractMeetingWhen(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("tomorrow")) return "tomorrow";
  if (lower.includes("today")) return "today";
  const iso = message.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  return "";
}

function extractTopics(message: string): string[] {
  return ["meeting", "stream", "collab", "sponsor", "mod", "support", "watch party", "song request"]
    .filter((topic) => message.toLowerCase().includes(topic));
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
  const withRawJsonValues = template.replace(/"\{\{([a-zA-Z0-9_.-]+)\}\}"/g, (_match, key: string) => {
    const value = readPath(payload, key);
    return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value ?? "");
  });
  return parseMaybeJson(withRawJsonValues.replace(/\{\{([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => {
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

async function streamLatestMountainViewApk(response: ServerResponse, env: NodeJS.ProcessEnv): Promise<void> {
  const token = env.GITHUB_TOKEN;
  if (!token) throw new HttpError(503, "GITHUB_TOKEN is not configured for APK downloads.");

  const release = await fetch("https://api.github.com/repos/Mtman1987/fly-machine-rotator/releases/tags/mountainview-latest", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "mountainview-ai"
    }
  });
  if (!release.ok) throw new HttpError(502, `GitHub release lookup failed: ${release.status}`);

  const releaseJson = await release.json() as { assets?: Array<{ name?: string; url?: string; size?: number }> };
  const asset = releaseJson.assets?.find((item) => item.name === "app-release.apk");
  if (!asset?.url) throw new HttpError(404, "MountainView APK release asset was not found.");

  const apk = await fetch(asset.url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/octet-stream",
      "user-agent": "mountainview-ai"
    }
  });
  if (!apk.ok) throw new HttpError(502, `GitHub APK download failed: ${apk.status}`);

  const body = Buffer.from(await apk.arrayBuffer());
  response.writeHead(200, {
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": 'attachment; filename="mountainview-ai.apk"',
    "content-length": String(body.length),
    "cache-control": "no-store"
  });
  response.end(body);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

function appDisplayName(appId: string): string {
  switch (appId) {
    case "streamweaver":
      return "StreamWeaver";
    case "hearmeout":
      return "HearMeOut";
    case "discordstreamhub":
      return "DiscordStreamHub";
    case "chat-tag":
      return "Chat-Tag";
    case "edenai":
      return "EdenAI";
    default:
      return appId;
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
    button,input,textarea,select{font:inherit} button,.link-btn{border:0;border-radius:8px;padding:10px 12px;color:#00131a;background:linear-gradient(135deg,var(--blue),#b9f4ff);font-weight:800;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center} button.secondary,.link-btn.secondary{background:rgba(255,255,255,.07);color:var(--text);border:1px solid var(--line)} button.danger{background:rgba(255,107,138,.16);color:#ffdce4;border:1px solid rgba(255,107,138,.35)}
    .shell{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:20px 14px 90px}.top{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:18px}.top-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.brand{display:flex;align-items:center;gap:12px}.mark{width:38px;height:38px;border-radius:10px;background:linear-gradient(135deg,var(--violet),var(--blue));box-shadow:0 0 34px rgba(32,213,255,.35)}h1{margin:0;font-size:24px;letter-spacing:0} .sub{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}.panel{background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,.035));border:1px solid var(--line);border-radius:8px;padding:16px;box-shadow:0 18px 60px rgba(0,0,0,.28);backdrop-filter:blur(12px)}.hero{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}.stat{border:1px solid var(--line);border-radius:8px;padding:13px;background:rgba(255,255,255,.045)}.label{text-transform:uppercase;letter-spacing:.13em;color:var(--muted);font-size:10px}.value{font-size:24px;font-weight:900;margin-top:4px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.cards{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.cmd{display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--line);border-radius:8px;padding:12px;background:rgba(255,255,255,.045)}.cmd strong{display:block}.cmd span{font-size:12px;color:var(--muted)}.qr{display:grid;grid-template-columns:180px 1fr;gap:12px;align-items:start}.qr svg{width:180px;height:180px;border-radius:8px;background:#f8fbff}.tabs{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;display:flex;gap:6px;background:rgba(8,12,25,.86);border:1px solid var(--line);padding:6px;border-radius:12px;backdrop-filter:blur(14px)}.tabs button{padding:9px 10px;background:transparent;color:var(--muted);border-radius:8px}.tabs button.active{background:rgba(32,213,255,.16);color:white}.screen{display:none}.screen.active{display:block}.row{display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;margin:8px 0}input,textarea,select{width:100%;border-radius:8px;border:1px solid var(--line);background:rgba(255,255,255,.06);color:var(--text);padding:10px}textarea{min-height:88px}.log{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;white-space:pre-wrap;color:#d9e8ff;background:rgba(0,0,0,.25);border-radius:8px;border:1px solid var(--line);padding:12px;max-height:260px;overflow:auto}.timeline{display:grid;gap:10px}.memory{border-left:2px solid var(--blue);padding:8px 0 8px 12px;background:rgba(255,255,255,.035);border-radius:0 8px 8px 0}.split{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:820px){.grid,.hero,.split,.qr{grid-template-columns:1fr}.cards{grid-template-columns:1fr}.top{align-items:flex-start;flex-direction:column}.top-actions{width:100%;justify-content:stretch}.top-actions>*{flex:1}.tabs{width:calc(100% - 20px);overflow:auto}.tabs button{white-space:nowrap}.row{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <main class="shell">
    <div class="top">
      <div class="brand"><div class="mark"></div><div><h1>MountainView AI</h1><div class="sub">Spacemountain.live mobile command bridge</div></div></div>
      <div class="top-actions">
        <a class="link-btn" href="/mountainview/apk">Download APK</a>
        <a class="link-btn secondary" href="/">Rotator dashboard</a>
        <button class="secondary" onclick="login()">Connect owner</button>
      </div>
    </div>

    <section id="home" class="screen active">
      <div class="grid">
        <div class="panel">
          <div class="hero">
            <div>
              <div class="label">AiMB / RDGlass bridge</div>
              <div class="value warn" id="deviceState">Native</div>
              <p class="sub">Phone-side bridge for Bluetooth audio, BLE events, media buttons, voice commands, images, and command triggers.</p>
            </div>
            <div class="stat"><div class="label">No face recognition</div><div class="value good">Relay only</div><p class="sub">StreamWeaver handles AI image processing.</p></div>
            <div class="stat"><div class="label">Live stream</div><div class="value">Ready</div><p class="sub">Control plane prepared for future direct media feeds.</p></div>
            <div class="stat"><div class="label">Flashlight</div><div class="value bad">Research</div><p class="sub">RDGlass test command is logged; steady torch control is still being mapped.</p></div>
          </div>
        </div>
        <div class="panel">
          <div class="label">Quick actions</div>
          <div class="cards" id="quickCommands"></div>
        </div>
      </div>
      <div class="grid" style="margin-top:14px;">
        <div class="panel"><div class="label">Companion HUD</div><div class="value">Phone / tablet / browser display</div><p class="sub">Use paired devices as the display your glasses do not have: memory cards, command output, transcripts, QR targets, and stream controls.</p><button class="secondary" onclick="show('devices', document.querySelector('[data-tab=devices]'))">Open device mesh</button></div>
        <div class="panel"><div class="label">Visual trigger polling</div><div class="value">Snapshot mode</div><p class="sub">Battery-aware scheduled photo checks for QR codes, device markers, scene changes, and memory prompts without continuous video streaming.</p><button class="secondary" onclick="show('polling', document.querySelector('[data-tab=polling]'))">Configure polling</button></div>
        <div class="panel"><div class="label">App logo recognition</div><div class="value">Screen routing</div><p class="sub">Use polling snapshots to identify Spacemountain app logos on screens and link to the right command flow.</p><button class="secondary" onclick="show('logos', document.querySelector('[data-tab=logos]'))">Open logo tests</button></div>
        <div class="panel"><div class="label">QR trigger maker</div><div class="value">AR actions</div><p class="sub">Generate scannable triggers for avatars, tags, stream overlays, rooms, and audiobook requests.</p><button class="secondary" onclick="show('qr', document.querySelector('[data-tab=qr]'))">Make QR triggers</button></div>
      </div>
    </section>

    <section id="commands" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Command center</div><div id="commandGroups" class="timeline"></div><div id="commandList" class="timeline"></div></div>
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
        <button onclick="runSystemCommand('cmd_stream_start')">Start stream</button><button class="secondary" onclick="runSystemCommand('cmd_stream_stop')">Stop stream</button><button class="secondary" onclick="runSystemCommand('cmd_stream_audio')">Start glasses audio relay</button><button class="secondary" onclick="runSystemCommand('cmd_stream_video')">Start glasses video relay</button><button class="secondary" onclick="sendImage()">Send current image/frame</button><button class="secondary" onclick="runSystemCommand('cmd_stream_overlay')">Trigger stream overlay/event</button>
      </div><p class="sub">Glasses audio/video are treated as input streams. StreamWeaver, HearMeOut, DiscordStreamHub, Chat-Tag, and EdenAI do the workflow work behind the bridge.</p></div>
    </section>

    <section id="devices" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Device mesh</div><div id="deviceList" class="timeline"></div></div>
        <div class="panel">
          <div class="label">Register device</div>
          <div class="row"><span>Name</span><input id="deviceName" value="Companion Display"></div>
          <div class="row"><span>Kind</span><select id="deviceKind"><option value="tablet">Tablet</option><option value="computer">Computer</option><option value="phone">Phone</option><option value="stream-machine">Stream machine</option><option value="browser-display">Browser display</option></select></div>
          <div class="row"><span>Pairing code</span><input id="devicePairing" value="qr-command-portal"></div>
          <button onclick="saveDevice()">Save device</button>
        </div>
      </div>
    </section>

    <section id="polling" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Visual polling profiles</div><div id="pollingList" class="timeline"></div></div>
        <div class="panel">
          <div class="label">Create polling profile</div>
          <div class="row"><span>Name</span><input id="pollName" value="QR and device trigger scan"></div>
          <div class="row"><span>Interval</span><select id="pollInterval"><option value="15">15 seconds</option><option value="60" selected>60 seconds</option><option value="180">3 minutes</option><option value="300">5 minutes</option></select></div>
          <div class="row"><span>Battery mode</span><select id="pollBattery"><option value="balanced">Balanced</option><option value="battery-saver">Battery saver</option><option value="high-power">High power</option></select></div>
          <div class="row"><span>Targets</span><input id="pollTargets" value="qr,device-marker,scene-change"></div>
          <button onclick="savePollingProfile()">Save polling profile</button>
        </div>
      </div>
    </section>

    <section id="logos" class="screen">
      <div class="split">
        <div class="panel"><div class="label">App logo recognition profiles</div><div id="logoProfileList" class="timeline"></div></div>
        <div class="panel">
          <div class="label">Add logo route</div>
          <div class="row"><span>Name</span><input id="logoName" value="StreamWeaver"></div>
          <div class="row"><span>Target app</span><select id="logoApp"><option value="streamweaver">StreamWeaver</option><option value="hearmeout">HearMeOut</option><option value="discordstreamhub">DiscordStreamHub</option><option value="chat-tag">Chat-Tag</option><option value="edenai">EdenAI</option></select></div>
          <div class="row"><span>Aliases</span><input id="logoAliases" value="streamweaver,stream weaver"></div>
          <div class="row"><span>Command</span><input id="logoCommand" value="cmd_streamweaver_voice_commander"></div>
          <button onclick="saveLogoProfile()">Save logo route</button>
          <div class="row"><span>Test text</span><input id="logoObserved" value="I see the StreamWeaver logo on my tablet"></div>
          <button class="secondary" onclick="testLogoMatch()">Test polling match</button>
          <div class="log" id="logoMatchStatus">Waiting for logo test.</div>
        </div>
      </div>
    </section>

    <section id="qr" class="screen">
      <div class="split">
        <div class="panel"><div class="label">QR trigger maker</div><div id="qrTriggerList" class="timeline"></div></div>
        <div class="panel">
          <div class="label">Create QR trigger</div>
          <div class="row"><span>Name</span><input id="qrName" value="AR avatar room anchor"></div>
          <div class="row"><span>Target app</span><select id="qrApp"><option value="streamweaver">StreamWeaver</option><option value="hearmeout">HearMeOut</option><option value="discordstreamhub">DiscordStreamHub</option><option value="chat-tag">Chat-Tag</option><option value="edenai">EdenAI</option></select></div>
          <div class="row"><span>Command</span><input id="qrCommand" value="cmd_eden_image_generation"></div>
          <div class="row"><span>Action</span><input id="qrAction" value="ar-avatar"></div>
          <div class="row"><span>Payload</span><input id="qrPayload" value="mountainview://avatar/room-anchor/default"></div>
          <button onclick="saveQrTrigger()">Generate QR trigger</button>
        </div>
      </div>
    </section>

    <section id="roadmap" class="screen">
      <div class="panel"><div class="label">Coming soon and test beds</div><div id="roadmapList" class="cards"></div></div>
    </section>

    <section id="settings" class="screen">
      <div class="split">
        <div class="panel"><div class="label">Service token storage</div><div class="row"><span>Service</span><select id="tokenService"><option value="streamweaver">StreamWeaver</option><option value="discordstreamhub">DiscordStreamHub</option><option value="chat-tag">Chat-Tag</option><option value="hearmeout">HearMeOut</option></select></div><div class="row"><span>Token</span><input id="serviceToken" type="password"></div><button onclick="saveToken()">Store encrypted token</button></div>
        <div class="panel"><div class="label">Activity logs</div><div class="log" id="activityLog"></div></div>
      </div>
    </section>
  </main>
  <nav class="tabs"><button data-tab="home" class="active" onclick="show('home',this)">Home</button><button data-tab="commands" onclick="show('commands',this)">Commands</button><button data-tab="relay" onclick="show('relay',this)">Relay</button><button data-tab="memory" onclick="show('memory',this)">Memory</button><button data-tab="stream" onclick="show('stream',this)">Stream</button><button data-tab="devices" onclick="show('devices',this)">Devices</button><button data-tab="polling" onclick="show('polling',this)">Polling</button><button data-tab="logos" onclick="show('logos',this)">Logos</button><button data-tab="qr" onclick="show('qr',this)">QR</button><button data-tab="roadmap" onclick="show('roadmap',this)">Roadmap</button><button data-tab="settings" onclick="show('settings',this)">Settings</button></nav>
  <script>
    let token = localStorage.mvToken || ""; let state = {commands:[], memory:[], logs:[]};
    const api = async (path, options={}) => { const res = await fetch('/mountainview/api' + path, { ...options, headers: { 'content-type':'application/json', authorization: token ? 'Bearer '+token : '', ...(options.headers||{}) } }); const data = await res.json(); if(!res.ok || data.error) throw new Error(data.error || 'Request failed'); return data; };
    async function login(){ const password = prompt('MountainView owner password'); if(!password) return; const data = await api('/login',{method:'POST',body:JSON.stringify({email:'owner@spacemountain.live',password})}); token=data.token; localStorage.mvToken=token; await load(); }
    async function load(){ if(!token) return; const data = await api('/bootstrap'); state=data; renderCommands(); renderMemory(); renderDevices(); renderPolling(); renderLogoProfiles(); renderQrTriggers(); renderRoadmap(); renderLogs(); }
    function show(id, btn){ document.querySelectorAll('.screen').forEach(x=>x.classList.remove('active')); document.getElementById(id).classList.add('active'); document.querySelectorAll('.tabs button').forEach(x=>x.classList.remove('active')); btn.classList.add('active'); if(id==='memory') loadMemory(); }
    function renderCommands(){ const commands=state.commands||[]; const html = commands.map(c=>'<div class="cmd"><div><strong>'+esc(c.name)+'</strong><span>'+esc(c.app_id)+' • '+esc(c.method)+' '+esc(c.url_template)+'</span></div><button class="secondary" onclick="runSystemCommand(\\''+esc(c.id)+'\\')">Run</button></div>').join(''); commandList.innerHTML=html; quickCommands.innerHTML=commands.slice(0,8).map(c=>'<div class="cmd"><div><strong>'+esc(c.name)+'</strong><span>'+esc(c.app_id)+'</span></div><button class="secondary" onclick="runSystemCommand(\\''+esc(c.id)+'\\')">Run</button></div>').join(''); const groups={StreamWeaver:commands.filter(c=>c.app_id==='streamweaver'),HearMeOut:commands.filter(c=>c.app_id==='hearmeout'),DiscordStreamHub:commands.filter(c=>c.app_id==='discordstreamhub'),'Chat-Tag':commands.filter(c=>c.app_id==='chat-tag'),EdenAI:commands.filter(c=>c.app_id==='edenai')}; commandGroups.innerHTML=Object.entries(groups).map(([name,items])=>'<div class="memory"><strong>'+esc(name)+'</strong><div class="sub">'+items.length+' commands ready</div></div>').join(''); }
    async function runSystemCommand(id){ const message = prompt('Payload message', 'MountainView trigger') || ''; const data = await api('/commands/execute',{method:'POST',body:JSON.stringify({commandId:id,payload:{message,payload:{message},metadata:{source:'dashboard'}}})}); appendLog(JSON.stringify(data,null,2)); await load(); }
    async function saveCommand(){ await api('/commands',{method:'POST',body:JSON.stringify({name:cmdName.value,appId:cmdApp.value,method:cmdMethod.value,urlTemplate:cmdUrl.value,payloadTemplate:JSON.parse(cmdPayload.value),phrase:cmdName.value.toLowerCase()})}); await load(); }
    async function sendImage(){ relayStatus.textContent='Uploading...'; const data = await api('/media/streamweaver',{method:'POST',body:JSON.stringify({imageBase64:imageBase64.value,imageUrl:imageUrl.value,metadata:{sentAt:new Date().toISOString(),source:'mountainview-dashboard'}})}); relayStatus.textContent=JSON.stringify(data,null,2); await load(); }
    async function saveMemory(){ await api('/memory',{method:'POST',body:JSON.stringify({title:memTitle.value,body:memBody.value,tags:memTags.value})}); memBody.value=''; await loadMemory(); }
    async function loadMemory(){ const data = await api('/memory?q='+encodeURIComponent(memSearch?.value||'')); state.memory=data.records; renderMemory(); }
    function renderMemory(){ memoryList.innerHTML=(state.memory||[]).map(m=>'<div class="memory"><strong>'+esc(m.title)+'</strong><div class="sub">'+esc(m.body)+'</div><div class="sub">'+esc((m.tags||[]).join(', '))+'</div></div>').join('') || '<p class="sub">No memory records yet.</p>'; }
    function renderLogs(){ activityLog.textContent=(state.logs||[]).map(l=>l.created_at+' '+l.app_id+' '+l.status+' '+l.method+' '+l.url+'\\n'+(l.error||'')).join('\\n\\n') || 'No activity yet.'; }
    async function saveToken(){ await api('/settings/token',{method:'POST',body:JSON.stringify({serviceId:tokenService.value,token:serviceToken.value})}); serviceToken.value=''; appendLog('Stored encrypted token for '+tokenService.value); }
    async function saveDevice(){ await api('/devices',{method:'POST',body:JSON.stringify({name:deviceName.value,kind:deviceKind.value,pairingCode:devicePairing.value,capabilities:['display','commands','companion-hud']})}); await load(); }
    async function savePollingProfile(){ await api('/polling-profiles',{method:'POST',body:JSON.stringify({name:pollName.value,intervalSeconds:Number(pollInterval.value),batteryMode:pollBattery.value,triggerTargets:pollTargets.value.split(',').map(x=>x.trim()).filter(Boolean)})}); await load(); }
    async function saveLogoProfile(){ await api('/logo-profiles',{method:'POST',body:JSON.stringify({name:logoName.value,appId:logoApp.value,aliases:logoAliases.value,commandId:logoCommand.value})}); await load(); }
    async function testLogoMatch(){ const data = await api('/logo-profiles/match',{method:'POST',body:JSON.stringify({observedText:logoObserved.value})}); logoMatchStatus.textContent=JSON.stringify(data,null,2); await load(); }
    async function saveQrTrigger(){ await api('/qr-triggers',{method:'POST',body:JSON.stringify({name:qrName.value,targetApp:qrApp.value,commandId:qrCommand.value,actionType:qrAction.value,payload:qrPayload.value})}); await load(); }
    function renderDevices(){ deviceList.innerHTML=(state.devices||[]).map(d=>'<div class="memory"><strong>'+esc(d.name)+'</strong><div class="sub">'+esc(d.kind)+' • '+esc(d.status)+' • '+esc(d.connection_hint)+'</div><div class="sub">Pairing: '+esc(d.pairing_code||'local')+'</div><div class="sub">'+esc((d.capabilities||[]).join(', '))+'</div></div>').join('') || '<p class="sub">No devices registered.</p>'; }
    function renderPolling(){ pollingList.innerHTML=(state.pollingProfiles||[]).map(p=>'<div class="memory"><strong>'+esc(p.name)+'</strong><div class="sub">'+esc(p.interval_seconds)+'s • '+esc(p.battery_mode)+' • '+(p.enabled ? 'enabled' : 'paused')+'</div><div class="sub">'+esc((p.trigger_targets||[]).join(', '))+'</div></div>').join('') || '<p class="sub">No polling profiles yet.</p>'; }
    function renderLogoProfiles(){ logoProfileList.innerHTML=(state.logoProfiles||[]).map(p=>'<div class="memory"><strong>'+esc(p.name)+'</strong><div class="sub">'+esc(p.app_id)+' • '+esc(p.command_id)+' • threshold '+esc(p.confidence_threshold)+'</div><div class="sub">'+esc((p.aliases||[]).join(', '))+'</div></div>').join('') || '<p class="sub">No logo profiles yet.</p>'; }
    function renderQrTriggers(){ qrTriggerList.innerHTML=(state.qrTriggers||[]).map(q=>'<div class="memory qr"><div>'+String(q.qr_svg||'')+'</div><div><strong>'+esc(q.name)+'</strong><div class="sub">'+esc(q.target_app)+' • '+esc(q.command_id)+' • '+esc(q.action_type)+'</div><div class="sub">'+esc(q.payload)+'</div></div></div>').join('') || '<p class="sub">No QR triggers yet.</p>'; }
    function renderRoadmap(){ roadmapList.innerHTML=(state.roadmap||[]).map(r=>'<div class="stat"><div class="label">'+esc(r.status)+'</div><div class="value" style="font-size:18px">'+esc(r.title)+'</div><p class="sub">'+esc(r.description)+'</p></div>').join(''); }
    function appendLog(text){ activityLog.textContent = new Date().toISOString()+' '+text+'\\n\\n'+activityLog.textContent; }
    function esc(v){ return String(v ?? '').replace(/[&<>"]/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[s])); }
    load().catch(()=>{});
  </script>
</body>
</html>`;
}
