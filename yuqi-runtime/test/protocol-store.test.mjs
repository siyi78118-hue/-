import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  TURN_STATES,
  canonicalJson,
  contentHash,
  validateEnvelope
} from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';
import { publicTurnStatus } from '../src/turn-status.mjs';

function validEnvelope(overrides = {}) {
  return {
    protocolVersion: 1,
    turnId: 'turn_device1_1',
    characterId: 'yuqi',
    deviceId: 'device1',
    deviceSeq: 1,
    createdAt: 1784400000000,
    message: {
      messageId: 'msg_device1_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    },
    ...overrides
  };
}

function validV2Envelope(overrides = {}) {
  return {
    protocolVersion: 2,
    turnId: 'turn_device2_1',
    characterId: 'yuqi',
    deviceId: 'device2',
    deviceSeq: 1,
    createdAt: 1784400000000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_device2_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你好',
      sentAt: 1784400000000
    },
    ...overrides
  };
}

function validTriggerEnvelope(overrides = {}) {
  return {
    protocolVersion: 2,
    turnId: 'turn_device2_proactive_1',
    characterId: 'yuqi',
    deviceId: 'device2',
    deviceSeq: 2,
    createdAt: 1784400001000,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_device2_proactive_1',
      triggerType: 'proactive_chat',
      scheduledFor: 1784400000000,
      executedAt: 1784400001000
    },
    ...overrides
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-store-'));
  const file = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(file);
  try {
    return run({ store, file });
  } finally {
    store.close();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== 'EPERM') throw error;
        if (attempt === 9 && process.platform === 'win32') break;
        if (attempt === 9) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
    }
  }
}

test('canonical JSON and hash are stable across object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));
});

test('rejects an envelope whose speaker identity conflicts with its type', () => {
  const value = validEnvelope({
    message: {
      ...validEnvelope().message,
      speakerId: 'yuqi',
      speakerType: 'user'
    }
  });
  assert.throws(() => validateEnvelope(value), /speaker mismatch/i);
});

test('protocol v2 direct turn preserves the exact user message and kind', () => {
  const value = validateEnvelope(validV2Envelope());
  assert.equal(value.protocolVersion, 2);
  assert.equal(value.kind, 'DIRECT_REPLY');
  assert.equal(value.message.speakerId, 'user');
  assert.equal(value.message.content, '你好');
  assert.equal(value.trigger, undefined);
});

test('protocol v2 accepts legacy payment ids by canonicalizing them before validation', () => {
  const value = validateEnvelope(validV2Envelope({
    turnId: 'turn_pay_1784713105609_3qb4xo',
    message: {
      ...validV2Envelope().message,
      messageId: 'pay_1784713105609_3qb4xo',
      content: '姜隽倚给虞栖发了一个红包：¥20.00'
    }
  }));

  assert.equal(value.message.messageId, 'msg_pay_1784713105609_3qb4xo');
});

test('canonical payment recovery suppresses the already-ingested legacy alias', () => withStore(({ store }) => {
  store.putMessage({
    messageId: 'pay_1784713105609_3qb4xo',
    turnId: 'turn_pay_1784713105609_3qb4xo',
    characterId: 'yuqi',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '姜隽倚给虞栖发了一个红包：¥20.00',
    sentAt: 1784713109805,
    origin: 'phone',
    deviceId: 'device2',
    deviceSeq: 1784713105609
  });
  store.submitTurn(validV2Envelope({
    turnId: 'turn_pay_1784713105609_3qb4xo',
    deviceSeq: 1784713105609,
    createdAt: 1784713105609,
    message: {
      ...validV2Envelope().message,
      messageId: 'pay_1784713105609_3qb4xo',
      content: '姜隽倚给虞栖发了一个红包：¥20.00',
      sentAt: 1784713105609
    }
  }));

  assert.deepEqual(store.listMessages('yuqi', 10).map(message => message.messageId), [
    'msg_pay_1784713105609_3qb4xo'
  ]);
  assert.equal(store.isMessageSuppressed('pay_1784713105609_3qb4xo'), true);
}));

test('protocol v2 automatic turn persists a trigger without creating a user message', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  assert.equal(turn.sourceMessageId, 'trigger_device2_proactive_1');
  assert.equal(store.listMessages('yuqi', 10).length, 0);
}));

test('normalizes authenticated legacy Android automatic turn IDs without widening direct-message IDs', () => {
  const automatic = validateEnvelope(validTriggerEnvelope({ turnId: 'cloud_proactive_job_1' }));
  assert.equal(automatic.turnId, 'turn_cloud_proactive_job_1');
  assert.throws(
    () => validateEnvelope(validV2Envelope({ turnId: 'cloud_direct_1' })),
    /invalid turnId/i
  );
});

test('protocol v2 automatic turn rejects a fabricated user message', () => {
  assert.throws(
    () => validateEnvelope(validTriggerEnvelope({ message: validV2Envelope().message })),
    /automatic turn cannot contain a message/i
  );
});

