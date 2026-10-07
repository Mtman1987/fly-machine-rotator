import { describe,it,expect } from "vitest";
import { mkdtemp,readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckCommands } from "../src/repoOps.js";
import { validationEnvironment } from "../src/validationEnvironment.js";
describe("coder validation environment",()=>{
 it("drops production authority and redirects report/state writes outside production",async()=>{
  const cwd=await mkdtemp(join(tmpdir(),"validation-"));
  const env=await validationEnvironment(cwd,{PATH:process.env.PATH,FLY_API_TOKEN:"private",GITHUB_TOKEN:"private",GEMINI_API_KEY:"private",DISCORD_WEBHOOK_URL:"private",DISCORD_ERROR_REPORT_MESSAGE_FILE:"/data/live-report.json",FLY_APP_NAME:"live-app"});
  expect(env).not.toHaveProperty("FLY_API_TOKEN");expect(env).not.toHaveProperty("DISCORD_WEBHOOK_URL");expect(env).not.toHaveProperty("GEMINI_API_KEY");expect(env).not.toHaveProperty("FLY_APP_NAME");
  expect(env.DISCORD_ERROR_REPORT_MESSAGE_FILE).not.toBe("/data/live-report.json");
  expect(env.DISCORD_ERROR_REPORT_MESSAGE_FILE).toContain("spmt-validation");
  const results=await runCheckCommands(cwd,[`node -e 'require("fs").writeFileSync(process.env.DISCORD_ERROR_REPORT_MESSAGE_FILE,JSON.stringify({messageId:"new-message"}));if(process.env.FLY_API_TOKEN||process.env.DISCORD_WEBHOOK_URL)process.exit(1)'`]);
  expect(results[0].exitCode).toBe(0);
  expect(await readFile(env.DISCORD_ERROR_REPORT_MESSAGE_FILE!,"utf8")).toContain("new-message");
 });
});
