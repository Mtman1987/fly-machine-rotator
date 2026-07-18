import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeAlreadyAppliedChanges } from "../src/aiFixer.js";

describe("repair learning reconciliation", () => {
  it("turns model patches already present in the repo into durable lessons", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rotator-repair-learning-"));
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "fixed.ts"), "export const fixed = true;\n");

    const result = await removeAlreadyAppliedChanges(repo, [
      { path: "src/fixed.ts", reason: "guard the response", content: "export const fixed = true;\r\n" },
      { path: "src/pending.ts", reason: "new repair", content: "export const pending = true;\n" },
    ]);

    expect(result.alreadyApplied).toEqual(["src/fixed.ts"]);
    expect(result.pending.map((change) => change.path)).toEqual(["src/pending.ts"]);
  });
});
