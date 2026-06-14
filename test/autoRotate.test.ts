import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { getNextRotationDelayMs, readLatestRotationAt } from "../src/autoRotate.js";

describe("autoRotate", () => {
  it("runs immediately when no rotation history exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-auto-"));
    const historyFile = join(dir, "rotation-history.json");

    await expect(getNextRotationDelayMs(historyFile, Date.parse("2026-06-08T12:00:00Z"))).resolves.toBe(0);
  });

  it("waits until twelve hours after the latest successful rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-auto-"));
    const historyFile = join(dir, "rotation-history.json");
    await writeFile(historyFile, JSON.stringify([
      { at: "2026-06-08T00:00:00Z" },
      { at: "2026-06-08T06:00:00Z" }
    ]));

    await expect(getNextRotationDelayMs(historyFile, Date.parse("2026-06-08T12:00:00Z"))).resolves.toBe(6 * 60 * 60 * 1000);
    await expect(readLatestRotationAt(historyFile)).resolves.toBe(Date.parse("2026-06-08T06:00:00Z"));
  });
});
