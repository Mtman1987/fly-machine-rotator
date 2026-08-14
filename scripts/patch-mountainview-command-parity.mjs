import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) return;
  await writeFile(path, after);
  console.log(`patched command parity ${path}`);
}

function insertAfter(source, marker, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(marker)) throw new Error(`command parity marker missing: ${label}`);
  return source.replace(marker, `${marker}${addition}`);
}

function insertBefore(source, marker, addition, label) {
  if (source.includes(addition.trim())) return source;
  if (!source.includes(marker)) throw new Error(`command parity marker missing: ${label}`);
  return source.replace(marker, `${addition}${marker}`);
}

await patch('src/mountainView.ts', (source) => {
  const spmtApps = '      ["cmd_spmt_apps", "spmt", "List SpaceMountain apps registered in SPMT", "what apps can i control", "GET", "/api/apps", {}],';
  if (!source.includes('"cmd_companion_obs_scene"')) {
    source = insertAfter(source, spmtApps, `\n      ["cmd_companion_status", "spmt", "Check paired PC Companion status", "is my pc companion connected", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "companion.status", action: "companion.status", payload: {} }],\n      ["cmd_companion_overlay_show", "spmt", "Show Personal overlay on paired PC Companion", "show my personal overlay on the pc", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "overlay.control", action: "overlay.show", payload: {} }],\n      ["cmd_companion_overlay_hide", "spmt", "Hide Personal overlay on paired PC Companion", "hide my personal overlay on the pc", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "overlay.control", action: "overlay.hide", payload: {} }],\n      ["cmd_companion_popout_show", "spmt", "Show a Companion popout", "show companion popout one", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "overlay.control", action: "popout.show", payload: { id: "{{id}}" } }],\n      ["cmd_companion_popout_hide", "spmt", "Hide a Companion popout", "hide companion popout one", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "overlay.control", action: "popout.hide", payload: { id: "{{id}}" } }],\n      ["cmd_companion_obs_scene", "spmt", "Set OBS scene through paired PC Companion", "switch obs to brb", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "obs.control", action: "obs.scene.set", payload: { sceneName: "{{sceneName}}" } }],\n      ["cmd_companion_obs_media", "spmt", "Play approved OBS media through paired PC Companion", "play approved media in obs", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "obs.control", action: "obs.media.play", payload: { mediaName: "{{mediaName}}", obsInputName: "{{obsInputName}}", title: "{{title}}" } }],\n      ["cmd_companion_audio_mute", "spmt", "Mute or unmute Companion audio", "mute the pc companion", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "audio.control", action: "audio.mute", payload: { muted: "{{muted}}" } }],\n      ["cmd_companion_audio_volume", "spmt", "Set Companion audio volume", "set pc companion volume to fifty percent", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "audio.control", action: "audio.volume", payload: { volume: "{{volume}}" } }],\n      ["cmd_companion_media_transcode", "spmt", "Run an approved Companion media transcode", "transcode my approved media file", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "media.write", action: "media.transcode", payload: { inputName: "{{inputName}}", preset: "{{preset}}" } }],\n      ["cmd_companion_workflow", "spmt", "Run an allowlisted Companion workflow", "run companion workflow", "POST", "/api/companion/commands", { deviceId: "{{deviceId}}", capability: "workflow.run", action: "workflow.run", payload: { workflowId: "{{workflowId}}", input: "{{input}}" } }],` , 'companion command catalog');
  }

  const chatLive = '      ["cmd_chat_tag_live_members", "chat-tag", "Ask Chat-Tag who is live", "who is live", "GET", "/api/discord/live-members", {}],';
  if (!source.includes('"cmd_chat_tag_spmt_live"')) {
    source = insertAfter(source, chatLive, `\n      ["cmd_discord_live_members", "chat-tag", "List everyone in the connected Discord community who is live", "who is live", "GET", "/api/discord/live-members", {}],\n      ["cmd_chat_tag_spmt_live", "chat-tag", "List live Chat-Tag players (SPMT live)", "who is active in chat tag", "GET", "/api/tag/live", {}],`, 'live command catalog');
  }

  const listCommandsOld = '    return rows.map((row) => enrichCommandForVoice(normalizeRow(row)));';
  if (source.includes(listCommandsOld)) {
    source = source.replace(listCommandsOld, `    const unsupportedVoiceCommands = new Set([\n      "cmd_hearmeout_voice_room",\n      "cmd_hearmeout_voice_peers",\n      "cmd_hearmeout_watch_request",\n      "cmd_hearmeout_watch_control",\n      "cmd_hearmeout_discord_message",\n    ]);\n    return rows\n      .filter((row) => !unsupportedVoiceCommands.has(String(row.id ?? "")))\n      .map((row) => enrichCommandForVoice(normalizeRow(row)));`);
  }

  const authMethod = '  private async authHeaders(userId: string, serviceId: string, defaults: Record<string, string> = {}): Promise<Record<string, string>> {';
  if (!source.includes('private async resolveCompanionDevice')) {
    source = insertBefore(source, authMethod, `  private async resolveCompanionDevice(userId: string, capability: string, requestedDeviceId = ""): Promise<string> {\n    const token = this.getServiceToken(userId, "spmt");\n    if (!token) throw new HttpError(401, "Reconnect MountainView to SPMT before controlling the PC Companion.");\n    const base = this.serviceBaseUrl("spmt").replace(/\\/$/, "");\n    const response = await fetch(\`${'${base}'}/api/companion/devices\`, {\n      headers: { authorization: \`Bearer ${'${token}'}\`, accept: "application/json" },\n      signal: AbortSignal.timeout(10_000),\n    });\n    const payload = asRecord(await response.json().catch(() => ({})));\n    if (!response.ok) throw new HttpError(response.status, readText(payload, "error") || "Could not read paired Companion devices.");\n    const devices = Array.isArray(payload.devices) ? payload.devices.map(asRecord) : [];\n    const capable = devices.filter((device) => {\n      const raw = device.capabilities;\n      const capabilities = Array.isArray(raw) ? raw.map(String) : String(raw || "").split(",").map((value) => value.trim()).filter(Boolean);\n      return capabilities.includes(capability);\n    });\n    const requested = requestedDeviceId ? capable.find((device) => readText(device, "id") === requestedDeviceId) : undefined;\n    const online = requested || capable.find((device) => /^(online|connected)$/i.test(readText(device, "status")));\n    if (!online || !/^(online|connected)$/i.test(readText(online, "status"))) {\n      throw new HttpError(409, \`No online paired PC Companion currently grants ${'${capability}'}. Open Companion on the PC and verify its SPMT pairing.\`);\n    }\n    return readText(online, "id");\n  }\n\n`, 'Companion device resolver');
  }

  const headerInit = '    const headers: Record<string, string> = { "content-type": "application/json", ...defaults };';
  if (!source.includes('const signedInSpmtToken = this.getServiceToken(userId, "spmt")')) {
    source = insertAfter(source, headerInit, `\n    const signedInSpmtToken = this.getServiceToken(userId, "spmt");\n    if (signedInSpmtToken && (serviceId === "spmt" || serviceId === "hearmeout")) {\n      headers.authorization = \`Bearer ${'${signedInSpmtToken}'}\`;\n      headers["x-spacemountain-source"] = "mountainview-ai";\n    }`, 'SPMT bearer forwarding');
    source = source.replace('    if (serviceId === "spmt") {', '    if (serviceId === "spmt" && !headers.authorization) {');
  }

  const scopedDefaults = '    const next = withCommandDefaults(commandId, scopedPayload);';
  if (source.includes(scopedDefaults) && !source.includes('const companionContracts: Record<string')) {
    source = insertAfter(source, scopedDefaults, `\n    const companionContracts: Record<string, { capability: string; action: string }> = {\n      cmd_companion_status: { capability: "companion.status", action: "companion.status" },\n      cmd_companion_overlay_show: { capability: "overlay.control", action: "overlay.show" },\n      cmd_companion_overlay_hide: { capability: "overlay.control", action: "overlay.hide" },\n      cmd_companion_popout_show: { capability: "overlay.control", action: "popout.show" },\n      cmd_companion_popout_hide: { capability: "overlay.control", action: "popout.hide" },\n      cmd_companion_obs_scene: { capability: "obs.control", action: "obs.scene.set" },\n      cmd_companion_obs_media: { capability: "obs.control", action: "obs.media.play" },\n      cmd_companion_audio_mute: { capability: "audio.control", action: "audio.mute" },\n      cmd_companion_audio_volume: { capability: "audio.control", action: "audio.volume" },\n      cmd_companion_media_transcode: { capability: "media.write", action: "media.transcode" },\n      cmd_companion_workflow: { capability: "workflow.run", action: "workflow.run" },\n    };\n    const companionContract = companionContracts[commandId];\n    if (companionContract) {\n      const deviceId = await this.resolveCompanionDevice(userId, companionContract.capability, readText(next, "deviceId"));\n      return { ...next, deviceId, capability: companionContract.capability, action: companionContract.action };\n    }`, 'Companion payload preparation');
  }

  const profileMarker = 'function getCommandRoutingProfile(commandId: string, appId: string): CommandRoutingProfile {\n';
  if (source.includes(profileMarker) && !source.includes('commandId.startsWith("cmd_companion_")')) {
    source = insertAfter(source, profileMarker, `  if (commandId.startsWith("cmd_companion_")) {\n    if (commandId === "cmd_companion_obs_scene") return profile(["sceneName"], ["deviceId"], "low", false, "ready", ["switch OBS to BRB", "go to the gameplay scene", "change scene to Starting Soon"]);\n    if (commandId === "cmd_companion_obs_media") return profile(["mediaName", "obsInputName"], ["title", "deviceId"], "medium", true, "ready", ["play the approved intro clip in OBS"]);\n    if (commandId === "cmd_companion_audio_mute") return profile(["muted"], ["deviceId"], "low", false, "ready", ["mute the PC companion", "unmute the companion"]);\n    if (commandId === "cmd_companion_audio_volume") return profile(["volume"], ["deviceId"], "low", false, "ready", ["set PC companion volume to 50 percent"]);\n    if (commandId === "cmd_companion_popout_show" || commandId === "cmd_companion_popout_hide") return profile(["id"], ["deviceId"], "low", false, "ready", ["show companion popout one", "hide companion popout two"]);\n    if (commandId === "cmd_companion_media_transcode") return profile(["inputName", "preset"], ["deviceId"], "medium", false, "ready", ["transcode my approved clip to mp4 web"]);\n    if (commandId === "cmd_companion_workflow") return profile(["workflowId"], ["input", "deviceId"], "medium", true, "ready", ["run the companion test echo workflow"]);\n    return profile([], ["deviceId"], "low", false, "ready", ["is my PC companion online", "show my personal overlay on the PC"]);\n  }\n`, 'Companion routing profiles');
  }

  const tagBranch = '    if (/\\b(chat[-\\s]?tag|battle\\s?arena|quackverse|booster\\s+pack|pack|currently\\s+it|who\'?s\\s+it|what\'?s\\s+my\\s+rank|rank|who is live|who\'?s live|partners?\\s+live|crew\\s+group|join chat tag|tag\\s+(?:player|game))\\b/.test(lower)) {';
  if (source.includes(tagBranch) && !source.includes('Explicit PC Companion / OBS intents')) {
    source = insertBefore(source, tagBranch, `    // Explicit PC Companion / OBS intents win before fuzzy catalog or AI routing.\n    const obsSceneMatch = transcript.match(/\\b(?:switch|change|set|go)(?:\\s+obs)?(?:\\s+(?:scene))?(?:\\s+to)?\\s+(.+)$/i);\n    const commonObsScene = /\\b(brb|gameplay|starting soon|ending|intermission|just chatting)\\b/i.test(lower);\n    if (obsSceneMatch && (/\\bobs\\b|\\bscene\\b/i.test(lower) || commonObsScene)) {\n      const sceneName = String(obsSceneMatch[1] || "").replace(/\\bscene\\b$/i, "").trim();\n      if (sceneName) return voiceDecision({ mode: "action", commandId: "cmd_companion_obs_scene", appId: "spmt", transcript, confidence: 0.99, reason: "Explicit OBS scene language maps only to the paired PC Companion.", payload: { sceneName } });\n    }\n    if (/\\b(?:is|check|show|tell me).*(?:pc |desktop )?companion.*(?:online|connected|status)|\\bcompanion status\\b/i.test(lower)) {\n      return voiceDecision({ mode: "action", commandId: "cmd_companion_status", appId: "spmt", transcript, confidence: 0.99, reason: "Explicit Companion status request.", payload: {} });\n    }\n    if (/\\b(?:show|hide).*(?:personal )?overlay.*(?:pc|companion)|(?:pc|companion).*(?:show|hide).*(?:personal )?overlay\\b/i.test(lower)) {\n      const show = /\\bshow\\b/i.test(lower) && !/\\bhide\\b/i.test(lower);\n      return voiceDecision({ mode: "action", commandId: show ? "cmd_companion_overlay_show" : "cmd_companion_overlay_hide", appId: "spmt", transcript, confidence: 0.99, reason: "Explicit PC Companion overlay control.", payload: {} });\n    }\n    if (/\\b(?:mute|unmute).*(?:pc|desktop|companion)|(?:pc|desktop|companion).*(?:mute|unmute)\\b/i.test(lower)) {\n      return voiceDecision({ mode: "action", commandId: "cmd_companion_audio_mute", appId: "spmt", transcript, confidence: 0.99, reason: "Explicit Companion audio mute control.", payload: { muted: !/\\bunmute\\b/i.test(lower) } });\n    }\n    const companionVolumeMatch = lower.match(/\\b(?:pc|desktop|companion)(?:\\s+audio)?\\s+volume(?:\\s+to)?\\s+(\\d{1,3})\\s*%?/i) || lower.match(/\\bvolume(?:\\s+on)?\\s+(?:the\\s+)?(?:pc|desktop|companion)(?:\\s+to)?\\s+(\\d{1,3})\\s*%?/i);\n    if (companionVolumeMatch) {\n      const percent = Math.max(0, Math.min(100, Number(companionVolumeMatch[1])));\n      return voiceDecision({ mode: "action", commandId: "cmd_companion_audio_volume", appId: "spmt", transcript, confidence: 0.99, reason: "Explicit Companion volume control.", payload: { volume: percent / 100 } });\n    }\n\n    // "Who's live" means the whole connected Discord/community list unless Chat Tag is named.\n    if (!/\\b(?:chat[-\\s]?tag|chattag|spmt)\\b/i.test(lower) && /\\b(?:who(?: is|'s)? live|who is streaming|who(?: is|'s)? streaming|which (?:people|members|streamers) are live)\\b/i.test(lower)) {\n      return voiceDecision({ mode: "action", commandId: "cmd_discord_live_members", appId: "chat-tag", transcript, confidence: 0.99, reason: "Generic live-status questions mean everyone in the connected Discord/community roster.", payload: {} });\n    }\n\n    // Chat Tag-specific live/active language is the SPMT live game command semantics.\n    if (/\\bspmt\\s+live\\b/i.test(lower) || (/\\b(?:chat[-\\s]?tag|chattag)\\b/i.test(lower) && /\\b(?:live|active|streaming)\\b/i.test(lower))) {\n      return voiceDecision({ mode: "action", commandId: "cmd_chat_tag_spmt_live", appId: "chat-tag", transcript, confidence: 0.99, reason: "Chat Tag live/active language maps to SPMT live players only.", payload: {} });\n    }\n\n`, 'explicit natural-language routes');
  }

  source = source.replace('                : "cmd_chat_tag_live_members";', '                : /\\b(?:live|active|streaming)\\b/.test(lower) ? "cmd_chat_tag_spmt_live" : "cmd_chat_tag_state";');
  source = source.replace('    confidence: 0.91,\n    reason: "Natural media request language maps to a concrete HearMeOut queue request."', '    confidence: 0.99,\n    reason: "Concrete natural media request language maps deterministically to the HearMeOut queue."');
  source = source.replace('  if (commandId === "cmd_chat_tag_live_members") {', '  if (commandId === "cmd_chat_tag_live_members" || commandId === "cmd_discord_live_members") {');

  const enrichMarker = 'function enrichCommandResponse(commandId: string, response: unknown): unknown {\n';
  if (source.includes(enrichMarker) && !source.includes('commandId === "cmd_chat_tag_spmt_live"')) {
    source = insertAfter(source, enrichMarker, `  if (commandId === "cmd_chat_tag_spmt_live") {\n    const record = asRecord(response);\n    const players = Array.isArray(record.livePlayers) ? record.livePlayers.map(asRecord) : [];\n    const names = players.map((player) => readText(player, "displayName") || readText(player, "twitchUsername")).filter(Boolean);\n    return { ...record, response: names.length ? \`Chat Tag live now (${ '${names.length}' }): ${ '${names.join(", ")}' }\` : "No Chat Tag players are live right now." };\n  }\n`, 'Chat Tag live response');
  }

  // The current HearMeOut app has music session APIs after the compatibility bridge, but no peer-voice/watch API contract yet.
  source = source.replace('/\\b(song|audiobook|audio book|movie|watch party|queue|request|play)\\b/.test(lower) && /\\b(hearmeout|hear me out|song|audiobook|audio book|movie|watch party)\\b/.test(lower)', '/\\b(song|audiobook|audio book|music|track|queue|request|play)\\b/.test(lower) && /\\b(hearmeout|hear me out|song|audiobook|audio book|music|track)\\b/.test(lower)');

  return source;
});

