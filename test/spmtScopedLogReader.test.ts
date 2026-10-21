import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboard = readFileSync(resolve(process.cwd(), "src/dashboardServer.ts"), "utf8");
const auth = readFileSync(resolve(process.cwd(), "src/spmtAuth.ts"), "utf8");

describe("SPMT scoped read-only log access", () => {
  it("applies scoped authorization to both protected exports and validates the caller's token", () => {
    expect(dashboard).toMatch(/url\\.pathname === "\\/logs\\/errors\\.txt"[\\s\\S]*?requireSpmtLogReader\\(request, env\\)/);
    expect(dashboard).toMatch(/url\\.pathname === "\\/logs\\/run-readout\\.json"[\\s\\S]*?requireSpmtLogReader\\(request, env\\)/);
    expect(auth).toContain("const token = readSpmtAccessToken(request);");
    expect(auth).toContain("/api/oauth/serviceinfo");
    expect(auth).toContain('payload?.client_id === "mountainview"');
    expect(auth).toContain('payload.scopes.includes("logs:read:last24h")');
  });

  it("never mints Rotator's service token to authorize an anonymous incoming request", () => {
    expect(auth).not.toContain("getSpmtLogReaderToken");
    expect(auth).not.toContain("client_secret: clientSecret");
    expect(auth).not.toContain('grant_type: "client_credentials"');
  });

  it("does not broaden scoped log access into machine-action authorization", () => {
    expect(dashboard).toMatch(/requireSpmtAdmin\\(request, env\\)/);
    expect(auth).toMatch(/export async function requireSpmtAdmin/);
    expect(auth).toMatch(/export async function requireSpmtLogReader/);
  });
});
