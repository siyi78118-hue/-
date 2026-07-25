import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const root = resolve(import.meta.dirname, '..');
const [turnArgument = 'latest', configArgument = `${root}/yuqi-runtime/config.json`] = process.argv.slice(2);
const config = JSON.parse(readFileSync(resolve(configArgument), 'utf8'));

let turnId = turnArgument;
if (turnArgument === 'latest') {
  const database = new DatabaseSync(resolve(config.databasePath), { readOnly: true });
  try {
    turnId = String(database.prepare(`
      SELECT turn_id AS turnId
      FROM turns
      WHERE state = 'failed'
      ORDER BY created_at DESC
      LIMIT 1
    `).get()?.turnId || '');
  } finally {
    database.close();
  }
}
if (!turnId) throw new Error('no failed turn found');

const store = new YuqiStore(resolve(config.databasePath));
try {
  store.migrate();
  const result = store.requeueUsageLimitFailedTurn(turnId);
  process.stdout.write(`${JSON.stringify({
    turnId,
    requeued: result.requeued,
    state: result.turn?.state || ''
  }, null, 2)}\n`);
} finally {
  store.close();
}
