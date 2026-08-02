import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { decryptRelayPayload } from '../src/cloud-relay-pump.mjs';
import { projectBridgeResultForWire } from '../src/bridge-result-projector.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { ResultOutbox } from '../src/result-outbox.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const keyBase64 = Buffer.alloc(32, 9).toString('base64');
const SHA_A = 'a'.repeat(64);

function canonicalOutboxResult(turnId, groupId) {
  return {
    protocolVersion: 3,
    turnId,
    roleId: 'yuqi',
    authorityOrigin: 'pc',
    authorityLineageKey: `lineage_${groupId}`,
    visibleGroupId: groupId,
    lineageRevision: 1,
    turnRevision: 1,
    laneKey: 'private_chat',
    laneRevision: 1,
    inputVisibilitySequence: 0,
    inputClearEpoch: 0,
    generationFingerprint: null,
    releaseId: 'release_test',
    commitPayloadVersion: 'pc-visible-commit-v2',
    commitChecksum: SHA_A,
    terminalDisposition: 'skip',
    replyParts: [],
    actions: []
  };
}

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

test('two result outboxes claim one canonical failure lease and enqueue it once', async () => {
  const failure = {
    protocolVersion: 3,
    type: 'BACKLOG_FAILED',
    turnId: 'turn_failure_lease_1',
    roleId: 'yuqi',
    authorityLineageKey: 'lin_failure_lease_1',
    lineageRevision: 1,
    turnRevision: 2,
    laneKey: 'private_chat',
    laneRevision: 1,
    retryOfTurnId: null,
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    generationFingerprint: null,
    releaseId: 'release_test',
    state: 'failed',
    errorCode: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
    failureClass: 'transient',
    retryAllowed: true,
    failedAt: 100
  };
  let claimed = false;
  let marked = 0;
  let calls = 0;
  const store = {
    listPendingAuthorityCloudDeliveries: () => [],
    listPendingCanonicalFailureCloudDeliveries: () => [{
      deliveryType: 'canonical_failure', turnId: failure.turnId, peerId: 'phone_cloud', updatedAt: 1
    }],
    listPendingCloudDeliveries: () => [],
    claimCanonicalFailureCloudDeliveryInternal() {
      if (claimed) return null;
      claimed = true;
      return {
        payload: { ok: true, ...failure, rawStatusChecksum: 'a'.repeat(64), recoveryAckSeq: 0 },
        rawStatusChecksum: 'a'.repeat(64),
        leaseId: 'failure_lease_1', leaseAttempt: 1,
        relayMessageId: 'relay_failure_1'
      };
    },
    markCanonicalFailureCloudDeliveryMailboxedInternal(input) {
      marked += 1;
      assert.equal(input.relayMessageId, 'relay_failure_1');
    }
  };
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ ok: true }, { status: 201 });
  };
  const shared = {
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
    deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store, fetchImpl,
    clock: () => 1_000
  };
  const [first, second] = await Promise.all([
    new ResultOutbox(shared).flushOnce(),
    new ResultOutbox(shared).flushOnce()
  ]);
  assert.equal(first.delivered + second.delivered, 1);
  assert.equal(calls, 1);
  assert.equal(marked, 1);
});

test('canonical authority quarantine failures surface instead of being swallowed by the outbox', async () => {
  let quarantineCalls = 0;
  const store = {
    listPendingAuthorityCloudDeliveries: () => [],
    listPendingCanonicalFailureCloudDeliveries: () => [{
      deliveryType: 'canonical_failure', turnId: 'turn_failure_quarantine_surface', peerId: 'phone_cloud',
      state: 'waiting', payloadJson: null, checksum: '', attempts: 0, relayMessageId: null,
      deliveredAt: null, updatedAt: 1
    }],
    listPendingCloudDeliveries: () => [],
    claimCanonicalFailureCloudDeliveryInternal() {
      throw new Error('canonical failure target set conflict');
    },
    quarantineCanonicalCloudDeliveryInternal() {
      quarantineCalls += 1;
      throw new Error('SQLITE_BUSY: diagnostic write failed');
    }
  };
  const outbox = new ResultOutbox({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
    deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
    fetchImpl: async () => { throw new Error('fetch must not run'); }, clock: () => 1_000
  });
  await assert.rejects(() => outbox.flushOnce(), /SQLITE_BUSY: diagnostic write failed/);
  assert.equal(quarantineCalls, 1);
});

