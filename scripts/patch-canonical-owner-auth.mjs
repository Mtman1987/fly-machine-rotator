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
  next = next.replace(
    '    { label: "Rotator action bridge", status: has("ROTATOR_DASHBOARD_ACTION_TOKEN") ? "ready" : "missing", detail: "Server-side compatibility token; browser prompt removed" },\n',
    '    { label: "Rotator owner auth", status: has("MOUNTAINVIEW_CLIENT_SECRET") || has("ROTATOR_SPMT_CLIENT_SECRET") ? "ready" : "missing", detail: "Canonical SPMT OAuth owner/admin session" },\n',
  );

  if (next.includes('hasMountainViewAdminSession')) throw new Error('legacy MountainView session auth remains in Athena gateway');
  return next;
});

patchFile('src/dashboardServer.ts', (source) => {
  let next = source;

  // All owner actions use the same SPMT admin identity as the dashboard itself.
  next = next.replaceAll('    authorizeAction(request, env);', '    await authorizeAction(request, env);');
  next = next.replace(
    /export function authorizeAction\(request: IncomingMessage, env: NodeJS\.ProcessEnv\): void \{[\s\S]*?\n\}/,
    [
      'export async function authorizeAction(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<void> {',
      '  const identity = await requireSpmtAdmin(request, env);',
      '  if (!identity) throw new HttpError(401, "SPMT owner/admin session required.");',
      '}',
    ].join('\n'),
  );

  if (next.includes('Invalid rotator dashboard action token.')) throw new Error('legacy rotator action token gate remains');
  return next;
});

patchFile('src/publicCodexFixer.ts', (source) => {
  let next = source;

  // Browser owner writes are authorized by the same SPMT session as reads.
  // The outer gateway already enforces same-origin mutation checks and rate limits.
  next = next.replace(
    '  const ownerWriteAuth = method !== "GET" && await ownerUiAuthorized(request, env);',
    '  const ownerWriteAuth = method !== "GET" && await requireSpmtAdmin(request, env);',
  );

  return next;
});

console.log('Canonical SPMT owner auth normalization applied.');