test('accepts only known durable turn states', () => {
  assert.deepEqual(TURN_STATES, [
    'queued',
    'memory_running',
    'memory_done',
    'brain_running',
    'brain_done',
    'supervisor_running',
    'approved',
    'committed',
    'delivered',
    'completed',
    'fallback',
    'failed'
  ]);
});

test('submitTurn is idempotent and survives reopening', () => withStore(({ store, file }) => {
  const first = store.submitTurn(validEnvelope());
  const second = store.submitTurn(validEnvelope());
  assert.equal(first.turnId, second.turnId);
  assert.equal(store.listMessages('yuqi', 10).length, 1);

  store.close();
  const reopened = new YuqiStore(file);
  try {
    assert.equal(reopened.getTurn(first.turnId).state, 'queued');
    assert.equal(reopened.listMessages('yuqi', 10)[0].speakerId, 'user');
  } finally {
    reopened.close();
  }
}));

test('the same device sequence cannot be attached to a different message', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  const conflicting = validEnvelope({
    turnId: 'turn_device1_2',
    message: {
      ...validEnvelope().message,
      messageId: 'msg_device1_other',
      content: '另一条'
    }
  });
  assert.throws(() => store.submitTurn(conflicting), /device sequence conflict/i);
}));

test('state transitions use compare-and-set semantics', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  const claimed = store.claimTurn('worker-a');
  assert.equal(claimed.state, 'memory_running');
  assert.equal(claimed.workerId, 'worker-a');
  assert.throws(
    () => store.advanceTurn(claimed.turnId, 'queued', 'memory_done', {}),
    /stale turn state/i
  );
  const advanced = store.advanceTurn(claimed.turnId, 'memory_running', 'memory_done', {
    memoryPacketJson: '{"facts":[]}'
  });
  assert.equal(advanced.state, 'memory_done');
}));

test('persists the selected route and completed stage timings', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.setTurnRoute(turn.turnId, 'fast', ['ordinary_chat']);
  store.beginStage(turn.turnId, 'memory', 'gpt-5.6-terra', 'medium', 1000);
  store.finishStage(turn.turnId, 'memory', 1450);

  const saved = store.getTurn(turn.turnId);
  assert.equal(saved.route, 'fast');
  assert.deepEqual(saved.routeReasons, ['ordinary_chat']);
  assert.deepEqual(store.getTurnStages(turn.turnId), [{
    stage: 'memory',
    ordinal: 1,
    model: 'gpt-5.6-terra',
    effort: 'medium',
    startedAt: 1000,
    finishedAt: 1450,
    durationMs: 450
  }]);
}));

test('public turn status separates immersive copy from technical details', () => withStore(({ store }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.setTurnRoute(turn.turnId, 'fast', ['ordinary_chat']);
  store.beginStage(turn.turnId, 'memory', 'gpt-5.6-terra', 'medium', 1784400000000);

  const status = publicTurnStatus(store.getTurn(turn.turnId), {
    stages: store.getTurnStages(turn.turnId),
    clock: () => 1784400000600
  });
  assert.equal(status.route, 'fast');
  assert.equal(status.displayStage, '正在翻一下我们以前说过的话…');
  assert.equal(status.technicalStage, 'memory');
  assert.equal(status.stageModel, 'gpt-5.6-terra');
  assert.equal(status.stageEffort, 'medium');
  assert.equal(status.stageElapsedMs, 600);
  assert.equal(status.totalElapsedMs, 600);
}));

test('lists every nonterminal turn for dispatcher recovery and excludes committed turns', () => withStore(({ store }) => {
  const first = store.submitTurn(validEnvelope());
  const second = store.submitTurn(validV2Envelope({
    turnId: 'turn_device2_2',
    deviceSeq: 2,
    message: { ...validV2Envelope().message, messageId: 'msg_device2_2' }
  }));
  store.claimTurnById(first.turnId, 'worker-a');
  store.claimTurnById(second.turnId, 'worker-a');
  store.advanceTurn(second.turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
  store.advanceTurn(second.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(second.turnId, 'brain_running', 'brain_done', { brainDraftJson: '{"reply":"ok"}' });
  store.advanceTurn(second.turnId, 'brain_done', 'supervisor_running');
  store.advanceTurn(second.turnId, 'supervisor_running', 'approved', { supervisorJson: '{"approved":true}' });
  store.advanceTurn(second.turnId, 'approved', 'committed', { replyJson: '{"reply":{"content":"ok"}}' });

  assert.deepEqual(store.listRecoverableTurns().map(turn => turn.turnId), [first.turnId]);
}));

test('persists one cloud delivery target per turn and peer across reopening', () => withStore(({ store, file }) => {
  const turn = store.submitTurn(validV2Envelope());
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 44);
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 44);
  assert.equal(store.listCloudDeliveries(turn.turnId).length, 1);

  store.close();
  const reopened = new YuqiStore(file);
  try {
    const [delivery] = reopened.listCloudDeliveries(turn.turnId);
    assert.equal(delivery.peerId, 'phone_peer');
    assert.equal(delivery.recoveryAckSeq, 44);
    assert.equal(delivery.state, 'waiting');
  } finally {
    reopened.close();
  }
}));

