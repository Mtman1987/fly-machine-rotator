import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateRepoFileChanges } from "../src/repoOps.js";

describe("validateRepoFileChanges", () => {
  it("rejects path traversal", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rotator-repo-"));
    await expect(validateRepoFileChanges(repo, [{ path: "../outside.ts", content: "x\n" }]))
      .rejects
      .toThrow(/outside repo/);
  });

  it("rejects likely truncated rewrites", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rotator-repo-"));
    const file = join(repo, "large.ts");
    await writeFile(file, Array.from({ length: 130 }, (_, index) => `const value${index} = ${index};`).join("\n"));

    await expect(validateRepoFileChanges(repo, [{ path: "large.ts", content: "const value = 1;\n" }]))
      .rejects
      .toThrow(/truncated/);
  });
});
