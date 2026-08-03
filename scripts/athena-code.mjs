#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2);
const baseUrl = String(process.env.SPMT_BASE_URL || "https://spmt.live").replace(/\/$/, "");
const secret = String(process.env.SPMT_CODEX_SERVICE_SECRET || "").trim();

if (!secret) fail("Set SPMT_CODEX_SERVICE_SECRET to the existing SPMT Codex gateway secret.");

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json, text/plain",
      "content-type": "application/json",
      "x-spmt-codex-secret": secret,
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) fail(`${response.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function usage() {
  console.log(`Athena SPMT code CLI

Usage:
  npm run athena -- repos
  npm run athena -- submit <app-name> <description>
  npm run athena -- status <job-id>
  npm run athena -- diff|checks|response <job-id>
  npm run athena -- publish <job-id>

The CLI calls SPMT. Fly, GitHub, and OpenAI credentials remain on their servers.`);
}

let result;
if (command === "repos") {
  result = await request("/api/athena/code-references");
} else if (command === "submit") {
  const [appName, ...descriptionParts] = args;
  const description = descriptionParts.join(" ").trim();
  if (!appName || !description) fail("submit requires <app-name> and <description>.");
  result = await request("/api/athena/code-jobs", {
    method: "POST",
    body: JSON.stringify({ source: "athena-cli", reporter: "Mtman1987", appName, description }),
  });
} else if (command === "status") {
  if (!args[0]) fail("status requires <job-id>.");
  result = await request(`/api/athena/code-jobs/${encodeURIComponent(args[0])}`);
} else if (["diff", "checks", "response"].includes(command)) {
  if (!args[0]) fail(`${command} requires <job-id>.`);
  result = await request(`/api/athena/code-jobs/${encodeURIComponent(args[0])}/${command}`);
} else if (command === "publish") {
  if (!args[0]) fail("publish requires <job-id>.");
  result = await request(`/api/athena/code-jobs/${encodeURIComponent(args[0])}/publish`, { method: "POST", body: "{}" });
} else {
  usage();
  process.exit(command ? 1 : 0);
}

console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
