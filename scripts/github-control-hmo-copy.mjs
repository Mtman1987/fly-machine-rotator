#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

const execFileAsync = promisify(execFile);
const APP = 'hearmeout-main';
const APOLLO_ROOT = resolve('apollo');

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
  const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control payload must be an object.');
  if (String(value.command || '').toLowerCase() !== 'hmocopy') throw new Error('Unsupported production copy command.');
  return value;
}

async function run(program, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      encoding: 'utf8',
      timeout: options.timeout ?? 180000,
      maxBuffer: 12 * 1024 * 1024,
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
  if (!token) throw new Error('FLY_API_TOKEN is unavailable.');
  return run('flyctl', args, { ...options, env: { ...process.env, FLY_API_TOKEN: token } });
}

function parseJson(text, label) {
  try { return JSON.parse(String(text || '').trim() || 'null'); }
  catch { throw new Error(`${label} returned malformed JSON.`); }
}

function mounts(machine) {
  return Array.isArray(machine?.config?.mounts) ? machine.config.mounts : [];
}

function hasDataMount(machine) {
  return mounts(machine).some((mount) => (mount?.path ?? mount?.destination ?? null) === '/data');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function waitForSnapshot(volumeId, requestedAt) {
  const requestedMs = Date.parse(requestedAt) - 5000;
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const read = await fly(['volumes', 'snapshots', 'list', volumeId, '--app', APP, '--json']);
    if (!read.ok) throw new Error(read.stderr || 'Unable to list HearMeOut snapshots.');
    const parsed = parseJson(read.stdout, 'snapshot list');
    const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.snapshots) ? parsed.snapshots : []);
    const candidate = rows
      .filter((row) => Date.parse(String(row?.created_at ?? row?.createdAt ?? '')) >= requestedMs)
      .sort((a, b) => Date.parse(String(b?.created_at ?? b?.createdAt ?? '')) - Date.parse(String(a?.created_at ?? a?.createdAt ?? '')))[0];
    if (candidate && String(candidate?.status ?? candidate?.state ?? '') === 'created') {
      return {
        id: candidate?.id ?? null,
        status: 'created',
        createdAt: candidate?.created_at ?? candidate?.createdAt ?? null,
        storedSizeBytes: candidate?.stored_size_bytes ?? candidate?.storedSizeBytes ?? candidate?.size ?? null,
      };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5000));
  }
  throw new Error('Fresh HearMeOut volume snapshot did not reach created state in time.');
}

