import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudRelayPump,
  decryptRelayPayload,
  encryptRelayPayload
} from '../src/cloud-relay-pump.mjs';
import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { contentHash } from '../src/protocol.mjs';

const keyBase64 = Buffer.alloc(32, 7).toString('base64');
const envelope = {
  protocolVersion: 1,
  turnId: 'turn_phone_cloud_1',
  characterId: 'yuqi',
  deviceId: 'phone_cloud',
  deviceSeq: 1,
  createdAt: 1784400000001,
  message: {
    messageId: 'msg_phone_cloud_1', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: '在吗', sentAt: 1784400000001
  },
  recovery: { peerId: 'phone_cloud', lastCommonSeq: 0, lastSeq: 0, entries: [] }
};

const v2Envelope = {
  protocolVersion: 2,
  turnId: 'turn_phone_cloud_v2_1',
  characterId: 'yuqi',
  deviceId: 'phone_cloud',
  deviceSeq: 2,
  createdAt: 1784400000002,
  kind: 'DIRECT_REPLY',
  message: {
    messageId: 'msg_phone_cloud_v2_1', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: '换到云端继续', sentAt: 1784400000002
  },
  recovery: { peerId: 'phone_cloud', lastCommonSeq: 0, entries: [] }
};

const staleProactiveEnvelope = {
  protocolVersion: 2,
  turnId: 'turn_phone_cloud_stale_proactive',
  characterId: 'yuqi',
  deviceId: 'phone_cloud',
  deviceSeq: 3,
  createdAt: 1784500000000,
  kind: 'PROACTIVE_CHAT',
  trigger: {
    triggerId: 'trigger_phone_cloud_stale_proactive',
    triggerType: 'proactive_chat',
    scheduledFor: 1784500000000,
    executedAt: 1784500000000,
    reason: 'planned'
  },
  recovery: { peerId: 'phone_cloud', lastCommonSeq: 0, entries: [] }
};

function v3Envelope(content = 'v3 云端消息') {
  const message = {
    messageId: 'msg_phone_cloud_v3_1', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content, sentAt: 1784400000003
  };
  return {
    protocolVersion: 3,
    turnId: 'turn_phone_cloud_v3_1', characterId: 'yuqi', deviceId: 'phone_cloud', deviceSeq: 3,
    createdAt: 1784400000003, kind: 'DIRECT_REPLY', message,
    context: {
      currentBatch: {
        batchId: 'batch_phone_cloud_v3_1', messageIds: [message.messageId],
        startedAt: message.sentAt, committedAt: 1784400000003, messages: [message]
      },
      visibilityCursor: {
        nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
        uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0,
        localSequence: 1, clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0,
        chatOpen: true, quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat',
      rootSourceId: message.messageId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId
      }),
      claimedLineageRevision: 1, retryOfTurnId: null
    },
    recovery: { peerId: 'phone_cloud', lastCommonSeq: 0, entries: [] }
  };
}

function relayFixture(payload = envelope) {
  const encrypted = encryptRelayPayload(payload, keyBase64, Buffer.alloc(12, 3));
  const state = { inbound: [{ messageId: 'relay_phone_cloud_1', ...encrypted }], enqueued: [], acked: [] };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (path === '/bridge/poll') return Response.json({ ok: true, messages: state.inbound });
    if (path === '/bridge/enqueue') {
      state.enqueued.push(JSON.parse(options.body));
      return Response.json({ ok: true }, { status: 201 });
    }
    if (path === '/bridge/ack') {
      state.acked.push(...JSON.parse(options.body).messageIds);
      state.inbound = state.inbound.filter(item => !state.acked.includes(item.messageId));
      return Response.json({ ok: true, deleted: 1 });
    }
    throw new Error(`unexpected relay path ${path}`);
  };
  return { state, fetchImpl };
}

