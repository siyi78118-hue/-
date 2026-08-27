import assert from 'node:assert/strict';
import test from 'node:test';

import { YuqiStore } from '../src/store.mjs';

import {
  DEFAULT_SESSION_IDLE_TIMEOUT_MS,
  deriveSessionId,
  discoverClosedSessions,
  splitVisibleSessions
} from '../src/persona-evolution/session-boundary.mjs';

const minute = 60_000;

function message(id, minuteOffset, speaker = 'user', content = id) {
  return {
    id,
    speaker,
    createdAt: new Date(Date.parse('2026-08-27T10:00:00.000Z') + minuteOffset * minute).toISOString(),
    content
  };
}

test('uses one configurable 30 minute idle boundary', () => {
  assert.equal(DEFAULT_SESSION_IDLE_TIMEOUT_MS, 30 * minute);
  const continuous = splitVisibleSessions({
    roleId: 'role_a',
    conversationId: 'private:role_a',
    messages: [message('msg_1', 0), message('msg_2', 29, 'assistant')],
    idleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS
  });
  assert.equal(continuous.length, 1);

  const separated = splitVisibleSessions({
    roleId: 'role_a',
    conversationId: 'private:role_a',
    messages: [message('msg_1', 0), message('msg_2', 31, 'assistant')],
    idleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS
  });
  assert.equal(separated.length, 2);
});

test('derives a stable role and conversation scoped session identity', () => {
  const first = deriveSessionId({ roleId: 'role_a', conversationId: 'private:role_a', firstMessageId: 'msg_1' });
  assert.match(first, /^ses_[a-f0-9]{64}$/);
  assert.equal(first, deriveSessionId({ roleId: 'role_a', conversationId: 'private:role_a', firstMessageId: 'msg_1' }));
  assert.notEqual(first, deriveSessionId({ roleId: 'role_b', conversationId: 'private:role_a', firstMessageId: 'msg_1' }));
  assert.notEqual(first, deriveSessionId({ roleId: 'role_a', conversationId: 'moment:1', firstMessageId: 'msg_1' }));
});

test('keeps source order stable and rejects hidden-shaped messages', () => {
  const sessions = splitVisibleSessions({
    roleId: 'role_a',
    conversationId: 'private:role_a',
    messages: [message('msg_2', 1, 'assistant'), message('msg_1', 0)],
    idleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS
  });
  assert.deepEqual(sessions[0].messages.map(item => item.id), ['msg_1', 'msg_2']);
  assert.throws(() => splitVisibleSessions({
    roleId: 'role_a',
    conversationId: 'private:role_a',
    messages: [{ ...message('msg_hidden', 0), prompt: 'secret' }],
    idleTimeoutMs: DEFAULT_SESSION_IDLE_TIMEOUT_MS
  }), /unknown or missing/i);
});

test('discovers only sessions that are actually idle at the supplied clock', () => {
  const messages = [message('msg_1', 0), message('msg_2', 4, 'assistant')];
  const before = discoverClosedSessions({
    roleId: 'role_a', conversationId: 'private:role_a', messages,
    now: Date.parse('2026-08-27T10:33:00.000Z'), idleTimeoutMs: 30 * minute
  });
  assert.deepEqual(before, []);
  const after = discoverClosedSessions({
    roleId: 'role_a', conversationId: 'private:role_a', messages,
    now: Date.parse('2026-08-27T10:35:00.000Z'), idleTimeoutMs: 30 * minute
  });
  assert.equal(after.length, 1);
  assert.equal(after[0].endedAt, '2026-08-27T10:04:00.000Z');
});

test('a new visible message after the gap closes only the preceding session', () => {
  const closed = discoverClosedSessions({
    roleId: 'role_a',
    conversationId: 'private:role_a',
    messages: [message('msg_1', 0), message('msg_2', 2, 'assistant'), message('msg_3', 40)],
    now: Date.parse('2026-08-27T10:40:01.000Z'),
    idleTimeoutMs: 30 * minute
  });
  assert.equal(closed.length, 1);
  assert.deepEqual(closed[0].messages.map(item => item.id), ['msg_1', 'msg_2']);
});

test('store projection pages only persisted visible conversation messages in canonical order', () => {
  const store = new YuqiStore(':memory:');
  try {
    store.migrate();
    store.submitTurn({
      protocolVersion: 1,
      turnId: 'turn_visible_1',
      characterId: 'role_a',
      deviceId: 'phone',
      deviceSeq: 1,
      createdAt: Date.parse('2026-08-27T10:00:00.000Z'),
      message: {
        messageId: 'msg_user_1', speakerId: 'user', speakerType: 'user', recipientId: 'role_a',
        content: '用户可见消息', sentAt: Date.parse('2026-08-27T10:00:00.000Z')
      }
    });
    store.putMessage({
      messageId: 'msg_assistant_1', turnId: 'turn_visible_1', characterId: 'role_a',
      speakerId: 'role_a', speakerType: 'character', recipientId: 'user',
      content: '最终可见回复', sentAt: Date.parse('2026-08-27T10:01:00.000Z'),
      origin: 'codex', deviceId: 'pc', deviceSeq: 1
    });
    store.db.prepare("UPDATE turns SET state = 'completed' WHERE turn_id = ?").run('turn_visible_1');
    store.db.prepare(`INSERT INTO suppressed_messages(
      message_id, authoritative_message_id, reason, created_at
    ) VALUES (?, ?, ?, ?)`)
      .run('msg_assistant_1', 'msg_user_1', 'synthetic_test', Date.parse('2026-08-27T10:02:00.000Z'));

    const first = store.listCanonicalVisibleConversationItems('role_a', { limit: 1 });
    assert.deepEqual(first.items.map(item => [item.id, item.speaker, item.conversationId]), [
      ['msg_user_1', 'user', 'private_chat']
    ]);
    assert.equal(first.nextCursor, null);
    assert.equal(Object.keys(first.items[0]).sort().join(','), 'content,conversationId,createdAt,id,roleId,speaker');
  } finally {
    store.close();
  }
});
