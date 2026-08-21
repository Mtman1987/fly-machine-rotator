import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSignalHintHistory, ownerRuntimePolicy, runOwnerRotation } from "../src/ownerRuntimeOps.js";
import type { AppRotationResult } from "../src/types.js";

function rotation(appName: string, success: boolean): AppRotationResult {
  return {
    appName,
    success,
    dryRun: false,
    before: [{ id: `${appName}-old`, state: "started" }],
    after: [{ id: success ? `${appName}-new` : `${appName}-old`, state: "started" }],
    previousActiveId: `${appName}-old`,
    newActiveId: success ? `${appName}-new` : `${appName}-old`,
    actions: success ? ["rotation complete"] : ["restart attempted"],
    warnings: success ? [] : ["health check failed"],
    error: success ? undefined : "example failure",
  };
}

describe("owner runtime operations", () => {
  it("runs the existing tracked rotation executor and reports every app result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-owner-"));
    const stateFile = join(dir, "runtime-state.json");
    const env = { ROTATOR_RUNTIME_STATE_FILE: stateFile } as NodeJS.ProcessEnv;
    const result = await runOwnerRotation(env, async (_argv, passedEnv, trigger) => {
      expect(passedEnv).toBe(env);
      expect(trigger).toBe("mcp-owner");
      return [rotation("streamweaver-new", true), rotation("chat-tag-new", false)];
    });

    expect(result.ok).toBe(false);
    expect(result.appCount).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results.map((entry) => entry.appName)).toEqual(["streamweaver-new", "chat-tag-new"]);
    expect(result.results[1].error).toBe("example failure");
    expect(JSON.parse(await readFile(stateFile, "utf8").catch(() => "{}"))).toEqual({});
  });

  it("reads only the fixed StreamWeaver signal files and clamps history requests", async () => {
    const calls: string[][] = [];
    const payload = {
      schedulerEnabled: true,
      totalPosts: 7,
      uniqueChannelCount: 4,
      lastPostAt: "2026-08-21T02:00:00.000Z",
      latestPosts: [{ at: "2026-08-21T02:00:00.000Z", guildId: "g", channelId: "c", channelName: "general" }],
      scheduler: { nextAtIso: "2026-08-21T05:00:00.000Z", dueInMs: 1000 },
      historyFilePresent: true,
      schedulerFilePresent: true,
    };
    const result = await getSignalHintHistory(
      { limit: 999, appName: "evil-app", path: "/etc/passwd", command: "cat /etc/passwd" },
      { FLY_ROTATOR_APPS: "streamweaver-new,chat-tag-new", FLY_API_TOKEN: "test-token" },
      async (args) => {
        calls.push(args);
        return { stdout: `noise__SIGNAL_RUNTIME_BEGIN__${JSON.stringify(payload)}__SIGNAL_RUNTIME_END__`, stderr: "" };
      },
      async () => "stream-machine-1",
    );

    expect(result.appName).toBe("streamweaver-new");
    expect(result.machineId).toBe("stream-machine-1");
    expect(result.limit).toBe(100);
    expect(result.totalPosts).toBe(7);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("streamweaver-new");
    expect(calls[0]).not.toContain("evil-app");
    expect(calls[0]).not.toContain("/etc/passwd");
    expect(calls[0]).not.toContain("cat /etc/passwd");
    expect(calls[0].at(-1)).toBe("100");
    expect(ownerRuntimePolicy).toMatchObject({
      acceptsArbitraryApp: false,
      acceptsArbitraryPath: false,
      acceptsArbitraryCommand: false,
      maxSignalLimit: 100,
    });
  });
});
