import { describe, expect, it } from "vitest";
import { scanCurrencySweepLogsV1 } from "../src/currencySweep.js";

describe("currency sweep log draft", () => {
  it("quantifies flagged GP, SP, and XP independently and ignores duplicates", () => {
    const lines = [
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"nebula.checkin.front-seat","currency":"GP","operation":"award","delta":100}',
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"streamweaver.ride.front-seat","currency":"SP","operation":"award","delta":100}',
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"spmt.xp.ledger.award","currency":"XP","operation":"award","delta":25}',
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"nebula.checkin.front-seat","currency":"GP","operation":"award","delta":100,"duplicate":true}',
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"spmt.xp.ledger.spend","currency":"XP","operation":"spend","delta":-10}',
    ];
    const report = scanCurrencySweepLogsV1(lines);
    expect(report.acceptedEvents).toBe(4);
    expect(report.duplicateEvents).toBe(1);
    expect(report.byCurrency.GP.positiveUnits).toBe(100);
    expect(report.byCurrency.SP.positiveUnits).toBe(100);
    expect(report.byCurrency.XP.positiveUnits).toBe(25);
    expect(report.byCurrency.XP.negativeUnits).toBe(10);
    expect(report.byCurrency.XP.netDelta).toBe(15);
  });

  it("marks unknown sources and malformed flagged lines instead of silently counting them", () => {
    const report = scanCurrencySweepLogsV1([
      'CURRENCY_SWEEP_V1 {"schema":"spmt.currency-source.v1","sourceId":"future.source","currency":"GP","operation":"award","delta":5}',
      "CURRENCY_SWEEP_V1 not-json",
    ]);
    expect(report.unknownSources).toEqual(["future.source"]);
    expect(report.invalidLines).toBe(1);
    expect(report.acceptedEvents).toBe(0);
  });
});
