import {
  AppRotationResult,
  CreateMachineRequest,
  FlyClient,
  FlyMachine,
  MachineSnapshot,
  RotationOptions
} from "./types.js";
import { sleep } from "./flyClient.js";

const ACTIVE_STATES = new Set(["started", "starting", "running"]);
const STOPPED_STATES = new Set(["stopped", "suspended"]);

export class MachineRotator {
  constructor(
    private readonly fly: FlyClient,
    private readonly options: RotationOptions
  ) {}

  async rotateApps(appNames: string[]): Promise<AppRotationResult[]> {
    const results: AppRotationResult[] = [];
    for (const appName of appNames) {
      results.push(await this.rotateApp(appName));
    }
    return results;
  }

  async rotateApp(appName: string): Promise<AppRotationResult> {
    const actions: string[] = [];
    const warnings: string[] = [];
    let before: MachineSnapshot[] = [];
    let after: MachineSnapshot[] = [];
    let lease: { machineId: string; nonce: string } | undefined;
    let previousActiveId: string | undefined;
    let newActiveId: string | undefined;
    const reconciledExtraIds = new Set<string>();

    try {
      const initialMachines = await this.fly.listMachines(appName);
      before = snapshot(initialMachines);
      if (initialMachines.length === 0) {
        throw new Error("No Machines exist; cannot clone an active Machine configuration.");
      }

      let activeMachines = active(initialMachines);
      let activeMachine = choosePrimaryActive(activeMachines);
      const leaseAnchor = activeMachine ?? initialMachines[0];
      const unsafeReason = this.findUnsafeRotationReason(initialMachines);
      if (unsafeReason) {
        if (!this.options.restartUnsafeApps) {
          warnings.push(unsafeReason);
          actions.push("Skipped rotation because this app requires an explicit override.");
          return successResult(appName, this.options.dryRun, before, before, undefined, undefined, actions, warnings);
        }
        warnings.push(`${unsafeReason} Restarting the active Machine in place because clone handoff is unsafe for this app.`);
        return await this.restartActiveApp(appName, initialMachines, before, actions, warnings);
      }

      if (this.options.dryRun) {
        actions.push(`Would acquire app lock using Machine lease on ${leaseAnchor.id}.`);
      } else {
        const acquired = await this.fly.createLease(
          appName,
          leaseAnchor.id,
          this.options.leaseTtlSeconds,
          `fly-machine-rotator ${new Date().toISOString()}`
        );
        lease = { machineId: leaseAnchor.id, nonce: acquired.nonce };
        actions.push(`Acquired app lock using Machine lease on ${leaseAnchor.id}.`);
      }

      let machines = initialMachines;
      if (activeMachines.length > 1) {
        const extras = activeMachines.filter((machine) => machine.id !== activeMachine?.id);
        for (const extra of extras) reconciledExtraIds.add(extra.id);
        warnings.push(`Found ${activeMachines.length} active Machines before rotation; stopping extras first.`);
        await this.stopExtras(appName, extras, activeMachine?.id, actions, lease?.nonce);
        machines = this.options.dryRun ? machines : await this.fly.listMachines(appName);
        activeMachines = active(machines);
        activeMachine = choosePrimaryActive(activeMachines);
      }

      if (!activeMachine) {
        activeMachine = stopped(machines)[0];
        if (!activeMachine) throw new Error("No active or stopped standby Machine is available to start.");
        warnings.push("No active Machine found; starting an existing stopped Machine instead of rotating from an active source.");
      }

      previousActiveId = isActive(activeMachine) ? activeMachine.id : undefined;
      const existingStandby = stopped(machines).find(
        (machine) =>
          machine.id !== activeMachine?.id &&
          !reconciledExtraIds.has(machine.id) &&
          (this.options.allowVolumeRotation || !hasVolumeMount(machine))
      );
      const standby = existingStandby ?? await this.createStandby(appName, activeMachine, actions);
      const standbyWasCreatedAndLaunched = !existingStandby && !this.options.dryRun;
      newActiveId = standby.id;

      if (this.options.dryRun) {
        actions.push(`Would start standby Machine ${standby.id}.`);
        actions.push(`Would poll Machine ${standby.id} until healthy.`);
        if (previousActiveId) actions.push(`Would stop previous active Machine ${previousActiveId} only after ${standby.id} is healthy.`);
        after = before;
        return successResult(appName, this.options.dryRun, before, after, previousActiveId, newActiveId, actions, warnings);
      }

      if (standbyWasCreatedAndLaunched) {
        actions.push(`Standby Machine ${standby.id} was created and launched.`);
      } else {
        actions.push(`Starting standby Machine ${standby.id}.`);
        await this.fly.startMachine(appName, standby.id, standby.id === lease?.machineId ? lease.nonce : undefined);
      }
      await this.waitForHealthy(appName, standby.id, actions);

      if (previousActiveId && previousActiveId !== standby.id) {
        actions.push(`Stopping previous active Machine ${previousActiveId}.`);
        await this.fly.stopMachine(
          appName,
          previousActiveId,
          { signal: "SIGTERM", timeout: `${this.options.stopTimeoutSeconds}s` },
          previousActiveId === lease?.machineId ? lease.nonce : undefined
        );
        await this.fly.waitForMachineState(appName, previousActiveId, "stopped").catch((error) => {
          warnings.push(`Timed out waiting for ${previousActiveId} to report stopped: ${String(error)}`);
        });
      }

      after = await this.verifyExactlyOneRunning(appName, standby.id, actions, warnings, lease?.nonce);
      return successResult(appName, false, before, after, previousActiveId, newActiveId, actions, warnings);
    } catch (error) {
      try {
        after = snapshot(await this.fly.listMachines(appName));
      } catch {
        after = [];
      }
      return {
        appName,
        success: false,
        dryRun: this.options.dryRun,
        before,
        after,
        previousActiveId,
        newActiveId,
        actions,
        warnings,
        error: error instanceof Error ? error.message : String(error)
      };
    } finally {
      if (lease) {
        await this.fly.releaseLease(appName, lease.machineId, lease.nonce).catch(() => undefined);
      }
    }
  }

