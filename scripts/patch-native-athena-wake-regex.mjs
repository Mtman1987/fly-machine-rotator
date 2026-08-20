import { readFile, writeFile } from 'node:fs/promises';

const path = 'mobile/plugins/withMetaWearablesAndroid.js';
let source = await readFile(path, 'utf8');

const bad = 'val match = Regex("(?i)\\\\b(?:hey\\\\s+)?(?:athena|annie)\\\\b[:,]?\\\\s*(.*)$").find(text.trim()) ?: return';
const good = 'val match = Regex("(?i)\\\\\\\\b(?:hey\\\\\\\\s+)?(?:athena|annie)\\\\\\\\b[:,]?\\\\\\\\s*(.*)$").find(text.trim()) ?: return';

if (source.includes(good)) {
  console.log('native Athena wake Kotlin regex already hardened');
  process.exit(0);
}
if (!source.includes(bad)) {
  throw new Error('native Athena wake Kotlin regex marker missing');
}
source = source.replace(bad, good);
await writeFile(path, source, 'utf8');
console.log('hardened native Athena wake Kotlin regex escaping');
