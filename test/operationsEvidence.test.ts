import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { clearObservationWindow } from "../src/observationWindow.js";
import { parseMachineLoad, MACHINE_LOAD_PROBE, collectMachineLoads } from "../src/machineLoads.js";
import { buildUnifiedPayload } from "../src/unifiedReport.js";
import { recordActualRepair } from "../src/repairComparison.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("fresh observation and operations evidence", () => {
  it("archives and clears incidents/dedupe without erasing approved repairs or coder history", async () => {
    const dir = await mkdtemp(join(tmpdir(),"observation-"));
    try {
      const env = { ROTATOR_ERROR_ARCHIVE_DIR: join(dir,"archives"), ROTATOR_ERROR_BASELINE_FILE:join(dir,"baseline.json"), LOG_ERROR_HISTORY_FILE:join(dir,"errors.json"), LOG_OBSERVATION_HISTORY_FILE:join(dir,"observations.json"), LOG_ERROR_DEDUPE_FILE:join(dir,"dedupe.json"), FIX_STORE_FILE:join(dir,"fixes.json") };
      for (const path of [env.LOG_ERROR_HISTORY_FILE,env.LOG_OBSERVATION_HISTORY_FILE,env.LOG_ERROR_DEDUPE_FILE]) await writeFile(path,JSON.stringify([{message:"Bearer privateCredential12345"}]));
      await writeFile(env.FIX_STORE_FILE,'[{"status":"deployed"}]');
      const window=await clearObservationWindow(env,new Date("2026-10-07T12:00:00Z"));
      expect(window.endsAt).toBe("2026-10-08T12:00:00.000Z");
      expect(window.clearedEvents).toBe(1); expect(window.clearedObservations).toBe(1);
      expect(await readFile(env.LOG_ERROR_HISTORY_FILE,"utf8")).toBe("[]");
      expect(await readFile(env.LOG_OBSERVATION_HISTORY_FILE,"utf8")).toBe("[]");
      expect(await readFile(env.FIX_STORE_FILE,"utf8")).toContain("deployed");
      expect(await readFile(join(window.archiveDir,"errors.redacted.json"),"utf8")).not.toContain("privateCredential12345");
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it("runs the actual probe and distinguishes busy time from stolen and waiting time", () => {
    const value=parseMachineLoad(execFileSync("sh",["-c",MACHINE_LOAD_PROBE],{encoding:"utf8"}));
    expect(value.cpus).toBeGreaterThan(0);
    expect(value.cpuBusyPercent!+value.cpuIdlePercent!+value.cpuStealPercent!+value.cpuWaitPercent!).toBeCloseTo(100,0);
    expect(() => parseMachineLoad(JSON.stringify({...value,cpuStealPercent:-1}))).toThrow();
    expect(() => parseMachineLoad(JSON.stringify({...value,cpuStealPercent:undefined}))).toThrow();
  });
  it("never starts a stopped machine or probes excluded partner apps, and preserves failed samples", async () => {
    const fetchMock=vi.fn(async (url: any) => {
      if(String(url).endsWith("/exec")) return new Response("",{status:503});
      return new Response(JSON.stringify([{id:"running",state:"started"},{id:"stopped",state:"stopped"}]),{status:200});
    });
    vi.stubGlobal("fetch",fetchMock);
    const rows=await collectMachineLoads({FLY_ROTATOR_APPS:"test-app,mika-bot,aetherra",FLY_API_TOKEN:"test"},fetchMock);
    expect(rows).toHaveLength(2);
    expect(rows.find(r=>r.machineId==="running")?.unavailable).toBeTruthy();
    expect(rows.find(r=>r.machineId==="stopped")?.cpuStealPercent).toBeUndefined();
    expect(fetchMock.mock.calls.filter(call=>String(call[0]).endsWith("/exec"))).toHaveLength(1);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toMatch(/mika|aetherra|\/start/);
  });
  it("keeps embeds within Discord limits and includes the window and resource readings", () => {
    const machines=Array.from({length:14},(_,i)=>({appName:"streamweaver-new",machineId:String(i),state:"started",sampledAt:new Date().toISOString(),cpus:2,cpuBusyPercent:5,cpuStealPercent:12,cpuWaitPercent:0,load1:0.1,load5:0.2,load15:0.3,ramUsedMb:256,ramTotalMb:1024}));
    const payload=buildUnifiedPayload([],[],{updatedAt:"",currentStatus:"idle",totalRuns:0,lastRunLines:[]},undefined,"https://example.test",[],undefined,machines,{startedAt:"2026-10-07T12:00:00Z",endsAt:"2026-10-08T12:00:00Z",archiveDir:"",clearedEvents:0,clearedObservations:0}) as any;
    const fields=payload.embeds[0].fields;
    expect(JSON.stringify(fields)).toContain("steal 12%");
    expect(JSON.stringify(fields)).toContain("Observation start:");
    expect(fields.every((f:any)=>f.value.length<=1024)).toBe(true);
    expect(fields.reduce((n:number,f:any)=>n+f.name.length+f.value.length,0)).toBeLessThan(5500);
  });
  it("refuses to record an actual fix against another commit or a failed deployment", async () => {
    const mock=vi.fn(async()=>new Response(JSON.stringify({head_sha:"b".repeat(40),status:"completed",conclusion:"failure",head_branch:"main",repository:{full_name:"Mtman1987/streamweaver"}}),{status:200}));
    vi.stubGlobal("fetch",mock);
    await expect(recordActualRepair({appName:"streamweaver-new",fingerprint:"a".repeat(16),commit:"a".repeat(40),workflowRunId:1},{FLY_ROTATOR_APPS:"streamweaver-new",GITHUB_TOKEN:"test"})).rejects.toThrow("successful main deployment");
    expect(mock).toHaveBeenCalledTimes(1);
  });
});
