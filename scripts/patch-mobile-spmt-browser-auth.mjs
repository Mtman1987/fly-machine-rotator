import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, transform) {
  const before = await readFile(path, 'utf8');
  const after = transform(before);
  if (after === before) {
    console.log(`mobile SPMT browser auth already patched: ${path}`);
    return;
  }
  await writeFile(path, after, 'utf8');
  console.log(`patched mobile SPMT browser auth: ${path}`);
}

function required(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`mobile SPMT browser auth marker missing: ${label}`);
  return source.replace(from, to);
}

await patch('src/mountainView.ts', (source) => {
  if (source.includes('MOUNTAINVIEW_MOBILE_AUTH_V1')) return source;

  source = required(
    source,
    '      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);',
    '      CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);\n      CREATE TABLE IF NOT EXISTS mobile_auth_handoffs (code_hash TEXT PRIMARY KEY, encrypted_session_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);',
    'mobile auth handoff table',
  );

  const callbackBlock = `    if (cookies.mountainview_oauth_target === "mobile") {\n      response.setHeader("cache-control", "no-store");\n      html(response, renderMobileAuthHandoff(session.token));\n      return true;\n    }`;
  const callbackReplacement = `    if (cookies.mountainview_oauth_target === "mobile") {\n      response.setHeader("cache-control", "no-store");\n      const handoffCode = context.createMobileAuthHandoff(session.token);\n      html(response, renderMobileAuthHandoff(handoffCode));\n      return true;\n    }`;
  source = required(source, callbackBlock, callbackReplacement, 'mobile callback handoff');

  const logoutMarker = `  if (method === "POST" && apiPath === "/api/logout") {`;
  const exchangeRoute = `  // MOUNTAINVIEW_MOBILE_AUTH_V1\n  if (method === "POST" && apiPath === "/api/auth/mobile/exchange") {\n    const body = await readJson(request);\n    const code = String(body.code ?? "").trim();\n    if (!code) throw new HttpError(400, "Mobile sign-in code is required.");\n    return json(response, { ok: true, token: context.exchangeMobileAuthHandoff(code) });\n  }\n\n`;
  source = required(source, logoutMarker, exchangeRoute + logoutMarker, 'mobile exchange route');

  const createSessionMarker = `  createSession(user: MountainViewUser): { token: string; user: MountainViewUser } {`;
  const handoffMethods = `  createMobileAuthHandoff(sessionToken: string): string {\n    const code = randomBytes(32).toString("base64url");\n    const now = new Date();\n    this.db.prepare("DELETE FROM mobile_auth_handoffs WHERE expires_at <= ?").run(now.toISOString());\n    this.db.prepare("INSERT INTO mobile_auth_handoffs (code_hash, encrypted_session_token, created_at, expires_at) VALUES (?, ?, ?, ?)")\n      .run(hashToken(code), this.encrypt(sessionToken), now.toISOString(), new Date(now.getTime() + 2 * 60 * 1000).toISOString());\n    return code;\n  }\n\n  exchangeMobileAuthHandoff(code: string): string {\n    const codeHash = hashToken(code);\n    const row = this.db.prepare("SELECT encrypted_session_token, expires_at FROM mobile_auth_handoffs WHERE code_hash = ?").get(codeHash) as { encrypted_session_token: string; expires_at: string } | undefined;\n    this.db.prepare("DELETE FROM mobile_auth_handoffs WHERE code_hash = ?").run(codeHash);\n    if (!row || Date.parse(row.expires_at) <= Date.now()) throw new HttpError(401, "Mobile sign-in code is invalid or expired.");\n    return this.decrypt(row.encrypted_session_token);\n  }\n\n`;
  source = required(source, createSessionMarker, handoffMethods + createSessionMarker, 'mobile handoff methods');

  const renderBlock = `export function renderMobileAuthHandoff(token: string): string {\n  const payload = JSON.stringify({ type: "mountainview-auth", token }).replace(/</g, "\\\\u003c");\n  return \`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MountainView connected</title></head><body><p>MountainView is connected to your SPMT account.</p><script>window.ReactNativeWebView?.postMessage(\${JSON.stringify(payload)});</script></body></html>\`;\n}`;
  const renderReplacement = `export function renderMobileAuthHandoff(code: string): string {\n  const target = \`mountainviewai://auth?code=\${encodeURIComponent(code)}\`;\n  const escapedTarget = JSON.stringify(target).replace(/</g, "\\\\u003c");\n  return \`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>MountainView connected</title></head><body><p>SPMT sign-in complete. Returning to MountainView...</p><p><a href=\${JSON.stringify(target)}>Return to MountainView</a></p><script>window.location.replace(\${escapedTarget});</script></body></html>\`;\n}`;
  source = required(source, renderBlock, renderReplacement, 'mobile auth return renderer');
  return source;
});

