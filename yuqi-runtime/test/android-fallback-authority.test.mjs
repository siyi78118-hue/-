import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveVisibleActionId, deriveVisibleGroupId } from '../src/authority-identity.mjs';
import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { contentHash, validateEnvelope } from '../src/protocol.mjs';
import { YuqiReconciler } from '../src/reconcile.mjs';
import { YuqiStore } from '../src/store.mjs';

const FIXTURE = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/android-fallback-authority-v2.json', import.meta.url),
  'utf8'
));

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-android-fallback-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    return run(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function clone(value) {
  return structuredClone(value);
}

function rehashReceipt(receipt, semanticPatch = {}) {
  const next = clone(receipt);
  next.semantic = { ...next.semantic, ...semanticPatch };
  next.manifest.semantic = clone(next.semantic);
  next.commitChecksum = contentHash(next.semantic);
  next.manifest.commitChecksum = next.commitChecksum;
  return next;
}

function externalAction({ kind, targetKey, targetRevision = '1', payload }, groupId) {
  return {
    actionId: deriveVisibleActionId(groupId, 0),
    ordinal: 0,
    kind,
    targetKey,
    targetRevision,
    payload,
    checksum: contentHash({ kind, targetKey, targetRevision, payload })
  };
}

function actionOnlyReceipt(action) {
  const candidate = clone(FIXTURE);
  candidate.semantic.terminalDisposition = 'action_only';
  candidate.semantic.replyItems = [];
  candidate.semantic.visibleItems = [];
  candidate.semantic.actions = [externalAction(action, candidate.semantic.visibleGroupId)];
  candidate.manifest.semantic = clone(candidate.semantic);
  candidate.commitChecksum = contentHash(candidate.semantic);
  candidate.manifest.commitChecksum = candidate.commitChecksum;
  return candidate;
}

function actionOnlyReceiptWithInputContext(action, context) {
  const candidate = actionOnlyReceipt(action);
  candidate.semantic.input.trigger.context = clone(context);
  candidate.semantic.input.checksum = contentHash({
    kind: 'automatic',
    trigger: clone(candidate.semantic.input.trigger),
    visibilitySequence: candidate.semantic.input.visibilitySequence,
    clearEpoch: candidate.semantic.input.clearEpoch
  });
  candidate.manifest.semantic = clone(candidate.semantic);
  candidate.commitChecksum = contentHash(candidate.semantic);
  candidate.manifest.commitChecksum = candidate.commitChecksum;
  return candidate;
}

function actionTargetRevision(value) {
  return `sha256:${contentHash(value)}`;
}

function pinnedActionContext({
  payment = null,
  scene = null,
  targetMoment = null,
  targetComment = null,
  rolePlan = null
} = {}) {
  const basis = {
    version: 1,
    payment: clone(payment),
    scene: clone(scene),
    input: {
      targetMoment: clone(targetMoment),
      targetComment: clone(targetComment),
      rolePlan: clone(rolePlan)
    }
  };
  return { ...basis, checksum: contentHash(basis) };
}

function directActionOnlyReceipt(action, pinned) {
  const candidate = actionOnlyReceipt(action);
  const message = {
    messageId: 'msg_android_direct_action_001',
    speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: '给你', sentAt: 900, attachments: []
  };
  const batchHeader = {
    batchId: 'batch_android_direct_action_001',
    sourceMessageId: message.messageId,
    messageIds: [message.messageId],
    startedAt: 900,
    committedAt: 901
  };
  const lineageKey = deriveAuthorityLineageKey({
    roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId
  });
  const groupId = deriveVisibleGroupId(lineageKey);
  candidate.semantic.turnKind = 'DIRECT_REPLY';
  candidate.semantic.rootSourceId = message.messageId;
  candidate.semantic.authorityLineageKey = lineageKey;
  candidate.semantic.visibleGroupId = groupId;
  candidate.semantic.input = {
    kind: 'direct',
    batch: {
      batchId: batchHeader.batchId,
      characterId: 'yuqi',
      sourceMessageId: message.messageId,
      startedAt: batchHeader.startedAt,
      committedAt: batchHeader.committedAt,
      checksum: contentHash(batchHeader),
      items: [{
        sequence: 0, messageId: message.messageId,
        message, checksum: contentHash(message)
      }]
    },
    pinnedActionContext: clone(pinned),
    visibilitySequence: candidate.semantic.input.visibilitySequence,
    clearEpoch: candidate.semantic.input.clearEpoch,
    checksum: contentHash(batchHeader)
  };
  candidate.semantic.actions[0].actionId = deriveVisibleActionId(groupId, 0);
  candidate.manifest.semantic = clone(candidate.semantic);
  candidate.commitChecksum = contentHash(candidate.semantic);
  candidate.manifest.commitChecksum = candidate.commitChecksum;
  return candidate;
}

function ensureRollout(store, rolloutKey) {
  if (store.getCognitionRollout(rolloutKey)) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey,
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: 'a'.repeat(64)
    }],
    now: 1
  });
}

