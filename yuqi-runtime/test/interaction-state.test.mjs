import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuthoritativeInteractionState } from '../src/interaction-state.mjs';

test('separates model processing delay from the gap before the current message batch', () => {
  const previousAt = Date.parse('2026-07-23T14:00:00+08:00');
  const batchAt = Date.parse('2026-07-23T14:20:00+08:00');
  const now = batchAt + 40_000;
  const envelope = {
    characterId: 'yuqi',
    createdAt: batchAt,
    message: {
      messageId: 'msg_batch_2',
      speakerId: 'user',
      sentAt: batchAt
    },
    context: {
      currentBatch: {
        batchId: 'batch_1',
        messageIds: ['msg_batch_1', 'msg_batch_2'],
        startedAt: batchAt,
        committedAt: batchAt
      }
    }
  };
  const messages = [
    { messageId: 'msg_before_batch', speakerId: 'yuqi', sentAt: previousAt, content: '你想好再告诉我' },
    { messageId: 'msg_batch_1', speakerId: 'user', sentAt: batchAt, content: '刚才去忙了' },
    { messageId: 'msg_batch_2', speakerId: 'user', sentAt: batchAt, content: '现在回来了' }
  ];

  const state = buildAuthoritativeInteractionState({ envelope, messages, now });

  assert.equal(state.processingDelayMs, 40_000);
  assert.equal(state.conversationGapMs, 20 * 60_000);
  assert.equal(state.conversationGapText, '20分钟');
  assert.equal(state.conversationGapClass, 'interrupted');
  assert.equal(state.previousMessageId, 'msg_before_batch');
  assert.equal(state.previousSpeakerId, 'yuqi');
  assert.deepEqual(state.currentBatchMessageIds, ['msg_batch_1', 'msg_batch_2']);
});

test('a single direct message forms its own current batch for legacy envelopes', () => {
  const previousAt = Date.parse('2026-07-23T14:00:00+08:00');
  const currentAt = previousAt + 12 * 60_000;
  const state = buildAuthoritativeInteractionState({
    envelope: {
      characterId: 'yuqi',
      createdAt: currentAt,
      message: { messageId: 'msg_current', speakerId: 'user', sentAt: currentAt }
    },
    messages: [
      { messageId: 'msg_previous', speakerId: 'yuqi', sentAt: previousAt, content: '还没说完' },
      { messageId: 'msg_current', speakerId: 'user', sentAt: currentAt, content: '继续' }
    ],
    now: currentAt + 5_000
  });

  assert.equal(state.conversationGapMs, 12 * 60_000);
  assert.equal(state.previousMessageId, 'msg_previous');
  assert.deepEqual(state.currentBatchMessageIds, ['msg_current']);
});
