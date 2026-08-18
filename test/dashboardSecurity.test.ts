import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDashboardServer } from "../src/dashboardServer.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("rotator protected error baseline", () => {
  it("requires outside authorization, permits trusted loopback work, redacts reports, archives state, and starts at zero", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rotator-dashboard-security-"));
    tempDirs.push(directory);
    const historyFile = join(directory, "error-history.json");
    const dedupeFile = join(directory, "error-fingerprints.json");
    const fixesFile = join(directory, "fix-proposals.json");
    const ignoreFile = join(directory, "ignore-rules.json");
    const baselineFile = join(directory, "error-baseline.json");
    const archives = join(directory, "archives");
    const sensitiveValue = "synthetic-sensitive-value-for-redaction";
    await writeFile(historyFile, JSON.stringify([{
      recordedAt: new Date().toISOString(), appName: "hmo-dj-worker", fingerprint: "one",
      message: `wss://example.invalid/rtc?access_token=${sensitiveValue}&join=1`, suggestion: "retry", context: [],
    }]));
    await writeFile(dedupeFile, JSON.stringify([{ fingerprint: "one", reportedAt: new Date().toISOString() }]));
    await writeFile(fixesFile, JSON.stringify([{ id: "one", appName: "hmo-dj-worker", fingerprint: "one", status: "generated", updatedAt: new Date().toISOString(), changes: [], attempts: [] }]));
    await writeFile(ignoreFile, "[]");

    const server = startDashboardServer({
      NODE_ENV: "test", PORT: "0",
      FLY_API_TOKEN: "placeholder-for-test-config",
      LOG_ERROR_HISTORY_FILE: historyFile, LOG_ERROR_DEDUPE_FILE: dedupeFile,
      ROTATOR_FIXES_FILE: fixesFile, ROTATOR_IGNORE_RULES_FILE: ignoreFile,
      ROTATOR_ERROR_ARCHIVE_DIR: archives, ROTATOR_ERROR_BASELINE_FILE: baselineFile,
      ROTATOR_RUNTIME_STATE_FILE: join(directory, "runtime-state.json"),
      ROTATION_HISTORY_FILE: join(directory, "rotation-history.json"),
      DISCORD_REPORT_MESSAGE_FILE: join(directory, "discord-report.json"),
      FLY_ROTATOR_APPS: "test-app",
    });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("dashboard did not bind a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const internalHeaders = { "x-rotator-internal": "same-process" };

    try {
      expect((await fetch(`${baseUrl}/logs/errors.txt`)).status).toBe(401);
      expect((await fetch(`${baseUrl}/logs/errors.txt`, { headers: { "x-rotator-action-token": "retired" } })).status).toBe(401);

      const report = await fetch(`${baseUrl}/logs/errors.txt`, { headers: internalHeaders });
      expect(report.status).toBe(200);
      const reportText = await report.text();
      expect(reportText).not.toContain(sensitiveValue);
      expect(reportText).toContain("access_token=[REDACTED]");

      const clear = await fetch(`${baseUrl}/actions/errors/clear`, { method: "POST", headers: internalHeaders });
      expect(clear.status).toBe(200);
      expect(JSON.parse(await readFile(historyFile, "utf8"))).toEqual([]);
      expect(JSON.parse(await readFile(dedupeFile, "utf8"))).toEqual([]);
      expect(JSON.parse(await readFile(fixesFile, "utf8"))).toEqual([]);
      const baseline = JSON.parse(await readFile(baselineFile, "utf8"));
      expect(baseline).toMatchObject({ clearedEvents: 1, clearedProposals: 1 });
      const archived = await readFile(join(baseline.archiveDir, "error-history.redacted.json"), "utf8");
      expect(archived).not.toContain(sensitiveValue);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
