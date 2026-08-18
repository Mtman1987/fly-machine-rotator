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

patchFile('src/incidentClassifier.ts', (source) => {
  if (source.includes('legacy-auth-migration:')) return source;
  const marker = '  const lower = evidence.toLowerCase();\n';
  if (!source.includes(marker)) throw new Error('incidentClassifier legacy-auth marker missing');
  return source.replace(marker, `${marker}\n  if (/\\blegacy_auth_used\\b/i.test(evidence)) {\n    const migration = evidence.match(/\\bmigration=([a-z0-9_-]+)/i)?.[1] || "untracked";\n    return {\n      key: \\`${'${event.appName}'}:legacy-auth-migration:${'${migration.toLowerCase()}'}\\`,\n      disposition: "code",\n      autoFixEligible: true,\n      reason: \\`Compatibility authentication path ${'${migration}'} is still active. Preserve legacy acceptance, migrate the caller to canonical SPMT OAuth/session authentication, validate both paths during rollout, and update the auth migration ledger.\\`,\n    };\n  }\n`);
});

patchFile('src/logMonitor.ts', (source) => {
  if (source.includes('/\\blegacy_auth_used\\b/i,')) return source;
  const marker = 'const ERROR_PATTERNS = [\n';
  if (!source.includes(marker)) throw new Error('logMonitor error pattern marker missing');
  return source.replace(marker, `${marker}  /\\blegacy_auth_used\\b/i,\n`);
});

patchFile('src/dashboardServer.ts', (source) => {
  let next = source;
  if (!next.includes('from "./repairApproval.js"')) {
    const marker = 'import { handlePublicCodexRequest, listCodexJobs } from "./publicCodexFixer.js";\n';
    if (!next.includes(marker)) throw new Error('dashboardServer import marker missing');
    next = next.replace(marker, `${marker}import { requestRepairApproval } from "./repairApproval.js";\n`);
  }

  const autoMarker = `      if (record.checkResult.ok && await maybePushCheckedFixBranch(record, config, repoPath, env)) {\n        pushed += 1;\n      }`;
  if (next.includes(autoMarker)) {
    next = next.replace(autoMarker, `${autoMarker}\n      if (record.checkResult.ok && record.pushResult?.commit) {\n        await requestRepairApproval(record, env);\n      }`);
  }

  const checkMarker = `    updateFixQualityGate(existing);\n    store.upsert(existing);\n    await store.save();\n    return { ok: true, message: existing.checkResult.ok ? branchPushed ? \\`Checks passed and pushed branch ${'${existing.pushResult?.branch}'}.\\` : "Checks passed." : "Checks failed." };`;
  if (next.includes(checkMarker)) {
    next = next.replace(checkMarker, `    updateFixQualityGate(existing);\n    if (existing.checkResult.ok && existing.pushResult?.commit) {\n      await requestRepairApproval(existing, env);\n    }\n    store.upsert(existing);\n    await store.save();\n    return { ok: true, message: existing.approval?.status === "awaiting_approval" ? "Checks passed. Repair sent to owner approval DM." : existing.checkResult.ok ? branchPushed ? \\`Checks passed and pushed branch ${'${existing.pushResult?.branch}'}.\\` : "Checks passed." : "Checks failed." };`);
  }

  const pushMarker = `    updateFixQualityGate(existing);\n    store.upsert(existing);\n    await store.save();\n    return { ok: true, message: \\`Pushed branch ${'${push.branch}'}.\\` };`;
  if (next.includes(pushMarker)) {
    next = next.replace(pushMarker, `    updateFixQualityGate(existing);\n    await requestRepairApproval(existing, env);\n    store.upsert(existing);\n    await store.save();\n    return { ok: true, message: existing.approval?.status === "awaiting_approval" ? \\`Pushed branch ${'${push.branch}'} and sent the repair to owner approval.\\` : \\`Pushed branch ${'${push.branch}'}.\\` };`);
  }
  return next;
});

