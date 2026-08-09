import { readFile, writeFile } from 'node:fs/promises';

const aiFixerPath = new URL('../src/aiFixer.ts', import.meta.url);
let source = await readFile(aiFixerPath, 'utf8');

const providerAnchor = '  const failures: string[] = [];\n';
const providerBlock = `  const failures: string[] = [];
  if (env.SPMT_LLM_BASE_URL) {
    try {
      return assertUsableModelPlan(await requestSpmtLlmFixPlan(prompt, repoPath, env), "SPMT LLM");
    } catch (error) {
      failures.push(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    }
  }
`;
if (!source.includes('requestSpmtLlmFixPlan(prompt')) {
  if (!source.includes(providerAnchor)) throw new Error('aiFixer provider anchor not found');
  source = source.replace(providerAnchor, providerBlock);
}

const functionAnchor = 'async function requestOpenAiFixPlan(prompt: string, repoPath: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {';
const localFunction = `async function requestSpmtLlmFixPlan(prompt: string, repoPath: string, env: NodeJS.ProcessEnv): Promise<ModelFixPlan> {
  const baseUrl = String(env.SPMT_LLM_BASE_URL || "http://spmt-llm-worker.internal:8080/v1").replace(/\\/$/, "");
  const model = env.SPMT_LLM_MODEL || "spmt-qwen3-8b";
  const response = await fetch(\`\${baseUrl}/chat/completions\`, {
    signal: AbortSignal.timeout(providerTimeoutMs(env)),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      thinking_budget_tokens: 0,
      max_tokens: 6000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "You are a senior software engineer. Return strict JSON with summary, diagnosis, confidence, sourceSummary, and changes. Each change must include path, reason, and the full updated file content. Do not emit reasoning or commentary outside the JSON." },
        { role: "user", content: prompt + "\\n\\n/no_think" }
      ]
    })
  });
  if (!response.ok) throw new Error(\`SPMT LLM request failed with \${response.status}: \${await response.text()}\`);
  const body = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
  const content = extractModelText(body.choices?.[0]?.message?.content);
  if (!content) throw new Error("SPMT LLM response did not include content.");
  return normalizeModelPlan(parseModelPlanContent(content), repoPath);
}

`;
if (!source.includes('async function requestSpmtLlmFixPlan(')) {
  if (!source.includes(functionAnchor)) throw new Error('aiFixer function anchor not found');
  source = source.replace(functionAnchor, localFunction + functionAnchor);
}

await writeFile(aiFixerPath, source);

const ownerAuthTargets = [
  '../src/athenaSpmtGateway.ts',
  '../src/athenaCoderUi.ts',
  '../src/publicCodexFixer.ts',
  '../src/dashboardServer.ts',
];

for (const relativePath of ownerAuthTargets) {
  const path = new URL(relativePath, import.meta.url);
  let ownerSource = await readFile(path, 'utf8');
  if (!ownerSource.includes('hasMountainViewAdminSession')) continue;

  const mountainViewImport = /import \{([^}]*)\} from "\.\/mountainView\.js";/;
  const match = ownerSource.match(mountainViewImport);
  if (!match) throw new Error(`${relativePath} MountainView import anchor not found`);

  const remainingNames = match[1]
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => value !== 'hasMountainViewAdminSession');
  const replacementImports = [
    ...(remainingNames.length ? [`import { ${remainingNames.join(', ')} } from "./mountainView.js";`] : []),
    'import { requireSpmtAdmin } from "./spmtAuth.js";',
  ].join('\n');
  ownerSource = ownerSource.replace(mountainViewImport, replacementImports);
  ownerSource = ownerSource.replaceAll('hasMountainViewAdminSession(', 'requireSpmtAdmin(');
  await writeFile(path, ownerSource);
}
