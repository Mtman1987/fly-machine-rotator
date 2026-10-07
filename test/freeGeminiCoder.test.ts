import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { createFreeGeminiCoder, readFreeCoderPolicy, publicCoderTask, publicSourceContext } from "../src/freeGeminiCoder.js";
const env = { GEMINI_API_KEY: "test-credential-not-real" };
const policy = { provider: "gemini", geminiFreeTierVerified: true } as const;
const publicCommit = {repoUrl:"https://github.com/Mtman1987/chat-tag.git",commit:"a".repeat(40)};
const context = "\n\n--- src/server.ts ---\nexport const ready = true;";
const reply = () => new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:"private thought"},{text:'{"summary":"inspected","patch":""}'}]}}]}),{status:200});
function router(gemini: typeof fetch, isPublic = true): typeof fetch {
  return async (url, options) => {
    if (String(url).startsWith("https://api.github.com/repos/")) {
      expect((options?.headers as Record<string,string>)?.authorization).toBeUndefined();
      return new Response(JSON.stringify(String(url).includes("/git/commits/") ? {sha:publicCommit.commit} : {private:!isPublic,full_name:"Mtman1987/chat-tag"}),{status:200});
    }
    return gemini(url,options);
  };
}
describe("Verified free coder", () => {
  it("fails closed for missing, malformed, paid or unverified policies", async () => {
    const root=await mkdtemp(join(tmpdir(),"free-coder-"));
    try {
      const e={CODEX_FIXER_DATA_DIR:root};
      expect(await readFreeCoderPolicy(e)).toBeNull();
      for(const p of [{provider:"gemini",geminiFreeTierVerified:false,paidRoutesEnabled:false},{provider:"gemini",geminiFreeTierVerified:true,paidRoutesEnabled:true},{provider:"gemini",geminiFreeTierVerified:true}]) {
        await writeFile(join(root,"ai-provider-policy.json"),JSON.stringify(p));expect(await readFreeCoderPolicy(e)).toBeNull();
      }
      await writeFile(join(root,"ai-provider-policy.json"),JSON.stringify({...policy,paidRoutesEnabled:false}));
      expect(await readFreeCoderPolicy(e)).toEqual(policy);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it("requires verified policy and credential before making a request", async () => {
    const f=vi.fn();
    const generate=createFreeGeminiCoder();
    await expect(generate(env,"task",context,null,publicCommit,f)).rejects.toThrow("verified/configured");
    await expect(generate({},"task",context,policy,publicCommit,f)).rejects.toThrow("verified/configured");
    expect(f).not.toHaveBeenCalled();
  });
  it("refuses a private repository without transmitting source to Gemini", async () => {
    const gemini=vi.fn(async()=>reply());
    await expect(createFreeGeminiCoder()(env,"task",context,policy,publicCommit,router(gemini,false))).rejects.toThrow("private repositories");
    expect(gemini).not.toHaveBeenCalled();
  });
  it("sends only fixed error categories and excludes runtime/credential records", () => {
    const privateText="timeout for private-viewer-identifier";
    expect(publicCoderTask(privateText)).toContain("timeout");
    expect(publicCoderTask(privateText)).not.toContain("private-viewer-identifier");
    const source=context+"\n\n--- data/runtime/records.ts ---\nprivate-runtime\n\n--- tokens/user.md ---\nprivate-token";
    expect(publicSourceContext(source)).toContain("ready");
    expect(publicSourceContext(source)).not.toContain("private-runtime");
    expect(publicSourceContext(source)).not.toContain("private-token");
  });
  it("uses fixed Gemini endpoint, bounded public input, JSON response and ignores thoughts", async () => {
    const f=vi.fn(async()=>reply());
    const result=await createFreeGeminiCoder()(env,"timeout private-viewer",context+"x".repeat(100000),policy,publicCommit,router(f));
    expect(JSON.parse(result)).toEqual({summary:"inspected",patch:""});
    const [url,options]=f.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(options.redirect).toBe("error");
    const body=JSON.parse(String(options.body));
    expect(body.contents[0].parts[0].text.length).toBeLessThan(88000);
    expect(body.contents[0].parts[0].text).not.toContain("private-viewer");
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.maxOutputTokens).toBe(4000);
  });
  it("never records upstream bodies or credentials and backs off without a paid fallback", async () => {
    const f=vi.fn(async()=>new Response("provider secret "+env.GEMINI_API_KEY,{status:429}));
    const generate=createFreeGeminiCoder();
    await expect(generate(env,"task",context,policy,publicCommit,router(f))).rejects.toThrow("quota/rate limit");
    await expect(generate(env,"task",context,policy,publicCommit,router(f))).rejects.toThrow("cooldown");
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("rejects concurrent calls and recovers after completion", async () => {
    let resolve!: (value:Response)=>void;
    const generate=createFreeGeminiCoder();
    const pending=generate(env,"task",context,policy,publicCommit,router(()=>new Promise(r=>{resolve=r;})));
    await expect(generate(env,"other",context,policy,publicCommit)).rejects.toThrow("busy");
    while(!resolve)await Promise.resolve();
    resolve(reply());await pending;
    expect(await generate(env,"task",context,policy,publicCommit,router(async()=>reply()))).toContain("inspected");
  });
  it("bounds stalled response bodies even when abort is ignored", async () => {
    vi.useFakeTimers();
    try {
      const generate=createFreeGeminiCoder();
      const pending=generate(env,"task",context,policy,publicCommit,router(async()=>({ok:true,json:()=>new Promise(()=>{})} as Response)));
      const assertion=expect(pending).rejects.toThrow("deadline");
      await vi.advanceTimersByTimeAsync(45000);await assertion;
      expect(await generate(env,"task",context,policy,publicCommit,router(async()=>reply()))).toContain("inspected");
    }finally{vi.useRealTimers();}
  });
});