await patch('mobile/App.tsx', (source) => {
  if (source.includes('MOUNTAINVIEW_BROWSER_AUTH_V1')) return source;

  source = required(
    source,
    'import { Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";',
    'import { Alert, Image, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";',
    'Linking import',
  );

  const tokenEffect = `  useEffect(() => {\n    tokenRef.current = token;\n    if (token) void ensurePrivateAssistant("authenticated-session");\n  }, [token]);`;
  const deepLinkEffect = `${tokenEffect}\n\n  // MOUNTAINVIEW_BROWSER_AUTH_V1\n  useEffect(() => {\n    const receive = ({ url }: { url: string }) => {\n      if (/^mountainviewai:\\/\\/auth(?:[/?#]|$)/i.test(url)) void handleAuthUrl(url);\n    };\n    const subscription = Linking.addEventListener("url", receive);\n    void Linking.getInitialURL().then((url) => { if (url) receive({ url }); });\n    return () => subscription.remove();\n  }, []);`;
  source = required(source, tokenEffect, deepLinkEffect, 'deep link listener');

  const authFunctions = `  async function login() {\n    announce("Opening secure SPMT sign-in...");\n    setAuthVisible(true);\n  }\n\n  async function handleAuthMessage(raw: string) {\n    try {\n      const data = JSON.parse(raw);\n      if (data?.type !== "mountainview-auth" || !data?.token) throw new Error("SPMT did not return a MountainView session.");\n      setToken(data.token);\n      await SecureStore.setItemAsync("mountainview_token", data.token);\n      setAuthVisible(false);\n      await load(data.token);\n      setStatusMessage("Connected with SPMT. MountainView command bridge is ready.");\n    } catch (error) {\n      reportError("SPMT sign-in", error);\n    }\n  }`;
  const authFunctionsReplacement = `  async function login() {\n    try {\n      announce("Opening SPMT in your browser...");\n      setAuthVisible(true);\n      const loginUrl = \`\${apiBaseUrl.replace(/\\/api\\/?$/, "")}/auth/login?client=mobile\`;\n      await Linking.openURL(loginUrl);\n    } catch (error) {\n      setAuthVisible(false);\n      reportError("SPMT sign-in", error);\n    }\n  }\n\n  async function handleAuthUrl(url: string) {\n    try {\n      const encodedCode = url.match(/[?&]code=([^&#]+)/i)?.[1] ?? "";\n      const code = decodeURIComponent(encodedCode);\n      if (!code) throw new Error("SPMT did not return a mobile sign-in code.");\n      announce("Finishing SPMT sign-in...");\n      const data = await request("/auth/mobile/exchange", { method: "POST", body: JSON.stringify({ code }) }, "");\n      if (!data?.token) throw new Error("MountainView did not return a session.");\n      setToken(data.token);\n      await SecureStore.setItemAsync("mountainview_token", data.token);\n      setAuthVisible(false);\n      await load(data.token);\n      setStatusMessage("Connected with SPMT. MountainView command bridge is ready.");\n    } catch (error) {\n      setAuthVisible(false);\n      reportError("SPMT sign-in", error);\n    }\n  }`;
  source = required(source, authFunctions, authFunctionsReplacement, 'browser login functions');

  const webViewBlock = `          {authVisible ? (\n            <>\n              <WebView\n                originWhitelist={["https://*"]}\n                source={{ uri: \`\${apiBaseUrl.replace(/\\/api\\/?$/, "")}/auth/login?client=mobile\` }}\n                onMessage={(event) => void handleAuthMessage(event.nativeEvent.data)}\n                sharedCookiesEnabled\n                thirdPartyCookiesEnabled\n                style={styles.authWebView}\n              />\n              <Pressable style={styles.secondaryButton} onPress={() => setAuthVisible(false)}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable>\n            </>\n          ) : (\n            <Pressable style={styles.primaryButton} onPress={login}><Text style={styles.primaryButtonText}>Sign in with SPMT</Text></Pressable>\n          )}`;
  const browserBlock = `          {authVisible ? (\n            <>\n              <View style={styles.hintBox}>\n                <Text style={styles.memoryTitle}>Finish sign-in in your browser</Text>\n                <Text style={styles.note}>MountainView opened SPMT outside the app so it can use your existing SPMT session. After sign-in, Android will return you here automatically.</Text>\n              </View>\n              <Pressable style={styles.secondaryButton} onPress={() => setAuthVisible(false)}><Text style={styles.secondaryButtonText}>Cancel</Text></Pressable>\n            </>\n          ) : (\n            <Pressable style={styles.primaryButton} onPress={login}><Text style={styles.primaryButtonText}>Sign in with SPMT</Text></Pressable>\n          )}`;
  source = required(source, webViewBlock, browserBlock, 'remove embedded auth webview');
  return source;
});
