import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patchFile(relative, mutate) {
  const file = path.join(root, relative);
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const next = mutate(source);
  if (next !== source) fs.writeFileSync(file, next, 'utf8');
}

patchFile('src/athenaSpmtGateway.ts', (source) => {
  let next = source;

  next = next.replace(
    'import { hasMountainViewAdminSession } from "./mountainView.js";\n',
    'import { requireSpmtAdmin } from "./spmtAuth.js";\n',
  );
  next = next.replaceAll('await hasMountainViewAdminSession(request, env)', 'await requireSpmtAdmin(request, env)');
  next = next.replaceAll('await hasMountainViewAdminSession(incoming, env)', 'await requireSpmtAdmin(incoming, env)');
  next = next.replace(
    'location: `/mountainview/auth/login?next=${next}`',
    'location: `/auth/spmt/login?next=${next}`',
  );

  // Owner browser requests are authenticated by the canonical SPMT OAuth
  // session cookie. Do not translate that identity into compatibility secrets.
  next = next.replace(/\n\s*if \(authenticated && pathname\.startsWith\("\/api\/codex\/"\) && isWrite\) \{[\s\S]*?\n\s*\}\n\n\s*if \(authenticated && \(pathname\.startsWith\("\/actions\/"\) \|\| pathname === "\/logs\/errors\.txt"\)\) \{[\s\S]*?\n\s*\}\n/, '\n');
  next = next.replace(
    '  const isWrite = incoming.method !== "GET" && incoming.method !== "HEAD";\n',
    '',
  );
  // Once compatibility-header injection is removed there is no reason to make
  // a second SPMT userinfo call for every otherwise-unrelated proxy request.
  next = next.replace(
    '  const authenticated = await requireSpmtAdmin(incoming, env);\n',
    '',
  );
  next = next.replace(
    '    { label: "Rotator action bridge", status: has("ROTATOR_DASHBOARD_ACTION_TOKEN") ? "ready" : "missing", detail: "Server-side compatibility token; browser prompt removed" },\n',
    '    { label: "Rotator owner auth", status: has("MOUNTAINVIEW_CLIENT_SECRET") || has("ROTATOR_SPMT_CLIENT_SECRET") ? "ready" : "missing", detail: "Canonical SPMT OAuth owner/admin session" },\n',
  );

  // The public gateway must never allow a browser to forge the local-process
  // marker used by Rotator components talking to the internal dashboard.
  const proxyMarker = '  const headers: IncomingHttpHeaders = { ...incoming.headers, host: `127.0.0.1:${internalPort}` };\n';
  if (next.includes(proxyMarker) && !next.includes('delete headers["x-rotator-internal"]')) {
    next = next.replace(proxyMarker, proxyMarker + '  delete headers["x-rotator-internal"];\n');
  }

  if (next.includes('hasMountainViewAdminSession')) throw new Error('legacy MountainView session auth remains in Athena gateway');
  return next;
});

patchFile('src/dashboardServer.ts', (source) => {
  let next = source;

  // Browser actions use the canonical SPMT owner session. Same-process Rotator
  // callers use a loopback-only marker instead of an environment secret.
  next = next.replaceAll('    authorizeAction(request, env);', '    await authorizeAction(request, env);');
  next = next.replaceAll('/mountainview/auth/login?next=%2F', '/auth/spmt/login?next=%2F');
  next = next.replace(
    /export function authorizeAction\(request: IncomingMessage, env: NodeJS\.ProcessEnv\): void \{[\s\S]*?\n\}/,
    [
      'function isSameProcessAction(request: IncomingMessage): boolean {',
      '  const remote = String(request.socket?.remoteAddress || "");',
      '  const loopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";',
      '  const marker = String(request.headers["x-rotator-internal"] || "").trim();',
      '  return loopback && marker === "same-process";',
      '}',
      '',
      'export async function authorizeAction(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<void> {',
      '  if (isSameProcessAction(request)) return;',
      '  const identity = await requireSpmtAdmin(request, env);',
      '  if (!identity) throw new HttpError(401, "SPMT owner/admin session required.");',
      '}',
    ].join('\n'),
  );

  if (next.includes('Invalid rotator dashboard action token.')) throw new Error('legacy rotator action token gate remains');
  if (next.includes('ROTATOR_DASHBOARD_ACTION_TOKEN is not configured')) throw new Error('legacy rotator action token configuration remains');
  return next;
});

patchFile('src/athenaIncidentTrigger.ts', (source) => {
  let next = source;
  next = next.replace('  const token = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN ?? "").trim();\n', '');
  next = next.replace('    if (!token) throw new Error("ROTATOR_DASHBOARD_ACTION_TOKEN is not configured");\n', '');
  next = next.replace(
    '      headers: { "x-rotator-action-token": token, "content-type": "application/json" },',
    '      headers: { "x-rotator-internal": "same-process", "content-type": "application/json" },',
  );
  return next;
});

patchFile('src/athenaRepairUi.ts', (source) => {
  let next = source;
  next = next.replace(
    '  const token = String(env.ROTATOR_DASHBOARD_ACTION_TOKEN || "").trim();\n  if (!token) throw new Error("ROTATOR_DASHBOARD_ACTION_TOKEN is not configured.");\n',
    '',
  );
  next = next.replace(
    '      "x-rotator-action-token": token,',
    '      "x-rotator-internal": "same-process",',
  );
  return next;
});

// publicCodexFixer already has the right owner boundary: ownerUiAuthorized()
// combines canonical requireSpmtAdmin() with the same-origin UI marker/origin
// check, while authorized() remains the separate machine-worker lane.

console.log('Canonical SPMT owner auth and same-process Rotator action normalization applied.');
