export type MachineState =
  | "created"
  | "started"
  | "starting"
  | "stopped"
  | "stopping"
  | "suspended"
  | "destroyed"
  | "replacing"
  | string;

export interface FlyMachine {
  id: string;
  name?: string;
  state: MachineState;
  region?: string;
  instance_id?: string;
  private_ip?: string;
  config?: Record<string, unknown>;
  checks?: Record<string, FlyMachineCheck> | FlyMachineCheck[];
  created_at?: string;
  updated_at?: string;
}

export interface FlyMachineCheck {
  name?: string;
  status?: string;
  output?: string;
  updated_at?: string;
}

export interface Lease {
  nonce: string;
  expires_at?: number;
  owner?: string;
  description?: string;
  version?: string;
}

export interface CreateMachineRequest {
  config: Record<string, unknown>;
  region?: string;
  name?: string;
  skip_launch?: boolean;
  skip_service_registration?: boolean;
}

export interface StopMachineRequest {
  signal?: string;
  timeout?: string;
}

export interface FlyClient {
  listMachines(appName: string): Promise<FlyMachine[]>;
  getMachine(appName: string, machineId: string): Promise<FlyMachine>;
  createMachine(appName: string, request: CreateMachineRequest): Promise<FlyMachine>;
  startMachine(appName: string, machineId: string, leaseNonce?: string): Promise<void>;
  stopMachine(appName: string, machineId: string, request?: StopMachineRequest, leaseNonce?: string): Promise<void>;
  waitForMachineState(appName: string, machineId: string, state: string, instanceId?: string): Promise<void>;
  createLease(appName: string, machineId: string, ttlSeconds: number, description: string): Promise<Lease>;
  releaseLease(appName: string, machineId: string, nonce: string): Promise<void>;
}

export interface AppRotationResult {
  appName: string;
  success: boolean;
  dryRun: boolean;
  before: MachineSnapshot[];
  after: MachineSnapshot[];
  previousActiveId?: string;
  newActiveId?: string;
  actions: string[];
  warnings: string[];
  error?: string;
}

export interface MachineSnapshot {
  id: string;
  state: string;
  name?: string;
  region?: string;
}

export interface RotationOptions {
  dryRun: boolean;
  healthTimeoutMs: number;
  healthPollIntervalMs: number;
  stopTimeoutSeconds: number;
  leaseTtlSeconds: number;
  requireHealthChecks: boolean;
  allowVolumeRotation: boolean;
  allowMultiMachineServices: boolean;
  restartUnsafeApps: boolean;
  restartStartRetries: number;
  restartStartRetryDelayMs: number;
}
