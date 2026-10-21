import { afterEach, describe, expect, it } from "vitest";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { consumeScopedLogGrant } from "./scopedLogGrant.js";

const secret = "test-only-scoped-delegation-secret-with-more-than-32-bytes";
let root = "";
const env = () => ({ ...process.env, SPMT_DELEGATION_SIGNING_SECRET: secret, ROTATOR_EVIDENCE_DIR: root });

function token(overrides: Record<string, unknown> = {}) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: "https://spmt.live",
    aud: "mtman-machine-rotator",
    scope: "logs:read:last24h",
    requestId: randomUUID(),
    jti: randomUUID(),
    sub: "owner-123",
    exp: Math.floor(Date.now() / 1000) + 90,
    ...overrides,
  });
  const input = header + "." + payload;
  return input + "." + createHmac("sha256", secret).update(input).digest("base64url");
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
});

describe("SPMT scoped log grants", () => {
  it("accepts a correctly signed, scoped, unexpired grant exactly once", async () => {
    root = await mkdtemp(join(tmpdir(), "rotator-scoped-grant-"));
    const grant = token();
    expect(await consumeScopedLogGrant(grant, env())).toEqual({ ok: true });
    expect(await consumeScopedLogGrant(grant, env())).toEqual({ ok: false, reason: "grant_replayed" });
  });

  it("rejects grants for any other scope", async () => {
    root = await mkdtemp(join(tmpdir(), "rotator-scoped-grant-"));
    expect(await consumeScopedLogGrant(token({ scope: "machines:restart" }), env())).toEqual({
      ok: false, reason: "wrong_scope_or_missing_claims",
    });
  });

  it("rejects expired grants", async () => {
    root = await mkdtemp(join(tmpdir(), "rotator-scoped-grant-"));
    expect(await consumeScopedLogGrant(token({ exp: Math.floor(Date.now() / 1000) - 1 }), env())).toEqual({
      ok: false, reason: "grant_expired",
    });
  });

  it("rejects grants with the wrong audience", async () => {
    root = await mkdtemp(join(tmpdir(), "rotator-scoped-grant-"));
    expect(await consumeScopedLogGrant(token({ aud: "another-service" }), env())).toEqual({
      ok: false, reason: "wrong_issuer_or_audience",
    });
  });

  it("rejects tampered signatures", async () => {
    root = await mkdtemp(join(tmpdir(), "rotator-scoped-grant-"));
    const parts = token().split(".");
    parts[2] = "invalid";
    expect(await consumeScopedLogGrant(parts.join("."), env())).toEqual({ ok: false, reason: "invalid_signature" });
  });
});
