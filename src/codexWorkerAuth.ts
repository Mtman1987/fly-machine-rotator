import { randomBytes } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";

export const CODEX_WORKER_SECRET_FILE = "/tmp/athena-coder-worker-secret";

export function withCodexWorkerAuth(env: NodeJS.ProcessEnv, secretFile = CODEX_WORKER_SECRET_FILE): NodeJS.ProcessEnv {
  const secret = String(env.CODEX_WORKER_SECRET || "").trim() || randomBytes(32).toString("base64url");
  writeFileSync(secretFile, `${secret}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(secretFile, 0o600);
  return { ...env, CODEX_WORKER_SECRET: secret };
}
