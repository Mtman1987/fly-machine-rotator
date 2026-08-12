const fs = require('node:fs');

function replaceOnce(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`${label} marker changed`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

{
  const path = 'src/spmtAuth.ts';
  let source = fs.readFileSync(path, 'utf8');
  const marker = `export async function requireSpmtAdmin(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<SpmtIdentity | null> {\n  const identity = await requireSpmtIdentity(request, env);\n  return identity && isSpmtAdmin(identity) ? identity : null;\n}\n`;
  if (!source.includes(marker)) throw new Error('requireSpmtAdmin marker changed');
  const addition = `${marker}\nexport type SpmtServiceIdentity = {\n  client_id: string;\n  token_use: 'client_credentials';\n  scopes: string[];\n};\n\nexport async function requireSpmtService(\n  request: IncomingMessage,\n  env: NodeJS.ProcessEnv,\n  options: { clientId?: string; scope?: string } = {},\n): Promise<SpmtServiceIdentity | null> {\n  const token = readSpmtAccessToken(request);\n  if (!token) return null;\n  const baseUrl = String(env.SPMT_BASE_URL || 'https://spmt.live').replace(/\\/$/, '');\n  const response = await fetch(\`${'${baseUrl}'}/api/oauth/serviceinfo\`, {\n    headers: { authorization: \`Bearer ${'${token}'}\`, accept: 'application/json' },\n    signal: AbortSignal.timeout(10_000),\n  }).catch(() => null);\n  if (!response?.ok) return null;\n  const payload = await response.json().catch(() => null) as any;\n  const clientId = String(payload?.client_id || '').trim();\n  const tokenUse = String(payload?.token_use || '').trim();\n  const scopes = Array.isArray(payload?.scopes) ? payload.scopes.map(String) : [];\n  if (!clientId || tokenUse !== 'client_credentials') return null;\n  if (options.clientId && clientId !== options.clientId) return null;\n  if (options.scope && !scopes.includes(options.scope)) return null;\n  return { client_id: clientId, token_use: 'client_credentials', scopes };\n}\n`;
  source = source.replace(marker, addition);
  fs.writeFileSync(path, source);
}

{
  const path = 'src/dshMtFixitGateway.ts';
  let source = fs.readFileSync(path, 'utf8');
  source = source.replace(`import { createHash, timingSafeEqual } from "node:crypto";\n`, '');
  source = source.replace(`import { handleRotatorSpmtAuthRequest } from "./spmtAuth.js";`, `import { handleRotatorSpmtAuthRequest, requireSpmtService } from "./spmtAuth.js";`);
  const oldAuth = `function secretMatches(expected: string, supplied: string): boolean {\n  if (!expected || !supplied) return false;\n  const expectedHash = createHash("sha256").update(expected).digest();\n  const suppliedHash = createHash("sha256").update(supplied).digest();\n  return timingSafeEqual(expectedHash, suppliedHash);\n}\n\nexport function isDshMtFixItAuthorized(request: Pick<IncomingMessage, "headers">, env: NodeJS.ProcessEnv): boolean {\n  const expected = String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();\n  const supplied = String(request.headers["x-dsh-mtfixit-key"] || "").trim();\n  return secretMatches(expected, supplied);\n}\n`;
  const newAuth = `export async function isDshMtFixItAuthorized(request: IncomingMessage, env: NodeJS.ProcessEnv): Promise<boolean> {\n  return Boolean(await requireSpmtService(request, env, { clientId: 'discord-stream-hub', scope: 'athena:write' }));\n}\n`;
  if (!source.includes(oldAuth)) throw new Error('legacy DSH auth block changed');
  source = source.replace(oldAuth, newAuth);
  source = source.replace(`  delete headers["x-dsh-mtfixit-key"]; delete headers.connection;`, `  delete headers["x-dsh-mtfixit-key"]; delete headers.authorization; delete headers.connection;`);
  source = source.replace(`  if (!isDshMtFixItAuthorized(request, env)) { sendJson(response, 401, { error: "Unauthorized" }); return true; }`, `  if (!(await isDshMtFixItAuthorized(request, env))) { sendJson(response, 401, { error: "SPMT service authorization required" }); return true; }`);
  fs.writeFileSync(path, source);
}

fs.writeFileSync('test/dshMtFixitGateway.test.ts', `import { afterEach, describe, expect, it, vi } from "vitest";\nimport { isDshMtFixItAuthorized, mapDshMtFixItWorkerPath } from "../src/dshMtFixitGateway.js";\n\nafterEach(() => vi.unstubAllGlobals());\n\ndescribe("DSH mtfixit gateway", () => {\n  it("requires a scoped SPMT client-credentials token for Discord Stream Hub", async () => {\n    const fetchMock = vi.fn().mockResolvedValue({\n      ok: true,\n      json: async () => ({ client_id: "discord-stream-hub", token_use: "client_credentials", scopes: ["athena:write"] }),\n    });\n    vi.stubGlobal("fetch", fetchMock);\n    const request = { headers: { authorization: "Bearer service-token" } } as any;\n    await expect(isDshMtFixItAuthorized(request, { SPMT_BASE_URL: "https://spmt.live" })).resolves.toBe(true);\n    expect(fetchMock).toHaveBeenCalledWith(\n      "https://spmt.live/api/oauth/serviceinfo",\n      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer service-token" }) }),\n    );\n  });\n\n  it("rejects the wrong service client or missing scope", async () => {\n    const request = { headers: { authorization: "Bearer service-token" } } as any;\n    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ client_id: "chat-tag", token_use: "client_credentials", scopes: ["athena:write"] }) }));\n    await expect(isDshMtFixItAuthorized(request, {})).resolves.toBe(false);\n    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ client_id: "discord-stream-hub", token_use: "client_credentials", scopes: ["discord:control"] }) }));\n    await expect(isDshMtFixItAuthorized(request, {})).resolves.toBe(false);\n  });\n\n  it("maps only create and single-job read operations", () => {\n    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs")).toBe("/api/codex/jobs");\n    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234", "?view=status")).toBe("/api/codex/jobs/mtfix_12345678_abcd1234?view=status");\n  });\n\n  it("does not expose list, artifact, or publish routes", () => {\n    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs")).toBeNull();\n    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/publish")).toBeNull();\n    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/diff")).toBeNull();\n    expect(mapDshMtFixItWorkerPath("DELETE", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234")).toBeNull();\n  });\n});\n`);
