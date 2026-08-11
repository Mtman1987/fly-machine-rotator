import { readFile, writeFile } from 'node:fs/promises';

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

function installSharedUi(source, appId, profileEndpoint = '/athena/api/settings') {
  source = ensureSharedUiImport(source);
  const headCall = '${spmtSharedUiHead("' + appId + '")}';
  const scriptCall = '${spmtSharedUiScript("' + appId + '", "' + profileEndpoint + '")}';
  if (source.includes('</head>') && !source.includes(headCall)) source = source.replace('</head>', `${headCall}</head>`);
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
    const workspaceMethod = `${tokenMethod}\n\n  async loadWorkspace(userId: string): Promise<JsonRecord | null> {\n    const accessToken = this.getServiceToken(userId, "spmt");\n    if (!accessToken) return null;\n    const base = this.serviceBaseUrl("spmt").replace(/\\/$/, "");\n    const headers = { authorization: \`Bearer \${accessToken}\`, accept: "application/json" };\n    try {\n      const [profileResponse, overlayResponse] = await Promise.all([\n        fetch(\`\${base}/api/workspace-profile\`, { headers, signal: AbortSignal.timeout(10_000) }),\n        fetch(\`\${base}/api/overlay-workspace\`, { headers, signal: AbortSignal.timeout(10_000) }),\n      ]);\n      if (!profileResponse.ok) return null;\n      const profile = asRecord(await profileResponse.json().catch(() => ({})));\n      const overlay = overlayResponse.ok ? asRecord(await overlayResponse.json().catch(() => ({}))) : {};\n      return { profile: profile.profile ?? null, overlay: overlay.layout ?? null };\n    } catch {\n      return null;\n    }\n  }`;
    source = source.replace(tokenMethod, workspaceMethod);
  }
  return installSharedUiInFunction(source, 'function renderMountainViewHtml', 'mountainview', '/mountainview/api/bootstrap');
});

await patch('mobile/App.tsx', (source) => {
  source = source.replace('type MainTab = "home" | "targets" | "apps" | "visual" | "logs" | "relay" | "memory" | "stream" | "devices" | "polling" | "logos" | "qr" | "roadmap";', 'type MainTab = "home" | "workspace" | "targets" | "apps" | "visual" | "logs" | "relay" | "memory" | "stream" | "devices" | "polling" | "logos" | "qr" | "roadmap";');

  const stateMarker = '  const [token, setToken] = useState("");';
  if (source.includes(stateMarker) && !source.includes('const [workspace, setWorkspace]')) {
    source = source.replace(stateMarker, `${stateMarker}\n  const [workspace, setWorkspace] = useState<Record<string, any> | null>(null);`);
  }

  const loadMarker = '    const data = await request("/bootstrap", {}, authToken);\n    setCommands(data.commands ?? []);';
  if (source.includes(loadMarker) && !source.includes('setWorkspace(data.workspace')) {
    source = source.replace(loadMarker, '    const data = await request("/bootstrap", {}, authToken);\n    setWorkspace(data.workspace ?? null);\n    setCommands(data.commands ?? []);');
  }

  const targetBlock = '          {tab === "targets" && (';
  if (source.includes(targetBlock) && !source.includes('Canonical workspace control center')) {
    const workspaceBlock = `          {tab === "workspace" && (\n            <View style={styles.panel}>\n              <Text style={styles.label}>Canonical workspace control center</Text>\n              <Text style={styles.note}>The same SPMT Worktray controls your three embeds, overlay workspace, and account settings from the phone without duplicating app state.</Text>\n              <View style={styles.workspaceSummary}>\n                <Text style={styles.workspaceTheme}>Preset: {String(workspace?.profile?.appearance?.themeId || "Sign in to SPMT")}</Text>\n                <Text style={styles.note}>{workspace?.profile ? "Workspace profile linked to this MountainView session." : "Open the SPMT surface below to connect or manage the account workspace."}</Text>\n              </View>\n              <WebView\n                source={{ uri: "https://spmt.live/embed/worktray?mode=full&app=mountainview-mobile" }}\n                style={styles.workspaceWebView}\n                sharedCookiesEnabled\n                thirdPartyCookiesEnabled\n                originWhitelist={["https://*"]}\n              />\n            </View>\n          )}\n\n`;
    source = source.replace(targetBlock, workspaceBlock + targetBlock);
  }

  const bottomTabs = `          ["targets", "eye", "Target"],\n          ["apps", "apps", "Apps"],\n          ["visual", "browsers", "Visual"],\n          ["logs", "terminal", "Logs"]`;
  if (source.includes(bottomTabs)) {
    source = source.replace(bottomTabs, `          ["workspace", "grid", "Workspace"],\n          ["apps", "apps", "Apps"],\n          ["visual", "browsers", "Visual"],\n          ["logs", "terminal", "Logs"]`);
  }

  const styleMarker = '  app: { flex: 1, backgroundColor: "#070812", paddingTop: 54 },';
  if (source.includes(styleMarker) && !source.includes('workspaceWebView:')) {
    source = source.replace(styleMarker, `${styleMarker}\n  workspaceSummary: { gap: 6, marginVertical: 10, padding: 12, borderRadius: 14, backgroundColor: "#0b1020", borderWidth: 1, borderColor: "rgba(34,211,238,.2)" },\n  workspaceTheme: { color: "#e2e8f0", fontWeight: "800" },\n  workspaceWebView: { height: 560, minHeight: 560, borderRadius: 14, overflow: "hidden", backgroundColor: "#050609" },`);
  }
  return source;
});
