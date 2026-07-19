import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloudRelayPump,
  decryptRelayPayload,
  encryptRelayPayload
} from '../src/cloud-relay-pump.mjs';

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
  recovery: { peerId: 'phone_cloud', lastCommonSeq: 0, entries: [] }
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
  const pump = new CloudRelayPump({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
    encryptionKeyBase64: keyBase64, fetchImpl: relay.fetchImpl,
    orchestrator: { async process() { throw new Error('supervisor unavailable'); } }
  });
  const result = await pump.pumpOnce();
  assert.equal(result.failed, 1);
  assert.deepEqual(relay.state.acked, []);
  assert.equal(relay.state.enqueued.length, 0);
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
