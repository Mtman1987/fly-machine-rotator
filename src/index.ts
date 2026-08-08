import "./spmtLlmRuntime.js";
import { startAthenaSpmtGateway } from "./athenaSpmtGateway.js";
import { startAutoRotationLoop } from "./autoRotate.js";
import { startDashboardServer } from "./dashboardServer.js";
import { startDshMtFixItOuterGateway } from "./dshMtFixitGateway.js";
import { runLogMonitor } from "./logMonitor.js";
import { executeTrackedRotation } from "./rotationControl.js";
import { withCodexWorkerAuth } from "./codexWorkerAuth.js";

function startWebStack(env: NodeJS.ProcessEnv = process.env) {
  const stackEnv = withCodexWorkerAuth(env);
  const publicPort = Number(stackEnv.PORT ?? stackEnv.ROTATOR_DASHBOARD_PORT ?? 8080);
  const athenaPort = Number(stackEnv.ROTATOR_ATHENA_GATEWAY_PORT ?? publicPort + 1);
  const dashboardPort = Number(stackEnv.ROTATOR_INTERNAL_DASHBOARD_PORT ?? publicPort + 2);
  const internalEnv = {
    ...stackEnv,
    PORT: String(dashboardPort),
    ROTATOR_DASHBOARD_PORT: String(dashboardPort),
  };
  startDashboardServer(internalEnv);
  startAthenaSpmtGateway(stackEnv, dashboardPort, athenaPort);
  startDshMtFixItOuterGateway(stackEnv, dashboardPort, athenaPort, publicPort);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  if (command === "serve") {
    startWebStack(process.env);
    console.log("Fly Machine Rotator dashboard and Athena Coder are running.");
    await new Promise(() => undefined);
    return;
  }
  if (command === "monitor") {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig(process.argv.slice(3));
    startWebStack(process.env);
    void startAutoRotationLoop(process.argv.slice(3));
    await runLogMonitor({
      appNames: config.appNames,
      token: process.env.FLY_LOG_TOKEN ?? config.flyApiToken,
      orgSlug: process.env.FLY_ORG ?? process.env.ORG ?? "mtman-new",
      discordWebhookUrl: config.discordWebhookUrl,
      dedupeFile: process.env.LOG_ERROR_DEDUPE_FILE ?? "/data/error-fingerprints.json",
      historyFile: process.env.LOG_ERROR_HISTORY_FILE ?? "/data/error-history.json",
      reportMessageFile: process.env.DISCORD_ERROR_REPORT_MESSAGE_FILE ?? "/data/discord-error-report-message.json",
      baselineFile: process.env.ROTATOR_ERROR_BASELINE_FILE ?? "/data/error-baseline.json",
      contextLines: Number(process.env.LOG_CONTEXT_LINES ?? 8),
      pollIntervalMs: Number(process.env.LOG_POLL_INTERVAL_MS ?? 60_000),
      sampleDurationMs: Number(process.env.LOG_SAMPLE_DURATION_MS ?? 15_000)
    });
    return;
  }
  if (command !== "run") {
    throw new Error(`Unknown command "${command}". Use "run", "monitor", or "serve".`);
  }

  const results = await executeTrackedRotation(process.argv.slice(3), process.env, "cli");
  if (results.some((result) => !result.success)) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
