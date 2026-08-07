import { describe, expect, it } from "vitest";
import { consumeOwnerMutationRate, isOwnerMutationPath, isSameOriginMutation } from "../src/dashboardSecurity.js";

describe("Rotator owner mutation guard", () => {
  it("scopes protection to privileged Rotator mutation routes", () => {
    expect(isOwnerMutationPath("/actions/rotate")).toBe(true);
    expect(isOwnerMutationPath("/api/codex/jobs")).toBe(true);
    expect(isOwnerMutationPath("/api/llm-control/provision")).toBe(true);
    expect(isOwnerMutationPath("/mountainview/api/voice/route")).toBe(false);
    expect(isOwnerMutationPath("/api/dsh/mtfixit/jobs")).toBe(false);
  });

  it("requires same-origin browser writes while allowing bearer-authenticated service writes", () => {
    expect(isSameOriginMutation({ headers: { host: "rotator.example", origin: "https://rotator.example" } } as any)).toBe(true);
    expect(isSameOriginMutation({ headers: { host: "rotator.example", origin: "https://evil.example" } } as any)).toBe(false);
    expect(isSameOriginMutation({ headers: { host: "rotator.example", authorization: "Bearer service-token" } } as any)).toBe(true);
  });

  it("rate limits repeated owner mutations", () => {
    const request = { headers: { host: "rotator.example", origin: "https://rotator.example", cookie: "rotator_spmt_access_token=test" }, socket: { remoteAddress: "127.0.0.1" } } as any;
    const env = { ROTATOR_MUTATION_RATE_LIMIT: "5", ROTATOR_MUTATION_RATE_WINDOW_MS: "60000" } as NodeJS.ProcessEnv;
    for (let index = 0; index < 5; index += 1) expect(consumeOwnerMutationRate(request, env, 1000 + index).ok).toBe(true);
    expect(consumeOwnerMutationRate(request, env, 1010).ok).toBe(false);
  });
});
