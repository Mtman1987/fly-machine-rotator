import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { listRepoConfigs } from "./repoMap.js";
import { ensureRepoReady } from "./repoOps.js";

const OPERATOR_CONTEXT_PATH = "docs/ecosystem/CHATGPT_OPERATOR_CONTEXT.md";
const MAX_OPERATOR_CONTEXT_CHARS = 60_000;

export async function loadEcosystemOperatorContext(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const spmt = listRepoConfigs().find((repo) => repo.id === "spmt-live");
  if (!spmt) {
    return "Canonical SPMT operator context unavailable: spmt-live is missing from the Rotator repository map.";
  }

  try {
    const repoPath = await ensureRepoReady(spmt, env);
    const source = await readFile(join(repoPath, OPERATOR_CONTEXT_PATH), "utf8");
    const trimmed = source.trim();
    if (!trimmed) throw new Error("operator context file is empty");
    return trimmed.slice(0, MAX_OPERATOR_CONTEXT_CHARS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      "Canonical SPMT operator context could not be loaded for this repair.",
      `Reason: ${message.slice(0, 1000)}`,
      "Fallback rules: inspect AGENTS.md, make the smallest justified change, add regression coverage, validate before publication, keep merge/deploy/live verification distinct, and never expose secrets or arbitrary infrastructure mutation.",
    ].join("\n");
  }
}

export function ecosystemOperatorContextSource(): string {
  return `Mtman1987/spmt-live:${OPERATOR_CONTEXT_PATH}`;
}
