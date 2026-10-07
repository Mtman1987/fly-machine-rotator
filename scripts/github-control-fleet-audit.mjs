import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const PARTNER_APP = /(?:^|[-_])(?:mika|miniature|atherea|atheria|aetherra)(?:[-_]|$)/i;
const EXPECTED = new Set(['chat-tag-bot-new','chat-tag-new','discord-stream-hub-new','dsh-clip-worker','hearmeout-main','hmo-dj-worker','streamweaver-new','spmt-live','mtman-machine-rotator']);
// Publish only fixed classifications and numeric measurements. Never publish log text,
// process arguments, environment variables, health output, or command stderr.
export function classify(message) {
  const s=String(message||'');
  if (s.includes('Optional EventSub integration is off; this is not a bot authentication error.')) return null;
  const rules=[['json_corruption',/SyntaxError.*JSON|Unexpected.*JSON/i],['ai_provider_failure',/Gemini.{0,80}(?:unavailable|failed|404|429)|RESOURCE_EXHAUSTED|no eligible.{0,30}model/i],['out_of_memory',/out of memory|oom.kill|oom-kill|oomkilled/i],['disk_full',/ENOSPC|no space left on device/i],['auth_failure',/invalid.{0,20}token|token.{0,20}(expired|invalid)|unauthori[sz]ed|invalid_grant/i],['health_failure',/health check.{0,200}fail/i],['lease_conflict',/lease currently held|lease.{0,40}conflict/i],['fetch_failure',/fetch failed|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED/i],['timeout',/timed? out|timeout|ETIMEDOUT/i],['rate_limit',/rate.limit|too many requests/i],['unhandled_failure',/unhandled|uncaught|panic|fatal/i],['playback_failure',/stopped advancing|buffer.{0,40}(fail|timeout)|ffmpeg.{0,40}(error|failed)/i],['generic_failure',/\berror\b|\bexception\b|\bfailed\b|\brejection\b/i],['warning',/\bwarn(?:ing)?\b/i]];
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
const fallbackProbe="awk 'BEGIN {getline line < \"/proc/stat\"; close(\"/proc/stat\"); split(line,a,\" \"); total=0; for(i=2;i<=9;i++) total+=a[i]; idle=a[5]+a[6]; system(\"sleep 2\"); getline line < \"/proc/stat\"; close(\"/proc/stat\"); split(line,b,\" \"); t=0; for(i=2;i<=9;i++) t+=b[i]; d=t-total; used=d?100*(1-((b[5]+b[6]-idle)/d)):0; while((getline line < \"/proc/meminfo\")>0) {split(line,m,\" \"); if(m[1]==\"MemTotal:\") mt=m[2]; if(m[1]==\"MemAvailable:\") ma=m[2]} if(mt>0) printf \"{\\\"cpuUsedPercent\\\":%.1f,\\\"cpuIdlePercent\\\":%.1f,\\\"ramTotalMb\\\":%.0f,\\\"ramUsedMb\\\":%.0f,\\\"ramAvailableMb\\\":%.0f,\\\"ramUsedPercent\\\":%.1f,\\\"sampleSeconds\\\":2}\\n\",used,100-used,mt/1024,(mt-ma)/1024,ma/1024,100*(1-ma/mt); else exit 1;}'";
const probe=String.raw`const fs=require('fs');const read=p=>fs.readFileSync(p,'utf8');const cpu=()=>read('/proc/stat').split('\n')[0].trim().split(/\s+/).slice(1,9).map(Number);const a=cpu();setTimeout(()=>{const b=cpu(),d=b.map((v,i)=>v-a[i]),total=d.reduce((x,y)=>x+y,0),idle=d[3]+d[4];const mem=Object.fromEntries(read('/proc/meminfo').split('\n').map(l=>{const m=l.match(/^(\w+):\s+(\d+)/);return m?[m[1],Number(m[2])]:[]}).filter(x=>x.length));const totalMb=mem.MemTotal/1024,availableMb=mem.MemAvailable/1024;console.log(JSON.stringify({cpuUsedPercent:total?Math.round((1-idle/total)*1000)/10:null,cpuIdlePercent:total?Math.round(idle/total*1000)/10:null,ramTotalMb:Math.round(totalMb),ramUsedMb:Math.round(totalMb-availableMb),ramAvailableMb:Math.round(availableMb),ramUsedPercent:Math.round((1-availableMb/totalMb)*1000)/10,sampleSeconds:2}));},2000);`;
async function machine(app,m) {
  const guest=m.config?.guest||m.guest||{};
  const out={id:m.id,state:m.state,region:m.region,processGroup:m.config?.metadata?.fly_process_group||m.process_group||null,cpus:guest.cpus??null,cpuKind:guest.cpu_kind??null,ramAllocatedMb:guest.memory_mb??null,checks:(m.checks||[]).map(c=>({name:c.name,status:c.status})),usage:null};
  if(m.state==='started') {
    let p=null;
    // This image lacks Node. Use its existing awk probe without creating
    // Fly exec failure records for an unavailable diagnostic executable.
    if(app!=='spmt-agents') {
      const encoded=Buffer.from(probe,'utf8').toString('base64');
      const command=`node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
      const r=await fly(['ssh','console','--app',app,'--machine',m.id,'--command',command,'--quiet'],30000);
      const match=r.ok?r.text.match(/\{"cpuUsedPercent"[^\n]*\}/):null;
      p=match?json(match[0]):null;
    }
    if(!p || typeof p.cpuUsedPercent!=='number') {
      const fallback=await fly(['ssh','console','--app',app,'--machine',m.id,'--command',fallbackProbe,'--quiet'],30000);
      const row=fallback.ok?fallback.text.match(/\{\"cpuUsedPercent\"[^\n]*\}/):null;
      p=row?json(row[0]):null;
    }
    out.usage=p&&typeof p.cpuUsedPercent==='number'?p:{unavailable:true};
  }
  return out;
}
async function appAudit(name) {
  const [mr,lr]=await Promise.all([fly(['machines','list','--app',name,'--json']),fly(['logs','--app',name,'--json','--no-tail'])]);
  const machinesRaw=mr.ok?json(mr.text):null;
  const machines=Array.isArray(machinesRaw)?await Promise.all(machinesRaw.map(m=>machine(name,m))):[];
  const logRows=lr.ok?records(lr.text):[];
  const counts={},recentCounts={},details={};const since=Date.now()-10*60*1000;for(const row of logRows){const c=classify(row.message||row.msg||row.log||'');if(c){counts[c]=(counts[c]||0)+1;const at=row.timestamp||row.time||row.ts||null;const entry=details[c]||{count:0,firstAt:at,lastAt:at};entry.count++;if(at&&(!entry.firstAt||at<entry.firstAt))entry.firstAt=at;if(at&&(!entry.lastAt||at>entry.lastAt))entry.lastAt=at;details[c]=entry;if(Date.parse(at)>=since)recentCounts[c]=(recentCounts[c]||0)+1;}}
  const times=logRows.map(r=>r.timestamp||r.time||r.ts).filter(t=>typeof t==='string'&&/^\d{4}-\d\d-\d\dT/.test(t)).sort();
  return {app:name,expectedRunning:EXPECTED.has(name),inventoryOk:Array.isArray(machinesRaw),machines,logs:{readOk:lr.ok,recordCount:logRows.length,firstAt:times[0]||null,lastAt:times.at(-1)||null,counts,recentWindowMinutes:10,recentCounts,details},findings:[...(machines.some(m=>m.cpuKind==='performance')?['performance_cpu']:[]),...(machines.some(m=>m.cpus>4)?['cpu_above_four']:[]),...(machines.some(m=>m.state==='started'&&!m.checks.length)?['health_checks_not_configured']:[]),...(EXPECTED.has(name)&&!machines.some(m=>m.state==='started')?['no_running_machine']:[]),...(machines.some(m=>m.state==='started'&&m.checks.some(c=>['critical','failing','fail'].includes(c.status)))?['failing_health_checks']:[]),...(machines.some(m=>m.usage?.ramUsedPercent>=85)?['high_ram']:[]),...(machines.some(m=>m.usage?.cpuUsedPercent>=85)?['high_cpu_sample']:[]),...(!lr.ok?['logs_unavailable']:[]),...(!Array.isArray(machinesRaw)?['inventory_unavailable']:[]),...(machines.some(m=>m.usage?.unavailable)?['usage_unavailable']:[])]};
}
export async function audit() {
  const r=await fly(['apps','list','--json']);const all=r.ok?json(r.text):null;
  if(!Array.isArray(all))throw Error('App inventory unavailable');
  const names=all.map(a=>a.Name||a.name).filter(n=>typeof n==='string'&&/^[a-z0-9-]+$/.test(n));
  const excludedApps=names.filter(name=>PARTNER_APP.test(name));
  const included=names.filter(name=>!PARTNER_APP.test(name));
  const rows=[];for(let i=0;i<included.length;i+=3)rows.push(...await Promise.all(included.slice(i,i+3).map(appAudit)));
  return {ok:rows.every(r=>r.inventoryOk&&r.logs.readOk),capturedAt:new Date().toISOString(),readOnly:true,excludedApps,usageNote:'CPU is a two-second sample; RAM used excludes available memory. Stopped Machines have no usage sample. Log counts classify retained records, not distinct incidents. Raw logs are not exported.',apps:rows};
}
if(process.argv[1]&&import.meta.url.endsWith('/'+process.argv[1].split('/').at(-1)))audit().then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.log(JSON.stringify({ok:false,error:'Fleet audit failed; inspect credential availability and Fly control access.'}));process.exitCode=1;});
