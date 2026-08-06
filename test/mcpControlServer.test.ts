import { describe, expect, it } from "vitest";
import { isAllowedMcpOrigin, isMcpAuthorized, listMcpTools } from "../src/mcpControlServer.js";

describe("MCP control server", () => {
  it("requires the dedicated MCP bearer token", () => {
    const env = { MCP_CONTROL_TOKEN: "owner-secret" };
    expect(isMcpAuthorized({ headers: { authorization: "Bearer owner-secret" } } as any, env)).toBe(true);
    expect(isMcpAuthorized({ headers: { "x-mcp-control-token": "owner-secret" } } as any, env)).toBe(true);
    expect(isMcpAuthorized({ headers: { authorization: "Bearer wrong" } } as any, env)).toBe(false);
    expect(isMcpAuthorized({ headers: {} } as any, env)).toBe(false);
    expect(isMcpAuthorized({ headers: { authorization: "Bearer owner-secret" } } as any, {})).toBe(false);
  });

  it("rejects browser origins unless explicitly allowlisted", () => {
    const env = { MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://example.test" };
    expect(isAllowedMcpOrigin("", env)).toBe(true);
    expect(isAllowedMcpOrigin("https://chatgpt.com", env)).toBe(true);
    expect(isAllowedMcpOrigin("https://example.test", env)).toBe(true);
    expect(isAllowedMcpOrigin("https://evil.test", env)).toBe(false);
    expect(isAllowedMcpOrigin("https://chatgpt.com", {})).toBe(false);
  });

  it("exposes only the narrow Athena Coder tools", () => {
    const tools = listMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "list_code_references",
      "create_coding_job",
      "get_coding_job",
    ]);
    expect(tools.some((tool) => /deploy|merge|shell|secret/i.test(tool.name))).toBe(false);
    expect(tools.find((tool) => tool.name === "create_coding_job")?.annotations.readOnlyHint).toBe(false);
    expect(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name)).toEqual([
      "list_code_references",
      "get_coding_job",
    ]);
  });
});
