import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startAutoRotationLoop } from "../src/autoRotate.js";
import { executeTrackedRotation, FAILURE_RETRY_MS, SUCCESS_INTERVAL_MS } from "../src/rotationControl.js";

vi.mock("node:fs/promises", () => ({ readFile: async () => "[]" }));
vi.mock("../src/rotationControl.js", () => ({ executeTrackedRotation: vi.fn(), FAILURE_RETRY_MS: 3_600_000, SUCCESS_INTERVAL_MS: 43_200_000 }));
vi.mock("../src/runtimeState.js", () => ({
  getRuntimeStateFile: () => "unused",
  RotatorRuntimeStateStore: { load: async () => ({ setNextRunAt: vi.fn() }) },
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("automatic rotation backoff without written history", () => {
  it.each(["success", "failed-result", "exception"])("waits for the correct next deadline after %s", async outcome => {
    if (outcome === "exception") vi.mocked(executeTrackedRotation).mockRejectedValue(new Error("temporary failure"));
    else vi.mocked(executeTrackedRotation).mockResolvedValue(outcome === "success" ? [] : [{ success: false } as any]);
    void startAutoRotationLoop([], {});
    await vi.advanceTimersByTimeAsync(0);
    expect(executeTrackedRotation).toHaveBeenCalledTimes(1);
    const interval = outcome === "success" ? SUCCESS_INTERVAL_MS : FAILURE_RETRY_MS;
    await vi.advanceTimersByTimeAsync(interval - 1);
    expect(executeTrackedRotation).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(executeTrackedRotation).toHaveBeenCalledTimes(2);
  });
});
