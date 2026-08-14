import { readFile, writeFile } from 'node:fs/promises';

const SUITE_BACKGROUND_STYLE = `<style id="spmt-suite-background">
html[data-spmt-theme="solar-flare"]{--spmt-suite-bg-image:url("https://spacemountain.live/assets/theme-solar-flare-background.webp")}
html[data-spmt-theme="nebula-purple"]{--spmt-suite-bg-image:url("https://spacemountain.live/assets/theme-nebula-purple-background.webp")}
html[data-spmt-theme="oceanic-blue"]{--spmt-suite-bg-image:url("https://spacemountain.live/assets/theme-oceanic-blue-background.webp")}
html[data-spmt-theme="aurora-green"]{--spmt-suite-bg-image:url("https://spacemountain.live/assets/theme-aurora-green-background.webp")}
body.spmt-host-shell:before{content:"";position:fixed;inset:-3%;z-index:-3;pointer-events:none;background-image:linear-gradient(180deg,rgba(2,6,18,.28),rgba(2,6,18,.72)),var(--spmt-suite-bg-image);background-size:cover;background-position:center;background-repeat:no-repeat;transform:scale(1.035)}
body.spmt-host-shell:after{background:radial-gradient(circle at 10% 0%,rgba(var(--spmt-accent-rgb),calc(.25 * var(--spmt-nebula))),transparent 36rem),radial-gradient(circle at 92% 86%,rgba(var(--spmt-accent-rgb),calc(.12 * var(--spmt-nebula))),transparent 34rem)!important}
</style>`;

async function patch(path, transform) {
  let before;
  try {
    before = await readFile(path, 'utf8');
  } catch (error) {
    if (path === 'mobile/App.tsx' && error?.code === 'ENOENT') {
      console.log('skipped optional mobile/App.tsx workspace parity patch');
      return;
    }
    throw error;
  }
  const after = transform(before);
  if (after === before) return;
  await writeFile(path, after);
  console.log(`patched ${path}`);
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`workspace parity patch marker missing: ${label}`);
  return source.replace(from, to);
}

function ensureSharedUiImport(source) {
  const importLine = 'import { spmtSharedUiHead, spmtSharedUiScript } from "./spmtSharedUi.js";';
  return source.includes(importLine) ? source : `${importLine}\n${source}`;
}

function installSuiteBackground(source) {
  if (source.includes('id="spmt-suite-background"')) return source;
  if (!source.includes('</head>')) return source;
  return source.replace('</head>', `${SUITE_BACKGROUND_STYLE}</head>`);
}

function installSharedUi(source, appId, profileEndpoint = '/athena/api/settings') {
  source = ensureSharedUiImport(source);
  const headCall = '${spmtSharedUiHead("' + appId + '")}';
  const scriptCall = '${spmtSharedUiScript("' + appId + '", "' + profileEndpoint + '")}';
  if (source.includes('</head>') && !source.includes(headCall)) source = source.replace('</head>', `${headCall}</head>`);
  source = installSuiteBackground(source);
  if (source.includes('</body>') && !source.includes(scriptCall)) source = source.replace('</body>', `${scriptCall}</body>`);
  return source;
}

function installSharedUiInFunction(source, functionMarker, appId, profileEndpoint) {
  source = ensureSharedUiImport(source);
  const start = source.indexOf(functionMarker);
  if (start < 0) throw new Error(`workspace parity patch marker missing: ${functionMarker}`);
  const before = source.slice(0, start);
  let section = source.slice(start);
  const headCall = '${spmtSharedUiHead("' + appId + '")}';
  const scriptCall = '${spmtSharedUiScript("' + appId + '", "' + profileEndpoint + '")}';
  if (!section.includes(headCall)) section = replaceRequired(section, '</head>', `${headCall}</head>`, `${appId} head`);
  section = installSuiteBackground(section);
  if (!section.includes(scriptCall)) section = replaceRequired(section, '</body>', `${scriptCall}</body>`, `${appId} body`);
  return before + section;
}

