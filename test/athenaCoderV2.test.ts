import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildRepositoryContext } from "../src/coderContext.js";

const execFileAsync = promisify(execFile);

describe("Athena Coder v2", () => {
  it("builds incident context from the full tracked repository and follows related code/tests", async () => {
    const root = await mkdtemp(join(tmpdir(), "athena-context-"));
    await mkdir(join(root, "src", "services"), { recursive: true });
    await mkdir(join(root, "src", "lib"), { recursive: true });
    await mkdir(join(root, "tests"), { recursive: true });

    await writeFile(join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await writeFile(join(root, "src", "services", "twitch-client.ts"), [
      'import { resolveTenant } from "../lib/tenant-routing.js";',
      'export function dispatchTwitchReply(channel: string) {',
      '  return resolveTenant(channel);',
      '}',
    ].join("\n"));
    await writeFile(join(root, "src", "lib", "tenant-routing.ts"), [
      'export function resolveTenant(channel: string) {',
      '  return channel.toLowerCase();',
      '}',
    ].join("\n"));
    await writeFile(join(root, "src", "unrelated.ts"), 'export const unrelated = "garden overlay";\n');
    await writeFile(join(root, "tests", "twitch-client.test.ts"), 'describe("tenant twitch reply", () => {});\n');

    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });

    const context = await buildRepositoryContext("Twitch tenant AI reply routing does not answer chat", root);

    expect(context).toContain("src/services/twitch-client.ts");
    expect(context).toContain("src/lib/tenant-routing.ts");
    expect(context).toContain("tests/twitch-client.test.ts");
    expect(context).toContain("dispatchTwitchReply");
    expect(context).toContain("Repository inventory:");
  });

  it("patches the repair executor with ecosystem context, ChatGPT handoff, baseline validation, and sandbox retention", async () => {
    const source = await readFile(join(process.cwd(), "src", "publicCodexFixer.ts"), "utf8");
    expect(source).toContain('buildRepositoryContext(description, workspace)');
    expect(source).toContain('loadEcosystemOperatorContext(env)');
    expect(source).toContain('Canonical ecosystem operator context:');
    expect(source).toContain('Qwen produced no code changes.');
    expect(source).toContain('writeChatGptHandoff(env');
    expect(source).toContain('ChatGPT Business handoff');
    expect(source).not.toContain('const codexResult = await runCodexWorkspaceCoder(');
    expect(source).not.toContain('Codex fallback:');
    expect(source).toContain('job.baselineChecks = []');
    expect(source).toContain('BASELINE FAILURE ACCEPTED');
    expect(source).toContain('Keep failed sandboxes with code changes on the Fly machine');
  });
});