test('prefix-shaped unknown errors never quarantine a canonical delivery', async () => {
  let quarantineCalls = 0;
  const store = {
    listPendingAuthorityCloudDeliveries: () => [],
    listPendingCanonicalFailureCloudDeliveries: () => [{
      deliveryType: 'canonical_failure', turnId: 'turn_failure_unknown_prefix', peerId: 'phone_cloud',
      state: 'waiting', payloadJson: null, checksum: '', attempts: 0, relayMessageId: null,
      deliveredAt: null, updatedAt: 1
    }],
    listPendingCloudDeliveries: () => [],
    claimCanonicalFailureCloudDeliveryInternal() {
      throw new Error('canonical failure made_up conflict');
    },
    quarantineCanonicalCloudDeliveryInternal() { quarantineCalls += 1; }
  };
  const outbox = new ResultOutbox({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
    deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
    fetchImpl: async () => { throw new Error('fetch must not run'); }, clock: () => 1_000
  });
  await assert.rejects(() => outbox.flushOnce(), /canonical failure made_up conflict/);
  assert.equal(quarantineCalls, 0);
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

test('canonical original and retry restart emit one group-keyed delivery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-authority-outbox-'));
  const file = join(dir, 'runtime.sqlite');
  let store = new YuqiStore(file);
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: 'a'.repeat(64)
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 1,
      lastTurnId: 'seed',
      state: { slowState: {}, mediumState: {}, fastState: {} },
      updatedAt: 1
    });
    const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({
      roleId: 'yuqi',
      at: 1_000
    });
    const baseEnvelope = envelope();
    const original = store.createCanonicalVisibleTurnInternal({
      envelope: baseEnvelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: `batch_${baseEnvelope.message.messageId}`,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: agencySnapshot.checksum,
      annotationSnapshot: {}
    }).turn;
    const retryEnvelope = structuredClone(baseEnvelope);
    retryEnvelope.turnId = 'turn_cloud_outbox_retry';
    retryEnvelope.deviceSeq += 1;
    retryEnvelope.context = {
      retry: {
        retryOfTurnId: original.turnId,
        canonicalMessageId: baseEnvelope.message.messageId
      }
    };
    const retry = store.createCanonicalVisibleTurnInternal({
      envelope: retryEnvelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: original.rolloutRevision,
      authoritativeReleaseId: original.authoritativeReleaseId,
      comparisonReleaseId: original.comparisonReleaseId,
      comparisonDirection: original.comparisonDirection,
      laneKey: 'private_chat',
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      inputUserBatchId: original.inputUserBatchId,
      inputVisibilitySequence: original.inputVisibilitySequence,
      agencySnapshotChecksum: original.agencySnapshotChecksum,
      annotationSnapshot: original.annotationSnapshot
    }).turn;
    const visibleGroup = {
      items: [{
        content: '在。',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'user'
      }]
    };
    const actionSet = [];
    const generation = generationFingerprint({
      roleId: retry.characterId,
      laneKey: retry.laneKey,
      inputVisibilitySequence: retry.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: retry.agencySnapshotChecksum
    });
    const receipt = commitVisibleResult({
      store,
      turnId: retry.turnId,
      authorityLineageKey: retry.authorityLineageKey,
      laneKey: retry.laneKey,
      expectedTurnRevision: retry.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(retry.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      expectedCognitiveStateRevision: 1,
      expectedLatestUserBatchId: retry.inputUserBatchId,
      inputVisibilitySequence: retry.inputVisibilitySequence,
      agencySnapshotChecksum: retry.agencySnapshotChecksum,
      authoritativeReleaseId: retry.authoritativeReleaseId,
      visibleGroup,
      actionSet,
      statePatch: {
        mood: 'present',
        currentStances: [],
        openThreads: []
      },
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generation,
      now: 2
    });
    assert.equal(store.outboxForTurn(original.turnId).length, 0);
    const canonicalDeliveryBefore = store.outboxForGroup(receipt.visibleGroupId)[0];
    assert.equal(
      store.listPendingCloudDeliveries().some(delivery => delivery.authorityGroupId != null),
      false
    );
    assert.deepEqual(
      store.listPendingAuthorityCloudDeliveries().map(delivery => delivery.authorityGroupId),
      [receipt.visibleGroupId]
    );
    const canonicalItem = store.visibleItemsForGroup(receipt.visibleGroupId)[0];
    assert.throws(() => store.recordDeliveryReceipt({
      protocolVersion: 1,
      turnId: retry.turnId,
      deliveredAt: 3,
      items: [{
        kind: 'message',
        id: canonicalItem.messageId,
        checksum: canonicalItem.itemChecksum
      }]
    }), /canonical delivery API required/i);
    for (const legacyCall of [
      () => store.registerCloudDelivery(retry.turnId, retry.deviceId),
      () => store.prepareCloudDelivery(retry.turnId, retry.deviceId, { replyParts: [] }),
      () => store.markCloudDeliveryAttempt(retry.turnId, retry.deviceId),
      () => store.markCloudDeliveryMailboxed(retry.turnId, retry.deviceId, 'x')
    ]) assert.throws(legacyCall, /canonical delivery API required/i);
    assert.deepEqual(store.outboxForGroup(receipt.visibleGroupId)[0], canonicalDeliveryBefore);
    store.close();
    store = new YuqiStore(file);

    const attempts = [];
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example',
      deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64,
      store,
      fetchImpl: async (_url, options) => {
        attempts.push(JSON.parse(options.body));
        return attempts.length === 1
          ? Response.json({ ok: false }, { status: 503 })
          : Response.json({ ok: true }, { status: 201 });
      }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(store.outboxForGroup(receipt.visibleGroupId)[0].state, 'pending');
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_visible_delivery_quarantined'
    `).get(retry.turnId).count, 0);
    assert.deepEqual(await outbox.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(attempts.length, 2);
    const decoded = decryptRelayPayload(attempts[1], keyBase64);
    const expectedCanonical = store.loadCanonicalBridgeResultInternal(retry.turnId);
    assert.deepEqual(decoded, {
      ok: true,
      ...projectBridgeResultForWire(expectedCanonical, 2),
      recoveryAckSeq: 0
    });
    assert.equal(decoded.replyParts[0].content, '在。');
    assert.equal(
      store.outboxForGroup(receipt.visibleGroupId)[0].relayMessageId,
      attempts[1].messageId
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a corrupt canonical group target is quarantined before relay fetch and never selected again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-authority-outbox-quarantine-'));
  const file = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(file);
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
        presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64)
      }], now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    store.putCognitiveStateInternal({
      roleId: 'yuqi', schemaVersion: 2, revision: 1, lastTurnId: 'seed',
      state: { slowState: {}, mediumState: {}, fastState: {} }, updatedAt: 1
    });
    const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const input = { ...envelope(), turnId: 'turn_cloud_outbox_quarantine_1' };
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: input,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: `batch_${input.message.messageId}`,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: agencySnapshot.checksum,
      annotationSnapshot: {}
    }).turn;
    const visibleGroup = {
      items: [{ content: '我在。', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }]
    };
    const receipt = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      expectedCognitiveStateRevision: 1,
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet: [],
      statePatch: { mood: 'present', currentStances: [], openThreads: [] },
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generationFingerprint({
        roleId: turn.characterId, laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup, actionSet: [], contextRevision: turn.agencySnapshotChecksum
      }),
      now: 2
    });
    const target = store.listCloudDeliveries(turn.turnId)[0];
    store.db.prepare(`UPDATE visible_commit_receipts SET commit_checksum = ? WHERE group_id = ?`).run(
      'b'.repeat(64), receipt.visibleGroupId
    );
    let fetchCalls = 0;
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
      fetchImpl: async () => { fetchCalls += 1; return Response.json({ ok: true }, { status: 201 }); }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(fetchCalls, 0);
    const quarantined = store.listCloudDeliveries(turn.turnId)[0];
    assert.deepEqual({
      state: quarantined.state,
      payloadJson: quarantined.payloadJson,
      checksum: quarantined.checksum,
      attempts: quarantined.attempts,
      relayMessageId: quarantined.relayMessageId,
      deliveredAt: quarantined.deliveredAt
    }, {
      state: 'quarantined', payloadJson: null, checksum: '', attempts: 0,
      relayMessageId: null, deliveredAt: null
    });
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_visible_delivery_quarantined'
    `).get(turn.turnId).count, 1);
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(fetchCalls, 0);
    assert.equal(target.state, 'waiting');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('mixed canonical and legacy backlog honors global age without starvation', async () => {
  const fetchOrder = [];
  const makeStore = ({ canonical, legacy, canonicalUpdatedAt, legacyUpdatedAt }) => ({
    listPendingAuthorityCloudDeliveries(limit) {
      return Array.from({ length: canonical }, (_, index) => ({
        authorityGroupId: `canonical_${String(index + 1).padStart(3, '0')}`,
        turnId: `turn_canonical_${String(index + 1).padStart(3, '0')}`,
        peerId: 'phone_cloud',
        authorityCommitChecksum: 'a'.repeat(64),
        updatedAt: canonicalUpdatedAt + index
      })).slice(0, limit);
    },
    listPendingCloudDeliveries(limit) {
      return Array.from({ length: legacy }, (_, index) => ({
        turnId: `legacy_${String(index + 1).padStart(3, '0')}`,
        peerId: 'phone_cloud',
        recoveryAckSeq: 0,
        updatedAt: legacyUpdatedAt + index
      })).slice(0, limit);
    },
    loadCanonicalBridgeResultInternal(turnId) {
      return canonicalOutboxResult(turnId, turnId.replace('turn_', ''));
    },
    prepareAuthorityCloudDelivery(groupId) {
      return { checksum: `checksum_${groupId}` };
    },
    markAuthorityCloudDeliveryAttempt() {},
    markAuthorityCloudDeliveryMailboxed() {},
    getTurn(turnId) {
      return {
        turnId,
        state: 'committed',
        protocolVersion: turnId.startsWith('turn_canonical_') ? 3 : 1,
        replyJson: JSON.stringify({ reply: { content: turnId } }),
        createdAt: 1,
        updatedAt: 1
      };
    },
    prepareCloudDelivery(turnId) {
      return { checksum: `checksum_${turnId}` };
    },
    markCloudDeliveryAttempt() {},
    markCloudDeliveryMailboxed() {}
  });
  const run = async options => {
    fetchOrder.length = 0;
    const store = makeStore(options);
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example',
      deviceId: 'phone_cloud',
      deviceToken: 'device-token-123456789',
      encryptionKeyBase64: keyBase64,
      store,
      fetchImpl: async (_url, request) => {
        const encrypted = JSON.parse(request.body);
        const payload = decryptRelayPayload(encrypted, keyBase64);
        fetchOrder.push(payload.visibleGroupId || payload.turnId);
        return Response.json({ ok: true }, { status: 201 });
      }
    });
    assert.equal(store.listPendingCloudDeliveries(100).every(
      target => target.authorityGroupId == null
    ), true);
    assert.equal(store.listPendingAuthorityCloudDeliveries(100).every(
      target => target.authorityGroupId != null
    ), true);
    assert.deepEqual(await outbox.flushOnce(50), {
      delivered: 50,
      failed: 0,
      waiting: 0
    });
  };

  await run({
    canonical: 60,
    legacy: 2,
    legacyUpdatedAt: 1,
    canonicalUpdatedAt: 100
  });
  assert.deepEqual(fetchOrder.slice(0, 2), ['legacy_001', 'legacy_002']);

  await run({
    canonical: 2,
    legacy: 60,
    canonicalUpdatedAt: 1,
    legacyUpdatedAt: 100
  });
  assert.deepEqual(fetchOrder.slice(0, 2), ['canonical_001', 'canonical_002']);
});

