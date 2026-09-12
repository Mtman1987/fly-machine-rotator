import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeTrackedRotation } from "../src/rotationControl.js";
import { runRotationOnce } from "../src/rotationRunner.js";

vi.mock("../src/config.js", () => ({ loadConfig: () => ({}) }));
vi.mock("../src/discord.js", () => ({ sendDiscordReport: vi.fn() }));
vi.mock("../src/rotationRunner.js", () => ({ runRotationOnce: vi.fn() }));
vi.mock("../src/runtimeState.js", () => ({
  getRuntimeStateFile: () => "unused",
  RotatorRuntimeStateStore: { load: async () => ({ markRunning: vi.fn(), markFinished: vi.fn(), markCrashed: vi.fn() }) },
}));
beforeEach(() => vi.clearAllMocks());

describe("tracked rotation concurrency", () => {
  it("shares an active run but starts a fresh run after completion", async () => {
    let finish!: (results: []) => void;
    vi.mocked(runRotationOnce).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValue([]);
    const first = executeTrackedRotation();
    const overlapping = executeTrackedRotation();
    await vi.waitFor(() => expect(runRotationOnce).toHaveBeenCalledTimes(1));
    finish([]);
    await Promise.all([first, overlapping]);
    await executeTrackedRotation();
    expect(runRotationOnce).toHaveBeenCalledTimes(2);
  });
  it("releases a failed run so the next attempt can recover", async () => {
    vi.mocked(runRotationOnce).mockRejectedValueOnce(new Error("temporary failure")).mockResolvedValue([]);
    await expect(executeTrackedRotation()).rejects.toThrow("temporary failure");
    await expect(executeTrackedRotation()).resolves.toEqual([]);
    expect(runRotationOnce).toHaveBeenCalledTimes(2);
  });
});
