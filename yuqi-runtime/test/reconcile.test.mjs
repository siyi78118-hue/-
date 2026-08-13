import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalJson, contentHash } from '../src/protocol.mjs';
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

function seedCanonicalUserMessage(store, overrides = {}) {
  const messageId = overrides.messageId || 'msg_recovery_alias';
  const turnId = `turn_${messageId}`;
  const sentAt = overrides.sentAt || 1784400004000;
  const deviceId = overrides.deviceId || 'phone_a';
  const message = {
    messageId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: overrides.content || '同一个已经提交过的用户气泡',
    sentAt
  };
  store.submitTurn({
    protocolVersion: 1,
    turnId,
    characterId: 'yuqi',
    deviceId,
    deviceSeq: overrides.deviceSeq || 41,
    createdAt: sentAt,
    message
  });
  store.db.prepare(`
    UPDATE turns
    SET result_authority_version = 1,
        state = 'failed',
        envelope_json = ?
    WHERE turn_id = ?
  `).run(JSON.stringify({ protocolVersion: 3 }), turnId);
  return { message, turnId, deviceId, stored: store.getMessage(messageId) };
}

test('queues exact fallback messages for background consolidation and never creates a second reply', async () => withStore(async store => {
  const roleCalls = [];
  const codex = {
      async runTurn(role, input, options) {
        roleCalls.push({ role, input: JSON.parse(input), options });
      return { text: JSON.stringify({ candidates: [] }) };
    }
  };
  const reconciler = new YuqiReconciler({ store, codex });
  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });

  assert.equal(result.ackSeq, 12);
  assert.deepEqual(result.deliverReplies, []);
  assert.deepEqual(result.reconciledFallbackTurns, ['turn_phone_11']);
  assert.deepEqual(roleCalls, []);
  const queued = store.db.prepare(
    'SELECT state, payload_json FROM consolidation_jobs WHERE turn_id = ?'
  ).get('turn_phone_11');
  assert.equal(queued.state, 'queued');
  assert.deepEqual(JSON.parse(queued.payload_json).messageIds, ['msg_phone_11', 'msg_fallback_11']);
  assert.equal(store.getSyncCursor('phone_a'), 12);
}));

test('reconciles legacy frontend fallback messages as character memory without drafting a reply', async () => withStore(async store => {
  const calls = [];
  const reconciler = new YuqiReconciler({
    store,
    codex: {
      async runTurn(role, input) {
        calls.push({ role, input: JSON.parse(input) });
        return { text: '{"candidates":[]}' };
      }
    }
  });
  const legacy = messageEntry(21, {
    messageId: 'msg_legacy_0241', turnId: 'turn_legacy_0241', characterId: 'yuqi',
    speakerId: 'yuqi', speakerType: 'character', recipientId: 'user',
    content: '猜错了也没关系，就是突然好奇', sentAt: 1784496060000,
    origin: 'legacy_fallback', deviceId: 'phone_a:legacy', deviceSeq: 21
  });

  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 20, entries: [legacy] });

  assert.equal(result.importedMessages, 1);
  assert.deepEqual(result.deliverReplies, []);
  assert.deepEqual(calls, []);
  assert.equal(
    store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?')
      .get('turn_legacy_0241').state,
    'queued'
  );
  assert.equal(store.getMessage('msg_legacy_0241').origin, 'legacy_fallback');
}));

test('duplicate recovery batches are idempotent and do not rerun memory', async () => withStore(async store => {
  let calls = 0;
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { calls += 1; return { text: '{"candidates":[]}' }; } }
  });
  await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  const duplicate = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  assert.equal(calls, 0);
  assert.equal(duplicate.importedMessages, 0);
  assert.equal(duplicate.ackSeq, 12);
}));

test('a deployed legacy recovery alias converges on its immutable canonical v3 user message', async () => withStore(async store => {
  const seeded = seedCanonicalUserMessage(store);
  const before = store.getMessage(seeded.message.messageId);
  const alias = messageEntry(41, {
    ...seeded.message,
    turnId: `turn_legacy_${seeded.message.messageId}`,
    characterId: 'yuqi',
    origin: 'phone',
    deviceId: `${seeded.deviceId}:visible`,
    deviceSeq: 41
  });
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('an existing user message needs no model call'); } }
  });

  const result = await reconciler.reconcileFrom({
    peerId: seeded.deviceId,
    lastCommonSeq: 40,
    lastSeq: 41,
    entries: [alias]
  });

  assert.equal(result.ackSeq, 41);
  assert.equal(result.importedMessages, 0);
  assert.deepEqual(store.getMessage(seeded.message.messageId), before);
}));

