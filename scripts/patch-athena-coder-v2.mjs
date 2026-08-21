import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixerPath = path.join(root, 'src/publicCodexFixer.ts');
let source = fs.readFileSync(fixerPath, 'utf8').replace(/\r\n/g, '\n');

function requireMarker(marker, label) {
  if (!source.includes(marker)) throw new Error(`Athena Coder v2 patch marker missing: ${label}`);
}

if (!source.includes('from "./coderContext.js"')) {
  const marker = 'import { getRepoConfigForApp, listRepoConfigs, type RepoConfig } from "./repoMap.js";\n';
  requireMarker(marker, 'coderContext import');
  source = source.replace(marker, marker + 'import { buildRepositoryContext } from "./coderContext.js";\n');
}

if (!source.includes('baselineChecks?: Array<{ command: string; ok: boolean; output: string }>;')) {
  const marker = '  checks: Array<{ command: string; ok: boolean; output: string }>;\n';
  requireMarker(marker, 'baselineChecks job field');
  source = source.replace(marker, marker + '  baselineChecks?: Array<{ command: string; ok: boolean; output: string }>;\n');
}

if (!source.includes('const context = await buildRepositoryContext(description, workspace);')) {
  const startMarker = '  const tracked = (await execFileAsync("git", ["ls-files"], { cwd: workspace, timeout: 60_000 })).stdout\n';
  const endMarker = '  if (!context) throw new Error("Qwen Coder could not select readable repository context.");\n';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Athena Coder v2 Qwen context block markers missing');
  source = source.slice(0, start) + '  const context = await buildRepositoryContext(description, workspace);\n' + source.slice(end + endMarker.length);
}

if (!source.includes('async function runCodexWorkspaceCoder(')) {
  const marker = 'function minimalCodexEnv(env: NodeJS.ProcessEnv, dataDir: string): Record<string, string> {\n';
  requireMarker(marker, 'Codex workspace helper');
  const helper = [
    'async function runCodexWorkspaceCoder(',
    '  description: string,',
    '  inputContext: unknown,',
    '  workspace: string,',
    '  repo: RepoConfig,',
    '  env: NodeJS.ProcessEnv,',
    '  dataDir: string',
    '): Promise<{ summary: string; threadId?: string }> {',
    '  const codex = new Codex({',
    '    apiKey: String(env.OPENAI_API_KEY || ""),',
    '    env: minimalCodexEnv(env, dataDir),',
    '    config: { sandbox_workspace_write: { network_access: false } },',
    '  });',
    '  const thread = codex.startThread({',
    '    workingDirectory: workspace,',
    '    model: String(env.CODEX_FIXER_MODEL || "gpt-5.6-sol"),',
    '    modelReasoningEffort: "high",',
    '    sandboxMode: "workspace-write",',
    '    networkAccessEnabled: false,',
    '    webSearchMode: "disabled",',
    '    approvalPolicy: "never",',
    '  });',
    '  const prompt = `${ATHENA_CODE_PROMPT}\\n\\nAssigned repository: ${repo.label}\\nPublic report: ${description.slice(0, 4000)}\\nContext JSON: ${JSON.stringify(inputContext || {}).slice(0, 6000)}`;',
    '  const turn = await thread.run(prompt);',
    '  return {',
    '    threadId: thread.id || undefined,',
    '    summary: redact(turn.finalResponse || "Codex completed without a final response."),',
    '  };',
    '}',
    '',
  ].join('\n');
  source = source.replace(marker, helper + marker);
}

if (!source.includes('const qwenConfigured = Boolean(String(env.SPMT_LLM_BASE_URL || "").trim());')) {
  const startMarker = '    if (String(env.SPMT_LLM_BASE_URL || "").trim()) {\n';
  const endMarker = '\n\n    // Intent-to-add makes new files part of the durable patch';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Athena Coder v2 provider block markers missing');
  const providerBlock = [
    '    const qwenConfigured = Boolean(String(env.SPMT_LLM_BASE_URL || "").trim());',
    '    let qwenChanged = false;',
    '    let qwenFailure = "";',
    '    if (qwenConfigured) {',
    '      try {',
    '        job.summary = await runQwenCoder(String(input.description || "").slice(0, 4000), workspace, env);',
    '        const qwenStatus = await runCommand("git status --short", workspace);',
    '        qwenChanged = qwenStatus.ok && Boolean(qwenStatus.output.trim());',
    '        if (!qwenChanged) qwenFailure = "Qwen produced no code changes.";',
    '      } catch (error) {',
    '        qwenFailure = redact(error instanceof Error ? error.message : String(error));',
    '        job.summary = undefined;',
    '        await runCommand("git reset --hard HEAD && git clean -fd", workspace);',
    '      }',
    '    }',
    '',
    '    if (!qwenConfigured || !qwenChanged) {',
    '      if (!String(env.OPENAI_API_KEY || "").trim()) {',
    '        if (qwenFailure) throw new Error(`Qwen repair attempt did not produce a patch and Codex fallback is unavailable: ${qwenFailure}`);',
    '        throw new Error("No Athena Coder provider is configured.");',
    '      }',
    '      const codexResult = await runCodexWorkspaceCoder(',
    '        String(input.description || "").slice(0, 4000),',
    '        input.context,',
    '        workspace,',
    '        repo,',
    '        env,',
    '        dataDir',
    '      );',
    '      job.threadId = codexResult.threadId;',
    '      job.summary = qwenFailure',
    '        ? redact(`Qwen attempt: ${qwenFailure}\\n\\nCodex fallback:\\n${codexResult.summary}`)',
    '        : codexResult.summary;',
    '    }',
  ].join('\n');
  source = source.slice(0, start) + providerBlock + source.slice(end);
}

