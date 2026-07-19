import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/audit-yuqi-memory.mjs <database.sqlite>');

const db = new DatabaseSync(databasePath, { readOnly: true });

try {
  const sessions = db.prepare(`
    SELECT role, length(thread_id) AS threadIdLength
    FROM sessions
    ORDER BY role
  `).all();
  const turns = db.prepare(`
    SELECT turn_id AS turnId, state, origin, envelope_checksum AS envelopeChecksum
    FROM turns
    ORDER BY turn_id
  `).all();
  const messages = db.prepare(`
    SELECT message_id AS messageId, turn_id AS turnId, speaker_id AS speakerId,
           speaker_type AS speakerType, origin, checksum, length(content) AS contentLength
    FROM messages
    ORDER BY message_id
  `).all();
  const digestRows = messages.map(({ messageId, turnId, speakerId, speakerType, origin, checksum }) => (
    [messageId, turnId, speakerId, speakerType, origin, checksum].join('\u001f')
  ));
  const messageLedgerSha256 = createHash('sha256').update(digestRows.join('\n')).digest('hex');

  process.stdout.write(`${JSON.stringify({
    databasePath,
    sessions,
    turns,
    messages,
    messageLedgerSha256
  }, null, 2)}\n`);
} finally {
  db.close();
}
