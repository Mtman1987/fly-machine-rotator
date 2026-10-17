export type CurrencyCodeV1 = "GP" | "SP" | "XP";
export type CurrencyOperationV1 = "award" | "spend" | "transfer" | "redeem" | "adjust" | "delete" | "migration";

export type CurrencySweepEventV1 = {
  schema: "spmt.currency-source.v1";
  sourceId: string;
  currency: CurrencyCodeV1;
  operation: CurrencyOperationV1;
  delta: number;
  eventId?: string;
  duplicate?: boolean;
  occurredAt?: string;
  tenantId?: string;
};

export const CURRENCY_SOURCE_REGISTRY_V1 = [
  { sourceId: "nebula.checkin.front-seat", currency: "GP", app: "chat-tag", location: "src/lib/checkin-nebula-bonus.ts + /api/game-hub/checkin-bonus", status: "flagged-in-draft" },
  { sourceId: "streamweaver.ride.front-seat", currency: "SP", app: "ApolloStation/apps/streamweaver", location: "apps/streamweaver/src/ride-runtime.ts", status: "flagged-in-draft" },
  { sourceId: "spmt.xp.ledger.award", currency: "XP", app: "spmt-live", location: "POST /api/platform/xp", status: "flagged-in-draft" },
  { sourceId: "spmt.xp.ledger.spend", currency: "XP", app: "spmt-live", location: "POST /api/platform/xp/spend", status: "flagged-in-draft" },
  { sourceId: "spmt.xp.ledger.gamble", currency: "XP", app: "spmt-live", location: "POST /api/platform/xp/gamble-settle", status: "flagged-in-draft" },
  { sourceId: "spmt.xp.ledger.transfer", currency: "XP", app: "spmt-live", location: "POST /api/platform/xp/transfer", status: "flagged-in-draft" },
  { sourceId: "spmt.xp.ledger.migration", currency: "XP", app: "spmt-live", location: "POST /api/platform/xp/migrate-balance", status: "flagged-in-draft" },
] as const;

const PREFIX = "CURRENCY_SWEEP_V1 ";
const SOURCE_BY_ID = new Map<string, (typeof CURRENCY_SOURCE_REGISTRY_V1)[number]>(CURRENCY_SOURCE_REGISTRY_V1.map((source) => [source.sourceId, source]));
const VALID_OPERATIONS = new Set<CurrencyOperationV1>(["award", "spend", "transfer", "redeem", "adjust", "delete", "migration"]);

export type CurrencySweepReportV1 = {
  schema: "spmt.currency-sweep-report.v1";
  mode: "log-sample-only";
  scannedLines: number;
  flaggedLines: number;
  acceptedEvents: number;
  duplicateEvents: number;
  unknownSources: string[];
  invalidLines: number;
  byCurrency: Record<CurrencyCodeV1, { events: number; positiveUnits: number; negativeUnits: number; netDelta: number }>;
  bySource: Record<string, { currency: CurrencyCodeV1; events: number; positiveUnits: number; negativeUnits: number; netDelta: number }>;
  limitations: string[];
};

function emptyTotals() { return { events: 0, positiveUnits: 0, negativeUnits: 0, netDelta: 0 }; }

export function scanCurrencySweepLogsV1(lines: string[]): CurrencySweepReportV1 {
  const report: CurrencySweepReportV1 = {
    schema: "spmt.currency-sweep-report.v1",
    mode: "log-sample-only",
    scannedLines: lines.length,
    flaggedLines: 0,
    acceptedEvents: 0,
    duplicateEvents: 0,
    unknownSources: [],
    invalidLines: 0,
    byCurrency: { GP: emptyTotals(), SP: emptyTotals(), XP: emptyTotals() },
    bySource: {},
    limitations: [
      "Only flagged lines present in the supplied log sample are counted; this is not lifetime supply.",
      "Missing flags, truncated logs, retries, and log sampling can cause undercounting.",
      "A complete supply reconciliation requires authoritative ledger/state snapshots in addition to event logs.",
    ],
  };
  for (const line of lines) {
    const index = line.indexOf(PREFIX);
    if (index < 0) continue;
    report.flaggedLines += 1;
    let event: CurrencySweepEventV1;
    try { event = JSON.parse(line.slice(index + PREFIX.length).trim()) as CurrencySweepEventV1; }
    catch { report.invalidLines += 1; continue; }
    if (event?.schema !== "spmt.currency-source.v1" || typeof event.sourceId !== "string" ||
        !["GP", "SP", "XP"].includes(event.currency) || !Number.isSafeInteger(event.delta) ||
        !VALID_OPERATIONS.has(event.operation as CurrencyOperationV1)) {
      report.invalidLines += 1; continue;
    }
    const registeredSource = SOURCE_BY_ID.get(event.sourceId);
    if (!registeredSource) {
      report.unknownSources.push(event.sourceId);
      continue;
    }
    if (registeredSource.currency !== event.currency) {
      report.invalidLines += 1;
      continue;
    }
    if (event.duplicate) { report.duplicateEvents += 1; continue; }
    report.acceptedEvents += 1;
    const source = report.bySource[event.sourceId] ??= { currency: event.currency, ...emptyTotals() };
    const currency = report.byCurrency[event.currency];
    for (const totals of [source, currency]) {
      totals.events += 1;
      if (event.delta > 0) totals.positiveUnits += event.delta;
      if (event.delta < 0) totals.negativeUnits += Math.abs(event.delta);
      totals.netDelta += event.delta;
    }
  }
  report.unknownSources = [...new Set(report.unknownSources)];
  return report;
}
