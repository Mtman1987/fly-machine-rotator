import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string) { return readFileSync(resolve(process.cwd(), path), 'utf8'); }

describe('MtFixIt ChatGPT review routing', () => {
  it('queues validated MtFixIt repairs through the ChatGPT handoff instead of direct deployment', () => {
    const resolution = source('src/mtfixitResolution.ts');
    expect(resolution).toContain('queueMtFixItForChatGpt');
    expect(resolution).toContain('status: \'awaiting_chatgpt\'');
    expect(resolution).toContain("approveChatGptHandoff(env, handoff.id, 'mtfixit-standing-policy')");
    expect(resolution).toContain('mtfixit: true');
    expect(resolution).toContain('draftPullRequest: pullRequest');
    expect(resolution).toContain('return queueMtFixItForChatGpt(job, env, dashboardPort, signature)');
  });

  it('synchronizes ChatGPT completion back into MtFixIt lifecycle state', () => {
    const control = source('scripts/github-control-chat.mjs');
    const workflow = source('.github/workflows/github-rotator-control.yml');
    expect(control).toContain("r.userContext&&r.userContext.mtfixit");
    expect(control).toContain("state.status=outcome==='success'?'deployed':'failed'");
    expect(control).toContain('state.chatgptHandoffId=r.id');
    expect(control).toContain('resultStatus=outcome');
    expect(workflow).toContain('[success|failed]');
    expect(workflow).toContain("payload.outcome = maybeOutcome === 'failed' || maybeOutcome === 'success'");
  });

  it('runs the MtFixIt review patch in every validation/build patch chain', () => {
    const pkg = JSON.parse(source('package.json'));
    expect(pkg.scripts['patch:athena-repair']).toContain('patch-mtfixit-chatgpt-review.mjs');
  });
});
