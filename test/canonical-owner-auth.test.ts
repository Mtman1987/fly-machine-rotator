import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relative: string) {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('canonical SPMT owner auth', () => {
  it('uses SPMT admin auth for Athena/Rotator owner surfaces without per-proxy identity lookups', () => {
    const gateway = source('src/athenaSpmtGateway.ts');
    expect(gateway).toContain('import { requireSpmtAdmin } from "./spmtAuth.js";');
    expect(gateway).not.toContain('hasMountainViewAdminSession');
    expect(gateway).toContain('/auth/spmt/login?next=${next}');
    expect(gateway).not.toContain('const authenticated = await requireSpmtAdmin(incoming, env);');
    expect(gateway).not.toContain('headers["x-rotator-action-token"]');
    expect(gateway).not.toContain('headers["x-codex-worker-secret"] = secret');
    expect(gateway).toContain('delete headers["x-rotator-internal"]');
  });

  it('uses SPMT for browser actions and a loopback-only marker for same-process actions', () => {
    const dashboard = source('src/dashboardServer.ts');
    expect(dashboard).toContain('export async function authorizeAction');
    expect(dashboard).toContain('await requireSpmtAdmin(request, env)');
    expect(dashboard).toContain('request.socket?.remoteAddress');
    expect(dashboard).toContain('marker === "same-process"');
    expect(dashboard).not.toContain('Invalid rotator dashboard action token.');
    expect(dashboard).not.toContain('ROTATOR_DASHBOARD_ACTION_TOKEN is not configured');
    expect(dashboard).not.toContain('/mountainview/auth/login?next=%2F');
  });

  it('removes the shared action token from automated and manual repair self-calls', () => {
    const trigger = source('src/athenaIncidentTrigger.ts');
    const repairUi = source('src/athenaRepairUi.ts');
    expect(trigger).toContain('"x-rotator-internal": "same-process"');
    expect(repairUi).toContain('"x-rotator-internal": "same-process"');
    expect(trigger).not.toContain('ROTATOR_DASHBOARD_ACTION_TOKEN');
    expect(repairUi).not.toContain('ROTATOR_DASHBOARD_ACTION_TOKEN');
    expect(trigger).not.toContain('x-rotator-action-token');
    expect(repairUi).not.toContain('x-rotator-action-token');
  });

  it('keeps authenticated owner Codex writes same-origin without translating identity into a worker secret', () => {
    const coder = source('src/publicCodexFixer.ts');
    expect(coder).toContain('const ownerWriteAuth = method !== "GET" && await ownerUiAuthorized(request, env);');
    expect(coder).toContain('return isSameOriginUiRequest(request) && await requireSpmtAdmin(request, env);');
  });
});
