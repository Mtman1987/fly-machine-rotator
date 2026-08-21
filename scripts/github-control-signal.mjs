#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'streamweaver-new';

function decode(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

function limit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 25;
  return Math.min(100, Math.max(1, Math.floor(n)));
}

const SIGNAL_SCRIPT = String.raw`
const fs=require('fs'),path=require('path');
const root=process.env.PERSIST_ROOT||path.resolve(process.cwd(),'data','runtime');
const g=path.join(root,'global');
const h=path.join(g,'signal-hint-history.json');
const s=path.join(g,'signal-scheduler.json');
const lim=Math.min(100,Math.max(1,Number(process.argv[1]||25)||25));
const read=(f,d)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return d}};
const hist=read(h,{totalPosts:0,uniqueChannelIds:[],history:[]});
const sched=read(s,null);
const list=Array.isArray(hist.history)?hist.history.slice(-lim):[];
process.stdout.write('__SIGNAL_BEGIN__'+JSON.stringify({totalPosts:Number(hist.totalPosts||0),uniqueChannelCount:Array.isArray(hist.uniqueChannelIds)?new Set(hist.uniqueChannelIds.map(String)).size:0,lastPostAt:hist.lastPostAt||null,latestPosts:list.map(x=>({at:String(x?.at||''),guildId:String(x?.guildId||''),channelId:String(x?.channelId||''),channelName:String(x?.channelName||'').slice(0,120)})),scheduler:sched?{guildId:String(sched.guildId||''),lastChannelId:String(sched.lastChannelId||''),bagRemaining:Array.isArray(sched.bag)?sched.bag.length:0,nextAt:Number(sched.nextAt||0)||null,nextAtIso:Number(sched.nextAt||0)>0?new Date(Number(sched.nextAt)).toISOString():null}:null,historyFilePresent:fs.existsSync(h),schedulerFilePresent:fs.existsSync(s)})+'__SIGNAL_END__');
`;

function redact(value) {
  return String(value ?? '').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]').replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]').slice(0,4000);
}

async function main() {
  try {
    const payload = decode(process.argv[2]);
    const count = limit(payload.limit);
    const encodedScript = Buffer.from(SIGNAL_SCRIPT, 'utf8').toString('base64');
    const remote = `node -e "const s=process.argv[1];process.argv.splice(1,1);eval(Buffer.from(s,'base64').toString('utf8'))" '${encodedScript}' '${count}'`;
    const { stdout } = await execFileAsync('flyctl', ['ssh', 'console', '--app', APP, '--command', remote], {
      env: { ...process.env, FLY_API_TOKEN: String(process.env.FLY_API_TOKEN || '') },
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const raw = String(stdout || '');
    const start = raw.indexOf('__SIGNAL_BEGIN__');
    const end = raw.indexOf('__SIGNAL_END__', start + 18);
    if (start < 0 || end < 0) throw new Error('Signal history returned no marked payload.');
    const result = JSON.parse(raw.slice(start + '__SIGNAL_BEGIN__'.length, end));
    process.stdout.write(JSON.stringify({ ok: true, appName: APP, readAt: new Date().toISOString(), limit: count, ...result }, null, 2));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
