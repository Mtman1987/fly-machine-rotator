import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { mtFixItKnownFixSignature } from '../src/mtfixitResolution.js';

const fixture = {
  id: 'mtfix_12345678',
  status: 'completed' as const,
  source: 'discord',
  reporter: 'tester',
  appName: 'discord-stream-hub-new',
  repoId: 'discord-stream-hub',
  description: 'Overlay does not update after a pack open.',
  summary: 'Fix generated.',
  changedFiles: ['src/example.ts'],
  checks: [{ command: 'npm test', ok: true, output: 'ok' }],
};

describe('MtFixIt resolution contracts', () => {
  test('known-fix signature is stable for the same normalized report and repo', () => {
    expect(mtFixItKnownFixSignature(fixture)).toBe(mtFixItKnownFixSignature({ ...fixture }));
    expect(mtFixItKnownFixSignature({ ...fixture, repoId: 'other-repo' })).not.toBe(mtFixItKnownFixSignature(fixture));
  });

  test('resolution workflow only learns known fixes after verified deployment and gates new fixes', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
    expect(source).toMatch(/status: "awaiting_approval"/);
    expect(source).toMatch(/await verifyDeployment/);
    expect(source).toMatch(/await rememberKnownFix/);
    expect(source.indexOf('await verifyDeployment')).toBeLessThan(source.indexOf('await rememberKnownFix'));
  });

  test('known fix auto-deploy requires the exact regenerated diff.patch fingerprint', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
    expect(source).toMatch(/jobPatchHash/);
    expect(source).toMatch(/item\.patchHash === patchHash/);
  });

  test('approved draft repairs use the supported GitHub GraphQL ready-for-review mutation', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
    expect(source).toMatch(/markPullRequestReadyForReview/);
    expect(source).toMatch(/pull\.node_id/);
    expect(source).not.toMatch(/\/ready_for_review/);
  });

  test('resolution route stays behind scoped SPMT service auth or legacy compatibility auth', () => {
    const gateway = readFileSync(resolve(process.cwd(), 'src/dshMtFixitGateway.ts'), 'utf8');
    const serviceAuthIndex = gateway.indexOf('isDshMtFixItServiceAuthorized(request, env)');
    const legacyAuthIndex = gateway.indexOf('isDshMtFixItAuthorized(request, env)');
    const denialIndex = gateway.indexOf('if (!serviceAuthorized && !legacyAuthorized)');
    const resolutionIndex = gateway.lastIndexOf('handleMtFixItResolutionRequest');
    expect(serviceAuthIndex).toBeGreaterThanOrEqual(0);
    expect(legacyAuthIndex).toBeGreaterThanOrEqual(0);
    expect(denialIndex).toBeGreaterThanOrEqual(0);
    expect(resolutionIndex).toBeGreaterThanOrEqual(0);
    expect(serviceAuthIndex).toBeLessThan(resolutionIndex);
    expect(legacyAuthIndex).toBeLessThan(resolutionIndex);
    expect(denialIndex).toBeLessThan(resolutionIndex);
  });
});
