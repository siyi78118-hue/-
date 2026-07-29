import { resolve } from 'node:path';

import { inspectMemorySnapshot } from './backup-yuqi-memory.mjs';

const databasePath = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/audit-yuqi-memory.mjs <database.sqlite>');

process.stdout.write(`${JSON.stringify(inspectMemorySnapshot(databasePath), null, 2)}\n`);
