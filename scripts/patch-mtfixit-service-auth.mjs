import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'dshMtFixitGateway.ts');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('async function isDshMtFixItServiceAuthorized(')) {
  const marker = 'export function mapDshMtFixItWorkerPath(method: string, pathname: string, search = ""): string | null {';
  if (!source.includes(marker)) throw new Error('DSH MtFixIt gateway auth insertion marker missing');
  const helper = [
    'async function isDshMtFixItServiceAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): Promise<boolean> {',
    '  const bearer = String(request.headers.authorization || "").match(/^Bearer\\s+(.+)$/i)?.[1]?.trim() || "";',
    '  if (!bearer) return false;',
    '  const baseUrl = String(env.SPMT_BASE_URL || "https://spmt.live").replace(/\\/$/, "");',
    '  const response = await fetch(`${baseUrl}/api/oauth/serviceinfo`, {',
    '    headers: { authorization: `Bearer ${bearer}`, accept: "application/json" },',
    '    signal: AbortSignal.timeout(10_000),',
    '  }).catch(() => null);',
    '  if (!response?.ok) return false;',
    '  const payload = await response.json().catch(() => null) as any;',
    '  const scopes = Array.isArray(payload?.scopes) ? payload.scopes.map(String) : [];',
    '  return payload?.client_id === "discord-stream-hub" && payload?.token_use === "client_credentials" && scopes.includes("athena:write");',
    '}',
    '',
  ].join('\n');
  source = source.replace(marker, helper + marker);
}

const oldAuth = '  if (!isDshMtFixItAuthorized(request, env)) { sendJson(response, 401, { error: "Unauthorized" }); return true; }';
if (source.includes(oldAuth)) {
  const replacement = [
    '  const serviceAuthorized = await isDshMtFixItServiceAuthorized(request, env);',
    '  const legacyAuthorized = !serviceAuthorized && isDshMtFixItAuthorized(request, env);',
    '  if (!serviceAuthorized && !legacyAuthorized) { sendJson(response, 401, { error: "Unauthorized" }); return true; }',
    '  if (legacyAuthorized) {',
    '    console.warn(`[auth-migration] LEGACY_AUTH_USED migration=AUTH-ROT-001 caller=discord-stream-hub route=${url.pathname} transport=dsh-shared-secret`);',
    '  }',
  ].join('\n');
  source = source.replace(oldAuth, replacement);
}

fs.writeFileSync(file, source, 'utf8');
console.log('Rotator MtFixIt scoped SPMT service auth patch applied.');
