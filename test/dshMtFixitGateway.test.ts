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
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit")).toBe("/api/codex/jobs");
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs")).toBe("/api/codex/jobs");
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234", "?view=status"))
      .toBe("/api/codex/jobs/mtfix_12345678_abcd1234?view=status");
  });

  it("bridges global Commlink evidence and service health into the coder description", () => {
    const payload = prepareDshMtFixItJobPayload({
      source: "dsh:twitch",
      description: "Chat commands are failing after reconnect.",
      context: {
        source: "twitch",
        diagnosticEvidence: {
          schemaVersion: "dsh.mtfixit.snapshot/v1",
          scope: { tenantId: null },
          commlinkSnapshot: {
            status: "captured",
            scope: "ecosystem-global",
            itemCount: 2,
            snapshotJson: JSON.stringify({
              scope: "ecosystem-global",
              items: [
                { timestamp: "2026-08-17T21:00:00.000Z", sourceApp: "discord-stream-hub", eventType: "message", channel: "support", actor: { displayName: "Alpha" }, text: "command failed" },
                { timestamp: "2026-08-17T21:00:01.000Z", sourceApp: "streamweaver", eventType: "relay.error", channel: "bridge", actor: { displayName: "system" }, text: "upstream timeout" },
              ],
            }),
          },
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
            commlinkGlobal: { status: "captured", note: "global Commlink evidence" },
          },
        },
      },
    });

    expect(payload.description).toContain("Chat commands are failing after reconnect.");
    expect(payload.description).toContain("tenantHint=none; not required for evidence capture");
    expect(payload.description).toContain("commlinkScope=ecosystem-global");
    expect(payload.description).toContain("discord-stream-hub/message");
    expect(payload.description).toContain("command failed");
    expect(payload.description).toContain("streamweaver/relay.error");
    expect(payload.description).toContain("upstream timeout");
    expect(payload.description).toContain("StreamWeaver/streamweaver-new: status=degraded");
    expect(payload.description).toContain("failingChecks=2");
  });

  it("keeps oversized health and Commlink snapshots below the coder worker request ceiling", () => {
    const payload = prepareDshMtFixItJobPayload({
      source: "dsh:twitch",
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
          commlinkSnapshot: {
            status: "captured",
            endpoint: "https://spmt.live/api/internal/commlink/diagnostic-feed",
            scope: "ecosystem-global",
            itemCount: 500,
            snapshotJson: JSON.stringify({ items: [{ text: "y".repeat(180_000) }] }),
          },
          adapters: { ecosystemHealth: { status: "captured" }, commlinkGlobal: { status: "captured" } },
        },
      },
    });

    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThan(56 * 1024);
    expect(payload.context.diagnosticEvidence.ecosystemSnapshot.truncated).toBe(true);
    expect(payload.context.diagnosticEvidence.commlinkSnapshot.truncated).toBe(true);
  });

  it("does not expose list, artifact, or publish routes", () => {
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs")).toBeNull();
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/publish")).toBeNull();
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/diff")).toBeNull();
    expect(mapDshMtFixItWorkerPath("DELETE", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234")).toBeNull();
  });
});
