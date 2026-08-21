import { describe, expect, it } from "vitest";
import {
  getMcpResourceMetadata,
  getMcpResourceMetadataUrl,
  getSpmtAuthorizationServerMetadata,
} from "../src/mcpOAuthMetadata.js";

describe("MCP OAuth discovery metadata", () => {
  it("advertises the Rotator MCP resource and SPMT authorization server", () => {
    const env = {
      ROTATOR_PUBLIC_BASE_URL: "https://rotator.example/",
      SPMT_BASE_URL: "https://identity.example/",
    } as NodeJS.ProcessEnv;

    expect(getMcpResourceMetadata(env)).toEqual({
      resource: "https://rotator.example/mcp",
      authorization_servers: ["https://identity.example"],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://rotator.example/docs/mcp",
    });
    expect(getMcpResourceMetadataUrl(env)).toBe("https://rotator.example/.well-known/oauth-protected-resource");
  });

  it("truthfully advertises the existing confidential-client SPMT OAuth capabilities", () => {
    const metadata = getSpmtAuthorizationServerMetadata({ SPMT_BASE_URL: "https://spmt.live" } as NodeJS.ProcessEnv);
    expect(metadata).toMatchObject({
      issuer: "https://spmt.live",
      authorization_endpoint: "https://spmt.live/api/oauth/authorize",
      token_endpoint: "https://spmt.live/api/oauth/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
    expect(metadata).not.toHaveProperty("registration_endpoint");
    expect(metadata).not.toHaveProperty("code_challenge_methods_supported");
  });
});
