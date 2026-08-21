import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runHourlyAthenaDiagnostic } from "../src/hourlyAthenaDiagnostic.js";

describe("hourly Athena diagnostic", () => {
  it("records a bounded no-op cycle when only non-actionable transport health noise exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "hourly-athena-"));
    const history = join(root, "errors.json");
    const cycles = join(root, "cycles.json");
    await writeFile(history, JSON.stringify([{
      recordedAt: "2026-08-21T06:45:00.000Z",
      appName: "streamweaver-new",
      fingerprint: "health-transition-1",
      message: "health check has failed app is not responding properly",
      suggestion: "observe recovery",
      context: [],
    }]));

    const result = await runHourlyAthenaDiagnostic({
      ...process.env,
      LOG_ERROR_HISTORY_FILE: history,
      HOURLY_REPAIR_CYCLES_FILE: cycles,
      HOURLY_REPAIR_NOTIFY_MODE: "log-only",
    }, new Date("2026-08-21T06:50:00.000Z"));

    expect(result.status).toBe("no-actionable-incident");
    expect(result.summary).toMatch(/No new auto-fix-eligible incident/i);
    const stored = JSON.parse(await readFile(cycles, "utf8"));
    expect(stored).toHaveLength(1);
    expect(stored[0].status).toBe("no-actionable-incident");
  });
});
