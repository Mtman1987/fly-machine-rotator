#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'discord-stream-hub-new';

function redact(value) {
  return String(value ?? '').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]').slice(0, 4000);
}

async function main() {
  try {
    const raw = Buffer.from(String(process.argv[2] || ''), 'base64').toString('utf8');
    const payload = JSON.parse(raw);
    if (payload?.command !== 'twitchstatus') throw new Error('Unsupported command.');
    const source = `
(async()=>{
const key=String(process.env.SPMT_API_KEY||process.env.SPMT_PLATFORM_API_KEY||'').trim();
if(!key) throw Error('DSH service key is not configured');
const r=await fetch('http://127.0.0.1:3000/api/internal/twitch/live-status?login=spacemountainlive',{headers:{authorization:'Bearer '+key,accept:'application/json'},signal:AbortSignal.timeout(15000)});
const b=await r.json().catch(()=>null);
process.stdout.write(JSON.stringify({status:r.status,body:b}));
if(!r.ok) process.exit(2);
})().catch(e=>{console.error(e?.message||e);process.exit(1)});
`;
    const encoded = Buffer.from(source,'utf8').toString('base64');
    const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
    const env={...process.env,FLY_API_TOKEN:String(process.env.FLY_API_TOKEN||'')};
    const {stdout}=await execFileAsync('flyctl',['ssh','console','--app',APP,'--command',command,'--quiet'],{env,encoding:'utf8',timeout:60000,maxBuffer:1024*1024});
    const text=String(stdout||'').trim(); const start=text.indexOf('{');
    if(start<0) throw new Error('Twitch status returned malformed output.');
    const result=JSON.parse(text.slice(start));
    if(!(result.status>=200&&result.status<300)) throw new Error(String(result.body?.error||('Twitch status failed ('+result.status+')')));
    process.stdout.write(JSON.stringify({ok:true,...result.body},null,2));
  } catch(error) {
    process.stdout.write(JSON.stringify({ok:false,error:redact(error instanceof Error?error.message:error)},null,2));
    process.exitCode=1;
  }
}
void main();
