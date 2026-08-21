import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("github-control-chat runner", () => {
  it("rejects malformed payloads before invoking Fly", () => {
    const script = resolve(process.cwd(), "scripts/github-control-chat.mjs");
    const result = spawnSync(process.execPath, [script, "$(touch /tmp/nope)"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: "" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    const payload = JSON.parse(result.stdout) as { ok?: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Invalid control payload encoding/);
  });

  it("rejects invalid handoff ids before invoking Fly", () => {
    const script = resolve(process.cwd(), "scripts/github-control-chat.mjs");
    const encoded = Buffer.from(JSON.stringify({ command: "chatjob", id: "../../etc/passwd" }), "utf8").toString("base64");
    const result = spawnSync(process.execPath, [script, encoded], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, FLY_API_TOKEN: "" },
    });

    expect(result.status).toBe(1);
    const payload = JSON.parse(result.stdout) as { ok?: boolean; error?: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/Invalid ChatGPT handoff ID/);
  });

  it("removes only the encoded script argument so the payload remains argv[1] remotely", async () => {
    const source = await readFile(resolve(process.cwd(), "scripts/github-control-chat.mjs"), "utf8");
    expect(source).toContain("process.argv.splice(1,1);eval(Buffer.from(s,'base64').toString('utf8'))");
    expect(source).not.toContain("process.argv.splice(1,2);eval(Buffer.from(s,'base64').toString('utf8'))");
  });
});
