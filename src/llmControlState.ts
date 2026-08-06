import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LlmControlState = {
  provisioningEnabled: boolean;
  updatedAt: string;
};

function stateFile(env: NodeJS.ProcessEnv): string {
  return String(env.SPMT_LLM_CONTROL_STATE_FILE || "/data/spmt-llm-control.json");
}

export async function readLlmControlState(env: NodeJS.ProcessEnv): Promise<LlmControlState> {
  try {
    const parsed = JSON.parse(await readFile(stateFile(env), "utf8")) as Partial<LlmControlState>;
    return {
      provisioningEnabled: parsed.provisioningEnabled === true,
      updatedAt: String(parsed.updatedAt || ""),
    };
  } catch {
    return {
      provisioningEnabled: String(env.MCP_ALLOW_FLY_PROVISIONING || "").trim().toLowerCase() === "true",
      updatedAt: "",
    };
  }
}

export async function writeLlmControlState(env: NodeJS.ProcessEnv, provisioningEnabled: boolean): Promise<LlmControlState> {
  const state: LlmControlState = {
    provisioningEnabled,
    updatedAt: new Date().toISOString(),
  };
  const file = stateFile(env);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  return state;
}
