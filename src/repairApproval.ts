import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appendFixAttempt, FixRecord, FixStore, getFixStoreFile } from "./fixStore.js";
import { getRepoConfigForApp } from "./repoMap.js";
import { ensureRepoReady } from "./repoOps.js";
import { redactSensitiveText } from "./redaction.js";

const execFileAsync = promisify(execFile);
const VERIFY_INTERVAL_MS = 10_000;
const VERIFY_TIMEOUT_MS = 20 * 60_000;
const WORKFLOW_DISCOVERY_GRACE_MS = 90_000;
const activeDeployments = new Set<string>();

function safe(value: unknown, max = 4000) {
  return redactSensitiveText(String(value ?? "")).slice(0, max);
}

function repoSlug(record: FixRecord) {
  const config = getRepoConfigForApp(record.appName);
  if (!config) throw new Error(`No repository mapping for ${record.appName}`);
  return new URL(config.repoUrl).pathname.replace(/^\//, "").replace(/\.git$/, "");
}

function githubToken(env: NodeJS.ProcessEnv) {
  const token = String(env.GITHUB_TOKEN || "").trim();
  if (!token) throw new Error("GITHUB_TOKEN is not configured");
  return token;
}

async function githubRequest(env: NodeJS.ProcessEnv, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${githubToken(env)}`,
      "content-type": "application/json",
      "user-agent": "athena-repair-approval",
      "x-github-api-version": "2022-11-28",
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.message || `GitHub HTTP ${response.status}`);
  return payload;
}

function publicBaseUrl(env: NodeJS.ProcessEnv) {
  return String(env.PUBLIC_DASHBOARD_URL || `https://${env.FLY_APP_NAME || "mtman-machine-rotator"}.fly.dev`).replace(/\/$/, "");
}

function approvalUrl(env: NodeJS.ProcessEnv, fixId: string, action: "approve" | "deny") {
  const url = new URL("/athena/repair-decision", publicBaseUrl(env));
  url.searchParams.set("fix", fixId);
  url.searchParams.set("action", action);
  return url.toString();
}

function dshOwnerDmUrl(env: NodeJS.ProcessEnv) {
  return String(env.DISCORD_STREAM_HUB_URL || env.DSH_BASE_URL || "https://discord-stream-hub-new.fly.dev")
    .replace(/\/$/, "") + "/api/internal/owner-dm";
}

function legacyDshCredential(env: NodeJS.ProcessEnv) {
  return String(env.SPMT_API_KEY || env.SPMT_PLATFORM_API_KEY || "").trim();
}

function repairReport(record: FixRecord) {
  const checks = record.checkResult?.commandResults || [];
  const sections = [
    `Athena repair: ${record.id}`,
    `App: ${record.appName}`,
    `Repository: ${record.repoLabel || record.repoId || "unknown"}`,
    `State: ${record.status}`,
    `Quality gate: ${record.qualityGate?.verdict || "unknown"} ${record.qualityGate?.overallConfidence ?? "?"}%`,
    "",
    "Diagnosis:",
    safe(record.diagnosis || record.summary || "No diagnosis recorded.", 8000),
    "",
    "Changed files:",
    ...(record.changes.length ? record.changes.map((change) => `- ${change.path}: ${change.reason}`) : ["None"]),
    "",
    "Validation:",
    ...(checks.length ? checks.map((check) => `${check.exitCode === 0 ? "PASS" : "FAIL"} ${check.command}\n${safe(check.output, 5000)}`) : ["No checks recorded."]),
    "",
    "Proposed code:",
    ...record.changes.flatMap((change) => [
      `\n--- ${change.path} ---`,
      safe(change.content, 20_000),
    ]),
  ];
  return sections.join("\n").slice(0, 450_000);
}

async function sendApprovalDm(record: FixRecord, env: NodeJS.ProcessEnv) {
  const credential = legacyDshCredential(env);
  if (!credential) throw new Error("No DSH owner-DM compatibility credential is configured");
  const report = repairReport(record);
  const message = [
    `Athena has a validated repair waiting for your approval.`,
    `App: **${record.appName}**`,
    `Fix: **${record.id}**`,
    `Quality gate: **${record.qualityGate?.verdict || "unknown"}** (${record.qualityGate?.overallConfidence ?? "?"}%)`,
    `Changed files: **${record.changes.length}**`,
    `Checks: **${record.checkResult?.commandResults.filter((item) => item.exitCode === 0).length || 0}/${record.checkResult?.commandResults.length || 0} passed**`,
  ].join("\n");
  const response = await fetch(dshOwnerDmUrl(env), {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      message,
      fileName: `${record.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`,
      fileContent: report,
      buttons: [
        { label: "Approve & Deploy", url: approvalUrl(env, record.id, "approve"), style: 3 },
        { label: "Deny / Hold", url: approvalUrl(env, record.id, "deny"), style: 4 },
      ],
      embed: {
        title: "Athena repair approval required",
        description: safe(record.summary || record.diagnosis || "Validated repair is ready for review.", 3000),
        fields: [
          { name: "App", value: record.appName, inline: true },
          { name: "State", value: "awaiting approval", inline: true },
          { name: "Quality", value: `${record.qualityGate?.verdict || "unknown"} · ${record.qualityGate?.overallConfidence ?? "?"}%`, inline: true },
          { name: "Changed files", value: record.changes.map((item) => `\`${item.path}\``).join("\n").slice(0, 1000) || "None", inline: false },
          { name: "Checks", value: checksSummary(record), inline: false },
        ],
        footer: "The attached report contains the proposed code and validation output.",
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(payload?.error || `DSH owner DM returned ${response.status}`);
  return { channelId: String(payload?.channelId || ""), messageId: String(payload?.messageId || "") };
}

function checksSummary(record: FixRecord) {
  const checks = record.checkResult?.commandResults || [];
  if (!checks.length) return "No checks recorded.";
  return checks.map((check) => `${check.exitCode === 0 ? "✅" : "❌"} ${check.command}`).join("\n").slice(0, 1000);
}

export async function requestRepairApproval(record: FixRecord, env: NodeJS.ProcessEnv = process.env) {
  if (!record.checkResult?.ok) return false;
  if (!record.pushResult?.branch || !record.pushResult.commit) return false;
  if (!record.qualityGate || !["ready", "verified"].includes(record.qualityGate.verdict)) return false;
  if (record.approval?.status === "awaiting_approval" && record.approval.dm?.messageId) return false;

  const requestedAt = new Date().toISOString();
  record.status = "awaiting_approval";
  record.updatedAt = requestedAt;
  record.approval = { status: "awaiting_approval", requestedAt };
  appendFixAttempt(record, {
    attemptedAt: requestedAt,
    action: "approval-request",
    ok: true,
    summary: "Repair passed checks and is waiting for owner approval.",
  });

  const delivered = await sendApprovalDm(record, env);
  record.approval.dm = { ...delivered, sentAt: new Date().toISOString() };
  record.updatedAt = new Date().toISOString();
  return true;
}

async function ensurePullRequest(record: FixRecord, env: NodeJS.ProcessEnv) {
  if (record.approval?.pullRequest?.number) return record.approval.pullRequest;
  if (!record.pushResult?.branch || !record.pushResult.commit) throw new Error("Repair branch has not been pushed");
  const repo = repoSlug(record);
  const payload = await githubRequest(env, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({
      title: `Athena repair: ${record.appName} ${record.fingerprint}`,
      head: record.pushResult.branch,
      base: "main",
      draft: false,
      body: [
        "## Athena repair",
        "",
        safe(record.summary || record.diagnosis || "Automated repair proposal.", 5000),
        "",
        "## Changed files",
        ...record.changes.map((change) => `- \`${change.path}\` — ${safe(change.reason, 500)}`),
        "",
        "## Validation",
        ...(record.checkResult?.commandResults || []).map((check) => `- ${check.exitCode === 0 ? "Passed" : "Failed"}: \`${check.command}\``),
        "",
        "Owner approval was recorded through the SPMT-authenticated Athena repair gate.",
      ].join("\n"),
    }),
  });
  const pullRequest = {
    number: Number(payload.number),
    url: String(payload.html_url || ""),
    branch: record.pushResult.branch,
    commit: record.pushResult.commit,
  };
  if (!pullRequest.number || !pullRequest.url) throw new Error("GitHub did not create the repair pull request");
  if (!record.approval) record.approval = { status: "approved" };
  record.approval.pullRequest = pullRequest;
  return pullRequest;
}

async function workflowRuns(repo: string, sha: string, env: NodeJS.ProcessEnv) {
  const payload = await githubRequest(env, `/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=20`);
  return Array.isArray(payload?.workflow_runs) ? payload.workflow_runs as any[] : [];
}

async function verifyDeployment(record: FixRecord, repo: string, sha: string, env: NodeJS.ProcessEnv, save: () => Promise<void>) {
  const started = Date.now();
  while (Date.now() - started < VERIFY_TIMEOUT_MS) {
    const runs = await workflowRuns(repo, sha, env).catch(() => [] as any[]);
    const meaningful = runs.filter((run) => !/retain newest merged branch backup/i.test(String(run.name || "")));
    if (meaningful.length) {
      const failed = meaningful.find((run) => run.status === "completed" && run.conclusion && !["success", "neutral", "skipped"].includes(String(run.conclusion)));
      const pending = meaningful.find((run) => run.status !== "completed");
      const selected = failed || pending || meaningful[0];
      if (!record.approval) record.approval = { status: "deploying" };
      record.approval.workflow = {
        id: Number(selected.id || 0),
        name: String(selected.name || "GitHub Actions"),
        status: String(selected.status || "unknown"),
        conclusion: selected.conclusion ?? null,
        url: String(selected.html_url || ""),
      };
      record.updatedAt = new Date().toISOString();
      await save();
      if (failed) throw new Error(`Deployment workflow failed: ${failed.name || failed.id} (${failed.conclusion})`);
      if (!pending && meaningful.every((run) => ["success", "neutral", "skipped"].includes(String(run.conclusion || "")))) return;
    } else if (Date.now() - started >= WORKFLOW_DISCOVERY_GRACE_MS) {
      throw new Error("No deployment workflow was discovered for the merged repair commit");
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFY_INTERVAL_MS));
  }
  throw new Error("Deployment verification timed out");
}

async function deployApprovedRepair(record: FixRecord, env: NodeJS.ProcessEnv) {
  if (activeDeployments.has(record.id)) return;
  activeDeployments.add(record.id);
  const store = await FixStore.load(getFixStoreFile(env));
  const save = async () => { store.upsert(record); await store.save(); };
  try {
    const pull = await ensurePullRequest(record, env);
    const repo = repoSlug(record);
    record.status = "deploying";
    if (!record.approval) record.approval = { status: "deploying" };
    record.approval.status = "deploying";
    record.approval.message = `PR #${pull.number} is merging and deployment is being verified.`;
    record.updatedAt = new Date().toISOString();
    await save();

    const merged = await githubRequest(env, `/repos/${repo}/pulls/${pull.number}/merge`, {
      method: "PUT",
      body: JSON.stringify({ merge_method: "squash" }),
    });
    if (!merged?.merged || !merged?.sha) throw new Error(merged?.message || "GitHub did not merge the repair pull request");
    record.approval.mergeCommit = String(merged.sha);
    appendFixAttempt(record, {
      attemptedAt: new Date().toISOString(),
      action: "merge",
      ok: true,
      summary: `Merged repair PR #${pull.number}.`,
      details: String(merged.sha),
    });
    await save();

    await verifyDeployment(record, repo, String(merged.sha), env, save);
    record.status = "deployed";
    record.approval.status = "deployed";
    record.approval.message = "Repair merged and deployment workflows completed successfully.";
    record.updatedAt = new Date().toISOString();
    appendFixAttempt(record, {
      attemptedAt: record.updatedAt,
      action: "deploy",
      ok: true,
      summary: "Deployment workflows completed successfully.",
    });
    await save();
  } catch (error) {
    record.status = "error";
    if (!record.approval) record.approval = { status: "failed" };
    record.approval.status = "failed";
    record.approval.message = safe(error instanceof Error ? error.message : error, 1200);
    record.lastError = record.approval.message;
    record.updatedAt = new Date().toISOString();
    appendFixAttempt(record, {
      attemptedAt: record.updatedAt,
      action: "deploy",
      ok: false,
      summary: "Approved repair failed during merge/deployment.",
      details: record.lastError,
    });
    await save();
  } finally {
    activeDeployments.delete(record.id);
  }
}

export async function decideRepairApproval(fixId: string, action: "approve" | "deny", actor: string, env: NodeJS.ProcessEnv = process.env) {
  const store = await FixStore.load(getFixStoreFile(env));
  const record = store.get(fixId);
  if (!record) throw new Error(`Repair ${fixId} was not found`);
  if (record.approval?.status !== "awaiting_approval") throw new Error(`Repair is not awaiting approval (state=${record.approval?.status || record.status})`);
  const decidedAt = new Date().toISOString();
  if (action === "deny") {
    record.status = "denied";
    record.approval.status = "denied";
    record.approval.decidedAt = decidedAt;
    record.approval.decidedBy = actor;
    record.approval.message = "Owner denied this repair. The branch is retained for review.";
    record.updatedAt = decidedAt;
    appendFixAttempt(record, { attemptedAt: decidedAt, action: "deny", ok: true, summary: "Owner denied the repair." });
    store.upsert(record);
    await store.save();
    return record;
  }

  record.approval.status = "approved";
  record.approval.decidedAt = decidedAt;
  record.approval.decidedBy = actor;
  record.approval.message = "Owner approved merge and deployment.";
  record.updatedAt = decidedAt;
  appendFixAttempt(record, { attemptedAt: decidedAt, action: "approve", ok: true, summary: "Owner approved merge and deployment." });
  store.upsert(record);
  await store.save();
  void deployApprovedRepair(record, env);
  return record;
}

export async function listPendingRepairApprovals(env: NodeJS.ProcessEnv = process.env) {
  const store = await FixStore.load(getFixStoreFile(env));
  return store.list().filter((record) => record.approval?.status === "awaiting_approval");
}
