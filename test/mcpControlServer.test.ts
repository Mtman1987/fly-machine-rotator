import { describe, expect, it } from "vitest";
import { listMcpTools } from "../src/mcpControlServer.js";
import { isSpmtAdmin, readSpmtAccessToken } from "../src/spmtAuth.js";

describe("MCP control server", () => {
  it("accepts only the canonical SPMT bearer or SPMT session cookies", () => {
    expect(readSpmtAccessToken({ headers: { authorization: "Bearer spmt-token" } } as any)).toBe("spmt-token");
    expect(readSpmtAccessToken({ headers: { cookie: "rotator_spmt_access_token=rotator-token" } } as any)).toBe("rotator-token");
    expect(readSpmtAccessToken({ headers: { cookie: "spmt_access_token=cookie-token" } } as any)).toBe("cookie-token");
    expect(readSpmtAccessToken({ headers: { cookie: "streamweaver-spmt-token=shared-token" } } as any)).toBe("shared-token");
    expect(readSpmtAccessToken({ headers: { "x-mcp-control-token": "legacy-secret" } } as any)).toBe("");
  });

  it("uses the SPMT admin or owner flag for privileged tools", () => {
    expect(isSpmtAdmin({ id: "1", is_admin: 1 })).toBe(true);
    expect(isSpmtAdmin({ id: "1", isAdmin: true })).toBe(true);
    expect(isSpmtAdmin({ id: "1", role: "owner" })).toBe(true);
    expect(isSpmtAdmin({ id: "1", roles: ["member", "admin"] })).toBe(true);
    expect(isSpmtAdmin({ id: "1", role: "member" })).toBe(false);
  });

  it("exposes narrow coding and allowlisted LLM provisioning tools", () => {
    const tools = listMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_code_references",
      "create_coding_job",
      "get_coding_job",
      "get_spmt_llm_worker_status",
      "get_spmt_embedding_worker_status",
      "provision_spmt_llm_worker",
      "provision_spmt_embedding_worker",
    ]);
    expect(tools.some((tool) => /merge|shell|secret-value|delete/i.test(tool.name))).toBe(false);
    expect(tools.find((tool) => tool.name === "provision_spmt_llm_worker")?.annotations.idempotentHint).toBe(true);
    expect(tools.find((tool) => tool.name === "provision_spmt_embedding_worker")?.annotations.idempotentHint).toBe(true);
    expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual([
      "list_code_references",
      "get_coding_job",
      "get_spmt_llm_worker_status",
      "get_spmt_embedding_worker_status",
    ]);
  });
});
