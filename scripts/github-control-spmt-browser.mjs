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
  if (!['spmtbrowser','spmtstart','spmthostrestart'].includes(payload?.command)) throw new Error('Unsupported command.');
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
  return { ok:true, action:'start-only', alreadyLive:result.body?.alreadyLive===true, state:['live','ready','prestudio','login_required'].includes(result.body?.state)?result.body.state:'unknown', twitch:{ok:twitch.body.ok,isLive:twitch.body.isLive,startedAt:twitch.body.startedAt,streamId:twitch.body.streamId} };
}

async function inspect(uid) {
  const source = "\n(async()=>{\nconst uid=Buffer.from(process.argv[1],'base64').toString('utf8');\nconst secret=String(process.env.CLOUD_XBOX_WORKER_SECRET||process.env.JWT_SECRET||'').trim();\nif(!secret)throw Error('Worker authentication unavailable');\nconst response=await fetch('http://127.0.0.1:3003/v1/status',{headers:{'x-spmt-worker-secret':secret,'x-spmt-user-id':uid},signal:AbortSignal.timeout(15000)});\nconst status=await response.json();\nif(!response.ok)throw Error('Worker status unavailable');\nif(!status.running||status.mode!=='restream'){process.stdout.write(JSON.stringify({ok:true,running:status.running===true,restreamSessionPresent:false,waitingForOfflineStart:true}));return;}\nconst fs=require('fs'),path=require('path'),crypto=require('crypto'),WebSocket=require('ws');\nconst profile=path.join(process.env.CLOUD_XBOX_PROFILE_ROOT||'/var/lib/spmt-xbox/profiles',crypto.createHash('sha256').update(uid).digest('hex').slice(0,24));\nlet port;\nfor(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){\n let args;try{args=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0')}catch{continue}\n if(!args.includes('--user-data-dir='+profile))continue;\n const flag=args.find(x=>x.startsWith('--remote-debugging-port='));\n if(flag)port=Number(flag.split('=')[1]);\n}\nif(!port)throw Error('Existing owner browser debug port unavailable');\nconst targets=await (await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(5000)})).json();\nconst pages=targets.filter(t=>t.type==='page');\nconst stateExpression=\"(()=>{const matches=[...document.querySelectorAll('button,[role=button]')].map(el=>({el,text:(el.textContent||el.getAttribute('aria-label')||'').trim().toLowerCase()})).filter(x=>['go live','start stream','end stream','stop stream','enter studio'].includes(x.text)).filter(x=>!x.el.disabled&&x.el.getBoundingClientRect().width>0);const labels=matches.map(x=>x.text);return {canStart:labels.some(x=>['go live','start stream'].includes(x)),canStop:labels.some(x=>['end stream','stop stream'].includes(x)),canEnterStudio:labels.includes('enter studio'),goLiveDisabled:[...document.querySelectorAll('button,[role=button]')].some(el=>/^go live$|^start stream$/i.test((el.textContent||'').trim())&&(el.disabled||el.getAttribute('aria-disabled')==='true')),hasDialog:!!document.querySelector('[role=dialog]'),destinationRequired:/no destinations|add a destination|choose a destination/i.test(document.body.innerText||''),cameraPermissionRequired:/camera permission|allow access to.*camera/i.test(document.body.innerText||''),unsupportedBrowser:/unsupported browser|browser is not supported/i.test(document.body.innerText||''),sessionExpired:/session expired|please sign in|please log in/i.test(document.body.innerText||'')};})()\";\nconst probes=[];\nfor(const target of pages.slice(0,5)){\nconst item={selectedByWorker:target.id===pages[pages.length-1]?.id,isStudio:/^https:\\/\\/studio\\.restream\\.io\\//i.test(target.url),titleLive:/\\[LIVE\\]/i.test(target.title),isLogin:/restream\\.io\\/login/i.test(target.url)};\nconst socket=new WebSocket(target.webSocketDebuggerUrl,{origin:'http://127.0.0.1'});\nlet id=0;const pending=new Map();\nsocket.on('message',raw=>{let m;try{m=JSON.parse(String(raw))}catch{return}const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error('CDP command failed')):p.resolve(m.result)}});\nsocket.on('error',()=>{});\ntry{\nawait new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Connect timeout')),3000);socket.once('open',()=>{clearTimeout(timer);resolve()});socket.once('error',()=>{clearTimeout(timer);reject(Error('Connect failed'))})});\nasync function call(expression){return new Promise((resolve,reject)=>{const current=++id;const timer=setTimeout(()=>{pending.delete(current);reject(Error('Evaluate timeout'))},3000);pending.set(current,{resolve,reject,timer});socket.send(JSON.stringify({id:current,method:'Runtime.evaluate',params:{expression,returnByValue:true}}))})}\nconst started=Date.now();\ntry{const result=await call('1');item.simpleEvaluateOk=result?.result?.value===1}catch{item.simpleEvaluateOk=false}\nitem.simpleEvaluateMs=Date.now()-started;\nif(item.simpleEvaluateOk){const controlsStarted=Date.now();try{const result=await call(stateExpression);item.controls=result?.result?.value||null;item.controlsEvaluateOk=Boolean(item.controls)}catch{item.controlsEvaluateOk=false}item.controlsEvaluateMs=Date.now()-controlsStarted}\n}catch{item.connectionOk=false}finally{socket.terminate()}\nprobes.push(item);\n}\nprocess.stdout.write(JSON.stringify({ok:true,running:true,profilePersistent:status.profilePersistent===true,persistentHost:status.persistentHost===true,resources:status.resources,probes}));\n})().catch(()=>{console.error('Bounded existing-browser probe failed');process.exit(1)});\n";
  const sourceEncoded = Buffer.from(source, 'utf8').toString('base64');
  const uidEncoded = Buffer.from(uid, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${sourceEncoded}','base64').toString('utf8'))" '${uidEncoded}'`;
  const run = await fly(['ssh','console','--app',APP,'--process-group','xbox','--command',command,'--quiet'], 90000);
  if (!run.ok) throw new Error('Bounded existing-browser probe failed.');
  const raw = String(run.stdout || '').trim();
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('Browser probe returned malformed output.');
  return JSON.parse(raw.slice(start));
}


async function twitchStateForRecovery() {
  const source = "\n(async()=>{\nconst clientId=String(process.env.TWITCH_CLIENT_ID||'').trim();\nconst clientSecret=String(process.env.TWITCH_CLIENT_SECRET||'').trim();\nlet token=String(process.env.TWITCH_ACCESS_TOKEN||'').trim();\nif(!clientId) throw Error('Twitch client id is unavailable for verification');\nif(clientSecret){\n  const tr=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,client_secret:clientSecret,grant_type:'client_credentials'}),signal:AbortSignal.timeout(8000)});\n  const tb=await tr.json().catch(()=>null);\n  if(!tr.ok||!tb?.access_token) throw Error('Twitch app token request failed');\n  token=String(tb.access_token);\n}\nif(!token) throw Error('Twitch access token is unavailable for verification');\nconst r=await fetch('https://api.twitch.tv/helix/streams?user_login=spacemountainlive',{headers:{'client-id':clientId,authorization:'Bearer '+token,accept:'application/json'},signal:AbortSignal.timeout(12000)});\nconst b=await r.json().catch(()=>null);\nconst isLive=Boolean(r.ok&&Array.isArray(b?.data)&&b.data.length);\nprocess.stdout.write(JSON.stringify({status:r.status,body:{ok:r.ok,isLive,startedAt:b?.data?.[0]?.started_at||null,streamId:b?.data?.[0]?.id||null}}));\nif(!r.ok||!Array.isArray(b?.data)) process.exit(2);\n})().catch(e=>{console.error(e?.message||e);process.exit(1)});";
  const encoded = Buffer.from(source, 'utf8').toString('base64');
  const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
  const run = await fly(['ssh','console','--app',APP,'--process-group','app','--command',command,'--quiet'],60000);
  const raw = String(run.stdout || '').trim();
  const at = raw.indexOf('{');
  let result = null;
  if (at >= 0) { try { result = JSON.parse(raw.slice(at)); } catch {} }
  if (!run.ok || !result?.body?.ok || typeof result.body.isLive !== 'boolean') throw Error('Twitch verification failed; browser host was not restarted.');
  return result.body;
}


async function freshStudioTab(uid) {
  const source = "\n(async()=>{\nconst fs=require('fs'),path=require('path'),crypto=require('crypto');\nconst uid=Buffer.from(process.argv[1],'base64').toString('utf8');\nconst profile=path.join(process.env.CLOUD_XBOX_PROFILE_ROOT||'/var/lib/spmt-xbox/profiles',crypto.createHash('sha256').update(uid).digest('hex').slice(0,24));\nlet port;\nfor(const pid of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))){\nlet argv;try{argv=fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0')}catch{continue}\nif(!argv.includes('--user-data-dir='+profile))continue;\nconst flag=argv.find(x=>x.startsWith('--remote-debugging-port='));\nif(flag)port=Number(flag.split('=')[1]);\n}\nif(!port)throw Error('Saved owner browser unavailable');\nconst base='http://127.0.0.1:'+port;\nconst targets=await(await fetch(base+'/json/list',{signal:AbortSignal.timeout(5000)})).json();\nconst studio=targets.filter(t=>t.type==='page'&&/^https:\\/\\/studio\\.restream\\.io\\//i.test(t.url));\nif(!studio.length)throw Error('No existing Restream studio tab; no tab replaced');\nconst made=await fetch(base+'/json/new?'+encodeURIComponent('https://studio.restream.io/'),{method:'PUT',signal:AbortSignal.timeout(10000)});\nif(!made.ok)throw Error('Fresh studio tab could not be opened');\nconst target=await made.json();\nif(!target.id)throw Error('Fresh studio tab returned no target');\nfor(const old of studio)await fetch(base+'/json/close/'+encodeURIComponent(old.id),{signal:AbortSignal.timeout(5000)});\nprocess.stdout.write(JSON.stringify({ok:true,replacedStudioTabs:studio.length,preservedProfile:true}));\n})().catch(e=>{console.error(e?.message||e);process.exit(1)});\n";
  const encoded=Buffer.from(source,'utf8').toString('base64');
  const user=Buffer.from(uid,'utf8').toString('base64');
  const command=`node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))" '${user}'`;
  const run=await fly(['ssh','console','--app',APP,'--process-group','xbox','--command',command,'--quiet'],60000);
  if(!run.ok)throw Error(run.stderr||'Fresh studio tab recovery failed');
  await new Promise(resolve=>setTimeout(resolve,8000));
}

async function restartOfflineHost(uid) {
  const before = await twitchStateForRecovery();
  if (before.isLive) return {ok:true,alreadyLive:true,twitch:before,restarted:false};
  const list = await fly(['machines','list','--app',APP,'--json'],60000);
  if (!list.ok) throw Error(list.stderr || 'Browser host inventory failed');
  const machines = JSON.parse(list.stdout || '[]');
  const group = m => String(m.process_group || m.config?.metadata?.fly_process_group || m.config?.env?.FLY_PROCESS_GROUP || '');
  const hosts = machines.filter(m => group(m) === 'xbox' && m.state === 'started');
  if (hosts.length !== 1) throw Error('Expected exactly one started Xbox browser host; no restart performed.');
  const host = hosts[0];
  if (!(host.config?.mounts || []).some(m => m.path === '/var/lib/spmt-xbox')) throw Error('Saved browser profile volume missing; no restart performed.');
  const finalGuard = await twitchStateForRecovery();
  if (finalGuard.isLive) return {ok:true,alreadyLive:true,twitch:finalGuard,restarted:false};
  const cpus = Number(host.config?.guest?.cpus || 0);
  const restarted = cpus > 0 && cpus < 4
    ? await fly(['machine','update',String(host.id),'--app',APP,'--vm-cpus','4','--yes'],180000)
    : await fly(['machine','restart',String(host.id),'--app',APP],180000);
  if (!restarted.ok) throw Error(restarted.stderr || 'Browser host restart failed');
  await new Promise(resolve => setTimeout(resolve,8000));
  let start;
  try { start = await startRestream(uid); }
  catch (error) {
    if (!/Runtime.evaluate timed out/.test(String(error?.message || ''))) throw error;
    const offline = await twitchStateForRecovery();
    if (offline.isLive) return {ok:true,restarted:true,twitch:offline,machineId:host.id};
    await freshStudioTab(uid);
    start = await startRestream(uid);
  }
  let twitch = start.twitch;
  for (let attempt = 0; !twitch?.isLive && attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve,5000));
    twitch = await twitchStateForRecovery();
  }
  if (!twitch?.isLive) throw Error('Browser host restarted but Twitch has not confirmed live.');
  return {ok:true,action:'restart-offline-browser-host',machineId:host.id,preservedProfile:true,preservedProcessGroups:['app'],twitch};
}

async function main() {
  try {
    const payload = parsePayload(process.argv[2]);
    const uid = await ownerId();
    const result = payload.command === 'spmthostrestart' ? await restartOfflineHost(uid) : payload.command === 'spmtstart' ? await startRestream(uid) : await inspect(uid);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok:false, error:redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
