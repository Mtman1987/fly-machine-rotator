import { readFile } from "node:fs/promises";
import { appendFixAttempt, buildFixId, FixRecord, FixStore, getFixStoreFile } from "./fixStore.js";
import { updateFixQualityGate } from "./fixQuality.js";
import { classifyIncident } from "./incidentClassifier.js";
import {
  buildFixBranchName,
  captureRepoSnapshot,
  checkoutFixBranch,
  ensureRepoDependencies,
  ensureRepoReady,
  hasWorkingTreeChanges,
  pushRepoBranch,
  runCheckCommands,
  writeRepoFiles,
} from "./repoOps.js";
import { getRepoConfigForApp } from "./repoMap.js";
import { requestRepairApproval } from "./repairApproval.js";

interface StoredErrorEvent {
  recordedAt: string;
  appName: string;
  fingerprint: string;
  message: string;
  suggestion: string;
  context: string[];
}

export type IncidentRepairPreparation = {
  advanced: boolean;
  status: string;
  message: string;
};

async function readCurrentEvent(appName: string, fingerprint: string, env: NodeJS.ProcessEnv): Promise<StoredErrorEvent | null> {
  const path = env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json";
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as StoredErrorEvent[];
    return (Array.isArray(parsed) ? parsed : []).find((item) => item.appName === appName && item.fingerprint === fingerprint) || null;
  } catch {
    return null;
  }
}

function proposalGate(event: StoredErrorEvent, record: FixRecord): string[] {
  const classification = classifyIncident(event);
  const reasons: string[] = [];
  if (!classification.autoFixEligible) reasons.push(classification.reason);
  if (!record.changes.length) reasons.push("Athena produced no file changes.");
  if (record.changes.length > 4) reasons.push("The proposal changes more than four files.");
  if (record.changes.some((change) => !change.path.trim() || !change.reason.trim())) reasons.push("Every proposed file requires a path and reason.");
  if ((record.confidenceScore ?? 0) < 75 && record.confidence !== "high") reasons.push("Root-cause confidence is below the unattended preparation threshold.");
  if (!record.repoSnapshot?.headCommit || record.repoSnapshot.dirty) reasons.push("The proposal is not based on a clean captured commit.");
  if (record.qualityGate?.verdict === "blocked") reasons.push("The proposal quality gate is blocked.");
  return reasons;
}

async function save(store: FixStore, record: FixRecord) {
  store.upsert(record);
  await store.save();
}

