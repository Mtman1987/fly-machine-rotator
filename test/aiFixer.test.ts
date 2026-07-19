import { describe, expect, it } from "vitest";
import { derivePriorityPaths, deriveSearchTerms, discardExcerptGuessing, extractJsonPayload } from "../src/aiFixer.js";

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

  it("extracts fenced JSON from provider prose", () => {
    const payload = extractJsonPayload([
      "Here is the plan:",
      "```json",
      "{\"summary\":\"fix\",\"diagnosis\":\"root\",\"changes\":[]}",
      "```"
    ].join("\n"));

    expect(JSON.parse(payload)).toEqual({
      summary: "fix",
      diagnosis: "root",
      changes: []
    });
  });

  it("extracts the first balanced JSON object", () => {
    const payload = extractJsonPayload("text before {\"summary\":\"fix\",\"changes\":[]} text after");
    expect(JSON.parse(payload).summary).toBe("fix");
  });

  it("extracts a balanced JSON object from a json-prefixed payload", () => {
    const content = 'json {"summary":"ok","diagnosis":"d","confidence":"medium","sourceSummary":"s","changes":[]}';
    expect(extractJsonPayload(content)).toBe('{"summary":"ok","diagnosis":"d","confidence":"medium","sourceSummary":"s","changes":[]}');
  });

  it("prioritizes streamweaver admin-access files for DSH 404 integration errors", () => {
    const event = {
      recordedAt: "2026-06-16T00:00:00.000Z",
      appName: "streamweaver-new",
      fingerprint: "abc123",
      message: "[Next.js ERROR] [DiscordStreamHub] Admin access check failed: Error: DiscordStreamHub /api/admin/access failed: 404 <!DOCTYPE html>",
      suggestion: "placeholder",
      context: []
    };

    const paths = derivePriorityPaths(event);
    expect(paths).toContain("src/lib/application-access.ts");
    expect(paths).toContain("src/app/api/admin/access/route.ts");
    expect(paths).toContain("src/app/(app)/applications/page.tsx");
  });

  it("prioritizes live image-generation files for streamweaver SeaArt errors", () => {
    const paths = derivePriorityPaths({
      recordedAt: "2026-07-01T00:00:00.000Z",
      appName: "streamweaver-new",
      fingerprint: "abc123",
      message: "[Next.js ERROR] [AI Image] Error: Custom SeaArt models require modelNo:modelVerNo.",
      suggestion: "placeholder",
      context: []
    });

    expect(paths).toContain("src/app/api/ai/image/route.ts");
    expect(paths).toContain("src/services/image-command.ts");
  });

  it("extracts host plus route search terms for cross-app integration failures", () => {
    const event = {
      recordedAt: "2026-06-16T00:00:00.000Z",
      appName: "streamweaver-new",
      fingerprint: "abc123",
      message: "[Next.js ERROR] DiscordStreamHub /api/admin/access failed: 404 https://discord-stream-hub-new.fly.dev/api/admin/access",
      suggestion: "placeholder",
      context: []
    };

    const terms = deriveSearchTerms(event);
    expect(terms).toContain("/api/admin/access");
    expect(terms).toContain("discord-stream-hub-new.fly.dev/api/admin/access");
  });

  it("discards patches that mistake a bounded source excerpt for incomplete code", () => {
    const guarded = discardExcerptGuessing({
      summary: "Complete the missing parser implementation.",
      diagnosis: "The source function is truncated and the implementation is cut off.",
      confidence: "high",
      sourceSummary: "The file appears incomplete.",
      changes: [{ path: "src/route.ts", reason: "Complete the function.", content: "export function parse() {}\n" }]
    });

    expect(guarded.changes).toEqual([]);
    expect(guarded.confidence).toBe("low");
    expect(guarded.sourceSummary).toContain("discarded");
  });

  it("keeps patches when a request payload, rather than source context, was truncated", () => {
    const guarded = discardExcerptGuessing({
      summary: "Reject a truncated request payload.",
      diagnosis: "The caller supplied a truncated JSON payload.",
      confidence: "high",
      sourceSummary: "The complete route source validates the request body.",
      changes: [{ path: "src/route.ts", reason: "Return a controlled 400.", content: "export function parse() {}\n" }]
    });

    expect(guarded.changes).toHaveLength(1);
    expect(guarded.confidence).toBe("high");
  });
});
