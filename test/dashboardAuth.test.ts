import { describe, expect, it } from "vitest";
import { IncomingMessage } from "node:http";
import { authorizeAction } from "../src/dashboardServer.js";

function request(headers: IncomingMessage["headers"]): IncomingMessage {
  return { headers } as IncomingMessage;
}

describe("rotator dashboard action authorization", () => {
  it("accepts the dedicated dashboard action token", () => {
    expect(() => authorizeAction(request({ "x-rotator-action-token": "correct" }), {
      ROTATOR_DASHBOARD_ACTION_TOKEN: "correct"
    })).not.toThrow();
  });

  it("rejects missing, wrong, and unconfigured tokens", () => {
    expect(() => authorizeAction(request({}), { ROTATOR_DASHBOARD_ACTION_TOKEN: "correct" })).toThrow(/Invalid/);
    expect(() => authorizeAction(request({ authorization: "Bearer wrong" }), { ROTATOR_DASHBOARD_ACTION_TOKEN: "correct" })).toThrow(/Invalid/);
    expect(() => authorizeAction(request({}), {})).toThrow(/not configured/);
  });
});
