import { CreateMachineRequest, FlyClient, FlyMachine, Lease, StopMachineRequest } from "./types.js";

interface FlyApiClientOptions {
  token: string;
  hostname?: string;
  minIntervalMs?: number;
  maxRetries?: number;
}

export class FlyApiClient implements FlyClient {
  private readonly token: string;
  private readonly hostname: string;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private nextRequestAt = 0;

  constructor(options: FlyApiClientOptions) {
    this.token = options.token;
    this.hostname = (options.hostname ?? "https://api.machines.dev").replace(/\/$/, "");
    this.minIntervalMs = options.minIntervalMs ?? 400;
    this.maxRetries = options.maxRetries ?? 4;
  }

  listMachines(appName: string): Promise<FlyMachine[]> {
    return this.request("GET", `/v1/apps/${encodeURIComponent(appName)}/machines`);
  }

  getMachine(appName: string, machineId: string): Promise<FlyMachine> {
    return this.request("GET", `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}`);
  }

  createMachine(appName: string, request: CreateMachineRequest): Promise<FlyMachine> {
    return this.request("POST", `/v1/apps/${encodeURIComponent(appName)}/machines`, request);
  }

  async startMachine(appName: string, machineId: string, leaseNonce?: string): Promise<void> {
    await this.request("POST", `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}/start`, undefined, leaseNonce);
  }

  async stopMachine(appName: string, machineId: string, request?: StopMachineRequest, leaseNonce?: string): Promise<void> {
    await this.request("POST", `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}/stop`, request ?? {}, leaseNonce);
  }

  async waitForMachineState(appName: string, machineId: string, state: string, instanceId?: string): Promise<void> {
    const params = new URLSearchParams({ state });
    if (instanceId) params.set("instance_id", instanceId);
    await this.request("GET", `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}/wait?${params}`);
  }

  async createLease(appName: string, machineId: string, ttlSeconds: number, description: string): Promise<Lease> {
    const response = await this.request<{ data?: Lease; nonce?: string }>(
      "POST",
      `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}/lease`,
      { ttl: ttlSeconds, description }
    );
    const lease = response.data ?? response;
    if (!lease.nonce) throw new Error(`Fly lease response for ${appName}/${machineId} did not include a nonce.`);
    return lease as Lease;
  }

  async releaseLease(appName: string, machineId: string, nonce: string): Promise<void> {
    await this.request("DELETE", `/v1/apps/${encodeURIComponent(appName)}/machines/${machineId}/lease`, undefined, nonce, [400, 404]);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    leaseNonce?: string,
    ignoreStatuses: number[] = []
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      await this.throttle();
      const response = await fetch(`${this.hostname}${path}`, {
        method,
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Content-Type": "application/json",
          ...(leaseNonce ? { "fly-machine-lease-nonce": leaseNonce } : {})
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });

      if (ignoreStatuses.includes(response.status)) {
        return undefined as T;
      }

      if (response.ok) {
        if (response.status === 204) return undefined as T;
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }

      const retryAfterMs = retryAfterToMs(response.headers.get("retry-after"));
      const text = await response.text().catch(() => "");
      lastError = new Error(`${method} ${path} failed with ${response.status}: ${text}`);

      if (!shouldRetry(response.status) || attempt === this.maxRetries) break;
      await sleep(retryAfterMs ?? backoffMs(attempt));
    }
    throw lastError;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    if (now < this.nextRequestAt) {
      await sleep(this.nextRequestAt - now);
    }
    this.nextRequestAt = Date.now() + this.minIntervalMs;
  }
}

function shouldRetry(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
  const base = Math.min(10_000, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function retryAfterToMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
