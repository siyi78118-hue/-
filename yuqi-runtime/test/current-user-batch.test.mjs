import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveCurrentUserBatch } from '../src/current-user-batch.mjs';

function directEnvelope(overrides = {}) {
  const first = {
    messageId: 'msg_batch_1',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '你明明答应过我，我真的很失望',
    sentAt: 1_000
  };
  const second = {
    messageId: 'msg_batch_2',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '算了',
    sentAt: 2_000
  };
  return {
    protocolVersion: 2,
    turnId: 'turn_batch_1',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 3_000,
    kind: 'DIRECT_REPLY',
    message: second,
    context: {
      currentBatch: {
        batchId: 'batch_1',
        messageIds: [first.messageId, second.messageId],
        startedAt: first.sentAt,
        committedAt: 3_000,
        messages: [first, second]
      }
    },
    ...overrides
  };
}

test('a self-contained current batch preserves every bubble once and in order', () => {
  const batch = resolveCurrentUserBatch(directEnvelope());

  assert.equal(batch.batchId, 'batch_1');
  assert.equal(batch.sourceMessageId, 'msg_batch_2');
  assert.deepEqual(batch.messageIds, ['msg_batch_1', 'msg_batch_2']);
  assert.deepEqual(batch.messages.map(item => item.content), [
    '你明明答应过我，我真的很失望',
    '算了'
  ]);
  assert.equal(batch.combinedText, '你明明答应过我，我真的很失望\n算了');
  assert.equal(batch.complete, true);
  assert.deepEqual(batch.missingMessageIds, []);
});

test('an old id-only batch resolves its earlier bubbles from synchronized messages', () => {
  const envelope = directEnvelope();
  delete envelope.context.currentBatch.messages;
  const batch = resolveCurrentUserBatch(envelope, [
    {
      messageId: 'msg_batch_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '同步来的第一条',
      sentAt: 1_000
    }
  ]);

  assert.deepEqual(batch.messages.map(item => item.content), ['同步来的第一条', '算了']);
  assert.equal(batch.complete, true);
});

test('a legacy direct message becomes a synthetic single-message current batch', () => {
  const envelope = directEnvelope();
  delete envelope.context;
  const batch = resolveCurrentUserBatch(envelope);

  assert.deepEqual(batch.messageIds, ['msg_batch_2']);
  assert.deepEqual(batch.messages, [envelope.message]);
  assert.equal(batch.startedAt, 2_000);
  assert.equal(batch.committedAt, 3_000);
  assert.equal(batch.complete, true);
});

test('an unresolved id-only batch exposes missing ids instead of silently claiming completeness', () => {
  const envelope = directEnvelope();
  delete envelope.context.currentBatch.messages;
  const batch = resolveCurrentUserBatch(envelope);

  assert.deepEqual(batch.messages.map(item => item.messageId), ['msg_batch_2']);
  assert.equal(batch.complete, false);
  assert.deepEqual(batch.missingMessageIds, ['msg_batch_1']);
});

test('automatic turns do not fabricate a current user batch', () => {
  assert.equal(resolveCurrentUserBatch({
    protocolVersion: 2,
    kind: 'PROACTIVE_CHAT',
    characterId: 'yuqi',
    trigger: { triggerId: 'trigger_1' }
  }), null);
});