await patch('src/athenaSpmtGateway.ts', (source) => {
  source = source.replace('import { hasMountainViewAdminSession } from "./mountainView.js";', 'import { requireSpmtAdmin } from "./spmtAuth.js";');
  source = source.replaceAll('await hasMountainViewAdminSession(request, env)', 'await requireSpmtAdmin(request, env)');
  source = source.replace('location: `/mountainview/auth/login?next=${next}`', 'location: `/auth/spmt/login?next=${next}`');
  return source;
});

await patch('src/athenaCoderUi.ts', (source) => {
  source = source.replace('import { hasMountainViewAdminSession } from "./mountainView.js";', 'import { requireSpmtAdmin } from "./spmtAuth.js";');
  source = source.replaceAll('await hasMountainViewAdminSession(request, env)', 'await requireSpmtAdmin(request, env)');
  source = source.replace('location: `/mountainview/auth/login?next=${next}`', 'location: `/auth/spmt/login?next=${next}`');
  return installSharedUi(source, 'athena-coder');
});

await patch('src/athenaRepairUi.ts', (source) => installSharedUi(source, 'athena-repair'));
await patch('src/athenaChat.ts', (source) => installSharedUi(source, 'athena-llm'));
await patch('src/streamweaverAdminUi.ts', (source) => installSharedUi(source, 'streamweaver-ops'));

await patch('src/dashboardServer.ts', (source) => source.replaceAll('/mountainview/auth/login?next=', '/auth/spmt/login?next='));

