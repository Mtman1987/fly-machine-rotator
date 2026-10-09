import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "nats";
import { isLogMonitorEcho, looksLikeError, runLogMonitor } from "../src/logMonitor.js";

vi.mock("nats", () => ({ connect: vi.fn(), StringCodec: () => ({ decode: (data: string) => data }) }));

describe("log monitor feedback prevention", () => {
  it("ignores its own observation and report echoes even when the original message is an expected response", () => {
    expect(isLogMonitorEcho("mtman-machine-rotator", 'observed streamweaver-new 648829c0f79a46e8 [unknown]: error')).toBe(true);
    expect(isLogMonitorEcho("mtman-machine-rotator", 'observed mtman-machine-rotator 648829c0f79a46e8 [unknown]: observed other 648829c0f79a46e8 [unknown]: failed')).toBe(true);
    expect(isLogMonitorEcho("mtman-machine-rotator", 'reported chat-tag-new 648829c0f79a46e8: failed')).toBe(true);
    expect(isLogMonitorEcho("mtman-machine-rotator", 'observed chat-tag-new 648829c0f79a46e8 [transient_external]: Health check failed.')).toBe(true);
  });
  it("keeps original incidents and real monitor failures", () => {
    expect(isLogMonitorEcho("streamweaver-new", 'observed streamweaver-new 648829c0f79a46e8 [unknown]: error')).toBe(false);
    expect(isLogMonitorEcho("mtman-machine-rotator", "SPMT Companion diagnostics delivery failed (403)")).toBe(false);
    expect(isLogMonitorEcho("mtman-machine-rotator", "Log monitor failed to reload dedupe state")).toBe(false);
  });
  it("does not classify the explicit healthy bot-authentication notice as an error", () => {
    expect(looksLikeError("[Bot] Twitch chat uses the authorized bot account via TMI.js. Optional EventSub integration is off; this is not a bot authentication error.")).toBe(false);
    expect(looksLikeError("[Bot] Twitch authentication error: Invalid refresh token")).toBe(true);
  });
});
it("does not persist or emit a fresh recursive echo received from Fly", async () => {
  const root = await mkdtemp(join(tmpdir(), "rotator-echo-"));
  const log = { subject: "logs.mtman-machine-rotator.ord.machine", data: JSON.stringify({ message: 'observed chat-tag-new 648829c0f79a46e8 [transient_external]: Health check \'servicecheck-00-http-3000\' on port 3000 has failed. Your app is not responding properly. Services exposed on ports [80, 443] will have intermittent failures until the health check passes.' }) };
  vi.mocked(connect).mockResolvedValue({ subscribe: () => (async function* () { yield log; })(), isClosed: () => false, close: async () => {} } as any);
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    await expect(runLogMonitor({ appNames: ["mtman-machine-rotator"], token: "test", orgSlug: "test", dedupeFile: join(root,"dedupe.json"), historyFile: join(root,"history.json"), observationFile: join(root,"observations.json"), reportMessageFile: join(root,"report.json"), contextLines: 8, pollIntervalMs: 1000, sampleDurationMs: 1000 })).rejects.toThrow("subscription ended unexpectedly");
    await expect(readFile(join(root,"observations.json"),"utf8")).rejects.toMatchObject({code:"ENOENT"});
    expect(output.mock.calls.some(([line]) => String(line).startsWith("observed "))).toBe(false);
  } finally { output.mockRestore(); await rm(root,{recursive:true,force:true}); }
});