  private async createStandby(appName: string, activeMachine: FlyMachine, actions: string[]): Promise<FlyMachine> {
    if (!activeMachine.config) {
      throw new Error(`Active Machine ${activeMachine.id} has no config to clone.`);
    }
    const request: CreateMachineRequest = {
      config: structuredClone(activeMachine.config),
      region: activeMachine.region,
      skip_launch: this.options.dryRun
    };

    if (this.options.dryRun) {
      actions.push(`Would create stopped standby Machine from ${activeMachine.id}.`);
      return {
        id: "dry-run-created-standby",
        state: "stopped",
        region: activeMachine.region,
        config: request.config
      };
    }

    actions.push(`Creating stopped standby Machine from ${activeMachine.id}.`);
    return this.fly.createMachine(appName, request);
  }

  private async restartActiveApp(
    appName: string,
    machines: FlyMachine[],
    before: MachineSnapshot[],
    actions: string[],
    warnings: string[]
  ): Promise<AppRotationResult> {
    const activeMachines = active(machines);
    const activeMachine = choosePrimaryActive(activeMachines);
    if (!activeMachine) {
      throw new Error("Restart fallback requires one active Machine.");
    }

    if (activeMachines.length > 1) {
      const extras = activeMachines.filter((machine) => machine.id !== activeMachine.id);
      warnings.push(`Restart fallback found ${activeMachines.length} active Machines; stopping extras first.`);
      await this.stopExtras(appName, extras, activeMachine.id, actions);
    }

    if (this.options.dryRun) {
      actions.push(`Would restart active Machine ${activeMachine.id} without starting a duplicate.`);
      return successResult(appName, true, before, before, activeMachine.id, activeMachine.id, actions, warnings);
    }

    const lease = await this.fly.createLease(
      appName,
      activeMachine.id,
      this.options.leaseTtlSeconds,
      `fly-machine-rotator restart fallback ${new Date().toISOString()}`
    );

    try {
      actions.push(`Stopping active Machine ${activeMachine.id} for restart fallback.`);
      await this.fly.stopMachine(appName, activeMachine.id, { signal: "SIGTERM", timeout: `${this.options.stopTimeoutSeconds}s` }, lease.nonce);
      await this.fly.waitForMachineState(appName, activeMachine.id, "stopped").catch((error) => {
        warnings.push(`Timed out waiting for ${activeMachine.id} to stop during restart fallback: ${String(error)}`);
      });

      actions.push(`Starting active Machine ${activeMachine.id} after restart fallback stop.`);
      await this.startRestartedMachine(appName, activeMachine.id, actions, warnings, lease.nonce);
      await this.waitForHealthy(appName, activeMachine.id, actions);
      actions.push(`Restarted Machine ${activeMachine.id}; ephemeral temp/cache data has been cleared.`);

      const after = await this.verifyExactlyOneRunning(appName, activeMachine.id, actions, warnings, lease.nonce);
      return successResult(appName, false, before, after, activeMachine.id, activeMachine.id, actions, warnings);
    } finally {
      await this.fly.releaseLease(appName, activeMachine.id, lease.nonce).catch(() => undefined);
    }
  }

