import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import { authorizeAction, getHttpErrorStatus } from "../src/dashboardServer.js";

function request(headers: IncomingMessage["headers"], remoteAddress = "203.0.113.10"): IncomingMessage {
  return { headers, socket: { remoteAddress } } as IncomingMessage;
}

describe("rotator dashboard action authorization", () => {
  it("accepts the loopback-only same-process marker without a shared secret", async () => {
    await expect(authorizeAction(
      request({ "x-rotator-internal": "same-process" }, "127.0.0.1"),
      {},
    )).resolves.toBeUndefined();
  });

  it("does not let the same-process marker bypass auth from a non-loopback caller", async () => {
    await expect(authorizeAction(
      request({ "x-rotator-internal": "same-process" }, "203.0.113.10"),
      {},
    )).rejects.toThrow(/SPMT owner\/admin session required/i);
  });

  it("does not accept the retired dashboard action token as owner auth", async () => {
    await expect(authorizeAction(
      request({ "x-rotator-action-token": "old-secret" }),
      { ROTATOR_DASHBOARD_ACTION_TOKEN: "old-secret" },
    )).rejects.toThrow(/SPMT owner\/admin session required/i);
  });

  it("preserves status codes from MountainView route errors", () => {
    expect(getHttpErrorStatus({ statusCode: 401 })).toBe(401);
    expect(getHttpErrorStatus(new Error("boom"))).toBe(500);
  });
});
