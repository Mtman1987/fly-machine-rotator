import assert from 'node:assert/strict';
import test from 'node:test';
import { mtFixItKnownFixSignature } from '../src/mtfixitResolution.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('known-fix signature is stable for the same normalized report and repo', () => {
  const left = mtFixItKnownFixSignature({ repoId: 'discord-stream-hub', description: `I can't tag people   even though im it` });
  const right = mtFixItKnownFixSignature({ repoId: 'discord-stream-hub', description: `  i can't tag people even though im it  ` });
  assert.equal(left, right);
  assert.notEqual(left, mtFixItKnownFixSignature({ repoId: 'streamweaver', description: `I can't tag people even though im it` }));
});

test('resolution workflow only learns known fixes after verified deployment and gates new fixes', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/mtfixitResolution.ts'), 'utf8');
  assert.match(source, /status: known \? "deploying" : "awaiting_approval"/);
  assert.match(source, /await verifyDeployment\(/);
  assert.match(source, /state\.status = "deployed"/);
  assert.match(source, /await rememberKnownFix\(env, job, state\)/);
  assert.doesNotMatch(source, /rememberKnownFix\([^\n]+awaiting_approval/);
  assert.match(source, /action === "deny"/);
});

test('resolution route stays behind the authenticated DSH mtfixit gateway', () => {
  const gateway = readFileSync(resolve(process.cwd(), 'src/dshMtFixitGateway.ts'), 'utf8');
  const authIndex = gateway.indexOf('if (!isDshMtFixItAuthorized(request, env))');
  const resolutionIndex = gateway.indexOf('handleMtFixItResolutionRequest');
  assert.ok(authIndex >= 0);
  assert.ok(resolutionIndex >= 0);
  assert.ok(authIndex < gateway.lastIndexOf('handleMtFixItResolutionRequest'));
});
