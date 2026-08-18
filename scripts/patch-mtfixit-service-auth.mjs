import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'dshMtFixitGateway.ts');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('async function isDshMtFixItServiceAuthorized(')) {
  const marker = 'export function mapDshMtFixItWorkerPath(method: string, pathname: string, search = ""): string | null {';
  if (!source.includes(marker)) throw new Error('DSH MtFixIt gateway auth insertion marker missing');
  const helper = `async function isDshMtFixItServiceAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): Promise<boolean> {\n  const bearer = String(request.headers.authorization || "").match(/^Bearer\\s+(.+)$/i)?.[1]?.trim() || "";\n  if (!bearer) return false;\n  const baseUrl = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\\/$/, "");\n  const response = await fetch(\\`${'${baseUrl}'}/api/oauth/serviceinfo\\`, {\n    headers: { authorization: \\`Bearer ${'${bearer}'}\\`, accept: "application/json" },\n    signal: AbortSignal.timeout(10_000),\n  }).catch(() => null);\n  if (!response?.ok) return false;\n  const payload = await response.json().catch(() => null) as any;\n  const scopes = Array.isArray(payload?.scopes) ? payload.scopes.map(String) : [];\n  return payload?.client_id === "discord-stream-hub" && payload?.token_use === "client_credentials" && scopes.includes("athena:write");\n}\n\n`;
  source = source.replace(marker, helper + marker);
}

const oldAuth = '  if (!isDshMtFixItAuthorized(request, env)) { sendJson(response, 401, { error: "Unauthorized" }); return true; }';
if (source.includes(oldAuth)) {
  source = source.replace(oldAuth, `  const serviceAuthorized = await isDshMtFixItServiceAuthorized(request, env);\n  const legacyAuthorized = !serviceAuthorized && isDshMtFixItAuthorized(request, env);\n  if (!serviceAuthorized && !legacyAuthorized) { sendJson(response, 401, { error: "Unauthorized" }); return true; }\n  if (legacyAuthorized) {\n    console.warn(\\`[auth-migration] LEGACY_AUTH_USED migration=AUTH-ROT-001 caller=discord-stream-hub route=${'${url.pathname}'} transport=dsh-shared-secret\\`);\n  }`);
}

fs.writeFileSync(file, source, 'utf8');
console.log('Rotator MtFixIt scoped SPMT service auth patch applied.');