test('recovers a failed brain draft as one committed reply and resets cloud delivery', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  store.claimTurnById(turn.turnId, 'worker-a');
  store.advanceTurn(turn.turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
  store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
  store.advanceTurn(turn.turnId, 'brain_running', 'brain_done', {
    brainDraftJson: JSON.stringify({ reply: '原来是AI短剧。小团队还负责得多，难怪你忙成这样😂', usedFactIds: [] })
  });
  store.advanceTurn(turn.turnId, 'brain_done', 'failed', {
    errorJson: JSON.stringify({ name: 'Error', message: 'hard validation failed: BACKSTAGE_LEAK' })
  });
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 42);
  const failedDelivery = store.prepareCloudDelivery(turn.turnId, 'phone_peer', {
    turnId: turn.turnId, state: 'failed', terminal: true
  });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', failedDelivery.checksum);

  const recovered = store.recoverFailedDraft(turn.turnId, {
    peerId: 'phone_peer', sentAt: 1784400004000
  });
  const repeated = store.recoverFailedDraft(turn.turnId, {
    peerId: 'phone_peer', sentAt: 1784400005000
  });
  const [delivery] = store.listCloudDeliveries(turn.turnId);

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.result.reply.content, '原来是AI短剧。小团队还负责得多，难怪你忙成这样😂');
  assert.equal(store.getTurn(turn.turnId).state, 'committed');
  assert.equal(store.getMessage(recovered.result.reply.messageId)?.turnId, turn.turnId);
  assert.equal(delivery.state, 'waiting');
  assert.equal(delivery.recoveryAckSeq, 42);
  assert.equal(delivery.checksum, '');
  assert.equal(repeated.recovered, false);
  assert.equal(repeated.result.reply.messageId, recovered.result.reply.messageId);
}));

test('a proactive reply stays outside shared memory until the phone confirms persistence', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  const reply = store.putMessage({
    messageId: 'msg_yuqi_pending_phone_1',
    turnId: turn.turnId,
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '这是只在手机确认后才算说过的话',
    sentAt: 1784400002000,
    origin: 'codex'
  });

  store.quarantinePendingReply(reply.messageId);
  store.registerCloudDelivery(turn.turnId, 'phone_peer', 0);
  const prepared = store.prepareCloudDelivery(turn.turnId, 'phone_peer', { turnId: turn.turnId });
  store.markCloudDeliveryAttempt(turn.turnId, 'phone_peer');
  store.markCloudDeliveryMailboxed(turn.turnId, 'phone_peer', prepared.checksum);

  assert.equal(store.listMessages('yuqi', 20).some(message => message.messageId === reply.messageId), false);

  const confirmed = store.confirmCloudDelivery(turn.turnId, 'phone_peer', {
    messageId: reply.messageId,
    contentSha256: createHash('sha256').update(reply.content, 'utf8').digest('hex'),
    receivedAt: 1784400003000
  });

  assert.equal(confirmed.state, 'confirmed');
  assert.equal(store.listMessages('yuqi', 20).some(message => message.messageId === reply.messageId), true);
}));

test('facts supported by an unconfirmed reply stay outside retrieval', () => withStore(({ store }) => {
  const turn = store.submitTurn(validTriggerEnvelope());
  const reply = store.putMessage({
    messageId: 'msg_yuqi_pending_fact_1', turnId: turn.turnId, characterId: 'yuqi',
    speakerId: 'yuqi', speakerType: 'character', recipientId: 'user',
    content: '我说我已经买了饭团', sentAt: 1784400002000, origin: 'codex'
  });
  store.putFact({
    factId: 'fact_pending_delivery_1', characterId: 'yuqi', subjectId: 'yuqi',
    predicate: 'bought', object: { item: '饭团' }, evidenceMode: 'exact',
    sourceMessageIds: [reply.messageId], exactQuotes: [{ messageId: reply.messageId, text: reply.content }],
    status: 'verified', confidence: 0.99, origin: 'memory'
  });

  store.quarantinePendingReply(reply.messageId);

  assert.deepEqual(store.listRetrievableFacts('yuqi'), []);
  assert.equal(store.listFacts('yuqi').length, 1);
}));

test('sync deltas are ordered, checksummed, and acknowledged independently', () => withStore(({ store }) => {
  store.submitTurn(validEnvelope());
  store.putMessage({
    messageId: 'msg_yuqi_1',
    turnId: 'turn_device1_1',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '你好呀',
    sentAt: 1784400001000,
    origin: 'codex'
  });
  const delta = store.getSyncDelta(0, 20);
  assert.ok(delta.length >= 3);
  assert.deepEqual(delta.map(item => item.seq), [...delta.map(item => item.seq)].sort((a, b) => a - b));
  assert.ok(delta.every(item => /^[a-f0-9]{64}$/.test(item.checksum)));
  assert.equal(store.ackSync('phone', delta.at(-1).seq), delta.at(-1).seq);
  assert.equal(store.getSyncCursor('phone'), delta.at(-1).seq);
}));
