import fs from 'node:fs';

function patchFile(path, transform) {
  const before = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const after = transform(before);
  if (after !== before) fs.writeFileSync(path, after, 'utf8');
  console.log(after === before ? `OpenAI bridge already applied: ${path}` : `Patched OpenAI bridge: ${path}`);
}

patchFile('src/athenaChat.ts', (source) => {
  source = source.replace(
    '    { id: "local", label: "Local Qwen", ready: Boolean(env.SPMT_LLM_BASE_URL), model: env.ATHENA_CHAT_LOCAL_MODEL || "spmt-qwen3-4b" },\n    { id: "openai", label: "OpenAI", ready: Boolean(env.OPENAI_API_KEY), model: env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5-mini" },',
    '    { id: "openai", label: "OpenAI", ready: Boolean(env.OPENAI_API_KEY), model: env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5.6-luna" },\n    { id: "local", label: "Local Qwen", ready: Boolean(env.SPMT_LLM_BASE_URL), model: env.ATHENA_CHAT_LOCAL_MODEL || "spmt-qwen3-4b" },',
  );
  source = source.replaceAll('env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5-mini"', 'env.ATHENA_CHAT_OPENAI_MODEL || "gpt-5.6-luna"');
  source = source.replace(
    'function normalizeProvider(value: unknown): ChatProvider { return value === "openai" || value === "eden" || value === "gemini" ? value : "local"; }',
    'function normalizeProvider(value: unknown): ChatProvider { return value === "local" || value === "openai" || value === "eden" || value === "gemini" ? value : "openai"; }',
  );
  if (!source.includes('gpt-5.6-luna') || !source.includes('? value : "openai"')) throw new Error('Athena OpenAI bridge did not apply.');
  return source;
});

patchFile('src/mountainView.ts', (source) => {
  source = source.replace(
    '[Private owner session. Adult mode active. No content restrictions apply.]',
    '[Private owner session. Adult mode active for consensual fictional adult conversation between unambiguously 18+ adults. Provider safety rules still apply.]',
  );
  if (source.includes('const openAiKey = String(env.OPENAI_API_KEY || "").trim();')) return source;

  const marker = `    const started = Date.now();
    let responseText = "";
    let upstreamStatus = 0;
    try {
      const res = await fetch(\`\${qwenUrl}/api/chat\`, {`;
  if (!source.includes(marker)) throw new Error('MountainView Qwen request marker missing.');

  const bridge = `    const started = Date.now();
    let responseText = "";
    let upstreamStatus = 0;

    const openAiKey = String(env.OPENAI_API_KEY || "").trim();
    if (openAiKey) {
      const openAiModel = String(env.MOUNTAINVIEW_CHAT_OPENAI_MODEL || "gpt-5.6-luna");
      const openAiStarted = Date.now();
      try {
        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { authorization: \`Bearer \${openAiKey}\`, "content-type": "application/json" },
          signal: AbortSignal.timeout(120_000),
          body: JSON.stringify({
            model: openAiModel,
            store: false,
            instructions: fullSystem,
            input: messages.map((message) => ({ role: message.role, content: message.content })),
            max_output_tokens: 1200
          })
        });
        const raw = await res.text();
        upstreamStatus = res.status;
        if (res.ok) {
          const data = JSON.parse(raw) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
          responseText = (data.output || []).flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => String(part.text || "")).join("").trim();
          if (responseText) {
            this.logCommand(user.id, "athena-chat", "openai", "POST", "https://api.openai.com/v1/responses", "success", upstreamStatus, Date.now() - openAiStarted, responseText.slice(0, 2000), "");
            this.saveMemory(user.id, {
              kind: "athena-chat",
              title: \`Athena chat (\${mode})\`,
              body: messages.at(-1)?.content?.slice(0, 300) ?? "",
              tags: ["athena", "private-chat", mode],
              metadata: { tenantId, mode, provider: "openai", model: openAiModel, responseSnippet: responseText.slice(0, 200) }
            });
            return { ok: true, text: responseText, mode, provider: "openai", model: openAiModel };
          }
        }
        this.logCommand(user.id, "athena-chat", "openai", "POST", "https://api.openai.com/v1/responses", "error", upstreamStatus, Date.now() - openAiStarted, raw.slice(0, 2000), res.ok ? "OpenAI returned no usable text" : \`HTTP \${upstreamStatus}\`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logCommand(user.id, "athena-chat", "openai", "POST", "https://api.openai.com/v1/responses", "error", 0, Date.now() - openAiStarted, "", msg);
      }
    }

    // Local Qwen remains the fallback until the Companion-hosted model is restored.
    try {
      const res = await fetch(\`\${qwenUrl}/api/chat\`, {`;
  return source.replace(marker, bridge);
});
