#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { randomBytes, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'hmo-dj-worker';
const SOURCE_SHA = '3832931fb0991d74ee8734f2fbc6a27058eaea38';
const TENANT = 'apollo-canary';
const ROOM = 'rtc-empty-test-room';
const SOURCE_DIR = 'hmo-source';

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/((?:token|authorization|secret|password|SPMT_RTC_CANARY_SECRET))\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 12000);
}
function decodePayload(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || String(value.command || '').toLowerCase() !== 'hmortcstage') throw new Error('Unsupported HMO RTC stage command.');
}
async function run(program, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, { cwd: options.cwd, env: options.env || process.env, encoding: 'utf8', timeout: options.timeout ?? 180000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || ''), stderr: redact(error?.stderr || error?.message || error) };
  }
}
async function fly(args, options = {}) {
  const token = String(process.env.FLY_API_TOKEN || ''); if (!token) throw new Error('FLY_API_TOKEN is unavailable.');
  return run('flyctl', args, { ...options, env: { ...process.env, FLY_API_TOKEN: token } });
}
function ticket(secret, participantId, role) {
  const expiresAt = Date.now() + 60000;
  const signature = createHmac('sha256', secret).update([TENANT, ROOM, participantId, role, String(expiresAt)].join('\n')).digest('base64url');
  return { expiresAt, value: `spmt-rtc-auth.${expiresAt}.${signature}` };
}
function socketUrl(participantId, role) {
  const url = new URL('wss://hmo-dj-worker.fly.dev/v1/hearmeout/rtc');
  for (const [key, value] of Object.entries({ tenantId: TENANT, roomId: ROOM, participantId, role })) url.searchParams.set(key, value);
  return url;
}
function wait(socket, event, label) { return new Promise((resolve, reject) => { const timer = setTimeout(() => { cleanup(); reject(new Error(`${label} timeout`)); }, 15000); const good = (value) => { cleanup(); resolve(value); }; const bad = () => { cleanup(); reject(new Error(`${label} socket error`)); }; const cleanup = () => { clearTimeout(timer); socket.removeEventListener(event, good); socket.removeEventListener('error', bad); }; socket.addEventListener(event, good, { once: true }); socket.addEventListener('error', bad, { once: true }); }); }
async function proveRelay(secret) {
  const aTicket = ticket(secret, 'rotator-probe-a', 'browser');
  const bTicket = ticket(secret, 'rotator-probe-b', 'persona');
  const a = new WebSocket(socketUrl('rotator-probe-a', 'browser'), ['spmt-rtc-v1', aTicket.value]);
  const b = new WebSocket(socketUrl('rotator-probe-b', 'persona'), ['spmt-rtc-v1', bTicket.value]);
  b.binaryType = 'arraybuffer';
  try {
    await Promise.all([wait(a, 'open', 'relay client A open'), wait(b, 'open', 'relay client B open')]);
    const received = wait(b, 'message', 'relay frame');
    const proof = new Uint8Array([83, 80, 77, 84, 82, 84, 67]);
    a.send(proof);
    const event = await received;
    const bytes = new Uint8Array(event.data);
    if (bytes.length !== proof.length || bytes.some((value, index) => value !== proof[index])) throw new Error('SPMT RTC relay payload mismatch');
    return { connected: true, binaryRelayVerified: true, bytes: proof.length };
  } finally { try { a.close(); } catch {} try { b.close(); } catch {} }
}
async function waitForHealth() {
  let last = '';
  for (let attempt = 0; attempt < 18; attempt += 1) {
    try { const response = await fetch('https://hmo-dj-worker.fly.dev/health', { signal: AbortSignal.timeout(5000) }); if (response.ok) return true; last = `HTTP ${response.status}`; } catch (error) { last = String(error?.message || error); }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`HMO worker health did not recover: ${redact(last)}`);
}

async function main() {
  try {
    decodePayload(process.argv[2]);
    const source = await run('git', ['rev-parse', 'HEAD'], { cwd: SOURCE_DIR });
    if (!source.ok || source.stdout.trim() !== SOURCE_SHA) throw new Error('Checked-out HMO source does not match the reviewed canary commit.');
    const machines = await fly(['machines', 'list', '--app', APP, '--json']);
    if (!machines.ok) throw new Error(machines.stderr || 'Unable to inspect HMO worker Machines.');
    const parsed = JSON.parse(machines.stdout || '[]');
    const active = (Array.isArray(parsed) ? parsed : []).filter((machine) => machine?.state === 'started');
    if (active.length !== 1) throw new Error(`Expected exactly one started HMO worker before canary deploy; found ${active.length}.`);

    const secret = randomBytes(32).toString('base64url');
    const staged = await fly(['secrets', 'set', '--stage', '--app', APP, `SPMT_RTC_AUTH_MODE=canary-hmac`, `SPMT_RTC_CANARY_SECRET=${secret}`, `SPMT_RTC_CANARY_TENANT=${TENANT}`, `SPMT_RTC_CANARY_ROOM=${ROOM}`]);
    if (!staged.ok) throw new Error(staged.stderr || 'Unable to stage HMO RTC canary secrets.');
    const deployed = await fly(['deploy', '.', '--remote-only', '--config', 'worker/fly.toml', '--strategy', 'immediate', '--yes'], { cwd: SOURCE_DIR, timeout: 900000 });
    if (!deployed.ok) throw new Error(deployed.stderr || 'HMO RTC worker-only deploy failed.');
    await waitForHealth();
    const relay = await proveRelay(secret);
    process.stdout.write(JSON.stringify({ ok: true, app: APP, workerOnlyDeploy: true, sourceSha: SOURCE_SHA, tenant: TENANT, room: ROOM, blueMainRedeployed: false, dnsChanged: false, discordVoiceTouched: false, liveKitUsed: false, additionalMachineCreated: false, ...relay }, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, app: APP, workerOnlyDeploy: true, sourceSha: SOURCE_SHA, blueMainRedeployed: false, dnsChanged: false, discordVoiceTouched: false, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