await patch('mobile/App.tsx', (source) => {
  const wakeState = '  const [wakeListenerActive, setWakeListenerActive] = useState(false);';
  if (source.includes(wakeState) && !source.includes('const [wakeName, setWakeName]')) {
    source = insertAfter(source, wakeState, '\n  const [wakeName, setWakeName] = useState("Athena");', 'wake name state');
  }
  const wakeRef = '  const wakeListenerActiveRef = useRef(false);';
  if (source.includes(wakeRef) && !source.includes('const wakeNameRef = useRef')) {
    source = insertAfter(source, wakeRef, '\n  const wakeNameRef = useRef("Athena");', 'wake name ref');
  }
  const wakeEffect = '  useEffect(() => {\n    wakeListenerActiveRef.current = wakeListenerActive;\n  }, [wakeListenerActive]);';
  if (source.includes(wakeEffect) && !source.includes('mountainview_wake_name')) {
    source = insertAfter(source, wakeEffect, `\n\n  useEffect(() => {\n    wakeNameRef.current = wakeName.trim() || "Athena";\n    void SecureStore.setItemAsync("mountainview_wake_name", wakeNameRef.current);\n  }, [wakeName]);\n\n  useEffect(() => {\n    SecureStore.getItemAsync("mountainview_wake_name").then((stored) => {\n      if (stored?.trim()) {\n        wakeNameRef.current = stored.trim();\n        setWakeName(stored.trim());\n      }\n    }).catch(() => undefined);\n  }, []);`, 'wake name persistence');
  }

  const wakeFunction = `  function wakeCommandFromTranscript(transcript: string) {\n    const normalized = transcript.trim();\n    const match = normalized.match(/\\b(?:hey\\s+)?(?:athena|annie)\\b[:,]?\\s*(.*)$/i);\n    if (!match) return "";\n    return match[1]?.trim() || normalized;\n  }`;
  if (source.includes(wakeFunction)) {
    source = source.replace(wakeFunction, `  function wakeCommandFromTranscript(transcript: string) {\n    const normalized = transcript.trim();\n    const aliases = ["athena", "annie", wakeNameRef.current].map((value) => value.trim().toLowerCase()).filter(Boolean);\n    const uniqueAliases = [...new Set(aliases)].map((value) => value.replace(/[.*+?^${'${'}'}()|[\\]\\\\]/g, "\\\\$&"));\n    const match = normalized.match(new RegExp("\\\\b(?:hey\\\\s+)?(?:" + uniqueAliases.join("|") + ")\\\\b[:,]?\\\\s*(.*)$", "i"));\n    if (!match) return "";\n    return match[1]?.trim() || normalized;\n  }`);
  }

  source = source.replace('    setStatusMessage("Hey Athena listener active. Keep MountainView open.");', '    setStatusMessage(`Hey ${wakeNameRef.current} listener active. Keep SpaceMountain Companion open.`);');
  source = source.replace('    setLog("Hey Athena listener active. Say: Hey Athena, followed by your command.");', '    setLog(`Wake listener active. Say: Hey Athena or Hey ${wakeNameRef.current}, followed by your command.`);');
  source = source.replace('            setStatusMessage(`Listening for Hey Athena. Heard: ${transcript}`);', '            setStatusMessage(`Listening for Hey Athena / Hey ${wakeNameRef.current}. Heard: ${transcript}`);');

  const wakeUi = '                <Text style={styles.note}>Keep these controls for testing Android wake permissions, media-button interception, and the older continuous listener while the BLE button map gets filled in.</Text>';
  if (source.includes(wakeUi) && !source.includes('Wake name / bot name')) {
    source = insertAfter(source, wakeUi, `\n                <Text style={styles.label}>Wake name / bot name</Text>\n                <TextInput value={wakeName} onChangeText={setWakeName} autoCapitalize="words" placeholder="Athena" placeholderTextColor="#64748b" style={styles.input} />\n                <Text style={styles.note}>While this listener is active in the foreground, both “Hey Athena” and “Hey {wakeName || "Athena"}” are accepted.</Text>`, 'wake name UI');
  }
  return source;
});
