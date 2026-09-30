import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferRepo, reconcileInterruptedCodexJobs } from "../src/publicCodexFixer.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Stella Coder repository routing", () => {
  it("honors the explicit app even when the task mentions another ecosystem service", () => {
    expect(inferRepo({
      appName: "streamweaver-new",
      description: "Keep built-in SPMT Qwen as the StreamWeaver default",
    }).id).toBe("streamweaver");
  });

  it("falls back to description inference when no known app is supplied", () => {
    expect(inferRepo({ description: "Repair spmt.live OAuth" }).id).toBe("spmt-live");
  });
});


describe("Stella Coder restart reconciliation", () => {
  it("marks queued and running jobs failed after restart without touching completed jobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotator-codex-reconcile-"));
    cleanup.push(root);
    const jobsDir = join(root, "jobs");
    await mkdir(jobsDir, { recursive: true });
    const base = {
      createdAt: "2026-09-30T14:00:00.000Z",
      updatedAt: "2026-09-30T14:01:00.000Z",
      source: "test",
      reporter: "test",
      appName: "hearmeout-main",
      repoId: "hearmeout",
      description: "test",
      changedFiles: [],
      checks: [],
    };
    await writeFile(join(jobsDir, "running.json"), JSON.stringify({ ...base, id: "mtfix_running_1234", status: "running" }));
    await writeFile(join(jobsDir, "queued.json"), JSON.stringify({ ...base, id: "mtfix_queued_1234", status: "queued" }));
    await writeFile(join(jobsDir, "completed.json"), JSON.stringify({ ...base, id: "mtfix_done_1234", status: "completed" }));

    const count = await reconcileInterruptedCodexJobs({ CODEX_FIXER_DATA_DIR: root });
    expect(count).toBe(2);

    const running = JSON.parse(await readFile(join(jobsDir, "running.json"), "utf8"));
    const queued = JSON.parse(await readFile(join(jobsDir, "queued.json"), "utf8"));
    const completed = JSON.parse(await readFile(join(jobsDir, "completed.json"), "utf8"));
    expect(running.status).toBe("failed");
    expect(queued.status).toBe("failed");
    expect(running.error).toMatch(/interrupted by a rotator restart/i);
    expect(queued.error).toMatch(/safe to retry/i);
    expect(completed.status).toBe("completed");
  });
});
