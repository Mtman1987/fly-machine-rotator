import { describe, expect, it } from "vitest";
import { MachineRotator } from "../src/rotator.js";
import { CreateMachineRequest, FlyClient, FlyMachine, Lease, StopMachineRequest } from "../src/types.js";

const baseOptions = {
  dryRun: false,
  healthTimeoutMs: 50,
  healthPollIntervalMs: 1,
  stopTimeoutSeconds: 10,
  leaseTtlSeconds: 60,
  requireHealthChecks: true,
  allowVolumeRotation: false,
  allowMultiMachineServices: false,
  restartUnsafeApps: true,
  restartStartRetries: 3,
  restartStartRetryDelayMs: 1
};

describe("MachineRotator", () => {
  it("starts a healthy standby before stopping the previous active Machine", async () => {
    const fly = new FakeFlyClient([
      machine("active-1", "started"),
      machine("standby-1", "stopped")
    ]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("chat-bot");

    expect(result.success).toBe(true);
    expect(result.previousActiveId).toBe("active-1");
    expect(result.newActiveId).toBe("standby-1");
    expect(fly.calls).toEqual([
      "list",
      "lease active-1",
      "start standby-1",
      "wait standby-1 started",
      "get standby-1",
      "stop active-1",
      "wait active-1 stopped",
      "list",
      "release active-1"
    ]);
    expect(activeIds(fly.machines)).toEqual(["standby-1"]);
  });

  it("does not stop the old Machine if the new Machine never becomes healthy", async () => {
    const fly = new FakeFlyClient([
      machine("active-1", "started"),
      machine("standby-1", "stopped", false)
    ]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("chat-bot");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Timed out waiting");
    expect(fly.calls).not.toContain("stop active-1");
    expect(activeIds(fly.machines)).toEqual(["active-1", "standby-1"]);
  });

  it("creates a stopped standby from the active config when none exists", async () => {
    const fly = new FakeFlyClient([machine("active-1", "started")]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("chat-bot");

    expect(result.success).toBe(true);
    expect(fly.calls).toContain("create");
    expect(result.newActiveId).toBe("created-1");
    expect(activeIds(fly.machines)).toEqual(["created-1"]);
  });

  it("dry-run reports planned actions without mutating Machines", async () => {
    const fly = new FakeFlyClient([
      machine("active-1", "started"),
      machine("standby-1", "stopped")
    ]);
    const result = await new MachineRotator(fly, { ...baseOptions, dryRun: true }).rotateApp("chat-bot");

    expect(result.success).toBe(true);
    expect(result.actions).toContain("Would start standby Machine standby-1.");
    expect(fly.calls).toEqual(["list"]);
    expect(activeIds(fly.machines)).toEqual(["active-1"]);
  });

  it("stops extra active Machines found during initial reconciliation", async () => {
    const fly = new FakeFlyClient([
      machine("older-active", "started", true, "2026-01-01T00:00:00Z"),
      machine("newer-active", "started", true, "2026-01-02T00:00:00Z"),
      machine("standby-1", "stopped")
    ]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("chat-bot");

    expect(result.success).toBe(true);
    expect(result.warnings[0]).toContain("Found 2 active Machines");
    expect(fly.calls).toContain("stop older-active");
    expect(activeIds(fly.machines)).toEqual(["standby-1"]);
  });

  it("restarts volume-mounted apps instead of clone-rotating them", async () => {
    const active = machine("active-1", "started");
    active.config = { ...active.config, mounts: [{ volume: "vol_123", path: "/data" }] };
    const fly = new FakeFlyClient([active, machine("standby-1", "stopped")]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("chat-bot");

    expect(result.success).toBe(true);
    expect(result.warnings[0]).toContain("Restarting the active Machine in place");
    expect(fly.calls).toContain("stop active-1");
    expect(fly.calls).toContain("start active-1");
    expect(activeIds(fly.machines)).toEqual(["active-1"]);
  });

  it("ignores volume mounts on stopped legacy Machines when the active worker has no mount", async () => {
    const legacy = machine("legacy-volume", "stopped");
    legacy.config = { ...legacy.config, mounts: [{ volume: "vol_123", path: "/data" }] };
    const fly = new FakeFlyClient([machine("active-1", "started"), legacy, machine("standby-1", "stopped")]);
    const result = await new MachineRotator(fly, baseOptions).rotateApp("hmo-dj-worker");

    expect(result.success).toBe(true);
    expect(result.previousActiveId).toBe("active-1");
    expect(result.newActiveId).toBe("standby-1");
    expect(result.warnings).toHaveLength(0);
    expect(fly.calls).toContain("start standby-1");
    expect(fly.calls).toContain("stop active-1");
    expect(activeIds(fly.machines)).toEqual(["standby-1"]);
  });

  it("can hand off multi-machine service apps when explicitly allowed", async () => {
    const active = machine("active-1", "started");
    active.config = { ...active.config, services: [{ min_machines_running: 2 }] };
    const fly = new FakeFlyClient([active, machine("standby-1", "stopped")]);
    const result = await new MachineRotator(fly, { ...baseOptions, allowMultiMachineServices: true }).rotateApp("clip-worker");

    expect(result.success).toBe(true);
    expect(result.previousActiveId).toBe("active-1");
    expect(result.newActiveId).toBe("standby-1");
    expect(fly.calls).toContain("start standby-1");
    expect(fly.calls).toContain("stop active-1");
    expect(activeIds(fly.machines)).toEqual(["standby-1"]);
  });
});

function machine(id: string, state: string, healthy = true, updatedAt = "2026-01-01T00:00:00Z"): FlyMachine {
  return {
    id,
    state,
    region: "ord",
    updated_at: updatedAt,
    config: {
      image: "registry.fly.io/chat-bot:deployment-1",
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 }
    },
    checks: healthy ? { service: { status: "passing" } } : { service: { status: "critical" } }
  };
}

function activeIds(machines: FlyMachine[]): string[] {
  return machines.filter((item) => item.state === "started").map((item) => item.id);
}

class FakeFlyClient implements FlyClient {
  calls: string[] = [];
  machines: FlyMachine[];
  private created = 0;

  constructor(machines: FlyMachine[]) {
    this.machines = machines.map((item) => structuredClone(item));
  }

  async listMachines(): Promise<FlyMachine[]> {
    this.calls.push("list");
    return this.snapshot();
  }

  async getMachine(_appName: string, machineId: string): Promise<FlyMachine> {
    this.calls.push(`get ${machineId}`);
    return structuredClone(this.find(machineId));
  }

  async createMachine(_appName: string, request: CreateMachineRequest): Promise<FlyMachine> {
    this.calls.push("create");
    this.created += 1;
    const created = {
      id: `created-${this.created}`,
      state: request.skip_launch ? "stopped" : "started",
      region: request.region,
      config: request.config,
      checks: { service: { status: "passing" } },
      updated_at: "2026-01-03T00:00:00Z"
    };
    this.machines.push(created);
    return structuredClone(created);
  }

  async startMachine(_appName: string, machineId: string): Promise<void> {
    this.calls.push(`start ${machineId}`);
    this.find(machineId).state = "started";
  }

  async stopMachine(_appName: string, machineId: string, _request?: StopMachineRequest): Promise<void> {
    this.calls.push(`stop ${machineId}`);
    this.find(machineId).state = "stopped";
  }

  async waitForMachineState(_appName: string, machineId: string, state: string): Promise<void> {
    this.calls.push(`wait ${machineId} ${state}`);
  }

  async createLease(_appName: string, machineId: string): Promise<Lease> {
    this.calls.push(`lease ${machineId}`);
    return { nonce: `nonce-${machineId}` };
  }

  async releaseLease(_appName: string, machineId: string): Promise<void> {
    this.calls.push(`release ${machineId}`);
  }

  private find(machineId: string): FlyMachine {
    const found = this.machines.find((item) => item.id === machineId);
    if (!found) throw new Error(`missing ${machineId}`);
    return found;
  }

  private snapshot(): FlyMachine[] {
    return this.machines.map((item) => structuredClone(item));
  }
}
