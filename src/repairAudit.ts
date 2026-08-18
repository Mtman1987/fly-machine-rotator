import { FixStore, getFixStoreFile, type FixRecord } from "./fixStore.js";
import { getAthenaIncidentAttemptsFile, readAthenaIncidentAttempts, type AthenaIncidentAttempt } from "./athenaIncidentTrigger.js";
import { redactSensitiveText } from "./redaction.js";

export type AthenaRepairAudit = {
  generatedAt: string;
  files: { fixes: string; attempts: string };
  counts: {
    fixes: number;
    attempts: number;
    awaitingApproval: number;
    generatedOnly: number;
    pushed: number;
    deployed: number;
    failedAttempts: number;
  };
  pendingApprovals: ReturnType<typeof summarizeFix>[];
  fixes: ReturnType<typeof summarizeFix>[];
  attempts: ReturnType<typeof summarizeAttempt>[];
};

function safe(value: unknown, max = 4000) {
  return redactSensitiveText(String(value ?? "")).slice(0, max);
}

function summarizeFix(record: FixRecord) {
  return {
    id: record.id,
    appName: record.appName,
    fingerprint: record.fingerprint,
    status: record.status,
    generatedAt: record.generatedAt,
    updatedAt: record.updatedAt,
    diagnosis: safe(record.diagnosis || "", 3000),
    summary: safe(record.summary || "", 3000),
    confidence: record.confidence,
    confidenceScore: record.confidenceScore,
    qualityGate: record.qualityGate,
    changedFiles: record.changes.map((change) => ({ path: change.path, reason: safe(change.reason, 1000) })),
    attempts: (record.attempts || []).map((attempt) => ({
      attemptedAt: attempt.attemptedAt,
      action: attempt.action,
      ok: attempt.ok,
      summary: safe(attempt.summary, 1500),
      details: safe(attempt.details || "", 2000),
    })),
    checks: record.checkResult ? {
      ranAt: record.checkResult.ranAt,
      ok: record.checkResult.ok,
      commands: record.checkResult.commandResults.map((item) => ({
        command: safe(item.command, 500),
        exitCode: item.exitCode,
        output: safe(item.output, 2500),
      })),
    } : undefined,
    push: record.pushResult ? {
      pushedAt: record.pushResult.pushedAt,
      branch: record.pushResult.branch,
      commit: record.pushResult.commit,
      output: safe(record.pushResult.output, 1500),
    } : undefined,
    approval: record.approval,
    verification: record.verificationResult,
    lastError: safe(record.lastError || "", 2500),
    handledAt: record.handledAt,
  };
}

function summarizeAttempt(attempt: AthenaIncidentAttempt) {
  return {
    incidentId: attempt.incidentId,
    appName: attempt.appName,
    fingerprint: attempt.fingerprint,
    rotationKey: attempt.rotationKey,
    attemptedAt: attempt.attemptedAt,
    finishedAt: attempt.finishedAt,
    status: attempt.status,
    summary: safe(attempt.summary || "", 2500),
  };
}

export async function getAthenaRepairAudit(env: NodeJS.ProcessEnv = process.env): Promise<AthenaRepairAudit> {
  const fixesFile = getFixStoreFile(env);
  const attemptsFile = getAthenaIncidentAttemptsFile(env);
  const [store, incidentAttempts] = await Promise.all([
    FixStore.load(fixesFile),
    readAthenaIncidentAttempts(attemptsFile),
  ]);
  const fixes = store.list().map(summarizeFix);
  const attempts = incidentAttempts
    .slice()
    .sort((left, right) => right.attemptedAt.localeCompare(left.attemptedAt))
    .map(summarizeAttempt);
  const pendingApprovals = fixes.filter((fix) => fix.status === "awaiting_approval" || fix.approval?.status === "awaiting_approval");
  return {
    generatedAt: new Date().toISOString(),
    files: { fixes: fixesFile, attempts: attemptsFile },
    counts: {
      fixes: fixes.length,
      attempts: attempts.length,
      awaitingApproval: pendingApprovals.length,
      generatedOnly: fixes.filter((fix) => fix.status === "generated").length,
      pushed: fixes.filter((fix) => Boolean(fix.push)).length,
      deployed: fixes.filter((fix) => fix.status === "deployed" || fix.approval?.status === "deployed").length,
      failedAttempts: attempts.filter((attempt) => attempt.status === "failed").length,
    },
    pendingApprovals,
    fixes,
    attempts,
  };
}

export function renderAthenaRepairAuditText(audit: AthenaRepairAudit): string {
  const lines = [
    "ATHENA REPAIR AUDIT",
    `Generated: ${audit.generatedAt}`,
    `Fix records: ${audit.counts.fixes}`,
    `Incident attempts: ${audit.counts.attempts}`,
    `Awaiting approval: ${audit.counts.awaitingApproval}`,
    `Generated only: ${audit.counts.generatedOnly}`,
    `Pushed: ${audit.counts.pushed}`,
    `Deployed: ${audit.counts.deployed}`,
    `Failed attempts: ${audit.counts.failedAttempts}`,
    "",
    "PENDING APPROVALS",
  ];
  if (!audit.pendingApprovals.length) lines.push("None");
  for (const fix of audit.pendingApprovals) {
    lines.push(`- ${fix.id} | ${fix.appName} | ${fix.status} | updated ${fix.updatedAt}`);
    lines.push(`  DM: ${fix.approval?.dm?.messageId ? `delivered ${fix.approval.dm.sentAt || ""} message=${fix.approval.dm.messageId}` : "not recorded"}`);
    if (fix.summary || fix.diagnosis) lines.push(`  ${safe(fix.summary || fix.diagnosis, 1500)}`);
  }
  lines.push("", "FIX RECORDS");
  if (!audit.fixes.length) lines.push("None");
  for (const fix of audit.fixes) {
    lines.push("-".repeat(72));
    lines.push(`${fix.id}`);
    lines.push(`app=${fix.appName} status=${fix.status} updated=${fix.updatedAt}`);
    lines.push(`changed_files=${fix.changedFiles.map((item) => item.path).join(", ") || "none"}`);
    if (fix.push) lines.push(`push=${fix.push.branch}@${fix.push.commit}`);
    if (fix.approval) lines.push(`approval=${fix.approval.status} requested=${fix.approval.requestedAt || ""} decided=${fix.approval.decidedAt || ""} dm=${fix.approval.dm?.messageId || "none"}`);
    if (fix.checks) lines.push(`checks=${fix.checks.ok ? "PASS" : "FAIL"} at ${fix.checks.ranAt}`);
    if (fix.summary || fix.diagnosis) lines.push(`summary=${safe(fix.summary || fix.diagnosis, 1800)}`);
    for (const attempt of fix.attempts) lines.push(`attempt ${attempt.attemptedAt} ${attempt.action} ${attempt.ok ? "OK" : "FAIL"}: ${safe(attempt.summary, 1200)}`);
  }
  lines.push("", "ATHENA INCIDENT ATTEMPTS");
  if (!audit.attempts.length) lines.push("None");
  for (const attempt of audit.attempts) {
    lines.push(`${attempt.attemptedAt} | ${attempt.status} | ${attempt.incidentId} | ${safe(attempt.summary, 1600)}`);
  }
  return lines.join("\n").slice(0, 900_000);
}
