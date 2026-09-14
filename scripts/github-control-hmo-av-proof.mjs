#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const APP = 'hmo-dj-worker';
const VIDEO_ID = 'aqz-KE-bpKQ';

function redact(value) {
  return String(value ?? '')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/(FlyV1\s*)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]')
    .replace(/((?:token|authorization|secret|password|cookie))\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/https?:\/\/[^\s"']+/gi, '[MEDIA_URL_REDACTED]')
    .slice(0, 12000);
}

function decodePayload(encoded) {
  if (!/^[A-Za-z0-9+/=_-]{4,12000}$/.test(String(encoded || ''))) throw new Error('Invalid control payload encoding.');
  const value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value) || String(value.command || '').toLowerCase() !== 'hmoav') {
    throw new Error('Unsupported HMO A/V proof command.');
  }
  return value;
}

async function run(program, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(program, args, {
      env: options.env || process.env,
      encoding: 'utf8',
      timeout: options.timeout ?? 180000,
      maxBuffer: 12 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout || ''), stderr: redact(error?.stderr || error?.message || error) };
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

function parseSentinel(raw) {
  const match = String(raw || '').match(/HMO_AV_PROOF_JSON=([A-Za-z0-9+/=]+)/);
  if (!match) throw new Error('HearMeOut A/V proof did not return its sentinel.');
  return parseJson(Buffer.from(match[1], 'base64').toString('utf8'), 'HearMeOut A/V proof sentinel');
}

const REMOTE_PROOF = String.raw`
(async()=>{
  const {execFileSync}=require('node:child_process');
  const fs=require('node:fs');
  const os=require('node:os');
  const path=require('node:path');
  const videoId='${VIDEO_ID}';
  const watch='https://www.youtube.com/watch?v='+videoId;
  const safe=(e)=>String(e?.stderr||e?.message||e||'').replace(/https?:\/\/[^\s"']+/gi,'[MEDIA_URL_REDACTED]').replace(/((?:token|authorization|secret|password|cookie))\s*[:=]\s*\S+/gi,'$1=[REDACTED]').slice(0,700);
  const run=(cmd,args,timeout=120000)=>execFileSync(cmd,args,{encoding:'utf8',timeout,maxBuffer:12*1024*1024,stdio:['ignore','pipe','pipe']});
  const out={ok:false,fixtureVideoId:videoId,authoritativeSources:1,encoderProcesses:1,intermediateYoutubeHls:false,liveKitMedia:false};
  let tmp='';
  try{
    out.ytDlpVersion=run('yt-dlp',['--version'],15000).trim().slice(0,80);
    out.ffmpegAvailable=/ffmpeg version/i.test(run('ffmpeg',['-version'],15000).split('\n')[0]);
    out.ffprobeAvailable=/ffprobe version/i.test(run('ffprobe',['-version'],15000).split('\n')[0]);
    const selector='bv[height<=720]+ba/b[height<=720]/b';
    const raw=run('yt-dlp',['--ignore-config','--js-runtimes','node','--dump-single-json','--no-playlist','--no-warnings','-f',selector,'--',watch],120000);
    const body=JSON.parse(raw);
    const requested=Array.isArray(body.requested_formats)&&body.requested_formats.length?body.requested_formats:[body];
    const hasVideo=f=>typeof f?.url==='string'&&f.vcodec&&f.vcodec!=='none';
    const hasAudio=f=>typeof f?.url==='string'&&f.acodec&&f.acodec!=='none';
    const video=requested.find(hasVideo)||null;
    const audio=requested.find(f=>hasAudio(f)&&(!f.vcodec||f.vcodec==='none'))||requested.find(hasAudio)||null;
    if(!video||!audio)throw new Error('yt-dlp did not return selected video and audio formats');
    const sameUrl=video.url===audio.url;
    out.selector=selector;
    out.transportInputs=sameUrl?1:2;
    out.selectedVideoFormatId=String(video.format_id||'').slice(0,40);
    out.selectedAudioFormatId=String(audio.format_id||'').slice(0,40);
    out.selectedHeight=Number.isFinite(Number(video.height))?Number(video.height):null;
    out.selectedVideoCodec=String(video.vcodec||'').slice(0,80);
    out.selectedAudioCodec=String(audio.acodec||'').slice(0,80);
    const headerArgs=f=>{
      const headers=f&&f.http_headers&&typeof f.http_headers==='object'?f.http_headers:{};
      const lines=Object.entries(headers).filter(([k,v])=>typeof k==='string'&&typeof v==='string'&&k&&!/[\r\n]/.test(k+v)).map(([k,v])=>k+': '+v);
      return lines.length?['-headers',lines.join('\r\n')+'\r\n']:[];
    };
    const videoProbe=JSON.parse(run('ffprobe',['-v','error','-rw_timeout','15000000',...headerArgs(video),'-show_streams','-of','json',video.url],30000));
    const videoStreams=Array.isArray(videoProbe.streams)?videoProbe.streams:[];
    out.sourceVideoStreams=videoStreams.filter(s=>s.codec_type==='video').length;
    if(out.sourceVideoStreams<1)throw new Error('ffprobe did not confirm video on yt-dlp selected video input');
    if(sameUrl){
      out.sourceAudioStreams=videoStreams.filter(s=>s.codec_type==='audio').length;
    }else{
      const audioProbe=JSON.parse(run('ffprobe',['-v','error','-rw_timeout','15000000',...headerArgs(audio),'-show_streams','-of','json',audio.url],30000));
      const audioStreams=Array.isArray(audioProbe.streams)?audioProbe.streams:[];
      out.sourceAudioStreams=audioStreams.filter(s=>s.codec_type==='audio').length;
    }
    if(out.sourceAudioStreams<1)throw new Error('ffprobe did not confirm audio on yt-dlp selected audio input');
    tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hmo-av-proof-'));
    const index=path.join(tmp,'index.m3u8');
    const inputs=sameUrl
      ? [...headerArgs(video),'-i',video.url]
      : [...headerArgs(video),'-i',video.url,...headerArgs(audio),'-i',audio.url];
    const maps=sameUrl?['-map','0:v:0','-map','0:a:0']:['-map','0:v:0','-map','1:a:0'];
    run('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-y','-threads','2','-t','8',...inputs,...maps,'-c:v','libx264','-preset','veryfast','-pix_fmt','yuv420p','-c:a','aac','-ac','2','-b:a','128k','-f','hls','-hls_time','2','-hls_list_size','0','-hls_segment_filename',path.join(tmp,'seg%03d.ts'),index],90000);
    const segments=fs.readdirSync(tmp).filter(n=>/^seg\d+\.ts$/.test(n));
    out.hlsManifest=fs.existsSync(index)&&fs.statSync(index).size>0;
    out.hlsSegments=segments.length;
    if(!out.hlsManifest||segments.length<1)throw new Error('one encoder did not produce HLS output');
    const outputProbe=JSON.parse(run('ffprobe',['-v','error','-show_streams','-of','json',path.join(tmp,segments[0])],20000));
    const outputStreams=Array.isArray(outputProbe.streams)?outputProbe.streams:[];
    out.outputVideoStreams=outputStreams.filter(s=>s.codec_type==='video').length;
    out.outputAudioStreams=outputStreams.filter(s=>s.codec_type==='audio').length;
    if(out.outputVideoStreams<1||out.outputAudioStreams<1)throw new Error('encoded broadcast segment did not contain both video and audio');
    out.ok=true;
    out.stage='complete';
  }catch(e){out.stage='resolve-probe-or-encode';out.error=safe(e)}finally{if(tmp){try{fs.rmSync(tmp,{recursive:true,force:true})}catch{}}}
  process.stdout.write('HMO_AV_PROOF_JSON='+Buffer.from(JSON.stringify(out),'utf8').toString('base64'));
  if(!out.ok)process.exitCode=1;
})().catch(e=>{const out={ok:false,fixtureVideoId:'${VIDEO_ID}',stage:'runner',error:String(e?.message||e).slice(0,500)};process.stdout.write('HMO_AV_PROOF_JSON='+Buffer.from(JSON.stringify(out),'utf8').toString('base64'));process.exitCode=1});
`;

async function main() {
  try {
    decodePayload(process.argv[2]);
    const machinesRead = await fly(['machines', 'list', '--app', APP, '--json']);
    if (!machinesRead.ok) throw new Error(machinesRead.stderr || 'Unable to list HMO worker Machines.');
    const machines = parseJson(machinesRead.stdout, 'HMO worker Machines list');
    const active = (Array.isArray(machines) ? machines : []).filter((machine) => machine?.state === 'started');
    if (active.length !== 1) throw new Error(`Expected exactly one started HMO worker; found ${active.length}.`);
    const encoded = Buffer.from(REMOTE_PROOF, 'utf8').toString('base64');
    const command = `node -e "eval(Buffer.from('${encoded}','base64').toString('utf8'))"`;
    const result = await fly(['ssh', 'console', '--app', APP, '--machine', String(active[0].id), '--command', command, '--quiet'], { timeout: 180000 });
    const output = parseSentinel(`${result.stdout}\n${result.stderr}`);
    process.stdout.write(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, fixtureVideoId: VIDEO_ID, stage: 'fly-control', error: redact(error instanceof Error ? error.message : error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
