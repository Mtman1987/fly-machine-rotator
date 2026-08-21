import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { approveChatGptHandoff, listChatGptHandoffs, readChatGptHandoff, resolveChatGptHandoff, writeChatGptHandoff } from "../src/chatgptHandoff.js";
import { ecosystemOperatorContextSource } from "../src/ecosystemContext.js";

describe("ChatGPT repair handoffs", () => {
  it("persists an owner-gated handoff, preserves redaction, and resolves only after approval", async () => {
    const root = await mkdtemp(join(tmpdir(), "chatgpt-handoff-"));
    const env = { ...process.env, CODEX_FIXER_DATA_DIR: root };

    const created = await writeChatGptHandoff(env, {
      jobId: "12345678-abcd",
      appName: "streamweaver-new",
      repoId: "streamweaver",
      repoLabel: "StreamWeaver",
      repoUrl: "https://github.com/Mtman1987/streamweaver.git",
      description: "Fix tenant routing regression",
      userContext: { source: "test" },
      qwenFailure: "Bearer secret-token-should-not-leak",
      baselineChecks: [{ command: "npm test", ok: false, output: "sk-test-secret-abcdef should not leak" }],
      operatorContext: "canonical ecosystem rules",
      repositoryContext: "selected repository files",
      validationCommands: ["npm run typecheck", "npm run test:isolation"],
    });

    expect(created.status).toBe("awaiting-owner-approval");
    expect(created.operatorContextSource).toBe(ecosystemOperatorContextSource());
    expect(created.qwenFailure).toContain("Bearer [redacted]");
    expect(created.baselineChecks[0].output).toContain("[redacted]");

    const stored = await listChatGptHandoffs(env, 10);
    expect(stored.map((row) => row.id)).toContain(created.id);
    await expect(resolveChatGptHandoff(env, created.id, "should not resolve before approval")).rejects.toThrow(/not owner-approved/i);

    const approved = await approveChatGptHandoff(env, created.id, "mtman-discord");
    expect(approved.status).toBe("awaiting-chatgpt");
    expect(approved.approvedAt).toBeTruthy();

    const loaded = await readChatGptHandoff(env, created.id);
    expect(loaded?.description).toBe("Fix tenant routing regression");

    const resolved = await resolveChatGptHandoff(env, created.id, "Merged PR #999 and live verified.");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toContain("PR #999");
  });
});
