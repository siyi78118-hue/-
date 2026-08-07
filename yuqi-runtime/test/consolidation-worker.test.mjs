import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConsolidationWorker } from '../src/consolidation-worker.mjs';
import { contentHash } from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';

function envelope(seq = 1) {
  return {
    protocolVersion: 2,
    turnId: `turn_device_${seq}`,
    characterId: 'yuqi',
    deviceId: 'device',
    deviceSeq: seq,
    createdAt: 1784400000000 + seq,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_device_${seq}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '我喜欢砂锅米线',
      sentAt: 1784400000000 + seq
    }
  };
}

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-consolidation-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presetRegistry = {
    current: () => ({ version: '2.0.0' }),
    resolvePresetBundle: () => '只整理有原文证据的记忆'
  };
  return Promise.resolve(run({ store, presetRegistry })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function createJob(store, turn, now = 1784400001000) {
  return store.createConsolidationJobInternal({
    subjectType: 'turn',
    subjectId: turn.turnId,
    turnId: turn.turnId,
    roleId: 'yuqi',
    jobType: 'turn_consolidation',
    dueAt: now,
    createdAt: now,
    payload: { turnId: turn.turnId }
  });
}

test('a turn consolidation job commits evidence-backed facts once and completes its lease', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(1), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    createJob(store, turn);
    const codexClient = {
      async runTurn() {
        return {
          text: JSON.stringify({
            candidates: [{
              factId: 'fact_user_food_1',
              characterId: 'yuqi',
              type: 'preference',
              subjectId: 'user',
              predicate: 'likes_food',
              object: { food: '砂锅米线' },
              evidenceMode: 'direct',
              sourceMessageIds: ['msg_device_1'],
              exactQuotes: [{
                messageId: 'msg_device_1',
                speakerId: 'user',
                text: '我喜欢砂锅米线'
              }],
              confidence: 0.99
            }]
          })
        };
      }
    };
    const worker = new ConsolidationWorker({
      store, codexClient, presetRegistry, clock: () => 1784400001000
    });

    await worker.runOnce();
    await worker.runOnce();

    assert.equal(store.listFacts('yuqi').length, 1);
    assert.equal(store.listFacts('yuqi')[0].status, 'verified');
    assert.equal(
      store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).state,
      'completed'
    );
  });
});

test('an undelivered Yuqi message is excluded from consolidation evidence', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(2), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    store.putMessage({
      messageId: 'msg_yuqi_2',
      turnId: turn.turnId,
      characterId: 'yuqi',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user',
      content: '我答应你，晚上回来找你',
      sentAt: 1784400000500,
      origin: 'codex'
    });
    createJob(store, turn);
    const codexClient = {
      async runTurn() {
        return {
          text: JSON.stringify({
            candidates: [{
              factId: 'fact_yuqi_promise_2',
              characterId: 'yuqi',
              type: 'commitment',
              subjectId: 'yuqi',
              predicate: 'promised_to_return',
              object: { when: 'evening' },
              promisedBy: 'yuqi',
              promisedTo: 'user',
              evidenceMode: 'direct',
              sourceMessageIds: ['msg_yuqi_2'],
              exactQuotes: [{
                messageId: 'msg_yuqi_2',
                speakerId: 'yuqi',
                text: '我答应你，晚上回来找你'
              }],
              confidence: 0.99
            }]
          })
        };
      }
    };
    const worker = new ConsolidationWorker({
      store, codexClient, presetRegistry, clock: () => 1784400001000
    });

    await worker.runOnce();

    assert.equal(store.listFacts('yuqi').length, 0);
  });
});

