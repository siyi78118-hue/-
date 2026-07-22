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
