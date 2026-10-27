import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("MountainView mobile live-app command parity", () => {
  it("does not expose unsupported HearMeOut routes and distinguishes live-status queries", async () => {
    const source = await readFile(new URL("../mobile/App.tsx", import.meta.url), "utf8");

    for (const unsupported of [
      "cmd_hearmeout_voice_peers",
      "cmd_hearmeout_watch_request",
      "cmd_hearmeout_watch_control",
    ]) {
      expect(source, unsupported).not.toContain(unsupported);
    }

    expect(source).toContain("cmd_discord_live_members");
    expect(source).toContain("cmd_chat_tag_spmt_live");
    expect(source).toContain("cmd_hearmeout_song_request");
    expect(source).toContain("cmd_hearmeout_music_control");
  });
});
