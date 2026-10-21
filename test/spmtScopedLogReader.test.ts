import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboard = readFileSync(resolve(process.cwd(), "src/dashboardServer.ts"), "utf8");
const auth = readFileSync(resolve(process.cwd(), "src/spmtAuth.ts"), "utf8");
const logReader = auth.slice(auth.indexOf("export async function requireSpmtLogReader"));

describe("SPMT scoped read-only log access", () => {
  it("applies scoped authorization to both protected exports and validates the caller's token", () => {
    expect(dashboard).toContain('url.pathname === "/logs/errors.txt"');
    expect(dashboard).toContain('url.pathname === "/logs/run-readout.json"');
    expect(dashboard).toContain("requireSpmtLogReader(request, env)");
    expect(logReader).toContain("const token = readSpmtAccessToken(request);");
    expect(logReader).toContain("/api/oauth/serviceinfo");
    expect(logReader).toContain('payload?.client_id === "mountainview"');
    expect(logReader).toContain('payload.scopes.includes("logs:read:last24h")');
  });

  it("never mints Rotator's service token to authorize an anonymous incoming request", () => {
    expect(logReader).not.toContain("getSpmtLogReaderToken");
    expect(logReader).not.toContain("client_secret: clientSecret");
    expect(logReader).not.toContain("grant_type");
  });

  it("does not broaden scoped log access into machine-action authorization", () => {
    expect(auth).toContain("export async function requireSpmtAdmin");
    expect(auth).toContain("export async function requireSpmtLogReader");
  });
});
