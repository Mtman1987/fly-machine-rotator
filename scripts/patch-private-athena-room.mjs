import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.log(`private Athena room already patched: ${path}`);
    return;
  }
  await writeFile(path, after);
  console.log(`patched private Athena room: ${path}`);
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`private Athena room patch marker missing: ${label}`);
  return source.replace(from, to);
}

await patch('src/mountainView.ts', (source) => {
  if (!source.includes('from "./privateAssistant.js"')) source = 'import { callPrivateAssistant, withSpmtSession, proxyPrivateMedia } from "./privateAssistant.js";\n' + source;
  const routeMarker = `  if (method === "POST" && apiPath === "/api/voice/route") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, await context.routeVoiceCommand(user.id, body));
  }
`;
  const routeReplacement = `${routeMarker}
  if (method === "GET" && apiPath.startsWith("/api/private-assistant/media/")) {
    const user = context.requireAuth(request);
    await context.streamPrivateMedia(user.id, request, response, url);
    return true;
  }

  if (method === "POST" && apiPath === "/api/private-assistant") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, await context.runPrivateAssistant(user.id, body));
  }
`;
  if (!source.includes('apiPath === "/api/private-assistant"')) {
    source = replaceRequired(source, routeMarker, routeReplacement, 'private assistant API route');
  }

  const accessTokenMarker = `    const accessToken = readText(payload, "access_token") || readText(payload, "token");
    if (accessToken) this.saveServiceToken(id, "spmt", accessToken);
    return localSession;`;
  const accessTokenReplacement = `    const accessToken = readText(payload, "access_token") || readText(payload, "token");
    const refreshToken = readText(payload, "refresh_token");
    if (accessToken) this.saveServiceToken(id, "spmt", accessToken);
    if (refreshToken) this.saveServiceToken(id, "spmt-refresh", refreshToken);
    return localSession;`;
  if (!source.includes('this.saveServiceToken(id, "spmt-refresh", refreshToken)')) {
    source = replaceRequired(source, accessTokenMarker, accessTokenReplacement, 'MountainView SPMT refresh token storage');
  }

  const methodMarker = `  async athenaChatCompletion(user: MountainViewUser, body: JsonRecord, env: NodeJS.ProcessEnv): Promise<JsonRecord> {`;
  if (!source.includes('async runPrivateAssistant(userId: string')) {
    const methods = `  private async refreshMountainViewSpmtAccessToken(userId: string): Promise<string> {
    const refreshToken = this.getServiceToken(userId, "spmt-refresh");
    const clientSecret = String(this.env.MOUNTAINVIEW_CLIENT_SECRET || "").trim();
    if (!refreshToken || !clientSecret) {
      throw new HttpError(401, "MountainView SPMT session needs to be renewed. Sign in with SPMT again.");
    }
    const response = await fetch(new URL("/api/oauth/token", this.serviceBaseUrl("spmt")), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "mountainview",
        client_secret: clientSecret
      })
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new HttpError(response.status === 400 || response.status === 401 ? 401 : 503, "MountainView SPMT refresh failed: " + (readText(payload, "error") || response.status));
    }
    const accessToken = readText(payload, "access_token") || readText(payload, "token");
    const nextRefreshToken = readText(payload, "refresh_token") || refreshToken;
    if (!accessToken) throw new HttpError(502, "SPMT refresh returned no access token.");
    this.saveServiceToken(userId, "spmt", accessToken);
    if (nextRefreshToken) this.saveServiceToken(userId, "spmt-refresh", nextRefreshToken);
    return accessToken;
  }

  private async privateAssistantFetch(userId: string, service: "streamweaver" | "hearmeout", path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.getServiceToken(userId, "spmt")) throw new HttpError(401, "Sign in with SPMT to restore your session.");
    return withSpmtSession({
      userId,
      getToken: () => this.getServiceToken(userId, "spmt"),
      refresh: () => this.refreshMountainViewSpmtAccessToken(userId),
      send: (token) => fetch(new URL(path, this.serviceBaseUrl(service)), {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init.headers).entries()), authorization: "Bearer " + token },
      }),
    });
  }

  async streamPrivateMedia(userId: string, request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    await proxyPrivateMedia(request, response, url, (service, path, init) => this.privateAssistantFetch(userId, service, path, init));
  }

  async runPrivateAssistant(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const payload = await callPrivateAssistant(input, (service, path, init) => this.privateAssistantFetch(userId, service, path, init));
    const status = Number(payload.upstreamStatus || 200);
    if (status >= 400 || payload.ok === false) throw new HttpError(status >= 400 ? status : 502, String(payload.error || "Athena is temporarily unavailable."));
    return payload;
  }

`;
    source = replaceRequired(source, methodMarker, `${methods}${methodMarker}`, 'private assistant context methods');
  }

  return source;
});