test('decrypts a phone envelope, reconciles first, and enqueues one opaque reply', async () => {
  const relay = relayFixture();
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    reconciler: { async reconcileFrom(value) { events.push(`reconcile:${value.peerId}`); return { ackSeq: 44 }; } },
    orchestrator: { async process(value) { events.push(`turn:${value.turnId}`); return { turnId: value.turnId, reply: { content: '在。' } }; } }
  });
  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(events, ['reconcile:phone_cloud', 'turn:turn_phone_cloud_1']);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
  assert.equal(relay.state.enqueued[0].direction, 'pc_to_phone');
  assert.equal('reply' in relay.state.enqueued[0], false);
  const decoded = decryptRelayPayload(relay.state.enqueued[0], keyBase64);
  assert.equal(decoded.reply.content, '在。');
  assert.equal(decoded.recoveryAckSeq, 44);
});

test('does not acknowledge input when a role fails, so recovery can retry it', async () => {
  const relay = relayFixture();
  const diagnostics = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { async process() { throw new Error('supervisor unavailable'); } },
    store: { putDiagnostic(value) { diagnostics.push(value); } },
    clock: () => 1784512000000
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(relay.state.acked, []);
  assert.equal(relay.state.enqueued.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].turnId, envelope.turnId);
  assert.equal(diagnostics[0].stage, 'cloud_relay_message');
  assert.deepEqual(diagnostics[0].detail, {
    relayMessageId: 'relay_phone_cloud_1',
    message: 'supervisor unavailable'
  });
});

test('poll failure remains unacknowledged and becomes visible in relay status', async () => {
  const diagnostics = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64,
    fetchImpl: async () => { throw new Error('connect timeout'); },
    orchestrator: { async process() { throw new Error('must not process'); } },
    store: { putDiagnostic(value) { diagnostics.push(value); } },
    proxyEnabled: true,
    clock: () => 1784512000000
  });

  await assert.rejects(pump.pumpOnce(), /connect timeout/);

  assert.deepEqual(pump.status(), {
    enabled: true,
    proxyEnabled: true,
    connected: false,
    lastSuccessAt: 0,
    lastErrorAt: 1784512000000,
    lastError: 'connect timeout',
    pendingProcessed: 0
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].stage, 'cloud_relay_poll');
  assert.equal(JSON.stringify(diagnostics[0]).includes('device-token-123456789'), false);
});

test('stale proactive cloud turn reconciles and acknowledges without dispatching a visible reply', async () => {
  const relay = relayFixture(staleProactiveEnvelope);
  const events = [];
  const diagnostics = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { throw new Error('stale proactive must not dispatch'); } },
    store: {
      registerCloudDelivery() { throw new Error('stale proactive must not create a delivery'); },
      putDiagnostic(value) { diagnostics.push(value); }
    },
    reconciler: {
      async reconcileFrom(value) { events.push(`reconcile:${value.peerId}`); return { ackSeq: 88 }; }
    },
    proxyEnabled: true,
    clock: () => 1784512000000
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.equal(result.suppressed, 1);
  assert.deepEqual(events, ['reconcile:phone_cloud']);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
  assert.equal(relay.state.enqueued.length, 0);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].turnId, staleProactiveEnvelope.turnId);
  assert.equal(diagnostics[0].stage, 'stale_proactive_suppressed');
  assert.deepEqual(diagnostics[0].detail, { ageMs: 12000000 });
});

test('canonical v3 lane busy stays retryable with no diagnostic, registration, or ACK', async () => {
  const busyEnvelope = structuredClone(v3Envelope());
  busyEnvelope.turnId = 'turn_phone_cloud_busy';
  busyEnvelope.kind = 'PROACTIVE_CHAT';
  delete busyEnvelope.message;
  delete busyEnvelope.context.currentBatch;
  busyEnvelope.trigger = {
    triggerId: 'trigger_phone_cloud_busy',
    triggerType: 'proactive_chat',
    scheduledFor: busyEnvelope.createdAt,
    executedAt: busyEnvelope.createdAt,
    context: {}
  };
  busyEnvelope.authority.rootSourceId = busyEnvelope.trigger.triggerId;
  busyEnvelope.authority.lineageKey = deriveAuthorityLineageKey({
    roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: busyEnvelope.trigger.triggerId
  });
  const relay = relayFixture(busyEnvelope);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: {
      accept() {
        events.push('accept');
        const error = new Error('interaction lane is busy');
        error.code = 'INTERACTION_LANE_BUSY';
        throw error;
      }
    },
    store: {
      registerCloudDelivery() { events.push('register'); },
      putDiagnostic() { events.push('diagnostic'); }
    },
    clock: () => busyEnvelope.createdAt
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(events, ['accept']);
  assert.deepEqual(relay.state.acked, []);
});