test('fifty mixed group, failure, and legacy deliveries preserve global age fairness', async () => {
  const fetchOrder = [];
  const checksum = 'c'.repeat(64);
  const store = {
    listPendingAuthorityCloudDeliveries(limit) {
      return Array.from({ length: 20 }, (_, index) => ({
        authorityGroupId: `group_${String(index).padStart(2, '0')}`,
        turnId: `turn_group_${String(index).padStart(2, '0')}`,
        peerId: 'phone_cloud', authorityCommitChecksum: checksum, updatedAt: 300 + index
      })).slice(0, limit);
    },
    listPendingCanonicalFailureCloudDeliveries(limit) {
      return Array.from({ length: 20 }, (_, index) => ({
        deliveryType: 'canonical_failure', turnId: `failure_${String(index).padStart(2, '0')}`,
        peerId: 'phone_cloud', updatedAt: 100 + index
      })).slice(0, limit);
    },
    listPendingCloudDeliveries(limit) {
      return Array.from({ length: 20 }, (_, index) => ({
        turnId: `legacy_${String(index).padStart(2, '0')}`,
        peerId: 'phone_cloud', recoveryAckSeq: 0, updatedAt: 200 + index
      })).slice(0, limit);
    },
    claimCanonicalFailureCloudDeliveryInternal({ turnId }) {
      return {
        payload: {
          ok: true, terminal: true, type: 'BACKLOG_FAILED', turnId,
          rawStatusChecksum: checksum, recoveryAckSeq: 0
        },
        rawStatusChecksum: checksum,
        leaseId: `lease_${turnId}`,
        leaseAttempt: 1,
        relayMessageId: `relay_${turnId}`
      };
    },
    markCanonicalFailureCloudDeliveryMailboxedInternal() {},
    loadCanonicalBridgeResultInternal(turnId) {
      return canonicalOutboxResult(turnId, turnId.replace('turn_', ''));
    },
    prepareAuthorityCloudDelivery() { return { checksum }; },
    markAuthorityCloudDeliveryAttempt() {},
    markAuthorityCloudDeliveryMailboxed() {},
    getTurn(turnId) {
      return {
        turnId, state: 'committed', protocolVersion: turnId.startsWith('turn_group_') ? 3 : 1,
        replyJson: JSON.stringify({ reply: { content: turnId } }), createdAt: 1, updatedAt: 1
      };
    },
    prepareCloudDelivery() { return { checksum }; },
    markCloudDeliveryAttempt() {},
    markCloudDeliveryMailboxed() {}
  };
  const outbox = new ResultOutbox({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
    deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
    fetchImpl: async (_url, request) => {
      const payload = decryptRelayPayload(JSON.parse(request.body), keyBase64);
      fetchOrder.push(payload.visibleGroupId || payload.turnId);
      return Response.json({ ok: true }, { status: 201 });
    },
    clock: () => 1_000
  });
  assert.deepEqual(await outbox.flushOnce(50), { delivered: 50, failed: 0, waiting: 0 });
  assert.deepEqual(fetchOrder.slice(0, 20), Array.from({ length: 20 }, (_, index) =>
    `failure_${String(index).padStart(2, '0')}`
  ));
  assert.deepEqual(fetchOrder.slice(20, 40), Array.from({ length: 20 }, (_, index) =>
    `legacy_${String(index).padStart(2, '0')}`
  ));
  assert.deepEqual(fetchOrder.slice(40), Array.from({ length: 10 }, (_, index) =>
    `group_${String(index).padStart(2, '0')}`
  ));
});

