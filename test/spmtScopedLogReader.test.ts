import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dashboard = readFileSync(resolve(process.cwd(), "src/dashboardServer.ts"), "utf8");
const auth = readFileSync(resolve(process.cwd(), "src/spmtAuth.ts"), "utf8");

describe("SPMT scoped read-only log access", () => {
  it("allows the narrow logs:read:last24h service identity to read both protected exports", () => {
    expect(dashboard).toMatch(/url\.pathname === "\/logs\/errors\.txt"[\s\S]*?requireSpmtLogReader\(request, env\)/);
    expect(dashboard).toMatch(/url\.pathname === "\/logs\/run-readout\.json"[\s\S]*?requireSpmtLogReader\(request, env\)/);
    expect(auth).toMatch(/scope: "logs:read:last24h"/);
    expect(auth).toMatch(/scopes\.includes\("logs:read:last24h"\)/);
  });

  it("does not broaden scoped log access into machine-action authorization", () => {
    expect(dashboard).toMatch(/requireSpmtAdmin\(request, env\)/);
    expect(auth).toMatch(/export async function requireSpmtAdmin/);
    expect(auth).toMatch(/export async function requireSpmtLogReader/);
  });
});