function createFailedParent(store, { retryAllowed = true, turnId = 'turn_android_parent' } = {}) {
  const rootSourceId = FIXTURE.semantic.rootSourceId;
  const lineageKey = deriveAuthorityLineageKey({
    roleId: 'yuqi', laneKey: 'private_chat', rootSourceId
  });
  const envelope = validateEnvelope({
    protocolVersion: 3,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 6,
    createdAt: 998,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: rootSourceId,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: 'parent input',
      sentAt: 998,
      attachments: []
    },
    context: {
      currentBatch: {
        batchId: 'batch_android_parent',
        messageIds: [rootSourceId],
        startedAt: 998,
        committedAt: 998,
        messages: [{
          messageId: rootSourceId,
          speakerId: 'user',
          speakerType: 'user',
          recipientId: 'yuqi',
          content: 'parent input',
          sentAt: 998,
          attachments: []
        }]
      },
      visibilityCursor: {
        nativeCompletedTurnId: null,
        nativeCompletedGroupId: null,
        nativeCompletedSequence: 0,
        uiAppliedTurnId: null,
        uiAppliedGroupId: null,
        uiAppliedSequence: 0,
        localSequence: 1,
        clearedThroughSequence: 0,
        clearEpoch: 0,
        clearedAt: 0,
        chatOpen: false,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey: 'private_chat',
      rootSourceId,
      lineageKey,
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  });
  ensureRollout(store, 'DIRECT_REPLY');
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 998 });
  const created = store.createCanonicalVisibleTurnInternal({
    envelope,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: 'batch_android_parent',
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
  const failure = store.recordCanonicalTurnFailureInternal({
    turnId: created.turnId,
    expectedState: created.state,
    expectedTurnRevision: created.turnRevision,
    failure: {
      failureClass: 'transient',
      retryAllowed,
      code: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
      message: 'android fallback retry parent'
    }
  });
  // The retry receipt is an Android fallback projection, so its parent must
  // carry the same persisted release pin before the child can be accepted.
  store.db.prepare(`
    UPDATE turns
    SET authoritative_release_id = ?, authoritative_pipeline_checksum = ?
    WHERE turn_id = ?
  `).run(
    FIXTURE.semantic.release.releaseId,
    FIXTURE.semantic.release.releaseChecksum,
    failure.turnId
  );
  return failure;
}

function retryReceipt(parent, patch = {}) {
  const batchMessage = {
    messageId: FIXTURE.semantic.rootSourceId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: 'parent input',
    sentAt: 998
  };
  const batch = {
    batchId: parent.inputUserBatchId || 'batch_android_parent',
    characterId: 'yuqi',
    sourceMessageId: batchMessage.messageId,
    startedAt: 998,
    committedAt: 1000,
    checksum: '',
    items: [{
      sequence: 0,
      messageId: batchMessage.messageId,
      message: batchMessage,
      checksum: contentHash(batchMessage)
    }]
  };
  const batchHeader = {
    batchId: batch.batchId,
    sourceMessageId: batch.sourceMessageId,
    messageIds: batch.items.map(item => item.messageId),
    startedAt: batch.startedAt,
    committedAt: batch.committedAt
  };
  batch.checksum = contentHash(batchHeader);
  return rehashReceipt(FIXTURE, {
    authoritativeTurnId: 'turn_android_retry_002',
    lineageRevisionAtCreation: Number(parent.lineageRevisionAtCreation) + 1,
    turnRevision: Number(parent.turnRevision || 1) + 1,
    retryOfTurnId: parent.turnId,
    turnKind: 'DIRECT_REPLY',
    input: {
      kind: 'direct',
      visibilitySequence: 7,
      clearEpoch: 0,
      batch,
      checksum: batch.checksum
    },
    ...patch
  });
}

function insertMessageProjection(store, {
  message, turnId, origin, deviceId = null, deviceSeq = null,
  checksum, authorityGroupId = null, groupOrdinal = null
}) {
  const columns = [
    'message_id', 'turn_id', 'character_id', 'speaker_id', 'speaker_type',
    'recipient_id', 'content', 'sent_at', 'origin', 'device_id', 'device_seq',
    'checksum', 'created_at'
  ];
  const values = [
    message.messageId, turnId, message.speakerType === 'user' ? 'yuqi' : 'yuqi',
    message.speakerId, message.speakerType, message.recipientId, message.content,
    message.sentAt, origin, deviceId, deviceSeq, checksum, 123
  ];
  if (authorityGroupId != null) {
    columns.push('authority_group_id', 'group_ordinal');
    values.push(authorityGroupId, groupOrdinal);
  }
  store.db.prepare(`
    INSERT INTO messages(${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `).run(...values);
}

function insertEquivalentMessageProjections(store, receipt) {
  const semantic = receipt.semantic;
  const batch = semantic.input.batch;
  for (const item of batch.items) {
    const message = item.message;
    const normalized = {
      messageId: message.messageId,
      turnId: semantic.authoritativeTurnId,
      characterId: semantic.roleId,
      speakerId: message.speakerId,
      speakerType: message.speakerType,
      recipientId: message.recipientId,
      content: message.content,
      sentAt: message.sentAt,
      origin: 'phone',
      deviceId: semantic.deviceId,
      deviceSeq: item.sequence === 0 ? semantic.journalSyncSeq : null
    };
    insertMessageProjection(store, {
      message,
      turnId: semantic.authoritativeTurnId,
      origin: 'phone',
      deviceId: normalized.deviceId,
      deviceSeq: normalized.deviceSeq,
      checksum: contentHash(normalized)
    });
  }
  for (const item of semantic.replyItems) {
    const message = item.message;
    insertMessageProjection(store, {
      message,
      turnId: semantic.authoritativeTurnId,
      origin: 'codex',
      checksum: contentHash({
        messageId: message.messageId,
        content: String(message.content || ''),
        recipientId: String(message.recipientId || 'user')
      }),
      authorityGroupId: semantic.visibleGroupId,
      groupOrdinal: item.ordinal
    });
  }
}

function rowCounts(store) {
  const existing = new Set(store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map(row => row.name));
  return Object.fromEntries([
    'turn_authority_lineages', 'turns', 'current_user_batches', 'current_user_batch_items',
    'visible_result_groups', 'visible_result_items', 'visible_result_actions',
    'visible_result_manifests', 'visible_commit_receipts', 'pipeline_releases',
    'cloud_deliveries', 'result_outbox', 'cognitive_states', 'consolidation_jobs',
    'comparison_runs', 'shadow_runs', 'quality_eval_runs'
  ].filter(table => existing.has(table)).map(table => [table, Number(store.db.prepare(
    `SELECT COUNT(*) AS value FROM ${table}`
  ).get().value)]));
}

test('fixture has one semantic authority and stable checksum bases', () => {
  assert.deepEqual(FIXTURE.manifest.semantic, FIXTURE.semantic);
  assert.equal(FIXTURE.manifest.commitChecksum, FIXTURE.commitChecksum);
  assert.equal(FIXTURE.commitChecksum, contentHash(FIXTURE.semantic));
  assert.equal(FIXTURE.semantic.fallbackExecution, undefined);
  assert.equal(FIXTURE.semantic.release.releaseId.startsWith('android_fallback:'), true);
});

test('imports a complete external Android authority graph with no PC side effects', () =>
  withStore(store => {
    const before = rowCounts(store);
    const imported = store.importExternalVisibleReceiptInternal(FIXTURE);
    assert.equal(imported.authorityOrigin, 'android_fallback');
    assert.equal(imported.visibleGroupId, FIXTURE.semantic.visibleGroupId);
    assert.equal(store.getTurn(FIXTURE.semantic.authoritativeTurnId).resultAuthorityVersion, 1);
    assert.equal(store.getCurrentUserBatch(FIXTURE.semantic.authoritativeTurnId), null);
    assert.equal(store.getTurn(FIXTURE.semantic.authoritativeTurnId).inputUserBatchId,
      FIXTURE.semantic.input.trigger.triggerId);
    assert.equal(store.getVisibleResultManifest(FIXTURE.semantic.visibleGroupId).payloadVersion,
      'android-fallback-commit-v2');
    assert.equal(store.getVisibleCommitReceipt(FIXTURE.semantic.authorityLineageKey).commitChecksum,
      FIXTURE.commitChecksum);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value, 0);
    const outbox = store.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'result_outbox'"
    ).get();
    if (outbox) assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM result_outbox').get().value, 0);
    assert.deepEqual(store.getCognitiveState('yuqi'), null);
    assert.deepEqual(store.db.prepare('SELECT COUNT(*) AS value FROM consolidation_jobs').get().value, 0);
    assert.notDeepEqual(rowCounts(store), before);
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
  }));