test('legacy delivered Yuqi messages keep their compatibility evidence path', () => {
  const content = '我答应你，周六会回来找你';
  const message = {
    messageId: 'msg_legacy_delivered_5',
    turnId: 'turn_legacy_delivered_5',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content,
    sentAt: 1784400000500,
    origin: 'codex',
    committed: true,
    deliveryState: 'confirmed'
  };
  const store = {
    getTurn: () => ({ turnId: message.turnId, state: 'committed', resultAuthorityVersion: 0 }),
    listMessages: () => [message]
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const evidence = worker.evidenceForJob({ roleId: 'yuqi', turnId: message.turnId, payload: {} });
  assert.deepEqual(evidence.messages.map(item => item.messageId), [message.messageId]);
});

test('failures back off for four attempts and the fifth failure is auditable without changing the turn', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(3), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    createJob(store, turn);
    let now = 1784400001000;
    const worker = new ConsolidationWorker({
      store,
      presetRegistry,
      clock: () => now,
      codexClient: { async runTurn() { throw new Error('temporary provider failure'); } }
    });
    const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
    for (const delay of delays) {
      await worker.runOnce();
      const row = store.db.prepare(
        'SELECT state, due_at FROM consolidation_jobs WHERE turn_id = ?'
      ).get(turn.turnId);
      assert.equal(row.state, 'retry_wait');
      assert.equal(row.due_at, now + delay);
      now = row.due_at;
    }
    await worker.runOnce();
    const failed = store.db.prepare(
      'SELECT state, attempt_count, last_error_code FROM consolidation_jobs WHERE turn_id = ?'
    ).get(turn.turnId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.attempt_count, 5);
    assert.equal(failed.last_error_code, 'Error');
    assert.equal(store.getTurn(turn.turnId).state, 'queued');
  });
});

test('turn consolidation never claims a shadow job', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(4), {
      pipelineMode: 'shadow',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    store.createConsolidationJobInternal({
      subjectType: 'turn',
      subjectId: turn.turnId,
      turnId: turn.turnId,
      roleId: 'yuqi',
      jobType: 'shadow_cognition',
      dueAt: 1784400001000,
      payload: { turnId: turn.turnId }
    });
    const worker = new ConsolidationWorker({
      store,
      presetRegistry,
      clock: () => 1784400001000,
      codexClient: { async runTurn() { throw new Error('must not run'); } }
    });

    assert.equal(await worker.runOnce(), null);
    assert.equal(
      store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).state,
      'queued'
    );
  });
});

test('consolidation evidence excludes draft and model-only messages before the provider call', () => {
  const committed = {
    messageId: 'msg_committed',
    turnId: 'turn_authority',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    content: '我已经把周六安排记下来了',
    sentAt: 1784400001000,
    committed: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityGroupId: 'grp_authority',
    authorityLineageKey: 'lin_authority',
    authorityCommitChecksum: 'a'.repeat(64),
    deliveryState: 'confirmed'
  };
  const draft = {
    ...committed,
    messageId: 'msg_draft',
    committed: false,
    turnState: 'brain_done',
    content: '模型脑补出来的内容'
  };
  const store = {
    getTurn: () => ({ turnId: 'turn_authority', state: 'committed', resultAuthorityVersion: 1 }),
    listMessages: () => [committed, draft],
    loadCanonicalBridgeResultInternal: () => ({
      protocolVersion: 3,
      turnId: 'turn_authority',
      roleId: 'yuqi',
      authorityLineageKey: 'lin_authority',
      visibleGroupId: 'grp_authority',
      commitChecksum: 'a'.repeat(64),
      terminalDisposition: 'visible',
      replyParts: [committed]
    }),
    outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }]
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const evidence = worker.evidenceForJob({
    roleId: 'yuqi',
    turnId: 'turn_authority',
    payload: { messageIds: ['msg_committed'] }
  });
  assert.deepEqual(evidence.messages.map(message => message.messageId), ['msg_committed']);
  assert.equal(evidence.messages.some(message => message.content.includes('脑补')), false);
});

