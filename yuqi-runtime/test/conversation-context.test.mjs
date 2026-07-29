import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGenerationWindow } from '../src/conversation-context.mjs';

test('generation window is ordered, bounded, and excludes the explicit current message', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    messageId: index === 30 ? 'msg_current' : `msg_${index}`,
    sentAt: 1_000 + (39 - index),
    content: `message ${index}`
  }));

  const window = buildGenerationWindow(messages, { currentMessageId: 'msg_current', limit: 24 });

  assert.equal(window.length, 24);
  assert.equal(window.some(item => item.messageId === 'msg_current'), false);
  assert.deepEqual(
    window.map(item => item.sentAt),
    [...window.map(item => item.sentAt)].sort((left, right) => left - right)
  );
});

test('generation window tolerates malformed entries without duplicating message ids', () => {
  const window = buildGenerationWindow([
    null,
    { messageId: 'a', sentAt: 2 },
    { messageId: 'a', sentAt: 3 },
    { messageId: 'b', sentAt: 1 }
  ], { limit: 24 });

  assert.deepEqual(window.map(item => item.messageId), ['b', 'a']);
  assert.equal(window.find(item => item.messageId === 'a').sentAt, 3);
});

test('generation window retains the latest complete message groups without cutting a multi-bubble reply', () => {
  const messages = [
    {
      messageId: 'msg_oldest_user',
      turnId: 'turn_oldest',
      speakerType: 'user',
      sentAt: 1,
      content: '最旧的一组'
    },
    {
      messageId: 'msg_yuqi_group_1',
      turnId: 'turn_yuqi_group',
      speakerType: 'character',
      sentAt: 2,
      content: '同一次回复的第一条'
    },
    {
      messageId: 'msg_yuqi_group_2',
      turnId: 'turn_yuqi_group',
      speakerType: 'character',
      sentAt: 3,
      content: '同一次回复的第二条'
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      messageId: `msg_recent_${index}`,
      turnId: `turn_recent_${index}`,
      speakerType: index % 2 ? 'character' : 'user',
      sentAt: 4 + index,
      content: `最近完整消息 ${index}`
    }))
  ];

  const window = buildGenerationWindow(messages, { limit: 20 });

  assert.equal(window.some(item => item.messageId === 'msg_oldest_user'), false);
  assert.equal(window.some(item => item.messageId === 'msg_yuqi_group_1'), true);
  assert.equal(window.some(item => item.messageId === 'msg_yuqi_group_2'), true);
  assert.equal(window.length, 21);
});

test('generation window counts user and character messages separately even when they share a turn id', () => {
  const window = buildGenerationWindow([
    {
      messageId: 'msg_shared_user',
      turnId: 'turn_shared',
      speakerType: 'user',
      sentAt: 1,
      content: '用户消息'
    },
    {
      messageId: 'msg_shared_character',
      turnId: 'turn_shared',
      speakerType: 'character',
      sentAt: 2,
      content: '虞栖回复'
    }
  ], { limit: 1 });

  assert.deepEqual(window.map(item => item.messageId), ['msg_shared_character']);
});

test('generation window excludes every message in the current user batch', () => {
  const window = buildGenerationWindow([
    { messageId: 'msg_history', speakerType: 'character', sentAt: 1, content: '之前' },
    { messageId: 'msg_batch_1', speakerType: 'user', sentAt: 2, content: '第一条' },
    { messageId: 'msg_batch_2', speakerType: 'user', sentAt: 3, content: '第二条' }
  ], {
    currentMessageIds: ['msg_batch_1', 'msg_batch_2'],
    limit: 20
  });

  assert.deepEqual(window.map(item => item.messageId), ['msg_history']);
});

test('generation window keeps a historical multi-bubble user batch as one complete group', () => {
  const messages = [
    {
      messageId: 'msg_user_batch_1',
      batchId: 'batch_history',
      batchSequence: 0,
      turnId: 'turn_legacy_1',
      speakerType: 'user',
      sentAt: 1,
      content: '第一条'
    },
    {
      messageId: 'msg_user_batch_2',
      batchId: 'batch_history',
      batchSequence: 1,
      turnId: 'turn_legacy_2',
      speakerType: 'user',
      sentAt: 2,
      content: '第二条'
    },
    ...Array.from({ length: 20 }, (_, index) => ({
      messageId: `msg_recent_group_${index}`,
      turnId: `turn_recent_group_${index}`,
      speakerType: 'character',
      sentAt: 3 + index,
      content: `最近消息 ${index}`
    }))
  ];

  const window = buildGenerationWindow(messages, { limit: 21 });

  assert.equal(window.some(item => item.messageId === 'msg_user_batch_1'), true);
  assert.equal(window.some(item => item.messageId === 'msg_user_batch_2'), true);
  assert.equal(window.length, 22);
});

test('the twentieth complete group boundary never cuts a three-bubble batch', () => {
  const messages = [
    {
      messageId: 'msg_boundary_1',
      batchId: 'batch_boundary',
      speakerType: 'user',
      sentAt: 1,
      content: '边界第一条'
    },
    {
      messageId: 'msg_boundary_2',
      batchId: 'batch_boundary',
      speakerType: 'user',
      sentAt: 2,
      content: '边界第二条'
    },
    {
      messageId: 'msg_boundary_3',
      batchId: 'batch_boundary',
      speakerType: 'user',
      sentAt: 3,
      content: '边界第三条'
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      messageId: `msg_after_boundary_${index}`,
      turnId: `turn_after_boundary_${index}`,
      speakerType: 'character',
      sentAt: 4 + index,
      content: `后续完整组 ${index}`
    }))
  ];

  const included = buildGenerationWindow(messages, { limit: 20 });
  assert.deepEqual(
    included.slice(0, 3).map((item) => item.messageId),
    ['msg_boundary_1', 'msg_boundary_2', 'msg_boundary_3']
  );

  const excluded = buildGenerationWindow([
    {
      messageId: 'msg_older',
      turnId: 'turn_older',
      speakerType: 'character',
      sentAt: 0,
      content: '更早一组'
    },
    ...messages
  ], { limit: 20 });
  assert.equal(excluded.some((item) => item.batchId === 'batch_boundary'), true);
  assert.equal(excluded.some((item) => item.messageId === 'msg_older'), false);
});
