import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { inspectMemorySnapshot, verifyYuqiBackup } from './backup-yuqi-memory.mjs';

const databasePath = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/audit-yuqi-memory.mjs <database.sqlite>');

let targetPath = databasePath;
if (!statSync(databasePath).isDirectory() && databasePath.toLowerCase().endsWith('.json')) {
  const config = JSON.parse(readFileSync(databasePath, 'utf8'));
  if (typeof config.databasePath !== 'string' || !config.databasePath.trim()) {
    throw new Error('Yuqi memory config databasePath is required');
  }
  targetPath = resolve(config.databasePath);
}
const result = statSync(targetPath).isDirectory()
  ? verifyYuqiBackup({ artifactDir: targetPath })
  : inspectMemorySnapshot(targetPath);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