test('external Android authority exact replay survives close and reopen without writes', () =>
  withStore((store, path) => {
    const first = store.importExternalVisibleReceiptInternal(FIXTURE);
    const before = rowCounts(store);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      const replay = reopened.importExternalVisibleReceiptInternal(FIXTURE);
      assert.equal(replay.commitChecksum, first.commitChecksum);
      assert.deepEqual(rowCounts(reopened), before);
    } finally {
      reopened.close();
    }
  }));

test('changed Android authority records one conflict and never merges a second group', () =>
  withStore(store => {
    store.importExternalVisibleReceiptInternal(FIXTURE);
    const changed = clone(FIXTURE);
    changed.semantic.visibleGroupId = 'group_android_changed';
    changed.manifest.semantic.visibleGroupId = changed.semantic.visibleGroupId;
    changed.commitChecksum = contentHash(changed.semantic);
    changed.manifest.commitChecksum = changed.commitChecksum;
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(changed),
      /cross-device authority conflict|external authority(?: group identity)? conflict/
    );
    assert.equal(store.visibleGroupsForLineage(FIXTURE.semantic.authorityLineageKey).length, 1);
    assert.equal(Number(store.db.prepare(
      "SELECT COUNT(*) AS value FROM diagnostics WHERE stage = 'external_authority_conflict'"
    ).get().value), 1);
    const crossDevice = clone(FIXTURE);
    crossDevice.semantic.deviceId = 'tablet';
    crossDevice.manifest.semantic = clone(crossDevice.semantic);
    crossDevice.commitChecksum = contentHash(crossDevice.semantic);
    crossDevice.manifest.commitChecksum = crossDevice.commitChecksum;
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(crossDevice),
      /cross-device authority conflict/
    );
    assert.equal(Number(store.db.prepare(
      "SELECT COUNT(*) AS value FROM diagnostics WHERE stage = 'external_authority_conflict'"
    ).get().value), 1);
  }));

test('malformed, redacted, and cancelled receipts fail before any mirror write', () =>
  withStore(store => {
    for (const disposition of ['redacted', 'cancelled']) {
      const candidate = clone(FIXTURE);
      candidate.semantic.terminalDisposition = disposition;
      candidate.manifest.semantic.terminalDisposition = disposition;
      candidate.commitChecksum = contentHash(candidate.semantic);
      candidate.manifest.commitChecksum = candidate.commitChecksum;
      const before = rowCounts(store);
      assert.throws(() => store.importExternalVisibleReceiptInternal(candidate), /redacted|cancelled|authority conflict/);
      assert.deepEqual(rowCounts(store), before);
    }
  }));

test('automatic receipts never invent a current batch and direct receipts require one', () =>
  withStore(store => {
    const direct = clone(FIXTURE);
    direct.semantic.input = {
      kind: 'direct',
      visibilitySequence: 7,
      clearEpoch: 0,
      checksum: '0'.repeat(64)
    };
    direct.manifest.semantic.input = clone(direct.semantic.input);
    direct.commitChecksum = contentHash(direct.semantic);
    direct.manifest.commitChecksum = direct.commitChecksum;
    assert.throws(() => store.importExternalVisibleReceiptInternal(direct), /batch|input (?:authority|keys)/);
    assert.equal(store.getTurn(FIXTURE.semantic.authoritativeTurnId), null);
  }));

