import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relative: string) {
  return fs.readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("Athena repair provider escalation", () => {
  it("does not let a diagnosis-only provider stop the repair provider chain", () => {
    const fixer = source("src/aiFixer.ts");
    expect(fixer).toContain("guarded.changes.length === 0");
    expect(fixer).toContain("returned diagnostic evidence but no patch; continuing to another repair provider when configured");
  });

  it("preserves source-summary evidence such as rejected excerpt-guess patches", () => {
    const fixer = source("src/aiFixer.ts");
    expect(fixer).toContain("[guarded.sourceSummary, guarded.diagnosis, guarded.summary]");
    expect(fixer).toContain('failures.join(" | ").slice(0, 4800)');
  });

  it("keeps the local fallback as a diagnosis when no provider can produce a patch", () => {
    const fixer = source("src/aiFixer.ts");
    expect(fixer).toContain("return buildLocalFallbackPlan(event, contextFiles, failures);");
    expect(fixer).toContain("No automatic file rewrite was produced because the local fallback will not guess at code edits");
  });
});
