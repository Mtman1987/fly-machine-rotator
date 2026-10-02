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

export function parseFlyJsonRecords(raw) {
  const source = String(raw || '');
  const rows = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let plainStart = 0;

  const flushPlain = (end) => {
    for (const line of source.slice(plainStart, end).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) rows.push({ message: redact(trimmed) });
    }
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (start < 0) {
      if (char === '{' || char === '[') {
        flushPlain(index);
        start = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') depth -= 1;

    if (depth === 0) {
      const record = source.slice(start, index + 1);
      try { rows.push(JSON.parse(record)); }
      catch { rows.push({ message: redact(record.trim()) }); }
      start = -1;
      plainStart = index + 1;
    }
  }

  if (start >= 0) {
    for (const line of source.slice(start).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) rows.push({ message: redact(trimmed) });
    }
  } else {
    flushPlain(source.length);
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
    const entries = parseFlyJsonRecords(read.stdout).map((entry) => ({
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

async function coderJobStatus(id) {
  const jobId = text(id, 120);
  if (!/^mtfix_[a-zA-Z0-9_-]{8,100}$/.test(jobId)) throw new Error('Invalid coder job id.');
  const remote = `node scripts/athena-code.mjs status ${jobId}`;
  const run = await fly(['ssh', 'console', '--app', ROTATOR_APP, '--command', remote], { timeout: 120000 });
  if (!run.ok) throw new Error(run.stderr || 'Coder job status lookup failed.');
  const raw = run.stdout.trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('Coder job status returned malformed output.');
  try { return { ok: true, job: JSON.parse(raw.slice(start)) }; }
  catch { throw new Error('Coder job status returned malformed JSON.'); }
}

async function streamStatus() {
  const list = await fly(['machines', 'list', '--app', 'hmo-dj-worker', '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list HearMeOut worker machines.');
  let machines = [];
  try { machines = JSON.parse(list.stdout || '[]'); }
  catch { throw new Error('HearMeOut worker machine list returned malformed JSON.'); }
  const active = Array.isArray(machines) ? machines.filter((m) => ['started', 'starting'].includes(String(m?.state))) : [];
  const source = `
(async()=>{
const secret=String(process.env.HMO_WORKER_SHARED_SECRET||'').trim();
if(!secret) throw Error('Worker authentication is not configured');
const r=await fetch('http://127.0.0.1:3002/restream/status',{headers:{authorization:'Bearer '+secret,accept:'application/json'},signal:AbortSignal.timeout(15000)});
const b=await r.json().catch(()=>null);
process.stdout.write(JSON.stringify({status:r.status,body:b}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const rows = [];
  for (const machine of active) {
    const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
    const run = await fly(['ssh', 'console', '--app', 'hmo-dj-worker', '--machine', String(machine.id), '--command', command, '--quiet'], { timeout: 60000 });
    const raw = String(run.stdout || '').trim();
    let payload = null;
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) { try { payload = JSON.parse(raw.slice(jsonStart)); } catch {} }
    rows.push({ machineId: machine.id, runOk: run.ok, ...(payload || {}), error: run.ok ? undefined : run.stderr });
  }
  const lounge = rows.find((row) => row.status && row.status !== 404);
  return { ok: Boolean(lounge), lounge: lounge || null, machines: rows.map(r => ({ machineId:r.machineId, status:r.status ?? null })) };
}

async function streamStart() {
  const list = await fly(['machines', 'list', '--app', 'hmo-dj-worker', '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list HearMeOut worker machines.');
  let machines = [];
  try { machines = JSON.parse(list.stdout || '[]'); }
  catch { throw new Error('HearMeOut worker machine list returned malformed JSON.'); }
  const active = Array.isArray(machines) ? machines.filter((m) => ['started', 'starting'].includes(String(m?.state))) : [];
  if (!active.length) throw new Error('No active HearMeOut worker machine is available.');

  const source = `
(async()=>{
const secret=String(process.env.HMO_WORKER_SHARED_SECRET||'').trim();
if(!secret) throw Error('Lounge worker authentication is not configured');
const headers={authorization:'Bearer '+secret,accept:'application/json','content-type':'application/json'};
async function call(path,init={}){const r=await fetch('http://127.0.0.1:3002'+path,{...init,headers:{...headers,...(init.headers||{})},signal:AbortSignal.timeout(90000)});const b=await r.json().catch(()=>null);return {r,b}}
const before=await call('/restream/status');
if(before.r.status===404){process.stdout.write(JSON.stringify({skip:true,reason:'not-lounge'}));return}
if(!before.r.ok) throw Error('Restream controller status failed ('+before.r.status+')');
if(before.b?.automationEnabled!==true) throw Error('Restream automation is not enabled (state='+String(before.b?.state||'unknown')+')');
if(before.b?.state==='live'){process.stdout.write(JSON.stringify({ok:true,reason:'Restream is already live',before:before.b,after:before.b}));return}
if(before.b?.state!=='offline') throw Error('Restream is not in a recognized offline state (state='+String(before.b?.state||'unknown')+')');
const started=await call('/restream/start',{method:'POST',body:'{}'});
if(!started.r.ok||started.b?.ok===false) throw Error(String(started.b?.error||('Restream start failed ('+started.r.status+')')));
const after=await call('/restream/status');
if(!after.r.ok||after.b?.state!=='live') throw Error('Restream did not reach a recognized live state after start');
process.stdout.write(JSON.stringify({ok:true,reason:'Restream is live',before:before.b,after:after.b,startedWith:started.b?.startedWith||null}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const results = [];
  for (const machine of active) {
    const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
    const run = await fly(['ssh', 'console', '--app', 'hmo-dj-worker', '--machine', String(machine.id), '--command', command, '--quiet'], { timeout: 150000 });
    const raw = String(run.stdout || '').trim();
    let payload = null;
    const jsonStart = raw.indexOf('{');
    if (jsonStart >= 0) { try { payload = JSON.parse(raw.slice(jsonStart)); } catch {} }
    if (run.ok && payload?.ok) return { ...payload, machineId: machine.id };
    if (run.ok && payload?.skip) { results.push({ machineId: machine.id, ...payload }); continue; }
    results.push({ machineId: machine.id, ok: false, error: run.stderr || 'Worker command failed.' });
  }
  throw new Error('No Lounge worker completed the Restream start: ' + redact(JSON.stringify(results)));
}



async function spotlightStatus() {
  const app = 'hmo-dj-worker';
  const list = await fly(['machines', 'list', '--app', app, '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list HearMeOut worker machines.');
  let machines = [];
  try { machines = JSON.parse(list.stdout || '[]'); }
  catch { throw new Error('HearMeOut worker machine list returned malformed JSON.'); }
  const processGroup = (machine) => String(
    machine?.process_group ??
    machine?.config?.metadata?.fly_process_group ??
    machine?.config?.metadata?.['fly_process_group'] ??
    machine?.config?.env?.FLY_PROCESS_GROUP ??
    ''
  ).toLowerCase();
  const spotlight = Array.isArray(machines) ? machines.find((m) => processGroup(m) === 'spotlight') : null;
  if (!spotlight?.id) throw new Error('Could not identify the Spotlight process-group Machine.');

  const source = `
(async()=>{
const secret=String(process.env.HMO_WORKER_SHARED_SECRET||'').trim();
const headers=secret?{authorization:'Bearer '+secret,accept:'application/json'}:{accept:'application/json'};
const r=await fetch('http://127.0.0.1:3002/spotlight/status',{headers,signal:AbortSignal.timeout(15000)});
const b=await r.json().catch(()=>null);
const fs=require('fs');
const safeRead=p=>{try{return fs.readFileSync(p,'utf8')}catch{return ''}};
const folder=b?.generation?'/tmp/spotlight-hls/'+b.generation:'';
const files=folder&&fs.existsSync(folder)?fs.readdirSync(folder).slice(0,25).map(name=>({name,bytes:fs.statSync(folder+'/'+name).size})):[];
const processes=fs.readdirSync('/proc').filter(id=>/^\\d+$/.test(id)&&safeRead('/proc/'+id+'/comm').trim()==='ffmpeg').map(id=>({pid:Number(id),wait:safeRead('/proc/'+id+'/wchan').trim(),io:safeRead('/proc/'+id+'/io'),stat:safeRead('/proc/'+id+'/stat')}));
let sourceProbe=null;
const relayProcess=processes.find(process=>safeRead('/proc/'+process.pid+'/cmdline').split(String.fromCharCode(0)).includes(folder+'/index.m3u8'));
let argv;
if(relayProcess)argv=safeRead('/proc/'+relayProcess.pid+'/cmdline').split(String.fromCharCode(0));
else if(/^[a-z0-9_]{1,25}$/.test(b?.currentLogin||'')){
  const {execFile}=require('child_process');
  const url=await new Promise((resolve,reject)=>execFile('yt-dlp',['--no-warnings','--no-playlist','-g','-f','best[height<=480]/best','https://www.twitch.tv/'+b.currentLogin],{timeout:20000,maxBuffer:262144},(error,stdout)=>error?reject(Error('Source resolution failed')):resolve(String(stdout).trim().split(/\\r?\\n/)[0])));
  const {spotlightTimestampFilter}=require('/app/src/spotlight-hls.js');
  argv=['ffmpeg','-hide_banner','-loglevel','error','-nostdin','-rw_timeout','15000000','-i',url,'-map','0:v:0','-map','0:a:0?','-c:v','copy','-c:a','copy','-bsf:v',spotlightTimestampFilter(),'-bsf:a',spotlightTimestampFilter(true),'-f','hls','-hls_time','4','-hls_list_size','24','-hls_flags','delete_segments+independent_segments+temp_file','-hls_segment_filename',folder+'/seg_%06d.ts',folder+'/index.m3u8'];
}
if(argv){
const source=argv[argv.indexOf('-i')+1];
try{
const response=await fetch(source,{signal:AbortSignal.timeout(8000)});
const playlist=await response.text();
const lines=playlist.split(String.fromCharCode(10));
const segments=lines.filter(line=>line.trim()&&!line.startsWith('#'));
sourceProbe={status:response.status,contentType:response.headers.get('content-type'),bytes:playlist.length,segmentCount:segments.length,targetDuration:lines.find(line=>line.startsWith('#EXT-X-TARGETDURATION:')),mediaSequence:lines.find(line=>line.startsWith('#EXT-X-MEDIA-SEQUENCE:')),durations:lines.filter(line=>line.startsWith('#EXTINF:')).slice(-8),endList:lines.includes('#EXT-X-ENDLIST')};
if(segments.length){const segment=await fetch(new URL(segments[segments.length-1],source),{signal:AbortSignal.timeout(8000)});sourceProbe.lastSegmentStatus=segment.status;sourceProbe.lastSegmentBytes=(await segment.arrayBuffer()).byteLength;}
const {spawnSync}=require('child_process');
const probeFolder='/tmp/spotlight-relay-probe-'+Date.now();
fs.mkdirSync(probeFolder,{recursive:true});
const args=argv.slice(1).filter(Boolean).map(arg=>arg.startsWith(folder+'/')?arg.replace(folder,probeFolder):arg);
args.splice(args.lastIndexOf('-f'),0,'-t','8');
const started=Date.now();
const relay=spawnSync('ffmpeg',args,{encoding:'utf8',timeout:15000,maxBuffer:200000});
sourceProbe.relay={elapsedMs:Date.now()-started,status:relay.status,timedOut:relay.error?.code==='ETIMEDOUT',files:fs.readdirSync(probeFolder).map(name=>({name,bytes:fs.statSync(probeFolder+'/'+name).size})),errors:String(relay.stderr||'').split(String.fromCharCode(10)).filter(line=>!line.includes('http')).slice(-8)};
fs.rmSync(probeFolder,{recursive:true,force:true});
sourceProbe.liveTrials=[];
const {spawn}=require('child_process');
for(const mode of ['current','pts-only','original-clocks']){
  const trialFolder=probeFolder+'-'+mode;fs.mkdirSync(trialFolder,{recursive:true});
  let trialArgs=argv.slice(1).filter(Boolean).map(arg=>arg.startsWith(folder+'/')?arg.replace(folder,trialFolder):arg);
  if(mode==='pts-only')trialArgs=trialArgs.map(arg=>arg.startsWith('setts=')?"setts=pts='DTS+if(between(PTS-DTS,-1/TB,1/TB),PTS-DTS,0)'":arg);
  if(mode==='original-clocks'){
    for(const flag of ['-bsf:v','-bsf:a']){const at=trialArgs.indexOf(flag);if(at>=0)trialArgs.splice(at,2);}
  }
  const child=spawn('ffmpeg',trialArgs,{stdio:['ignore','ignore','ignore']});
  await new Promise(resolve=>setTimeout(resolve,10000));
  const manifest=(()=>{try{return fs.readFileSync(trialFolder+'/index.m3u8','utf8')}catch{return ''}})();
  sourceProbe.liveTrials.push({mode,active:child.exitCode===null,segmentCount:(manifest.match(/^seg_\\d+\\.ts$/gm)||[]).length,files:fs.readdirSync(trialFolder).map(name=>({name,bytes:fs.statSync(trialFolder+'/'+name).size})),durations:(manifest.match(/^#EXTINF:[^\\n]+/gm)||[]).slice(-6)});
  child.kill('SIGTERM');await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('close',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve()},1000)});
  fs.rmSync(trialFolder,{recursive:true,force:true});
}

}catch(e){sourceProbe={error:e?.name||'Source probe failed'};}
}
process.stdout.write(JSON.stringify({status:r.status,body:{...b,encoderDiagnostics:{files,processes,sourceProbe}}}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const run = await fly(['ssh','console','--app',app,'--machine',String(spotlight.id),'--command',command,'--quiet'],{timeout:90000});
  if (!run.ok) throw new Error(run.stderr || 'Spotlight status probe failed.');
  const raw=String(run.stdout||'').trim();
  const start=raw.indexOf('{');
  if(start<0) throw new Error('Spotlight status probe returned malformed output.');
  let payload;
  try{payload=JSON.parse(raw.slice(start));}catch{throw new Error('Spotlight status probe returned malformed JSON.');}
  return {ok:true,appName:app,machineId:spotlight.id,machineState:spotlight.state??null,spotlight:payload.body??null,httpStatus:payload.status??null};
}

async function spotlightRestart() {
  const app = 'hmo-dj-worker';
  const list = await fly(['machines', 'list', '--app', app, '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list HearMeOut worker machines.');
  let machines = [];
  try { machines = JSON.parse(list.stdout || '[]'); }
  catch { throw new Error('HearMeOut worker machine list returned malformed JSON.'); }

  const processGroup = (machine) => String(
    machine?.process_group ??
    machine?.config?.metadata?.fly_process_group ??
    machine?.config?.metadata?.['fly_process_group'] ??
    machine?.config?.env?.FLY_PROCESS_GROUP ??
    ''
  ).toLowerCase();

  const spotlight = Array.isArray(machines)
    ? machines.find((machine) => processGroup(machine) === 'spotlight')
    : null;
  if (!spotlight?.id) throw new Error('Could not identify the Spotlight process-group Machine.');

  const before = { id: spotlight.id, state: spotlight.state ?? null, processGroup: 'spotlight' };
  const restart = await fly(['machine', 'restart', String(spotlight.id), '--app', app], { timeout: 180000 });
  if (!restart.ok) throw new Error(restart.stderr || 'Spotlight Machine restart failed.');

  let after = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const check = await fly(['machines', 'list', '--app', app, '--json']);
    if (!check.ok) continue;
    try {
      const current = JSON.parse(check.stdout || '[]');
      const machine = Array.isArray(current) ? current.find((item) => String(item?.id) === String(spotlight.id)) : null;
      if (machine) {
        after = { id: machine.id, state: machine.state ?? null, processGroup: processGroup(machine) || 'spotlight' };
        if (String(machine.state) === 'started') break;
      }
    } catch {}
  }
  if (!after || after.state !== 'started') throw new Error('Spotlight Machine did not return to started state.');
  return { ok: true, appName: app, restartedOnly: 'spotlight', preservedProcessGroups: ['lounge','dj'], before, after };
}

async function loungeRestart() {
  const app = 'hmo-dj-worker';
  const list = await fly(['machines', 'list', '--app', app, '--json']);
  if (!list.ok) throw new Error(list.stderr || 'Unable to list HearMeOut worker machines.');
  let machines = [];
  try { machines = JSON.parse(list.stdout || '[]'); }
  catch { throw new Error('HearMeOut worker machine list returned malformed JSON.'); }

  const processGroup = (machine) => String(
    machine?.process_group ??
    machine?.config?.metadata?.fly_process_group ??
    machine?.config?.metadata?.['fly_process_group'] ??
    machine?.config?.env?.FLY_PROCESS_GROUP ??
    ''
  ).toLowerCase();

  const lounge = Array.isArray(machines)
    ? machines.find((machine) => processGroup(machine) === 'lounge')
    : null;
  if (!lounge?.id) throw new Error('Could not identify the Lounge process-group Machine.');

  const before = { id: lounge.id, state: lounge.state ?? null, processGroup: 'lounge' };
  const restart = await fly(['machine', 'restart', String(lounge.id), '--app', app], { timeout: 180000 });
  if (!restart.ok) throw new Error(restart.stderr || 'Lounge Machine restart failed.');

  let after = null;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const check = await fly(['machines', 'list', '--app', app, '--json']);
    if (!check.ok) continue;
    try {
      const current = JSON.parse(check.stdout || '[]');
      const machine = Array.isArray(current) ? current.find((item) => String(item?.id) === String(lounge.id)) : null;
      if (machine) {
        after = { id: machine.id, state: machine.state ?? null, processGroup: processGroup(machine) || 'lounge' };
        if (String(machine.state) === 'started') break;
      }
    } catch {}
  }
  if (!after || after.state !== 'started') throw new Error('Lounge Machine did not return to started state.');
  return { ok: true, appName: app, restartedOnly: 'lounge', preservedProcessGroups: ['spotlight','dj'], before, after };
}

async function wordChainStop() {
  const app = 'chat-tag-new';
  const source = [
    "(async()=>{",
    "const secret=String(process.env.STREAMWEAVER_SECRET||process.env.STREAMWEAVER_CLIENT_SECRET||'').trim();",
    "if(!secret) throw Error('Nebula service secret is not configured');",
    "const base='http://127.0.0.1:3000';",
    "const b=await fetch(base+'/api/game-hub/channel?channel=spacemountainlive',{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});",
    "const before=await b.json().catch(()=>null);",
    "const r=await fetch(base+'/api/game-hub/command',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-bot-secret':secret},body:JSON.stringify({channel:'spacemountainlive',username:'mtman1987',displayName:'mtman1987',message:'spmt wordchain stop',isBroadcaster:true,isModerator:true,source:'rotator-owner-control'}),signal:AbortSignal.timeout(15000)});",
    "const body=await r.json().catch(()=>null);",
    "const a=await fetch(base+'/api/game-hub/channel?channel=spacemountainlive',{headers:{accept:'application/json'},signal:AbortSignal.timeout(10000)});",
    "const after=await a.json().catch(()=>null);",
    "process.stdout.write(JSON.stringify({status:r.status,handled:body?.handled??null,reply:body?.reply??null,beforeGameIds:before?.gameIds??null,afterGameIds:after?.gameIds??null}));",
    "if(!r.ok||!Array.isArray(after?.gameIds)||after.gameIds.includes('wordchain')) process.exit(2);",
    "})().catch(e=>{console.error(e?.message||e);process.exit(1)});"
  ].join('');
  const encoded=Buffer.from(source,'utf8').toString('base64');
  const command=`node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const run=await fly(['ssh','console','--app',app,'--command',command,'--quiet'],{timeout:120000});
  if(!run.ok) throw new Error(run.stderr || 'Word Chain stop failed.');
  const raw=String(run.stdout||'').trim();
  const start=raw.indexOf('{');
  if(start<0) throw new Error('Word Chain stop returned malformed output.');
  let result={};
  try { result=JSON.parse(raw.slice(start)); } catch { throw new Error('Word Chain stop returned malformed JSON.'); }
  return {ok:true,appName:app,stopped:'wordchain',...result};
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


async function loungeViewerRefresh() {
  const list=await fly(['machines','list','--app',STREAMWEAVER_APP,'--json']);
  if(!list.ok)throw Error(list.stderr||'Unable to list StreamWeaver machines.');
  const machines=JSON.parse(list.stdout||'[]');
  const machine=machines.find(item=>item.state==='started');
  if(!machine?.id)throw Error('No active StreamWeaver machine.');
  const source=`
(async()=>{
const fs=require('fs'),path=require('path');
const root=process.env.PERSIST_ROOT||path.resolve(process.cwd(),'data','runtime');
const target=path.join(root,'tenants','spacemountainlive','data','lounge','lounge-browser-refresh.json');
const read=async()=>{const r=await fetch('http://127.0.0.1:3000/api/lounge/browser-refresh',{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('Lounge refresh status unavailable');return r.json()};
const before=await read();
const previous=fs.existsSync(target)?fs.readFileSync(target,'utf8'):null;
const disk=previous?JSON.parse(previous):{requestedAt:0};
if(Number(disk.requestedAt||0)!==Number(before.requestedAt||0))throw Error('Lounge refresh storage did not match the service');
const requestedAt=Date.now();
if(requestedAt-Number(before.requestedAt||0)<120000){process.stdout.write(JSON.stringify({ok:true,accepted:false,requestedAt:before.requestedAt}));return;}
if(!fs.existsSync(path.dirname(target)))throw Error('Lounge storage directory not found');
const temporary=target+'.owner-control.tmp';
fs.writeFileSync(temporary,JSON.stringify({requestedAt,requestedBy:'rotator-owner-control'}));
fs.renameSync(temporary,target);
try{
const after=await read();
if(Number(after.requestedAt)!==requestedAt)throw Error('Lounge refresh request did not reach the service');
process.stdout.write(JSON.stringify({ok:true,accepted:true,requestedAt,preservedWorkers:['movie','spotlight','restream']}));
}catch(error){if(previous!==null)fs.writeFileSync(target,previous);else fs.unlinkSync(target);throw error;}
})().catch(error=>{console.error(error.message);process.exit(1)});
`;
  const encoded=Buffer.from(source).toString('base64');
  const command=`node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const run=await fly(['ssh','console','--app',STREAMWEAVER_APP,'--machine',String(machine.id),'--command',command,'--quiet'],{timeout:60000});
  if(!run.ok)throw Error(run.stderr||'Lounge viewer refresh failed');
  const raw=String(run.stdout||'').trim();const at=raw.indexOf('{');
  if(at<0)throw Error('Lounge viewer refresh returned malformed output');
  return {...JSON.parse(raw.slice(at)),machineId:machine.id};
}

export async function execute(payload) {
  const command = text(payload.command, 40).toLowerCase();
  if (command === 'states') return { ok: true, ...(await readStates(requireApp(payload.appName))) };
  if (command === 'rotate') return await rotate();
  if (command === 'signal') return await signalHistory(payload.limit);
  if (command === 'logs') return await logs(requireApp(payload.appName), payload.limit, payload.errorsOnly === true);
  if (command === 'repair') return await repair(payload);
  if (command === 'coderjob') return await coderJobStatus(payload.id);
  if (command === 'loungeviewerrefresh') return await loungeViewerRefresh();
  if (command === 'streamstatus') return await streamStatus();
  if (command === 'streamstart') return await streamStart();
  if (command === 'spotlightstatus') return await spotlightStatus();
  if (command === 'spotlightrestart') return await spotlightRestart();
  if (command === 'loungerestart') return await loungeRestart();
  if (command === 'wordchainstop') return await wordChainStop();
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
