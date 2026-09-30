#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'spmt-live';

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .slice(0, 8000);
}

async function fly(args, timeout = 120000) {
  const env = { ...process.env, FLY_API_TOKEN: String(process.env.FLY_API_TOKEN || '') };
  if (!env.FLY_API_TOKEN) throw new Error('FLY_API_TOKEN is unavailable.');
  try {
    const { stdout, stderr } = await execFileAsync('flyctl', args, {
      env,
      encoding: 'utf8',
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error?.stdout || ''),
      stderr: redact(error?.stderr || error?.message || error),
    };
  }
}

function parsePayload(encoded) {
  const raw = Buffer.from(String(encoded || ''), 'base64').toString('utf8');
  const payload = JSON.parse(raw);
  if (!['spmtbrowser','spmtstart'].includes(payload?.command)) throw new Error('Unsupported command.');
  return payload;
}

async function ownerId() {
  const source = [
    "const Database=require('better-sqlite3');",
    "const db=new Database(process.env.DATABASE_PATH||'/data/spmt.db',{readonly:true,fileMustExist:true});",
    "const row=db.prepare('SELECT id FROM users WHERE lower(username)=? LIMIT 1').get('mtman1987');",
    "if(!row?.id){process.stderr.write('owner not found');process.exit(2)}",
    "process.stdout.write(String(row.id));",
  ].join('');
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const run = await fly(['ssh','console','--app',APP,'--process-group','app','--command',command,'--quiet'], 60000);
  if (!run.ok) throw new Error(run.stderr || 'Owner profile lookup failed.');
  const id = String(run.stdout || '').trim().split(/\r?\n/).pop()?.trim();
  if (!id) throw new Error('Owner profile lookup returned no id.');
  return id;
}