test('authenticated recovery is reconciled once before lane-busy retry and never ACKs the busy turn', async () => {
  const busyEnvelope = structuredClone(v3Envelope());
  busyEnvelope.turnId = 'turn_phone_cloud_busy_with_recovery';
  busyEnvelope.kind = 'PROACTIVE_CHAT';
  delete busyEnvelope.message;
  delete busyEnvelope.context.currentBatch;
  busyEnvelope.trigger = {
    triggerId: 'trigger_phone_cloud_busy_with_recovery',
    triggerType: 'proactive_chat',
    scheduledFor: busyEnvelope.createdAt,
    executedAt: busyEnvelope.createdAt,
    context: {}
  };
  busyEnvelope.authority.rootSourceId = busyEnvelope.trigger.triggerId;
  busyEnvelope.authority.lineageKey = deriveAuthorityLineageKey({
    roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: busyEnvelope.trigger.triggerId
  });
  const recoveryMessage = {
    messageId: 'recovery_message_busy',
    turnId: 'legacy_recovery_turn',
    characterId: 'yuqi', deviceId: 'phone_cloud', deviceSeq: 1,
    speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: 'recovered once', sentAt: busyEnvelope.createdAt
  };
  const recoveryAnnotation = {
    annotationId: 'recovery_annotation_busy', roleId: 'yuqi', turnId: 'legacy_recovery_turn',
    kind: 'recovery_note', value: 'reconciled once'
  };
  busyEnvelope.recovery = {
    peerId: 'phone_cloud',
    lastCommonSeq: 0,
    lastSeq: 2,
    entries: [
      {
        seq: 1, entityType: 'message', entityId: recoveryMessage.messageId,
        operation: 'upsert', payload: recoveryMessage, checksum: contentHash(recoveryMessage)
      },
      {
        seq: 2, entityType: 'annotation', entityId: recoveryAnnotation.annotationId,
        operation: 'upsert', payload: recoveryAnnotation, checksum: contentHash(recoveryAnnotation)
      }
    ]
  };
  const relay = relayFixture(busyEnvelope);
  const events = [];
  const sync = { value: 0 };
  const messages = new Map();
  const annotations = new Map();
  let dispatches = 0;
  let diagnostics = 0;
  const store = {
    getSyncCursor() { return sync.value; },
    ackSync(_peerId, seq) { sync.value = Math.max(sync.value, Number(seq)); events.push(`ack-sync:${seq}`); },
    getMessage(messageId) { return messages.get(messageId) || null; },
    putMessage(value) { messages.set(value.messageId, structuredClone(value)); events.push(`message:${value.messageId}`); return value; },
    getAnnotation(annotationId) { return annotations.get(annotationId) || null; },
    putAnnotation(value) { annotations.set(value.annotationId, structuredClone(value)); events.push(`annotation:${value.annotationId}`); return value; },
    putDiagnostic() { diagnostics += 1; },
    registerCloudDelivery() { events.push('legacy-delivery'); }
  };
  const reconciler = {
    async reconcileFrom(value) {
      events.push(`reconcile:${value.peerId}`);
      const { YuqiReconciler } = await import('../src/reconcile.mjs');
      return new YuqiReconciler({ store, codex: {} }).reconcileFrom(value);
    }
  };
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    reconciler,
    dispatcher: {
      accept() {
        dispatches += 1;
        const error = new Error('interaction lane is busy');
        error.code = 'INTERACTION_LANE_BUSY';
        throw error;
      }
    },
    store,
    clock: () => busyEnvelope.createdAt
  });
  const first = await pump.pumpOnce();
  const second = await pump.pumpOnce();
  assert.equal(first.failed, 1);
  assert.equal(second.failed, 1);
  assert.equal(dispatches, 2);
  assert.equal(sync.value, 2);
  assert.equal(messages.size, 1);
  assert.equal(annotations.size, 1);
  assert.equal(events.filter(event => event.startsWith('message:')).length, 1);
  assert.equal(events.filter(event => event.startsWith('annotation:')).length, 1);
  assert.equal(diagnostics, 0);
  assert.equal(events.some(event => event.startsWith('ack-sync:')), true);
  assert.equal(events.includes('legacy-delivery'), false);
  assert.deepEqual(relay.state.acked, []);
});

