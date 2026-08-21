import { spawnSync } from "node:child_process";
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
});
