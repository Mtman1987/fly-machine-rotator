import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCoderResult, inferRepo, reconcileInterruptedCodexJobs } from "../src/publicCodexFixer.js";
import { execFileSync } from "node:child_process";

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


describe("Stella Coder patch rejection recovery", () => {
  it("preserves malformed candidate and validation diagnostics for a bounded correction attempt", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotator-codex-patch-reject-"));
    cleanup.push(root);
    const repo = join(root, "repo");
    const data = join(root, "data");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    await writeFile(join(repo, "sample.txt"), "original\n");
    execFileSync("git", ["add", "sample.txt"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "base"], { cwd: repo });

    await expect(applyCoderResult(
      { summary: "candidate", patch: "this is not a unified diff\n" },
      repo,
      { CODEX_FIXER_DATA_DIR: data },
      "mtfix_test_1234",
      1,
    )).rejects.toThrow(/PATCH_VALIDATION_REJECTED/);

    const rejected = join(data, "jobs", "mtfix_test_1234", "rejected-patches");
    expect(await readFile(join(rejected, "attempt-1.patch"), "utf8")).toContain("not a unified diff");
    expect(await readFile(join(rejected, "attempt-1.diagnostic.txt"), "utf8")).toMatch(/Patch validation rejected|corrupt patch|No valid patches/i);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" })).toBe("");
  });
});
