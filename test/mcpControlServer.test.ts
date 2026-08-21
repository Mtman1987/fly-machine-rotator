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

  it("exposes owner runtime controls without generic shell or secret access", () => {
    const tools = listMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_code_references",
      "list_coding_jobs",
      "create_coding_job",
      "get_coding_job",
      "get_coding_job_artifact",
      "publish_coding_job",
      "get_athena_repair_audit",
      "run_rotation",
      "get_signal_history",
      "list_fly_app_states",
      "sample_fly_logs",
      "get_fly_observability_snapshot",
      "get_quackverse_art_inventory",
      "read_quackverse_art_asset",
      "get_spmt_llm_worker_status",
      "get_spmt_embedding_worker_status",
      "provision_spmt_llm_worker",
      "provision_spmt_embedding_worker",
    ]);
    expect(tools.some((tool) => /shell|secret-value|delete|stop-machine/i.test(tool.name))).toBe(false);
    expect(tools.find((tool) => tool.name === "run_rotation")?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
    expect(tools.find((tool) => tool.name === "get_signal_history")?.annotations.readOnlyHint).toBe(true);
    expect(tools.find((tool) => tool.name === "get_signal_history")?.inputSchema).toMatchObject({
      properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
      additionalProperties: false,
    });
    expect(tools.find((tool) => tool.name === "provision_spmt_llm_worker")?.annotations.idempotentHint).toBe(true);
    expect(tools.find((tool) => tool.name === "provision_spmt_embedding_worker")?.annotations.idempotentHint).toBe(true);
    expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual([
      "list_code_references",
      "list_coding_jobs",
      "get_coding_job",
      "get_coding_job_artifact",
      "get_athena_repair_audit",
      "get_signal_history",
      "list_fly_app_states",
      "sample_fly_logs",
      "get_fly_observability_snapshot",
      "get_quackverse_art_inventory",
      "read_quackverse_art_asset",
      "get_spmt_llm_worker_status",
      "get_spmt_embedding_worker_status",
    ]);
    expect(tools.find((tool) => tool.name === "get_athena_repair_audit")?.inputSchema.properties).toMatchObject({
      format: { type: "string", enum: ["json", "text"] },
    });
    expect(tools.find((tool) => tool.name === "sample_fly_logs")?.inputSchema.properties).toMatchObject({
      limit: { type: "integer", minimum: 1, maximum: 500 },
      durationMs: { type: "integer", minimum: 500, maximum: 10000 },
      errorsOnly: { type: "boolean" },
    });
    expect(tools.find((tool) => tool.name === "get_quackverse_art_inventory")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(tools.find((tool) => tool.name === "read_quackverse_art_asset")?.inputSchema).toMatchObject({
      required: ["fileName"],
      additionalProperties: false,
    });
  });
});
