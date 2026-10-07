import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { listProviders, runAthenaProvider } from "../src/athenaChat.js";
import { requestFixPlan } from "../src/aiFixer.js";
const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function config() {
  const root=await mkdtemp(join(tmpdir(),"free-chat-policy-"));dirs.push(root);
  const key="test-free-credential";
  await writeFile(join(root,"ai-provider-policy.json"),JSON.stringify({provider:"gemini",geminiFreeTierVerified:true,paidRoutesEnabled:false,keyFingerprint:createHash("sha256").update(key).digest("hex")}));
  return {CODEX_FIXER_DATA_DIR:root,GEMINI_API_KEY:key,OPENAI_API_KEY:"test-paid-key",EDENAI_API_KEY:"test-other-paid-key"};
}
describe("Other AI paths preserve free-only policy without private disclosure",()=>{
  it("blocks private chat pending explicit authorization instead of calling a paid or external provider",async()=>{
    const env=await config();
    expect((await listProviders(env)).filter(p=>p.ready)).toEqual([]);
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await expect(runAthenaProvider("openai",[{role:"user",content:"private-test-message"}],{},env)).rejects.toThrow("requires explicit authorization");
    await expect(runAthenaProvider("gemini",[{role:"user",content:"private-test-message"}],{},env)).rejects.toThrow("requires explicit authorization");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps raw incident planning local instead of calling paid or external providers",async()=>{
    const env=await config(),fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    const event={appName:"test-owned-app",message:"timeout private-incident-marker"} as any;
    const plan=await requestFixPlan("owned app","/tmp/public-repo",event,[],env,{});
    expect(plan.changes).toEqual([]);
    expect(plan.diagnosis).toContain("use the verified free public-source coder");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refuses every route when the verified key changes",async()=>{
    const env={...await config(),GEMINI_API_KEY:"different-key"},fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    await expect(runAthenaProvider("openai",[{role:"user",content:"hello"}],{},env)).rejects.toThrow("verified credential changed");
    await expect(requestFixPlan("app","/tmp/repo",{message:"timeout",appName:"app"} as any,[],env,{})).rejects.toThrow("verified credential changed");
    expect(fetcher).not.toHaveBeenCalled();
  });
});