test('uses deterministic output identity so duplicate cloud delivery cannot create duplicate replies', async () => {
  const relay = relayFixture();
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { async process(value) { return { turnId: value.turnId, reply: { content: '只回复一次' } }; } }
  });
  await pump.pumpOnce();
  relay.state.inbound = relayFixture().state.inbound;
  await pump.pumpOnce();
  assert.equal(relay.state.enqueued[0].messageId, relay.state.enqueued[1].messageId);
  assert.equal(relay.state.enqueued[0].idempotencyKey, relay.state.enqueued[1].idempotencyKey);
});

test('v2 cloud ingress acknowledges after durable dispatch without waiting for the reply', async () => {
  const relay = relayFixture(v2Envelope);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: {
      accept(value) {
        events.push(`accept:${value.turnId}`);
        return { turnId: value.turnId, state: 'queued' };
      }
    },
    store: {
      registerCloudDelivery(turnId, peerId, recoveryAckSeq) {
        events.push(`delivery:${turnId}:${peerId}:${recoveryAckSeq}`);
      }
    },
    reconciler: {
      async reconcileFrom(value) { events.push(`reconcile:${value.peerId}`); return { ackSeq: 55 }; }
    },
    outbox: { async flushOnce() { events.push('outbox'); return { delivered: 0 }; } }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
  assert.equal(relay.state.enqueued.length, 0);
  assert.deepEqual(events, [
    'reconcile:phone_cloud',
    'accept:turn_phone_cloud_v2_1',
    'delivery:turn_phone_cloud_v2_1:phone_cloud:55',
    'outbox'
  ]);
});

test('canonical v2 and v3 cloud turns acknowledge once without creating a legacy delivery', async () => {
  for (const incoming of [v2Envelope, v3Envelope('canonical cloud turn')]) {
    const relay = relayFixture(incoming);
    const registrations = [];
    const pump = new CloudRelayPump({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
      dispatcher: {
        accept(value) {
          return { turnId: value.turnId, state: 'queued', resultAuthorityVersion: 1 };
        }
      },
      store: {
        registerCloudDelivery(...args) { registrations.push(args); }
      },
      reconciler: { async reconcileFrom() { return { ackSeq: 55 }; } },
      outbox: { async flushOnce() { return { delivered: 0 }; } }
    });

    const result = await pump.pumpOnce();

    assert.equal(result.processed, 1);
    assert.deepEqual(registrations, []);
    assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
  }
});

test('v2 duplicate checksum conflict keeps the authoritative turn and acknowledges the relay envelope', async () => {
  const relay = relayFixture(v2Envelope);
  const events = [];
  const authoritative = { turnId: v2Envelope.turnId, state: 'failed' };
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: {
      accept() { throw new Error('turn checksum conflict'); }
    },
    store: {
      getTurn(turnId) {
        events.push(`lookup:${turnId}`);
        return authoritative;
      },
      registerCloudDelivery(turnId, peerId, recoveryAckSeq) {
        events.push(`delivery:${turnId}:${peerId}:${recoveryAckSeq}`);
      },
      putDiagnostic(value) { events.push(`diagnostic:${value.stage}:${value.detail.state}`); }
    },
    reconciler: { async reconcileFrom() { return { ackSeq: 61 }; } },
    outbox: { async flushOnce() { events.push('outbox'); return { delivered: 1 }; } }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
  assert.deepEqual(events, [
    'lookup:turn_phone_cloud_v2_1',
    'diagnostic:duplicate_turn_payload_ignored:failed',
    'delivery:turn_phone_cloud_v2_1:phone_cloud:61',
    'outbox'
  ]);
});

