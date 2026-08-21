#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MANAGED_APPS = [
  'chat-tag-bot-new',
  'chat-tag-new',
  'discord-stream-hub-new',
  'dsh-clip-worker',
  'hearmeout-main',
  'hmo-dj-worker',
  'streamweaver-new',
];
const ROTATOR_APP = 'mtman-machine-rotator';
const STREAMWEAVER_APP = 'streamweaver-new';

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]')
    .slice(0, 8000);
}

function decodePayload(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  if (raw.length > 8000) throw new Error('Control payload is too large.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control payload must be an object.');
  return value;
}

function text(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function limit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

function requireApp(value) {
  const app = text(value);
  if (!app) return undefined;
  if (!MANAGED_APPS.includes(app)) throw new Error(`App ${app} is not in the managed Rotator allowlist.`);
  return app;
}

async function fly(args, options = {}) {
  const env = { ...process.env, FLY_API_TOKEN: String(process.env.FLY_API_TOKEN || '') };
  if (!env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is not available to the GitHub control workflow.');
  try {
    const { stdout, stderr } = await execFileAsync('flyctl', args, {
      env,
      encoding: 'utf8',
      timeout: options.timeout ?? 120000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ''),
      stderr: redact(error?.stderr || error?.message || error),
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
    };
  }
}

function safeMachine(machine) {
  return {
    id: machine?.id ?? null,
    name: machine?.name ?? null,
    state: machine?.state ?? null,
    region: machine?.region ?? null,
    createdAt: machine?.created_at ?? null,
    updatedAt: machine?.updated_at ?? null,
  };
}

async function readStates(appName) {
  const apps = appName ? [appName] : MANAGED_APPS;
  const results = [];
  for (const app of apps) {
    const result = await fly(['machines', 'list', '--app', app, '--json']);
    if (!result.ok) {
      results.push({ appName: app, ok: false, error: result.stderr || 'flyctl machines list failed' });
      continue;
    }
    let machines = [];
    try { machines = JSON.parse(result.stdout || '[]'); }
    catch { results.push({ appName: app, ok: false, error: 'Fly returned malformed machine JSON.' }); continue; }
    const safe = Array.isArray(machines) ? machines.map(safeMachine) : [];
    results.push({
      appName: app,
      ok: true,
      machineCount: safe.length,
      activeCount: safe.filter((m) => ['started', 'starting'].includes(String(m.state))).length,
      machines: safe,
    });
  }
  return { generatedAt: new Date().toISOString(), apps: results };
}

async function rotate() {
  const run = await fly(['ssh', 'console', '--app', ROTATOR_APP, '--command', 'node dist/index.js run'], { timeout: 20 * 60 * 1000 });
  const states = await readStates();
  return {
    ok: run.ok && states.apps.every((app) => app.ok && app.activeCount === 1),
    rotationExitCode: run.ok ? 0 : run.exitCode ?? 1,
    rotationError: run.ok ? undefined : (run.stderr || 'Rotator command failed.'),
    states,
  };
}

const SIGNAL_SCRIPT = String.raw`
const fs=require('fs'),path=require('path');
const root=process.env.PERSIST_ROOT||path.resolve(process.cwd(),'data','runtime');
const g=path.join(root,'global');
const h=path.join(g,'signal-hint-history.json');
const s=path.join(g,'signal-scheduler.json');
const limit=Math.min(100,Math.max(1,Number(process.argv[1]||25)||25));
const read=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const hist=read(h,{totalPosts:0,uniqueChannelIds:[],history:[]});
const sched=read(s,null);
const list=Array.isArray(hist.history)?hist.history.slice(-limit):[];
process.stdout.write(JSON.stringify({totalPosts:Number(hist.totalPosts||0),uniqueChannelCount:Array.isArray(hist.uniqueChannelIds)?new Set(hist.uniqueChannelIds.map(String)).size:0,lastPostAt:hist.lastPostAt||null,latestPosts:list.map(x=>({at:String(x?.at||''),guildId:String(x?.guildId||''),channelId:String(x?.channelId||''),channelName:String(x?.channelName||'').slice(0,120)})),scheduler:sched?{guildId:String(sched.guildId||''),lastChannelId:String(sched.lastChannelId||''),bagRemaining:Array.isArray(sched.bag)?sched.bag.length:0,nextAt:Number(sched.nextAt||0)||null,nextAtIso:Number(sched.nextAt||0)>0?new Date(Number(sched.nextAt)).toISOString():null}:null,historyFilePresent:fs.existsSync(h),schedulerFilePresent:fs.existsSync(s)}));
`;

async function signalHistory(requestedLimit) {
  const list = await fly(['machines', 'list', '--app', STREAMWEAVER_APP, '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list StreamWeaver machines.');
  const machines = JSON.parse(list.stdout || '[]');
  const machine = Array.isArray(machines) ? (machines.find((m) => m.state === 'started') || machines.find((m) => m.state === 'starting')) : null;
  if (!machine?.id) throw new Error('No active StreamWeaver machine is available for Signal history.');
  const count = limit(requestedLimit, 25, 100);
  const read = await fly(['machine', 'exec', '--app', STREAMWEAVER_APP, machine.id, 'node', '-e', SIGNAL_SCRIPT, String(count)]);
  if (!read.ok) throw new Error(read.stderr || 'Signal history read failed.');
  let payload;
  try { payload = JSON.parse(read.stdout.trim()); }
  catch { throw new Error('Signal history returned malformed JSON.'); }
  return { ok: true, appName: STREAMWEAVER_APP, machineId: machine.id, readAt: new Date().toISOString(), limit: count, ...payload };
}

function parseJsonLines(raw) {
  const rows = [];
  for (const line of String(raw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { rows.push(JSON.parse(trimmed)); }
    catch { rows.push({ message: redact(trimmed) }); }
  }
  return rows;
}

async function logs(appName, requestedLimit, errorsOnly) {
  const apps = appName ? [appName] : MANAGED_APPS;
  const max = limit(requestedLimit, 50, 200);
  const pattern = /\berror\b|\bexception\b|\bfatal\b|\bpanic\b|\bfailed\b|\bunhandled\b|\brejection\b/i;
  const result = [];
  for (const app of apps) {
    const read = await fly(['logs', '--app', app, '--json', '--no-tail'], { timeout: 60000 });
    if (!read.ok) { result.push({ appName: app, ok: false, error: read.stderr || 'fly logs failed' }); continue; }
    const entries = parseJsonLines(read.stdout).map((entry) => ({
      timestamp: entry.timestamp || entry.time || entry.ts || null,
      machineId: entry.machine_id || entry.machine || entry.instance || null,
      region: entry.region || null,
      level: entry.level || null,
      message: redact(entry.message || entry.msg || entry.log || entry.event || JSON.stringify(entry)),
    })).filter((entry) => !errorsOnly || pattern.test(entry.message)).slice(-max);
    result.push({ appName: app, ok: true, count: entries.length, logs: entries });
  }
  return { ok: result.every((row) => row.ok), sampledAt: new Date().toISOString(), errorsOnly: Boolean(errorsOnly), apps: result };
}

async function repair(payload) {
  const appName = requireApp(payload.appName);
  const description = text(payload.description, 4000);
  if (!appName || !description) throw new Error('repair requires an allowlisted app and a problem description.');
  const encoded = Buffer.from(JSON.stringify({ appName, description }), 'utf8').toString('base64');
  const remote = `node -e "const{spawnSync}=require('child_process');const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));const r=spawnSync('node',['scripts/athena-code.mjs','submit',p.appName,p.description],{encoding:'utf8'});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status??1)" '${encoded}'`;
  const run = await fly(['ssh', 'console', '--app', ROTATOR_APP, '--command', remote], { timeout: 120000 });
  if (!run.ok) throw new Error(run.stderr || 'Athena repair submission failed.');
  let result = run.stdout.trim();
  const jsonStart = result.indexOf('{');
  if (jsonStart >= 0) {
    try { result = JSON.parse(result.slice(jsonStart)); } catch { result = redact(result); }
  } else result = redact(result);
  return { ok: true, source: 'rotator-athena-cli', appName, result };
}

export async function execute(payload) {
  const command = text(payload.command, 40).toLowerCase();
  if (command === 'states') return { ok: true, ...(await readStates(requireApp(payload.appName))) };
  if (command === 'rotate') return await rotate();
  if (command === 'signal') return await signalHistory(payload.limit);
  if (command === 'logs') return await logs(requireApp(payload.appName), payload.limit, payload.errorsOnly === true);
  if (command === 'repair') return await repair(payload);
  throw new Error('Unsupported command.');
}

async function main() {
  try {
    const payload = decodePayload(process.argv[2]);
    const result = await execute(payload);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) void main();