if (!source.includes('job.baselineChecks = [];')) {
  const marker = [
    '    await cloneWorkspace(target, workspace);',
    '    await ensureRepoDependencies(workspace, repo.installCommand);',
    '    await mkdir(join(dataDir, "tmp"), { recursive: true });',
    '',
  ].join('\n');
  requireMarker(marker, 'baseline insertion');
  const replacement = [
    '    await cloneWorkspace(target, workspace);',
    '    await ensureRepoDependencies(workspace, repo.installCommand);',
    '    await mkdir(join(dataDir, "tmp"), { recursive: true });',
    '    await mkdir(join(dataDir, "jobs", job.id), { recursive: true });',
    '',
    '    job.baselineChecks = [];',
    '    for (const command of repo.checkCommands) job.baselineChecks.push(await runCommand(command, workspace));',
    '    await writeFile(',
    '      join(dataDir, "jobs", job.id, "baseline-checks.txt"),',
    '      job.baselineChecks.map((check) => `$ ${check.command}\\n${check.ok ? "PASS" : "FAIL"}\\n${check.output}`).join("\\n\\n")',
    '    );',
    '    job.updatedAt = new Date().toISOString();',
    '    await saveJob(env, job);',
    '',
  ].join('\n');
  source = source.replace(marker, replacement);
}

if (!source.includes('BASELINE FAILURE ACCEPTED')) {
  const marker = [
    '    job.checks = [];',
    '    for (const command of repo.checkCommands) job.checks.push(await runCommand(command, workspace));',
    '    await writeFile(join(dataDir, "jobs", job.id, "checks.txt"), job.checks.map((check) => `$ ${check.command}\\n${check.output}`).join("\\n\\n"));',
  ].join('\n');
  requireMarker(marker, 'baseline-aware post validation');
  const replacement = [
    '    job.checks = [];',
    '    for (let index = 0; index < repo.checkCommands.length; index += 1) {',
    '      const command = repo.checkCommands[index];',
    '      const check = await runCommand(command, workspace);',
    '      const baseline = job.baselineChecks?.[index];',
    '      if (!check.ok && baseline && !baseline.ok) {',
    '        check.ok = true;',
    '        check.output = redact(`[BASELINE FAILURE ACCEPTED: this command already failed before Athena changed code]\\n\\nBefore repair:\\n${baseline.output}\\n\\nAfter repair:\\n${check.output}`);',
    '      }',
    '      job.checks.push(check);',
    '    }',
    '    await writeFile(join(dataDir, "jobs", job.id, "checks.txt"), job.checks.map((check) => `$ ${check.command}\\n${check.ok ? "ACCEPT" : "REGRESSION"}\\n${check.output}`).join("\\n\\n"));',
  ].join('\n');
  source = source.replace(marker, replacement);
}

if (source.includes('    if (job.status === "failed") job.error = "One or more validation checks failed.";')) {
  source = source.replace(
    '    if (job.status === "failed") job.error = "One or more validation checks failed.";',
    '    if (job.status === "failed") job.error = `Validation regression: ${job.checks.filter((check) => !check.ok).map((check) => check.command).join(", ")}`;'
  );
}

const responseWriteMarker = '    await writeFile(join(dataDir, "jobs", job.id, "response.txt"), job.summary);';
if (source.includes(responseWriteMarker)) {
  source = source.replace(
    responseWriteMarker,
    '    await writeFile(join(dataDir, "jobs", job.id, "response.txt"), job.summary || "Athena Coder completed without a summary.");'
  );
}

const cleanupMarker = [
  '  if (job.status === "failed" || job.changedFiles.length === 0) {',
  '    await rm(join(workDir(env), "sandboxes", job.id), { recursive: true, force: true }).catch(() => undefined);',
  '  }',
].join('\n');
if (source.includes(cleanupMarker)) {
  source = source.replace(cleanupMarker, [
    '  // Keep failed sandboxes with code changes on the Fly machine for live inspection.',
    '  // Durable diff/check/response artifacts are already stored under /data/codex-fixer.',
    '  if (job.changedFiles.length === 0) {',
    '    await rm(join(workDir(env), "sandboxes", job.id), { recursive: true, force: true }).catch(() => undefined);',
    '  }',
  ].join('\n'));
}

fs.writeFileSync(fixerPath, source, 'utf8');
console.log('Athena Coder v2 repository context, provider escalation, baseline validation, and Fly sandbox retention patched.');
