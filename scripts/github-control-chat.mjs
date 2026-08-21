#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'mtman-machine-rotator';

function decode(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  const raw = Buffer.from(encoded, 'base64').toString('utf8');
  if (raw.length > 8000) throw new Error('Control payload is too large.');
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Control payload must be an object.');
  return value;
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(id)) throw new Error('Invalid ChatGPT handoff ID.');
  return id;
}

function boundedText(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

function boundedLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

function boundedOutcome(value) {
  return String(value || '').toLowerCase() === 'failed' ? 'failed' : 'success';
}

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{12,}\b/g, '[REDACTED]')
    .slice(0, 8000);
}

async function flyRemote(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const remoteScript = String.raw`
const fs=require('fs'),path=require('path');
const p=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const root=process.env.CODEX_FIXER_DATA_DIR||'/data/codex-fixer';
const dir=path.join(root,'chatgpt-handoffs');
const safe=(v)=>/^[A-Za-z0-9_-]{8,120}$/.test(String(v||''));
const read=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return null}};
const clip=(v,n)=>String(v??'').slice(0,n);
let result;
if(p.command==='chatqueue'){
  const lim=Math.min(100,Math.max(1,Number(p.limit||25)||25));
  const rows=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>n.endsWith('.json')).map(n=>read(path.join(dir,n))).filter(Boolean):[];
  result={ok:true,count:0,handoffs:rows.filter(r=>r.status==='awaiting-chatgpt').sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,lim).map(r=>({id:r.id,jobId:r.jobId,status:r.status,createdAt:r.createdAt,appName:r.appName,repoId:r.repoId,repoLabel:r.repoLabel,repoUrl:r.repoUrl,description:clip(r.description,1600),qwenFailure:clip(r.qwenFailure,2400),validationCommands:Array.isArray(r.validationCommands)?r.validationCommands.slice(0,20):[],baselineChecks:Array.isArray(r.baselineChecks)?r.baselineChecks.map(c=>({command:clip(c.command,500),ok:Boolean(c.ok),output:clip(c.output,1800)})):[],operatorContextSource:r.operatorContextSource}))};
  result.count=result.handoffs.length;
}else if(p.command==='chatjob'){
  if(!safe(p.id)) throw new Error('Invalid ChatGPT handoff ID.');
  const r=read(path.join(dir,p.id+'.json'));
  if(!r) throw new Error('ChatGPT handoff was not found.');
  result={ok:true,handoff:{id:r.id,jobId:r.jobId,status:r.status,createdAt:r.createdAt,updatedAt:r.updatedAt,resolvedAt:r.resolvedAt||null,appName:r.appName,repoId:r.repoId,repoLabel:r.repoLabel,repoUrl:r.repoUrl,description:clip(r.description,4000),userContext:r.userContext??null,qwenFailure:clip(r.qwenFailure,8000),baselineChecks:Array.isArray(r.baselineChecks)?r.baselineChecks.map(c=>({command:clip(c.command,1000),ok:Boolean(c.ok),output:clip(c.output,5000)})):[],validationCommands:Array.isArray(r.validationCommands)?r.validationCommands.slice(0,20):[],operatorContextSource:r.operatorContextSource,operatorContext:clip(r.operatorContext,18000),repositoryContext:clip(r.repositoryContext,22000),instructions:Array.isArray(r.instructions)?r.instructions.slice(0,20):[],resolution:r.resolution||null}};
}else if(p.command==='chatdone'){
  if(!safe(p.id)) throw new Error('Invalid ChatGPT handoff ID.');
  const file=path.join(dir,p.id+'.json');
  const r=read(file);
  if(!r) throw new Error('ChatGPT handoff was not found.');
  const now=new Date().toISOString();
  const outcome=p.outcome==='failed'?'failed':'success';
  r.status='resolved';r.updatedAt=now;r.resolvedAt=now;r.resultStatus=outcome;r.resolution=clip(p.resolution||'Resolved by ChatGPT conversation.',4000);
  fs.writeFileSync(file,JSON.stringify(r,null,2));
  let mtfixit=null;
  if(r.userContext&&r.userContext.mtfixit&&safe(r.jobId)){
    const resolutionFile=path.join(root,'mtfixit-resolution',r.jobId+'.json');
    const state=read(resolutionFile);
    if(state){
      state.status=outcome==='success'?'deployed':'failed';
      state.updatedAt=now;
      state.message=clip(r.resolution,1200);
      state.chatgptHandoffId=r.id;
      state.chatgptOutcome=outcome;
      fs.writeFileSync(resolutionFile,JSON.stringify(state,null,2));
      mtfixit={jobId:r.jobId,status:state.status};
    }
  }
  result={ok:true,id:r.id,status:r.status,outcome,resolvedAt:r.resolvedAt,resolution:r.resolution,mtfixit};
}else{throw new Error('Unsupported ChatGPT handoff command.');}
process.stdout.write('__CHATGPT_BEGIN__'+JSON.stringify(result)+'__CHATGPT_END__');
`;
  const encodedScript = Buffer.from(remoteScript, 'utf8').toString('base64');
  const remote = `node -e "const s=process.argv[1];process.argv.splice(1,1);eval(Buffer.from(s,'base64').toString('utf8'))" '${encodedScript}' '${encodedPayload}'`;
  const { stdout } = await execFileAsync('flyctl', ['ssh', 'console', '--app', APP, '--command', remote], {
    env: { ...process.env, FLY_API_TOKEN: String(process.env.FLY_API_TOKEN || '') },
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const raw = String(stdout || '');
  const begin = '__CHATGPT_BEGIN__';
  const end = '__CHATGPT_END__';
  const start = raw.indexOf(begin);
  const finish = raw.indexOf(end, start + begin.length);
  if (start < 0 || finish < 0) throw new Error('ChatGPT handoff control returned no marked payload.');
  return JSON.parse(raw.slice(start + begin.length, finish));
}

async function main() {
  try {
    const payload = decode(process.argv[2]);
    const command = String(payload.command || '').toLowerCase();
    if (!['chatqueue', 'chatjob', 'chatdone'].includes(command)) throw new Error('Unsupported ChatGPT handoff command.');
    const request = { command };
    if (command === 'chatqueue') request.limit = boundedLimit(payload.limit);
    if (command === 'chatjob' || command === 'chatdone') request.id = safeId(payload.id);
    if (command === 'chatdone') {
      request.outcome = boundedOutcome(payload.outcome);
      request.resolution = boundedText(payload.resolution || 'Resolved by ChatGPT conversation.', 4000);
    }
    const result = await flyRemote(request);
    process.stdout.write(JSON.stringify(result, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();