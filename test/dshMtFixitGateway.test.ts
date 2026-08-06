import { describe, expect, it } from "vitest";
import { isDshMtFixItAuthorized, mapDshMtFixItWorkerPath } from "../src/dshMtFixitGateway.js";

describe("DSH mtfixit gateway", () => {
  it("accepts the existing shared SPMT API key", () => {
    const request = { headers: { "x-dsh-mtfixit-key": "shared-key" } } as any;
    expect(isDshMtFixItAuthorized(request, { SPMT_API_KEY: "shared-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { SPMT_PLATFORM_API_KEY: "shared-key" })).toBe(true);
    expect(isDshMtFixItAuthorized(request, { SPMT_API_KEY: "different" })).toBe(false);
    expect(isDshMtFixItAuthorized({ headers: {} } as any, { SPMT_API_KEY: "shared-key" })).toBe(false);
  });

  it("maps only create and single-job read operations", () => {
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
