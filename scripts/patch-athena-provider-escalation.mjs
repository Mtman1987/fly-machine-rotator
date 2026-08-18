import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'src', 'aiFixer.ts');
const original = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
let source = original;

const before = `function assertUsableModelPlan(plan: ModelFixPlan, provider: string): ModelFixPlan {
  const guarded = discardExcerptGuessing(plan);
  if (!isUsablePlan(guarded)) {
    throw new Error(\`${'${provider}'} returned an empty fix plan.\`);
  }
  return guarded;
}`;

const after = `function assertUsableModelPlan(plan: ModelFixPlan, provider: string): ModelFixPlan {
  const guarded = discardExcerptGuessing(plan);
  if (!isUsablePlan(guarded)) {
    throw new Error(\`${'${provider}'} returned an empty fix plan.\`);
  }
  if (guarded.changes.length === 0) {
    const evidence = [guarded.sourceSummary, guarded.diagnosis, guarded.summary]
      .filter(Boolean)
      .join(" | ")
      .replace(/\\s+/g, " ")
      .trim()
      .slice(0, 1000);
    throw new Error(\`${'${provider}'} returned diagnostic evidence but no patch; continuing to another repair provider when configured. ${'${evidence}'}\`);
  }
  return guarded;
}`;

if (source.includes(before)) {
  source = source.replace(before, after);
} else if (!source.includes('returned diagnostic evidence but no patch; continuing to another repair provider when configured')) {
  throw new Error('Athena provider-plan guard marker missing');
}

source = source.replace(
  '`AI provider attempts were unavailable or unusable: ${failures.join(" | ").slice(0, 1800)}`',
  '`AI provider attempts were unavailable or unusable: ${failures.join(" | ").slice(0, 4800)}`',
);

if (source !== original) fs.writeFileSync(file, source, 'utf8');
console.log('Athena repair provider escalation patch applied.');
