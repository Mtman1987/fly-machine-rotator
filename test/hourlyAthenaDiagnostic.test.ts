import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { notifyOwner, runHourlyAthenaDiagnostic } from "../src/hourlyAthenaDiagnostic.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("hourly Athena diagnostic", () => {
  it.each([401, 500])("reports a rejected owner notification (HTTP %s)", async status => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("private upstream body", { status })));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await notifyOwner({ SPMT_API_KEY: "private-test-key" }, { message: "private notification" });
    expect(logged).toHaveBeenCalledWith(`Hourly repair notification failed: owner-dm HTTP ${status}`);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private/);
  });
  it("reports network and missing-credential failures without logging secrets", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("private-test-key")));
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await notifyOwner({ SPMT_API_KEY: "private-test-key" }, { message: "private notification" });
    await notifyOwner({}, { message: "private notification" });
    expect(logged).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(logged.mock.calls)).not.toMatch(/private/);
  });
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
