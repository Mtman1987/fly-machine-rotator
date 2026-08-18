import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(relative, mutate) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const after = mutate(before);
  if (after !== before) fs.writeFileSync(file, after, 'utf8');
}

patch('src/mcpControlServer.ts', (source) => {
  let next = source;
  if (!next.includes('from "./repairAudit.js"')) {
    const marker = 'import { isSpmtAdmin, requireSpmtIdentity, type SpmtIdentity } from "./spmtAuth.js";\n';
    if (!next.includes(marker)) throw new Error('MCP repair audit import marker missing');
    next = next.replace(marker, marker + 'import { getAthenaRepairAudit, renderAthenaRepairAuditText } from "./repairAudit.js";\n');
  }
  if (!next.includes('{ name: "get_athena_repair_audit"')) {
    const marker = '    { name: "list_fly_app_states", title: "List managed Fly app states"';
    const index = next.indexOf(marker);
    if (index < 0) throw new Error('MCP repair audit tool marker missing');
    const block = [
      '    { name: "get_athena_repair_audit", title: "Read Athena repair audit", description: "Read persisted Athena fix records, incident attempts, approval delivery state, checks, pushes, and deployment outcomes. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: { format: { type: "string", enum: ["json", "text"] } }, additionalProperties: false }, annotations: readOnlyAnnotations },',
    ].join('\n') + '\n';
    next = next.slice(0, index) + block + next.slice(index);
  }
  if (!next.includes('    "get_athena_repair_audit",')) {
    const marker = '    "list_fly_app_states",\n';
    if (!next.includes(marker)) throw new Error('MCP admin tool marker missing');
    next = next.replace(marker, '    "get_athena_repair_audit",\n' + marker);
  }
  if (!next.includes('if (name === "get_athena_repair_audit")')) {
    const marker = '  if (name === "list_fly_app_states") {';
    if (!next.includes(marker)) throw new Error('MCP repair audit executor marker missing');
    const block = [
      '  if (name === "get_athena_repair_audit") {',
      '    const audit = await getAthenaRepairAudit(env);',
      '    return { status: 200, payload: String(args.format || "json") === "text" ? { text: renderAthenaRepairAuditText(audit) } : audit };',
      '  }',
    ].join('\n') + '\n';
    next = next.replace(marker, block + marker);
  }
  return next;
});

patch('src/athenaRepairUi.ts', (source) => {
  let next = source;
  if (!next.includes('from "./repairAudit.js"')) {
    const marker = 'import { requireSpmtAdmin } from "./spmtAuth.js";\n';
    if (!next.includes(marker)) throw new Error('Athena repair UI audit import marker missing');
    next = next.replace(marker, marker + 'import { getAthenaRepairAudit, renderAthenaRepairAuditText } from "./repairAudit.js";\n');
  }
  if (!next.includes('function sendTextDownload(')) {
    const marker = 'function sendHtml(response: ServerResponse, html: string) {';
    if (!next.includes(marker)) throw new Error('Athena repair UI send helper marker missing');
    const helper = [
      'function sendTextDownload(response: ServerResponse, text: string) {',
      '  response.writeHead(200, {',
      '    "content-type": "text/plain; charset=utf-8",',
      '    "content-disposition": `attachment; filename="athena-repair-audit-${new Date().toISOString().slice(0, 10)}.txt"`,',
      '    "cache-control": "private, no-store",',
      '    "x-content-type-options": "nosniff",',
      '  });',
      '  response.end(text);',
      '}',
      '',
    ].join('\n');
    next = next.replace(marker, helper + marker);
  }
  if (!next.includes('url.pathname === `${API_PREFIX}/audit`')) {
    const marker = '  if ((request.method || "GET") === "POST" && url.pathname === `${API_PREFIX}/run`) {';
    if (!next.includes(marker)) throw new Error('Athena repair UI audit route marker missing');
    const routes = [
      '  if ((request.method || "GET") === "GET" && url.pathname === `${API_PREFIX}/audit`) {',
      '    sendJson(response, 200, await getAthenaRepairAudit(env));',
      '    return true;',
      '  }',
      '',
      '  if ((request.method || "GET") === "GET" && url.pathname === `${API_PREFIX}/audit.txt`) {',
      '    sendTextDownload(response, renderAthenaRepairAuditText(await getAthenaRepairAudit(env)));',
      '    return true;',
      '  }',
      '',
    ].join('\n');
    next = next.replace(marker, routes + marker);
  }
  if (!next.includes('Download repair audit')) {
    const marker = '<div class="actions"><button id="run">Run Athena rotation</button><a class="button secondary" href="${rotatorDashboardUrl}">Open approval dashboard</a></div>';
    if (!next.includes(marker)) throw new Error('Athena repair UI audit button marker missing');
    next = next.replace(marker, '<div class="actions"><button id="run">Run Athena rotation</button><a class="button secondary" href="${rotatorDashboardUrl}">Open approval dashboard</a><a class="button secondary" href="/athena/api/repair/audit.txt">Download repair audit</a></div>');
  }
  return next;
});

console.log('Athena repair audit access patched.');
