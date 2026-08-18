import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getAthenaRepairAudit, renderAthenaRepairAuditText } from "../src/repairAudit.js";

describe("Athena repair audit", () => {
  it("summarizes persisted fixes, incident attempts, and approval delivery without exposing proposed file bodies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "athena-audit-"));
    const fixes = join(dir, "fixes.json");
    const attempts = join(dir, "attempts.json");
    await writeFile(fixes, JSON.stringify([{
      id: "app::fingerprint",
      appName: "example-app",
      fingerprint: "fingerprint",
      status: "awaiting_approval",
      generatedAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:01:00.000Z",
      summary: "Fix the broken route",
      changes: [{ path: "src/route.ts", reason: "repair", content: "SUPER_SECRET_PROPOSED_BODY" }],
      attempts: [{ attemptedAt: "2026-08-18T00:00:30.000Z", action: "check", ok: true, summary: "checks passed" }],
      checkResult: { ranAt: "2026-08-18T00:00:40.000Z", ok: true, commandResults: [{ command: "npm test", exitCode: 0, output: "pass" }] },
      pushResult: { pushedAt: "2026-08-18T00:00:50.000Z", branch: "rotator-fix/example", commit: "abc123", output: "pushed" },
      approval: { status: "awaiting_approval", requestedAt: "2026-08-18T00:01:00.000Z", dm: { channelId: "c", messageId: "m", sentAt: "2026-08-18T00:01:01.000Z" } },
    }]), "utf8");
    await writeFile(attempts, JSON.stringify([{
      incidentId: "app::fingerprint",
      appName: "example-app",
      fingerprint: "fingerprint",
      rotationKey: "r1",
      attemptedAt: "2026-08-18T00:00:00.000Z",
      finishedAt: "2026-08-18T00:01:00.000Z",
      status: "completed",
      summary: "generated and prepared",
    }]), "utf8");

    const audit = await getAthenaRepairAudit({ ROTATOR_FIXES_FILE: fixes, ROTATOR_ATHENA_ATTEMPTS_FILE: attempts } as NodeJS.ProcessEnv);
    expect(audit.counts).toMatchObject({ fixes: 1, attempts: 1, awaitingApproval: 1, pushed: 1 });
    expect(audit.pendingApprovals[0]?.approval?.dm?.messageId).toBe("m");
    expect(audit.fixes[0]?.changedFiles).toEqual([{ path: "src/route.ts", reason: "repair" }]);
    expect(JSON.stringify(audit)).not.toContain("SUPER_SECRET_PROPOSED_BODY");
    const text = renderAthenaRepairAuditText(audit);
    expect(text).toContain("Awaiting approval: 1");
    expect(text).toContain("message=m");
    expect(text).toContain("rotator-fix/example@abc123");
  });
});
