import { describe, expect, it } from "vitest";
import { inferRepo } from "../src/publicCodexFixer.js";

describe("Athena Coder repository routing", () => {
  it("honors the explicit app even when the task mentions another ecosystem service", () => {
    expect(inferRepo({
      appName: "streamweaver-new",
      description: "Keep built-in SPMT Qwen as the StreamWeaver default",
    }).id).toBe("streamweaver");
  });

  it("falls back to description inference when no known app is supplied", () => {
    expect(inferRepo({ description: "Repair spmt.live OAuth" }).id).toBe("spmt-live");
  });
});
