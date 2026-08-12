import { afterEach, describe, expect, it, vi } from "vitest";
import { getManagedFlyApps, getManagedFlyAppStates } from "../src/flyObservability.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Fly observability", () => {
  it("uses only the configured managed app allowlist", () => {
    expect(getManagedFlyApps({ FLY_ROTATOR_APPS: "streamweaver-new,spmt-live,streamweaver-new" })).toEqual([
      "streamweaver-new",
      "spmt-live",
    ]);
  });

  it("returns sanitized Machine state without config, private IP, or token values", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      {
        id: "machine-1",
        name: "app-blue",
        state: "started",
        region: "ord",
        private_ip: "fdaa::secret",
        config: { env: { SUPER_SECRET: "do-not-return" } },
        checks: { web: { name: "web", status: "passing", output: "ok", updated_at: "2026-08-12T00:00:00Z" } },
        created_at: "2026-08-11T00:00:00Z",
        updated_at: "2026-08-12T00:00:00Z",
      },
    ]), { status: 200 }));

    const result = await getManagedFlyAppStates({
      FLY_ROTATOR_APPS: "streamweaver-new",
      FLY_API_TOKEN: "fly-token-that-must-not-leak",
      FLY_API_HOSTNAME: "https://api.machines.dev",
      API_MIN_INTERVAL_MS: "1",
      API_MAX_RETRIES: "1",
      FLY_ORG: "mtman-new",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.apps).toHaveLength(1);
    const app = result.apps[0] as any;
    expect(app.status).toBe("running");
    expect(app.machines[0]).toMatchObject({ id: "machine-1", name: "app-blue", state: "started", region: "ord" });
    expect(app.machines[0]).not.toHaveProperty("private_ip");
    expect(app.machines[0]).not.toHaveProperty("config");
    expect(JSON.stringify(result)).not.toContain("fly-token-that-must-not-leak");
    expect(JSON.stringify(result)).not.toContain("do-not-return");
    expect(JSON.stringify(result)).not.toContain("fdaa::secret");
  });

  it("rejects app names outside the configured allowlist before calling Fly", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(getManagedFlyAppStates({
      FLY_ROTATOR_APPS: "streamweaver-new",
      FLY_API_TOKEN: "fly-token",
    }, "some-other-app")).rejects.toThrow(/not in the managed Fly app allowlist/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
