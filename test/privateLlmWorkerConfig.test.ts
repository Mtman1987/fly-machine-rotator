import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

async function source(path: string) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("private SPMT LLM worker configuration", () => {
  it("does not publish the llama.cpp HTTP service through Fly Proxy", async () => {
    const flyToml = await source("llm-worker/fly.toml");
    expect(flyToml).not.toMatch(/^\s*\[http_service\]/m);
    expect(flyToml).not.toMatch(/^\s*\[\[services\]\]/m);
    expect(flyToml).toContain('LLAMA_ARG_HOST = "::"');
    expect(flyToml).toContain('LLAMA_ARG_PORT = "8080"');
  });

  it("does not generate or install a model-worker API key", async () => {
    const provisioner = await source("src/flyLlmProvisioner.ts");
    expect(provisioner).not.toContain("randomBytes(");
    expect(provisioner).not.toContain("ensureKey(");
    expect(provisioner).not.toMatch(/LLAMA_API_KEY\s*:/);
    expect(provisioner).toContain('"secrets", "unset", "--app", appName, "LLAMA_API_KEY"');
    expect(provisioner).toContain('authMode: "spmt-gateway-private-network"');
  });

  it("cleans obsolete worker keys during the deployment workflow", async () => {
    const workflow = await source(".github/workflows/deploy-llm-worker.yml");
    expect(workflow).toContain('flyctl secrets unset --app "$LLM_APP" LLAMA_API_KEY');
    expect(workflow).toContain('flyctl secrets unset --app "$ROTATOR_APP" SPMT_LLM_API_KEY');
    expect(workflow).toContain("Release obsolete public worker addresses");
  });
});
