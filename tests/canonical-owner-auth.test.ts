import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function source(relative: string) {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('canonical SPMT owner auth', () => {
  it('uses SPMT admin auth for Athena/Rotator owner surfaces', () => {
    const gateway = source('src/athenaSpmtGateway.ts');
    expect(gateway).toContain('import { requireSpmtAdmin } from "./spmtAuth.js";');
    expect(gateway).not.toContain('hasMountainViewAdminSession');
    expect(gateway).toContain('/auth/spmt/login?next=${next}');
    expect(gateway).not.toContain('headers["x-rotator-action-token"]');
    expect(gateway).not.toContain('headers["x-codex-worker-secret"] = secret');
  });

  it('does not require the legacy Rotator action token for owner actions', () => {
    const dashboard = source('src/dashboardServer.ts');
    expect(dashboard).toContain('export async function authorizeAction');
    expect(dashboard).toContain('await requireSpmtAdmin(request, env)');
    expect(dashboard).not.toContain('Invalid rotator dashboard action token.');
    expect(dashboard).not.toContain('ROTATOR_DASHBOARD_ACTION_TOKEN is not configured');
  });

  it('allows authenticated owner Codex writes without translating identity into a worker secret', () => {
    const coder = source('src/publicCodexFixer.ts');
    expect(coder).toContain('const ownerWriteAuth = method !== "GET" && await requireSpmtAdmin(request, env);');
  });
});