test('malformed v3 cloud ingress does not reconcile, write, or acknowledge', async () => {
  const malformed = { ...v2Envelope, protocolVersion: 3, turnId: 'turn_phone_cloud_bad_v3' };
  const relay = relayFixture(malformed);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { events.push('accept'); return { turnId: malformed.turnId, state: 'queued' }; } },
    store: {
      registerCloudDelivery() { events.push('delivery'); },
      putDiagnostic() { events.push('diagnostic'); }
    },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } }
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(relay.state.acked, []);
});

test('invalid cloud recovery checksum is rejected before reconciliation, store work, or acknowledgement', async () => {
  const invalidRecovery = {
    ...v2Envelope,
    turnId: 'turn_phone_cloud_bad_recovery',
    recovery: {
      peerId: 'phone_cloud', lastCommonSeq: 100,
      entries: [{ seq: 1, entityType: 'message', entityId: 'msg_bad_recovery', operation: 'insert', payload: {}, checksum: '0'.repeat(64) }]
    }
  };
  const relay = relayFixture(invalidRecovery);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { events.push('accept'); return { turnId: invalidRecovery.turnId, state: 'queued' }; } },
    store: {
      registerCloudDelivery() { events.push('delivery'); },
      putDiagnostic() { events.push('diagnostic'); }
    },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } }
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(relay.state.acked, []);
});

test('invalid cloud recovery cursor is rejected before reconciliation, store work, or acknowledgement', async () => {
  const invalidRecovery = {
    ...v2Envelope,
    turnId: 'turn_phone_cloud_bad_recovery_cursor',
    recovery: { peerId: 'phone_cloud', lastCommonSeq: '100', entries: [] }
  };
  const relay = relayFixture(invalidRecovery);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { events.push('accept'); return { turnId: invalidRecovery.turnId, state: 'queued' }; } },
    store: {
      registerCloudDelivery() { events.push('delivery'); },
      putDiagnostic() { events.push('diagnostic'); }
    },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } }
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(relay.state.acked, []);
});

test('forged Android lastSeq recovery variants are rejected before cloud side effects', async () => {
  const variants = [
    { peerId: 'phone_cloud', lastCommonSeq: 10, lastSeq: 9, entries: [] },
    { peerId: 'phone_cloud', lastCommonSeq: 10, lastSeq: 11, entries: [] },
    { peerId: 'phone_cloud', lastCommonSeq: 10, lastSeq: '10', entries: [] },
    { peerId: 'phone_cloud', lastCommonSeq: 10, lastSeq: 10, entries: [], extra: true }
  ];
  for (const [index, recovery] of variants.entries()) {
    const invalidRecovery = {
      ...v2Envelope,
      turnId: `turn_phone_cloud_bad_last_seq_${index}`,
      recovery
    };
    const relay = relayFixture(invalidRecovery);
    const events = [];
    const pump = new CloudRelayPump({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
      dispatcher: { accept() { events.push('accept'); return { turnId: invalidRecovery.turnId, state: 'queued' }; } },
      store: {
        registerCloudDelivery() { events.push('delivery'); },
        putDiagnostic() { events.push('diagnostic'); }
      },
      reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } }
    });
    const result = await pump.pumpOnce();
    assert.equal(result.failed, 1);
    assert.deepEqual(events, []);
    assert.deepEqual(relay.state.acked, []);
  }
});