export async function prepareIncidentRepairForApproval(
  appName: string,
  fingerprint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IncidentRepairPreparation> {
  const id = buildFixId(appName, fingerprint);
  const store = await FixStore.load(getFixStoreFile(env));
  const record = store.get(id);
  if (!record) return { advanced: false, status: "missing", message: `Generated repair ${id} was not found in FixStore.` };
  if (record.approval?.status === "awaiting_approval") {
    return { advanced: false, status: "awaiting_approval", message: "Repair is already waiting for owner approval." };
  }
  if (["approved", "deploying", "deployed"].includes(record.approval?.status || "")) {
    return { advanced: false, status: record.approval?.status || record.status, message: "Repair has already passed the owner gate." };
  }

  const event = await readCurrentEvent(appName, fingerprint, env);
  if (!event) return { advanced: false, status: "review", message: "The source incident is no longer in the current repair history; leaving the generated proposal for dashboard review." };
  const gateReasons = proposalGate(event, record);
  if (gateReasons.length) {
    appendFixAttempt(record, {
      attemptedAt: new Date().toISOString(),
      action: "apply",
      ok: false,
      summary: "Automatic preparation stopped at the deterministic proposal gate.",
      details: gateReasons.join(" "),
    });
    record.updatedAt = new Date().toISOString();
    updateFixQualityGate(record);
    await save(store, record);
    return { advanced: false, status: "review", message: gateReasons.join(" ") };
  }

  const config = getRepoConfigForApp(record.appName);
  if (!config) return { advanced: false, status: "error", message: `No repository mapping for ${record.appName}.` };

  try {
    const repoPath = await ensureRepoReady(config, env);
    const current = await captureRepoSnapshot(repoPath);
    if (current.dirty) throw new Error("Target repository has uncommitted changes.");
    if (record.repoSnapshot?.headCommit && current.headCommit && current.headCommit !== record.repoSnapshot.headCommit) {
      throw new Error(`Repair snapshot is stale: repo moved from ${record.repoSnapshot.headCommit.slice(0, 12)} to ${current.headCommit.slice(0, 12)}.`);
    }

    const branch = buildFixBranchName(config, record.appName, record.fingerprint);
    await checkoutFixBranch(repoPath, branch);
    await writeRepoFiles(repoPath, record.changes.map((change) => ({ path: change.path, content: change.content })));
    record.status = "applied";
    record.updatedAt = new Date().toISOString();
    record.lastError = undefined;
    appendFixAttempt(record, {
      attemptedAt: record.updatedAt,
      action: "apply",
      ok: true,
      summary: `Applied ${record.changes.length} proposed file change(s) on ${branch}.`,
    });
    updateFixQualityGate(record);
    await save(store, record);

    await ensureRepoDependencies(repoPath, config.installCommand);
    const commandResults = await runCheckCommands(repoPath, config.checkCommands);
    record.checkResult = {
      ranAt: new Date().toISOString(),
      ok: commandResults.every((result) => result.exitCode === 0),
      commandResults,
    };
    record.status = record.checkResult.ok ? "checked" : "error";
    record.updatedAt = new Date().toISOString();
    record.lastError = record.checkResult.ok ? undefined : commandResults.find((result) => result.exitCode !== 0)?.output.slice(-4000);
    appendFixAttempt(record, {
      attemptedAt: record.updatedAt,
      action: "check",
      ok: record.checkResult.ok,
      summary: record.checkResult.ok ? "Configured repository checks passed." : "Configured repository checks failed.",
      details: commandResults.map((result) => `${result.command} => ${result.exitCode}`).join(" | "),
    });
    updateFixQualityGate(record);
    await save(store, record);
    if (!record.checkResult.ok) return { advanced: false, status: "error", message: "Athena produced a patch, but repository validation failed." };

    if (!hasWorkingTreeChanges || !(await hasWorkingTreeChanges(repoPath))) {
      return { advanced: false, status: "handled", message: "The proposed change was already present after repository reconciliation." };
    }
    const pushed = await pushRepoBranch(repoPath, branch, `athena repair: ${record.appName} ${record.fingerprint}`, env);
    record.pushResult = {
      pushedAt: new Date().toISOString(),
      branch: pushed.branch,
      commit: pushed.commit,
      output: pushed.output.slice(-4000),
    };
    record.status = "pushed";
    record.updatedAt = new Date().toISOString();
    appendFixAttempt(record, {
      attemptedAt: record.updatedAt,
      action: "push",
      ok: true,
      summary: `Pushed validated repair branch ${pushed.branch}.`,
      details: pushed.commit,
    });
    updateFixQualityGate(record);

    const requested = await requestRepairApproval(record, env);
    await save(store, record);
    if (!requested) {
      return {
        advanced: false,
        status: record.status,
        message: `Validated branch was pushed, but the final approval gate is not ready (${record.qualityGate?.verdict || "unknown"}).`,
      };
    }
    return { advanced: true, status: "awaiting_approval", message: "Validated repair was pushed and sent to the owner approval DM." };
  } catch (error) {
    record.status = "error";
    record.updatedAt = new Date().toISOString();
    record.lastError = error instanceof Error ? error.message : String(error);
    updateFixQualityGate(record);
    await save(store, record);
    return { advanced: false, status: "error", message: record.lastError };
  }
}
