import { describe, expect, it } from "vitest";
// The production CLI is intentionally plain ESM so it also runs in the Fly image without a TS loader.
// @ts-expect-error JavaScript CLI module has no declaration file.
import { resolveClient } from "../scripts/athena-code.mjs";

describe("Athena Coder CLI", () => {
  it("uses the SPMT gateway by default when its service secret is present", () => {
    expect(resolveClient({ SPMT_CODEX_SERVICE_SECRET: "gateway" })).toEqual({
      baseUrl: "https://spmt.live",
      referencesPath: "/api/athena/code-references",
      jobsPath: "/api/athena/code-jobs",
      headers: { "x-spmt-codex-secret": "gateway" },
    });
  });

  it("uses the private Codex worker route on Fly without a browser session", () => {
    expect(resolveClient({
      CODEX_WORKER_SECRET: "worker",
      ATHENA_CODER_BASE_URL: "http://127.0.0.1:8082/",
    })).toEqual({
      baseUrl: "http://127.0.0.1:8082",
      referencesPath: "/api/codex/references",
      jobsPath: "/api/codex/jobs",
      headers: { "x-codex-worker-secret": "worker" },
    });
  });

  it("derives the private dashboard port from the public Fly port", () => {
    expect(resolveClient({ CODEX_WORKER_SECRET: "worker", PORT: "9000" }).baseUrl)
      .toBe("http://127.0.0.1:9002");
  });

  it("refuses to run authenticated operations without an existing server credential", () => {
    expect(() => resolveClient({})).toThrow(/SPMT_CODEX_SERVICE_SECRET/);
  });
});
