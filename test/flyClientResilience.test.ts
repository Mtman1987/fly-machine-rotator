import { afterEach, describe, expect, it, vi } from "vitest";
import { FlyApiClient } from "../src/flyClient.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Fly API bounded retry and pacing", () => {
  it("reserves distinct slots for concurrent requests", async () => {
    vi.useFakeTimers();
    const times: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => { times.push(Date.now()); return new Response("[]"); }));
    const client = new FlyApiClient({ token: "test", minIntervalMs: 100 });
    const calls = Promise.all([client.listMachines("app"), client.listMachines("app"), client.listMachines("app")]);
    await vi.advanceTimersByTimeAsync(200);
    await calls;
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBe(100);
    expect(times[2] - times[1]).toBe(100);
  });
  it("retries a transient read failure with a deadline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("socket lost")).mockResolvedValueOnce(new Response("[]"));
    vi.stubGlobal("fetch", fetcher);
    const pending = new FlyApiClient({ token: "test", minIntervalMs: 0, maxRetries: 1 }).listMachines("app");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
  });
  it("does not repeat an ambiguous machine creation", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("socket lost after write"));
    vi.stubGlobal("fetch", fetcher);
    await expect(new FlyApiClient({ token: "test", minIntervalMs: 0 }).createMachine("app", { config: {} } as any))
      .rejects.toThrow("network_or_timeout");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not repeat machine creation after an ambiguous 503", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("sensitive upstream body", { status: 503 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(new FlyApiClient({ token: "test", minIntervalMs: 0 }).createMachine("app", { config: {} } as any))
      .rejects.toThrow("failed with 503");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("retries explicitly rejected rate and lease conflicts within a bound", async () => {
    for (const status of [409, 429]) {
      const fetcher = vi.fn().mockResolvedValueOnce(new Response("rejected", { status, headers: { "retry-after": "0" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: { nonce: "test-lease" } })));
      vi.stubGlobal("fetch", fetcher);
      const result = await new FlyApiClient({ token: "test", minIntervalMs: 0, maxRetries: 1 }).createLease("app", "machine", 30, "test");
      expect(result.nonce).toBe("test-lease");
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });
  it("returns permanent authentication failure once without provider response content", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("secret upstream detail", { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const pending = new FlyApiClient({ token: "test", minIntervalMs: 0 }).listMachines("app");
    await expect(pending).rejects.toThrow("failed with 401");
    await expect(pending).rejects.not.toThrow("secret");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
