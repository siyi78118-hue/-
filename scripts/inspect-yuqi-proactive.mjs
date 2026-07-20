import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const configPath = resolve(process.argv[2] || `${root}/yuqi-runtime/config.json`);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const db = new DatabaseSync(resolve(config.databasePath), { readOnly: true });

function rows(sql) {
  return db.prepare(sql).all();
}

try {
  const turns = rows(`
    SELECT turn_id AS turnId,
           json_extract(envelope_json, '$.kind') AS kind,
           json_extract(envelope_json, '$.trigger.jobId') AS jobId,
           json_extract(envelope_json, '$.trigger.triggerId') AS triggerId,
           state, route, origin, source_message_id AS sourceMessageId,
           datetime(created_at / 1000, 'unixepoch', 'localtime') AS createdAt,
           datetime(updated_at / 1000, 'unixepoch', 'localtime') AS updatedAt
    FROM turns
    ORDER BY created_at DESC
    LIMIT 40
  `);
  const proactiveTurnIds = turns
    .filter(row => row.kind === 'PROACTIVE_CHAT')
    .map(row => `'${String(row.turnId).replaceAll("'", "''")}'`);
  const filter = proactiveTurnIds.length ? `WHERE turn_id IN (${proactiveTurnIds.join(',')})` : 'WHERE 0';
  const stages = rows(`
    SELECT turn_id AS turnId, stage, ordinal, model, effort, duration_ms AS durationMs,
           datetime(started_at / 1000, 'unixepoch', 'localtime') AS startedAt,
           datetime(finished_at / 1000, 'unixepoch', 'localtime') AS finishedAt
    FROM turn_stages ${filter}
    ORDER BY started_at DESC
  `);
  const deliveries = rows(`
    SELECT turn_id AS turnId, peer_id AS peerId, state, attempts,
           length(payload_json) AS payloadBytes,
           datetime(created_at / 1000, 'unixepoch', 'localtime') AS createdAt,
           datetime(updated_at / 1000, 'unixepoch', 'localtime') AS updatedAt,
           datetime(delivered_at / 1000, 'unixepoch', 'localtime') AS deliveredAt
    FROM cloud_deliveries ${filter}
    ORDER BY created_at DESC
  `);
  const diagnostics = rows(`
    SELECT diagnostic_id AS diagnosticId, turn_id AS turnId, stage, level, detail_json AS detail,
           datetime(created_at / 1000, 'unixepoch', 'localtime') AS createdAt
    FROM diagnostics
    ORDER BY diagnostic_id DESC
    LIMIT 80
  `).map(row => {
    try { return { ...row, detail: JSON.parse(row.detail) }; } catch { return row; }
  });
  const messageCounts = rows(`
    SELECT turn_id AS turnId, speaker_type AS speakerType, origin, count(*) AS count
    FROM messages ${filter}
    GROUP BY turn_id, speaker_type, origin
    ORDER BY turn_id DESC, speaker_type
  `);

  process.stdout.write(`${JSON.stringify({
    databasePath: config.databasePath,
    recentTurns: turns,
    proactiveTurns: turns.filter(row => row.kind === 'PROACTIVE_CHAT'),
    stages,
    deliveries,
    messageCounts,
    diagnostics
  }, null, 2)}\n`);
} finally {
  db.close();
}
