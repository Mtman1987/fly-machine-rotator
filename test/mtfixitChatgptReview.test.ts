import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) { return readFileSync(resolve(process.cwd(), path), 'utf8'); }

describe('Autonomous MtFixIt routing', () => {
  it('keeps new repairs owner-gated and lets exact known fixes deploy without ChatGPT', () => {
    const resolution = source('src/mtfixitResolution.ts');
    expect(resolution).toContain('status: known ? "deploying" : "awaiting_approval"');
    expect(resolution).toContain('if (known) void deployInBackground(job, env, dashboardPort, state)');
    expect(resolution).toContain('export async function applyMtFixItResolutionAction');
    expect(resolution).not.toContain('queueMtFixItForChatGpt');
    expect(resolution).not.toContain("status: 'awaiting_chatgpt'");
  });

  it('hourly diagnostics resolve validated jobs locally and DM the owner for new fixes', () => {
    const hourly = source('src/hourlyAthenaDiagnostic.ts');
    expect(hourly).toContain('applyMtFixItResolutionAction(job.id, "resolve", env, dashboardPort)');
    expect(hourly).toContain('mtfixit_approve:');
    expect(hourly).toContain('Approve & Deploy');
    expect(hourly).toContain('deploying-known-fix');
    expect(hourly).not.toContain('Approve ChatGPT Repair');
    expect(hourly).not.toContain('approveChatGptHandoff');
  });

  it('does not re-enable the legacy MtFixIt ChatGPT rewrite during test/build patch chains', () => {
    const pkg = JSON.parse(source('package.json'));
    expect(pkg.scripts['patch:athena-repair']).not.toContain('patch-mtfixit-chatgpt-review.mjs');
  });
});
