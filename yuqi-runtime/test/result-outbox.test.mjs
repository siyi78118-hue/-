import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decryptRelayPayload } from '../src/cloud-relay-pump.mjs';
import { ResultOutbox } from '../src/result-outbox.mjs';
import { YuqiStore } from '../src/store.mjs';

const keyBase64 = Buffer.alloc(32, 9).toString('base64');

function envelope() {
  return {
    protocolVersion: 2,
    turnId: 'turn_cloud_outbox_1',
    characterId: 'yuqi',
    deviceId: 'phone_cloud',
    deviceSeq: 91,
    createdAt: 1784400000091,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_cloud_outbox_user_1',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你还在吗',
      sentAt: 1784400000091
    }
  };
}

function commit(store, turnId) {
  store.claimTurnById(turnId, 'worker-outbox');
  store.advanceTurn(turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
  store.advanceTurn(turnId, 'memory_done', 'brain_running');
  store.advanceTurn(turnId, 'brain_running', 'brain_done', { brainDraftJson: '{}' });
  store.advanceTurn(turnId, 'brain_done', 'supervisor_running');
  store.advanceTurn(turnId, 'supervisor_running', 'approved', { supervisorJson: '{}' });
  store.advanceTurn(turnId, 'approved', 'committed', {
    replyJson: JSON.stringify({
      turnId,
      presetVersion: 'secret-preset',
      usedFactIds: ['fact-secret'],
      reply: {
        messageId: 'msg_yuqi_outbox_1', turnId, characterId: 'yuqi', speakerId: 'yuqi',
        speakerType: 'character', recipientId: 'user', content: '当然在。',
        sentAt: 1784400001091, origin: 'codex'
      }
    })
  });
}

test('persists a terminal cloud reply until relay delivery succeeds without leaking backstage data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-result-outbox-'));
  const file = join(dir, 'runtime.sqlite');
  let store = new YuqiStore(file);
  try {
    const turn = store.submitTurn(envelope());
    store.registerCloudDelivery(turn.turnId, 'phone_cloud', 77);
    commit(store, turn.turnId);

    const attempts = [];
    const first = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
      fetchImpl: async (_url, options) => {
        attempts.push(JSON.parse(options.body));
        return Response.json({ ok: false }, { status: 503 });
      }
    });
    assert.deepEqual(await first.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(store.listCloudDeliveries(turn.turnId)[0].state, 'pending');

    store.close();
    store = new YuqiStore(file);
    const second = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
      fetchImpl: async (_url, options) => {
        attempts.push(JSON.parse(options.body));
        return Response.json({ ok: true }, { status: 201 });
      }
    });
    assert.deepEqual(await second.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    assert.deepEqual(await second.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });

    assert.equal(attempts[0].messageId, attempts[1].messageId);
    assert.equal(attempts[0].idempotencyKey, attempts[1].idempotencyKey);
    const decoded = decryptRelayPayload(attempts[1], keyBase64);
    assert.equal(decoded.reply.content, '当然在。');
    assert.equal(decoded.recoveryAckSeq, 77);
    assert.equal('presetVersion' in decoded, false);
    assert.equal('usedFactIds' in decoded, false);
    assert.equal(store.listCloudDeliveries(turn.turnId)[0].state, 'mailboxed');
    assert.equal(store.listCloudDeliveries(turn.turnId)[0].confirmedAt, null);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delivers a LAN-accepted terminal turn through Cloud later without changing the turn or duplicating the reply', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-cross-route-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    const accepted = store.submitTurn(envelope());
    commit(store, accepted.turnId);
    const beforeCloud = store.getTurn(accepted.turnId);

    store.registerCloudDelivery(accepted.turnId, 'phone_cloud', 88);
    const deliveries = [];
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
      fetchImpl: async (_url, options) => {
        deliveries.push(JSON.parse(options.body));
        return Response.json({ ok: true }, { status: 201 });
      }
    });

    assert.deepEqual(await outbox.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(deliveries.length, 1);

    const afterCloud = store.getTurn(accepted.turnId);
    assert.equal(afterCloud.turnId, beforeCloud.turnId);
    assert.equal(afterCloud.envelopeChecksum, beforeCloud.envelopeChecksum);
    assert.equal(afterCloud.replyJson, beforeCloud.replyJson);
    const decoded = decryptRelayPayload(deliveries[0], keyBase64);
    assert.equal(decoded.turnId, accepted.turnId);
    assert.equal(decoded.reply.messageId, JSON.parse(beforeCloud.replyJson).reply.messageId);
    assert.equal(decoded.recoveryAckSeq, 88);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delivers an automatic skip as a successful terminal action without inventing reply text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-skip-outbox-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    const automatic = { ...envelope(), kind: 'PROACTIVE_CHAT', message: undefined, trigger: {
      triggerId: 'trigger_skip_1', triggerType: 'proactive_chat', scheduledFor: 1784400000000, executedAt: 1784400000091,
      context: { reason: 'scheduled_check_in' }
    } };
    const accepted = store.submitTurn(automatic);
    store.registerCloudDelivery(accepted.turnId, 'phone_cloud', 90);
    store.claimTurnById(accepted.turnId, 'worker-outbox');
    store.advanceTurn(accepted.turnId, 'memory_running', 'memory_done', { memoryPacketJson: '{}' });
    store.advanceTurn(accepted.turnId, 'memory_done', 'brain_running');
    store.advanceTurn(accepted.turnId, 'brain_running', 'brain_done', { brainDraftJson: '{}' });
    store.advanceTurn(accepted.turnId, 'brain_done', 'supervisor_running');
    store.advanceTurn(accepted.turnId, 'supervisor_running', 'approved', { supervisorJson: '{}' });
    store.advanceTurn(accepted.turnId, 'approved', 'committed', {
      replyJson: JSON.stringify({ turnId: accepted.turnId, action: 'skip', reply: null })
    });
    let payload;
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud', deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64, store,
      fetchImpl: async (_url, options) => { payload = JSON.parse(options.body); return Response.json({ ok: true }, { status: 201 }); }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    const decoded = decryptRelayPayload(payload, keyBase64);
    assert.equal(decoded.action, 'skip');
    assert.equal(decoded.reply, null);
    assert.equal(decoded.terminal, true);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
