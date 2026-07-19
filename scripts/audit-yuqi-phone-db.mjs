import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const databasePath = resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/audit-yuqi-phone-db.mjs <database.sqlite>');

const db = new DatabaseSync(databasePath, { readOnly: true });
const sha256 = value => createHash('sha256').update(String(value ?? '')).digest('hex');

try {
  const turns = db.prepare(`
    SELECT turnId, kind, state, sourceMessageId, activeAttemptId
    FROM chat_turns
    WHERE turnId LIKE 'turn_android_%'
    ORDER BY createdAt
  `).all();
  const attempts = db.prepare(`
    SELECT attemptId, turnId, sequence, stage, state, errorCode, retryable,
           memoryResult, rawReply
    FROM execution_attempts
    WHERE turnId LIKE 'turn_android_%'
    ORDER BY turnId, sequence
  `).all().map(row => {
    let bridge = null;
    try {
      const parsed = JSON.parse(row.memoryResult || '{}');
      bridge = {
        turnId: parsed.turnId ?? parsed.bridgeTurnId ?? null,
        origin: parsed.origin ?? parsed.replyOrigin ?? null,
        route: parsed.route ?? parsed.attemptedRoute ?? null
      };
    } catch {}
    return {
      attemptId: row.attemptId,
      turnId: row.turnId,
      sequence: row.sequence,
      stage: row.stage,
      state: row.state,
      errorCode: row.errorCode,
      retryable: row.retryable,
      bridge,
      rawReplyLength: row.rawReply?.length ?? 0,
      rawReplySha256: row.rawReply ? sha256(row.rawReply) : null
    };
  });
  const replyParts = db.prepare(`
    SELECT replyPartId, turnId, attemptId, sequence, type, content
    FROM reply_parts
    WHERE turnId LIKE 'turn_android_%'
    ORDER BY turnId, sequence
  `).all().map(({ content, ...row }) => ({
    ...row,
    contentLength: content.length,
    contentSha256: sha256(content)
  }));
  const rawMessages = db.prepare(`
    SELECT messageId, turnId, speakerId, speakerType, recipientId, origin,
           deviceId, deviceSeq, checksum, length(content) AS contentLength
    FROM yuqi_raw_messages
    WHERE turnId LIKE 'turn_android_%'
    ORDER BY turnId, speakerType, messageId
  `).all();

  process.stdout.write(`${JSON.stringify({
    databasePath,
    turns,
    attempts,
    replyParts,
    rawMessages,
    counts: {
      turns: turns.length,
      completedTurns: turns.filter(row => row.state === 'COMPLETED').length,
      replyParts: replyParts.length,
      userRawMessages: rawMessages.filter(row => row.speakerType === 'user').length,
      characterRawMessages: rawMessages.filter(row => row.speakerType === 'character').length
    }
  }, null, 2)}\n`);
} finally {
  db.close();
}
