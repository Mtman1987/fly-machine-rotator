import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("current SPMT Qwen worker configuration", () => {
  it("keeps the Qwen3 8B worker on Fly private networking", async () => {
    const flyToml = await source("llm-worker/fly.toml");
    expect(flyToml).not.toMatch(/^\s*\[http_service\]/m);
    expect(flyToml).not.toMatch(/^\s*\[\[services\]\]/m);
    expect(flyToml).toContain('LLAMA_ARG_HOST = "::"');
    expect(flyToml).toContain('LLAMA_ARG_PORT = "8080"');
    expect(flyToml).toContain('LLAMA_ARG_ALIAS = "spmt-qwen3-8b"');
    expect(flyToml).toContain('Qwen/Qwen3-8B-GGUF:Q4_K_M');
    expect(flyToml).toContain('memory_mb = 16384');
  });

  it("does not generate or install a second model-worker API key", async () => {
    const provisioner = await source("src/flyLlmProvisioner.ts");
    expect(provisioner).not.toContain("randomBytes(");
    expect(provisioner).not.toContain("ensureKey(");
    expect(provisioner).not.toMatch(/LLAMA_API_KEY\s*:/);
    expect(provisioner).toContain('"secrets", "unset", "--app", appName, "LLAMA_API_KEY"');
    expect(provisioner).toContain('authMode: "spmt-gateway-private-network"');
  });

  it("cleans stale auth and smoke-tests the real keyless 8B chat endpoint on deploy", async () => {
    const workflow = await source(".github/workflows/deploy-llm-worker.yml");
    expect(workflow).toContain('flyctl secrets unset --app "$LLM_APP" LLAMA_API_KEY');
    expect(workflow).toContain('flyctl secrets unset --app "$LLM_APP" LLAMA_ARG_API_KEY_FILE');
    expect(workflow).toContain('flyctl secrets unset --app "$ROTATOR_APP" SPMT_LLM_API_KEY');
    expect(workflow).toContain("Release obsolete public worker addresses");
    expect(workflow).toContain("/v1/chat/completions");
    expect(workflow).toContain("model:'spmt-qwen3-8b'");
    expect(workflow).toContain("thinking_budget_tokens:0");
    expect(workflow).toContain("/no_think");
  });

  it("waits through the normal llama.cpp model-loading 503 window", async () => {
    const workflow = await source(".github/workflows/deploy-llm-worker.yml");
    expect(workflow).toContain("for attempt in $(seq 1 40)");
    expect(workflow).toContain("Qwen is still loading");
    expect(workflow).toContain("AbortSignal.timeout(10000)");
    expect(workflow).toContain("for attempt in $(seq 1 8)");
    expect(workflow).toContain("AbortSignal.timeout(120000)");
  });
});
