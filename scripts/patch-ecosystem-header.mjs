import { readFile, writeFile } from 'node:fs/promises';

const path = 'src/spmtSharedUi.ts';
let source = await readFile(path, 'utf8');
if (source.includes('https://spmt.live/shared/ecosystem-header.js')) {
  console.log('canonical SPMT ecosystem header already installed in shared web UI');
  process.exit(0);
}

const marker = '</style><meta name="spmt-host-app" content="${safeApp}">`';
if (!source.includes(marker)) {
  throw new Error('shared UI header marker missing');
}
source = source.replace(
  marker,
  '</style><script src="https://spmt.live/shared/ecosystem-header.js" data-app="${safeApp}" defer></script><meta name="spmt-host-app" content="${safeApp}">`',
);
await writeFile(path, source, 'utf8');
console.log('installed canonical SPMT ecosystem header in shared web UI');
