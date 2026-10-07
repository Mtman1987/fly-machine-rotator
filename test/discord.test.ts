import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendDiscordReport } from "../src/discord.js";
import { AppRotationResult } from "../src/types.js";

describe("sendDiscordReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.DISCORD_ROTATION_REPORT_MESSAGE_FILE;
    delete process.env.ROTATION_HISTORY_FILE;
    delete process.env.ROTATOR_EVIDENCE_DIR;
    delete process.env.DISCORD_UNIFIED_REPORT_MESSAGE_FILE;
  });

  it("reposts the rolling message when Discord refuses edits to an old message", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rotator-discord-"));
    const stateFile = join(dir, "rotation-report.json");
    const historyFile = join(dir, "rotation-history.json");
    process.env.DISCORD_ROTATION_REPORT_MESSAGE_FILE = stateFile;
    process.env.DISCORD_UNIFIED_REPORT_MESSAGE_FILE = stateFile;
    process.env.ROTATION_HISTORY_FILE = historyFile;
    process.env.ROTATOR_EVIDENCE_DIR = join(dir,"evidence");

    await writeJson(stateFile, { messageId: "111111111111111111", updatedAt: "2026-05-19T16:08:42.562Z" });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => '{"message":"Maximum number of edits to messages older than 1 hour reached.","code":30046}'
      })
      .mockResolvedValueOnce({ ok: true, text: async () => "" })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"id":"222222222222222222"}',
        json: async () => ({ id: "222222222222222222" })
      });
    vi.stubGlobal("fetch", fetchMock);

    await sendDiscordReport("https://discord.com/api/webhooks/123/token", [result()]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://discord.com/api/webhooks/123/token/messages/111111111111111111");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PATCH" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://discord.com/api/webhooks/123/token/messages/111111111111111111");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://discord.com/api/webhooks/123/token?wait=true");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "POST" });
    const form = fetchMock.mock.calls[2]?.[1]?.body as FormData;
    const payload = JSON.parse(String(form.get("payload_json")));
    expect(payload.attachments.map((item: any) => item.filename)).toEqual(["rotator-run-readout.json", "rotator-log-snapshot.json"]);
    const evidence = JSON.parse(await (form.get("files[0]") as Blob).text());
    expect(evidence.latestRun[0].previousActiveId).toBe("old-machine");
    expect(evidence.latestRun[0].newActiveId).toBe("new-machine");
    expect(evidence.comparison).toHaveProperty("coderProposals");
    expect(JSON.parse(await readFile(historyFile,"utf8"))[0].details[0].previousActiveId).toBe("old-machine");
    await expect(readFile(stateFile, "utf8")).resolves.toContain('"messageId": "222222222222222222"');
  });
});

function result(): AppRotationResult {
  return {
    appName: "chat-tag-bot-new",
    success: true,
    previousActiveId: "old-machine",
    newActiveId: "new-machine",
    warnings: [],
    error: undefined,
    actions: [],
    before: [],
    after: [],
    dryRun: false
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2);
  await writeFile(path, text);
}
