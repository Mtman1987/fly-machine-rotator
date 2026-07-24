import { dirname } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { RotatorRuntimeState, getRuntimeStateFile, RotatorRuntimeStateStore } from "./runtimeState.js";
import { AppRotationResult } from "./types.js";
import { redactSensitiveText, redactSensitiveValue } from "./redaction.js";

type RotationHistoryEntry = {
  at: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  trigger?: string;
  results: Array<{ appName: string; success: boolean; mode: string; from?: string; to?: string; warnings?: number; error?: string }>;
};

type StoredErrorEvent = {
  recordedAt: string;
  appName: string;
  fingerprint: string;
  machineId?: string;
  region?: string;
  timestamp?: string;
  message: string;
  suggestion: string;
  context: string[];
};

type UnifiedReportState = {
  messageId: string;
  createdAt: string;
  updatedAt: string;
};

export async function upsertUnifiedDiscordReport(
  webhookUrl: string | undefined,
  latestRotationResults?: AppRotationResult[]
): Promise<void> {
  if (!webhookUrl) return;

  const rotationHistoryFile = process.env.ROTATION_HISTORY_FILE ?? "/data/rotation-history.json";
  const errorHistoryFile = process.env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json";
  const stateFile = getUnifiedReportStateFile();
  const dashboardUrl = getDashboardUrl();

  const [rotationHistory, errorHistory, currentState, runtimeState] = await Promise.all([
    readRotationHistory(rotationHistoryFile),
    readErrorHistory(errorHistoryFile),
    DiscordUnifiedReportState.load(stateFile),
    RotatorRuntimeStateStore.load(getRuntimeStateFile()).then((store) => store.snapshot()),
  ]);

  const payload = buildUnifiedPayload(rotationHistory, errorHistory, runtimeState, latestRotationResults, dashboardUrl);
  const webhook = parseDiscordWebhookUrl(webhookUrl);
  const currentMessage = currentState.get();

  if (currentMessage) {
    const editResponse = await fetch(`${webhook.messagesUrl}/${currentMessage.messageId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (editResponse.ok) {
      const updated = (await editResponse.json().catch(() => undefined)) as { id?: string } | undefined;
      await currentState.set({
        messageId: updated?.id ?? currentMessage.messageId,
        createdAt: currentMessage.createdAt,
        updatedAt: new Date().toISOString()
      });
      return;
    }

    const body = await editResponse.text().catch(() => "");
    if (!shouldRepostUnifiedReport(editResponse.status, body)) {
      throw new Error(`Discord webhook edit failed with ${editResponse.status}: ${body}`);
    }

    await fetch(`${webhook.messagesUrl}/${currentMessage.messageId}`, { method: "DELETE" }).catch(() => undefined);
    await currentState.clear();
  }

  const createResponse = await fetch(`${webhook.baseUrl}?wait=true`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!createResponse.ok) {
    const body = await createResponse.text().catch(() => "");
    throw new Error(`Discord webhook create failed with ${createResponse.status}: ${body}`);
  }

  const created = (await createResponse.json().catch(() => undefined)) as { id?: string } | undefined;
  if (created?.id) {
    const now = new Date().toISOString();
    await currentState.set({ messageId: created.id, createdAt: now, updatedAt: now });
  }
}

export function buildUnifiedPayload(
  rotationHistory: RotationHistoryEntry[],
  errorHistory: StoredErrorEvent[],
  runtimeState: RotatorRuntimeState,
  latestRotationResults: AppRotationResult[] | undefined,
  dashboardUrl: string
): object {
  const prunedErrors = pruneErrorHistory(errorHistory);
  const latestHistoryEntry = rotationHistory.at(-1);
  const brandAssets = getBrandAssetUrls(dashboardUrl);
  const latestRotation = latestRotationResults ? summarizeRotationResults(latestRotationResults) : summarizeLatestRotation(rotationHistory);
  const failureCounts = summarizeFailureCounts(prunedErrors);
  const latestRunLines = latestRotationResults
    ? latestRotationResults.map((result) => renderModeLine(result.appName, inferMode(result.previousActiveId, result.newActiveId))).join("\n")
    : renderLatestRunLines(rotationHistory, runtimeState.lastRunLines);
  const [rotationColumnOne, rotationColumnTwo] = splitLinesIntoColumns(latestRunLines, 2);
  const startedAt = runtimeState.lastStartedAt ?? latestHistoryEntry?.startedAt ?? latestHistoryEntry?.at;
  const finishedAt = runtimeState.lastFinishedAt ?? latestHistoryEntry?.finishedAt ?? latestHistoryEntry?.at;
  const totalRuns = runtimeState.totalRuns > 0 ? runtimeState.totalRuns : rotationHistory.length;
  const latestRunStatus = runtimeState.currentStatus === "running"
    ? "running"
    : latestRotation.failed > 0
      ? "failed"
      : totalRuns > 0
        ? "success"
        : "idle";
  const notesText = [
    `${latestRotation.handoffs} handoffs`,
    `${latestRotation.restarts} restarts`,
    `${latestRotation.failed} failed`
  ].join("\n");
  const summaryText = [
    `Latest run: ${latestRunStatus}`,
    `Started: ${formatTimestamp(startedAt)}`,
    `Finished: ${formatTimestamp(finishedAt)}`,
    `Next run: ${formatTimestamp(runtimeState.nextRunAt)}`,
    `Total runs: ${totalRuns}`,
    `24h errors: ${prunedErrors.length}`
  ].join("\n");
  const footerParts = [
    startedAt ? `rotation start ${formatTimestamp(startedAt)}` : undefined,
    finishedAt ? `last finished ${formatTimestamp(finishedAt)}` : undefined
  ].filter(Boolean);

  return {
    username: "Fly Machine Rotator",
    avatar_url: brandAssets.avatarUrl,
    attachments: [],
    content: "Rolling Fly rotation and error report.",
    embeds: [
      {
        title: "Open rotator dashboard",
        url: dashboardUrl,
        color: latestRotation.failed > 0 ? 0xe67e22 : prunedErrors.length > 0 ? 0xe74c3c : 0x2ecc71,
        description: latestRotation.text,
        thumbnail: { url: brandAssets.logoUrl },
        fields: [
          {
            name: "Status",
            value: codeBlock(summaryText),
            inline: false
          },
          {
            name: "Rotation 1",
            value: codeBlock(rotationColumnOne),
            inline: true
          },
          {
            name: "Rotation 2",
            value: codeBlock(rotationColumnTwo),
            inline: true
          },
          {
            name: "24h Failure Totals",
            value: codeBlock(failureCounts),
            inline: true
          },
          {
            name: "Notes",
            value: codeBlock(notesText),
            inline: true
          }
        ],
        footer: footerParts.length > 0 ? { text: footerParts.join(" | ") } : undefined,
        timestamp: new Date().toISOString()
      }
    ]
  };
}

function splitLinesIntoColumns(text: string, columns: number): string[] {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return Array.from({ length: columns }, () => "\u200b");
  const rowsPerColumn = Math.ceil(lines.length / columns);
  return Array.from({ length: columns }, (_, index) => {
    const start = index * rowsPerColumn;
    const value = lines.slice(start, start + rowsPerColumn).join("\n").trim();
    return value || "\u200b";
  });
}

function summarizeRotationResults(results: AppRotationResult[]): { failed: number; handoffs: number; restarts: number; text: string } {
  const failed = results.filter((result) => !result.success).length;
  const handoffs = results.filter((result) => result.previousActiveId && result.newActiveId && result.previousActiveId !== result.newActiveId).length;
  const restarts = results.filter((result) => result.previousActiveId && result.newActiveId && result.previousActiveId === result.newActiveId).length;
  const at = new Date().toISOString();
  return {
    failed,
    handoffs,
    restarts,
    text: `${at} ok=${results.length - failed} failed=${failed} handoffs=${handoffs} restarts=${restarts}`
  };
}

function summarizeLatestRotation(history: RotationHistoryEntry[]): { failed: number; handoffs: number; restarts: number; text: string } {
  const latest = history.at(-1);
  if (!latest) return { failed: 0, handoffs: 0, restarts: 0, text: "no rotations recorded yet" };
  const ok = latest.results.filter((result) => result.success).length;
  const failed = latest.results.length - ok;
  const handoffs = latest.results.filter((result) => result.mode === "handoff").length;
  const restarts = latest.results.filter((result) => result.mode === "restart").length;
  return {
    failed,
    handoffs,
    restarts,
    text: `${latest.at} ok=${ok} failed=${failed} handoffs=${handoffs} restarts=${restarts}`
  };
}

function renderLatestRunLines(history: RotationHistoryEntry[], runtimeLines: string[]): string {
  if (runtimeLines.length > 0) return runtimeLines.join("\n").slice(0, 1000);
  const latest = history.at(-1);
  if (!latest) return "No rotation output recorded.";
  return latest.results
    .map((result) => renderModeLine(result.appName, result.mode))
    .join("\n")
    .slice(0, 1000);
}

function summarizeFailureCounts(events: StoredErrorEvent[]): string {
  if (events.length === 0) return "No errors in the last 24 hours.";
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.appName, (counts.get(event.appName) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([appName, count]) => `${appName}: ${count}`)
    .join("\n")
    .slice(0, 1000);
}

function renderLast24HourReport(events: StoredErrorEvent[]): string {
  const pruned = pruneErrorHistory(events);
  const lines = [
    "Fly Log Monitor - errors from the last 24 hours",
    `Generated: ${new Date().toISOString()}`,
    `Count: ${pruned.length}`,
    ""
  ];

  for (const event of pruned) {
    lines.push("=".repeat(80));
    lines.push(`${event.recordedAt} ${event.appName} ${event.fingerprint}`);
    lines.push(`machine=${event.machineId ?? "unknown"} region=${event.region ?? "unknown"} log_time=${event.timestamp ?? "unknown"}`);
    lines.push(`error: ${redactSensitiveText(event.message)}`);
    lines.push(`suggestion: ${redactSensitiveText(event.suggestion)}`);
    lines.push("recent logs:");
    lines.push(...event.context.map((line) => `  ${redactSensitiveText(line)}`));
    lines.push("");
  }

  return lines.join("\n").slice(-900_000);
}

function renderModeLine(appName: string, mode: string): string {
  return `${appName.padEnd(24, " ")} ${mode}`;
}

function inferMode(previousActiveId: string | undefined, newActiveId: string | undefined): string {
  if (previousActiveId && newActiveId && previousActiveId !== newActiveId) return "handoff";
  if (previousActiveId && newActiveId && previousActiveId === newActiveId) return "restart";
  return "no-op";
}

function pruneErrorHistory(events: StoredErrorEvent[]): StoredErrorEvent[] {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return events.filter((event) => Date.parse(event.recordedAt) >= cutoff);
}

function codeBlock(text: string): string {
  return ["```text", text, "```"].join("\n");
}

function getUnifiedReportStateFile(): string {
  return process.env.DISCORD_UNIFIED_REPORT_MESSAGE_FILE
    ?? process.env.DISCORD_ERROR_REPORT_MESSAGE_FILE
    ?? process.env.DISCORD_ROTATION_REPORT_MESSAGE_FILE
    ?? "/data/discord-unified-report-message.json";
}

function getDashboardUrl(): string {
  return process.env.PUBLIC_DASHBOARD_URL ?? `https://${process.env.FLY_APP_NAME ?? "mtman-machine-rotator"}.fly.dev/`;
}

function getBrandAssetUrls(dashboardUrl: string): { avatarUrl: string; logoUrl: string } {
  const base = dashboardUrl.endsWith("/") ? dashboardUrl.slice(0, -1) : dashboardUrl;
  return {
    avatarUrl: `${base}/brand/avatar.png`,
    logoUrl: `${base}/brand/logo.png`
  };
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC"
  }).format(date).replace(",", "") + " UTC";
}