test('automatic action-only receipts preserve the closed action projection without PC execution', () =>
  withStore(store => {
    const candidate = clone(FIXTURE);
    candidate.semantic.terminalDisposition = 'action_only';
    candidate.semantic.replyItems = [];
    candidate.semantic.visibleItems = [];
    const targetMoment = { momentId: 'moment_1', content: 'source', createdAt: 1000 };
    candidate.semantic.input.trigger.context = { input: { targetMoment } };
    candidate.semantic.input.checksum = contentHash({
      kind: 'automatic',
      trigger: clone(candidate.semantic.input.trigger),
      visibilitySequence: candidate.semantic.input.visibilitySequence,
      clearEpoch: candidate.semantic.input.clearEpoch
    });
    const action = {
      actionId: deriveVisibleActionId(candidate.semantic.visibleGroupId, 0),
      ordinal: 0,
      kind: 'moment_like',
      targetKey: 'moment:moment_1',
      targetRevision: actionTargetRevision(targetMoment),
      payload: { momentId: 'moment_1', like: true, comment: '', replyToCommentId: null },
      checksum: ''
    };
    action.checksum = contentHash({
      kind: action.kind,
      targetKey: action.targetKey,
      targetRevision: action.targetRevision,
      payload: action.payload
    });
    candidate.semantic.actions = [action];
    candidate.manifest.semantic = clone(candidate.semantic);
    candidate.commitChecksum = contentHash(candidate.semantic);
    candidate.manifest.commitChecksum = candidate.commitChecksum;
    const imported = store.importExternalVisibleReceiptInternal(candidate);
    assert.equal(imported.exactReplay, false);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS value FROM visible_result_items WHERE group_id = ?'
    ).get(candidate.semantic.visibleGroupId).value, 0);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS value FROM visible_result_actions WHERE group_id = ?'
    ).get(candidate.semantic.visibleGroupId).value, 1);
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
  }));

test('external moment and relationship action payloads reject top-level secrets with zero writes', () => {
  const cases = [
    {
      kind: 'moment_like',
      targetKey: 'moment:moment_1',
      targetRevision: actionTargetRevision({ momentId: 'moment_1', content: 'source', createdAt: 1000 }),
      payload: {
        momentId: 'moment_1', like: true, comment: '', replyToCommentId: null,
        secret: 'do-not-import'
      },
      context: { input: { targetMoment: { momentId: 'moment_1', content: 'source', createdAt: 1000 } } }
    },
    {
      kind: 'relationship_transition',
      targetKey: 'relationship:yuqi',
      targetRevision: actionTargetRevision({
        relationshipStage: { base: 'close', phase: 'normal' }, stagePersonaRevision: 1
      }),
      payload: {
        baseAction: {
          from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历',
          confidence: 0.9, evidenceMessageIds: [], explicitMutualChange: false, changedAt: 2000
        },
        phaseAction: null,
        expectedSceneRevision: 1,
        label: '熟悉',
        changedAt: 2000,
        secret: 'do-not-import'
      },
      context: {
        scene: { relationshipStage: { base: 'close', phase: 'normal' }, stagePersonaRevision: 1 }
      }
    }
  ];
  for (const action of cases) {
    withStore(store => {
      const candidate = actionOnlyReceiptWithInputContext(action, action.context);
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /canonical (?:moment|relationship) action payload|external authority action/i
      );
      assert.deepEqual(rowCounts(store), before);
    });
  }
});

test('external payment and role-plan actions reject wrong kind-target pairs with zero writes', () => {
  const cases = [
    {
      kind: 'payment_accept',
      targetKey: 'moment:payment_1',
      targetRevision: `sha256:${'a'.repeat(64)}`,
      payload: { messageId: 'payment_1' }
    },
    {
      kind: 'role_plan_update',
      targetKey: 'role_plan:plan_other',
      targetRevision: `sha256:${'a'.repeat(64)}`,
      payload: { op: 'update', planId: 'plan_1', patch: { title: 'changed' } }
    }
  ];
  for (const action of cases) {
    withStore(store => {
      const candidate = actionOnlyReceipt(action);
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /canonical (?:payment|role plan).*(?:conflict)|external authority action/i
      );
      assert.deepEqual(rowCounts(store), before);
    });
  }
});

test('external role-plan actions reject a changed nested plan target with zero writes', () => {
  withStore(store => {
    const candidate = actionOnlyReceipt({
      kind: 'role_plan_update',
      targetKey: 'role_plan:plan_1',
      targetRevision: `sha256:${'a'.repeat(64)}`,
      payload: {
        op: 'update',
        planId: 'plan_1',
        patch: { planId: 'plan_other', title: 'changed target' }
      }
    });
    const before = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(candidate),
      /canonical role plan.*conflict|external authority action/i
    );
    assert.deepEqual(rowCounts(store), before);
  });
});

test('legal closed moment, relationship, payment, and role-plan actions remain importable', () => {
  const cases = [
    {
      kind: 'moment_like',
      targetKey: 'moment:moment_1',
      targetRevision: actionTargetRevision({ momentId: 'moment_1', content: 'source', createdAt: 1000 }),
      payload: { momentId: 'moment_1', like: true, comment: '', replyToCommentId: null },
      context: { input: { targetMoment: { momentId: 'moment_1', content: 'source', createdAt: 1000 } } }
    },
    {
      kind: 'relationship_transition',
      targetKey: 'relationship:yuqi',
      targetRevision: actionTargetRevision({
        relationshipStage: { base: 'close', phase: 'normal' }, stagePersonaRevision: 1
      }),
      payload: {
        baseAction: {
          from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历',
          confidence: 0.9, evidenceMessageIds: [], explicitMutualChange: false, changedAt: 2000
        },
        phaseAction: null,
        expectedSceneRevision: 1,
        label: '熟悉',
        changedAt: 2000
      },
      context: {
        scene: { relationshipStage: { base: 'close', phase: 'normal' }, stagePersonaRevision: 1 }
      }
    },
    {
      kind: 'payment_accept',
      targetKey: 'payment:payment_1',
      targetRevision: actionTargetRevision({ messageId: 'payment_1', amount: 8, status: 'pending' }),
      payload: { messageId: 'payment_1' },
      context: { payment: { messageId: 'payment_1', amount: 8, status: 'pending' } }
    },
    {
      kind: 'role_plan_update',
      targetKey: 'role_plan:plan_1',
      targetRevision: actionTargetRevision({ planId: 'plan_1', title: 'source title' }),
      payload: { op: 'update', planId: 'plan_1', patch: { title: 'next' } },
      context: { input: { rolePlan: { planId: 'plan_1', title: 'source title' } } }
    },
    {
      kind: 'role_plan_create',
      targetKey: `lineage_create:${FIXTURE.semantic.authorityLineageKey}:role_plan_create`,
      targetRevision: '1',
      payload: {
        op: 'create',
        type: 'private_message',
        source: 'spoken',
        title: '喝茶提醒',
        intent: '提醒用户喝茶',
        schedule: { kind: 'once', at: '2026-08-07T15:00:00+08:00' },
        timeConfidence: 'explicit'
      }
    }
  ];
  for (const action of cases) {
    withStore(store => {
      const candidate = action.context
        ? actionOnlyReceiptWithInputContext(action, action.context)
        : actionOnlyReceipt(action);
      assert.doesNotThrow(() => store.importExternalVisibleReceiptInternal(candidate));
    });
  }
});

