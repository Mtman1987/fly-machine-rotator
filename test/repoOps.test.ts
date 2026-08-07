import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGithubGitAuthEnv, validateRepoFileChanges } from "../src/repoOps.js";

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

describe("GitHub repository authentication", () => {
  it("passes credentials through ephemeral git config environment instead of the remote URL", () => {
    const token = "github_pat_test_secret_value";
    const env = buildGithubGitAuthEnv("https://github.com/Mtman1987/fly-machine-rotator.git", token);
    expect(env.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    expect(env.GIT_CONFIG_VALUE_0).toMatch(/^AUTHORIZATION: basic /);
    expect(String(env.GIT_CONFIG_VALUE_0)).not.toContain(token);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not add GitHub credentials to non-GitHub remotes", () => {
    expect(buildGithubGitAuthEnv("https://example.com/repo.git", "secret")).toEqual({});
    expect(buildGithubGitAuthEnv("git@github.com:Mtman1987/repo.git", "secret")).toEqual({});
  });
});