test('a canonical visible recovery echo converges without rewriting its authority row', async () => withStore(async store => {
  const seeded = seedCanonicalUserMessage(store, { messageId: 'msg_canonical_visible_echo' });
  const before = store.getMessage(seeded.message.messageId);
  const echo = messageEntry(73, {
    ...seeded.message,
    turnId: seeded.turnId,
    characterId: 'yuqi',
    origin: 'phone',
    deviceId: `${seeded.deviceId}:visible`,
    deviceSeq: 73
  });
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { assert.fail('an exact recovery echo needs no model call'); } }
  });

  const result = await reconciler.reconcileFrom({
    peerId: seeded.deviceId,
    lastCommonSeq: 72,
    lastSeq: 73,
    entries: [echo]
  });

  assert.equal(result.ackSeq, 73);
  assert.equal(result.importedMessages, 0);
  assert.deepEqual(store.getMessage(seeded.message.messageId), before);
}));

test('canonical recovery alias compatibility rejects every semantic or authority change', async () => {
  const mutations = [
    ['content', payload => { payload.content = '被改过的正文'; }],
    ['sentAt', payload => { payload.sentAt += 1; }],
    ['speaker', payload => { payload.speakerId = 'yuqi'; payload.speakerType = 'character'; }],
    ['recipient', payload => { payload.recipientId = 'other'; }],
    ['legacy owner', payload => { payload.turnId = 'turn_unrelated'; }],
    ['device identity', payload => { payload.deviceId = 'phone_a'; }],
    ['device sequence', payload => { payload.deviceSeq = 42; }]
  ];
  for (const [label, mutate] of mutations) {
    await withStore(async store => {
      const seeded = seedCanonicalUserMessage(store, { messageId: `msg_recovery_${label.replaceAll(' ', '_')}` });
      const payload = {
        ...seeded.message,
        turnId: `turn_legacy_${seeded.message.messageId}`,
        characterId: 'yuqi',
        origin: 'phone',
        deviceId: `${seeded.deviceId}:visible`,
        deviceSeq: 41
      };
      mutate(payload);
      const reconciler = new YuqiReconciler({
        store,
        codex: { async runTurn() { throw new AssertionError('invalid recovery needs no model call'); } }
      });
      store.ackSync(seeded.deviceId, 40);

      await assert.rejects(
        reconciler.reconcileFrom({
          peerId: seeded.deviceId,
          lastCommonSeq: 40,
          lastSeq: 41,
          entries: [messageEntry(41, payload)]
        }),
        /message checksum conflict/,
        label
      );
      assert.equal(store.getSyncCursor(seeded.deviceId), 40, label);
      assert.equal(store.getMessage(seeded.message.messageId).turnId, seeded.turnId, label);
    });
  }
});

test('canonical visible recovery echoes reject every semantic or authority change', async () => {
  const mutations = [
    ['content', (_store, _seeded, payload) => { payload.content = '被改过的正文'; }, /message checksum conflict/],
    ['sentAt', (_store, _seeded, payload) => { payload.sentAt += 1; }, /message checksum conflict/],
    ['speaker', (_store, _seeded, payload) => {
      payload.speakerId = 'yuqi';
      payload.speakerType = 'character';
    }, /canonical visible result API required/],
    ['recipient', (_store, _seeded, payload) => { payload.recipientId = 'other'; }, /message checksum conflict/],
    ['canonical turn', (_store, _seeded, payload) => { payload.turnId = 'turn_unrelated'; }, /message checksum conflict/],
    ['visible peer', (_store, _seeded, payload) => { payload.deviceId = 'foreign:visible'; }, /message checksum conflict/],
    ['journal sequence', (_store, _seeded, payload) => { payload.deviceSeq = 74; }, /message checksum conflict/],
    ['owner authority', (store, seeded) => {
      store.db.prepare('UPDATE turns SET result_authority_version = 0 WHERE turn_id = ?')
        .run(seeded.turnId);
    }, /message checksum conflict/],
    ['owner protocol', (store, seeded) => {
      store.db.prepare('UPDATE turns SET envelope_json = ? WHERE turn_id = ?')
        .run(JSON.stringify({ protocolVersion: 2 }), seeded.turnId);
    }, /message checksum conflict/]
  ];
  for (const [label, mutate, expectedError] of mutations) {
    await withStore(async store => {
      const seeded = seedCanonicalUserMessage(store, {
        messageId: `msg_visible_echo_${label.replaceAll(' ', '_')}`
      });
      const before = store.getMessage(seeded.message.messageId);
      const payload = {
        ...seeded.message,
        turnId: seeded.turnId,
        characterId: 'yuqi',
        origin: 'phone',
        deviceId: `${seeded.deviceId}:visible`,
        deviceSeq: 73
      };
      mutate(store, seeded, payload);
      store.ackSync(seeded.deviceId, 72);
      const reconciler = new YuqiReconciler({
        store,
        codex: { async runTurn() { assert.fail('an invalid recovery echo needs no model call'); } }
      });

      await assert.rejects(
        reconciler.reconcileFrom({
          peerId: seeded.deviceId,
          lastCommonSeq: 72,
          lastSeq: 73,
          entries: [messageEntry(73, payload)]
        }),
        expectedError,
        label
      );
      assert.equal(store.getSyncCursor(seeded.deviceId), 72, label);
      assert.deepEqual(store.getMessage(seeded.message.messageId), before, label);
    });
  }
});

