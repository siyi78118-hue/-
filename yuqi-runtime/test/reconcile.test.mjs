import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { contentHash } from '../src/protocol.mjs';
import { YuqiReconciler } from '../src/reconcile.mjs';
import { YuqiStore } from '../src/store.mjs';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-reconcile-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  return Promise.resolve(run(store)).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function messageEntry(seq, payload) {
  return {
    seq,
    entityType: 'message',
    entityId: payload.messageId,
    operation: 'insert',
    payload,
    checksum: contentHash(payload),
    createdAt: payload.sentAt
  };
}

function fallbackBatch() {
  return [
    messageEntry(11, {
      messageId: 'msg_phone_11', turnId: 'turn_phone_11', characterId: 'yuqi',
      speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: '你还记得答应我的事吗？',
      sentAt: 1784400000000, origin: 'phone', deviceId: 'phone_a', deviceSeq: 11
    }),
    messageEntry(12, {
      messageId: 'msg_fallback_11', turnId: 'turn_phone_11', characterId: 'yuqi',
      speakerId: 'yuqi', speakerType: 'character', recipientId: 'user', content: '记得。你不必再提醒第二次。',
      sentAt: 1784400001000, origin: 'fallback', deviceId: 'phone_a:fallback', deviceSeq: 12
    })
  ];
}

test('replays exact fallback messages through memory and never creates a second reply', async () => withStore(async store => {
  const roleCalls = [];
  const codex = {
    async runTurn(role, input) {
      roleCalls.push({ role, input: JSON.parse(input) });
      return { text: JSON.stringify({ candidates: [] }) };
    }
  };
  const reconciler = new YuqiReconciler({ store, codex });
  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });

  assert.equal(result.ackSeq, 12);
  assert.deepEqual(result.deliverReplies, []);
  assert.deepEqual(result.reconciledFallbackTurns, ['turn_phone_11']);
  assert.deepEqual(roleCalls.map(call => call.role), ['memory']);
  assert.equal(roleCalls[0].input.exactRawMessages[0].speakerId, 'user');
  assert.equal(roleCalls[0].input.exactRawMessages[1].speakerId, 'yuqi');
  assert.equal(store.getSyncCursor('phone_a'), 12);
}));

test('duplicate recovery batches are idempotent and do not rerun memory', async () => withStore(async store => {
  let calls = 0;
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { calls += 1; return { text: '{"candidates":[]}' }; } }
  });
  await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  const duplicate = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  assert.equal(calls, 1);
  assert.equal(duplicate.importedMessages, 0);
  assert.equal(duplicate.ackSeq, 12);
}));

test('a memory-role failure leaves the cursor unacknowledged for a later retry', async () => withStore(async store => {
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new Error('memory thread unavailable'); } }
  });
  await assert.rejects(
    reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() }),
    /memory thread unavailable/
  );
  assert.equal(store.getSyncCursor('phone_a'), 10);
  assert.equal(store.listMessages('yuqi', 20).length, 2, 'raw chat remains durable even when memory analysis fails');
}));

test('an already-generated Codex reply is preserved raw but hidden behind the reply actually shown to the user', async () => withStore(async store => {
  store.putMessage({
    messageId: 'msg_codex_stale', turnId: 'turn_phone_11', characterId: 'yuqi',
    speakerId: 'yuqi', speakerType: 'character', recipientId: 'user', content: '这是电脑晚到的回复',
    sentAt: 1784400000500, origin: 'codex'
  });
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { return { text: '{"candidates":[]}' }; } }
  });
  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  const visible = store.listMessages('yuqi', 20);
  assert.equal(result.suppressedReplies, 1);
  assert.equal(store.getMessage('msg_codex_stale').content, '这是电脑晚到的回复');
  assert.equal(visible.some(message => message.messageId === 'msg_codex_stale'), false);
  assert.equal(visible.some(message => message.messageId === 'msg_fallback_11'), true);
}));

test('invalid sync checksums stop reconciliation before facts can be promoted', async () => withStore(async store => {
  const corrupted = fallbackBatch();
  corrupted[1] = { ...corrupted[1], checksum: '0'.repeat(64) };
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('must not run'); } }
  });
  await assert.rejects(
    reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: corrupted }),
    /checksum/
  );
  assert.equal(store.getSyncCursor('phone_a'), 10);
}));