test('changed v3 checksum conflict is not treated as an acknowledged duplicate', async () => {
  const original = v3Envelope();
  const changed = v3Envelope('已被改写的同一 turn');
  const relay = relayFixture(changed);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { events.push('accept'); throw new Error('turn checksum conflict'); } },
    store: {
      getTurn(turnId) {
        events.push(`lookup:${turnId}`);
        return { turnId: original.turnId, envelopeChecksum: contentHash(original) };
      },
      registerCloudDelivery() { events.push('delivery'); },
      putDiagnostic() { events.push('diagnostic'); }
    },
    reconciler: { async reconcileFrom() { events.push('reconcile'); return { ackSeq: 1 }; } }
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(events, ['reconcile', 'accept', `lookup:${original.turnId}`]);
  assert.deepEqual(relay.state.acked, []);
});

test('a phone delivery receipt confirms memory without dispatching a chat turn', async () => {
  const receipt = {
    type: 'DELIVERY_RECEIPT',
    turnId: 'turn_phone_cloud_v2_1',
    messageId: 'msg_yuqi_phone_cloud_v2_1',
    contentSha256: 'a'.repeat(64),
    receivedAt: 1784400009000
  };
  const relay = relayFixture(receipt);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    dispatcher: { accept() { events.push('dispatch'); throw new Error('receipt must not dispatch'); } },
    store: {
      registerCloudDelivery() {},
      confirmCloudDelivery(turnId, peerId, value) {
        events.push(`confirm:${turnId}:${peerId}:${value.messageId}`);
        return { state: 'confirmed' };
      }
    }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(events, [
    'confirm:turn_phone_cloud_v2_1:phone_cloud:msg_yuqi_phone_cloud_v2_1'
  ]);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
});

test('an encrypted itemized phone receipt uses the unified exact delivery store before relay ack', async () => {
  const receipt = {
    type: 'DELIVERY_RECEIPT',
    protocolVersion: 1,
    turnId: 'turn_phone_cloud_v2_2',
    peerId: 'phone_cloud',
    deliveredAt: 1784400010000,
    items: [{ kind: 'message', id: 'msg_yuqi_2', checksum: 'b'.repeat(64) }]
  };
  const relay = relayFixture(receipt);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
    store: {
      registerCloudDelivery() {},
      confirmCloudDelivery() { throw new Error('legacy receipt path must not run'); },
      confirmCloudDeliveryItems(turnId, peerId, value) {
        events.push(`items:${turnId}:${peerId}:${value.items.length}`);
        return { complete: true };
      }
    }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(events, ['items:turn_phone_cloud_v2_2:phone_cloud:1']);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
});

test('an encrypted canonical v2 simple receipt uses its authority adapter before relay ack', async () => {
  const receipt = {
    type: 'DELIVERY_RECEIPT',
    turnId: 'turn_phone_cloud_canonical_v2_simple',
    messageId: 'msg_yuqi_canonical_v2_simple',
    contentSha256: 'c'.repeat(64),
    receivedAt: 1784400010500
  };
  const relay = relayFixture(receipt);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
    store: {
      getTurn: turnId => ({ turnId, resultAuthorityVersion: 1, protocolVersion: 2 }),
      confirmCanonicalV2SimpleDeliveryInternal(turnId, peerId, value) {
        events.push(`canonical-simple:${turnId}:${peerId}:${value.messageId}`);
        return { state: 'confirmed' };
      },
      confirmCloudDelivery() { throw new Error('legacy receipt writer must not run'); }
    }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(events, [
    'canonical-simple:turn_phone_cloud_canonical_v2_simple:phone_cloud:msg_yuqi_canonical_v2_simple'
  ]);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
});

