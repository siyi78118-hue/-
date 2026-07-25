import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const [turnArgument = '', configArgument = `${root}/yuqi-runtime/config.json`] = process.argv.slice(2);
if (!turnArgument.trim()) throw new Error('turn id or "latest" is required');

const config = JSON.parse(readFileSync(resolve(configArgument), 'utf8'));
const database = new DatabaseSync(resolve(config.databasePath), { readOnly: true });

try {
  const turnId = turnArgument === 'latest'
    ? String(database.prepare('SELECT turn_id AS turnId FROM turns ORDER BY created_at DESC LIMIT 1').get()?.turnId || '')
    : turnArgument;
  if (!turnId) throw new Error('no turn found');
  const turn = database.prepare(`
    SELECT turn_id AS turnId, state, route, origin,
           created_at AS createdAt, updated_at AS updatedAt
    FROM turns
    WHERE turn_id = ?
  `).get(turnId);
  const stages = database.prepare(`
    SELECT stage, ordinal, model, effort, duration_ms AS durationMs,
           started_at AS startedAt, finished_at AS finishedAt
    FROM turn_stages
    WHERE turn_id = ?
    ORDER BY ordinal
  `).all(turnId);
  const diagnostics = database.prepare(`
    SELECT stage, level, detail_json AS detail, created_at AS createdAt
    FROM diagnostics
    WHERE turn_id = ?
    ORDER BY created_at
  `).all(turnId);
  const deliveries = database.prepare(`
    SELECT peer_id AS peerId, state, attempts,
           created_at AS createdAt, updated_at AS updatedAt,
           delivered_at AS deliveredAt
    FROM cloud_deliveries
    WHERE turn_id = ?
    ORDER BY created_at
  `).all(turnId);
  const messages = database.prepare(`
    SELECT speaker_type AS speakerType, origin, content, created_at AS createdAt
    FROM messages
    WHERE turn_id = ?
    ORDER BY created_at
  `).all(turnId);

  process.stdout.write(`${JSON.stringify({ turn, stages, diagnostics, deliveries, messages }, null, 2)}\n`);
} finally {
  database.close();
}
