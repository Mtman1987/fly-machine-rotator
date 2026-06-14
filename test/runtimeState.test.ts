import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RotatorRuntimeStateStore } from "../src/runtimeState.js";

describe("RotatorRuntimeStateStore", () => {
  it("preserves finished run metadata when only nextRunAt is updated from a stale store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-runtime-"));
    const stateFile = join(dir, "runtime-state.json");

    await writeFile(stateFile, JSON.stringify({
      updatedAt: "2026-06-14T10:36:50.387Z",
      totalRuns: 1,
      currentStatus: "success",
      lastTrigger: "dashboard",
      lastStartedAt: "2026-06-14T10:35:20.000Z",
      lastFinishedAt: "2026-06-14T10:36:50.387Z",
      lastDurationMs: 90387,
      nextRunAt: "2026-06-14T22:36:50.387Z",
      lastRunLines: ["OK chat-tag-bot-new handoff: old -> new"]
    }, null, 2));

    const staleStore = await RotatorRuntimeStateStore.load(stateFile);
    await writeFile(stateFile, JSON.stringify({
      updatedAt: "2026-06-14T10:36:50.387Z",
      totalRuns: 2,
      currentStatus: "success",
      lastTrigger: "auto",
      lastStartedAt: "2026-06-14T10:35:20.000Z",
      lastFinishedAt: "2026-06-14T10:36:50.387Z",
      lastDurationMs: 90387,
      nextRunAt: "2026-06-14T22:36:50.387Z",
      lastRunLines: ["OK dsh-clip-worker handoff: old -> new"]
    }, null, 2));

    await staleStore.setNextRunAt("2026-06-15T00:00:00.000Z");

    const saved = JSON.parse(await readFile(stateFile, "utf8")) as {
      totalRuns: number;
      currentStatus: string;
      lastTrigger?: string;
      lastStartedAt?: string;
      lastFinishedAt?: string;
      lastDurationMs?: number;
      nextRunAt?: string;
      lastRunLines: string[];
    };

    expect(saved.totalRuns).toBe(2);
    expect(saved.currentStatus).toBe("success");
    expect(saved.lastTrigger).toBe("auto");
    expect(saved.lastStartedAt).toBe("2026-06-14T10:35:20.000Z");
    expect(saved.lastFinishedAt).toBe("2026-06-14T10:36:50.387Z");
    expect(saved.lastDurationMs).toBe(90387);
    expect(saved.nextRunAt).toBe("2026-06-15T00:00:00.000Z");
    expect(saved.lastRunLines).toEqual(["OK dsh-clip-worker handoff: old -> new"]);
  });
});
