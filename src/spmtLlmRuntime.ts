const PRIVATE_LLM_MARKER = "spmt-private-network-no-auth";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

let installed = false;

export function installSpmtLlmRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  const baseUrl = String(env.SPMT_LLM_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return;

  installed = true;

  // aiFixer already speaks the OpenAI-compatible chat-completions protocol.
  // This marker only selects that existing code path; it is never sent as
  // authentication and is not a credential.
  if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = PRIVATE_LLM_MARKER;
  if (!env.OPENAI_FIX_MODEL) env.OPENAI_FIX_MODEL = "spmt-qwen3-4b";

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

    if (url !== OPENAI_CHAT_COMPLETIONS_URL || env.OPENAI_API_KEY !== PRIVATE_LLM_MARKER) {
      return originalFetch(input, init);
    }

    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("x-api-key");

    return originalFetch(`${baseUrl}/chat/completions`, {
      ...init,
      headers,
    });
  };
}

installSpmtLlmRuntime();
