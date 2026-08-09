import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { triggerAthenaForIncident } from "../src/athenaIncidentTrigger.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Athena incident rotation cooldown", () => {
  it("fires once per incident per rotation and becomes eligible after the next rotation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "athena-attempts-"));
    directories.push(directory);
    const runtimeFile = join(directory, "runtime.json");
    const attemptsFile = join(directory, "attempts.json");
    const env = {
      ROTATOR_RUNTIME_STATE_FILE: runtimeFile,
      ROTATOR_ATHENA_ATTEMPTS_FILE: attemptsFile,
      ROTATOR_DASHBOARD_ACTION_TOKEN: "test-action-token",
      ROTATOR_INTERNAL_DASHBOARD_PORT: "9999"
    };
    const event = { appName: "example-app", fingerprint: "same-error" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, message: "generated" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await writeFile(runtimeFile, JSON.stringify({ currentStatus: "success", totalRuns: 1, updatedAt: "2026-08-09T00:00:00Z", lastStartedAt: "rotation-1", lastRunLines: [] }));

    await expect(triggerAthenaForIncident(event, env, Date.parse("2026-08-09T01:00:00Z"))).resolves.toMatchObject({ triggered: true });
    await expect(triggerAthenaForIncident(event, env, Date.parse("2026-08-09T02:00:00Z"))).resolves.toMatchObject({ triggered: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await writeFile(runtimeFile, JSON.stringify({ currentStatus: "success", totalRuns: 2, updatedAt: "2026-08-09T12:00:00Z", lastStartedAt: "rotation-2", lastRunLines: [] }));
    await expect(triggerAthenaForIncident(event, env, Date.parse("2026-08-09T13:00:00Z"))).resolves.toMatchObject({ triggered: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
