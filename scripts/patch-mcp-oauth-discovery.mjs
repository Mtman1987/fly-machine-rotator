import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src/mcpControlServer.ts');
let source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

if (!source.includes('from "./mcpOAuthMetadata.js"')) {
  const marker = 'import { isSpmtAdmin, requireSpmtIdentity, type SpmtIdentity } from "./spmtAuth.js";\n';
  if (!source.includes(marker)) throw new Error('MCP OAuth discovery import marker missing');
  source = source.replace(marker, marker + 'import { getMcpResourceMetadata, getMcpResourceMetadataUrl, getSpmtAuthorizationServerMetadata } from "./mcpOAuthMetadata.js";\n');
}

const routeMarker = '  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);\n  if (url.pathname !== MCP_PATH) return false;\n';
if (!source.includes('oauth-protected-resource')) {
  if (!source.includes(routeMarker)) throw new Error('MCP OAuth discovery route marker missing');
  source = source.replace(routeMarker, [
    '  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);',
    '  if ((request.method || "GET") === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {',
    '    sendJson(response, 200, getMcpResourceMetadata(env));',
    '    return true;',
    '  }',
    '  if ((request.method || "GET") === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {',
    '    sendJson(response, 200, getSpmtAuthorizationServerMetadata(env));',
    '    return true;',
    '  }',
    '  if (url.pathname !== MCP_PATH) return false;',
    '',
  ].join('\n'));
}

source = source.replace(
  '    response.setHeader("www-authenticate", \'Bearer realm="SPMT"\');',
  '    response.setHeader("www-authenticate", `Bearer realm="SPMT", resource_metadata="${getMcpResourceMetadataUrl(env)}"`);',
);

fs.writeFileSync(file, source, 'utf8');
console.log('MCP OAuth discovery routes patched.');
