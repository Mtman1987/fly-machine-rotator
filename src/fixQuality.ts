import { FixRecord, FixQualityGate } from "./fixStore.js";

export function updateFixQualityGate(record: FixRecord): FixQualityGate {
  const rootCauseConfidence = clampScore(record.confidenceScore ?? confidenceLabelToScore(record.confidence));
  const patchConfidence = scorePatch(record, rootCauseConfidence);
  const testConfidence = scoreTests(record);
  const rollbackConfidence = scoreRollback(record);
  const postDeployConfidence = scorePostDeploy(record);
  const signals = buildQualitySignals(record, {
    rootCauseConfidence,
    patchConfidence,
    testConfidence,
    rollbackConfidence,
    postDeployConfidence
  });
  const overallConfidence = Math.round(
    rootCauseConfidence * 0.25 +
    patchConfidence * 0.25 +
    testConfidence * 0.25 +
    rollbackConfidence * 0.15 +
    postDeployConfidence * 0.10
  );
  const verdict = chooseVerdict(record, overallConfidence, testConfidence, rollbackConfidence, postDeployConfidence);
  const gate: FixQualityGate = {
    updatedAt: new Date().toISOString(),
    overallConfidence: clampScore(overallConfidence),
    rootCauseConfidence,
    patchConfidence,
    testConfidence,
    rollbackConfidence,
    postDeployConfidence,
    verdict,
    signals
  };
  record.qualityGate = gate;
  return gate;
}

function scorePatch(record: FixRecord, rootCauseConfidence: number): number {
  if (record.changes.length === 0) return 15;
  let score = Math.min(88, rootCauseConfidence + 8);
  if (record.changes.length > 4) score -= 10;
  if (record.changes.some((change) => !change.reason.trim())) score -= 8;
  if (record.changes.some((change) => !change.content.includes("\n"))) score -= 12;
  return clampScore(score);
}

function scoreTests(record: FixRecord): number {
  if (!record.checkResult) return 35;
  if (!record.checkResult.ok) return 8;
  const commands = record.checkResult.commandResults.length;
  return clampScore(78 + Math.min(12, commands * 4));
}

function scoreRollback(record: FixRecord): number {
  if (record.pushResult?.branch && record.pushResult.commit) return 95;
  if (record.status === "applied" || record.status === "checked") return 58;
  return 25;
}

function scorePostDeploy(record: FixRecord): number {
  if (!record.verificationResult) return 35;
  return record.verificationResult.ok ? 92 : 5;
}

function buildQualitySignals(record: FixRecord, scores: Omit<FixQualityGate, "updatedAt" | "overallConfidence" | "verdict" | "signals">): string[] {
  const signals = [
    `root cause evidence: ${scores.rootCauseConfidence}%`,
    `patch evidence: ${scores.patchConfidence}%`,
    `test evidence: ${scores.testConfidence}%`,
    `rollback evidence: ${scores.rollbackConfidence}%`,
    `post-deploy evidence: ${scores.postDeployConfidence}%`
  ];
  if (record.confidenceSignals?.length) signals.push(...record.confidenceSignals);
  if (record.checkResult) {
    signals.push(record.checkResult.ok ? "checks passed" : "checks failed");
  } else {
    signals.push("checks not run yet");
  }
  if (record.pushResult?.branch) {
    signals.push(`rollback branch ready: ${record.pushResult.branch}`);
  } else {
    signals.push("rollback branch not pushed yet");
  }
  if (record.verificationResult) {
    signals.push(record.verificationResult.summary);
  } else {
    signals.push("post-deploy verification not run yet");
  }
  return signals;
}

function chooseVerdict(
  record: FixRecord,
  overall: number,
  testConfidence: number,
  rollbackConfidence: number,
  postDeployConfidence: number
): FixQualityGate["verdict"] {
  if (record.verificationResult?.ok && overall >= 75) return "verified";
  if (record.checkResult?.ok === false || record.status === "error") return "blocked";
  if (testConfidence >= 75 && rollbackConfidence >= 80 && overall >= 70) return postDeployConfidence >= 80 ? "verified" : "ready";
  return "review";
}

function confidenceLabelToScore(confidence: FixRecord["confidence"]): number {
  if (confidence === "high") return 74;
  if (confidence === "medium") return 58;
  if (confidence === "low") return 38;
  return 25;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
