import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { StoredErrorEvent } from "./aiFixer.js";

export type IgnoreRuleKind = "fingerprint" | "app_message_regex";

export interface IgnoreRule {
  id: string;
  kind: IgnoreRuleKind;
  appName?: string;
  fingerprint?: string;
  pattern?: string;
  createdAt: string;
  note?: string;
}

export class IgnoreRuleStore {
  private constructor(
    private readonly path: string,
    private readonly values: IgnoreRule[]
  ) {}

  static async load(path: string): Promise<IgnoreRuleStore> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as IgnoreRule[];
      return new IgnoreRuleStore(path, Array.isArray(parsed) ? parsed : []);
    } catch {
      return new IgnoreRuleStore(path, []);
    }
  }

  list(): IgnoreRule[] {
    return this.values
      .slice()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  add(rule: IgnoreRule): IgnoreRule {
    if (!this.values.some((value) => value.id === rule.id)) {
      this.values.push(rule);
    }
    return rule;
  }

  remove(id: string): boolean {
    const index = this.values.findIndex((value) => value.id === id);
    if (index < 0) return false;
    this.values.splice(index, 1);
    return true;
  }

  matches(event: Pick<StoredErrorEvent, "appName" | "fingerprint" | "message">): boolean {
    return this.values.some((rule) => matchesRule(rule, event));
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.values, null, 2));
  }
}

export function getIgnoreRulesFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.ROTATOR_IGNORE_RULES_FILE ?? "/data/ignore-rules.json";
}

export function buildFingerprintIgnoreRule(event: Pick<StoredErrorEvent, "appName" | "fingerprint" | "message">): IgnoreRule {
  return {
    id: `fingerprint:${event.appName}:${event.fingerprint}`,
    kind: "fingerprint",
    appName: event.appName,
    fingerprint: event.fingerprint,
    createdAt: new Date().toISOString(),
    note: trimNote(event.message)
  };
}

export function buildPatternIgnoreRule(event: Pick<StoredErrorEvent, "appName" | "message">): IgnoreRule {
  const pattern = deriveIgnoreRegex(event.message);
  return {
    id: `pattern:${event.appName}:${pattern}`,
    kind: "app_message_regex",
    appName: event.appName,
    pattern,
    createdAt: new Date().toISOString(),
    note: trimNote(event.message)
  };
}

export function matchesRule(rule: IgnoreRule, event: Pick<StoredErrorEvent, "appName" | "fingerprint" | "message">): boolean {
  if (rule.kind === "fingerprint") {
    return rule.appName === event.appName && rule.fingerprint === event.fingerprint;
  }
  if (rule.kind === "app_message_regex") {
    if (rule.appName && rule.appName !== event.appName) return false;
    if (!rule.pattern) return false;
    try {
      return new RegExp(rule.pattern, "i").test(event.message);
    } catch {
      return false;
    }
  }
  return false;
}

export function deriveIgnoreRegex(message: string): string {
  if (/You are not it! .* is it\./i.test(message)) {
    return String.raw`You are not it! .+ is it\.`;
  }
  if (/is immune \((?:20-min cooldown|no-tagback)\)/i.test(message)) {
    return String.raw`is immune \((?:20-min cooldown|no-tagback)\)`;
  }
  if (/is away\/offline/i.test(message)) {
    return String.raw`is away\/offline`;
  }

  const escaped = escapeRegex(message)
    .replace(/\\\"[^"]+\\\"/g, String.raw`\".+?\"`)
    .replace(/\b[a-f0-9]{8,}\b/gi, String.raw`[a-f0-9]{8,}`)
    .replace(/\b\d+\b/g, String.raw`\d+`);

  return escaped;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimNote(message: string): string {
  return message.length > 140 ? `${message.slice(0, 137)}...` : message;
}
