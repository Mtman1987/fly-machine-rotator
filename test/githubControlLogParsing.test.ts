import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

describe("GitHub control Fly log parsing", () => {
  it("keeps pretty-printed Fly JSON events intact", async () => {
    const script = pathToFileURL(resolve(process.cwd(), "scripts/github-control-direct.mjs")).href;
    const mod = await import(script);
    const rows = mod.parseFlyJsonRecords(`{
  "level": "error",
  "instance": "abc123",
  "region": "iad",
  "timestamp": "2026-10-02T01:00:00Z",
  "message": "Health check failed",
  "Error": {
    "Code": 0,
    "Message": ""
  }
}
{
  "level": "info",
  "instance": "def456",
  "region": "iad",
  "timestamp": "2026-10-02T01:00:01Z",
  "message": "[LoungeHLS] mediaSequence=44 lastSegment=55"
}`);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      level: "error",
      instance: "abc123",
      region: "iad",
      timestamp: "2026-10-02T01:00:00Z",
      message: "Health check failed",
    });
    expect(rows[1]).toMatchObject({
      level: "info",
      instance: "def456",
      message: "[LoungeHLS] mediaSequence=44 lastSegment=55",
    });
  });
});
