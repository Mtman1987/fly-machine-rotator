import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withCodexWorkerAuth } from "../src/codexWorkerAuth.js";

describe("Codex worker loopback authentication", () => {
  it("generates a root-only local credential when no Fly secret is configured", () => {
    const file = join(mkdtempSync(join(tmpdir(), "codex-worker-auth-")), "secret");
    const env = withCodexWorkerAuth({}, file);
    expect(env.CODEX_WORKER_SECRET).toMatch(/^[a-zA-Z0-9_-]{40,}$/);
    expect(readFileSync(file, "utf8").trim()).toBe(env.CODEX_WORKER_SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("preserves an explicitly configured cross-service credential", () => {
    const file = join(mkdtempSync(join(tmpdir(), "codex-worker-auth-")), "secret");
    const env = withCodexWorkerAuth({ CODEX_WORKER_SECRET: "configured-worker-secret" }, file);
    expect(env.CODEX_WORKER_SECRET).toBe("configured-worker-secret");
    expect(readFileSync(file, "utf8").trim()).toBe("configured-worker-secret");
  });
});
