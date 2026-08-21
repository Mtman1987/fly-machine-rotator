import { describe, expect, it } from "vitest";
import { decodeControlPayload } from "../src/githubControlCli.js";

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

describe("githubControlCli", () => {
  it("decodes bounded JSON control payloads", () => {
    expect(decodeControlPayload(encode({ command: "states", appName: "streamweaver-new" }))).toEqual({
      command: "states",
      appName: "streamweaver-new",
    });
  });

  it("rejects shell-shaped and malformed payload input before execution", () => {
    expect(() => decodeControlPayload("$(touch /tmp/nope)")).toThrow(/Invalid control payload encoding/);
    expect(() => decodeControlPayload(Buffer.from("not json").toString("base64"))).toThrow();
  });
});