patchFile('src/athenaSpmtGateway.ts', (source) => {
  let next = source;
  if (!next.includes('from "./repairApproval.js"')) {
    const marker = 'import { listCodeReferences, listCodexJobs, type PublicCodexJob } from "./publicCodexFixer.js";\n';
    if (!next.includes(marker)) throw new Error('athenaSpmtGateway import marker missing');
    next = next.replace(marker, `${marker}import { decideRepairApproval } from "./repairApproval.js";\n`);
  }

  if (!next.includes('url.pathname === "/athena/repair-decision"')) {
    const marker = `      if (request.method === "GET" && url.pathname === "/rotator") {`;
    if (!next.includes(marker)) throw new Error('athenaSpmtGateway decision route marker missing');
    const block = `      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/athena/repair-decision") {\n        if (!(await hasMountainViewAdminSession(request, env))) return redirectToLogin(response, url);\n        if (request.method === "GET") {\n          const fixId = String(url.searchParams.get("fix") || "").trim();\n          const action = normalizeRepairAction(url.searchParams.get("action"));\n          if (!fixId || !action) return sendRepairDecisionPage(response, 400, "Athena Repair Gate", "Invalid or incomplete repair decision link.");\n          return sendRepairDecisionConfirmation(response, fixId, action);\n        }\n        const form = new URLSearchParams(await readRequestText(request));\n        const fixId = String(form.get("fix") || "").trim();\n        const action = normalizeRepairAction(form.get("action"));\n        if (!fixId || !action) return sendRepairDecisionPage(response, 400, "Athena Repair Gate", "Invalid repair decision payload.");\n        try {\n          const record = await decideRepairApproval(fixId, action, "spmt-owner", env);\n          return sendRepairDecisionPage(response, 200, action === "approve" ? "Repair approved" : "Repair denied", record.approval?.message || \\`Repair is now ${'${record.status}'}.\\`);\n        } catch (error) {\n          return sendRepairDecisionPage(response, 409, "Decision could not be recorded", error instanceof Error ? error.message : String(error));\n        }\n      }\n\n`;
    next = next.replace(marker, block + marker);
  }

  if (!next.includes('function normalizeRepairAction(')) {
    const marker = 'type CodeReference = Awaited<ReturnType<typeof listCodeReferences>>[number];\n';
    if (!next.includes(marker)) throw new Error('athenaSpmtGateway helper marker missing');
    const helpers = `function normalizeRepairAction(value) {\n  const action = String(value || "").trim().toLowerCase();\n  return action === "approve" || action === "deny" ? action : "";\n}\n\nasync function readRequestText(request) {\n  let raw = "";\n  for await (const chunk of request) {\n    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);\n    if (raw.length > 32 * 1024) throw new Error("Repair decision payload too large");\n  }\n  return raw;\n}\n\nfunction escapeDecisionHtml(value) {\n  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");\n}\n\nfunction sendRepairDecisionPage(response, status, title, message) {\n  response.writeHead(status, privateHeaders("text/html; charset=utf-8"));\n  response.end(\\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${'${escapeDecisionHtml(title)}'}</title><style>:root{color-scheme:dark}body{margin:0;background:#070b12;color:#eef4ff;font:16px/1.5 system-ui;display:grid;min-height:100vh;place-items:center;padding:24px}.card{width:min(720px,100%);background:#101722;border:1px solid #28364c;border-radius:16px;padding:24px}.muted{color:#9aacbf}a{color:#8edfff}</style></head><body><main class="card"><div class="muted">Athena · Repair Gate</div><h1>${'${escapeDecisionHtml(title)}'}</h1><p>${'${escapeDecisionHtml(message)}'}</p><p><a href="/athena">Return to Athena Coder</a></p></main></body></html>\\`);\n}\n\nfunction sendRepairDecisionConfirmation(response, fixId, action) {\n  const verb = action === "approve" ? "Approve & deploy" : "Deny / hold";\n  response.writeHead(200, privateHeaders("text/html; charset=utf-8"));\n  response.end(\\`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Athena Repair Gate</title><style>:root{color-scheme:dark}body{margin:0;background:#070b12;color:#eef4ff;font:16px/1.5 system-ui;display:grid;min-height:100vh;place-items:center;padding:24px}.card{width:min(720px,100%);background:#101722;border:1px solid #28364c;border-radius:16px;padding:24px}.muted{color:#9aacbf}.actions{display:flex;gap:12px;margin-top:22px}button,a{border:0;border-radius:10px;padding:12px 18px;font-weight:700;text-decoration:none}.approve{background:#31c76a;color:#06140b}.deny{background:#e14c58;color:white}.secondary{background:#29374a;color:#eef4ff}</style></head><body><main class="card"><div class="muted">Athena · Repair Gate</div><h1>${'${escapeDecisionHtml(verb)}'}</h1><p>Repair <code>${'${escapeDecisionHtml(fixId)}'}</code></p><p class="muted">Your existing SPMT admin session authenticated this decision. Approval allows Athena to create/merge the repair PR and verify deployment. Denial retains the branch for review.</p><form method="post"><input type="hidden" name="fix" value="${'${escapeDecisionHtml(fixId)}'}"><input type="hidden" name="action" value="${'${action}'}"><div class="actions"><button class="${'${action === "approve" ? "approve" : "deny"}'}" type="submit">${'${escapeDecisionHtml(verb)}'}</button><a class="secondary" href="/athena">Cancel</a></div></form></main></body></html>\\`);\n}\n\n`;
    next = next.replace(marker, helpers + marker);
  }
  return next;
});

console.log('Athena universal repair gates patched.');
