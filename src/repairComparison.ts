import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getManagedFlyApps, getManagedFlyAppStates } from "./flyObservability.js";
import { getRepoConfigForApp } from "./repoMap.js";
import { evidenceRoot } from "./operationsEvidence.js";
import { writeAtomicJson } from "./atomicJson.js";
import { redactSensitiveValue } from "./redaction.js";

// This records an actual repair separately from the coder proposal. It never
// approves, publishes, learns or deploys a generated patch.
export async function recordActualRepair(input: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env) {
  const appName = String(input.appName || "");
  const fingerprint = String(input.fingerprint || "");
  const commit = String(input.commit || "");
  const runId = Number(input.workflowRunId);
  const repo = getRepoConfigForApp(appName);
  if (!repo || !getManagedFlyApps(env).includes(appName) || !/^[a-f0-9]{16,64}$/.test(fingerprint) || !/^[a-f0-9]{40}$/.test(commit) || !Number.isSafeInteger(runId) || runId < 1) throw new Error("A managed app, incident fingerprint, commit and workflowRunId are required");
  const slug = new URL(repo.repoUrl).pathname.replace(/^\//, "").replace(/\.git$/, "");
  const github = async (path: string) => {
    const response = await fetch(`https://api.github.com/repos/${slug}/${path}`, { headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json" }, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("Repair deployment evidence could not be read"); }
    return await response.json() as any;
  };
  const run = await github(`actions/runs/${runId}`);
  if (run.head_sha !== commit || run.status !== "completed" || run.conclusion !== "success" || run.head_branch !== "main" || run.repository?.full_name !== slug) throw new Error("Repair must have a successful main deployment for this exact commit");
  const source = await github(`commits/${commit}`);
  const states = await getManagedFlyAppStates(env, appName);
  const record = redactSensitiveValue({ appName, fingerprint, commit, repo: slug, recordedAt: new Date().toISOString(),
    summary: String(input.summary || "").slice(0,4000), operatorObservation: String(input.observation || "").slice(0,4000),
    changedFiles: (source.files || []).map((file: any) => file.filename),
    workflow: { id: runId, conclusion: run.conclusion, url: run.html_url }, machineHealth: states,
    verificationScope: "GitHub deployment success and current Fly machine health. Operator observation is a separate claim; recurrence is measured by future incidents." });
  const dir = evidenceRoot(env); await mkdir(dir, { recursive: true });
  const file = join(dir,"actual-repairs.json");
  let rows: any[] = []; try { const old = JSON.parse(await readFile(file,"utf8")); if (Array.isArray(old)) rows=old; } catch {}
  const existing = rows.find(row => row.appName===appName && row.fingerprint===fingerprint && row.commit===commit);
  if (existing) return existing;
  await writeAtomicJson(file,[...rows,record]);
  return record;
}
