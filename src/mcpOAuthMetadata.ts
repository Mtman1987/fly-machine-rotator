const DEFAULT_ROTATOR_BASE = "https://mtman-machine-rotator.fly.dev";
const DEFAULT_SPMT_BASE = "https://spmt.live";

function cleanBase(value: string | undefined, fallback: string): string {
  const raw = String(value || fallback).trim() || fallback;
  return raw.replace(/\/$/, "");
}

export function getMcpResourceMetadata(env: NodeJS.ProcessEnv = process.env) {
  const rotatorBase = cleanBase(env.ROTATOR_PUBLIC_BASE_URL || env.MOUNTAINVIEW_BASE_URL, DEFAULT_ROTATOR_BASE);
  const spmtBase = cleanBase(env.SPMT_BASE_URL, DEFAULT_SPMT_BASE);
  return {
    resource: `${rotatorBase}/mcp`,
    authorization_servers: [spmtBase],
    bearer_methods_supported: ["header"],
    resource_documentation: `${rotatorBase}/docs/mcp`,
  };
}

export function getSpmtAuthorizationServerMetadata(env: NodeJS.ProcessEnv = process.env) {
  const spmtBase = cleanBase(env.SPMT_BASE_URL, DEFAULT_SPMT_BASE);
  return {
    issuer: spmtBase,
    authorization_endpoint: `${spmtBase}/api/oauth/authorize`,
    token_endpoint: `${spmtBase}/api/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: ["identity:read"],
  };
}

export function getMcpResourceMetadataUrl(env: NodeJS.ProcessEnv = process.env) {
  const rotatorBase = cleanBase(env.ROTATOR_PUBLIC_BASE_URL || env.MOUNTAINVIEW_BASE_URL, DEFAULT_ROTATOR_BASE);
  return `${rotatorBase}/.well-known/oauth-protected-resource`;
}
