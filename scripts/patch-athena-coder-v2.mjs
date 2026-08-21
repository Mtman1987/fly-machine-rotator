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
console.log('Athena Coder v2 repository context, baseline validation, and Fly sandbox retention patched.');