await patch('mobile/App.tsx', (source) => {
  const tokenEffect = `  useEffect(() => {
    tokenRef.current = token;
  }, [token]);`;
  const tokenEffectReplacement = `  useEffect(() => {
    tokenRef.current = token;
    if (token) void ensurePrivateAssistant("authenticated-session");
  }, [token]);`;
  if (!source.includes('ensurePrivateAssistant("authenticated-session")')) {
    source = replaceRequired(source, tokenEffect, tokenEffectReplacement, 'authenticated assistant ensure');
  }

  const replyMarker = `  function commandReplyText(data: Record<string, any>) {
    const reply = data.response?.response ?? data.response?.message ?? data.response?.reply ?? data.response;
    return typeof reply === "string" && reply.trim() ? reply.trim() : "";
  }
`;
  if (!source.includes('async function ensurePrivateAssistant(reason: string)')) {
    const helper = `${replyMarker}
  async function ensurePrivateAssistant(reason: string) {
    const authToken = tokenRef.current;
    if (!authToken) return null;
    try {
      const data = await request("/private-assistant", {
        method: "POST",
        body: JSON.stringify({ action: "ensure", reason })
      }, authToken);
      appendActivityLog("voice", "Athena private chat", "ready", {
        reason,
        roomId: data.roomId,
        persona: data.persona,
        persistent: data.persistent,
        private: data.private
      });
      return data;
    } catch (error) {
      reportSoftError("Athena private chat", error);
      return null;
    }
  }

  async function runPrivateAssistantUtterance(message: string, speakReply = true) {
    message = String(message || "").trim();
    if (!message) {
      setStatusMessage("Say or type a message for Athena first.");
      return { ok: false, status: "empty-input" };
    }
    const data = await request("/private-assistant", {
      method: "POST",
      body: JSON.stringify({ action: "utterance", text: message, speak: speakReply, requestId: \`companion-\${Date.now()}-\${Math.random().toString(36).slice(2)}\` })
    });
    const reply = String(data.reply ?? data.response?.response ?? data.response?.reply ?? data.response?.message ?? "").trim();
    setLog(JSON.stringify(withoutAudio(data), null, 2));
    setPreviewFromResult("Athena private chat", withoutAudio(data));
    appendActivityLog("voice", "Athena private chat", "response", {
      roomId: data.roomId,
      persona: data.persona,
      speech: data.speech,
      reply
    });
    setStatusMessage(reply || "Athena is ready.");
    if (data.media) void localAudio().applySession(data.media).catch((error) => reportError("Music playback", error));
    if (speakReply && reply) await speakText(reply, data.tts);
    return data;
  }
`;
    source = replaceRequired(source, replyMarker, helper, 'mobile private assistant helpers');
  }

  const outboundMarker = `      const outboundMessage = intent.intent === "direct-message" ? intent.cleanedText : message;
      if (shouldUseParsedIntent && intent.commandId === "local_flashlight") {`;
  const outboundReplacement = `      const outboundMessage = intent.intent === "direct-message" ? intent.cleanedText : message;
      if (commandId === "cmd_streamweaver_voice_commander" && destination === "ai" && !options.commandMode) {
        return await runPrivateAssistantUtterance(outboundMessage, options.speakReply ?? true);
      }
      if (shouldUseParsedIntent && intent.commandId === "local_flashlight") {`;
  if (!source.includes('return await runPrivateAssistantUtterance(outboundMessage')) {
    source = replaceRequired(source, outboundMarker, outboundReplacement, 'Athena conversation routing');
  }

  const armedMarker = `      setBleAutoConnectState("Bluetooth controls armed");
      setStatusMessage("Bluetooth controls armed. Headset/media button events are subscribed.");
      setLog(JSON.stringify({ reason, connect, services, notifications }, null, 2));
      appendActivityLog("ble", "Bluetooth controls armed", "armed", { reason, address, connect, services, notifications });
      await trackMobileEvent("ble-auto-arm", { reason, address, connect, services, notifications }, "armed");
      return true;`;
  const armedReplacement = `      setBleAutoConnectState("Bluetooth controls armed");
      setStatusMessage("Bluetooth controls armed. Headset/media button events are subscribed.");
      setLog(JSON.stringify({ reason, connect, services, notifications }, null, 2));
      appendActivityLog("ble", "Bluetooth controls armed", "armed", { reason, address, connect, services, notifications });
      await trackMobileEvent("ble-auto-arm", { reason, address, connect, services, notifications }, "armed");
      if (tokenRef.current) await ensurePrivateAssistant(\`glasses-\${reason}\`);
      return true;`;
  if (!source.includes('ensurePrivateAssistant(`glasses-${reason}`)')) {
    source = replaceRequired(source, armedMarker, armedReplacement, 'glasses reconnect assistant ensure');
  }

  return source;
});