test('external action target revisions remain bound to persisted input snapshots', () => {
  const paymentSource = { messageId: 'payment_1', amount: 8, status: 'pending' };
  const paymentTampered = { messageId: 'payment_2', amount: 8, status: 'pending' };
  const momentSource = { momentId: 'moment_1', content: 'source', createdAt: 1000 };
  const momentTampered = { momentId: 'moment_1', content: 'tampered', createdAt: 1000 };
  const relationshipSource = {
    relationshipStage: { base: 'close', phase: 'normal' },
    stagePersonaRevision: 1
  };
  const relationshipTampered = {
    relationshipStage: { base: 'close', phase: 'conflict' },
    stagePersonaRevision: 1
  };
  const rolePlanSource = { planId: 'plan_1', title: 'source title' };
  const rolePlanTampered = { planId: 'plan_1', title: 'tampered title' };
  const cases = [
    {
      action: {
        kind: 'payment_accept', targetKey: 'payment:payment_2',
        targetRevision: actionTargetRevision(paymentTampered),
        payload: { messageId: 'payment_2' }
      },
      context: { payment: paymentSource }
    },
    {
      action: {
        kind: 'moment_comment', targetKey: 'moment:moment_1',
        targetRevision: actionTargetRevision(momentTampered),
        payload: { momentId: 'moment_1', like: false, comment: 'tampered', replyToCommentId: null }
      },
      context: { input: { targetMoment: momentSource } }
    },
    {
      action: {
        kind: 'relationship_transition', targetKey: 'relationship:yuqi',
        targetRevision: actionTargetRevision(relationshipTampered),
        payload: {
          baseAction: {
            from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历',
            confidence: 0.9, evidenceMessageIds: [], explicitMutualChange: false, changedAt: 2000
          },
          phaseAction: null,
          expectedSceneRevision: 1,
          label: '熟悉',
          changedAt: 2000
        }
      },
      context: { scene: relationshipSource }
    },
    {
      action: {
        kind: 'role_plan_update', targetKey: 'role_plan:plan_1',
        targetRevision: actionTargetRevision(rolePlanTampered),
        payload: { op: 'update', planId: 'plan_1', patch: { title: 'tampered title' } }
      },
      context: { input: { rolePlan: rolePlanSource } }
    },
    {
      action: {
        kind: 'role_plan_create',
        targetKey: `lineage_create:${FIXTURE.semantic.authorityLineageKey}:role_plan_create`,
        targetRevision: '2',
        payload: {
          op: 'create',
          type: 'private_message',
          source: 'spoken',
          title: 'tampered create',
          intent: '新计划',
          schedule: { kind: 'once', at: '2026-08-07T15:00:00+08:00' },
          timeConfidence: 'explicit'
        }
      }
    }
  ];
  for (const { action, context } of cases) {
    withStore(store => {
      const candidate = actionOnlyReceiptWithInputContext(action, context);
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /pinned|target revision|authority action|external authority/i
      );
      assert.deepEqual(rowCounts(store), before);
    });
  }
});

test('direct Android action receipts carry one closed pinned target proof', () => {
  const payment = {
    kind: 'redpacket', amount: 8, note: '晚饭',
    messageId: 'payment_1', status: 'pending'
  };
  const action = {
    kind: 'payment_accept', targetKey: 'payment:payment_1',
    targetRevision: actionTargetRevision(payment),
    payload: { messageId: 'payment_1' }
  };
  withStore(store => {
    const candidate = directActionOnlyReceipt(
      action, pinnedActionContext({ payment }));
    assert.doesNotThrow(() => store.importExternalVisibleReceiptInternal(candidate));
  });
});

test('direct Android action receipts reject missing, rehashed, or overbroad target proof', () => {
  const payment = {
    kind: 'redpacket', amount: 8, note: '晚饭',
    messageId: 'payment_1', status: 'pending'
  };
  const action = {
    kind: 'payment_accept', targetKey: 'payment:payment_1',
    targetRevision: actionTargetRevision(payment),
    payload: { messageId: 'payment_1' }
  };
  const cases = [];
  const missing = directActionOnlyReceipt(action, pinnedActionContext({ payment }));
  delete missing.semantic.input.pinnedActionContext;
  cases.push(rehashReceipt(missing));

  const tamperedPayment = { ...payment, messageId: 'payment_2' };
  cases.push(directActionOnlyReceipt({
    ...action,
    targetKey: 'payment:payment_2',
    targetRevision: actionTargetRevision(tamperedPayment),
    payload: { messageId: 'payment_2' }
  }, pinnedActionContext({ payment })));

  const overbroad = directActionOnlyReceipt(action, pinnedActionContext({ payment }));
  overbroad.semantic.input.pinnedActionContext.secret = 'do-not-import';
  const basis = clone(overbroad.semantic.input.pinnedActionContext);
  delete basis.checksum;
  overbroad.semantic.input.pinnedActionContext.checksum = contentHash(basis);
  cases.push(rehashReceipt(overbroad));

  for (const candidate of cases) {
    withStore(store => {
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /pinned action|target revision|direct input|external authority/i
      );
      assert.deepEqual(rowCounts(store), before);
    });
  }
});

