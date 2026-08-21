import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src/mtfixitResolution.ts');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('from "./chatgptHandoff.js"')) {
  source = source.replace(
    'import { listRepoConfigs } from "./repoMap.js";\n',
    'import { listRepoConfigs } from "./repoMap.js";\nimport { approveChatGptHandoff, readChatGptHandoff, writeChatGptHandoff } from "./chatgptHandoff.js";\nimport { loadEcosystemOperatorContext } from "./ecosystemContext.js";\n',
  );
}

source = source.replace(
  'status: "awaiting_analysis" | "awaiting_approval" | "deploying" | "deployed" | "failed" | "denied" | "no_change";',
  'status: "awaiting_analysis" | "awaiting_approval" | "awaiting_chatgpt" | "deploying" | "deployed" | "failed" | "denied" | "no_change";',
);

if (!source.includes('async function queueMtFixItForChatGpt')) {
  const marker = 'async function resolveJob(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number): Promise<MtFixItResolutionState> {';
  const index = source.indexOf(marker);
  if (index < 0) throw new Error('resolveJob marker missing from mtfixitResolution.ts');
  const addition = `async function queueMtFixItForChatGpt(job: CodexJob, env: NodeJS.ProcessEnv, dashboardPort: number, signature: string): Promise<MtFixItResolutionState> {\n  const repo = listRepoConfigs().find((item) => item.id === job.repoId);\n  if (!repo) throw new Error(\`Unknown repository \${job.repoId}\`);\n  const pullRequest = await ensurePublished(job, env, dashboardPort);\n  const handoffId = \`chatgpt-\${job.id}\`;\n  let handoff = await readChatGptHandoff(env, handoffId);\n  if (!handoff) {\n    const operatorContext = await loadEcosystemOperatorContext(env);\n    handoff = await writeChatGptHandoff(env, {\n      jobId: job.id,\n      appName: job.appName,\n      repoId: job.repoId,\n      repoLabel: String((repo as any).label || job.repoId),\n      repoUrl: String(repo.repoUrl || ''),\n      description: job.description,\n      userContext: { source: job.source || 'dsh:mtfixit', reporter: job.reporter, reporterId: job.reporterId || null, tenantId: job.tenantId || null, mtfixit: true, draftPullRequest: pullRequest },\n      qwenFailure: 'Local Qwen produced a validated MtFixIt repair. ChatGPT must review the draft PR, regression coverage, deployment, and live behavior before completion.',\n      baselineChecks: (job.checks || []).map((check) => ({ command: check.command, ok: check.ok, output: check.output || '' })),\n      operatorContext,\n      repositoryContext: \`Qwen draft PR #\${pullRequest.number} is the starting point. Fetch current main, AGENTS.md, the PR diff, and required tests before approving or changing it.\`,\n      validationCommands: (job.checks || []).map((check) => check.command),\n    });\n  }\n  if (handoff.status === 'awaiting-owner-approval') {\n    handoff = await approveChatGptHandoff(env, handoff.id, 'mtfixit-standing-policy');\n  }\n  const state: MtFixItResolutionState = {\n    schemaVersion: 'mtfixit.resolution/v1',\n    jobId: job.id,\n    status: 'awaiting_chatgpt',\n    updatedAt: new Date().toISOString(),\n    signature,\n    pullRequest,\n    message: \`Athena validated draft PR #\${pullRequest.number}. It is queued for the next ChatGPT review/deploy/live-verification pass. handoff=\${handoff.id}\`,\n  };\n  await saveResolution(env, state);\n  return state;\n}\n\n`;
  source = source.slice(0, index) + addition + source.slice(index);
}

const oldSuccessBlock = `  const existing = await readMtFixItResolution(env, job.id); if (existing && ["awaiting_approval", "deploying", "deployed", "failed", "denied"].includes(existing.status)) return existing;\n  const patchHash = await jobPatchHash(env, job.id);\n  const known = Boolean(patchHash) && (await listKnownFixes(env)).some((item) => item.signature === signature && item.repoId === job.repoId && item.patchHash === patchHash);\n  const state: MtFixItResolutionState = {\n    schemaVersion: "mtfixit.resolution/v1",\n    jobId: job.id,\n    status: known ? "deploying" : "awaiting_approval",\n    updatedAt: new Date().toISOString(),\n    signature,\n    patchHash: patchHash || undefined,\n    knownFix: known,\n    message: known\n      ? "This report regenerated the exact previously approved validated patch. Athena is applying the known fix automatically."\n      : "Athena found and validated a new or changed fix. mtman approval is required before merge/deployment.",\n  };\n  await saveResolution(env, state); if (known) void deployInBackground(job, env, dashboardPort, state); return state;`;
const newSuccessBlock = `  const existing = await readMtFixItResolution(env, job.id); if (existing && ["awaiting_chatgpt", "deploying", "deployed", "failed", "denied"].includes(existing.status)) return existing;\n  return queueMtFixItForChatGpt(job, env, dashboardPort, signature);`;
if (source.includes(oldSuccessBlock)) source = source.replace(oldSuccessBlock, newSuccessBlock);
else if (!source.includes('return queueMtFixItForChatGpt(job, env, dashboardPort, signature);')) throw new Error('MtFixIt successful-resolution block marker missing');

source = source.replace(
  '  if (state.status === "deployed" || state.status === "deploying") return state;',
  '  if (state.status === "deployed" || state.status === "deploying" || state.status === "awaiting_chatgpt") return state;',
);

fs.writeFileSync(file, source, 'utf8');
console.log('MtFixIt ChatGPT review queue patch applied.');