await patch('src/mountainView.ts', (source) => {
  const oldExchange = '    const isAdmin = spmtUser.isAdmin === true || spmtUser.is_admin === true;\n    return this.createSession({ id, email, role: isAdmin ? "admin" : "user" });';
  const newExchange = '    const isAdmin = spmtUser.isAdmin === true || spmtUser.is_admin === true;\n    const localSession = this.createSession({ id, email, role: isAdmin ? "admin" : "user" });\n    const accessToken = readText(payload, "access_token") || readText(payload, "token");\n    if (accessToken) this.saveServiceToken(id, "spmt", accessToken);\n    return localSession;';
  if (source.includes(oldExchange)) source = source.replace(oldExchange, newExchange);

  const bootstrapMarker = '      user,\n      config: context.publicConfig(),';
  if (source.includes(bootstrapMarker) && !source.includes('workspace: await context.loadWorkspace')) {
    source = source.replace(bootstrapMarker, '      user,\n      workspace: await context.loadWorkspace(user.id),\n      config: context.publicConfig(),');
  }

  const tokenMethod = '  private getServiceToken(userId: string, serviceId: string): string {\n    const row = this.db.prepare("SELECT encrypted_token FROM service_tokens WHERE user_id = ? AND service_id = ?").get(userId, serviceId) as { encrypted_token: string } | undefined;\n    return row ? this.decrypt(row.encrypted_token) : "";\n  }';
  if (source.includes(tokenMethod) && !source.includes('async loadWorkspace(userId: string)')) {
    const workspaceMethod = `${tokenMethod}\n\n  async loadWorkspace(userId: string): Promise<JsonRecord | null> {\n    const accessToken = this.getServiceToken(userId, "spmt");\n    if (!accessToken) return null;\n    const base = this.serviceBaseUrl("spmt").replace(/\\/$/, "");\n    const headers = { authorization: \`Bearer \${accessToken}\`, accept: "application/json" };\n    try {\n      const [profileResponse, surfacesResponse, personalResponse, sceneResponse] = await Promise.all([\n        fetch(\`\${base}/api/workspace-profile\`, { headers, signal: AbortSignal.timeout(10_000) }),\n        fetch(\`\${base}/api/platform/surfaces\`, { headers, signal: AbortSignal.timeout(10_000) }),\n        fetch(\`\${base}/api/personal-overlay-launch\`, { headers, signal: AbortSignal.timeout(10_000) }),\n        fetch(\`\${base}/api/tenant-scene?output=personal\`, { headers, signal: AbortSignal.timeout(10_000) }),\n      ]);\n      if (!profileResponse.ok) return null;\n      const profile = asRecord(await profileResponse.json().catch(() => ({})));\n      const surfacePayload = await surfacesResponse.json().catch(() => ([]));\n      const surfaces = Array.isArray(surfacePayload) ? surfacePayload : Array.isArray(asRecord(surfacePayload).surfaces) ? asRecord(surfacePayload).surfaces as unknown[] : [];\n      const personal = personalResponse.ok ? asRecord(await personalResponse.json().catch(() => ({}))) : {};\n      const scene = sceneResponse.ok ? asRecord(await sceneResponse.json().catch(() => ({}))) : {};\n      const tenant = String(scene.tenant || personal.tenant || "").trim().toLowerCase();\n      const outputs = asRecord(scene.urls);\n      const buildSurfaceUrl = (id: string, mode: string) => {\n        const item = surfaces.find((entry) => String(asRecord(entry).id || "") === id);\n        const record = asRecord(item);\n        const raw = String(record.url || record.path || "").trim();\n        if (!raw) return "";\n        try {\n          const target = new URL(raw, base);\n          target.searchParams.set("mode", mode);\n          target.searchParams.set("app", "mountainview-mobile");\n          if (id === "overlays") target.searchParams.set("output", "personal");\n          return target.toString();\n        } catch {\n          return "";\n        }\n      };\n      return {\n        tenant,\n        profile: profile.profile ?? null,\n        outputs,\n        personalLayout: scene.layout ?? null,\n        canonical: {\n          origin: base,\n          surfaces,\n          surfaceUrls: {\n            worktray: buildSurfaceUrl("worktray", "full"),\n            overlays: buildSurfaceUrl("overlays", "full"),\n            settings: buildSurfaceUrl("settings", "full"),\n          },\n          personalOverlayUrl: String(personal.url || outputs.personal || ""),\n        },\n      };\n    } catch {\n      return null;\n    }\n  }`;
    source = source.replace(tokenMethod, workspaceMethod);
  }

  const routeContextMarker = '    const context = asRecord(input.context);\n    const heuristicDecision = this.decideVoiceRoute(userId, transcript, context);';
  if (source.includes(routeContextMarker) && !source.includes('const workspaceIdentity = await this.loadWorkspace(userId);')) {
    source = source.replace(routeContextMarker, '    let context = asRecord(input.context);\n    const workspaceIdentity = await this.loadWorkspace(userId);\n    const scopedTenant = readText(asRecord(workspaceIdentity), "tenant");\n    if (scopedTenant) {\n      context = {\n        ...context,\n        tenantId: readText(context, "tenantId") || scopedTenant,\n        username: readText(context, "username") || scopedTenant,\n        twitchUsername: readText(context, "twitchUsername") || scopedTenant,\n        channel: readText(context, "channel") || scopedTenant,\n      };\n    }\n    const heuristicDecision = this.decideVoiceRoute(userId, transcript, context);');
  }

  const prepareMarker = '  private async prepareCommandPayload(userId: string, commandId: string, payload: JsonRecord): Promise<JsonRecord> {\n    const next = withCommandDefaults(commandId, payload);';
  if (source.includes(prepareMarker) && !source.includes('const commandWorkspace = await this.loadWorkspace(userId);')) {
    source = source.replace(prepareMarker, '  private async prepareCommandPayload(userId: string, commandId: string, payload: JsonRecord): Promise<JsonRecord> {\n    const commandWorkspace = await this.loadWorkspace(userId);\n    const scopedTenant = readText(asRecord(commandWorkspace), "tenant");\n    const scopedPayload = scopedTenant ? {\n      ...payload,\n      tenantId: readText(payload, "tenantId") || scopedTenant,\n      username: readText(payload, "username") || scopedTenant,\n      twitchUsername: readText(payload, "twitchUsername") || scopedTenant,\n      channel: readText(payload, "channel") || scopedTenant,\n    } : payload;\n    const next = withCommandDefaults(commandId, scopedPayload);');
  }

  source = source.replace('    const tenantId = readText(context, "tenantId") || DEFAULT_STREAMWEAVER_TENANT_ID;\n    const username = readText(context, "username") || DEFAULT_STREAMWEAVER_USERNAME;', '    const username = readText(context, "username") || readText(context, "tenantId");\n    const tenantId = readText(context, "tenantId") || username;');
  source = source.replace('  const tenantId = readText(payload, "tenantId") || readText(nestedPayload, "tenantId") || DEFAULT_STREAMWEAVER_TENANT_ID;\n  const username = readText(payload, "username") || readText(nestedPayload, "username") || DEFAULT_STREAMWEAVER_USERNAME;', '  const explicitUsername = readText(payload, "username") || readText(nestedPayload, "username");\n  const tenantId = readText(payload, "tenantId") || readText(nestedPayload, "tenantId") || explicitUsername;\n  const username = explicitUsername || tenantId;');
  source = source.replaceAll('userId: DEFAULT_CHAT_TAG_USER_ID', 'userId: readText(context, "userId")');
  source = source.replaceAll('readText(base, "userId") || DEFAULT_CHAT_TAG_USER_ID', 'readText(base, "userId")');
  source = source.replaceAll('readText(base, "streamerId") || DEFAULT_STREAMWEAVER_USERNAME', 'readText(base, "streamerId") || twitchUsername');

  source = source.replace('  const asset = releaseJson.assets?.find((item) => item.name === "app-release.apk");', '  const asset = releaseJson.assets?.find((item) => item.name === "MountainView-Android.apk") || releaseJson.assets?.find((item) => item.name === "app-release.apk");');

  return installSharedUiInFunction(source, 'function renderMountainViewHtml', 'mountainview', '/mountainview/api/bootstrap');
});

