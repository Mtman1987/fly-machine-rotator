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

test('resolution workflow learns known fixes only after verified deployment while all validated repairs enter ChatGPT review', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /status: 'awaiting_chatgpt'/);
  assert.match(source, /return queueMtFixItForChatGpt\(job, env, dashboardPort, signature\)/);
  assert.match(source, /approveChatGptHandoff\(env, handoff\.id, 'mtfixit-standing-policy'\)/);
  assert.match(source, /await verifyDeployment\(/);
  assert.match(source, /state\.status = "deployed"/);
  assert.match(source, /await rememberKnownFix\(env, job, state\)/);
  assert.doesNotMatch(source, /status: known \? "deploying" : "awaiting_approval"/);
});

test('known-fix history remains evidence for learning but cannot bypass ChatGPT review', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /jobs\/\$\{jobId\}\/diff\.patch/);
  assert.match(source, /createHash\("sha256"\)\.update\(patch\)/);
  assert.match(source, /existing = values\.find\(\(item\) => item\.signature === state\.signature && item\.patchHash === state\.patchHash\)/);
  assert.match(source, /patchHash: state\.patchHash/);
  assert.doesNotMatch(source, /item\.patchHash === patchHash/);
  assert.doesNotMatch(source, /Boolean\(patchHash\).*known/s);
});

test('legacy deployment helper still uses the supported GitHub GraphQL ready-for-review mutation', () => {
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
