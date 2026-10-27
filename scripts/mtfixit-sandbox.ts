import { mkdir, writeFile } from "node:fs/promises";
import { buildUnifiedPayload } from "../src/unifiedReport.js";
import type { RotatorRuntimeState } from "../src/runtimeState.js";

const now = new Date().toISOString();
const state: RotatorRuntimeState = {
  updatedAt: now, totalRuns: 14, currentStatus: "success", lastTrigger: "sandbox",
  lastStartedAt: now, lastFinishedAt: now, lastDurationMs: 1200, nextRunAt: now,
  lastRunLines: ["OK mock-lounge restart", "OK mock-chat handoff"]
};
const cycles = [
  ...[1, 2, 3].map(() => ({ appName: "mock-chat", fingerprint: "not-seen-456", status: "failed", summary: "Not seen in the latest log pass" })),
  ...[1, 2, 3].map((n) => ({ appName: "mock-lounge", fingerprint: "still-failing-123", status: "failed", summary: `Attempt ${n} failed${n === 3 ? "; Athena confidence: 87%" : ""}` })),
  { appName: "mock-streamweaver", fingerprint: "twitch-auth-789", status: "failed", summary: "Twitch OAuth refresh rejected; Athena confidence: 68%; retry with alternate credential diagnosis" }
];
const fixes = Array.from({ length: 23 }, (_, i) => ({ signature: `fix-${i}`, incidentFingerprint: `proven-${i}`, repoId: "mock", successfulDeploys: 1 }));
const payload = buildUnifiedPayload(
  [{ at: now, startedAt: now, finishedAt: now, results: [{ appName: "mock-lounge", success: true, mode: "restart", warnings: 0 }] }],
  [{ recordedAt: now, appName: "mock-lounge", fingerprint: "still-failing-123", message: "mock stream health check still failing", suggestion: "Inspect playback session", context: [] }],
  state, undefined, "https://example.invalid", [],
  { incidentId: "mock-lounge:still-failing-123", appName: "mock-lounge", fingerprint: "still-failing-123", rotationKey: "sandbox", attemptedAt: now, finishedAt: now, status: "failed", summary: "Mock incident still needs another repair attempt." },
  [], undefined, cycles, fixes
) as any;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fence = String.fromCharCode(96).repeat(3);
const stripCodeFence = (value: unknown) => { const lines = String(value ?? "").split("\n"); if (lines[0] === `${fence}text`) lines.shift(); if (lines.at(-1) === fence) lines.pop(); return lines.join("\n"); };
const fields = payload.embeds[0].fields.map((f: any) => `<section class="field ${f.inline ? "inline" : ""}"><h3>${escape(f.name)}</h3><pre>${escape(stripCodeFence(f.value))}</pre></section>`).join("");
const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MtFixIt Sandbox</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#202225;color:#dcddde;font:14px/1.45 system-ui,Arial}.layout{max-width:1360px;margin:auto;display:grid;grid-template-columns:2fr 1fr;gap:20px}.embed,.chat{background:#2f3136;border-radius:8px;padding:18px}.embed{border-left:5px solid #2ecc71}.title{font-size:20px;font-weight:700;margin-bottom:8px}.muted{color:#aeb0b5;font-size:12px}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:16px}.field{background:#202225;border-radius:5px;padding:12px;min-width:0}.field:not(.inline){grid-column:1/-1}h3{margin:0 0 8px;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;font:12px/1.45 ui-monospace,monospace}.message{padding:12px 0;border-bottom:1px solid #41434a}.message:last-child{border:0}.green{color:#57d38c}.red{color:#ff6b6b}.yellow{color:#ffd166}@media(max-width:900px){.layout{grid-template-columns:1fr}.fields{grid-template-columns:1fr}}
</style></head><body><main class="layout"><article class="embed"><div class="title">${escape(payload.embeds[0].title)}</div><div class="muted">Offline mock Discord embed • test data only</div><p>${escape(payload.embeds[0].description)}</p><div class="fields">${fields}</div></article><aside class="chat"><h2>Mock chat rooms</h2><div class="message"><b>#lounge</b> <span class="red">● Still failing</span><p>Stream health check fails after restart.</p><div class="muted">Attempt 3/3 • confidence 87% • blacklist red</div></div><div class="message"><b>#chat-tag</b> <span class="green">● Rotation success</span><p>Primary recovered in place.</p><div class="muted">Error not seen on last log pass • blacklist green</div></div><div class="message"><b>#streamweaver</b> <span class="yellow">● Retry 2/3</span><p>Authentication error still present.</p></div><div class="message"><b>Owner feedback</b><p>PASS records a proven fix. FAIL opens a modal for the remaining failure notes.</p></div></aside></main></body></html>`;
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/mtfixit-sandbox.html", html, "utf8");
await writeFile("artifacts/mtfixit-sandbox.json", JSON.stringify(payload, null, 2), "utf8");
console.log("Rendered mock Discord embed and mock chat-room preview.");
