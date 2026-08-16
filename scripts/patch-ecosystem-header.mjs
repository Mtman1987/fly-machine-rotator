import { readFile, writeFile } from 'node:fs/promises';

const path = 'src/spmtSharedUi.ts';
let source = await readFile(path, 'utf8');
const headerScript = '<script src="https://spmt.live/shared/ecosystem-header.js" data-app="${safeApp}" defer></script>';
const workspaceScript = '<script src="https://spmt.live/shared/workspace-controller.js" defer></script>';
const marker = '</style><meta name="spmt-host-app" content="${safeApp}">`';

if (!source.includes(headerScript)) {
  if (!source.includes(marker)) throw new Error('shared UI header marker missing');
  const replacement = '</style>' + headerScript + workspaceScript + '<meta name="spmt-host-app" content="${safeApp}">`';
  source = source.replace(marker, replacement);
} else if (!source.includes(workspaceScript)) {
  source = source.replace(headerScript, headerScript + workspaceScript);
} else {
  console.log('canonical SPMT ecosystem header and workspace controls already installed in shared web UI');
  process.exit(0);
}

await writeFile(path, source, 'utf8');
console.log('installed canonical SPMT ecosystem header and workspace controls in shared web UI');
