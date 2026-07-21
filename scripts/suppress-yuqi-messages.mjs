import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [configPath, reason = 'manual_technical_quarantine', ...messageIds] = process.argv.slice(2);
if (!configPath || messageIds.length === 0) {
  throw new Error('usage: node suppress-yuqi-messages.mjs <config> <reason> <message-id> [...]');
}

const config = JSON.parse(readFileSync(configPath, 'utf8'));
const database = new DatabaseSync(config.databasePath);
database.exec('PRAGMA busy_timeout = 5000;');

try {
  const find = database.prepare('SELECT message_id FROM messages WHERE message_id = ?');
  const suppress = database.prepare(`
    INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
    VALUES (?, ?, ?, ?)
  `);
  database.exec('BEGIN IMMEDIATE;');
  for (const messageId of messageIds) {
    if (!find.get(messageId)) throw new Error(`message not found: ${messageId}`);
    suppress.run(messageId, messageId, reason, Date.now());
  }
  database.exec('COMMIT;');
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT message_id AS messageId, reason
    FROM suppressed_messages
    WHERE message_id IN (${placeholders})
    ORDER BY message_id
  `).all(...messageIds);
  console.log(JSON.stringify({ ok: rows.length === messageIds.length, suppressed: rows }));
} catch (error) {
  try { database.exec('ROLLBACK;'); } catch {}
  throw error;
} finally {
  database.close();
}