test('fifty canonical sends perform fifty scoped validations and zero full scans', async () => {
  const validationCounts = { fullDatabase: 0, groupScoped: 0 };
  const fetchBodies = [];
  const targets = Array.from({ length: 50 }, (_, index) => ({
    authorityGroupId: `group_${String(index).padStart(3, '0')}`,
    turnId: `turn_group_${String(index).padStart(3, '0')}`,
    peerId: 'phone_cloud',
    authorityCommitChecksum: 'a'.repeat(64),
    updatedAt: index + 1
  }));
  const store = {
    listPendingAuthorityCloudDeliveries: limit => targets.slice(0, limit),
    listPendingCloudDeliveries: () => [],
    getTurn(turnId) {
      return { turnId, protocolVersion: 3, state: 'committed' };
    },
    loadCanonicalBridgeResultInternal(turnId) {
      validationCounts.groupScoped += 1;
      return canonicalOutboxResult(turnId, turnId.replace('turn_', ''));
    },
    prepareAuthorityCloudDelivery() { return { checksum: 'b'.repeat(64) }; },
    markAuthorityCloudDeliveryAttempt() {},
    markAuthorityCloudDeliveryMailboxed() {}
  };
  const outbox = new ResultOutbox({
    relayUrl: 'https://relay.example', deviceId: 'phone_cloud',
    deviceToken: 'device-token-123456789', encryptionKeyBase64: keyBase64, store,
    fetchImpl: async (_url, options) => {
      fetchBodies.push(JSON.parse(options.body));
      return Response.json({ ok: true }, { status: 201 });
    }
  });
  assert.deepEqual(await outbox.flushOnce(50), { delivered: 50, failed: 0, waiting: 0 });
  assert.equal(validationCounts.fullDatabase, 0);
  assert.equal(validationCounts.groupScoped, 50);
  assert.equal(fetchBodies.length, 50);
});
