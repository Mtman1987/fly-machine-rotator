import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const EXPECTED = new Set(['chat-tag-bot-new','chat-tag-new','discord-stream-hub-new','dsh-clip-worker','hearmeout-main','hmo-dj-worker','streamweaver-new','spmt-live','mtman-machine-rotator']);
// Publish only fixed classifications and numeric measurements. Never publish log text,
// process arguments, environment variables, health output, or command stderr.
export function classify(message) {
  const s=String(message||'');
  if (s.includes('Optional EventSub integration is off; this is not a bot authentication error.')) return null;
  const rules=[['out_of_memory',/out of memory|oom.kill|oom-kill|oomkilled/i],['disk_full',/ENOSPC|no space left on device/i],['auth_failure',/invalid.{0,20}token|token.{0,20}(expired|invalid)|unauthori[sz]ed|invalid_grant/i],['health_failure',/health check.{0,200}fail/i],['lease_conflict',/lease currently held|lease.{0,40}conflict/i],['fetch_failure',/fetch failed|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED/i],['timeout',/timed? out|timeout|ETIMEDOUT/i],['rate_limit',/rate.limit|too many requests/i],['unhandled_failure',/unhandled|uncaught|panic|fatal/i],['playback_failure',/stopped advancing|buffer.{0,40}(fail|timeout)|ffmpeg.{0,40}(error|failed)/i],['generic_failure',/\berror\b|\bexception\b|\bfailed\b|\brejection\b/i],['warning',/\bwarn(?:ing)?\b/i]];
  return rules.find(([,r])=>r.test(s))?.[0]||null;
}
async function fly(args,timeout=60000) {
  try { const r=await exec('flyctl',args,{timeout,maxBuffer:16*1024*1024,env:process.env});return {ok:true,text:r.stdout}; }
  catch {return {ok:false};}
}
function json(s) {try{return JSON.parse(s);}catch{return null;}}
function records(s) {
  const rows=[]; let buffer='',depth=0,quoted=false,escaped=false;
  for(const line of String(s||'').split(/\r?\n/)) {
    if(!buffer&&!/^\s*[\[{]/.test(line)){if(line.trim())rows.push({message:line});continue;}
    for(const char of line+'\n') {
      if(!buffer&&/\s/.test(char))continue;buffer+=char;
      if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;}
      else if(char==='"')quoted=true;else if(char==='{'||char==='[')depth++;else if(char==='}'||char===']')depth--;
      if(depth===0&&!quoted&&buffer.trim()){const p=json(buffer);if(Array.isArray(p))rows.push(...p);else if(p)rows.push(p);buffer='';}
    }
  }
  return rows;
}
const probe=String.raw`const fs=require('fs');const read=p=>fs.readFileSync(p,'utf8');const cpu=()=>read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);const a=cpu();setTimeout(()=>{const b=cpu(),d=b.map((v,i)=>v-a[i]),total=d.reduce((x,y)=>x+y,0),idle=d[3]+d[4];const mem=Object.fromEntries(read('/proc/meminfo').split('\n').map(l=>{const m=l.match(/^(\w+):\s+(\d+)/);return m?[m[1],Number(m[2])]:[]}).filter(x=>x.length));const totalMb=mem.MemTotal/1024,availableMb=mem.MemAvailable/1024;console.log(JSON.stringify({cpuUsedPercent:total?Math.round((1-idle/total)*1000)/10:null,cpuIdlePercent:total?Math.round(idle/total*1000)/10:null,ramTotalMb:Math.round(totalMb),ramUsedMb:Math.round(totalMb-availableMb),ramAvailableMb:Math.round(availableMb),ramUsedPercent:Math.round((1-availableMb/totalMb)*1000)/10,sampleSeconds:2}));},2000);`;
async function machine(app,m) {
  const guest=m.config?.guest||m.guest||{};
  const out={id:m.id,state:m.state,region:m.region,processGroup:m.config?.metadata?.fly_process_group||m.process_group||null,cpus:guest.cpus??null,cpuKind:guest.cpu_kind??null,ramAllocatedMb:guest.memory_mb??null,checks:(m.checks||[]).map(c=>({name:c.name,status:c.status})),usage:null};
  if(m.state==='started') {
    const r=await fly(['machine','exec','--app',app,m.id,'node','-e',probe],20000);
    const p=r.ok?json(r.text.trim()):null;
    out.usage=p&&typeof p.cpuUsedPercent==='number'?p:{unavailable:true};
  }
  return out;
}
async function appAudit(name) {
  const [mr,lr]=await Promise.all([fly(['machines','list','--app',name,'--json']),fly(['logs','--app',name,'--json','--no-tail'])]);
  const machinesRaw=mr.ok?json(mr.text):null;
  const machines=Array.isArray(machinesRaw)?await Promise.all(machinesRaw.map(m=>machine(name,m))):[];
  const logRows=lr.ok?records(lr.text):[];
  const counts={};for(const row of logRows){const c=classify(row.message||row.msg||row.log||'');if(c)counts[c]=(counts[c]||0)+1;}
  const times=logRows.map(r=>r.timestamp||r.time||r.ts).filter(t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT/.test(t)).sort();
  return {app:name,expectedRunning:EXPECTED.has(name),inventoryOk:Array.isArray(machinesRaw),machines,logs:{readOk:lr.ok,recordCount:logRows.length,firstAt:times[0]||null,lastAt:times.at(-1)||null,counts},findings:[...(EXPECTED.has(name)&&!machines.some(m=>m.state==='started')?['no_running_machine']:[]),...(machines.some(m=>m.state==='started'&&m.checks.some(c=>['critical','failing','fail'].includes(c.status)))?['failing_health_checks']:[]),...(machines.some(m=>m.usage?.ramUsedPercent>=85)?['high_ram']:[]),...(machines.some(m=>m.usage?.cpuUsedPercent>=85)?['high_cpu_sample']:[]),...(!lr.ok?['logs_unavailable']:[]),...(!Array.isArray(machinesRaw)?['inventory_unavailable']:[]),...(machines.some(m=>m.usage?.unavailable)?['usage_unavailable']:[])]};
}
export async function audit() {
  const r=await fly(['apps','list','--json']);const all=r.ok?json(r.text):null;
  if(!Array.isArray(all))throw Error('App inventory unavailable');
  const names=all.map(a=>a.Name||a.name).filter(n=>typeof n==='string'&&/^[a-z0-9-]+$/.test(n));
  const rows=[];for(let i=0;i<names.length;i+=3)rows.push(...await Promise.all(names.slice(i,i+3).map(appAudit)));
  return {ok:rows.every(r=>r.inventoryOk&&r.logs.readOk),capturedAt:new Date().toISOString(),readOnly:true,usageNote:'CPU is a two-second sample; RAM used excludes available memory. Stopped Machines have no usage sample. Log counts classify retained records, not distinct incidents. Raw logs are not exported.',apps:rows};
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].split('/').at(-1)))audit().then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.log(JSON.stringify({ok:false,error:'Fleet audit failed; inspect credential availability and Fly control access.'}));process.exitCode=1;});
