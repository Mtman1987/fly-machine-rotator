import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixerPath = path.join(root, 'src/publicCodexFixer.ts');
let source = fs.readFileSync(fixerPath, 'utf8').replace(/\r\n/g, '\n');

function requireMarker(marker, label) {
  if (!source.includes(marker)) throw new Error(`Athena ChatGPT handoff patch marker missing: ${label}`);
}

const coderContextImport = 'import { buildRepositoryContext } from "./coderContext.js";\n';
if (!source.includes('from "./ecosystemContext.js"')) {
  requireMarker(coderContextImport, 'ecosystem context import');
  source = source.replace(
    coderContextImport,
    coderContextImport
      + 'import { loadEcosystemOperatorContext } from "./ecosystemContext.js";\n'
      + 'import { writeChatGptHandoff } from "./chatgptHandoff.js";\n'
  );
}

if (!source.includes('const operatorContext = await loadEcosystemOperatorContext(env);\n  const context = await buildRepositoryContext(description, workspace);')) {
  const marker = '  const context = await buildRepositoryContext(description, workspace);\n';
  requireMarker(marker, 'Qwen ecosystem context');
  source = source.replace(
    marker,
    '  const operatorContext = await loadEcosystemOperatorContext(env);\n'
      + '  const context = await buildRepositoryContext(description, workspace);\n'
  );
}

if (!source.includes('Canonical ecosystem operator context:')) {
  const marker = '{ role: "user", content: `Task:\\n${description}\\n\\nSelected repository files:${context}\\n\\n/no_think` },';
  requireMarker(marker, 'Qwen prompt context');
  source = source.replace(
    marker,
    '{ role: "user", content: `Canonical ecosystem operator context:\\n${operatorContext}\\n\\nTask:\\n${description}\\n\\nSelected repository files:${context}\\n\\n/no_think` },'
  );
}

if (!source.includes('ChatGPT Business handoff')) {
  const startMarker = '    const qwenConfigured = Boolean(String(env.SPMT_LLM_BASE_URL || "").trim());\n';
  const endMarker = '\n\n    // Intent-to-add makes new files part of the durable patch';
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error('Athena ChatGPT handoff provider block markers missing');

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
    '    } else {',
    '      qwenFailure = "Local Qwen provider is not configured.";',
    '    }',
    '',
    '    if (!qwenChanged) {',
    '      const operatorContext = await loadEcosystemOperatorContext(env);',
    '      const repositoryContext = await buildRepositoryContext(String(input.description || "").slice(0, 4000), workspace);',
    '      const handoff = await writeChatGptHandoff(env, {',
    '        jobId: job.id,',
    '        appName: job.appName,',
    '        repoId: repo.id,',
    '        repoLabel: repo.label,',
    '        repoUrl: repo.repoUrl,',
    '        description: String(input.description || "").slice(0, 4000),',
    '        userContext: input.context,',
    '        qwenFailure: qwenFailure || "Qwen did not produce a safe patch.",',
    '        baselineChecks: job.baselineChecks || [],',
    '        operatorContext,',
    '        repositoryContext,',
    '        validationCommands: repo.checkCommands,',
    '      });',
    '      job.summary = `Local Qwen did not produce a safe patch. ChatGPT Business handoff ${handoff.id} is ready for a normal ChatGPT conversation.`;',
    '      throw new Error(`awaiting-chatgpt:${handoff.id}: ${qwenFailure || "Qwen did not produce a safe patch."}`);',
    '    }',
  ].join('\n');

  source = source.slice(0, start) + providerBlock + source.slice(end);
}

fs.writeFileSync(fixerPath, source, 'utf8');
console.log('Athena Coder ChatGPT Business handoff fallback patched.');
