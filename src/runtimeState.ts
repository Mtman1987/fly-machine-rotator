import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { AppRotationResult } from "./types.js";

export interface RotatorRuntimeState {
  updatedAt: string;
  totalRuns: number;
  currentStatus: "idle" | "running" | "success" | "failed";
  lastTrigger?: string;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  nextRunAt?: string;
  lastRunLines: string[];
}

const DEFAULT_STATE: RotatorRuntimeState = {
  updatedAt: new Date(0).toISOString(),
  totalRuns: 0,
  currentStatus: "idle",
  lastRunLines: []
};

export class RotatorRuntimeStateStore {
  private constructor(
    private readonly path: string,
    private readonly value: RotatorRuntimeState
  ) {}

  static async load(path: string): Promise<RotatorRuntimeStateStore> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<RotatorRuntimeState>;
      return new RotatorRuntimeStateStore(path, normalizeState(parsed));
    } catch {
      return new RotatorRuntimeStateStore(path, { ...DEFAULT_STATE });
    }
  }

  snapshot(): RotatorRuntimeState {
    return structuredClone(this.value);
  }

  async markRunning(trigger: string, startedAt: string): Promise<void> {
    this.value.currentStatus = "running";
    this.value.lastTrigger = trigger;
    this.value.lastStartedAt = startedAt;
    this.value.lastFinishedAt = undefined;
    this.value.lastDurationMs = undefined;
    this.value.lastError = undefined;
    this.value.lastRunLines = [];
    this.value.updatedAt = startedAt;
    await this.save();
  }

  async markFinished(
    trigger: string,
    finishedAt: string,
    durationMs: number,
    results: AppRotationResult[],
    nextRunAt: string
  ): Promise<void> {
    this.value.totalRuns += 1;
    this.value.currentStatus = results.every((result) => result.success) ? "success" : "failed";
    this.value.lastTrigger = trigger;
    this.value.lastFinishedAt = finishedAt;
    this.value.lastDurationMs = durationMs;
    this.value.lastError = results.find((result) => result.error)?.error;
    this.value.nextRunAt = nextRunAt;
    this.value.lastRunLines = results.map(formatRuntimeResultLine).slice(0, 20);
    this.value.updatedAt = finishedAt;
    await this.save();
  }

  async markCrashed(trigger: string, finishedAt: string, durationMs: number, error: string, nextRunAt: string): Promise<void> {
    this.value.totalRuns += 1;
    this.value.currentStatus = "failed";
    this.value.lastTrigger = trigger;
    this.value.lastFinishedAt = finishedAt;
    this.value.lastDurationMs = durationMs;
    this.value.lastError = error;
    this.value.nextRunAt = nextRunAt;
    this.value.lastRunLines = [`FAILED ${error.slice(0, 240)}`];
    this.value.updatedAt = finishedAt;
    await this.save();
  }

  async setNextRunAt(nextRunAt: string | undefined): Promise<void> {
    this.value.nextRunAt = nextRunAt;
    this.value.updatedAt = new Date().toISOString();
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.value, null, 2));
  }
}

export function getRuntimeStateFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROTATOR_RUNTIME_STATE_FILE ?? "/data/runtime-state.json";
}

export function formatRuntimeResultLine(result: AppRotationResult): string {
  const status = result.success ? "OK" : "FAILED";
  const mode = result.previousActiveId && result.newActiveId && result.previousActiveId !== result.newActiveId
    ? "handoff"
    : result.previousActiveId && result.newActiveId && result.previousActiveId === result.newActiveId
      ? "restart"
      : "no-op";
  const warning = result.warnings.length > 0 ? ` warn=${result.warnings.length}` : "";
  const error = result.error ? ` error=${result.error.slice(0, 140)}` : "";
  return `${status} ${result.appName} ${mode}: ${result.previousActiveId ?? "none"} -> ${result.newActiveId ?? "none"}${warning}${error}`;
}

function normalizeState(value: Partial<RotatorRuntimeState>): RotatorRuntimeState {
  return {
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : DEFAULT_STATE.updatedAt,
    totalRuns: typeof value.totalRuns === "number" && Number.isFinite(value.totalRuns) ? value.totalRuns : 0,
    currentStatus: value.currentStatus === "running" || value.currentStatus === "success" || value.currentStatus === "failed"
      ? value.currentStatus
      : "idle",
    lastTrigger: typeof value.lastTrigger === "string" ? value.lastTrigger : undefined,
    lastStartedAt: typeof value.lastStartedAt === "string" ? value.lastStartedAt : undefined,
    lastFinishedAt: typeof value.lastFinishedAt === "string" ? value.lastFinishedAt : undefined,
    lastDurationMs: typeof value.lastDurationMs === "number" && Number.isFinite(value.lastDurationMs) ? value.lastDurationMs : undefined,
    lastError: typeof value.lastError === "string" ? value.lastError : undefined,
    nextRunAt: typeof value.nextRunAt === "string" ? value.nextRunAt : undefined,
    lastRunLines: Array.isArray(value.lastRunLines) ? value.lastRunLines.filter((item): item is string => typeof item === "string") : []
  };
}
