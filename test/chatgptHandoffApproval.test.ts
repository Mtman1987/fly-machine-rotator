import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  approveChatGptHandoff,
  denyChatGptHandoff,
  readChatGptHandoff,
  resolveChatGptHandoff,
  writeChatGptHandoff,
} from "../src/chatgptHandoff.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function env() {
  const root = await mkdtemp(join(tmpdir(), "chatgpt-handoff-"));
  roots.push(root);
  return { CODEX_FIXER_DATA_DIR: root } as NodeJS.ProcessEnv;
}

function input(jobId: string) {
  return {
    jobId,
    appName: "streamweaver-new",
    repoId: "streamweaver",
    repoLabel: "StreamWeaver",
    repoUrl: "https://github.com/Mtman1987/streamweaver.git",
    description: "repair a regression",
    qwenFailure: "Qwen produced no code changes.",
    baselineChecks: [],
    operatorContext: "canonical context",
    repositoryContext: "repository context",
    validationCommands: ["npm run typecheck"],
  };
}

describe("ChatGPT handoff owner approval", () => {
  it("starts hidden from the worker state and becomes awaiting-chatgpt only after approval", async () => {
    const e = await env();
    const handoff = await writeChatGptHandoff(e, input("job_12345678"));
    expect(handoff.status).toBe("awaiting-owner-approval");
    expect(handoff.approvedAt).toBeUndefined();

    const approved = await approveChatGptHandoff(e, handoff.id, "mtman-discord");
    expect(approved.status).toBe("awaiting-chatgpt");
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.decisionBy).toBe("mtman-discord");

    const resolved = await resolveChatGptHandoff(e, handoff.id, "fixed and live verified");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toContain("live verified");
  });

  it("keeps a declined handoff out of the ChatGPT queue and blocks later resolution", async () => {
    const e = await env();
    const handoff = await writeChatGptHandoff(e, input("job_87654321"));
    const denied = await denyChatGptHandoff(e, handoff.id, "mtman-discord");
    expect(denied.status).toBe("denied");
    await expect(resolveChatGptHandoff(e, handoff.id, "should not happen")).rejects.toThrow(/not owner-approved/i);
    expect((await readChatGptHandoff(e, handoff.id))?.status).toBe("denied");
  });
});
