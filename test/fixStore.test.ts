import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FixStore } from "../src/fixStore.js";

describe("FixStore", () => {
  it("normalizes legacy records without attempts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fix-store-"));
    const file = join(dir, "fixes.json");
    await writeFile(file, JSON.stringify([
      {
        id: "app::fingerprint",
        appName: "app",
        fingerprint: "fingerprint",
        status: "error",
        updatedAt: "2026-06-14T00:00:00.000Z",
        changes: []
      }
    ], null, 2));

    const store = await FixStore.load(file);
    expect(store.get("app::fingerprint")?.attempts).toEqual([]);
  });
});