test('v3 authority turns never fall back to caller-supplied character messages without canonical loader', () => {
  const callerMessage = {
    messageId: 'msg_forged_committed',
    turnId: 'turn_authority_missing_loader',
    characterId: 'yuqi',
    speakerId: 'yuqi',
    speakerType: 'character',
    content: '调用方伪造的已提交内容',
    sentAt: 1784400001000,
    committed: true,
    resultAuthorityVersion: 1,
    turnState: 'committed',
    authorityVerified: true,
    authorityGroupId: 'grp_forged',
    authorityLineageKey: 'lin_forged',
    authorityCommitChecksum: 'a'.repeat(64),
    deliveryState: 'confirmed'
  };
  const store = {
    getTurn: () => ({ turnId: 'turn_authority_missing_loader', state: 'committed', resultAuthorityVersion: 1 }),
    listMessages: () => [callerMessage]
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const evidence = worker.evidenceForJob({
    roleId: 'yuqi',
    turnId: 'turn_authority_missing_loader',
    payload: { messageIds: ['msg_forged_committed'] }
  });
  assert.deepEqual(evidence.messages, []);
});

test('v3 canonical evidence includes the persisted current user batch exactly once', () => {
  const userMessage = {
    messageId: 'msg_user_batch_1',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '我喜欢周六一起吃饭',
    sentAt: 1784400001000
  };
  const yuqiMessage = {
    messageId: 'msg_yuqi_batch_1',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '那就周六一起吃饭',
    sentAt: 1784400001100
  };
  const store = {
    getTurn: () => ({ turnId: 'turn_batch_authority', characterId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
    getCurrentUserBatch: () => ({
      turnId: 'turn_batch_authority',
      batchId: 'batch_1',
      characterId: 'yuqi',
      sourceMessageId: userMessage.messageId,
      messageIds: [userMessage.messageId],
      startedAt: 1784400000900,
      committedAt: 1784400001000,
      checksum: contentHash({
        batchId: 'batch_1',
        sourceMessageId: userMessage.messageId,
        messageIds: [userMessage.messageId],
        startedAt: 1784400000900,
        committedAt: 1784400001000
      }),
      messages: [userMessage]
    }),
    loadCanonicalBridgeResultInternal: () => ({
      protocolVersion: 3,
      turnId: 'turn_batch_authority',
      roleId: 'yuqi',
      authorityLineageKey: 'lin_batch_authority',
      visibleGroupId: 'grp_batch_authority',
      commitChecksum: 'b'.repeat(64),
      terminalDisposition: 'visible',
      replyParts: [yuqiMessage]
    }),
    outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }]
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const evidence = worker.evidenceForJob({
    roleId: 'yuqi',
    turnId: 'turn_batch_authority',
    payload: {}
  });
  assert.deepEqual(evidence.messages.map(message => message.messageId), [
    'msg_user_batch_1',
    'msg_yuqi_batch_1'
  ]);
  assert.equal(evidence.messages[0].speakerType, 'user');
  assert.equal(evidence.messages[0].authorityVerified, true);
});

test('v3 input closure rejects changed or suppressed batches and unconfirmed result, with unknown IDs fail-closed', () => {
  const userMessage = {
    messageId: 'msg_input_closure',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '我周六有空',
    sentAt: 1784400001000
  };
  const batch = {
    turnId: 'turn_input_closure',
    batchId: 'batch_input_closure',
    characterId: 'yuqi',
    sourceMessageId: userMessage.messageId,
    messageIds: [userMessage.messageId],
    startedAt: 1784400000900,
    committedAt: 1784400001000,
    checksum: contentHash({
      batchId: 'batch_input_closure',
      sourceMessageId: userMessage.messageId,
      messageIds: [userMessage.messageId],
      startedAt: 1784400000900,
      committedAt: 1784400001000
    }),
    messages: [userMessage]
  };
  const yuqiMessage = {
    messageId: 'msg_result_closure',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '记下了',
    sentAt: 1784400001100
  };
  const makeEvidence = ({ batchOverride = {}, messages = [userMessage], deliveries = [{ state: 'confirmed', confirmedAt: 1 }], ids = [] } = {}) => {
    const store = {
      getTurn: () => ({ turnId: batch.turnId, characterId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
      getCurrentUserBatch: () => ({ ...batch, ...batchOverride, messages }),
      loadCanonicalBridgeResultInternal: () => ({
        protocolVersion: 3,
        turnId: batch.turnId,
        roleId: 'yuqi',
        authorityLineageKey: 'lin_input_closure',
        visibleGroupId: 'grp_input_closure',
        commitChecksum: 'c'.repeat(64),
        terminalDisposition: 'visible',
        replyParts: [yuqiMessage]
      }),
      outboxForGroup: () => deliveries
    };
    const worker = new ConsolidationWorker({
      store,
      codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
      presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
    });
    return worker.evidenceForJob({
      roleId: 'yuqi',
      turnId: batch.turnId,
      payload: ids.length ? { messageIds: ids } : {}
    }).messages;
  };

  assert.deepEqual(makeEvidence({ batchOverride: { messageIds: [userMessage.messageId, 'missing'] } }), []);
  assert.deepEqual(makeEvidence({ batchOverride: { batchId: 'batch_changed' } }), []);
  assert.deepEqual(makeEvidence({ messages: [{ ...userMessage, redacted: true }] }), []);
  assert.deepEqual(makeEvidence({ messages: [{ ...userMessage, suppressed: true }] }), []);
  assert.deepEqual(makeEvidence({ deliveries: [{ state: 'pending' }] }).map(message => message.messageId), [userMessage.messageId]);
  assert.deepEqual(makeEvidence({ ids: [userMessage.messageId, 'unknown'] }), []);
});

test('action-only canonical projection reaches the model as closed action evidence', async () => {
  const action = {
    actionId: 'action_only_1',
    kind: 'moment_comment',
    targetKey: 'moment:moment_1',
    targetRevision: 'rev_1',
    payload: { text: '周六一起吃饭' },
    actionChecksum: 'd'.repeat(64)
  };
  const writes = [];
  let request = null;
  const store = {
    getTurn: () => ({ turnId: 'turn_action_only', characterId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
    loadCanonicalBridgeResultInternal: () => ({
      protocolVersion: 3,
      turnId: 'turn_action_only',
      roleId: 'yuqi',
      authorityLineageKey: 'lin_action_only',
      visibleGroupId: 'grp_action_only',
      commitChecksum: 'e'.repeat(64),
      terminalDisposition: 'action_only',
      replyParts: [],
      actions: [action]
    }),
    outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }],
    putFact: fact => writes.push(fact)
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: {
      async runTurn(_channel, body) {
        request = JSON.parse(body);
        return {
          text: JSON.stringify({ candidates: [{
            factId: 'fact_action_only_1',
            characterId: 'yuqi',
            type: 'retrievable_event',
            subjectId: 'user',
            predicate: 'weekend_plan',
            object: { day: 'saturday' },
            evidenceMode: 'direct',
            sourceActionIds: [action.actionId],
            exactActions: [action],
            confidence: 0.9
          }] })
        };
      }
    },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const result = await worker.processJob({
    jobId: 'job_action_only',
    jobType: 'turn_consolidation',
    turnId: 'turn_action_only',
    roleId: 'yuqi',
    attemptCount: 1,
    payload: { actionIds: [action.actionId] }
  });
  assert.deepEqual(request.exactVisibleMessages, []);
  assert.deepEqual(request.exactVisibleActions, [
    { ...action, evidenceSource: 'yuqi_delivered_action' }
  ]);
  assert.equal(result.verified.length, 1);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].sourceActionIds, [action.actionId]);
});

test('message and action allowlists stay separate when their IDs collide', () => {
  const sharedId = 'same_namespace_id';
  const reply = {
    messageId: sharedId,
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '同一个字符串 ID 的消息',
    sentAt: 1784400001100
  };
  const action = {
    actionId: sharedId,
    kind: 'moment_comment',
    targetKey: 'moment:moment_same',
    targetRevision: 'rev_1',
    payload: { text: '同一个字符串 ID 的动作' },
    actionChecksum: 'f'.repeat(64)
  };
  const makeWorker = () => new ConsolidationWorker({
    store: {
      getTurn: () => ({ turnId: 'turn_namespace_collision', roleId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
      loadCanonicalBridgeResultInternal: () => ({
        protocolVersion: 3,
        turnId: 'turn_namespace_collision',
        roleId: 'yuqi',
        authorityLineageKey: 'lin_namespace_collision',
        visibleGroupId: 'grp_namespace_collision',
        commitChecksum: 'a'.repeat(64),
        terminalDisposition: 'visible',
        replyParts: [reply],
        actions: [action]
      }),
      outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }]
    },
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const messageEvidence = makeWorker().evidenceForJob({
    turnId: 'turn_namespace_collision',
    roleId: 'yuqi',
    payload: { messageIds: [sharedId] }
  }).messages;
  assert.deepEqual(messageEvidence.map(item => item.evidenceKind || 'message'), ['message']);
  const actionEvidence = makeWorker().evidenceForJob({
    turnId: 'turn_namespace_collision',
    roleId: 'yuqi',
    payload: { actionIds: [sharedId] }
  }).messages;
  assert.deepEqual(actionEvidence.map(item => item.evidenceKind), ['action']);
});

test('malformed candidate source arrays and unknown IDs are rejected without throwing', async () => {
  const writes = [];
  const store = {
    getTurn: () => ({ turnId: 'turn_malformed_sources', roleId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
    loadCanonicalBridgeResultInternal: () => ({
      protocolVersion: 3,
      turnId: 'turn_malformed_sources',
      roleId: 'yuqi',
      authorityLineageKey: 'lin_malformed_sources',
      visibleGroupId: 'grp_malformed_sources',
      commitChecksum: 'b'.repeat(64),
      terminalDisposition: 'visible',
      replyParts: [],
      actions: []
    }),
    outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }],
    putFact: fact => writes.push(fact)
  };
  const worker = new ConsolidationWorker({
    store,
    codexClient: {
      runTurn: async () => ({
        text: JSON.stringify({ candidates: [
          {
            factId: 'fact_bad_message_ids', characterId: 'yuqi', type: 'retrievable_event',
            subjectId: 'user', predicate: 'x', object: {}, evidenceMode: 'direct',
            sourceMessageIds: {}, exactQuotes: [], confidence: 0.5
          },
          {
            factId: 'fact_unknown_action_id', characterId: 'yuqi', type: 'retrievable_event',
            subjectId: 'user', predicate: 'x', object: {}, evidenceMode: 'direct',
            sourceActionIds: ['unknown_action'], exactActions: [], confidence: 0.5
          }
        ] })
      })
    },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const result = await worker.processJob({
    jobId: 'job_malformed_sources',
    jobType: 'turn_consolidation',
    turnId: 'turn_malformed_sources',
    roleId: 'yuqi',
    attemptCount: 1,
    payload: {}
  });
  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.equal(writes.length, 0);

  const nonArrayWorker = new ConsolidationWorker({
    store,
    codexClient: { runTurn: async () => ({ text: '[]' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const nonArrayResult = await nonArrayWorker.processJob({
    jobId: 'job_non_array_model',
    jobType: 'turn_consolidation',
    turnId: 'turn_malformed_sources',
    roleId: 'yuqi',
    attemptCount: 1,
    payload: {}
  });
  assert.equal(nonArrayResult.rejected.length, 1);
  assert.equal(writes.length, 0);
});

test('delayed original job reuses retry canonical batch only when lineage input is identical', () => {
  const input = {
    messageId: 'msg_retry_shared_input',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '我周日有空',
    sentAt: 1784400001000
  };
  const base = {
    batchId: 'batch_retry_shared',
    characterId: 'yuqi',
    sourceMessageId: input.messageId,
    messageIds: [input.messageId],
    startedAt: 1784400000900,
    committedAt: 1784400001000,
    checksum: contentHash({
      batchId: 'batch_retry_shared',
      sourceMessageId: input.messageId,
      messageIds: [input.messageId],
      startedAt: 1784400000900,
      committedAt: 1784400001000
    }),
    messages: [input]
  };
  const originalBatch = { turnId: 'turn_original_retry', ...base };
  const retryBatch = { turnId: 'turn_retry_shared', ...base };
  const result = {
    messageId: 'msg_retry_result',
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user',
    content: '记下了',
    sentAt: 1784400001100
  };
  const makeWorker = retryBatchValue => new ConsolidationWorker({
    store: {
      getTurn: () => ({ turnId: originalBatch.turnId, characterId: 'yuqi', state: 'committed', resultAuthorityVersion: 1 }),
      getCurrentUserBatch: turnId => turnId === originalBatch.turnId ? originalBatch : retryBatchValue,
      loadCanonicalBridgeResultInternal: () => ({
        protocolVersion: 3,
        turnId: retryBatch.turnId,
        roleId: 'yuqi',
        authorityLineageKey: 'lin_retry_shared',
        visibleGroupId: 'grp_retry_shared',
        commitChecksum: 'f'.repeat(64),
        terminalDisposition: 'visible',
        replyParts: [result],
        actions: []
      }),
      outboxForGroup: () => [{ state: 'confirmed', confirmedAt: 1784400002000 }]
    },
    codexClient: { runTurn: async () => ({ text: '{"candidates":[]}' }) },
    presetRegistry: { current: () => ({ version: '2.0.0' }), resolvePresetBundle: () => '' }
  });
  const same = makeWorker(retryBatch).evidenceForJob({
    roleId: 'yuqi',
    turnId: originalBatch.turnId,
    payload: {}
  });
  assert.deepEqual(same.messages.map(message => message.messageId), [input.messageId, result.messageId]);

  const changedRetry = {
    ...retryBatch,
    messages: [{ ...input, content: '被篡改的输入' }]
  };
  const changed = makeWorker(changedRetry).evidenceForJob({
    roleId: 'yuqi',
    turnId: originalBatch.turnId,
    payload: {}
  });
  assert.deepEqual(changed.messages, []);
});
