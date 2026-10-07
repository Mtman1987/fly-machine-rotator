import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';const exec=promisify(execFile);
const source="process.stdout.write(JSON.stringify({key:String(process.env.GEMINI_API_KEY||'').trim()}))";
try{
 const r=await exec('flyctl',['ssh','console','--app','streamweaver-new','--command','node -e eval(String.fromCharCode('+[...source].map(c=>c.charCodeAt(0)).join(',')+'))','--quiet'],{timeout:60000,maxBuffer:65536});
 const line=r.stdout.split('\n').find(l=>l.startsWith('{"key":'));const key=line?JSON.parse(line).key:'';
 if(typeof key!=='string'||!key.endsWith('5CvQ')||!/^[A-Za-z0-9_-]{20,200}$/.test(key))throw Error('verification_failure');
 await new Promise((resolve,reject)=>{const p=spawn('flyctl',['secrets','import','--app','mtman-machine-rotator','--stage'],{stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>{p.kill();reject(Error('stage_failure'));},90000);p.stdout.resume();p.stderr.resume();p.on('error',()=>{clearTimeout(timer);reject(Error('stage_failure'));});p.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('stage_failure'));});p.stdin.end('GEMINI_API_KEY='+key+'\n');});
 console.log(JSON.stringify({app:'mtman-machine-rotator',verified_free_key_staged:1,plaintext_exported:0,machine_restart_requested:0,paid_route_enabled:0}));
}catch{console.log(JSON.stringify({app:'mtman-machine-rotator',key_stage_failed:1,category:'verification_or_stage_failure'}));process.exitCode=1;}
