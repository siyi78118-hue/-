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
