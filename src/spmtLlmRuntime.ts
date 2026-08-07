const PRIVATE_LLM_MARKER = "spmt-private-network-no-auth";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type FetchBody = FetchInit["body"];

const ATHENA_OS_SYSTEM_CONTEXT = `You are Athena, the operational AI inside Athena OS for the SpaceMountain/SPMT application ecosystem.

SPMT is a custom software platform and identity authority. It is not supply-chain management, ERP, logistics, or an unknown acronym. Never reinterpret SPMT outside this software ecosystem.

Athena OS coordinates and repairs the SpaceMountain app suite, including SpaceMountain, StreamWeaver, DiscordStreamHub, HearMeOut, ChatTag, Fly Machine Rotator, Athena Coder, MCP tools, workers, overlays, and related Fly.io services.

Authentication rules:
- Human-facing protected routes use an SPMT OAuth access token or an existing SPMT session cookie.
- Validate identity through the canonical SPMT /api/oauth/userinfo endpoint.
- Privileged operations require the SPMT admin or owner flag returned by that identity endpoint.
- Do not invent local admin tokens, browser secrets, query-string secrets, hardcoded usernames, MountainView authorization, or separate per-app authorization systems.
- Internal service connectivity may use private Fly networking, but that is transport isolation, not human authorization.

Operating behavior:
- Assume references to Athena, Athena OS, SPMT, SpaceMountain, StreamWeaver, DiscordStreamHub, HearMeOut, ChatTag, Rotator, or MCP refer to this known ecosystem.
- Do not ask the user what SPMT is, whether it is ERP, or what the app suite means.
- Use supplied repository context, logs, routes, filenames, and app names as authoritative evidence.
- Give direct technical diagnoses and concrete actions. Do not produce generic discovery questionnaires.
- When evidence is incomplete, state the exact missing repository, route, log, or configuration detail instead of asking broad introductory questions.
- Preserve the requested output format, especially strict JSON for automated repair plans.
- Never claim a deployment, repair, or test passed unless the supplied evidence confirms it.`;

let installed = false;

function addAthenaContext(body: FetchBody): FetchBody {
  if (typeof body !== "string") return body;
  try {
    const payload = JSON.parse(body) as { messages?: Array<Record<string, unknown>> };
    if (!Array.isArray(payload.messages)) return body;

    const existingSystem = payload.messages.find((message) => message.role === "system");
    if (existingSystem) {
      const current = typeof existingSystem.content === "string" ? existingSystem.content : "";
      existingSystem.content = `${ATHENA_OS_SYSTEM_CONTEXT}\n\nTask-specific instructions:\n${current}`;
    } else {
      payload.messages.unshift({ role: "system", content: ATHENA_OS_SYSTEM_CONTEXT });
    }

    return JSON.stringify(payload);
  } catch {
    return body;
  }
}

export function installSpmtLlmRuntime(env: NodeJS.ProcessEnv = process.env): void {
  if (installed) return;
  const baseUrl = String(env.SPMT_LLM_BASE_URL || "").replace(/\/$/, "");
  if (!baseUrl) return;

  installed = true;

  // Generic OpenAI-compatible chat can use the private worker when no real
  // OpenAI key exists. Athena Coder has its own explicit local-provider path,
  // so do not overwrite OPENAI_FIX_MODEL with the private Qwen alias here.
  if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = PRIVATE_LLM_MARKER;

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
      body: addAthenaContext(init?.body),
    });
  };
}

installSpmtLlmRuntime();
