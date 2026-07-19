import { describe, expect, it } from "vitest";
import { redactSensitiveText, redactSensitiveValue } from "../src/redaction.js";

describe("production log redaction", () => {
  it("removes LiveKit query tokens, bearer credentials, JWTs, and JSON secrets", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.aVeryLongSignatureValue123";
    const input = `wss://livekit.example/rtc/v1?access_token=${jwt}&join=1 Authorization: Bearer secret-token-value-123 {"client_secret":"keep-me-out"}`;
    const output = redactSensitiveText(input);
    expect(output).not.toContain(jwt);
    expect(output).not.toContain("secret-token-value-123");
    expect(output).not.toContain("keep-me-out");
    expect(output).toContain("access_token=[REDACTED]");
  });

  it("redacts nested values before they are archived or rendered", () => {
    const value = redactSensitiveValue({ context: ["api_key='super-secret-key'", "safe line"] });
    expect(value.context[0]).not.toContain("super-secret-key");
    expect(value.context[1]).toBe("safe line");
  });
});
