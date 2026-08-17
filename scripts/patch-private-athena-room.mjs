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
  const routeMarker = `  if (method === "POST" && apiPath === "/api/voice/route") {
    const user = context.requireAuth(request);
    const body = await readJson(request);
    return json(response, await context.routeVoiceCommand(user.id, body));
  }
`;
  const routeReplacement = `${routeMarker}
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
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: "mountainview",
        client_secret: clientSecret
      })
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new HttpError(401, "MountainView SPMT refresh failed: " + (readText(payload, "error") || response.status));
    }
    const accessToken = readText(payload, "access_token") || readText(payload, "token");
    const nextRefreshToken = readText(payload, "refresh_token") || refreshToken;
    if (!accessToken) throw new HttpError(502, "SPMT refresh returned no access token.");
    this.saveServiceToken(userId, "spmt", accessToken);
    if (nextRefreshToken) this.saveServiceToken(userId, "spmt-refresh", nextRefreshToken);
    return accessToken;
  }

  private async createHearMeOutLaunchCode(userId: string): Promise<string> {
    const spmtBase = this.serviceBaseUrl("spmt").replace(/\\/$/, "");
    const hearMeOutOrigin = new URL(this.serviceBaseUrl("hearmeout")).origin;
    let accessToken = this.getServiceToken(userId, "spmt");
    if (!accessToken) {
      throw new HttpError(401, "MountainView does not have an SPMT session for this user. Sign in with SPMT again.");
    }
    const launch = (token: string) => fetch(spmtBase + "/api/embed/launch", {
      method: "POST",
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json"
      },
      body: JSON.stringify({ client_id: "hearmeout", target_origin: hearMeOutOrigin })
    });
    let response = await launch(accessToken);
    if (response.status === 401) {
      accessToken = await this.refreshMountainViewSpmtAccessToken(userId);
      response = await launch(accessToken);
    }
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok) {
      throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, "SPMT HearMeOut launch failed: " + (readText(payload, "error") || response.status));
    }
    const code = readText(payload, "code");
    if (!code) throw new HttpError(502, "SPMT HearMeOut launch returned no one-time code.");
    return code;
  }

  async runPrivateAssistant(userId: string, input: JsonRecord): Promise<JsonRecord> {
    const action = String(input.action || "ensure").trim().toLowerCase();
    const text = String(input.text || input.command || input.transcript || "").trim();
    if (action !== "ensure" && action !== "utterance") {
      throw new HttpError(400, "Private assistant action must be ensure or utterance.");
    }
    if (action === "utterance" && !text) throw new HttpError(400, "Private assistant utterance text is required.");

    const launchCode = await this.createHearMeOutLaunchCode(userId);
    const hearMeOutBase = this.serviceBaseUrl("hearmeout").replace(/\\/$/, "");
    const response = await fetch(hearMeOutBase + "/api/private-assistant", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ launchCode, action, text })
    });
    const payload = asRecord(await response.json().catch(() => ({})));
    if (!response.ok || payload.ok === false) {
      const message = readText(payload, "error") || "HearMeOut private assistant returned HTTP " + response.status;
      throw new HttpError(response.status >= 400 && response.status < 500 ? response.status : 502, message);
    }
    this.logCommand(
      userId,
      action === "ensure" ? "private-athena-room-ensure" : "private-athena-room-utterance",
      "hearmeout",
      "POST",
      hearMeOutBase + "/api/private-assistant",
      "success",
      response.status,
      0,
      JSON.stringify({ status: payload.status, roomId: payload.roomId, persona: payload.persona }).slice(0, 2000),
      ""
    );
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
      appendActivityLog("voice", "Athena private room", "ready", {
        reason,
        roomId: data.roomId,
        persona: data.persona,
        persistent: data.persistent,
        private: data.private
      });
      return data;
    } catch (error) {
      reportSoftError("Athena private room", error);
      return null;
    }
  }

  async function runPrivateAssistantUtterance(message: string, speakReply = true) {
    const data = await request("/private-assistant", {
      method: "POST",
      body: JSON.stringify({ action: "utterance", text: message })
    });
    const reply = String(data.reply ?? data.response?.response ?? data.response?.reply ?? data.response?.message ?? "").trim();
    setLog(JSON.stringify(data, null, 2));
    setPreviewFromResult("Athena private room", data);
    appendActivityLog("voice", "Athena private room", "response", {
      roomId: data.roomId,
      persona: data.persona,
      speech: data.speech,
      reply
    });
    setStatusMessage(reply || "Athena private room is ready.");
    if (speakReply && reply) await speakText(reply);
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
