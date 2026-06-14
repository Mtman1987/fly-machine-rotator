import { AppRotationResult } from "./types.js";
import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { upsertUnifiedDiscordReport } from "./unifiedReport.js";

export async function sendDiscordReport(webhookUrl: string | undefined, results: AppRotationResult[]): Promise<void> {
  if (!webhookUrl) return;
  const historyFile = process.env.ROTATION_HISTORY_FILE;
  const history = historyFile ? await RotationHistory.load(historyFile) : undefined;
  if (history) {
    history.add(results);
    await history.save();
  }
  await upsertUnifiedDiscordReport(webhookUrl, results);
}

function formatSummary(results: AppRotationResult[]): string {
  return results.map(formatResultLine).join("\n").slice(0, 3900);
}

function formatResultLine(result: AppRotationResult): string {
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

function formatDetailedResult(result: AppRotationResult): string {
  const status = result.success ? "OK" : "FAILED";
  const lines = [
    `**${result.appName}**: ${status}${result.dryRun ? " (dry run)" : ""}`,
    `handoff: ${result.previousActiveId ?? "none"} -> ${result.newActiveId ?? "none"}`,
    `before:\n${formatMachineLog(result.before)}`,
    `after:\n${formatMachineLog(result.after)}`,
    `actions:\n${formatActions(result.actions)}`
  ];
  if (result.warnings.length > 0) lines.push(`warnings: ${result.warnings.join("; ")}`);
  if (result.error) lines.push(`error: ${result.error}`);
  return lines.join("\n");
}

function formatMachineLog(machines: { id: string; state: string; name?: string; region?: string }[]): string {
  if (machines.length === 0) return "- none";
  return machines
    .map((machine) => `- ${machine.id} ${machine.state}${machine.region ? ` ${machine.region}` : ""}${machine.name ? ` ${machine.name}` : ""}`)
    .join("\n");
}

function formatActions(actions: string[]): string {
  if (actions.length === 0) return "- none";
  return actions.map((action) => `- ${action}`).join("\n");
}

type RotationHistoryEntry = {
  at: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  trigger?: string;
  results: Array<{ appName: string; success: boolean; mode: string; from?: string; to?: string; warnings?: number; error?: string }>;
};

class RotationHistory {
  private constructor(private readonly path: string, private readonly values: RotationHistoryEntry[]) {}

  static async load(path: string): Promise<RotationHistory> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as RotationHistoryEntry[];
      return new RotationHistory(path, Array.isArray(parsed) ? parsed : []);
    } catch {
      return new RotationHistory(path, []);
    }
  }

  add(results: AppRotationResult[]): void {
    const finishedAt = new Date().toISOString();
    this.values.push({
      at: finishedAt,
      finishedAt,
      results: results.map((result) => {
        const mode = result.previousActiveId && result.newActiveId && result.previousActiveId !== result.newActiveId
          ? "handoff"
          : result.previousActiveId && result.newActiveId && result.previousActiveId === result.newActiveId
            ? "restart"
            : "no-op";
        return {
          appName: result.appName,
          success: result.success,
          mode,
          from: result.previousActiveId,
          to: result.newActiveId,
          warnings: result.warnings.length,
          error: result.error
        };
      })
    });
    while (this.values.length > 20) this.values.shift();
  }

  renderSummary(): string {
    return this.values.slice(-8).reverse().map((entry) => {
      const ok = entry.results.filter((result) => result.success).length;
      const fail = entry.results.length - ok;
      const handoffs = entry.results.filter((result) => result.mode === "handoff").length;
      const restarts = entry.results.filter((result) => result.mode === "restart").length;
      return `${entry.at} ok=${ok} failed=${fail} handoffs=${handoffs} restarts=${restarts}`;
    }).join("\n");
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(this.values, null, 2));
  }
}
