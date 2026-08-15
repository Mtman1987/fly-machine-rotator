import { describe, expect, it } from "vitest";
import { buildPublicEcosystemSnapshotFromStates, ECOSYSTEM_SCHEMA_VERSION } from "../src/ecosystemSnapshot.js";

describe("ecosystem snapshot v1", () => {
  it("keeps declared lifecycle separate from observed runtime state", () => {
    const snapshot = buildPublicEcosystemSnapshotFromStates({
      generatedAt: "2026-08-15T16:45:00.000Z",
      apps: [
        {
          appName: "streamweaver-new",
          status: "stopped",
          machineCount: 1,
          states: { stopped: 1 },
          failingCheckCount: 0,
          machines: [{ id: "secret-machine-id", region: "ord", checks: [{ output: "private output" }] }],
        },
      ],
    }, { generatedAt: "2026-08-15T16:45:00.000Z", producerCommit: "abc123" });

    expect(snapshot.schemaVersion).toBe(ECOSYSTEM_SCHEMA_VERSION);
    expect(snapshot.apps.streamweaver.lifecycle).toBe("available");
    expect(snapshot.apps.streamweaver.services["streamweaver-new"].runtime.status).toBe("stopped");
    expect(snapshot.apps.streamweaver.repository.name).toBe("Mtman1987/streamweaver");
    expect(snapshot.producer.commit).toBe("abc123");
  });

  it("uses an explicit unobserved runtime instead of null when a declared service is outside the current observation set", () => {
    const snapshot = buildPublicEcosystemSnapshotFromStates({
      generatedAt: "2026-08-15T16:45:00.000Z",
      apps: [],
    });
    expect(snapshot.apps.spmt.lifecycle).toBe("available");
    expect(snapshot.apps.spmt.services["spmt-live"].runtime).toEqual({
      status: "unobserved",
      machineCount: null,
      states: {},
      failingCheckCount: null,
      observedAt: "2026-08-15T16:45:00.000Z",
    });
  });

  it("publishes only aggregate runtime data and never machine details", () => {
    const snapshot = buildPublicEcosystemSnapshotFromStates({
      generatedAt: "2026-08-15T16:45:00.000Z",
      apps: [{
        appName: "spmt-live",
        status: "degraded",
        machineCount: 2,
        states: { started: 2 },
        failingCheckCount: 1,
        machines: [{ id: "machine-id", region: "ord", checks: [{ output: "sensitive diagnostics" }] }],
      }],
    });

    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("machine-id");
    expect(serialized).not.toContain("sensitive diagnostics");
    expect(serialized).not.toContain("private_ip");
    expect(serialized).not.toContain("config");
    expect(snapshot.apps.spmt.services["spmt-live"].runtime).toMatchObject({
      status: "degraded",
      machineCount: 2,
      states: { started: 2 },
      failingCheckCount: 1,
    });
  });

  it("preserves stable product ids while allowing multiple Fly services", () => {
    const snapshot = buildPublicEcosystemSnapshotFromStates({ apps: [] });
    expect(Object.keys(snapshot.apps)).toEqual(expect.arrayContaining([
      "spmt",
      "rotator",
      "streamweaver",
      "discord-stream-hub",
      "hearmeout",
      "chat-tag",
    ]));
    expect(Object.keys(snapshot.apps["discord-stream-hub"].services)).toEqual([
      "discord-stream-hub-new",
      "dsh-clip-worker",
    ]);
  });
});