test('a memory provider outage does not block durable reconciliation or its cursor', async () => withStore(async store => {
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new Error('memory thread unavailable'); } }
  });
  await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 10, entries: fallbackBatch() });
  assert.equal(store.getSyncCursor('phone_a'), 12);
  assert.equal(store.listMessages('yuqi', 20).length, 2);
  assert.equal(
    store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?')
      .get('turn_phone_11').state,
    'queued'
  );
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

test('invalid recovery checksums stop reconciliation before cursor acknowledgement or facts can be promoted', async () => withStore(async store => {
  const corrupted = fallbackBatch();
  corrupted[1] = { ...corrupted[1], checksum: '0'.repeat(64) };
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('must not run'); } }
  });
  await assert.rejects(
    reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 100, entries: corrupted }),
    /checksum/
  );
  assert.equal(store.getSyncCursor('phone_a'), 0);
}));

test('invalid recovery cursors stop reconciliation before cursor acknowledgement', async () => withStore(async store => {
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('must not run'); } }
  });
  await assert.rejects(
    reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: '100', entries: [] }),
    /invalid recovery snapshot/
  );
  assert.equal(store.getSyncCursor('phone_a'), 0);
}));

test('forged Android lastSeq variants cannot advance a reconciler cursor', async () => withStore(async store => {
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('must not run'); } }
  });
  for (const recovery of [
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 11, entries: fallbackBatch() },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 13, entries: fallbackBatch() },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: '10', entries: [] },
    { peerId: 'phone_a', lastCommonSeq: 10, lastSeq: 10, entries: [], extra: true }
  ]) {
    await assert.rejects(reconciler.reconcileFrom(recovery), /invalid recovery snapshot/);
    assert.equal(store.getSyncCursor('phone_a'), 0);
  }
}));

test('accepts the exact legacy Android checksum that escaped forward slashes', async () => withStore(async store => {
  const payload = {
    messageId: 'msg_legacy_slash', turnId: 'turn_legacy_slash', characterId: 'yuqi',
    speakerId: 'yuqi', speakerType: 'character', recipientId: 'user',
    content: '<al_schedule>{"next":"later"}</al_schedule>', sentAt: 1784400003000,
    origin: 'legacy_fallback', deviceId: 'phone_a:legacy', deviceSeq: 14
  };
  const legacyChecksum = createHash('sha256')
    .update(canonicalJson(payload).replaceAll('/', '\\/'), 'utf8')
    .digest('hex');
  const entry = { ...messageEntry(14, payload), checksum: legacyChecksum };
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { return { text: '{"candidates":[]}' }; } }
  });

  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 13, entries: [entry] });

  assert.equal(result.importedMessages, 1);
  assert.equal(store.getMessage('msg_legacy_slash').content, payload.content);
  assert.equal(store.getSyncCursor('phone_a'), 14);
}));

test('imports an evidence-linked human annotation for later preset publication', async () => withStore(async store => {
  const payload = {
    annotationId: 'annotation_phone_1', turnId: 'turn_phone_11', sourceMessageId: 'msg_fallback_11',
    presetVersion: '1.0.0', userCorrection: '这句是调侃，不是正式索取。',
    desiredBehavior: '先结合前后文判断玩笑，再决定是否写入稳定记忆。', status: 'proposed', createdAt: 1784400002000
  };
  const entry = {
    seq: 13, entityType: 'annotation', entityId: payload.annotationId, operation: 'insert', payload,
    checksum: contentHash(payload), createdAt: payload.createdAt
  };
  const reconciler = new YuqiReconciler({
    store,
    codex: { async runTurn() { throw new AssertionError('annotation-only sync does not need a role turn'); } }
  });
  const result = await reconciler.reconcileFrom({ peerId: 'phone_a', lastCommonSeq: 12, entries: [entry] });
  assert.equal(result.importedAnnotations, 1);
  assert.equal(store.getAnnotation('annotation_phone_1').sourceMessageId, 'msg_fallback_11');
  assert.equal(store.getAnnotation('annotation_phone_1').status, 'proposed');
}));