test('direct Android action receipts reject rehashed private fields inside every pinned target', () => {
  const cases = [
    {
      action: {
        kind: 'payment_accept', targetKey: 'payment:payment_1',
        targetRevision: actionTargetRevision({
          kind: 'redpacket', amount: 8, note: '晚饭', messageId: 'payment_1', status: 'pending'
        }),
        payload: { messageId: 'payment_1' }
      },
      proof: pinnedActionContext({ payment: {
        kind: 'redpacket', amount: 8, note: '晚饭', messageId: 'payment_1',
        status: 'pending', secret: 'must stay local'
      } })
    },
    {
      action: {
        kind: 'moment_like', targetKey: 'moment:moment_1',
        targetRevision: actionTargetRevision({
          momentId: 'moment_1', content: '风很轻', createdAt: 1000, secret: 'must stay local'
        }),
        payload: { momentId: 'moment_1', like: true, comment: '', replyToCommentId: null }
      },
      proof: pinnedActionContext({ targetMoment: {
        momentId: 'moment_1', content: '风很轻', createdAt: 1000, secret: 'must stay local'
      } })
    },
    {
      action: {
        kind: 'moment_reply', targetKey: 'comment:comment_1',
        targetRevision: actionTargetRevision({
          commentId: 'comment_1', momentId: 'moment_1', content: '收到', createdAt: 1001,
          secret: 'must stay local'
        }),
        payload: {
          momentId: 'moment_1', like: false, comment: '回复', replyToCommentId: 'comment_1'
        }
      },
      proof: pinnedActionContext({ targetComment: {
        commentId: 'comment_1', momentId: 'moment_1', content: '收到', createdAt: 1001,
        secret: 'must stay local'
      } })
    },
    {
      action: {
        kind: 'role_plan_update', targetKey: 'role_plan:plan_1',
        targetRevision: actionTargetRevision({
          planId: 'plan_1', title: '喝茶', secret: 'must stay local'
        }),
        payload: { op: 'update', planId: 'plan_1', patch: { title: '晚点喝茶' } }
      },
      proof: pinnedActionContext({ rolePlan: {
        planId: 'plan_1', title: '喝茶', secret: 'must stay local'
      } })
    },
    {
      action: {
        kind: 'role_plan_update', targetKey: 'role_plan:plan_1',
        targetRevision: actionTargetRevision({
          planId: 'plan_1', title: '喝茶',
          schedule: { kind: 'once', at: '2026-08-07T09:00:00+08:00', secret: 'must stay local' }
        }),
        payload: { op: 'update', planId: 'plan_1', patch: { title: '晚点喝茶' } }
      },
      proof: pinnedActionContext({ rolePlan: {
        planId: 'plan_1', title: '喝茶',
        schedule: { kind: 'once', at: '2026-08-07T09:00:00+08:00', secret: 'must stay local' }
      } })
    },
    {
      action: {
        kind: 'relationship_transition', targetKey: 'relationship:yuqi',
        targetRevision: actionTargetRevision({
          relationshipStage: { base: 'close', phase: 'normal', secret: 'must stay local' },
          stagePersonaRevision: 3
        }),
        payload: {
          baseAction: null,
          phaseAction: {
            from: 'normal', to: 'repairing', label: '修复', reason: '明确沟通',
            confidence: 0.9, evidenceMessageIds: ['msg_1'],
            explicitAcknowledgedChange: true, changedAt: 2000
          },
          expectedSceneRevision: 3, label: '修复', changedAt: 2000
        }
      },
      proof: pinnedActionContext({ scene: {
        relationshipStage: { base: 'close', phase: 'normal', secret: 'must stay local' },
        stagePersonaRevision: 3
      } })
    }
  ];
  for (const entry of cases) {
    withStore(store => {
      const candidate = directActionOnlyReceipt(entry.action, entry.proof);
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /pinned|target revision|external authority/i
      );
      assert.deepEqual(rowCounts(store), before);
    });
  }
});

test('direct Android action receipts reject duplicate single-action namespaces', () => {
  const payment = {
    kind: 'redpacket', amount: 8, note: '晚饭', messageId: 'payment_1', status: 'pending'
  };
  const baseAction = {
    kind: 'payment_accept', targetKey: 'payment:payment_1',
    targetRevision: actionTargetRevision(payment), payload: { messageId: 'payment_1' }
  };
  const candidate = directActionOnlyReceipt(baseAction, pinnedActionContext({ payment }));
  const duplicate = clone(candidate.semantic.actions[0]);
  duplicate.ordinal = 1;
  duplicate.actionId = deriveVisibleActionId(candidate.semantic.visibleGroupId, 1);
  duplicate.kind = 'payment_decline';
  duplicate.checksum = contentHash({
    kind: duplicate.kind, targetKey: duplicate.targetKey,
    targetRevision: duplicate.targetRevision, payload: duplicate.payload
  });
  candidate.semantic.actions.push(duplicate);
  rehashReceipt(candidate);
  withStore(store => {
    const before = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(candidate),
      /compatibility|duplicate|namespace|external authority/i
    );
    assert.deepEqual(rowCounts(store), before);
  });
});

