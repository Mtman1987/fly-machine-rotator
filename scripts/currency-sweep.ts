import { readFile } from "node:fs/promises";
import { scanCurrencySweepLogsV1 } from "../src/currencySweep.js";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run currency:sweep:sample -- <log-sample.txt>");
  process.exitCode = 2;
} else {
  const contents = await readFile(inputPath, "utf8");
  const report = scanCurrencySweepLogsV1(contents.split(/\r?\n/));
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}
