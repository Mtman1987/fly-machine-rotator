import assert from 'node:assert/strict';
import { test } from 'vitest';
import { mtFixItKnownFixSignature } from '../src/mtfixitResolution.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('known-fix signature is stable for the same normalized report and repo', () => {
  const left = mtFixItKnownFixSignature({ repoId: 'discord-stream-hub', description: `I can't tag people   even though im it` });
  const right = mtFixItKnownFixSignature({ repoId: 'discord-stream-hub', description: `  i can't tag people even though im it  ` });
  assert.equal(left, right);
  assert.notEqual(left, mtFixItKnownFixSignature({ repoId: 'streamweaver', description: `I can't tag people even though im it` }));
});

test('resolution workflow auto-deploys validated fixes and verifies deployment', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /const known = Boolean\(patchHash\).*item\.patchHash === patchHash/s);
  assert.match(source, /status: "deploying"/);
  assert.match(source, /void deployInBackground\(job, env, dashboardPort, state\)/);
  assert.match(source, /export async function applyMtFixItResolutionAction/);
  assert.match(source, /await verifyDeployment\(/);
  assert.match(source, /state\.status = "deployed"/);
  assert.match(source, /await rememberKnownFix\(env, job, state\)/);
  assert.match(source, /waitForPullRequestChecks\(repo, pullRequest\.number, env\)/);
  assert.match(source, /const checksPass = job\.checks\.length > 0 && job\.checks\.every\(\(check\) => check\.ok\)/);
});

test('known-fix history requires the same repo signature and exact patch hash', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /jobs\/\$\{jobId\}\/diff\.patch/);
  assert.match(source, /createHash\("sha256"\)\.update\(patch\)/);
  assert.match(source, /item\.signature === signature && item\.repoId === job\.repoId && item\.patchHash === patchHash/);
  assert.match(source, /patchHash: state\.patchHash/);
});

test('deployment helper uses the supported GitHub GraphQL ready-for-review mutation', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /markPullRequestReadyForReview/);
  assert.match(source, /pull\.node_id/);
  assert.doesNotMatch(source, /\/ready_for_review/);
});

test('resolution route stays behind scoped SPMT service auth or legacy compatibility auth', () => {
  const gateway = readFileSync(resolve(process.cwd(), 'src/dshMtFixitGateway.ts'), 'utf8');
  const serviceAuthIndex = gateway.indexOf('isDshMtFixItServiceAuthorized(request, env)');
  const legacyAuthIndex = gateway.indexOf('isDshMtFixItAuthorized(request, env)');
  const denialIndex = gateway.indexOf('if (!serviceAuthorized && !legacyAuthorized)');
  const resolutionIndex = gateway.lastIndexOf('handleMtFixItResolutionRequest');
  assert.ok(serviceAuthIndex >= 0);
  assert.ok(legacyAuthIndex >= 0);
  assert.ok(denialIndex >= 0);
  assert.ok(resolutionIndex >= 0);
  assert.ok(serviceAuthIndex < resolutionIndex);
  assert.ok(legacyAuthIndex < resolutionIndex);
  assert.ok(denialIndex < resolutionIndex);
});

test('new repairs must meet the configured confidence threshold before automatic promotion', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /MTFIXIT_CONFIDENCE_THRESHOLD/);
  assert.match(source, /confidencePercent < confidenceThreshold/);
  assert.match(source, /state\.status = "awaiting_approval"/);
  assert.match(source, /confidencePercent/);
});

test('failed incidents remain eligible for retry until the three-attempt blacklist is reached', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/hourlyAthenaDiagnostic.ts'), 'utf8');
  assert.match(source, /cycles\.filter\(\(cycle\) => cycle\.status !== "failed"\)/);
  assert.match(source, /\(failedAttempts\.get\(key\) \|\| 0\) < 3/);
});

test('pull-request validation includes the offline mock-chat sandbox as a required check', () => {
  const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/mtfixit-validation.yml'), 'utf8');
  assert.match(workflow, /offline-sandbox:/);
  assert.match(workflow, /needs: validate/);
  assert.match(workflow, /test\/unifiedReport\.test\.ts/);
});
