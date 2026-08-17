import { describe, expect, it } from "vitest";
import { isDshMtFixItAuthorized, mapDshMtFixItWorkerPath } from "../src/dshMtFixitGateway.js";

describe("DSH mtfixit gateway", () => {
  it("accepts the canonical shared SPMT API key", () => {
    const request = { headers: { "x-dsh-mtfixit-key": "shared-key" } } as any;
    expect(isDshMtFixItAuthorized(request, { SPMT_API_KEY: "shared-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { SPMT_PLATFORM_API_KEY: "shared-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { DSH_MTFIXIT_KEY: "shared-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { SPMT_API_KEY: "different" })).toBe(false);
    expect(isDshMtFixItAuthorized({ headers: {} } as any, { SPMT_API_KEY: "shared-key" })).toBe(false);
  });

  it("accepts the former DSH bridge secret during rolling deploys", () => {
    const request = { headers: { "x-cloudflare-bridge-secret": "legacy-key" } } as any;
    expect(isDshMtFixItAuthorized(request, { CLOUDFLARE_WORKER_BRIDGE_SECRET: "legacy-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { INTERNAL_BRIDGE_KEY: "legacy-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { CLOUDFLARE_WORKER_BRIDGE_SECRET: "different" })).toBe(false);
  });

  it("maps both legacy and canonical create operations", () => {
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit"))
      .toBe("/api/codex/jobs");
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs"))
      .toBe("/api/codex/jobs");
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234", "?view=status"))
      .toBe("/api/codex/jobs/mtfix_12345678_abcd1234?view=status");
  });

  it("does not expose list, artifact, or publish routes", () => {
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs")).toBeNull();
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/publish")).toBeNull();
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/diff")).toBeNull();
    expect(mapDshMtFixItWorkerPath("DELETE", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234")).toBeNull();
  });
});
