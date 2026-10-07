import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

export async function validationEnvironment(cwd: string, parent: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const root = join(tmpdir(), "spmt-validation", createHash("sha256").update(cwd).digest("hex").slice(0,20));
  const data = join(root,"data"); const temporary = join(root,"tmp");
  await mkdir(data,{recursive:true,mode:0o700}); await mkdir(temporary,{recursive:true,mode:0o700});
  const env: NodeJS.ProcessEnv = { PATH: parent.PATH || "/usr/local/bin:/usr/bin:/bin", LANG: parent.LANG || "C.UTF-8", TMPDIR: temporary, CI:"true", PERSIST_ROOT:data, DATA_DIR:data, ROTATOR_DATA_DIR:data, npm_config_cache:join(root,"npm-cache"), npm_config_userconfig:join(root,"npmrc"), GIT_CONFIG_GLOBAL:join(root,"gitconfig") };
  for(const key of ["SystemRoot","ComSpec","WINDIR","TZ"]) if(parent[key]) env[key]=parent[key];
  for(const name of ["npmrc","gitconfig"]) await writeFile(join(root,name),"",{mode:0o600});
  const directories = { CODEX_FIXER_DATA_DIR:"coder", CODEX_FIXER_WORK_DIR:"work", ROTATOR_REPO_CACHE_DIR:"repos", ROTATOR_EVIDENCE_DIR:"evidence", ROTATOR_ERROR_ARCHIVE_DIR:"archives", MTFIXIT_RESOLUTION_DIR:"resolutions" };
  for(const [key,name] of Object.entries(directories)) env[key]=join(data,name);
  const files = ["ROTATION_HISTORY_FILE","LOG_ERROR_HISTORY_FILE","LOG_OBSERVATION_HISTORY_FILE","LOG_ERROR_DEDUPE_FILE","ROTATOR_ERROR_BASELINE_FILE","ROTATOR_ATHENA_ATTEMPTS_FILE","HOURLY_REPAIR_CYCLES_FILE","ROTATOR_RUNTIME_STATE_FILE","ROTATOR_FIXES_FILE","ROTATOR_IGNORE_RULES_FILE","DISCORD_UNIFIED_REPORT_MESSAGE_FILE","DISCORD_ERROR_REPORT_MESSAGE_FILE","DISCORD_ROTATION_REPORT_MESSAGE_FILE","ROTATOR_LOG_SNAPSHOT_FILE","STREAM_SESSION_RESET_STATE_FILE","ROTATOR_ACTION_AUDIT_FILE","ATHENA_LOCAL_SETTINGS_FILE","SPMT_LLM_CONTROL_STATE_FILE","MOUNTAINVIEW_DB_FILE","MOUNTAINVIEW_CONFIG_FILE","MTFIXIT_KNOWN_FIXES_FILE"];
  for(const key of files) env[key]=join(data,key.toLowerCase()+".json");
  env.ROTATOR_ACTION_AUDIT_FILE=join(data,"action-audit.jsonl");
  env.MOUNTAINVIEW_DB_FILE=join(data,"mountainview.db");
  // No production credentials, webhook URL, machine identity or service routes.
  return env;
}
