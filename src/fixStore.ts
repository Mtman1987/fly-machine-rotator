import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

export type FixStatus =
  | "new"
  | "generated"
  | "applied"
  | "checked"
  | "pushed"
  | "handled"
  | "error";

export interface FixFileChange {
  path: string;
  reason: string;
  content: string;
}

export interface FixCheckResult {
  ranAt: string;
  ok: boolean;
  commandResults: Array<{
    command: string;
    exitCode: number;
    output: string;
  }>;
}

export interface FixPushResult {
  pushedAt: string;
  branch: string;
  commit: string;
  output: string;
}

export interface FixAttempt {
  attemptedAt: string;
  action: "generate" | "apply" | "check" | "push" | "handled";
  ok: boolean;
  summary: string;
  details?: string;
}

export interface FixRepoSnapshot {
  capturedAt: string;
  repoPath: string;
  branch?: string;
  headCommit?: string;
  originCommit?: string;
  dirty?: boolean;
  contextPaths: string[];
}

export interface FixRecord {
  id: string;
  appName: string;
  fingerprint: string;
  repoId?: string;
  repoLabel?: string;
  repoUrl?: string;
  status: FixStatus;
  generatedAt?: string;
  updatedAt: string;
  diagnosis?: string;
  summary?: string;
  confidence?: "low" | "medium" | "high";
  sourceSummary?: string;
  changes: FixFileChange[];
  attempts: FixAttempt[];
  repoSnapshot?: FixRepoSnapshot;
  checkResult?: FixCheckResult;
  pushResult?: FixPushResult;
  lastError?: string;
  handledAt?: string;
}

export class FixStore {
  private constructor(
    private readonly path: string,
    private readonly values: FixRecord[]
  ) {}

  static async load(path: string): Promise<FixStore> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as FixRecord[];
      return new FixStore(path, Array.isArray(parsed) ? parsed.map(normalizeFixRecord) : []);
    } catch {
      return new FixStore(path, []);
    }
  }

  list(): FixRecord[] {
    return this.values
      .slice()
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(id: string): FixRecord | undefined {
    return this.values.find((item) => item.id === id);
  }

  upsert(record: FixRecord): FixRecord {
    const index = this.values.findIndex((item) => item.id === record.id);
    if (index >= 0) {
      this.values[index] = record;
    } else {
      this.values.push(record);
    }
    return record;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.values, null, 2));
  }
}

export function getFixStoreFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROTATOR_FIXES_FILE ?? "/data/fix-proposals.json";
}

export function buildFixId(appName: string, fingerprint: string): string {
  return `${appName}::${fingerprint}`;
}

export function appendFixAttempt(
  record: FixRecord,
  attempt: FixAttempt
): FixRecord {
  record.attempts = [...(Array.isArray(record.attempts) ? record.attempts : []), attempt].slice(-20);
  return record;
}

function normalizeFixRecord(record: FixRecord): FixRecord {
  return {
    ...record,
    changes: Array.isArray(record.changes) ? record.changes : [],
    attempts: Array.isArray(record.attempts) ? record.attempts : []
  };
}
