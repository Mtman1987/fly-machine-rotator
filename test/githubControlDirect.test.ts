import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("github-control-direct runner", () => {
  it("runs as a CLI and rejects malformed control payloads before any Fly call", () => {
    const script = resolve(process.cwd(), "scripts/github-control-direct.mjs");
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
});
