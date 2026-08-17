import { describe, expect, it } from "vitest";
import { isDshMtFixItAuthorized, mapDshMtFixItWorkerPath, prepareDshMtFixItJobPayload } from "../src/dshMtFixitGateway.js";

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

  it("bridges tenant diagnostic service state into the coder description", () => {
    const payload = prepareDshMtFixItJobPayload({
      source: "dsh:twitch",
      tenantId: "tenant-42",
      description: "Chat commands are failing after reconnect.",
      context: {
        source: "twitch",
        diagnosticEvidence: {
          schemaVersion: "dsh.mtfixit.snapshot/v1",
          ecosystemSnapshot: {
            status: "captured",
            snapshotJson: JSON.stringify({
              apps: {
                streamweaver: {
                  name: "StreamWeaver",
                  services: {
                    "streamweaver-new": {
                      flyApp: "streamweaver-new",
                      runtime: { status: "degraded", machineCount: 1, failingCheckCount: 2, states: { started: 1 } },
                    },
                  },
                },
              },
            }),
          },
          adapters: {
            ecosystemHealth: { status: "captured", note: "runtime inventory" },
            appRuntimeLogs: { status: "pending-adapter", note: "tenant-scoped adapter pending" },
          },
        },
      },
    });

    expect(payload.description).toContain("Chat commands are failing after reconnect.");
    expect(payload.description).toContain("tenant=tenant-42");
    expect(payload.description).toContain("StreamWeaver/streamweaver-new: status=degraded");
    expect(payload.description).toContain("failingChecks=2");
    expect(payload.description).toContain("appRuntimeLogs: pending-adapter");
  });

  it("keeps oversized diagnostic snapshots below the coder worker request ceiling", () => {
    const payload = prepareDshMtFixItJobPayload({
      source: "dsh:twitch",
      tenantId: "tenant-42",
      description: "Large diagnostic report.",
      context: {
        source: "twitch",
        diagnosticEvidence: {
          schemaVersion: "dsh.mtfixit.snapshot/v1",
          ecosystemSnapshot: {
            status: "captured",
            endpoint: "https://example.test/ecosystem.json",
            snapshotJson: JSON.stringify({ apps: {}, filler: "x".repeat(180_000) }),
          },
          adapters: { ecosystemHealth: { status: "captured" } },
        },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(56 * 1024);
    expect(payload.context.diagnosticEvidence.ecosystemSnapshot.truncated).toBe(true);
  });

  it("does not expose list, artifact, or publish routes", () => {
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs")).toBeNull();
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/publish")).toBeNull();
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/diff")).toBeNull();
    expect(mapDshMtFixItWorkerPath("DELETE", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234")).toBeNull();
  });
});
