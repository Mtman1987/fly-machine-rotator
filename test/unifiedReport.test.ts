import { describe, expect, it } from "vitest";
import { buildUnifiedPayload } from "../src/unifiedReport.js";
import { RotatorRuntimeState } from "../src/runtimeState.js";

describe("buildUnifiedPayload", () => {
  it("includes the dashboard link, latest rotation lines, schedule metadata, and per-app error totals", () => {
    const now = Date.now();
    const recentOne = new Date(now - 10 * 60 * 1000).toISOString();
    const recentTwo = new Date(now - 9 * 60 * 1000).toISOString();

    const payload = buildUnifiedPayload(
      [
        {
          at: "2026-06-12T08:00:00.000Z",
          finishedAt: "2026-06-12T08:00:00.000Z",
          results: [
            {
              appName: "chat-tag-bot-new",
              success: true,
              mode: "handoff",
              from: "old-machine",
              to: "new-machine",
              warnings: 1
            }
          ]
        }
      ],
      [
        {
          recordedAt: recentOne,
          appName: "chat-tag-bot-new",
          fingerprint: "cf84a00931ba772c",
          machineId: "d8de509a926548",
          region: "iad",
          timestamp: recentOne,
          message: '[Bot] Tag API response: {"error":"You are not it! mamafeisty is it.","ok":false,"status":400}',
          suggestion: "Expected gameplay response.",
          context: []
        },
        {
          recordedAt: recentTwo,
          appName: "streamweaver-new",
          fingerprint: "aabbccddeeff0011",
          machineId: "streamweaver-machine",
          region: "ord",
          timestamp: recentTwo,
          message: "[09:27] error: Login authentication failed",
          suggestion: "Refresh the Twitch token.",
          context: []
        }
      ],
      runtimeState(),
      undefined,
      "https://mtman-machine-rotator.fly.dev/"
    ) as {
      embeds: Array<{
        title: string;
        url?: string;
        description: string;
        fields: Array<{ name: string; value: string }>;
        footer?: { text?: string };
      }>;
    };

    expect((payload as { avatar_url?: string }).avatar_url).toBe("https://mtman-machine-rotator.fly.dev/brand/avatar.png");
    const embed = payload.embeds[0];
    expect(embed.title).toBe("Open rotator dashboard");
    expect(embed.url).toBe("https://mtman-machine-rotator.fly.dev/");
    expect(embed.description).toContain("ok=1 failed=0 handoffs=1 restarts=0");
    expect((embed as { thumbnail?: { url?: string } }).thumbnail?.url).toBe("https://mtman-machine-rotator.fly.dev/brand/logo.png");
    expect(embed.fields[0]?.name).toBe("Status");
    expect(embed.fields[0]?.value).toContain("Latest run: success");
    expect(embed.fields[0]?.value).toContain("Total runs: 14");
    expect(embed.fields[1]?.name).toBe("Rotation");
    expect(embed.fields[1]?.value).toContain("chat-tag-bot-new");
    expect(embed.fields[1]?.value).toContain("handoff");
    expect(embed.fields[2]?.name).toBe("\u200b");
    expect((embed.fields[2] as { inline?: boolean }).inline).toBe(true);
    expect(embed.fields[3]?.name).toBe("24h Failure Totals");
    expect(embed.fields[3]?.value).toContain("chat-tag-bot-new: 1");
    expect(embed.fields[3]?.value).toContain("streamweaver-new: 1");
    expect(embed.fields[4]?.name).toBe("Notes");
    expect(embed.fields[4]?.value).toContain("1 handoffs");
    expect(embed.footer?.text).toContain("rotation start");
    expect(embed.footer?.text).toContain("last finished");
  });

  it("falls back to rotation history timestamps and count when runtime state is incomplete", () => {
    const payload = buildUnifiedPayload(
      [
        {
          at: "2026-06-13T00:32:19.263Z",
          startedAt: "2026-06-13T00:31:40.000Z",
          finishedAt: "2026-06-13T00:32:19.263Z",
          results: [
            {
              appName: "chat-tag-new",
              success: true,
              mode: "restart",
              warnings: 0
            }
          ]
        }
      ],
      [],
      {
        updatedAt: "2026-06-13T00:32:20.000Z",
        totalRuns: 0,
        currentStatus: "idle",
        lastRunLines: []
      },
      undefined,
      "https://mtman-machine-rotator.fly.dev/"
    ) as {
      embeds: Array<{
        fields: Array<{ name: string; value: string }>;
        footer?: { text?: string };
      }>;
    };

    const embed = payload.embeds[0];
    expect(embed.fields[0]?.value).toContain("Started: 06/13/2026 00:31 UTC");
    expect(embed.fields[0]?.value).toContain("Finished: 06/13/2026 00:32 UTC");
    expect(embed.fields[0]?.value).toContain("Total runs: 1");
    expect(embed.footer?.text).toContain("rotation start 06/13/2026 00:31 UTC");
    expect(embed.footer?.text).toContain("last finished 06/13/2026 00:32 UTC");
  });
});

function runtimeState(): RotatorRuntimeState {
  return {
    updatedAt: "2026-06-12T08:00:30.000Z",
    totalRuns: 14,
    currentStatus: "success",
    lastTrigger: "auto",
    lastStartedAt: "2026-06-12T08:00:00.000Z",
    lastFinishedAt: "2026-06-12T08:00:30.000Z",
    lastDurationMs: 30000,
    nextRunAt: "2026-06-12T20:00:00.000Z",
    lastRunLines: ["OK chat-tag-bot-new handoff: old-machine -> new-machine warn=1"]
  };
}