async function startRestream(uid) {
  const source = `
(async()=>{
const uid=Buffer.from(process.argv[1],'base64').toString('utf8');
const secret=String(process.env.CLOUD_XBOX_WORKER_SECRET||process.env.JWT_SECRET||'').trim();
if(!secret) throw Error('Cloud browser worker secret is not configured');
const headers={'x-spmt-worker-secret':secret,'x-spmt-user-id':uid,'content-type':'application/json'};
const r=await fetch('http://127.0.0.1:3003/v1/restream/start',{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(120000)});
const b=await r.json().catch(()=>null);
process.stdout.write(JSON.stringify({status:r.status,body:b}));
if(!r.ok) process.exit(2);
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const sourceEncoded = Buffer.from(source, 'utf8').toString('base64');
  const uidEncoded = Buffer.from(uid, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${sourceEncoded}','base64').toString('utf8'))" '${uidEncoded}'`;
  const run = await fly(['ssh','console','--app',APP,'--process-group','xbox','--command',command,'--quiet'], 150000);
  const raw = String(run.stdout || '').trim();
  const start = raw.indexOf('{');
  let result = null;
  if (start >= 0) {
    try { result = JSON.parse(raw.slice(start)); } catch {}
  }
  if (!run.ok || !result || result?.status < 200 || result?.status >= 300) {
    throw new Error(String(result?.body?.error || run.stderr || ('Restream start failed (' + result?.status + ')')));
  }

  const verifySource = `
(async()=>{
const clientId=String(process.env.TWITCH_CLIENT_ID||'').trim();
const clientSecret=String(process.env.TWITCH_CLIENT_SECRET||'').trim();
let token=String(process.env.TWITCH_ACCESS_TOKEN||'').trim();
if(!clientId) throw Error('Twitch client id is unavailable for verification');
if(clientSecret){
  const tr=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'}),signal:AbortSignal.timeout(8000)});
  const tb=await tr.json().catch(()=>null);
  if(!tr.ok||!tb?.access_token) throw Error('Twitch app token request failed');
  token=String(tb.access_token);
}
if(!token) throw Error('Twitch access token is unavailable for verification');
const r=await fetch('https://api.twitch.tv/helix/streams?user_login=spacemountainlive',{headers:{'client-id':clientId,authorization:'Bearer '+token,accept:'application/json'},signal:AbortSignal.timeout(12000)});
const b=await r.json().catch(()=>null);
const isLive=Boolean(r.ok&&Array.isArray(b?.data)&&b.data.length);
process.stdout.write(JSON.stringify({status:r.status,body:{ok:r.ok,isLive,startedAt:b?.data?.[0]?.started_at||null,streamId:b?.data?.[0]?.id||null}}));
if(!r.ok||!Array.isArray(b?.data)) process.exit(2);
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const verifyEncoded = Buffer.from(verifySource, 'utf8').toString('base64');
  const verifyCommand = `node -e "eval(Buffer.from('${verifyEncoded}','base64').toString('utf8'))"`;
  const verified = await fly(['ssh','console','--app',APP,'--process-group','app','--command',verifyCommand,'--quiet'], 60000);
  const verifyRaw = String(verified.stdout || '').trim();
  const verifyStart = verifyRaw.indexOf('{');
  let twitch = null;
  if (verifyStart >= 0) {
    try { twitch = JSON.parse(verifyRaw.slice(verifyStart)); } catch {}
  }
  if (!verified.ok || !twitch?.body?.ok || typeof twitch?.body?.isLive !== 'boolean') {
    throw new Error(verified.stderr || 'Twitch verification failed.');
  }
  return { ok:true, ...result.body, twitch:twitch.body };
}

async function inspect(uid) {
  const source = `
(async()=>{
const uid=Buffer.from(process.argv[1],'base64').toString('utf8');
const secret=String(process.env.CLOUD_XBOX_WORKER_SECRET||process.env.JWT_SECRET||'').trim();
if(!secret) throw Error('Cloud browser worker secret is not configured');
const headers={'x-spmt-worker-secret':secret,'x-spmt-user-id':uid,'content-type':'application/json'};
async function call(path,init={}) {
  const r=await fetch('http://127.0.0.1:3003'+path,{...init,headers:{...headers,...(init.headers||{})},signal:AbortSignal.timeout(45000)});
  const type=r.headers.get('content-type')||'';
  const b=type.includes('application/json')?await r.json().catch(()=>null):null;
  return {r,b};
}
const opened=await call('/v1/session',{method:'POST',body:JSON.stringify({mode:'restream'})});
if(!opened.r.ok) throw Error(String(opened.b?.error||('Restream browser open failed ('+opened.r.status+')')));
const status=await call('/v1/status');
if(!status.r.ok) throw Error('Restream browser status failed ('+status.r.status+')');
const inspect=await call('/v1/inspect');
if(!inspect.r.ok) throw Error('Restream browser inspection failed ('+inspect.r.status+')');
const cleanText=String(inspect.b?.bodyText||'')
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/gi,'[email]')
  .slice(0,3500);
process.stdout.write(JSON.stringify({
  ok:true,
  running:Boolean(status.b?.running),
  mode:status.b?.mode||null,
  url:String(inspect.b?.url||status.b?.url||'').slice(0,500),
  title:String(inspect.b?.title||status.b?.title||'').slice(0,300),
  buttons:Array.isArray(inspect.b?.buttons)?inspect.b.buttons.slice(0,80):[],
  bodyText:cleanText,
  profilePersistent:Boolean(status.b?.profilePersistent),
  persistentHost:Boolean(status.b?.persistentHost)
}));
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
  const sourceEncoded = Buffer.from(source, 'utf8').toString('base64');
  const uidEncoded = Buffer.from(uid, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${sourceEncoded}','base64').toString('utf8'))" '${uidEncoded}'`;
  const run = await fly(['ssh','console','--app',APP,'--process-group','xbox','--command',command,'--quiet'], 120000);
  if (!run.ok) throw new Error(run.stderr || 'Persistent Restream browser inspection failed.');
  const raw = String(run.stdout || '').trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('Persistent Restream browser inspection returned malformed output.');
  return JSON.parse(raw.slice(start));
}

async function main() {
  try {
    const payload = parsePayload(process.argv[2]);
    const uid = await ownerId();
    const result = payload.command === 'spmtstart' ? await startRestream(uid) : await inspect(uid);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok:false, error:redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