test('direct receipts import the complete user batch and preserve revision formulas', () =>
  withStore(store => {
    const candidate = clone(FIXTURE);
    candidate.semantic.turnKind = 'DIRECT_REPLY';
    candidate.semantic.input = {
      kind: 'direct',
      visibilitySequence: 8,
      clearEpoch: 0,
      batch: {
        batchId: 'batch_android_direct_001',
        characterId: 'yuqi',
        sourceMessageId: 'msg_android_user_001',
        startedAt: 900,
        committedAt: 1000,
        checksum: '',
        items: [{
          sequence: 0,
          messageId: 'msg_android_user_001',
          message: {
            messageId: 'msg_android_user_001',
            speakerId: 'user',
            speakerType: 'user',
            recipientId: 'yuqi',
            content: 'hi',
            sentAt: 900,
            attachments: []
          },
          checksum: ''
        }]
      },
      checksum: ''
    };
    const item = candidate.semantic.input.batch.items[0];
    item.checksum = contentHash(item.message);
    const batch = candidate.semantic.input.batch;
    const batchHeader = {
      batchId: batch.batchId,
      sourceMessageId: batch.sourceMessageId,
      messageIds: batch.items.map(entry => entry.messageId),
      startedAt: batch.startedAt,
      committedAt: batch.committedAt
    };
    batch.checksum = contentHash(batchHeader);
    candidate.semantic.input.checksum = batch.checksum;
    candidate.manifest.semantic = clone(candidate.semantic);
    candidate.commitChecksum = contentHash(candidate.semantic);
    candidate.manifest.commitChecksum = candidate.commitChecksum;
    store.importExternalVisibleReceiptInternal(candidate);
    assert.equal(store.getCurrentUserBatch(candidate.semantic.authoritativeTurnId).batchId,
      batch.batchId);
    assert.equal(store.getTurn(candidate.semantic.authoritativeTurnId).inputUserBatchId,
      batch.batchId);
    const lineage = store.getTurnAuthorityLineage(candidate.semantic.authorityLineageKey);
    assert.equal(lineage.revision, candidate.semantic.lineageRevisionAtCreation + 1);
    const receipt = store.getVisibleCommitReceipt(candidate.semantic.authorityLineageKey);
    assert.equal(receipt.lineageRevisionBefore, candidate.semantic.lineageRevisionAtCreation);
    assert.equal(receipt.lineageRevisionAfter, candidate.semantic.lineageRevisionAtCreation + 1);
    assert.equal(receipt.turnRevisionAfter, candidate.semantic.turnRevision);
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
  }));

test('fresh Android fallback receipts require an explicit native-null retryOfTurnId', () =>
  withStore(store => {
    const withoutRetryField = clone(FIXTURE);
    delete withoutRetryField.semantic.retryOfTurnId;
    delete withoutRetryField.manifest.semantic.retryOfTurnId;
    withoutRetryField.commitChecksum = contentHash(withoutRetryField.semantic);
    withoutRetryField.manifest.commitChecksum = withoutRetryField.commitChecksum;
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(withoutRetryField),
      /retryOfTurnId/
    );
  }));

test('Android fallback retry imports only an existing failed parent and preserves child lineage', () =>
  withStore((store, path) => {
    const parent = createFailedParent(store);
    const child = retryReceipt(parent);
    const imported = store.importExternalVisibleReceiptInternal(child);
    assert.equal(imported.exactReplay, false);
    assert.equal(store.getTurn(child.semantic.authoritativeTurnId).retryOfTurnId, parent.turnId);
    assert.equal(store.getTurnAuthorityLineage(child.semantic.authorityLineageKey).latestTurnId,
      child.semantic.authoritativeTurnId);
    assert.equal(store.getTurnAuthorityLineage(child.semantic.authorityLineageKey).revision,
      child.semantic.lineageRevisionAtCreation + 1);
    assert.equal(store.getVisibleCommitReceipt(child.semantic.authorityLineageKey).lineageRevisionBefore,
      child.semantic.lineageRevisionAtCreation);

    store.close();
    const reopened = new YuqiStore(path);
    try {
      const before = rowCounts(reopened);
      const replay = reopened.importExternalVisibleReceiptInternal(child);
      assert.equal(replay.exactReplay, true);
      assert.deepEqual(rowCounts(reopened), before);
      assert.doesNotThrow(() => reopened.assertVisibleAuthorityV13Invariants());
      assert.doesNotThrow(() => reopened.assertReleaseAuthorityV14Invariants());
    } finally {
      reopened.close();
    }
  }));

test('a non-Android wire-v2 retry child cannot satisfy canonical failure supersede closure', () =>
  withStore((store, path) => {
    const parent = createFailedParent(store, { turnId: 'turn_android_wire2_origin_parent' });
    const child = retryReceipt(parent, {
      authoritativeTurnId: 'turn_android_wire2_origin_child'
    });
    store.importExternalVisibleReceiptInternal(child);
    store.db.prepare('UPDATE turns SET origin = ? WHERE turn_id = ?')
      .run('pc', child.semantic.authoritativeTurnId);
    store.close();
    assert.throws(
      () => new YuqiStore(path),
      /canonical failure delivery authority conflict/
    );
  }));

test('Android fallback retry rejects missing, false-permission, and committed parents without writes', () => {
  withStore(store => {
    const missing = retryReceipt({
      turnId: 'turn_android_missing_parent',
      lineageRevisionAtCreation: 1
    });
    const beforeMissing = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(missing),
      /retry parent|retry permission|authority conflict/
    );
    assert.deepEqual(rowCounts(store), beforeMissing);
  });

  withStore(store => {
    const parent = createFailedParent(store, {
      retryAllowed: false,
      turnId: 'turn_android_false_parent'
    });
    const candidate = retryReceipt(parent);
    const before = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(candidate),
      /retry permission|retry parent|authority conflict/
    );
    assert.deepEqual(rowCounts(store), before);
  });

  withStore(store => {
    store.importExternalVisibleReceiptInternal(FIXTURE);
    const candidate = retryReceipt({
      turnId: FIXTURE.semantic.authoritativeTurnId,
      lineageRevisionAtCreation: FIXTURE.semantic.lineageRevisionAtCreation
    });
    const before = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(candidate),
      /committed|cross-device|authority conflict|retry parent/
    );
    assert.deepEqual(rowCounts(store), before);
    assert.equal(store.getTurn(candidate.semantic.authoritativeTurnId), null);
  });
});

