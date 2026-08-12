import { afterEach, describe, expect, it, vi } from "vitest";
import { isDshMtFixItAuthorized, mapDshMtFixItWorkerPath } from "../src/dshMtFixitGateway.js";

afterEach(() => vi.unstubAllGlobals());

describe("DSH mtfixit gateway", () => {
  it("requires a scoped SPMT client-credentials token for Discord Stream Hub", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ client_id: "discord-stream-hub", token_use: "client_credentials", scopes: ["athena:write"] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const request = { headers: { authorization: "Bearer service-token" } } as any;
    await expect(isDshMtFixItAuthorized(request, { SPMT_BASE_URL: "https://spmt.live" })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://spmt.live/api/oauth/serviceinfo",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer service-token" }) }),
    );
  });

  it("rejects the wrong service client or missing scope", async () => {
    const request = { headers: { authorization: "Bearer service-token" } } as any;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ client_id: "chat-tag", token_use: "client_credentials", scopes: ["athena:write"] }) }));
    await expect(isDshMtFixItAuthorized(request, {})).resolves.toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ client_id: "discord-stream-hub", token_use: "client_credentials", scopes: ["discord:control"] }) }));
    await expect(isDshMtFixItAuthorized(request, {})).resolves.toBe(false);
  });

  it("maps only create and single-job read operations", () => {
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs")).toBe("/api/codex/jobs");
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234", "?view=status")).toBe("/api/codex/jobs/mtfix_12345678_abcd1234?view=status");
  });

  it("does not expose list, artifact, or publish routes", () => {
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs")).toBeNull();
    expect(mapDshMtFixItWorkerPath("POST", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/publish")).toBeNull();
    expect(mapDshMtFixItWorkerPath("GET", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234/diff")).toBeNull();
    expect(mapDshMtFixItWorkerPath("DELETE", "/api/dsh/mtfixit/jobs/mtfix_12345678_abcd1234")).toBeNull();
  });
});
