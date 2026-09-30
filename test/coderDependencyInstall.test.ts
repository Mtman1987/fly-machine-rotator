import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureRepoDependencies } from "../src/repoOps.js";
import { getRepoConfigForApp } from "../src/repoMap.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("coder dependency setup", () => {
  it("uses deterministic cached npm installs for HearMeOut", () => {
    const repo = getRepoConfigForApp("hearmeout-main");
    expect(repo?.installCommand).toBe("npm ci --include=dev --no-audit --no-fund --prefer-offline");
  });

  it("kills the whole dependency-install process group on timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "rotator-deps-timeout-"));
    cleanup.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "timeout-test", version: "1.0.0" }));
    const survivor = join(root, "survivor.txt");
    const install = [
      process.execPath,
      "-e",
      JSON.stringify(
        "const {spawn}=require('node:child_process');" +
        "spawn(process.execPath,['-e'," +
        JSON.stringify("setTimeout(()=>require('fs').writeFileSync('survivor.txt','bad'),700);setInterval(()=>{},1000)") +
        "],{stdio:'inherit'});" +
        "setInterval(()=>{},1000)"
      ),
    ].join(" ");

    await expect(
      ensureRepoDependencies(root, install, {
        timeoutMs: 150,
        npmCacheDir: join(root, ".npm-cache"),
      })
    ).rejects.toThrow(/timed out/i);

    await new Promise((resolve) => setTimeout(resolve, 900));
    await expect(access(survivor)).rejects.toBeTruthy();
  });
});
