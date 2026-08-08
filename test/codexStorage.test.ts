import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { reclaimCodexStorage } from "../src/publicCodexFixer.js";

async function exists(path: string) {
  try { await readFile(path); return true; } catch { return false; }
}

describe("Athena Coder storage lifecycle", () => {
  it("removes rebuildable checkouts while retaining durable job records", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-storage-"));
    const work = await mkdtemp(join(tmpdir(), "codex-work-"));
    const env = { CODEX_FIXER_DATA_DIR: root, CODEX_FIXER_WORK_DIR: work };
    await mkdir(join(root, "references", "streamweaver"), { recursive: true });
    await mkdir(join(root, "tmp"), { recursive: true });
    await mkdir(join(root, "jobs"), { recursive: true });

    const jobs = [
      { id: "failed_job_1", status: "failed", changedFiles: ["a.ts"] },
      { id: "empty_job_12", status: "completed", changedFiles: [] },
      { id: "ready_job_12", status: "completed", changedFiles: ["a.ts"] },
      { id: "published_12", status: "completed", changedFiles: ["a.ts"], pullRequest: { number: 1 } },
    ];
    for (const job of jobs) {
      await mkdir(join(work, "sandboxes", job.id), { recursive: true });
      await writeFile(join(work, "sandboxes", job.id, "marker"), "x");
      await writeFile(join(root, "jobs", `${job.id}.json`), JSON.stringify(job));
    }

    await reclaimCodexStorage(env);

    expect(await exists(join(root, "references", "streamweaver"))).toBe(false);
    expect(await exists(join(root, "tmp"))).toBe(false);
    expect(await exists(join(work, "sandboxes", "failed_job_1", "marker"))).toBe(false);
    expect(await exists(join(work, "sandboxes", "empty_job_12", "marker"))).toBe(false);
    expect(await exists(join(work, "sandboxes", "published_12", "marker"))).toBe(false);
    expect(await exists(join(work, "sandboxes", "ready_job_12", "marker"))).toBe(false);
    expect(await exists(join(root, "jobs", "ready_job_12.json"))).toBe(true);
  });
});