await patch('mobile/App.tsx', (source) => {
  source = source.replace('type MainTab = "home" | "targets" | "apps" | "visual" | "logs" | "relay" | "memory" | "stream" | "devices" | "polling" | "logos" | "qr" | "roadmap";', 'type MainTab = "home" | "workspace" | "targets" | "apps" | "visual" | "logs" | "relay" | "memory" | "stream" | "devices" | "polling" | "logos" | "qr" | "roadmap";');

  const stateMarker = '  const [token, setToken] = useState("");';
  if (source.includes(stateMarker) && !source.includes('const [workspace, setWorkspace]')) {
    source = source.replace(stateMarker, `${stateMarker}\n  const [workspace, setWorkspace] = useState<Record<string, any> | null>(null);\n  const [workspaceSurface, setWorkspaceSurface] = useState<"worktray" | "overlays" | "settings">("worktray");\n  const [personalOverlayVisible, setPersonalOverlayVisible] = useState(false);\n  const [personalOpacity, setPersonalOpacity] = useState(100);\n  const [personalHudReady, setPersonalHudReady] = useState(false);\n  const personalWebViewRef = useRef<any>(null);`);
  }

  const connectedMarker = '  const connected = token.length > 0;';
  if (source.includes(connectedMarker) && !source.includes('const workspaceTenant =')) {
    source = source.replace(connectedMarker, `${connectedMarker}\n  const workspaceTenant = String(workspace?.tenant ?? "").trim().toLowerCase();\n  const workspaceSurfaceUrl = String(workspace?.canonical?.surfaceUrls?.[workspaceSurface] ?? "").trim();`);
  }

  const visibleLogMarker = '  const visibleActivityLogs = useMemo(() => {\n    return logFilter === "all" ? activityLogs : activityLogs.filter((item) => item.category === logFilter);\n  }, [activityLogs, logFilter]);';
  if (source.includes(visibleLogMarker) && !source.includes('spmt:mountainview-mobile:')) {
    source = source.replace(visibleLogMarker, `${visibleLogMarker}\n\n  function personalLocalKey(name: string) {\n    return "spmt:mountainview-mobile:" + (workspaceTenant || "unknown") + ":" + name;\n  }\n\n  function applyPersonalOpacityToWebView(value = personalOpacity) {\n    const factor = Math.max(0, Math.min(1, Number(value) / 100));\n    const script = "(function(){var opacity=" + factor + ";document.documentElement.style.setProperty('background','transparent','important');if(document.body){document.body.style.setProperty('background','transparent','important');document.body.style.setProperty('background-color','transparent','important');}var stage=document.getElementById('stage-wrap');if(stage){stage.style.setProperty('background','transparent','important');}var scene=document.getElementById('scene');if(scene){scene.style.opacity=String(opacity);}try{window.postMessage({type:'spmt.personal.local-opacity',opacity:opacity},'*');}catch(e){}true;})();";\n    personalWebViewRef.current?.injectJavaScript(script);\n  }\n\n  async function togglePersonalOverlay() {\n    const next = !personalOverlayVisible;\n    setPersonalOverlayVisible(next);\n    setPersonalHudReady(false);\n    if (workspaceTenant) await SecureStore.setItemAsync(personalLocalKey("visible"), next ? "1" : "0");\n  }\n\n  async function setLocalPersonalOpacity(nextValue: number) {\n    const next = Math.max(0, Math.min(100, Math.round(nextValue)));\n    setPersonalOpacity(next);\n    if (workspaceTenant) await SecureStore.setItemAsync(personalLocalKey("opacity"), String(next));\n    setTimeout(() => applyPersonalOpacityToWebView(next), 0);\n  }\n\n  useEffect(() => {\n    if (!workspaceTenant) return;\n    let cancelled = false;\n    Promise.all([\n      SecureStore.getItemAsync(personalLocalKey("visible")),\n      SecureStore.getItemAsync(personalLocalKey("opacity")),\n    ]).then(([visibleValue, opacityValue]) => {\n      if (cancelled) return;\n      setPersonalOverlayVisible(visibleValue === "1");\n      const parsedOpacity = Number(opacityValue);\n      setPersonalOpacity(Number.isFinite(parsedOpacity) ? Math.max(0, Math.min(100, Math.round(parsedOpacity))) : 100);\n    }).catch(() => undefined);\n    return () => { cancelled = true; };\n  }, [workspaceTenant]);\n\n  useEffect(() => {\n    setPersonalHudReady(false);\n  }, [workspace?.canonical?.personalOverlayUrl, workspaceTenant]);`);
  }

  const loadMarker = '    const data = await request("/bootstrap", {}, authToken);\n    setCommands(data.commands ?? []);';
  if (source.includes(loadMarker) && !source.includes('setWorkspace(data.workspace')) {
    source = source.replace(loadMarker, '    const data = await request("/bootstrap", {}, authToken);\n    setWorkspace(data.workspace ?? null);\n    setCommands(data.commands ?? []);');
  }

  const runMarker = '      const lockedVisualContext = options.visualContextOverride ?? visualContext;';
  if (source.includes(runMarker) && !source.includes('const workspaceIdentity = String(workspace?.tenant')) {
    source = source.replace(runMarker, '      const workspaceIdentity = String(workspace?.tenant ?? "").trim().toLowerCase();\n      const lockedVisualContext = options.visualContextOverride ?? visualContext;');
  }
  source = source.replaceAll('tenantId: "94371378",', 'tenantId: workspaceIdentity,');
  source = source.replaceAll('username: "mtman1987",', 'username: workspaceIdentity,');
  source = source.replace('channel: twitchTargetChannel.trim() || activeProfileChannel || extractTwitchChannelFromVisualContext(lockedVisualContext) || "mtman1987",', 'channel: twitchTargetChannel.trim() || activeProfileChannel || extractTwitchChannelFromVisualContext(lockedVisualContext) || workspaceIdentity,');
  source = source.replace('        ? (intent.twitchChannel || twitchTargetChannel.trim() || activeProfileChannel || extractTwitchChannelFromVisualContext(lockedVisualContext) || "mtman1987")\n        : "mtman1987";', '        ? (intent.twitchChannel || twitchTargetChannel.trim() || activeProfileChannel || extractTwitchChannelFromVisualContext(lockedVisualContext) || workspaceIdentity)\n        : workspaceIdentity;');

  const targetBlock = '          {tab === "targets" && (';
  if (source.includes(targetBlock) && !source.includes('SpaceMountain Companion workspace')) {
    const workspaceBlock = `          {tab === "workspace" && (\n            <View style={styles.panel}>\n              <Text style={styles.label}>SpaceMountain Companion workspace</Text>\n              <Text style={styles.note}>Android uses the same canonical SPMT Worktray, Overlay Bay, settings, tenant outputs, and Personal scene as the PC Companion. Nothing here creates a second mobile-only workspace.</Text>\n              <View style={styles.workspaceSummary}>\n                <Text style={styles.workspaceTheme}>{workspaceTenant ? "Tenant: " + workspaceTenant : "SPMT tenant unavailable"}</Text>\n                <Text style={styles.note}>Theme: {String(workspace?.profile?.appearance?.themeId || "shared default")}</Text>\n                {!!workspace?.outputs?.public && <Text style={styles.workspaceUrl} numberOfLines={1}>Public: {String(workspace.outputs.public)}</Text>}\n                {!!workspace?.outputs?.personal && <Text style={styles.workspaceUrl} numberOfLines={1}>Personal: {String(workspace.outputs.personal)}</Text>}\n              </View>\n              <View style={styles.inlineOptions}>\n                {(["worktray", "overlays", "settings"] as const).map((surface) => (\n                  <Pressable key={surface} style={[styles.optionChip, workspaceSurface === surface && styles.optionChipActive]} onPress={() => setWorkspaceSurface(surface)}>\n                    <Text style={styles.optionChipText}>{surface === "worktray" ? "Workspace" : surface === "overlays" ? "Overlay Bay" : "Settings"}</Text>\n                  </Pressable>\n                ))}\n              </View>\n              <View style={styles.localPersonalCard}>\n                <View style={styles.localPersonalHead}>\n                  <View style={{ flex: 1 }}>\n                    <Text style={styles.memoryTitle}>Local Personal HUD</Text>\n                    <Text style={styles.note}>Local to this Android device and this tenant. Overlay Bay remains the shared source of truth.</Text>\n                  </View>\n                  <Pressable style={personalOverlayVisible ? styles.primaryButton : styles.secondaryButton} onPress={() => void togglePersonalOverlay()}>\n                    <Text style={personalOverlayVisible ? styles.primaryButtonText : styles.secondaryButtonText}>{personalOverlayVisible ? "On" : "Off"}</Text>\n                  </Pressable>\n                </View>\n                <View style={styles.opacityPresetRow}>\n                  {[0, 25, 50, 75, 100].map((value) => (\n                    <Pressable key={value} style={[styles.opacityPreset, personalOpacity === value && styles.opacityPresetActive]} onPress={() => void setLocalPersonalOpacity(value)}>\n                      <Text style={styles.opacityPresetText}>{value}%</Text>\n                    </Pressable>\n                  ))}\n                </View>\n                <Text style={styles.note}>Current local opacity: {personalOpacity}%</Text>\n              </View>\n              {workspaceSurfaceUrl ? (\n                <WebView\n                  key={workspaceSurface + workspaceSurfaceUrl}\n                  source={{ uri: workspaceSurfaceUrl }}\n                  style={styles.workspaceWebView}\n                  sharedCookiesEnabled\n                  thirdPartyCookiesEnabled\n                  originWhitelist={["https://*"]}\n                />\n              ) : (\n                <Text style={styles.note}>This canonical SPMT surface is unavailable for the current session. Reconnect SPMT and reload.</Text>\n              )}\n            </View>\n          )}\n\n`;
    source = source.replace(targetBlock, workspaceBlock + targetBlock);
  }

  const scrollCloseMarker = '        </ScrollView>\n      )}\n\n      <View style={styles.tabs}>';
  if (source.includes(scrollCloseMarker) && !source.includes('data-personal-mobile-hud')) {
    const hud = `        </ScrollView>\n      )}\n\n      {connected && personalOverlayVisible && workspace?.canonical?.personalOverlayUrl ? (\n        <View pointerEvents="none" style={[styles.personalHudHost, !personalHudReady && styles.personalHudLoading]} nativeID="data-personal-mobile-hud">\n          <WebView\n            ref={personalWebViewRef}\n            source={{ uri: String(workspace.canonical.personalOverlayUrl) }}\n            style={styles.personalHudWebView}\n            containerStyle={styles.personalHudWebView}\n            originWhitelist={["https://*"]}\n            sharedCookiesEnabled\n            thirdPartyCookiesEnabled\n            androidLayerType="software"\n            scrollEnabled={false}\n            showsHorizontalScrollIndicator={false}\n            showsVerticalScrollIndicator={false}\n            injectedJavaScriptBeforeContentLoaded={"(function(){document.documentElement.style.setProperty('background','transparent','important');document.documentElement.style.setProperty('background-color','transparent','important');if(document.body){document.body.style.setProperty('background','transparent','important');document.body.style.setProperty('background-color','transparent','important');}true;})();"}\n            onLoadEnd={() => { applyPersonalOpacityToWebView(); setPersonalHudReady(true); }}\n          />\n        </View>\n      ) : null}\n\n      <View style={styles.tabs}>`;
    source = source.replace(scrollCloseMarker, hud);
  }

  const bottomTabs = `          ["targets", "eye", "Target"],\n          ["apps", "apps", "Apps"],\n          ["visual", "browsers", "Visual"],\n          ["logs", "terminal", "Logs"]`;
  if (source.includes(bottomTabs)) {
    source = source.replace(bottomTabs, `          ["workspace", "grid", "Workspace"],\n          ["apps", "apps", "Apps"],\n          ["visual", "browsers", "Visual"],\n          ["logs", "terminal", "Logs"]`);
  }

  const styleMarker = '  app: { flex: 1, backgroundColor: "#070812", paddingTop: 54 },';
  if (source.includes(styleMarker) && !source.includes('personalHudHost:')) {
    source = source.replace(styleMarker, `${styleMarker}\n  workspaceSummary: { gap: 6, marginVertical: 10, padding: 12, borderRadius: 14, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(34,211,238,.2)" },\n  workspaceTheme: { color: "#e2e8f0", fontWeight: "800" },\n  workspaceUrl: { color: "#8fdfff", fontFamily: "Courier", fontSize: 10 },\n  workspaceWebView: { height: 560, minHeight: 560, borderRadius: 14, overflow: "hidden", backgroundColor: "#050609" },\n  localPersonalCard: { gap: 10, padding: 12, borderRadius: 12, backgroundColor: "rgba(34,211,238,.06)", borderWidth: 1, borderColor: "rgba(34,211,238,.22)" },\n  localPersonalHead: { flexDirection: "row", alignItems: "center", gap: 10 },\n  opacityPresetRow: { flexDirection: "row", flexWrap: "wrap", gap: 6 },\n  opacityPreset: { minWidth: 50, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, alignItems: "center", borderWidth: 1, borderColor: "rgba(255,255,255,.14)", backgroundColor: "#0b1020" },\n  opacityPresetActive: { borderColor: "#22d3ee", backgroundColor: "rgba(34,211,238,.16)" },\n  opacityPresetText: { color: "#e2e8f0", fontSize: 11, fontWeight: "900" },\n  personalHudHost: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, backgroundColor: "transparent" },\n  personalHudLoading: { opacity: 0 },\n  personalHudWebView: { flex: 1, backgroundColor: "transparent" },`);
  }
  return source;
});
