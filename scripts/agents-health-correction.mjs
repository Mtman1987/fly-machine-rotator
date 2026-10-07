import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const app='spmt-agents', id='85d626f42450e8';
const endpoint='https://api.machines.dev/v1/apps/'+app+'/machines/'+id;
const check={type:'http',port:8080,protocol:'http',method:'GET',path:'/health',interval:'30s',timeout:'5s',grace_period:'30s'};
const token=process.env.FLY_API_TOKEN;
let nonce,changed=false;
async function api(path='',method='GET',body) {
  const r=await fetch(endpoint+path,{method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...(nonce?{'fly-machine-lease-nonce':nonce}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000),redirect:'error'});
  if(!r.ok){await r.body?.cancel();throw new Error('fly_request_rejected_'+r.status);}
  return r.json();
}
async function fly(args) {
  try{return (await exec('flyctl',args,{timeout:30000,maxBuffer:1048576})).stdout;}
  catch{throw new Error('runtime_probe_failed');}
}
function unchanged(config) {
  const value=structuredClone(config);delete value.checks;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
try {
 if(!token)throw new Error('authentication_unavailable');
 let before=await api();
 if(before.state!=='started'||before.config.guest.cpu_kind!=='shared'||before.config.guest.cpus!==1||before.config.guest.memory_mb!==512)throw new Error('unexpected_machine_resources');
 if(!/registry\.fly\.io\/spmt-agents/.test(before.config.image||'')||Object.keys(before.config.init||{}).some(k=>(before.config.init[k]||[]).length))throw new Error('unexpected_startup_configuration');
 const findPython="awk 'BEGIN { getline children < \"/proc/1/task/1/children\"; n=split(children,pids,\" \"); for(i=1;i<=n;i++){path=\"/proc/\"pids[i]\"/comm\"; getline cmd < path; close(path); if(cmd~/python/)print \"python_pid\",pids[i];}}'";
 const pid=Number((await fly(['ssh','console','--app',app,'--command',findPython,'--quiet'])).match(/python_pid (\d+)/)?.[1]||0);
 if(!pid)throw new Error('service_process_not_found');
 const probe=`import json,urllib.request,os,ast
owned=False
routes=[]
for pid in open("/proc/1/task/1/children").read().split():
 try:
  args=open("/proc/"+pid+"/cmdline","rb").read().decode().split("\\x00")
  if "python" not in " ".join(args):continue
  for arg in args:
   if not arg.endswith(".py"):continue
   file=arg if arg.startswith("/") else "/proc/"+pid+"/cwd/"+arg
   if not os.path.isfile(file):continue
   source=open(file).read()
   owned=owned or "Mtman1987" in source or "SpaceMountain" in source or "spmt" in source.lower()
   routes += [n.value for n in ast.walk(ast.parse(source)) if isinstance(n,ast.Constant) and isinstance(n.value,str) and n.value=="/health"]
 except Exception:pass
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
r=opener.open("http://[${before.private_ip}]:8080/health",timeout=5)
d=json.load(r)
print(json.dumps({"owned_source":int(owned),"health_route":int("/health" in routes),"private_http_status":r.status,"healthy":int(d.get("status") in ("ok","healthy","ready") or d.get("healthy") is True)},separators=(",",":")))
`;
 const output=await fly(['ssh','console','--app',app,'--command','/proc/'+pid+'/exe -c exec(bytes(['+[...probe].map(c=>c.charCodeAt(0)).join(',')+']).decode())','--quiet']);
 const metrics=JSON.parse(output.match(/\{"owned_source"[^\n]*\}/)?.[0]||'{}');
 if(metrics.owned_source!==1||metrics.health_route!==1||metrics.private_http_status!==200||metrics.healthy!==1)throw new Error('service_health_precondition_failed');
 const lease=await api('/lease','POST',{ttl:180,description:'Approved agents health correction'});
 nonce=lease.data?.nonce;
 if(!nonce)throw new Error('lease_not_acquired');
 before=await api();
 const prior=unchanged(before.config);
 const config=structuredClone(before.config);
 if(config.checks?.agents_ready&&JSON.stringify(config.checks.agents_ready)!==JSON.stringify(check))throw new Error('existing_check_conflict');
 if(!config.checks?.agents_ready){
  config.checks={...config.checks,agents_ready:check};
  await api('','POST',{config,current_version:before.instance_id});
  changed=true;
 }
 let after;
 for(let attempt=0;attempt<40;attempt++){
  after=await api();
  if(unchanged(after.config)!==prior)throw new Error('unrelated_configuration_changed');
  const checks=Array.isArray(after.checks)?after.checks:Object.entries(after.checks||{}).map(([name,c])=>({name,...c}));
  if(after.state==='started'&&checks.some(c=>c.name==='agents_ready'&&c.status==='passing')){
   console.log(JSON.stringify({app,changed:Number(changed),check_category:'agents_ready',health_passing:1,shared_cpus:after.config.guest.cpus,ram_allocated_mb:after.config.guest.memory_mb,other_configuration_preserved:1}));
   break;
  }
  if(attempt===39)throw new Error('health_verification_pending');
  await new Promise(resolve=>setTimeout(resolve,3000));
 }
}catch(e){console.log(JSON.stringify({app,changed:Number(changed),health_passing:0,error_category:/^[a-z_]+(?:_\d+)?$/.test(e.message)?e.message:'operation_failed'}));process.exitCode=1;}
finally{if(nonce){try{await api('/lease','DELETE');}catch{console.log(JSON.stringify({app,lease_release_verified:0}));}}}