function parseCopySentinel(raw) {
  const match = String(raw || '').match(/HMO_COPY_JSON=([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error('HearMeOut copy probe did not return its sentinel.');
  return JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
}

async function makeApplicationCopy(machineId) {
  const source = String.raw`
(async()=>{
  const fs=require('fs'),crypto=require('crypto');
  const init=(await import('sql.js')).default;
  const SQL=await init();
  const source='/data/app.db';
  const backup='/data/app.db.bak';
  const bytes=fs.readFileSync(source);
  const db=new SQL.Database(bytes);
  const quick=db.exec('PRAGMA quick_check;')?.[0]?.values?.[0]?.[0]??'unknown';
  if(quick!=='ok')throw new Error('source quick_check failed: '+quick);
  const count=Number(db.exec('SELECT COUNT(*) FROM docs')?.[0]?.values?.[0]?.[0]||0);
  const collections=(db.exec('SELECT collection_path,COUNT(*) FROM docs GROUP BY collection_path ORDER BY collection_path')?.[0]?.values||[]).map(r=>({collection:String(r[0]),rows:Number(r[1]||0)}));
  db.close();
  const stamp=new Date().toISOString().replace(/[:.]/g,'-');
  const dir='/data/recovery'; fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const target=dir+'/apollo-hmo-'+stamp+'.db';
  const fd=fs.openSync(target,'wx',0o600); try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
  const copied=fs.readFileSync(target);
  const verify=new SQL.Database(copied); const copiedQuick=verify.exec('PRAGMA quick_check;')?.[0]?.values?.[0]?.[0]??'unknown'; verify.close();
  if(copiedQuick!=='ok')throw new Error('copied quick_check failed: '+copiedQuick);
  const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const copiedDigest=crypto.createHash('sha256').update(copied).digest('hex');
  if(digest!==copiedDigest)throw new Error('copy digest mismatch');
  let backupInfo={present:false};
  if(fs.existsSync(backup)){const b=fs.readFileSync(backup);backupInfo={present:true,bytes:b.length,sha256:crypto.createHash('sha256').update(b).digest('hex')}}
  const out={remotePath:target,bytes:bytes.length,sha256:digest,integrity:'ok',documents:count,collections,backup:backupInfo};
  process.stdout.write('HMO_COPY_JSON='+Buffer.from(JSON.stringify(out),'utf8').toString('base64'));
})().catch(e=>{process.stderr.write(String(e?.message||e));process.exitCode=1});`;
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const result = await fly(['ssh', 'console', '--app', APP, '--machine', machineId, '--command', command, '--quiet'], { timeout: 120000 });
  if (!result.ok) throw new Error(result.stderr || 'Unable to create application-consistent HearMeOut copy.');
  return parseCopySentinel(`${result.stdout}\n${result.stderr}`);
}

async function runGreenRehearsal(localDb, copyMeta, root) {
  const bundlePath = join(root, 'bundle.json');
  const bundleBuild = await run('node', ['scripts/build-hearmeout-blue-migration-bundle.mjs', localDb, bundlePath], { cwd: APOLLO_ROOT });
  if (!bundleBuild.ok) throw new Error(bundleBuild.stderr || 'Apollo migration bundle build failed.');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  if (bundle.sourceDatabaseSha256 !== copyMeta.sha256) throw new Error('Apollo bundle source hash differs from the verified Blue copy.');

  const build = await run('npm', ['run', 'build', '--silent'], { cwd: APOLLO_ROOT, timeout: 240000 });
  if (!build.ok) throw new Error(build.stderr || 'Apollo build failed before real-data rehearsal.');

  const blueImport = await import(pathToFileURL(join(APOLLO_ROOT, 'apps/hearmeout/dist/blue-import.js')).href);
  const blueApply = await import(pathToFileURL(join(APOLLO_ROOT, 'apps/hearmeout/dist/blue-import-apply.js')).href);
  const roomCore = await import(pathToFileURL(join(APOLLO_ROOT, 'apps/hearmeout/dist/room-media-core.js')).href);
  const voiceCore = await import(pathToFileURL(join(APOLLO_ROOT, 'apps/hearmeout/dist/voice-bridge.js')).href);

  const tenantId = 'green-rehearsal-hmo';
  const principal = { tenantId, userId: 'green-rehearsal-admin', displayName: 'Green rehearsal admin', roles: ['admin'] };
  const transform = blueImport.transformBlueHearMeOutActivityRoom(bundle.activityRoom, tenantId);
  const roomsPath = join(root, 'green-rooms.db');
  const voicePath = join(root, 'green-voice.db');
  const now = new Date().toISOString();

  let rooms = new roomCore.SqliteHearMeOutRoomMediaRuntime(roomsPath);
  let voice = new voiceCore.SqliteHearMeOutVoiceBridgeStore(voicePath);
  const applied = blueApply.applyBlueHearMeOutActivityRoomTransform(transform, rooms, voice, principal, now);
  rooms.close(); voice.close();

  rooms = new roomCore.SqliteHearMeOutRoomMediaRuntime(roomsPath);
  voice = new voiceCore.SqliteHearMeOutVoiceBridgeStore(voicePath);
  const room = rooms.getRoom(tenantId, 'discord-activity', now);
  const session = rooms.getSession(tenantId, 'discord-activity', 'music', now);
  const bridge = voice.get(tenantId, 'discord-activity');
  const queueCount = (session.current ? 1 : 0) + session.queue.length;
  const result = {
    roomPresent: Boolean(room?.systemRoom),
    importedQueueItems: queueCount,
    expectedQueueItems: transform.musicQueue.length,
    playbackStatus: session.playback.status,
    voiceBridgeConfigured: applied.voiceBridgeConfigured,
    voiceBridgeEnabled: bridge.enabled,
    requiresExplicitHandoffStart: applied.requiresExplicitHandoffStart,
  };
  rooms.close(); voice.close();

  for (const path of [roomsPath, voicePath]) {
    const db = new DatabaseSync(path, { readOnly: true });
    const quick = String(db.prepare('PRAGMA quick_check').get()?.quick_check ?? 'unknown');
    db.close();
    if (quick !== 'ok') throw new Error(`Green rehearsal SQLite quick_check failed for ${path}.`);
  }
  if (!result.roomPresent || result.importedQueueItems !== result.expectedQueueItems || result.playbackStatus === 'playing' || result.voiceBridgeEnabled !== false) {
    throw new Error('Green rehearsal safety invariants failed.');
  }
  return { bundle, result };
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'hmo-production-copy-'));
  try {
    decodePayload(process.argv[2]);
    const machinesRead = await fly(['machines', 'list', '--app', APP, '--json']);
    if (!machinesRead.ok) throw new Error(machinesRead.stderr || 'Unable to list HearMeOut Machines.');
    const machines = parseJson(machinesRead.stdout, 'HearMeOut Machines list');
    const active = (Array.isArray(machines) ? machines : []).filter((machine) => machine?.state === 'started' && hasDataMount(machine));
    if (active.length !== 1) throw new Error(`Expected exactly one started HearMeOut /data Machine; found ${active.length}.`);
    const machine = active[0];
    const dataMount = mounts(machine).find((mount) => (mount?.path ?? mount?.destination ?? null) === '/data');
    const volumeId = String(dataMount?.volume || '');
    if (!volumeId) throw new Error('HearMeOut active Machine has no identifiable /data volume.');

    const snapshotRequestedAt = new Date().toISOString();
    const snapshotCreate = await fly(['volumes', 'snapshots', 'create', volumeId]);
    if (!snapshotCreate.ok) throw new Error(snapshotCreate.stderr || 'Unable to request fresh HearMeOut volume snapshot.');
    const snapshot = await waitForSnapshot(volumeId, snapshotRequestedAt);

    const copy = await makeApplicationCopy(String(machine.id));
    const localDb = join(root, 'blue-app.db');
    const download = await fly(['ssh', 'sftp', 'get', copy.remotePath, localDb, '--app', APP, '--machine', String(machine.id), '--quiet'], { timeout: 120000 });
    if (!download.ok) throw new Error(download.stderr || 'Unable to download verified HearMeOut recovery copy to isolated runner.');
    const localSha = sha256(readFileSync(localDb));
    if (localSha !== copy.sha256) throw new Error('Downloaded HearMeOut copy failed SHA-256 verification.');

    const rehearsal = await runGreenRehearsal(localDb, copy, root);
    const collectionMap = Object.fromEntries(copy.collections.map((entry) => [entry.collection, entry.rows]));
    const output = {
      ok: true,
      productionMutationApproved: true,
      blueRemainsAuthoritative: true,
      providerTrafficChanged: false,
      dnsChanged: false,
      snapshot: { volumeId, ...snapshot },
      applicationRecoveryPoint: {
        remotePath: copy.remotePath,
        bytes: copy.bytes,
        sha256: copy.sha256,
        integrity: copy.integrity,
        backupPreserved: copy.backup?.present === true,
        backupBytes: copy.backup?.bytes ?? null,
        backupSha256: copy.backup?.sha256 ?? null,
      },
      sourceShape: {
        documents: copy.documents,
        config: Number(collectionMap.config || 0),
        rooms: Number(collectionMap.rooms || 0),
        roomPresence: Number(collectionMap['rooms/discord-activity/users'] || 0),
        users: Number(collectionMap.users || 0),
      },
      migrationBundle: {
        sourceDatabaseSha256: rehearsal.bundle.sourceDatabaseSha256,
        sourceDocuments: rehearsal.bundle.sourceDocuments,
        spmtUserDocuments: rehearsal.bundle.reconciliation.spmtUserDocuments,
        rebuildPresenceDocuments: rehearsal.bundle.reconciliation.rebuildPresenceDocuments,
        legacyConfigDocuments: rehearsal.bundle.legacyConfig.documents,
        legacyConfigIncludedInGreen: rehearsal.bundle.legacyConfig.includedInActiveGreenState,
      },
      isolatedGreenRehearsal: rehearsal.result,
      runnerCopyDeletedOnExit: true,
    };
    process.stdout.write(JSON.stringify(output, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, blueRemainsAuthoritative: true, providerTrafficChanged: false, dnsChanged: false, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void main();
