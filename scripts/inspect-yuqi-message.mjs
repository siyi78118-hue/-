import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve(import.meta.dirname, '..');
const [needle = '', configArgument = `${root}/yuqi-runtime/config.json`] = process.argv.slice(2);
if (!needle.trim()) throw new Error('message text fragment is required');

const config = JSON.parse(readFileSync(resolve(configArgument), 'utf8'));
const database = new DatabaseSync(resolve(config.databasePath), { readOnly: true });

try {
  const messages = database.prepare(`
    SELECT message_id AS messageId, turn_id AS turnId, speaker_type AS speakerType,
           origin, content, created_at AS createdAt
    FROM messages
    WHERE content LIKE ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(`%${needle}%`);
  const turnIds = [...new Set(messages.map(message => message.turnId).filter(Boolean))];
  if (!turnIds.length) {
    console.log(JSON.stringify({ messages: [], turns: [], deliveries: [], diagnostics: [] }, null, 2));
  } else {
    const placeholders = turnIds.map(() => '?').join(',');
    const turns = database.prepare(`
      SELECT turn_id AS turnId, state, route, origin, envelope_json AS envelope,
             brain_draft_json AS brainDraft, supervisor_json AS supervisor,
             reply_json AS reply, created_at AS createdAt, updated_at AS updatedAt
      FROM turns WHERE turn_id IN (${placeholders})
      ORDER BY created_at DESC
    `).all(...turnIds);
    const deliveries = database.prepare(`
      SELECT turn_id AS turnId, peer_id AS peerId, state, attempts,
             payload_json AS payload, created_at AS createdAt,
             updated_at AS updatedAt, delivered_at AS deliveredAt, confirmed_at AS confirmedAt
      FROM cloud_deliveries WHERE turn_id IN (${placeholders})
      ORDER BY created_at DESC
    `).all(...turnIds);
    const diagnostics = database.prepare(`
      SELECT turn_id AS turnId, stage, level, detail_json AS detail, created_at AS createdAt
      FROM diagnostics WHERE turn_id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...turnIds);
    console.log(JSON.stringify({ messages, turns, deliveries, diagnostics }, null, 2));
  }
} finally {
  database.close();
}