test('an encrypted v3 authority delivery receipt uses the canonical writer before relay acknowledgement', async () => {
  const receipt = {
    protocolVersion: 3,
    type: 'AUTHORITY_DELIVERY_RECEIPT',
    peerId: 'phone_cloud',
    turnId: 'turn_phone_cloud_v3_1',
    authorityLineageKey: 'lin_phone_cloud_v3_1',
    visibleGroupId: 'group_phone_cloud_v3_1',
    commitChecksum: 'a'.repeat(64),
    terminalDisposition: 'skip',
    deliveredAt: 1784400011000
  };
  const relay = relayFixture(receipt);
  const events = [];
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
    store: {
      confirmAuthorityCloudDeliveryInternal(value) {
        events.push(`authority:${value.visibleGroupId}:${value.terminalDisposition}`);
        return { state: 'confirmed' };
      },
      confirmCloudDelivery() { throw new Error('legacy receipt writer must not run'); }
    }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.processed, 1);
  assert.deepEqual(events, ['authority:group_phone_cloud_v3_1:skip']);
  assert.deepEqual(relay.state.acked, ['relay_phone_cloud_1']);
});

test('encrypted v3 authority target-set conflicts leave both persisted and foreign peers unacknowledged', async () => {
  for (const peerId of ['phone_cloud', 'foreign_phone']) {
    const receipt = {
      protocolVersion: 3,
      type: 'AUTHORITY_DELIVERY_RECEIPT',
      peerId,
      turnId: 'turn_phone_cloud_v3_target_conflict',
      authorityLineageKey: 'lin_phone_cloud_v3_target_conflict',
      visibleGroupId: 'group_phone_cloud_v3_target_conflict',
      commitChecksum: 'a'.repeat(64),
      terminalDisposition: 'visible',
      deliveredAt: 1784400011000
    };
    const relay = relayFixture(receipt);
    const attemptedPeers = [];
    const pump = new CloudRelayPump({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
      orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
      store: {
        confirmAuthorityCloudDeliveryInternal(value) {
          attemptedPeers.push(value.peerId);
          throw new Error('canonical visible delivery target conflict');
        },
        confirmCloudDelivery() { throw new Error('legacy receipt writer must not run'); }
      }
    });
    const result = await pump.pumpOnce();
    assert.equal(result.failed, 1);
    assert.deepEqual(attemptedPeers, [peerId]);
    assert.deepEqual(relay.state.acked, []);
  }
});

test('an invalid encrypted v3 authority receipt does not call the store or acknowledge the relay', async () => {
  const receipt = {
    protocolVersion: 3,
    type: 'AUTHORITY_DELIVERY_RECEIPT',
    peerId: 'phone_cloud',
    turnId: 'turn_phone_cloud_v3_1',
    authorityLineageKey: 'lin_phone_cloud_v3_1',
    visibleGroupId: 'group_phone_cloud_v3_1',
    commitChecksum: 'a'.repeat(64),
    terminalDisposition: 'skip',
    deliveredAt: 1784400011000,
    unexpected: true
  };
  const relay = relayFixture(receipt);
  let calls = 0;
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
    store: { confirmAuthorityCloudDeliveryInternal() { calls += 1; } }
  });

  const result = await pump.pumpOnce();

  assert.equal(result.failed, 1);
  assert.equal(calls, 0);
  assert.deepEqual(relay.state.acked, []);
});

test('encrypted non-native v3 receipt dispositions never call the store or acknowledge', async () => {
  for (const terminalDisposition of [['skip'], { value: 'skip' }, 1, true, null]) {
    const receipt = {
      protocolVersion: 3,
      type: 'AUTHORITY_DELIVERY_RECEIPT',
      peerId: 'phone_cloud',
      turnId: 'turn_phone_cloud_v3_invalid_disposition',
      authorityLineageKey: 'lin_phone_cloud_v3_invalid_disposition',
      visibleGroupId: 'group_phone_cloud_v3_invalid_disposition',
      commitChecksum: 'a'.repeat(64),
      terminalDisposition,
      deliveredAt: 1784400011000
    };
    const relay = relayFixture(receipt);
    let calls = 0;
    const pump = new CloudRelayPump({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
      orchestrator: { process() { throw new Error('receipt must not dispatch'); } },
      store: { confirmAuthorityCloudDeliveryInternal() { calls += 1; } }
    });
    const result = await pump.pumpOnce();
    assert.equal(result.failed, 1);
    assert.equal(calls, 0);
    assert.deepEqual(relay.state.acked, []);
  }
});
