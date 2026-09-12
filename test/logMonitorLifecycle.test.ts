import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect } from "nats";
import { runLogMonitor } from "../src/logMonitor.js";

vi.mock("nats", () => ({ connect: vi.fn(), StringCodec: () => ({ decode: () => "" }) }));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("log monitor lifecycle", () => {
  it.each([false, true])("rejects a terminated subscription and releases the connection (closed=%s)", async closed => {
    const directory = await mkdtemp(join(tmpdir(), "rotator-lifecycle-"));
    directories.push(directory);
    const failure = new Error("NATS reconnects exhausted");
    const connection = {
      subscribe: () => (async function* () {})(),
      close: vi.fn().mockResolvedValue(undefined),
      isClosed: () => closed,
      closed: () => Promise.resolve(failure),
    };
    vi.mocked(connect).mockResolvedValue(connection as any);
    await expect(runLogMonitor({
      appNames: ["apollo"], token: "test", orgSlug: "test",
      dedupeFile: join(directory, "dedupe.json"), historyFile: join(directory, "history.json"),
      observationFile: join(directory, "observations.json"), reportMessageFile: join(directory, "report.json"),
      baselineFile: join(directory, "baseline.json"), contextLines: 8, pollIntervalMs: 1000, sampleDurationMs: 1000,
    })).rejects.toThrow(closed ? failure.message : "subscription ended unexpectedly");
    expect(connection.close).toHaveBeenCalledOnce();
  });
});
