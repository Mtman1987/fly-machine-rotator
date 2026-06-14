import { describe, expect, it } from "vitest";
import { extractJsonPayload } from "../src/aiFixer.js";

describe("extractJsonPayload", () => {
  it("extracts a balanced JSON object from prose-wrapped model output", () => {
    const content = [
      "Looking at the error, here is the safest fix:",
      "",
      '{"summary":"ok","diagnosis":"d","confidence":"medium","sourceSummary":"s","changes":[]}',
      "",
      "This should address the issue."
    ].join("\n");

    expect(extractJsonPayload(content)).toBe('{"summary":"ok","diagnosis":"d","confidence":"medium","sourceSummary":"s","changes":[]}');
  });

  it("extracts fenced JSON payloads", () => {
    const content = "```json\n{\"summary\":\"ok\",\"diagnosis\":\"d\",\"confidence\":\"medium\",\"sourceSummary\":\"s\",\"changes\":[]}\n```";
    expect(extractJsonPayload(content)).toBe('{"summary":"ok","diagnosis":"d","confidence":"medium","sourceSummary":"s","changes":[]}');
  });
});
