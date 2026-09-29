import { readFile, writeFile } from 'node:fs/promises';

const path = 'src/mountainView.ts';
const before = await readFile(path, 'utf8');
const legacy = 'model: this.env.MOUNTAINVIEW_AI_ROUTER_MODEL || "gpt-5.6",';
const current = 'model: this.env.MOUNTAINVIEW_AI_ROUTER_MODEL || "gpt-4o-mini",';

if (!before.includes(legacy) && !before.includes(current)) {
  throw new Error('MountainView AI router model marker is missing; refusing to silently skip the low-cost routing patch.');
}

const after = before.replace(legacy, current);
if (after !== before) {
  await writeFile(path, after);
  console.log('patched MountainView fuzzy voice router default to gpt-4o-mini');
} else {
  console.log('MountainView fuzzy voice router already defaults to gpt-4o-mini');
}