function parseDiscordWebhookUrl(webhookUrl: string): { baseUrl: string; messagesUrl: string } {
  const parsed = new URL(webhookUrl);
  parsed.search = "";
  const parts = parsed.pathname.split("/").filter(Boolean);
  const webhookIndex = parts.indexOf("webhooks");
  if (webhookIndex < 0 || parts.length < webhookIndex + 3) {
    throw new Error("DISCORD_WEBHOOK_URL is not a Discord webhook URL.");
  }
  const id = parts[webhookIndex + 1];
  const token = parts[webhookIndex + 2];
  const origin = `${parsed.protocol}//${parsed.host}`;
  const baseUrl = `${origin}/api/webhooks/${id}/${token}`;
  return { baseUrl, messagesUrl: `${baseUrl}/messages` };
}

function shouldRepostUnifiedReport(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status === 400 || status === 429) {
    return /maximum number of edits|30046|too old/i.test(body);
  }
  return false;
}

async function readRotationHistory(path: string): Promise<RotationHistoryEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as RotationHistoryEntry[];
    return Array.isArray(parsed) ? redactSensitiveValue(parsed) : [];
  } catch {
    return [];
  }
}

async function readErrorHistory(path: string): Promise<StoredErrorEvent[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StoredErrorEvent[];
    return Array.isArray(parsed) ? redactSensitiveValue(parsed) : [];
  } catch {
    return [];
  }
}

class DiscordUnifiedReportState {
  private constructor(
    private readonly path: string,
    private value?: UnifiedReportState
  ) {}

  static async load(path: string): Promise<DiscordUnifiedReportState> {
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as Partial<UnifiedReportState> & { updatedAt?: string };
      if (typeof parsed.messageId === "string" && parsed.messageId.trim()) {
        return new DiscordUnifiedReportState(path, {
          messageId: parsed.messageId,
          createdAt: parsed.createdAt ?? parsed.updatedAt ?? new Date().toISOString(),
          updatedAt: parsed.updatedAt ?? new Date().toISOString()
        });
      }
    } catch {
      // Missing state means create on next update.
    }
    return new DiscordUnifiedReportState(path);
  }

  get(): UnifiedReportState | undefined {
    return this.value;
  }

  async set(value: UnifiedReportState): Promise<void> {
    this.value = value;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(value, null, 2));
  }

  async clear(): Promise<void> {
    this.value = undefined;
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify({}, null, 2));
  }
}
