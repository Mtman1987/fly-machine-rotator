import {execFile} from 'node:child_process';import {promisify} from 'node:util';const exec=promisify(execFile);
function json(s){try{return JSON.parse(s)}catch{return null}}
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

async function fly(args){try{return {ok:true,text:(await exec('flyctl',args,{timeout:90000,maxBuffer:16777216})).stdout}}catch{return {ok:false,text:''}}}

const r=await fly(['logs','--app','spmt-agents','--json','--no-tail']);const rows=records(r.text);const groups={};const codes={};for(const row of rows){const s=String(row.message||row.msg||row.log||'');if(!/error|exception|failed|rejection/i.test(s))continue;const rules=[['missing_executable',/executable.*not found|no such file|ENOENT|command not found/i],['ssh_agent_unavailable',/ssh|sshd|vsock/i],['init_or_entrypoint_failure',/init|entrypoint|exec|command/i],['upstream_connection_failure',/connect|socket|ECONN|network/i],['permission_failure',/permission|denied|unauthori/i],['missing_module',/module|import/i],['configuration_failure',/config|missing|environment/i],['health_failure',/health/i]];const c=rules.find(([,re])=>re.test(s))?.[0]||'unclassified_failure';groups[c]=(groups[c]||0)+1;for(const m of s.matchAll(/(?:exit(?:ed)?(?: with)?(?: code)?|status)[^\d]{0,6}(\d{1,3})/gi))codes[m[1]]=(codes[m[1]]||0)+1;}console.log(JSON.stringify({app:'spmt-agents',retained_records:rows.length,error_categories:groups,exit_status_counts:codes}));
const r2=await fly(['machines','list','--app','spmt-agents','--json']);for(const m of json(r2.text)||[]){const c=m.config||{};const md=c.metadata||{};console.log(JSON.stringify({app:'spmt-agents',image_revision:md.fly_release_id||null,process_group:md.fly_process_group||null,entrypoint_count:(c.init?.entrypoint||[]).length,command_count:(c.init?.cmd||[]).length,image_config_has_init:Number(!!c.init),environment_key_count:Object.keys(c.env||{}).length,auto_destroy:Number(c.auto_destroy===true)}));}