  private async startRestartedMachine(
    appName: string,
    machineId: string,
    actions: string[],
    warnings: string[],
    leaseNonce: string
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.restartStartRetries; attempt += 1) {
      try {
        await this.fly.startMachine(appName, machineId, leaseNonce);
        return;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!isRetryableRestartStartError(message) || attempt === this.options.restartStartRetries) break;

        warnings.push(`Start retry ${attempt}/${this.options.restartStartRetries} for ${machineId}: ${message}`);
        await this.fly.waitForMachineState(appName, machineId, "stopped").catch(() => undefined);
        await sleep(this.options.restartStartRetryDelayMs);
      }
    }
    throw lastError;
  }

  private findUnsafeRotationReason(machines: FlyMachine[]): string | undefined {
    const activeMachine = choosePrimaryActive(active(machines));
    if (!this.options.allowVolumeRotation && activeMachine && hasVolumeMount(activeMachine)) {
      return `Active Machine ${activeMachine.id} has a Fly volume mount. Clone handoff is skipped because the standby may not be able to start while the old Machine owns the volume.`;
    }
    if (!this.options.allowMultiMachineServices && machines.some(hasMultiMachineService)) {
      return "App service config has min_machines_running greater than 1. Skipped because it conflicts with the exactly-one-running policy.";
    }
    return undefined;
  }

  private async waitForHealthy(appName: string, machineId: string, actions: string[]): Promise<void> {
    await this.fly.waitForMachineState(appName, machineId, "started").catch(() => undefined);
    const deadline = Date.now() + this.options.healthTimeoutMs;
    while (Date.now() < deadline) {
      const machine = await this.fly.getMachine(appName, machineId);
      if (isHealthy(machine, this.options.requireHealthChecks)) {
        actions.push(`Machine ${machineId} is healthy.`);
        return;
      }
      await sleep(this.options.healthPollIntervalMs);
    }
    throw new Error(`Timed out waiting for Machine ${machineId} to become healthy.`);
  }

  private async verifyExactlyOneRunning(
    appName: string,
    intendedActiveId: string,
    actions: string[],
    warnings: string[],
    leaseNonce?: string
  ): Promise<MachineSnapshot[]> {
    let machines = await this.fly.listMachines(appName);
    let running = active(machines);
    if (running.length > 1) {
      const extras = running.filter((machine) => machine.id !== intendedActiveId);
      warnings.push(`Verification found ${running.length} active Machines; stopping extras.`);
      await this.stopExtras(appName, extras, intendedActiveId, actions, leaseNonce);
      machines = await this.fly.listMachines(appName);
      running = active(machines);
    }
    if (running.length !== 1 || running[0].id !== intendedActiveId) {
      throw new Error(`Verification failed: expected exactly ${intendedActiveId} running, found ${running.map((machine) => `${machine.id}:${machine.state}`).join(", ") || "none"}.`);
    }
    actions.push(`Verified exactly one active Machine: ${intendedActiveId}.`);
    return snapshot(machines);
  }

  private async stopExtras(
    appName: string,
    extras: FlyMachine[],
    keepId: string | undefined,
    actions: string[],
    leaseNonce?: string
  ): Promise<void> {
    for (const machine of extras) {
      if (machine.id === keepId) continue;
      if (this.options.dryRun) {
        actions.push(`Would stop extra active Machine ${machine.id}.`);
      } else {
        actions.push(`Stopping extra active Machine ${machine.id}.`);
        await this.fly.stopMachine(appName, machine.id, { signal: "SIGTERM", timeout: `${this.options.stopTimeoutSeconds}s` }, leaseNonce);
      }
    }
  }
}

export function isHealthy(machine: FlyMachine, requireHealthChecks: boolean): boolean {
  if (!isActive(machine)) return false;
  const checks = machine.checks;
  if (!checks) return !requireHealthChecks;
  const values = Array.isArray(checks) ? checks : Object.values(checks);
  if (values.length === 0) return !requireHealthChecks;
  return values.every((check) => {
    const status = check.status?.toLowerCase();
    return status === "passing" || status === "passed" || status === "success" || status === "ok";
  });
}

function active(machines: FlyMachine[]): FlyMachine[] {
  return machines.filter(isActive);
}

function stopped(machines: FlyMachine[]): FlyMachine[] {
  return machines.filter((machine) => STOPPED_STATES.has(machine.state));
}

function isActive(machine: FlyMachine): boolean {
  return ACTIVE_STATES.has(machine.state);
}

function choosePrimaryActive(machines: FlyMachine[]): FlyMachine | undefined {
  return [...machines].sort((a, b) => sortableDate(b.updated_at ?? b.created_at) - sortableDate(a.updated_at ?? a.created_at))[0];
}

function sortableDate(value: string | undefined): number {
  return value ? Date.parse(value) || 0 : 0;
}

function snapshot(machines: FlyMachine[]): MachineSnapshot[] {
  return machines.map((machine) => ({
    id: machine.id,
    name: machine.name,
    state: machine.state,
    region: machine.region
  }));
}

function hasVolumeMount(machine: FlyMachine): boolean {
  const mounts = machine.config?.mounts;
  return Array.isArray(mounts) && mounts.length > 0;
}

function hasMultiMachineService(machine: FlyMachine): boolean {
  const services = machine.config?.services;
  if (!Array.isArray(services)) return false;
  return services.some((service) => {
    if (!service || typeof service !== "object") return false;
    const min = (service as { min_machines_running?: unknown }).min_machines_running;
    return typeof min === "number" && min > 1;
  });
}

function isRetryableRestartStartError(message: string): boolean {
  return /429|rate limit|machine still active|still attempting to start|failed_precondition/i.test(message);
}

function successResult(
  appName: string,
  dryRun: boolean,
  before: MachineSnapshot[],
  after: MachineSnapshot[],
  previousActiveId: string | undefined,
  newActiveId: string | undefined,
  actions: string[],
  warnings: string[]
): AppRotationResult {
  return {
    appName,
    success: true,
    dryRun,
    before,
    after,
    previousActiveId,
    newActiveId,
    actions,
    warnings
  };
}
