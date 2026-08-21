import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function patch(relative, mutate) {
  const file = path.join(root, relative);
  const before = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const after = mutate(before);
  if (after !== before) fs.writeFileSync(file, after, 'utf8');
}

patch('src/mcpControlServer.ts', (source) => {
  let next = source;
  if (!next.includes('from "./ownerRuntimeOps.js"')) {
    const marker = 'import { getQuackverseArtInventory, readQuackverseArtAsset } from "./quackverseFlyArt.js";\n';
    if (!next.includes(marker)) throw new Error('owner runtime MCP import marker missing');
    next = next.replace(marker, marker + 'import { getSignalHintHistory, runOwnerRotation } from "./ownerRuntimeOps.js";\n');
  }
  if (!next.includes('{ name: "run_rotation"')) {
    const marker = '    { name: "list_fly_app_states", title: "List managed Fly app states"';
    const index = next.indexOf(marker);
    if (index < 0) throw new Error('owner runtime MCP tool marker missing');
    const block = [
      '    { name: "run_rotation", title: "Run managed Fly rotation", description: "Run one tracked Rotator cycle across the configured managed Fly apps and return the per-app result plus persisted runtime state. Requires SPMT admin or owner.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } },',
      '    { name: "get_signal_history", title: "Read Signal hint history", description: "Read the persisted StreamWeaver Signal hint history and next scheduler time through a fixed read-only Fly Machine operation. Requires SPMT admin or owner; accepts no app, path, or command input.", inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false }, annotations: readOnlyAnnotations },',
    ].join('\n') + '\n';
    next = next.slice(0, index) + block + next.slice(index);
  }
  for (const tool of ['run_rotation', 'get_signal_history']) {
    const line = `    "${tool}",\n`;
    if (!next.includes(line)) {
      const marker = '    "list_fly_app_states",\n';
      if (!next.includes(marker)) throw new Error('owner runtime MCP admin marker missing');
      next = next.replace(marker, line + marker);
    }
  }
  if (!next.includes('if (name === "run_rotation")')) {
    const marker = '  if (name === "list_fly_app_states") {';
    if (!next.includes(marker)) throw new Error('owner runtime MCP executor marker missing');
    const block = [
      '  if (name === "run_rotation") return { status: 200, payload: await runOwnerRotation(env) };',
      '  if (name === "get_signal_history") return { status: 200, payload: await getSignalHintHistory(args, env) };',
    ].join('\n') + '\n';
    next = next.replace(marker, block + marker);
  }
  return next;
});

console.log('Owner runtime MCP tools patched.');
