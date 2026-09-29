import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { authorizeOwnerMutation } from "../src/dashboardSecurity.js";

function request(path: string, secret: string): IncomingMessage {
  return {
    url: path,
    headers: { "x-codex-worker-secret": secret },
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

describe("Codex worker mutation authorization", () => {
  const env = { CODEX_WORKER_SECRET: "test-only-worker-secret" };

  it("accepts the scoped service credential for a Codex job POST", async () => {
    expect(await authorizeOwnerMutation(request("/api/codex/jobs", env.CODEX_WORKER_SECRET), env)).toEqual({ ok: true });
  });

  it("rejects an incorrect credential and does not grant other owner actions", async () => {
    expect(await authorizeOwnerMutation(request("/api/codex/jobs", "incorrect"), env)).toMatchObject({ ok: false, status: 403 });
    expect(await authorizeOwnerMutation(request("/actions/restart", env.CODEX_WORKER_SECRET), env)).toMatchObject({ ok: false, status: 403 });
  });
});
