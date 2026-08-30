#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const INVENTORY_PROFILES = Object.freeze({
  'hearmeout-main': { healthUrl: 'https://hearmeout-main.fly.dev/api/health', kind: 'hearmeout-main' },
  'hmo-dj-worker': { healthUrl: 'https://hmo-dj-worker.fly.dev/health', kind: 'hmo-dj-worker' },
  'spmt-live': { healthUrl: 'https://spmt-live.fly.dev/api/health/ready', kind: 'spmt-live' },
});

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]')
    .slice(0, 12000);
}

function decodePayload(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  if (raw.length > 8000) throw new Error('Control payload is too large.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control payload must be an object.');
  return value;
}

function requireInventoryApp(value) {
  const appName = String(value || '').trim().slice(0, 120);
  if (!appName || !Object.hasOwn(INVENTORY_PROFILES, appName)) {
    throw new Error('inventory requires one approved app: hearmeout-main, hmo-dj-worker, or spmt-live.');
  }
  return appName;
}

async function run(program, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      env: options.env || process.env,
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

async function fly(args, options = {}) {
  const token = String(process.env.FLY_API_TOKEN || '');
  if (!token) throw new Error('FLY_API_TOKEN is not available to the GitHub control workflow.');
  return run('flyctl', args, { ...options, env: { ...process.env, FLY_API_TOKEN: token } });
}

function parseJson(raw, label) {
  const text = String(raw || '').trim();
  try { return JSON.parse(text || 'null'); }
  catch { throw new Error(`${label} returned malformed JSON.`); }
}

function parseFixedProbe(raw) {
  const match = String(raw || '').match(/SPMT_INVENTORY_JSON=([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error('fixed data probe did not return its inventory sentinel.');
  try {
    const value = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new Error('fixed data probe returned malformed sentinel JSON.');
  }
}

function safeMachine(machine) {
  const guest = machine?.config?.guest || machine?.guest || {};
  const mounts = Array.isArray(machine?.config?.mounts) ? machine.config.mounts : [];
  return {
    id: machine?.id ?? null,
    name: machine?.name ?? null,
    state: machine?.state ?? null,
    region: machine?.region ?? null,
    createdAt: machine?.created_at ?? null,
    updatedAt: machine?.updated_at ?? null,
    resources: { cpuKind: guest?.cpu_kind ?? null, cpus: guest?.cpus ?? null, memoryMb: guest?.memory_mb ?? null },
    mounts: mounts.map((mount) => ({ volume: mount?.volume ?? null, path: mount?.path ?? mount?.destination ?? null, name: mount?.name ?? null })),
  };
}

function safeVolume(volume) {
  return {
    id: volume?.id ?? null,
    name: volume?.name ?? null,
    region: volume?.region ?? null,
    sizeGb: volume?.size_gb ?? volume?.sizeGb ?? volume?.size ?? null,
    state: volume?.state ?? null,
    attachedMachineId: volume?.attached_machine_id ?? volume?.attachedMachineId ?? null,
    createdAt: volume?.created_at ?? volume?.createdAt ?? null,
    snapshotRetention: volume?.snapshot_retention ?? volume?.snapshotRetention ?? null,
  };
}

const COMMON_FS = String.raw`
const fs=require('fs'),path=require('path');
const emit=(value)=>process.stdout.write('SPMT_INVENTORY_JSON='+Buffer.from(JSON.stringify(value),'utf8').toString('base64'));
function file(p){try{const s=fs.statSync(p);return {present:s.isFile(),bytes:s.isFile()?s.size:null}}catch{return {present:false,bytes:null}}}
function tree(root,limit=20000){let files=0,bytes=0,truncated=false;const stack=[root];while(stack.length){const cur=stack.pop();let entries;try{entries=fs.readdirSync(cur,{withFileTypes:true})}catch{continue}for(const e of entries){const full=path.join(cur,e.name);if(e.isDirectory())stack.push(full);else if(e.isFile()){files++;try{bytes+=fs.statSync(full).size}catch{}if(files>=limit){truncated=true;return {present:true,files,bytes,truncated}}}}}return {present:fs.existsSync(root),files,bytes,truncated}}
function disk(root='/data'){try{const s=fs.statfsSync(root);return {present:true,totalBytes:Number(s.blocks)*Number(s.bsize),freeBytes:Number(s.bavail)*Number(s.bsize),usedBytes:(Number(s.blocks)-Number(s.bfree))*Number(s.bsize)}}catch{return {present:false}}}
`;

const HMO_MAIN_PROBE = COMMON_FS + String.raw`
(async()=>{const out={disk:disk(),files:{appDb:file('/data/app.db'),appDbBackup:file('/data/app.db.bak'),watchState:file('/data/watch-state.json'),watchStateBackup:file('/data/watch-state.backup.json')},directories:{watchCache:tree('/data/watch-cache'),watchHls:tree('/data/watch-hls'),music:tree('/data/music')}};try{const init=(await import('sql.js')).default;const SQL=await init();if(out.files.appDb.present){const db=new SQL.Database(fs.readFileSync('/data/app.db'));let q=db.exec('PRAGMA quick_check;');out.sqlite={integrity:q?.[0]?.values?.[0]?.[0]??'unknown'};q=db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");const tables=(q?.[0]?.values||[]).map(r=>String(r[0]));out.sqlite.tableCount=tables.length;out.sqlite.tables=tables.slice(0,100);out.sqlite.collectionRows={};if(tables.includes('docs')){const c=db.exec('SELECT COUNT(*) FROM docs');out.sqlite.collectionRows.docs=Number(c?.[0]?.values?.[0]?.[0]||0)}db.close()}}catch(e){out.sqlite={error:String(e?.message||e).slice(0,500)}}emit(out)})().catch(e=>{emit({error:String(e?.message||e).slice(0,500)});process.exitCode=1});
`;

const HMO_WORKER_PROBE = COMMON_FS + String.raw`
const out={disk:disk(),directories:{music:tree('/data/music'),watchHls:tree('/data/watch-hls'),watchCache:tree('/data/watch-cache')},files:{youtubeCookies:file('/data/youtube-cookies.txt')}};emit(out);
`;

const SPMT_PROBE = COMMON_FS + String.raw`
(async()=>{const out={disk:disk(),files:{spmtDb:file('/data/spmt.db'),spmtDbWal:file('/data/spmt.db-wal'),spmtDbShm:file('/data/spmt.db-shm')}};try{const mod=await import('better-sqlite3');const Database=mod.default;if(out.files.spmtDb.present){const db=new Database('/data/spmt.db',{readonly:true,fileMustExist:true});const integrity=String(db.pragma('quick_check',{simple:true})||'unknown');const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>String(r.name));const selectedCounts={};for(const name of ['users','messages','notifications']){if(tables.includes(name))selectedCounts[name]=Number(db.prepare('SELECT COUNT(*) AS count FROM '+name).get().count||0)}out.sqlite={integrity,tableCount:tables.length,tables:tables.slice(0,100),selectedCounts};db.close()}}catch(e){out.sqlite={error:String(e?.message||e).slice(0,500)}}emit(out)})().catch(e=>{emit({error:String(e?.message||e).slice(0,500)});process.exitCode=1});
`;

function probeFor(kind) {
  if (kind === 'hearmeout-main') return HMO_MAIN_PROBE;
  if (kind === 'hmo-dj-worker') return HMO_WORKER_PROBE;
  if (kind === 'spmt-live') return SPMT_PROBE;
  throw new Error('Unsupported inventory profile.');
}

async function readHealth(url) {
  const response = await run('curl', ['-fsS', '--max-time', '15', url], { timeout: 20000 });
  if (!response.ok) return { ok: false, error: response.stderr || 'health request failed' };
  const text = response.stdout.trim();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 1000); }
  return { ok: true, body };
}

async function inventory(appName) {
  const profile = INVENTORY_PROFILES[appName];
  const machinesRead = await fly(['machines', 'list', '--app', appName, '--json']);
  if (!machinesRead.ok) throw new Error(machinesRead.stderr || 'Unable to list Machines.');
  const machinesRaw = parseJson(machinesRead.stdout, 'Fly Machines list');
  const machines = Array.isArray(machinesRaw) ? machinesRaw : [];
  const active = machines.find((m) => m?.state === 'started') || machines.find((m) => m?.state === 'starting');

  const volumesRead = await fly(['volumes', 'list', '--app', appName, '--json']);
  const volumesRaw = volumesRead.ok ? parseJson(volumesRead.stdout, 'Fly volumes list') : [];
  const volumes = Array.isArray(volumesRaw) ? volumesRaw.map(safeVolume) : [];

  let data = { ok: false, error: 'No active Machine is available for the fixed read-only data probe.' };
  if (active?.id) {
    const fixedCommand = `node -e ${JSON.stringify(probeFor(profile.kind))}`;
    const probe = await fly(['machine', 'exec', active.id, fixedCommand, '--app', appName], { timeout: 120000 });
    if (probe.ok) data = { ok: true, ...parseFixedProbe(`${probe.stdout}\n${probe.stderr}`) };
    else data = { ok: false, error: probe.stderr || 'fixed data probe failed' };
  }

  const health = await readHealth(profile.healthUrl);
  return {
    ok: Boolean(active?.id) && data.ok && health.ok,
    readOnly: true,
    appName,
    capturedAt: new Date().toISOString(),
    machineCount: machines.length,
    activeMachineId: active?.id ?? null,
    machines: machines.map(safeMachine),
    volumeCount: volumes.length,
    volumes,
    health,
    data,
  };
}

async function main() {
  try {
    const payload = decodePayload(process.argv[2]);
    if (String(payload.command || '').toLowerCase() !== 'inventory') throw new Error('Unsupported inventory command.');
    const appName = requireInventoryApp(payload.appName);
    const result = await inventory(appName);
    process.stdout.write(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, readOnly: true, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