test('external direct import reuses equivalent pre-existing input and character message projections', () =>
  withStore(store => {
    const candidate = clone(FIXTURE);
    candidate.semantic = {
      ...candidate.semantic,
      turnKind: 'DIRECT_REPLY',
      retryOfTurnId: null,
      input: {
        kind: 'direct',
        visibilitySequence: 8,
        clearEpoch: 0,
        batch: {
          batchId: 'batch_android_direct_reuse',
          characterId: 'yuqi',
          sourceMessageId: 'msg_android_direct_input',
          startedAt: 900,
          committedAt: 1000,
          checksum: '',
          items: [{
            sequence: 0,
            messageId: 'msg_android_direct_input',
            message: {
              messageId: 'msg_android_direct_input',
              speakerId: 'user',
              speakerType: 'user',
              recipientId: 'yuqi',
              content: 'same input',
              sentAt: 900,
              attachments: []
            },
            checksum: ''
          }]
        },
        checksum: ''
      }
    };
    const item = candidate.semantic.input.batch.items[0];
    item.checksum = contentHash(item.message);
    const batch = candidate.semantic.input.batch;
    batch.checksum = contentHash({
      batchId: batch.batchId,
      sourceMessageId: batch.sourceMessageId,
      messageIds: batch.items.map(entry => entry.messageId),
      startedAt: batch.startedAt,
      committedAt: batch.committedAt
    });
    candidate.semantic.input.checksum = batch.checksum;
    candidate.manifest.semantic = clone(candidate.semantic);
    candidate.commitChecksum = contentHash(candidate.semantic);
    candidate.manifest.commitChecksum = candidate.commitChecksum;
    insertEquivalentMessageProjections(store, candidate);
    const imported = store.importExternalVisibleReceiptInternal(candidate);
    assert.equal(imported.exactReplay, false);
    assert.equal(Number(store.db.prepare(
      'SELECT COUNT(*) AS value FROM messages WHERE message_id IN (?, ?)'
    ).get(
      candidate.semantic.input.batch.items[0].messageId,
      candidate.semantic.replyItems[0].messageId
    ).value), 2);
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
  }));

test('external direct import rejects changed or foreign existing message projections with zero writes', () => {
  for (const mode of ['changed', 'foreign']) {
    withStore(store => {
      const candidate = clone(FIXTURE);
      candidate.semantic = {
        ...candidate.semantic,
        turnKind: 'DIRECT_REPLY',
        retryOfTurnId: null,
        input: {
          kind: 'direct',
          visibilitySequence: 9,
          clearEpoch: 0,
          batch: {
            batchId: `batch_android_${mode}`,
            characterId: 'yuqi',
            sourceMessageId: `msg_android_${mode}`,
            startedAt: 900,
            committedAt: 1000,
            checksum: '',
            items: [{
              sequence: 0,
              messageId: `msg_android_${mode}`,
              message: {
                messageId: `msg_android_${mode}`,
                speakerId: 'user',
                speakerType: 'user',
                recipientId: 'yuqi',
                content: 'incoming authority text',
                sentAt: 900,
                attachments: []
              },
              checksum: ''
            }]
          },
          checksum: ''
        }
      };
      const item = candidate.semantic.input.batch.items[0];
      item.checksum = contentHash(item.message);
      const batch = candidate.semantic.input.batch;
      batch.checksum = contentHash({
        batchId: batch.batchId,
        sourceMessageId: batch.sourceMessageId,
        messageIds: batch.items.map(entry => entry.messageId),
        startedAt: batch.startedAt,
        committedAt: batch.committedAt
      });
      candidate.semantic.input.checksum = batch.checksum;
      candidate.manifest.semantic = clone(candidate.semantic);
      candidate.commitChecksum = contentHash(candidate.semantic);
      candidate.manifest.commitChecksum = candidate.commitChecksum;
      const existingMessage = clone(item.message);
      if (mode === 'changed') existingMessage.content = 'different persisted text';
      const existingNormalized = {
        messageId: existingMessage.messageId,
        turnId: mode === 'foreign' ? 'turn_foreign_owner' : candidate.semantic.authoritativeTurnId,
        characterId: 'yuqi',
        speakerId: existingMessage.speakerId,
        speakerType: existingMessage.speakerType,
        recipientId: existingMessage.recipientId,
        content: existingMessage.content,
        sentAt: existingMessage.sentAt,
        origin: 'phone',
        deviceId: candidate.semantic.deviceId,
        deviceSeq: candidate.semantic.journalSyncSeq
      };
      insertMessageProjection(store, {
        message: existingMessage,
        turnId: existingNormalized.turnId,
        origin: 'phone',
        deviceId: existingNormalized.deviceId,
        deviceSeq: existingNormalized.deviceSeq,
        checksum: contentHash(existingNormalized)
      });
      const before = rowCounts(store);
      assert.throws(
        () => store.importExternalVisibleReceiptInternal(candidate),
        /external authority message conflict/
      );
      assert.deepEqual(rowCounts(store), before);
      assert.equal(store.getTurn(candidate.semantic.authoritativeTurnId), null);
    });
  }
});

test('fault during external import rolls back the entire mirror graph', () =>
  withStore(store => {
    store.importExternalVisibleReceiptFaultStep = 'after_lineage';
    const before = rowCounts(store);
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(FIXTURE),
      /forced external import fault: after_lineage/
    );
    assert.deepEqual(rowCounts(store), before);
  }));

test('reconciler ACK advances only after a successful external authority commit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-android-fallback-reconcile-'));
  const store = new YuqiStore(join(directory, 'runtime.sqlite'));
  try {
    const reconciler = new YuqiReconciler({
      store,
      codex: { async runTurn() { throw new Error('external authority must not call Codex'); } }
    });
    store.importExternalVisibleReceiptFaultStep = 'after_lineage';
    await assert.rejects(
      () => reconciler.importExternalVisibleReceiptInternal(FIXTURE),
      /forced external import fault: after_lineage/
    );
    assert.equal(store.getSyncCursor(FIXTURE.semantic.deviceId), 0);
    store.importExternalVisibleReceiptFaultStep = null;
    const result = await reconciler.importExternalVisibleReceiptInternal(FIXTURE);
    assert.equal(result.ackSeq, FIXTURE.semantic.journalSyncSeq);
    assert.equal(store.getSyncCursor(FIXTURE.semantic.deviceId), FIXTURE.semantic.journalSyncSeq);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
