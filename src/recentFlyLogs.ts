import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { writeAtomicJson } from "./atomicJson.js";
import { redactSensitiveText } from "./redaction.js";
import type { SampledFlyLog } from "./flyObservability.js";
let ring: SampledFlyLog[] = [];
let lastSaved = 0;
let saveChain: Promise<void> = Promise.resolve();
const file = (env: NodeJS.ProcessEnv) => env.ROTATOR_LOG_SNAPSHOT_FILE || "/data/operations-evidence/log-ring.json";
export function rememberRecentFlyLog(entry: Omit<SampledFlyLog,"observedAt">, env: NodeJS.ProcessEnv = process.env) {
  if (!env.FLY_APP_NAME && !env.ROTATOR_LOG_SNAPSHOT_FILE) return;
  ring.push({...entry,observedAt:new Date().toISOString(),message:redactSensitiveText(entry.message).slice(0,4000)});
  ring = ring.slice(-200);
  if(Date.now()-lastSaved < 5000) return;
  lastSaved=Date.now(); const snapshot=ring.slice();
  saveChain=saveChain.catch(()=>undefined).then(async()=>{await mkdir(dirname(file(env)),{recursive:true});await writeAtomicJson(file(env),snapshot);});
  void saveChain.catch(()=>console.error("Recent log snapshot could not be saved"));
}
export async function readRecentFlyLogs(env: NodeJS.ProcessEnv = process.env, startedAt?: string): Promise<SampledFlyLog[]> {
  let values: SampledFlyLog[]=[];
  try{const parsed=JSON.parse(await readFile(file(env),"utf8"));if(Array.isArray(parsed))values=parsed;}catch{}
  return values.filter(log=>!startedAt || (log.timestamp || log.observedAt)>=startedAt).slice(-200).map(log=>({...log,message:redactSensitiveText(log.message)}));
}
