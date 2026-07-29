import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const runId = option('run-id');
if (!runId) throw new Error('--run-id is required');
const path = resolve('artifacts/qa/cognition/replay', runId, 'summary.json');
const summary = JSON.parse(readFileSync(path, 'utf8'));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

