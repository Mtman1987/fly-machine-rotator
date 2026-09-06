import {describe,it,expect} from "vitest";
import {requestOpenAiRepairPlanJson} from "../src/openAiRepairPlanner.js";
describe("Stella hosted repair planning",()=>{
 it("uses Sol Responses with a bounded budget and keeps credentials out of context",async()=>{
  let payload:any;
  const result=await requestOpenAiRepairPlanJson("Fix the supplied incident",{OPENAI_API_KEY:"mock-secret"},1000,async(url,init)=>{expect(url).toBe("https://api.openai.com/v1/responses");payload=JSON.parse(String(init?.body));expect(init?.redirect).toBe("error");return Response.json({status:"completed",output:[{content:[{type:"output_text",text:'{"summary":"ready","changes":[]}'}]}]});});
  expect(JSON.parse(result).summary).toBe("ready");expect(payload.model).toBe("gpt-5.6-sol");expect(payload.store).toBe(false);expect(JSON.stringify(payload)).not.toContain("mock-secret");expect(payload.instructions).toContain("Stella");
 });
 it("rejects truncated output and does not disclose provider error bodies",async()=>{
  await expect(requestOpenAiRepairPlanJson("task",{},1000,async()=>Response.json({status:"incomplete"}))).rejects.toThrow("did not complete");
  await expect(requestOpenAiRepairPlanJson("task",{},1000,async()=>new Response("sensitive provider body",{status:401}))).rejects.toThrow("HTTP 401");
 });
});
