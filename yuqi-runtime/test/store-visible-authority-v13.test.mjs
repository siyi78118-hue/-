import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { generationFingerprint, laneKeyForEnvelope } from '../src/interaction-lanes.mjs';
import { buildProactiveMotiveAuthority } from '../src/life-simulation.mjs';
import { contentHash, validateEnvelope } from '../src/protocol.mjs';
import { InteractionLaneBusyError, YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const SHA_A = 'a'.repeat(64);
const V13_MIGRATION_FAULT_STEPS = [
  'after_schema_create',
  'after_schema_alter',
  'after_current_batch_copy',
  'after_visible_item_copy',
  'after_visible_action_copy',
  'after_copy_verification',
  'after_batch_parent_backfill',
  'after_group_parent_backfill',
  'after_lineage_parent_backfill',
  'after_parent_backfill_verification',
  'after_old_table_rename',
  'after_old_table_drop',
  'after_new_table_rename',
  'after_index_create',
  'after_version_write'
];

function withTempPath(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-visible-v13-'));
  const path = join(directory, 'memory.sqlite');
  let thrown = null;
  try {
    return run(path);
  } catch (error) {
    thrown = error;
    throw error;
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (cleanupError) {
      if (!thrown) throw cleanupError;
    }
  }
}

function raw(path, { readOnly = false } = {}) {
  return new DatabaseSync(path, { readOnly });
}

function normalizeSchemaSql(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function snapshotDatabase(path) {
  const database = raw(path, { readOnly: true });
  try {
    const userVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
    const schema = database.prepare(`
      SELECT type, name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
        AND type IN ('table', 'index', 'trigger')
      ORDER BY type, name
    `).all().map(row => ({
      type: row.type,
      name: row.name,
      sql: normalizeSchemaSql(row.sql)
    }));
    const tables = schema.filter(row => row.type === 'table').map(row => row.name);
    const rows = Object.fromEntries(tables.map(table => [
      table,
      database.prepare(`SELECT * FROM "${table}"`).all()
        .map(row => JSON.stringify(row))
        .sort()
    ]));
    return {
      userVersion,
      schema,
      rowCounts: Object.fromEntries(tables.map(table => [table, rows[table].length])),
      logicalChecksum: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
      canonicalTurnCount: Number(database.prepare(`
        SELECT COUNT(*) AS value
        FROM turns
        WHERE result_authority_version = 1
      `).get().value)
    };
  } finally {
    database.close();
  }
}

function columns(store, table) {
  return store.db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
}

function rows(store, table) {
  const allowlisted = new Set([
    'turns',
    'turn_authority_lineages',
    'current_user_batches',
    'visible_result_groups',
    'visible_result_items',
    'visible_result_actions',
    'cloud_deliveries'
  ]);
  assert.equal(allowlisted.has(table), true, `unexpected raw table: ${table}`);
  return store.db.prepare(`SELECT * FROM "${table}"`).all();
}

function envelope(index, kind = 'DIRECT_REPLY') {
  const automatic = kind !== 'DIRECT_REPLY';
  return {
    protocolVersion: 2,
    turnId: `turn_v12_${index}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: index,
    createdAt: 10_000 + index,
    kind,
    message: automatic ? undefined : {
      messageId: `msg_v12_${index}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `第${index}条迁移消息`,
      sentAt: 9_000 + index
    },
    trigger: automatic ? {
      triggerId: `trigger_v12_${index}_${kind}`,
      triggerType: kind.toLowerCase(),
      scheduledFor: 9_000 + index,
      executedAt: 10_000 + index,
      context: { reason: 'test' }
    } : undefined
  };
}

function v3AutomaticEnvelope(index, kind = 'PROACTIVE_CHAT') {
  const triggerId = `trigger_v3_${index}_${kind}`;
  const cursor = {
    nativeCompletedTurnId: null,
    nativeCompletedGroupId: null,
    nativeCompletedSequence: 0,
    uiAppliedTurnId: null,
    uiAppliedGroupId: null,
    uiAppliedSequence: 0,
    localSequence: index,
    clearedThroughSequence: 0,
    clearEpoch: 0,
    clearedAt: 0,
    chatOpen: true,
    quotedMessageId: null
  };
  const input = {
    protocolVersion: 3,
    turnId: `turn_v3_${index}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: index,
    createdAt: 10_000 + index,
    kind,
    trigger: {
      triggerId,
      triggerType: kind.toLowerCase(),
      scheduledFor: 9_000 + index,
      executedAt: 10_000 + index,
      context: {}
    },
    context: { visibilityCursor: cursor }
  };
  input.authority = {
    algorithm: 'al-authority-v1',
    roleId: 'yuqi',
    laneKey: 'private_chat',
    rootSourceId: triggerId,
    lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: triggerId }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  return input;
}

function ensureRollout(store, rolloutKey = 'DIRECT_REPLY') {
  if (store.getCognitionRollout(rolloutKey)) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey,
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: SHA_A
    }],
    now: 1
  });
}

function ensureDirectRollout(store) {
  ensureRollout(store, 'DIRECT_REPLY');
}

function ensureCanonicalRollouts(store) {
  if (store.getCognitionRollout('DIRECT_REPLY')) return;
  store.initializeCognitionRolloutsInternal({
    rows: [
      'DIRECT_REPLY', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION',
      'MOMENT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
      'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE'
    ].map(rolloutKey => ({
      rolloutKey,
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: SHA_A
    })),
    now: 1
  });
}

function createCanonicalFromEnvelope(store, input, { annotationSnapshot = {} } = {}) {
  const kind = input.kind;
  ensureRollout(store, kind);
  const rollout = store.getCognitionRollout(kind);
  const laneKey = laneKeyForEnvelope(input);
  const lane = store.getInteractionLane('yuqi', laneKey);
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi',
    at: input.message?.sentAt ?? input.trigger.executedAt
  });
  const effectiveAnnotationSnapshot = kind === 'PROACTIVE_CHAT'
    && Object.keys(annotationSnapshot || {}).length === 0
    ? store.rebuildProactiveMotiveAuthorityInternal({ envelope: input }).annotationSnapshot
    : annotationSnapshot;
  return store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: kind,
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey,
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: input.message
      ? (input.context?.currentBatch?.batchId || `batch_${input.message.messageId}`)
      : input.trigger.triggerId,
    inputVisibilitySequence: input.protocolVersion === 3
      ? input.context.visibilityCursor.localSequence
      : Number(lane?.localSequence || 0),
    inputClearEpoch: input.protocolVersion === 3
      ? input.context.visibilityCursor.clearEpoch
      : Number(lane?.clearEpoch || 0),
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: effectiveAnnotationSnapshot
  }).turn;
}

function createCanonical(store, index, kind = 'DIRECT_REPLY') {
  if (kind === 'PROACTIVE_CHAT'
    && !store.listLifeEpisodes('yuqi').some(item => item.episodeId === 'task17_fixture_chat')) {
    store.putLifePlan('yuqi', [{
      episodeId: 'task17_fixture_chat',
      kind: 'personal',
      title: 'Task17 fixture context',
      startAt: 0,
      endAt: 100_000
    }]);
  }
  return createCanonicalFromEnvelope(store, envelope(index, kind));
}

function threeBubbleEnvelope(index = 1) {
  const input = envelope(index);
  const messages = [0, 1, 2].map(offset => ({
    ...input.message,
    messageId: `msg_v13_batch_${index}_${offset}`,
    content: `第${offset + 1}个气泡`,
    sentAt: input.message.sentAt - (2 - offset) * 100
  }));
  input.message = messages[2];
  input.context = {
    currentBatch: {
      batchId: `batch_v13_multi_${index}`,
      messageIds: messages.map(message => message.messageId),
      startedAt: messages[0].sentAt,
      committedAt: input.createdAt,
      messages
    }
  };
  return input;
}

function createCanonicalRetry(store, parent, index) {
  const input = JSON.parse(parent.envelopeJson);
  input.turnId = `turn_v13_retry_${index}`;
  input.deviceSeq = Number(input.deviceSeq) + index;
  input.context = {
    ...(input.context || {}),
    retry: {
      retryOfTurnId: parent.turnId,
      canonicalMessageId: input.message.messageId
    }
  };
  const lane = store.getInteractionLane(parent.characterId, parent.laneKey);
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: parent.characterId,
    at: input.message.sentAt
  });
  return store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: parent.rolloutKey,
    expectedRolloutRevision: parent.rolloutRevision,
    authoritativeReleaseId: parent.authoritativeReleaseId,
    comparisonReleaseId: parent.comparisonReleaseId,
    comparisonDirection: parent.comparisonMode === 'none' ? null : parent.comparisonMode,
    laneKey: parent.laneKey,
    expectedLaneRevision: Number(lane.revision),
    inputUserBatchId: parent.inputUserBatchId,
    inputVisibilitySequence: parent.inputVisibilitySequence,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: parent.annotationSnapshot
  }).turn;
}

function commitCanonical(store, turn, index, { rich = false, items = undefined, actionSet = undefined } = {}) {
  const visibleGroup = {
    items: items ?? [{
      content: `第${index}条迁移回复`,
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user'
    }]
  };
  const actionDraft = {
    kind: 'moment_create',
    payload: { text: `第${index}条测试动态` }
  };
  const resolvedAction = rich
    ? store.resolveCanonicalActionTargetInternal({ turn, action: actionDraft })
    : null;
  const resolvedActionSet = actionSet ?? (rich ? [{
    ...actionDraft,
    targetKey: resolvedAction.targetKey,
    targetRevision: resolvedAction.targetRevision
  }] : []);
  const statePatch = {
    mood: index === 1 ? 'engaged' : 'warm',
    openThreads: [`thread_v12_${index}`],
    currentStances: rich ? [{
      operation: 'create',
      stanceId: `stance_${turn.turnId}`,
      topic: 'conversation',
      position: '继续聊',
      reason: '当前互动',
      strength: 0.7,
      flexibility: 0.8,
      evidenceMessageIds: [JSON.parse(turn.envelopeJson).message?.messageId].filter(Boolean),
      expiresAt: 30_000,
      remainingRelevantUserBatches: 3
    }] : []
  };
  const memoryJobs = rich ? [{
    jobId: `job_${turn.turnId}`,
    jobType: 'turn_consolidation',
    payload: {
      cognitionPacketChecksum: 'c'.repeat(64),
      resultingCognitiveStateChecksum: 'd'.repeat(64)
    }
  }] : [];
  const proactiveV3 = turn.protocolVersion === 3 && turn.rolloutKey === 'PROACTIVE_CHAT';
  const proactiveAuthority = turn.annotationSnapshot?.proactiveMotiveAuthority;
  const proactiveEvidenceIds = proactiveV3 && (visibleGroup.items.length || resolvedActionSet.length)
    ? [proactiveAuthority?.candidates?.[0]?.motiveId].filter(Boolean)
    : [];
  const contextRevision = proactiveV3
    ? contentHash({
        agencySnapshotChecksum: turn.agencySnapshotChecksum,
        proactiveMotiveAuthorityChecksum: proactiveAuthority?.checksum
      })
    : turn.agencySnapshotChecksum;
  const state = store.getCognitiveState('yuqi');
  return commitVisibleResult({
    store,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
    expectedCognitiveStateRevision: Number(state?.revision || 0),
    expectedLatestUserBatchId: turn.inputUserBatchId,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    inputClearEpoch: turn.inputClearEpoch,
    protocolVersion: turn.protocolVersion,
    turnKind: turn.rolloutKey,
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet: resolvedActionSet,
    proactiveMotiveEvidenceIds: proactiveEvidenceIds,
    statePatch,
    memoryJobs,
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: resolvedActionSet,
      contextRevision
    }),
    now: 20_000 + index
  });
}

test('fresh v3 PROACTIVE_CHAT refuses an occupied direct/proactive lane without writes', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureCanonicalRollouts(store);
      const firstInput = v3AutomaticEnvelope(1, 'PROACTIVE_CHAT');
      const rollout = store.getCognitionRollout('PROACTIVE_CHAT');
      const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: firstInput.createdAt });
      const first = store.createCanonicalVisibleTurnInternal({
        envelope: firstInput,
        rolloutKey: 'PROACTIVE_CHAT',
        expectedRolloutRevision: rollout.revision,
        authoritativeReleaseId: rollout.stableReleaseId,
        comparisonReleaseId: null,
        comparisonDirection: null,
        laneKey: 'private_chat',
        expectedLaneRevision: 0,
        inputUserBatchId: firstInput.trigger.triggerId,
        inputVisibilitySequence: 1,
        inputClearEpoch: 0,
        agencySnapshotChecksum: agency.checksum,
        annotationSnapshot: store.rebuildProactiveMotiveAuthorityInternal({ envelope: firstInput }).annotationSnapshot
      }).turn;
      const laneBefore = store.getInteractionLane('yuqi', 'private_chat');
      const secondInput = v3AutomaticEnvelope(2, 'PROACTIVE_CHAT');
      secondInput.authority.lineageKey = deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: secondInput.trigger.triggerId
      });
      const before = store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value;
      assert.throws(() => store.createCanonicalVisibleTurnInternal({
        envelope: secondInput,
        rolloutKey: 'PROACTIVE_CHAT',
        expectedRolloutRevision: rollout.revision,
        authoritativeReleaseId: rollout.stableReleaseId,
        comparisonReleaseId: null,
        comparisonDirection: null,
        laneKey: 'private_chat',
        expectedLaneRevision: laneBefore.revision,
        inputUserBatchId: secondInput.trigger.triggerId,
        inputVisibilitySequence: 2,
        inputClearEpoch: 0,
        agencySnapshotChecksum: agency.checksum,
        annotationSnapshot: store.rebuildProactiveMotiveAuthorityInternal({ envelope: secondInput }).annotationSnapshot
      }), error => error instanceof InteractionLaneBusyError || error?.code === 'INTERACTION_LANE_BUSY');
      assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value), Number(before));
      assert.equal(store.getInteractionLane('yuqi', 'private_chat').generatingTurnId, first.turnId);
    } finally {
      store.close();
    }
  });
});

test('Task17 lane collision admission stays limited to v3 direct and proactive chat', () => {
  for (const [label, makeInput] of [
    ['wire-v2 direct', index => envelope(index, 'DIRECT_REPLY')],
    ['v3 proactive moment', index => {
      const input = v3AutomaticEnvelope(index, 'PROACTIVE_MOMENT');
      input.authority.laneKey = laneKeyForEnvelope(input);
      input.authority.lineageKey = deriveAuthorityLineageKey({
        roleId: input.characterId, laneKey: input.authority.laneKey, rootSourceId: input.authority.rootSourceId
      });
      return input;
    }],
    ['v3 role plan', index => {
      const input = v3AutomaticEnvelope(index, 'ROLE_PLAN_CHAT');
      input.authority.laneKey = laneKeyForEnvelope(input);
      input.authority.lineageKey = deriveAuthorityLineageKey({
        roleId: input.characterId, laneKey: input.authority.laneKey, rootSourceId: input.authority.rootSourceId
      });
      return input;
    }]
  ]) {
    withTempPath(path => {
      const store = new YuqiStore(path);
      try {
        ensureCanonicalRollouts(store);
        createCanonicalFromEnvelope(store, makeInput(1));
        assert.doesNotThrow(() => createCanonicalFromEnvelope(store, makeInput(2)), label);
      } finally {
        store.close();
      }
    });
  }
});

test('v3 direct reply does not requeue a role-plan lane through Task17 admission', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureCanonicalRollouts(store);
      const plan = v3AutomaticEnvelope(11, 'ROLE_PLAN_CHAT');
      plan.authority.laneKey = 'private_chat';
      plan.authority.lineageKey = deriveAuthorityLineageKey({
        roleId: plan.characterId, laneKey: plan.authority.laneKey, rootSourceId: plan.authority.rootSourceId
      });
      plan.context.visibilityCursor.localSequence = 1;
      createCanonicalFromEnvelope(store, plan);
      const direct = v3AutomaticEnvelope(12, 'DIRECT_REPLY');
      delete direct.trigger;
      direct.message = {
        messageId: 'msg_direct_after_plan',
        speakerId: 'user',
        speakerType: 'user',
        recipientId: 'yuqi',
        content: 'direct',
        sentAt: direct.createdAt
      };
      direct.authority.rootSourceId = direct.message.messageId;
      direct.context.currentBatch = {
        batchId: 'batch_direct_after_plan',
        messageIds: [direct.message.messageId],
        startedAt: direct.message.sentAt,
        committedAt: direct.createdAt,
        messages: [direct.message]
      };
      direct.authority.laneKey = 'private_chat';
      direct.authority.lineageKey = deriveAuthorityLineageKey({
        roleId: direct.characterId, laneKey: direct.authority.laneKey, rootSourceId: direct.authority.rootSourceId
      });
      direct.context.visibilityCursor.localSequence =
        Number(store.getInteractionLane('yuqi', 'private_chat').localSequence || 0) + 1;
      assert.doesNotThrow(() => createCanonicalFromEnvelope(store, direct));
    } finally {
      store.close();
    }
  });
});

test('consumed proactive motives come only from committed v3 manifest evidence ids', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureCanonicalRollouts(store);
      store.putLifePlan('yuqi', [
        {
          episodeId: 'task17_consumed_current',
          kind: 'personal',
          title: '当前真实动机',
          startAt: 9_001,
          endAt: 100_000
        },
        {
          episodeId: 'task17_consumed_recent',
          kind: 'personal',
          title: '最近真实动机',
          startAt: 8_000,
          endAt: 9_000
        }
      ]);
      const input = v3AutomaticEnvelope(901, 'PROACTIVE_CHAT');
      input.context.visibilityCursor.localSequence = 1;
      const turn = createCanonicalFromEnvelope(store, input);
      const pinned = turn.annotationSnapshot.proactiveMotiveAuthority.candidates;
      assert.equal(pinned.length >= 2, true);
      commitCanonical(store, turn, 901);
      const group = store.getTurnAuthorityLineage(turn.authorityLineageKey).committedGroupId;
      const consumed = store.listConsumedProactiveMotiveIdsInternal({ roleId: 'yuqi' });
      assert.deepEqual(consumed, [pinned[0].motiveId]);
      assert.equal(consumed.includes(pinned[1].motiveId), false);

      const existingManifest = store.getVisibleResultManifest(group).semantic;
      const forgedManifest = { ...existingManifest, proactiveMotiveEvidenceIds: ['forged_motive'] };
      store.db.prepare(`
        UPDATE visible_result_manifests
        SET semantic_json = ?, semantic_checksum = ?
        WHERE group_id = ?
      `).run(JSON.stringify(forgedManifest), contentHash(forgedManifest), group);
      assert.throws(
        () => store.listConsumedProactiveMotiveIdsInternal({ roleId: 'yuqi' }),
        /canonical visible group authority conflict|proactive motive manifest evidence authority conflict/
      );
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(group, { purpose: 'reopen' }),
        /canonical visible group authority conflict|proactive motive evidence authority conflict|proactive motive authority conflict/
      );
    } finally {
      store.close();
    }
  });
});

test('wire-v2 PROACTIVE_CHAT remains v2-compatible through close and reopen', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      const turn = createCanonical(store, 912, 'PROACTIVE_CHAT');
      assert.equal(turn.protocolVersion, 2);
      commitCanonical(store, turn, 912);
      const groupId = store.getTurnAuthorityLineage(turn.authorityLineageKey).committedGroupId;
      const manifest = store.getVisibleResultManifest(groupId);
      assert.equal(manifest.payloadVersion, 'pc-visible-commit-v2');
      assert.equal(Object.hasOwn(manifest.semantic, 'proactiveMotiveEvidenceIds'), false);
      assert.equal(store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }).status, 'live');
      store.close();
      const reopened = new YuqiStore(path);
      try {
        assert.equal(reopened.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }).status, 'live');
      } finally {
        reopened.close();
      }
    } finally {
      try { store.close(); } catch {}
    }
  });
});

test('wire-v3 PROACTIVE_CHAT committed group survives full close and reopen invariants', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    let groupId;
    try {
      store.putLifePlan('yuqi', [{
        episodeId: 'task17_wire3_reopen_current',
        kind: 'personal',
        title: '真实 wire3 重启动机',
        startAt: 0,
        endAt: 100_000
      }]);
      const input = v3AutomaticEnvelope(914, 'PROACTIVE_CHAT');
      input.context.visibilityCursor.localSequence = 1;
      const annotationSnapshot = store.rebuildProactiveMotiveAuthorityInternal({
        envelope: input
      }).annotationSnapshot;
      const turn = createCanonicalFromEnvelope(store, input, { annotationSnapshot });
      assert.equal(turn.protocolVersion, 3);
      assert.equal(turn.rolloutKey, 'PROACTIVE_CHAT');
      const receipt = commitCanonical(store, turn, 914);
      groupId = receipt.visibleGroupId;
      assert.equal(store.getVisibleResultManifest(groupId).payloadVersion, 'pc-visible-commit-v3');
      assert.equal(store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }).status, 'live');
      store.close();

      const reopened = new YuqiStore(path);
      try {
        assert.doesNotThrow(() => reopened.assertVisibleAuthorityV13Invariants());
        assert.doesNotThrow(() => reopened.assertReleaseAuthorityV14Invariants());
        assert.equal(
          reopened.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }).status,
          'live'
        );
      } finally {
        reopened.close();
      }
    } finally {
      try { store.close(); } catch {}
    }
  });
});

test('wire-v3 receipt with a non-PC authority origin is rejected by scoped and restart validation', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    let groupId;
    try {
      store.putLifePlan('yuqi', [{
        episodeId: 'task17_wire3_wrong_origin',
        kind: 'personal',
        title: 'wire3 origin fixture',
        startAt: 0,
        endAt: 100_000
      }]);
      const input = v3AutomaticEnvelope(915, 'PROACTIVE_CHAT');
      input.context.visibilityCursor.localSequence = 1;
      const turn = createCanonicalFromEnvelope(store, input, {
        annotationSnapshot: store.rebuildProactiveMotiveAuthorityInternal({
          envelope: input
        }).annotationSnapshot
      });
      groupId = commitCanonical(store, turn, 915).visibleGroupId;
      store.db.prepare(`
        UPDATE visible_commit_receipts
        SET authority_origin = 'android_fallback'
        WHERE group_id = ?
      `).run(groupId);
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }),
        /canonical visible group authority conflict|receipt authority conflict/
      );
      store.close();
      assert.throws(() => new YuqiStore(path), /v11 invariant|authority conflict/);
    } finally {
      try { store.close(); } catch {}
    }
  });
});

test('v3 proactive authority preserves trusted annotation siblings and rejects pinned time/source/ref tampering', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      store.putLifePlan('yuqi', [{
        episodeId: 'task17_sibling_current',
        kind: 'personal',
        title: '带可信兄弟字段的真实动机',
        startAt: 0,
        endAt: 100_000
      }]);
      const input = v3AutomaticEnvelope(913, 'PROACTIVE_CHAT');
      input.context.visibilityCursor.localSequence = 1;
      const rebuilt = store.rebuildProactiveMotiveAuthorityInternal({ envelope: input }).annotationSnapshot;
      const turn = createCanonicalFromEnvelope(store, input, {
        annotationSnapshot: {
          ...rebuilt,
          trustedSibling: { checksum: 'trusted', value: 'preserve' }
        }
      });
      assert.equal(turn.protocolVersion, 3);
      assert.equal(turn.rolloutKey, 'PROACTIVE_CHAT');
      assert.equal(typeof turn.annotationSnapshot.proactiveMotiveAuthority.candidates[0].motiveId, 'string');
      commitCanonical(store, turn, 913);
      const groupId = store.getTurnAuthorityLineage(turn.authorityLineageKey).committedGroupId;
      assert.equal(store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }).status, 'live');
      const original = JSON.parse(store.db.prepare(
        'SELECT annotation_snapshot_json FROM turns WHERE turn_id = ?'
      ).get(turn.turnId).annotation_snapshot_json);
      const cases = [
        ['consideredAt', authority => ({ ...authority, consideredAt: authority.consideredAt + 1 })],
        ['expired', authority => ({
          ...authority,
          candidates: authority.candidates.map(candidate => ({
            ...candidate,
            expiresAt: authority.consideredAt
          }))
        })],
        ['life source revision', authority => ({
          ...authority,
          candidates: authority.candidates.map(candidate => candidate.sourceType === 'current_life_episode'
            ? { ...candidate, sourceRevision: 0 }
            : candidate)
        })],
        ['structural refs', authority => ({
          ...authority,
          structuralSilence: { reasonCode: 'ACTIVE_PRIVATE_CHAT_CONSTRAINT', constraintRefs: [] }
        })]
      ];
      for (const [label, mutate] of cases) {
        const authority = mutate(original.proactiveMotiveAuthority);
        authority.checksum = contentHash({
          version: authority.version,
          consideredAt: authority.consideredAt,
          candidates: authority.candidates,
          structuralSilence: authority.structuralSilence
        });
        const annotation = { ...original, proactiveMotiveAuthority: authority };
        store.db.prepare('UPDATE turns SET annotation_snapshot_json = ? WHERE turn_id = ?')
          .run(JSON.stringify(annotation), turn.turnId);
        assert.throws(
          () => store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }),
          /canonical visible group authority conflict|proactive motive authority conflict/,
          label
        );
        store.db.prepare('UPDATE turns SET annotation_snapshot_json = ? WHERE turn_id = ?')
          .run(JSON.stringify(original), turn.turnId);
      }
    } finally {
      store.close();
    }
  });
});

test('redacted proactive groups do not make fresh motive scans read tombstone semantics', () => {
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { kind: 'PROACTIVE_CHAT', rich: false });
    const store = new YuqiStore(fixture.path);
    try {
      assert.deepEqual(store.listConsumedProactiveMotiveIdsInternal({ roleId: 'yuqi' }), []);
    } finally {
      store.close();
    }
  });
});

test('canonical state patch persists rich schema-v2 open thread projection and reopens it', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    const input = envelope(902);
    input.protocolVersion = 3;
    input.context = {
      currentBatch: {
        batchId: 'batch_v3_902',
        messageIds: [input.message.messageId],
        startedAt: input.message.sentAt,
        committedAt: input.createdAt,
        messages: [input.message]
      },
      visibilityCursor: {
        nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
        uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0,
        localSequence: 1, clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0,
        chatOpen: true, quotedMessageId: null
      }
    };
    input.authority = {
      algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat',
      rootSourceId: input.message.messageId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: input.message.messageId
      }),
      claimedLineageRevision: 1, retryOfTurnId: null
    };
    ensureRollout(store, 'DIRECT_REPLY');
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: input.message.sentAt });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: input,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: input.context.currentBatch.batchId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    commitCanonical(store, turn, 902);
    const state = store.getCognitiveState('yuqi');
    assert.equal(state.schemaVersion, 2);
    assert.deepEqual(state.state.fastState.openThreadIds, ['thread_v12_902']);
    assert.deepEqual(state.state.fastState.openThreads, [{
      threadId: 'thread_v12_902',
      summary: 'thread_v12_902',
      sourceTurnId: turn.turnId,
      lastTouchedAt: 9_902
    }]);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.deepEqual(reopened.getCognitiveState('yuqi').state.fastState.openThreads, [{
        threadId: 'thread_v12_902',
        summary: 'thread_v12_902',
        sourceTurnId: turn.turnId,
        lastTouchedAt: 9_902
      }]);
    } finally {
      reopened.close();
    }
  });
});

test('wire-v2 state update removes prior v3 rich thread evidence instead of leaving stale motives', () => {
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      const input = envelope(903);
      input.protocolVersion = 3;
      input.context = {
        currentBatch: {
          batchId: 'batch_v3_903', messageIds: [input.message.messageId],
          startedAt: input.message.sentAt, committedAt: input.createdAt, messages: [input.message]
        },
        visibilityCursor: {
          nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0,
          uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0,
          localSequence: 1, clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0,
          chatOpen: true, quotedMessageId: null
        }
      };
      input.authority = {
        algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat',
        rootSourceId: input.message.messageId,
        lineageKey: deriveAuthorityLineageKey({
          roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: input.message.messageId
        }),
        claimedLineageRevision: 1, retryOfTurnId: null
      };
      ensureRollout(store, 'DIRECT_REPLY');
      const rollout = store.getCognitionRollout('DIRECT_REPLY');
      const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: input.message.sentAt });
      const v3Turn = store.createCanonicalVisibleTurnInternal({
        envelope: input, rolloutKey: 'DIRECT_REPLY', expectedRolloutRevision: rollout.revision,
        authoritativeReleaseId: rollout.stableReleaseId, comparisonReleaseId: null,
        comparisonDirection: null, laneKey: 'private_chat', expectedLaneRevision: 0,
        inputUserBatchId: input.context.currentBatch.batchId, inputVisibilitySequence: 1,
        inputClearEpoch: 0, agencySnapshotChecksum: agency.checksum, annotationSnapshot: {}
      }).turn;
      commitCanonical(store, v3Turn, 903);

      const v2Turn = createCanonical(store, 904);
      commitCanonical(store, v2Turn, 904);
      const state = store.getCognitiveState('yuqi');
      assert.deepEqual(state.state.fastState.openThreadIds, ['thread_v12_904']);
      assert.equal(Object.hasOwn(state.state.fastState, 'openThreads'), false);
      assert.deepEqual(buildProactiveMotiveAuthority({
        consideredAt: 9_904,
        lifeContext: { current: null, recent: [], upcoming: [] },
        cognitiveState: state
      }).candidates, []);
    } finally {
      store.close();
    }
  });
});

function buildLiveV12Database(path, { groups = 0, statePatches = 0 } = {}) {
  const store = new YuqiStore(path, { targetVersion: 12 });
  try {
    assert.equal(store.userVersion(), 12);
    ensureDirectRollout(store);
    for (let index = 1; index <= groups; index += 1) {
      const turn = createCanonical(store, index);
      if (index <= statePatches) commitCanonical(store, turn, index);
    }
  } finally {
    store.close();
  }
  return path;
}

function withAuthorityV13(run) {
  return withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureCanonicalRollouts(store);
      return run(store);
    } finally {
      store.close();
    }
  });
}

function openWithV13MigrationFault(path, step) {
  const store = new YuqiStore(path, {
    expectedSourceVersion: 12,
    v13MigrationFaultStep: step
  });
  store.close();
}

test('canonical visible commit snapshots only its persisted device recovery acknowledgement', () =>
  withAuthorityV13(store => {
    const turn = createCanonical(store, 9_901);
    store.ackSync('phone', 12);
    store.ackSync('foreign_device', 99);
    store.ackSync('phone', 42);

    const receipt = commitCanonical(store, turn, 9_901);
    const delivery = store.db.prepare(`
      SELECT peer_id, recovery_ack_seq
      FROM cloud_deliveries
      WHERE authority_group_id = ?
    `).get(receipt.visibleGroupId);
    assert.equal(delivery.peer_id, 'phone');
    assert.equal(delivery.recovery_ack_seq, 42);

    store.ackSync('phone', 88);
    const frozen = store.db.prepare(`
      SELECT recovery_ack_seq
      FROM cloud_deliveries
      WHERE authority_group_id = ?
    `).get(receipt.visibleGroupId);
    assert.equal(frozen.recovery_ack_seq, 42);
  }));

test('canonical visible commit rolls back its recovery acknowledgement delivery at fault step 9', () =>
  withAuthorityV13(store => {
    const turn = createCanonical(store, 9_902);
    store.ackSync('phone', 42);
    store.commitFaultAfterStep = 9;
    try {
      assert.throws(() => commitCanonical(store, turn, 9_902), /commit fault after step 9/);
    } finally {
      store.commitFaultAfterStep = undefined;
    }

    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value
      FROM visible_result_groups
      WHERE lineage_key = ?
    `).get(turn.authorityLineageKey).value, 0);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value
      FROM cloud_deliveries
      WHERE turn_id = ? AND authority_group_id IS NOT NULL
    `).get(turn.turnId).value, 0);
  }));

test('fresh and populated v12 migrate atomically to exact v13 tombstone schema', () =>
  withTempPath(path => {
    buildLiveV12Database(path, { groups: 2, statePatches: 2 });
    const before = snapshotDatabase(path);
    const store = new YuqiStore(path);
    try {
      assert.equal(store.userVersion(), 14);
      assert.deepEqual(columns(store, 'visible_result_items'), [
        'group_id', 'ordinal', 'message_id', 'item_json', 'item_checksum', 'redacted_at'
      ]);
      assert.deepEqual(columns(store, 'visible_result_actions'), [
        'group_id', 'ordinal', 'action_id', 'action_kind', 'target_key',
        'target_revision', 'action_json', 'action_checksum', 'redacted_at'
      ]);
      assert.deepEqual(columns(store, 'current_user_batch_items'), [
        'turn_id', 'batch_id', 'message_id', 'sequence',
        'message_json', 'checksum', 'redacted_at'
      ]);
      assert.equal(columns(store, 'turns').includes('authority_redacted_at'), true);
      assert.equal(columns(store, 'turns').includes('input_clear_epoch'), true);
      assert.equal(columns(store, 'turn_authority_lineages').includes('redacted_at'), true);
      assert.deepEqual(columns(store, 'turn_authority_lineages').slice(-3), [
        'redacted_at', 'attempt_count', 'attempt_commitment'
      ]);
      assert.deepEqual(columns(store, 'current_user_batches').slice(-2), [
        'item_count', 'tombstone_commitment'
      ]);
      assert.deepEqual(columns(store, 'visible_result_groups').slice(-5), [
        'item_count', 'action_count', 'tombstone_commitment',
        'redaction_delivery_count', 'redaction_delivery_commitment'
      ]);
      assert.equal(columns(store, 'cloud_deliveries').includes('relay_message_id'), true);
      assert.equal(columns(store, 'cloud_deliveries').includes('redaction_requested_at'), true);
      assert.equal(columns(store, 'cloud_deliveries')
        .includes('redaction_acknowledged_at'), true);
      assert.equal(columns(store, 'interaction_lanes').includes('clear_epoch'), true);
      assert.equal(columns(store, 'interaction_lanes')
        .includes('cleared_through_sequence'), true);
      assert.deepEqual(columns(store, 'conversation_clear_controls'), [
        'control_id', 'role_id', 'clear_epoch', 'cleared_through_sequence',
        'requested_at', 'applied_at', 'checksum'
      ]);
      assert.equal(
        store.visibleAuthorityV13InvariantSummary().canonicalTurnCount,
        before.canonicalTurnCount
      );
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('v12 to v13 migration anchors every live parent with count and tombstone commitments',
  () => withTempPath(path => {
    buildLiveV12Database(path, { groups: 1, statePatches: 1 });
    const store = new YuqiStore(path);
    try {
      const [lineage] = rows(store, 'turn_authority_lineages');
      const [batch] = rows(store, 'current_user_batches');
      const [group] = rows(store, 'visible_result_groups');
      assert.equal(Number(lineage.attempt_count), 1);
      assert.match(String(lineage.attempt_commitment), /^[a-f0-9]{64}$/);
      assert.equal(Number(batch.item_count), 1);
      assert.match(String(batch.tombstone_commitment), /^[a-f0-9]{64}$/);
      assert.equal(Number(group.item_count), 1);
      assert.equal(Number(group.action_count), 0);
      assert.match(String(group.tombstone_commitment), /^[a-f0-9]{64}$/);
      assert.equal(group.redaction_delivery_count, null);
      assert.equal(group.redaction_delivery_commitment, null);
    } finally {
      store.close();
    }
  }));

test('migrated v1 receipt replays unchanged while fresh v13 commit uses v2',
  () => withTempPath(path => {
    buildLiveV12Database(path, { groups: 1, statePatches: 1 });
    const store = new YuqiStore(path);
    try {
      const historical = store.db.prepare(
        'SELECT * FROM visible_commit_receipts LIMIT 1'
      ).get();
      assert.equal(historical.commit_payload_version, 'pc-visible-commit-v1');
      const replay = store.readCanonicalCommitOutcomeInternal({
        lineageKey: historical.lineage_key,
        expectedTurnId: historical.authoritative_turn_id
      });
      assert.equal(replay.status, 'already_committed');
      assert.equal(replay.receipt.commitPayloadVersion, 'pc-visible-commit-v1');
      const fresh = commitCanonical(store, createCanonical(store, 2), 2);
      assert.equal(fresh.commitPayloadVersion, 'pc-visible-commit-v2');
      assert.equal(store.getTurn(fresh.authoritativeTurnId).inputClearEpoch, 0);
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('raw v12 redaction marker refuses v13 migration without mutation', () =>
  withTempPath(path => {
    buildLiveV12Database(path, { groups: 1, statePatches: 1 });
    const database = raw(path);
    try {
      database.prepare('UPDATE visible_result_groups SET redacted_at = 3000').run();
    } finally {
      database.close();
    }
    const before = snapshotDatabase(path);
    assert.throws(
      () => new YuqiStore(path),
      /v13 migration rejects v12 redacted source/
    );
    assert.deepEqual(snapshotDatabase(path), before);
  }));

for (const [name, sql, value] of [
  ['null rollout key', 'UPDATE turns SET rollout_key = NULL WHERE result_authority_version = 1', null],
  ['unknown rollout key', 'UPDATE turns SET rollout_key = ? WHERE result_authority_version = 1', 'UNSUPPORTED_KIND'],
  ['mismatched rollout key', 'UPDATE turns SET rollout_key = ? WHERE result_authority_version = 1', 'PROACTIVE_CHAT']
]) {
  test(`v12 migration refuses canonical ${name} without mutation`, () => withTempPath(path => {
    buildLiveV12Database(path, { groups: 1, statePatches: 1 });
    const database = raw(path);
    try {
      value === null ? database.prepare(sql).run() : database.prepare(sql).run(value);
    } finally {
      database.close();
    }
    const before = snapshotDatabase(path);
    assert.throws(
      () => new YuqiStore(path),
      /v13 migration canonical turn kind anchor conflict/
    );
    assert.deepEqual(snapshotDatabase(path), before);
  }));
}

test('every v13 migration fault rolls back to the exact v12 logical snapshot', () => {
  for (const step of V13_MIGRATION_FAULT_STEPS) {
    withTempPath(path => {
      buildLiveV12Database(path, { groups: 1, statePatches: 1 });
      const before = snapshotDatabase(path);
      assert.throws(
        () => openWithV13MigrationFault(path, step),
        /forced v13 migration fault/
      );
      assert.deepEqual(snapshotDatabase(path), before);
    });
  }
});

test('two sequential state patches keep both manifests valid and only latest owns current state',
  () => withAuthorityV13(store => {
    const first = commitCanonical(store, createCanonical(store, 1), 1);
    const second = commitCanonical(store, createCanonical(store, 2), 2);
    assert.equal(
      store.getCognitiveState('yuqi').lastAuthorityGroupId,
      second.visibleGroupId
    );
    assert.equal(store.assertVisibleGroupAuthorityInternal(first.visibleGroupId, {
      purpose: 'reopen'
    }).status, 'live');
    assert.equal(store.assertVisibleGroupAuthorityInternal(second.visibleGroupId, {
      purpose: 'reopen'
    }).status, 'live');
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
    const path = store.filename;
    store.close();
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('delivery validates one group without invoking the whole database invariant',
  () => withAuthorityV13(store => {
    const receipt = commitCanonical(store, createCanonical(store, 1), 1);
    let globalCalls = 0;
    let scopedCalls = 0;
    const full = store.assertVisibleAuthorityV13Invariants.bind(store);
    const scoped = store.assertVisibleGroupAuthorityInternal.bind(store);
    store.assertVisibleAuthorityV13Invariants = (...args) => {
      globalCalls += 1;
      return full(...args);
    };
    store.assertVisibleGroupAuthorityInternal = (...args) => {
      scopedCalls += 1;
      return scoped(...args);
    };
    for (let index = 0; index < 50; index += 1) {
      store.visibleDeliveryPayload(receipt.visibleGroupId, 'phone');
    }
    assert.equal(globalCalls, 0);
    assert.equal(scopedCalls, 50);
  }));

function assertScopedAndRestartReject(path, groupId, mutate) {
  const store = new YuqiStore(path);
  try {
    mutate(store.db);
    assert.throws(
      () => store.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'reopen' }),
      /authority conflict|commitment sequence conflict/
    );
  } finally {
    store.close();
  }
  assert.throws(() => new YuqiStore(path), /invariant|authority conflict|commitment sequence conflict/);
}

for (const [name, mutate] of [
  ['item semantic mutation', database => database.prepare(`
    UPDATE visible_result_items SET item_json = '{"content":"篡改"}'
  `).run()],
  ['item deletion', database => database.prepare('DELETE FROM visible_result_items').run()],
  ['action semantic mutation', database => database.prepare(`
    UPDATE visible_result_actions SET action_json = '{"text":"篡改"}'
  `).run()],
  ['action deletion', database => database.prepare('DELETE FROM visible_result_actions').run()],
  ['message mutation', database => database.prepare(`
    UPDATE messages SET content = '篡改' WHERE authority_group_id IS NOT NULL
  `).run()],
  ['job ownership mismatch', database => database.prepare(`
    UPDATE consolidation_jobs SET role_id = 'foreign'
    WHERE authority_group_id IS NOT NULL
  `).run()],
  ['stance ownership mismatch', database => database.prepare(`
    UPDATE stance_records SET role_id = 'foreign'
    WHERE authority_group_id IS NOT NULL
  `).run()],
  ['receipt origin mismatch', database => database.prepare(`
    UPDATE visible_commit_receipts SET authority_origin = 'android_fallback'
  `).run()],
  ['receipt version mismatch', database => database.prepare(`
    UPDATE visible_commit_receipts SET commit_payload_version = 'android-fallback-commit-v1'
  `).run()],
  ['receipt checksum mismatch', database => database.prepare(`
    UPDATE visible_commit_receipts SET commit_checksum = ?
  `).run('f'.repeat(64))],
  ['manifest deletion', database => database.prepare(
    'DELETE FROM visible_result_manifests'
  ).run()],
  ['delivery checksum mismatch', database => database.prepare(`
    UPDATE cloud_deliveries SET authority_commit_checksum = ?
    WHERE authority_group_id IS NOT NULL
  `).run('f'.repeat(64))],
  ['current-batch content corruption', database => database.prepare(`
    UPDATE current_user_batch_items SET message_json = '{"content":"篡改"}'
  `).run()],
  ['current-batch order corruption', database => database.prepare(`
    UPDATE current_user_batch_items SET sequence = sequence + 1
  `).run()],
  ['current-batch checksum corruption', database => database.prepare(`
    UPDATE current_user_batches SET checksum = ?
  `).run('f'.repeat(64))]
]) {
  test(`scoped and restart validation reject ${name}`, () => withTempPath(path => {
    const seed = new YuqiStore(path);
    ensureDirectRollout(seed);
    const receipt = commitCanonical(seed, createCanonical(seed, 1), 1, { rich: true });
    seed.close();
    assertScopedAndRestartReject(path, receipt.visibleGroupId, mutate);
  }));
}

test('scoped and restart validation reject current state pointing to a historical group',
  () => withTempPath(path => {
    const seed = new YuqiStore(path);
    ensureDirectRollout(seed);
    const first = commitCanonical(seed, createCanonical(seed, 1), 1);
    const second = commitCanonical(seed, createCanonical(seed, 2), 2);
    seed.close();
    assertScopedAndRestartReject(path, first.visibleGroupId, database => database.prepare(`
      UPDATE cognitive_states
      SET last_authority_group_id = ?, last_turn_id = ?
      WHERE role_id = 'yuqi'
    `).run(first.visibleGroupId, second.authoritativeTurnId));
  }));

function buildRedactedV13Fixture(path, {
  rich = true,
  kind = 'DIRECT_REPLY',
  items = undefined,
  actionSet = undefined,
  annotationSnapshot = null,
  matrix = false
} = {}) {
  const store = new YuqiStore(path);
  ensureRollout(store, kind);
  let turn = matrix
    ? createCanonicalFromEnvelope(store, threeBubbleEnvelope(1))
    : createCanonical(store, 1, kind);
  const attemptTurnIds = [turn.turnId];
  if (matrix) {
    turn = createCanonicalRetry(store, turn, 1);
    attemptTurnIds.push(turn.turnId);
    turn = createCanonicalRetry(store, turn, 2);
    attemptTurnIds.push(turn.turnId);
    items = [0, 1, 2].map(index => ({
      content: `矩阵回复${index + 1}`,
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user'
    }));
    actionSet = [0, 1].map(index => {
      const draft = { kind: 'moment_create', payload: { text: `矩阵动态${index + 1}` } };
      const target = store.resolveCanonicalActionTargetInternal({ turn, action: draft });
      return { ...draft, targetKey: target.targetKey, targetRevision: target.targetRevision };
    });
    rich = false;
  }
  const receipt = commitCanonical(store, turn, 1, { rich, items, actionSet });
  const groupId = receipt.visibleGroupId;
  const turnId = receipt.authoritativeTurnId;
  const lineageKey = receipt.authorityLineageKey;
  const expectedRolloutKey = store.getTurn(turnId).rolloutKey;
  const expectedAttemptCommitment = store.db.prepare(`
    SELECT attempt_commitment FROM turn_authority_lineages WHERE lineage_key = ?
  `).get(lineageKey).attempt_commitment;
  const redactedAt = 50_000;
  if (annotationSnapshot) {
    store.db.prepare('UPDATE turns SET annotation_snapshot_json = ? WHERE turn_id = ?')
      .run(JSON.stringify(annotationSnapshot), turnId);
  }
  store.db.exec('BEGIN IMMEDIATE');
  try {
    const lineage = store.db.prepare(`
      SELECT lineage_key FROM visible_result_groups WHERE group_id = ?
    `).get(groupId).lineage_key;
    if (matrix) {
      const delivery = store.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE authority_group_id = ?
      `).get(groupId);
      store.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', relay_message_id = 'relay_phone_confirmed',
            payload_json = '{}', checksum = ?, delivered_at = ?, confirmed_at = ?
        WHERE authority_group_id = ? AND peer_id = 'phone'
      `).run(delivery.authority_commit_checksum, redactedAt - 20, redactedAt - 10, groupId);
      store.db.prepare(`
        INSERT INTO cloud_deliveries(
          turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
          attempts, created_at, updated_at, delivered_at, confirmed_at,
          authority_group_id, authority_commit_checksum, relay_message_id
        ) VALUES (?, 'tablet', 0, 'mailboxed', '{}', ?, 1, ?, ?, ?, NULL, ?, ?, 'relay_tablet_mailboxed')
      `).run(
        turnId, delivery.authority_commit_checksum, redactedAt - 30, redactedAt - 20,
        redactedAt - 20, groupId, delivery.authority_commit_checksum
      );
    }
    const frozenDeliveries = store.db.prepare(`
      SELECT peer_id, recovery_ack_seq, relay_message_id, authority_commit_checksum
      FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id
    `).all(groupId);
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = CASE
            WHEN relay_message_id IS NULL THEN 'redacted'
            ELSE 'redaction_pending'
          END,
          payload_json = NULL,
          checksum = NULL,
          redaction_requested_at = CASE
            WHEN relay_message_id IS NULL THEN NULL
            ELSE ?
          END,
          redaction_acknowledged_at = CASE
            WHEN relay_message_id IS NULL THEN ?
            ELSE NULL
          END
      WHERE authority_group_id = ?
    `).run(redactedAt, redactedAt, groupId);
    const deliveryCommitment = contentHash({
      version: 'authority-redaction-deliveries-v1',
      groupId,
      deliveryCount: frozenDeliveries.length,
      deliveries: frozenDeliveries.map(row => ({
        peerId: row.peer_id,
        recoveryAckSeq: Number(row.recovery_ack_seq),
        relayMessageId: row.relay_message_id == null ? null : row.relay_message_id,
        authorityCommitChecksum: row.authority_commit_checksum
      }))
    });
    store.db.prepare(
      'DELETE FROM consolidation_jobs WHERE authority_group_id = ?'
    ).run(groupId);
    store.db.prepare(
      'DELETE FROM stance_records WHERE authority_group_id = ?'
    ).run(groupId);
    store.db.prepare(
      'DELETE FROM cognitive_states WHERE last_authority_group_id = ?'
    ).run(groupId);
    store.db.prepare(`
      UPDATE interaction_lanes
      SET latest_authoritative_group_id = NULL,
          native_completed_group_id = NULL,
          ui_applied_group_id = NULL,
          last_commit_checksum = NULL
      WHERE latest_authoritative_group_id = ?
         OR native_completed_group_id = ?
         OR ui_applied_group_id = ?
    `).run(groupId, groupId, groupId);
    store.db.prepare(`
      UPDATE turns
      SET envelope_json = '{"redacted":true}',
          memory_packet_json = NULL,
          brain_draft_json = NULL,
          supervisor_json = NULL,
          reply_json = NULL,
          error_json = NULL,
          route_reasons_json = '[]',
          annotation_snapshot_json = '{}',
          authority_redacted_at = ?
      WHERE authority_lineage_key = ?
    `).run(redactedAt, lineage);
    store.db.prepare(`
      UPDATE current_user_batch_items
      SET message_json = NULL, redacted_at = ?
      WHERE turn_id IN (
        SELECT turn_id FROM turns WHERE authority_lineage_key = ?
      )
    `).run(redactedAt, lineage);
    store.db.prepare(`
      UPDATE messages SET content = ''
      WHERE turn_id IN (
        SELECT turn_id FROM turns WHERE authority_lineage_key = ?
      ) OR authority_group_id = ?
    `).run(lineage, groupId);
    store.db.prepare(`
      DELETE FROM annotations
      WHERE turn_id IN (
        SELECT turn_id FROM turns WHERE authority_lineage_key = ?
      )
    `).run(lineage);
    store.db.prepare(`
      DELETE FROM diagnostics
      WHERE turn_id IN (
        SELECT turn_id FROM turns WHERE authority_lineage_key = ?
      )
    `).run(lineage);
    store.db.prepare(`
      DELETE FROM sync_log
      WHERE entity_id IN (
        SELECT turn_id FROM turns WHERE authority_lineage_key = ?
      ) OR entity_id IN (
        SELECT message_id FROM messages
        WHERE turn_id IN (
          SELECT turn_id FROM turns WHERE authority_lineage_key = ?
        ) OR authority_group_id = ?
      )
    `).run(lineage, lineage, groupId);
    store.db.prepare('DELETE FROM sessions WHERE role = ?').run('yuqi');
    store.db.prepare(`
      UPDATE visible_result_items
      SET item_json = NULL, redacted_at = ?
      WHERE group_id = ?
    `).run(redactedAt, groupId);
    store.db.prepare(`
      UPDATE visible_result_actions
      SET action_kind = NULL, target_key = NULL, target_revision = NULL,
          action_json = NULL, redacted_at = ?
      WHERE group_id = ?
    `).run(redactedAt, groupId);
    store.db.prepare(`
      UPDATE visible_result_manifests
      SET semantic_json = NULL, redacted_at = ?
      WHERE group_id = ?
    `).run(redactedAt, groupId);
    store.db.prepare(`
      UPDATE visible_result_groups
      SET redacted_at = ?, redaction_delivery_count = ?, redaction_delivery_commitment = ?
      WHERE group_id = ?
    `).run(redactedAt, frozenDeliveries.length, deliveryCommitment, groupId);
    store.db.prepare(`
      UPDATE turn_authority_lineages SET redacted_at = ? WHERE lineage_key = ?
    `).run(redactedAt, lineage);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  } finally {
    store.close();
  }
  return {
    path, groupId, turnId, lineageKey, redactedAt,
    expectedRolloutKey, expectedAttemptCommitment, attemptTurnIds
  };
}

function buildLiveV13MatrixFixture(path) {
  const store = new YuqiStore(path);
  let turn = createCanonicalFromEnvelope(store, threeBubbleEnvelope(41));
  const attemptTurnIds = [turn.turnId];
  turn = createCanonicalRetry(store, turn, 411);
  attemptTurnIds.push(turn.turnId);
  turn = createCanonicalRetry(store, turn, 412);
  attemptTurnIds.push(turn.turnId);
  const items = [0, 1, 2].map(index => ({
    content: `活跃矩阵回复${index + 1}`,
    speakerId: 'yuqi',
    speakerType: 'character',
    recipientId: 'user'
  }));
  const actionSet = [0, 1].map(index => {
    const draft = { kind: 'moment_create', payload: { text: `活跃矩阵动态${index + 1}` } };
    const target = store.resolveCanonicalActionTargetInternal({ turn, action: draft });
    return { ...draft, targetKey: target.targetKey, targetRevision: target.targetRevision };
  });
  const receipt = commitCanonical(store, turn, 41, { items, actionSet });
  store.close();
  return {
    path,
    groupId: receipt.visibleGroupId,
    turnId: receipt.authoritativeTurnId,
    lineageKey: receipt.authorityLineageKey,
    attemptTurnIds
  };
}

function convertRedactedFixtureToCancelled(store, fixture) {
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id = ?')
      .run(fixture.groupId);
    store.db.prepare('DELETE FROM visible_result_manifests WHERE group_id = ?')
      .run(fixture.groupId);
    store.db.prepare('DELETE FROM visible_result_actions WHERE group_id = ?')
      .run(fixture.groupId);
    store.db.prepare('DELETE FROM visible_result_items WHERE group_id = ?')
      .run(fixture.groupId);
    store.db.prepare('DELETE FROM messages WHERE authority_group_id = ?')
      .run(fixture.groupId);
    store.db.prepare('DELETE FROM visible_commit_receipts WHERE lineage_key = ?')
      .run(fixture.lineageKey);
    store.db.prepare('DELETE FROM visible_result_groups WHERE group_id = ?')
      .run(fixture.groupId);
    store.db.prepare(`UPDATE turns SET state = 'cancelled', generation_fingerprint = NULL
      WHERE authority_lineage_key = ?`).run(fixture.lineageKey);
    store.db.prepare(`UPDATE turn_authority_lineages
      SET state = 'cancelled', committed_group_id = NULL WHERE lineage_key = ?`)
      .run(fixture.lineageKey);
    store.db.exec('COMMIT');
  } catch (error) {
    store.db.exec('ROLLBACK');
    throw error;
  }
}

function insertAuthorityRedactionAudit(store, {
  entityId, groupId, redactedAt, reasonCode = 'user_clear',
  createdAt = redactedAt, payloadOverrides = {}
}) {
  const payload = {
    groupId,
    reasonCode,
    redactedAt,
    ...payloadOverrides
  };
  store.db.prepare(`
    INSERT INTO sync_log(
      entity_type, entity_id, operation, payload_json, checksum, created_at
    ) VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)
  `).run(
    entityId, JSON.stringify(payload), contentHash(payload), createdAt
  );
  return payload;
}

test('a complete v13 redacted audit shell is restart-valid and non-deliverable',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const turn = rows(store, 'turns').find(row => row.turn_id === fixture.turnId);
      const lineage = rows(store, 'turn_authority_lineages')
        .find(row => row.lineage_key === fixture.lineageKey);
      assert.equal(turn.rollout_key, fixture.expectedRolloutKey);
      assert.equal(JSON.parse(turn.envelope_json).kind, undefined);
      assert.equal(lineage.attempt_commitment, fixture.expectedAttemptCommitment);
      const outcome = store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      });
      assert.equal(outcome.status, 'redacted');
      assert.equal(outcome.terminalDisposition, 'visible');
      assert.equal(outcome.group.itemCount, 1);
      const bridgeResult = store.loadCanonicalBridgeResultInternal(fixture.turnId);
      assert.deepEqual(Object.keys(bridgeResult).sort(), [
        'authorityLineageKey', 'commitChecksum', 'deliverable',
        'status', 'turnId', 'visibleGroupId'
      ].sort());
      assert.equal(bridgeResult.status, 'redacted');
      assert.equal(bridgeResult.deliverable, false);
      assert.equal(bridgeResult.turnId, fixture.turnId);
      assert.equal(bridgeResult.visibleGroupId, fixture.groupId);
      assert.throws(
        () => store.visibleDeliveryPayload(fixture.groupId, 'phone'),
        /redacted/
      );
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('redacted matrix fixture retains three bubbles, three attempts, two actions and two deliveries',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { matrix: true });
    const store = new YuqiStore(path);
    try {
      assert.equal(fixture.attemptTurnIds.length, 3);
      assert.equal(store.db.prepare(`
        SELECT COUNT(*) AS value FROM current_user_batch_items
        WHERE turn_id IN (
          SELECT turn_id FROM turns WHERE authority_lineage_key = ?
        )
      `).get(fixture.lineageKey).value, 9);
      assert.equal(store.db.prepare(
        'SELECT COUNT(*) AS value FROM visible_result_items WHERE group_id = ?'
      ).get(fixture.groupId).value, 3);
      assert.equal(store.db.prepare(
        'SELECT COUNT(*) AS value FROM visible_result_actions WHERE group_id = ?'
      ).get(fixture.groupId).value, 2);
      assert.equal(store.db.prepare(
        'SELECT COUNT(*) AS value FROM cloud_deliveries WHERE authority_group_id = ?'
      ).get(fixture.groupId).value, 2);
      const deliveries = store.db.prepare(`
        SELECT peer_id, state, relay_message_id, redaction_requested_at,
               redaction_acknowledged_at
        FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id
      `).all(fixture.groupId).map(row => ({ ...row }));
      assert.deepEqual(deliveries, [
        {
          peer_id: 'phone',
          state: 'redaction_pending',
          relay_message_id: 'relay_phone_confirmed',
          redaction_requested_at: fixture.redactedAt,
          redaction_acknowledged_at: null
        },
        {
          peer_id: 'tablet',
          state: 'redaction_pending',
          relay_message_id: 'relay_tablet_mailboxed',
          redaction_requested_at: fixture.redactedAt,
          redaction_acknowledged_at: null
        }
      ]);
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

function assertRedactedMatrixReject(
  mutate,
  expected = /redacted authority|canonical visible|v1[13] invariant/
) {
  return withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { matrix: true });
    const store = new YuqiStore(path);
    try {
      store.db.exec('PRAGMA foreign_keys = OFF');
      mutate(store, fixture);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }), expected);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), expected);
  });
}

function assertLiveMatrixReject(
  mutate,
  expected = /message|projection|canonical visible|v1[13] invariant/i
) {
  return withTempPath(path => {
    const fixture = buildLiveV13MatrixFixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.exec('PRAGMA foreign_keys = OFF');
      mutate(store, fixture);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }), expected);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), expected);
  });
}

for (const [name, mutate] of [
  ['visible item tail deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_items WHERE group_id = ? AND ordinal = 2'
  ).run(fixture.groupId)],
  ['visible item middle deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_items WHERE group_id = ? AND ordinal = 1'
  ).run(fixture.groupId)],
  ['all visible items deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_items WHERE group_id = ?'
  ).run(fixture.groupId)],
  ['visible action tail deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_actions WHERE group_id = ? AND ordinal = 1'
  ).run(fixture.groupId)],
  ['visible action middle deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_actions WHERE group_id = ? AND ordinal = 0'
  ).run(fixture.groupId)],
  ['all visible actions deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM visible_result_actions WHERE group_id = ?'
  ).run(fixture.groupId)],
  ['batch bubble tail deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM current_user_batch_items WHERE turn_id = ? AND sequence = 2'
  ).run(fixture.attemptTurnIds[0])],
  ['batch bubble middle deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM current_user_batch_items WHERE turn_id = ? AND sequence = 1'
  ).run(fixture.attemptTurnIds[0])],
  ['all batch bubbles deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM current_user_batch_items WHERE turn_id = ?'
  ).run(fixture.attemptTurnIds[0])],
  ['batch parent deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM current_user_batches WHERE turn_id = ?'
  ).run(fixture.attemptTurnIds[0])],
  ['original attempt deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM turns WHERE turn_id = ?'
  ).run(fixture.attemptTurnIds[0])],
  ['middle retry attempt deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM turns WHERE turn_id = ?'
  ).run(fixture.attemptTurnIds[1])],
  ['user message deletion', (store) => store.db.prepare(
    `DELETE FROM messages WHERE message_id = (
      SELECT message_id FROM messages WHERE speaker_type = 'user' LIMIT 1
    )`
  ).run()],
  ['character message deletion', (store, fixture) => store.db.prepare(
    'DELETE FROM messages WHERE authority_group_id = ? AND group_ordinal = 1'
  ).run(fixture.groupId)],
  ['confirmed delivery deletion', (store, fixture) => store.db.prepare(
    "DELETE FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = 'phone'"
  ).run(fixture.groupId)],
  ['mailboxed delivery deletion', (store, fixture) => store.db.prepare(
    "DELETE FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = 'tablet'"
  ).run(fixture.groupId)],
  ['confirmed delivery relay identity change', (store, fixture) => store.db.prepare(
    "UPDATE cloud_deliveries SET relay_message_id = 'relay_phone_changed' WHERE authority_group_id = ? AND peer_id = 'phone'"
  ).run(fixture.groupId)],
  ['mailboxed delivery relay identity change', (store, fixture) => store.db.prepare(
    "UPDATE cloud_deliveries SET relay_message_id = 'relay_tablet_changed' WHERE authority_group_id = ? AND peer_id = 'tablet'"
  ).run(fixture.groupId)],
  ['pending delivery relay identity removal', (store, fixture) => store.db.prepare(
    "UPDATE cloud_deliveries SET relay_message_id = NULL WHERE authority_group_id = ? AND peer_id = 'phone'"
  ).run(fixture.groupId)],
  ['user projection attached to result group', (store, fixture) => store.db.prepare(`
    UPDATE messages SET authority_group_id = ?, group_ordinal = 99
    WHERE message_id = 'msg_v13_batch_1_1'
  `).run(fixture.groupId)],
  ['extra valid-shape character projection', (store, fixture) => {
    const projection = {
      messageId: 'msg_redacted_extra_character',
      content: '',
      recipientId: 'user'
    };
    store.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type,
        recipient_id, content, sent_at, origin, checksum, created_at,
        authority_group_id, group_ordinal
      ) VALUES (?, ?, 'yuqi', 'yuqi', 'character', 'user', '', 49999,
        'codex', ?, 49999, ?, 99)
    `).run(projection.messageId, fixture.turnId, contentHash(projection), fixture.groupId);
  }],
  ['user projection owner moved to retry', (store, fixture) => store.db.prepare(`
    UPDATE messages SET turn_id = ? WHERE message_id = 'msg_v13_batch_1_1'
  `).run(fixture.attemptTurnIds[1])],
  ['pending delivery with premature acknowledgement', (store, fixture) => store.db.prepare(`
    UPDATE cloud_deliveries SET redaction_acknowledged_at = redaction_requested_at
    WHERE authority_group_id = ? AND peer_id = 'phone'
  `).run(fixture.groupId)],
  ['remote redacted delivery with missing request', (store, fixture) => store.db.prepare(`
    UPDATE cloud_deliveries
    SET state = 'redacted', redaction_requested_at = NULL,
        redaction_acknowledged_at = ?
    WHERE authority_group_id = ? AND peer_id = 'phone'
  `).run(fixture.redactedAt + 1, fixture.groupId)],
  ['authority redaction secret on authoritative turn', (store, fixture) => {
    const payload = {
      groupId: fixture.groupId,
      redactedAt: fixture.redactedAt,
      reasonCode: 'user_clear',
      secret: 'leak'
    };
    store.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)
    `).run(
      fixture.turnId, JSON.stringify(payload), contentHash(payload), fixture.redactedAt
    );
  }]
]) {
  test(`redacted matrix rejects ${name} in scoped validation and restart`, () =>
    assertRedactedMatrixReject(mutate));
}

test('live v13 group rejects an extra valid-shape character projection in scoped validation and restart',
  () => assertLiveMatrixReject((store, fixture) => {
    const projection = {
      messageId: 'msg_live_extra_character',
      content: '额外投影',
      recipientId: 'user'
    };
    store.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type,
        recipient_id, content, sent_at, origin, checksum, created_at,
        authority_group_id, group_ordinal
      ) VALUES (?, ?, 'yuqi', 'yuqi', 'character', 'user', ?, 49999,
        'codex', ?, 49999, ?, 99)
    `).run(
      projection.messageId, fixture.turnId, projection.content,
      contentHash(projection), fixture.groupId
    );
  }));

test('live v13 group rejects forged middle user history in scoped validation and restart',
  () => assertLiveMatrixReject((store) => store.db.prepare(`
    UPDATE messages SET content = 'forged history'
    WHERE message_id = 'msg_v13_batch_41_1'
  `).run()));

test('never-enqueued redacted delivery requires its exact local acknowledgement time',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.prepare(`
        UPDATE cloud_deliveries
        SET redaction_acknowledged_at = redaction_acknowledged_at + 1
        WHERE authority_group_id = ? AND relay_message_id IS NULL
      `).run(fixture.groupId);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }), /redacted authority delivery.*conflict/i);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /redacted authority delivery.*conflict/i);
  }));

test('live multi-bubble retry message projections pass scoped validation and restart',
  () => withTempPath(path => {
    const fixture = buildLiveV13MatrixFixture(path);
    const store = new YuqiStore(path);
    try {
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'live');
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('remote redaction acknowledgement preserves relay and request authority',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { matrix: true });
    const store = new YuqiStore(path);
    try {
      store.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'redacted', redaction_acknowledged_at = ?
        WHERE authority_group_id = ? AND peer_id = 'phone'
      `).run(fixture.redactedAt + 1, fixture.groupId);
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('canonical authority redaction audit metadata is accepted without semantic leakage',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const payload = {
        groupId: fixture.groupId,
        reasonCode: 'user_clear',
        redactedAt: fixture.redactedAt
      };
      store.db.prepare(`
        INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
        VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)
      `).run(
        fixture.groupId, JSON.stringify(payload), contentHash(payload), fixture.redactedAt
      );
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('redacted committed group rejects an audit attached to its lineage in scoped and restart validation',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      insertAuthorityRedactionAudit(store, {
        entityId: fixture.lineageKey,
        groupId: null,
        redactedAt: fixture.redactedAt
      });
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(fixture.groupId),
        /authority redaction|sync audit/i
      );
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
  }));

test('redacted committed group rejects a retained lineage sync payload in scoped and restart validation',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const payload = { secret: 'retained lineage payload' };
      store.db.prepare(`
        INSERT INTO sync_log(
          entity_type, entity_id, operation, payload_json, checksum, created_at
        ) VALUES ('authority_lineage', ?, 'update', ?, ?, ?)
      `).run(
        fixture.lineageKey, JSON.stringify(payload), contentHash(payload),
        fixture.redactedAt
      );
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(fixture.groupId),
        /authority redaction|sync audit/i
      );
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
  }));

test('live committed authority rejects a premature redaction audit in scoped and restart validation',
  () => withTempPath(path => {
    const fixture = buildLiveV13MatrixFixture(path);
    const store = new YuqiStore(path);
    try {
      insertAuthorityRedactionAudit(store, {
        entityId: fixture.groupId,
        groupId: fixture.groupId,
        redactedAt: 50_000
      });
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(fixture.groupId),
        /authority redaction|sync audit/i
      );
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
  }));

test('v13 full authority rejects an orphan redaction audit before and after restart',
  () => withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      insertAuthorityRedactionAudit(store, {
        entityId: 'group_missing',
        groupId: 'group_missing',
        redactedAt: 50_000
      });
      assert.throws(
        () => store.assertVisibleAuthorityV13Invariants(),
        /authority redaction|sync audit/i
      );
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
  }));

for (const [name, insert] of [
  ['numeric reason code', (store, fixture) => insertAuthorityRedactionAudit(store, {
    entityId: fixture.groupId,
    groupId: fixture.groupId,
    redactedAt: fixture.redactedAt,
    reasonCode: 123
  })],
  ['string redaction time', (store, fixture) => insertAuthorityRedactionAudit(store, {
    entityId: fixture.groupId,
    groupId: fixture.groupId,
    redactedAt: String(fixture.redactedAt)
  })],
  ['mismatched created time', (store, fixture) => insertAuthorityRedactionAudit(store, {
    entityId: fixture.groupId,
    groupId: fixture.groupId,
    redactedAt: fixture.redactedAt,
    createdAt: fixture.redactedAt + 1
  })],
  ['overlong reason code', (store, fixture) => insertAuthorityRedactionAudit(store, {
    entityId: fixture.groupId,
    groupId: fixture.groupId,
    redactedAt: fixture.redactedAt,
    reasonCode: `a${'b'.repeat(64)}`
  })],
  ['duplicate audit rows', (store, fixture) => {
    insertAuthorityRedactionAudit(store, {
      entityId: fixture.groupId,
      groupId: fixture.groupId,
      redactedAt: fixture.redactedAt
    });
    insertAuthorityRedactionAudit(store, {
      entityId: fixture.groupId,
      groupId: fixture.groupId,
      redactedAt: fixture.redactedAt
    });
  }],
  ['entity and payload target mismatch', (store, fixture) =>
    insertAuthorityRedactionAudit(store, {
      entityId: fixture.groupId,
      groupId: 'group_other',
      redactedAt: fixture.redactedAt
    })]
]) {
  test(`redacted committed authority rejects ${name} in scoped and restart validation`,
    () => withTempPath(path => {
      const fixture = buildRedactedV13Fixture(path);
      const store = new YuqiStore(path);
      try {
        insert(store, fixture);
        assert.throws(
          () => store.assertVisibleGroupAuthorityInternal(fixture.groupId),
          /authority redaction|sync audit/i
        );
      } finally {
        store.close();
      }
      assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
    }));
}

test('cancelled redacted lineage accepts one strict canonical redaction audit',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      convertRedactedFixtureToCancelled(store, fixture);
      insertAuthorityRedactionAudit(store, {
        entityId: fixture.lineageKey,
        groupId: null,
        redactedAt: fixture.redactedAt
      });
      assert.equal(store.readCanonicalCommitOutcomeInternal({
        lineageKey: fixture.lineageKey
      }).status, 'redacted');
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

for (const [name, insert] of [
  ['non-null payload group', (store, fixture) =>
    insertAuthorityRedactionAudit(store, {
      entityId: fixture.lineageKey,
      groupId: fixture.groupId,
      redactedAt: fixture.redactedAt
    })],
  ['wrong audit target', (store, fixture) =>
    insertAuthorityRedactionAudit(store, {
      entityId: fixture.turnId,
      groupId: null,
      redactedAt: fixture.redactedAt
    })]
]) {
  test(`cancelled redacted lineage rejects ${name} in scoped outcome and restart`,
    () => withTempPath(path => {
      const fixture = buildRedactedV13Fixture(path);
      const store = new YuqiStore(path);
      try {
        convertRedactedFixtureToCancelled(store, fixture);
        insert(store, fixture);
        assert.throws(() => store.readCanonicalCommitOutcomeInternal({
          lineageKey: fixture.lineageKey
        }), /authority redaction|sync audit/i);
      } finally {
        store.close();
      }
      assert.throws(() => new YuqiStore(path), /authority redaction|sync audit/i);
    }));
}

test('a redacted cancelled lineage returns a terminal redacted outcome without recovery', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id = ?')
          .run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_manifests WHERE group_id = ?')
          .run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_actions WHERE group_id = ?')
          .run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_items WHERE group_id = ?')
          .run(fixture.groupId);
        store.db.prepare('DELETE FROM messages WHERE authority_group_id = ?')
          .run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_commit_receipts WHERE lineage_key = ?')
          .run(fixture.lineageKey);
        store.db.prepare('DELETE FROM visible_result_groups WHERE group_id = ?')
          .run(fixture.groupId);
        store.db.prepare(`
          UPDATE turns
          SET state = 'cancelled', generation_fingerprint = NULL
          WHERE authority_lineage_key = ?
        `).run(fixture.lineageKey);
        store.db.prepare(`
          UPDATE turn_authority_lineages
          SET state = 'cancelled', committed_group_id = NULL
          WHERE lineage_key = ?
        `).run(fixture.lineageKey);
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      store.db.prepare(`
        UPDATE turns SET route_reasons_json = '["retained-secret"]'
        WHERE authority_lineage_key = ?
      `).run(fixture.lineageKey);
      assert.throws(() => new YuqiStore(path), /redacted.*lineage.*(turn|cancelled).*conflict/i);
      store.db.prepare(`
        UPDATE turns SET route_reasons_json = '[]' WHERE authority_lineage_key = ?
      `).run(fixture.lineageKey);
      const outcome = store.readCanonicalCommitOutcomeInternal({
        lineageKey: fixture.lineageKey
      });
      assert.equal(outcome.status, 'redacted');
      assert.equal(outcome.receipt, null);
      const original = store.getTurn(fixture.turnId);
      const replay = store.createCanonicalVisibleTurnInternal({
        envelope: envelope(1),
        rolloutKey: original.rolloutKey,
        expectedRolloutRevision: original.rolloutRevision,
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        laneKey: original.laneKey,
        expectedLaneRevision: Number(original.laneRevision) - 1,
        inputUserBatchId: original.inputUserBatchId,
        inputVisibilitySequence: original.inputVisibilitySequence,
        agencySnapshotChecksum: original.agencySnapshotChecksum,
        annotationSnapshot: original.annotationSnapshot
      });
      assert.equal(replay.status, 'redacted');
      assert.equal(replay.receipt, null);
      const forgedOriginal = envelope(1);
      forgedOriginal.message.content = 'forged changed content';
      assert.throws(() => store.createCanonicalVisibleTurnInternal({
        envelope: forgedOriginal,
        rolloutKey: original.rolloutKey,
        expectedRolloutRevision: original.rolloutRevision,
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        laneKey: original.laneKey,
        expectedLaneRevision: Number(original.laneRevision) - 1,
        inputUserBatchId: original.inputUserBatchId,
        inputVisibilitySequence: original.inputVisibilitySequence,
        agencySnapshotChecksum: original.agencySnapshotChecksum,
        annotationSnapshot: original.annotationSnapshot
      }), /canonical turn authority conflict|redacted replay authority conflict/);
      const retryEnvelope = envelope(1);
      retryEnvelope.turnId = 'turn_v13_redacted_retry';
      retryEnvelope.deviceSeq = 101;
      retryEnvelope.context = {
        retry: {
          retryOfTurnId: fixture.turnId,
          canonicalMessageId: retryEnvelope.message.messageId
        }
      };
      const retry = store.createCanonicalVisibleTurnInternal({
        envelope: retryEnvelope,
        rolloutKey: original.rolloutKey,
        expectedRolloutRevision: original.rolloutRevision,
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        laneKey: original.laneKey,
        expectedLaneRevision: Number(original.laneRevision) - 1,
        inputUserBatchId: original.inputUserBatchId,
        inputVisibilitySequence: original.inputVisibilitySequence,
        agencySnapshotChecksum: original.agencySnapshotChecksum,
        annotationSnapshot: original.annotationSnapshot
      });
      assert.equal(retry.status, 'redacted');
      assert.equal(retry.receipt, null);
      const missingBubbleRetry = JSON.parse(JSON.stringify(retryEnvelope));
      missingBubbleRetry.turnId = 'turn_v13_redacted_retry_missing_bubble';
      missingBubbleRetry.deviceSeq += 10;
      missingBubbleRetry.context.currentBatch = {
        batchId: original.inputUserBatchId,
        messageIds: ['msg_missing_prior_bubble', missingBubbleRetry.message.messageId],
        messages: [missingBubbleRetry.message],
        startedAt: 1,
        committedAt: 2
      };
      assert.throws(() => store.createCanonicalVisibleTurnInternal({
        envelope: missingBubbleRetry,
        rolloutKey: original.rolloutKey,
        expectedRolloutRevision: original.rolloutRevision,
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        laneKey: original.laneKey,
        expectedLaneRevision: Number(original.laneRevision) - 1,
        inputUserBatchId: original.inputUserBatchId,
        inputVisibilitySequence: original.inputVisibilitySequence,
        agencySnapshotChecksum: original.agencySnapshotChecksum,
        annotationSnapshot: original.annotationSnapshot
      }), /turn input authority|batch.*authority|current batch messages/i);
      assert.throws(() => commitCanonical(store, original, 1),
        /redacted.*cancelled|cancelled.*redacted|redacted lineage/i);
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('cancelled redacted lineage rejects a restored session and a non-cancelled attempt', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.exec('BEGIN IMMEDIATE');
      try {
        store.db.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id = ?').run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_manifests WHERE group_id = ?').run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_actions WHERE group_id = ?').run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_result_items WHERE group_id = ?').run(fixture.groupId);
        store.db.prepare('DELETE FROM messages WHERE authority_group_id = ?').run(fixture.groupId);
        store.db.prepare('DELETE FROM visible_commit_receipts WHERE lineage_key = ?').run(fixture.lineageKey);
        store.db.prepare('DELETE FROM visible_result_groups WHERE group_id = ?').run(fixture.groupId);
        store.db.prepare(`UPDATE turns SET state = 'cancelled', generation_fingerprint = NULL
          WHERE authority_lineage_key = ?`).run(fixture.lineageKey);
        store.db.prepare(`UPDATE turn_authority_lineages
          SET state = 'cancelled', committed_group_id = NULL WHERE lineage_key = ?`)
          .run(fixture.lineageKey);
        store.db.exec('COMMIT');
      } catch (error) {
        store.db.exec('ROLLBACK');
        throw error;
      }
      store.db.prepare(`INSERT INTO sessions(role, thread_id, turn_count, updated_at)
        VALUES ('yuqi', 'cancelled-redacted-secret-thread', 1, 1)`)
        .run();
    } finally {
      store.close();
    }
    assert.throws(() => {
      const reopened = new YuqiStore(path);
      reopened.close();
    }, /redacted.*context|redacted.*cancelled/i);
  }));

function assertCancelledRedactedReject(mutate) {
  return withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { matrix: true });
    const store = new YuqiStore(path);
    try {
      convertRedactedFixtureToCancelled(store, fixture);
      mutate(store, fixture);
      assert.throws(() => store.readCanonicalCommitOutcomeInternal({
        lineageKey: fixture.lineageKey
      }), /redacted authority|cancelled/i);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /redacted authority|cancelled|v1[13] invariant/i);
  });
}

function insertTurnLinkedMessage(store, fixture, {
  messageId, content = '', authorityGroupId = null
}) {
  const turn = store.getTurn(fixture.turnId);
  const normalized = {
    messageId,
    turnId: fixture.turnId,
    characterId: turn.characterId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: turn.characterId,
    content,
    sentAt: 49_000,
    origin: 'codex',
    deviceId: null,
    deviceSeq: null
  };
  store.db.prepare(`
    INSERT INTO messages(
      message_id, turn_id, character_id, speaker_id, speaker_type,
      recipient_id, content, sent_at, origin, device_id, device_seq,
      checksum, created_at, authority_group_id, group_ordinal
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    normalized.messageId, normalized.turnId, normalized.characterId,
    normalized.speakerId, normalized.speakerType, normalized.recipientId,
    normalized.content, normalized.sentAt, normalized.origin,
    normalized.deviceId, normalized.deviceSeq, contentHash(normalized),
    49_000, authorityGroupId
  );
}

for (const [name, mutate] of [
  ['mismatched attempt redaction time', (store, fixture) => store.db.prepare(`
    UPDATE turns SET authority_redacted_at = authority_redacted_at + 1
    WHERE turn_id = ?
  `).run(fixture.attemptTurnIds[1])],
  ['queued recoverable attempt', (store, fixture) => store.db.prepare(`
    UPDATE turns SET state = 'queued' WHERE turn_id = ?
  `).run(fixture.attemptTurnIds[1])],
  ['source-message annotation', (store, fixture) => store.db.prepare(`
    INSERT INTO annotations(
      annotation_id, turn_id, source_message_id, preset_version,
      annotation_json, status, created_at
    ) VALUES ('ann_cancelled_source', ?, 'msg_v13_batch_1_0', '1.9.2',
      '{"secret":true}', 'active', 1)
  `).run(fixture.turnId)],
  ['restored role session', (store) => store.db.prepare(`
    INSERT INTO sessions(role, thread_id, turn_count, updated_at)
    VALUES ('yuqi', 'cancelled-secret-thread', 1, 1)
  `).run()],
  ['forged user recipient identity', (store) => store.db.prepare(`
    UPDATE messages SET recipient_id = 'other_role'
    WHERE message_id = 'msg_v13_batch_1_1'
  `).run()],
  ['forged user character identity', (store) => store.db.prepare(`
    UPDATE messages SET character_id = 'other_role'
    WHERE message_id = 'msg_v13_batch_1_1'
  `).run()],
  ['extra plaintext turn-linked message', (store, fixture) =>
    insertTurnLinkedMessage(store, fixture, {
      messageId: 'msg_cancelled_extra_plaintext',
      content: 'retained secret'
    })],
  ['extra empty turn-linked message', (store, fixture) =>
    insertTurnLinkedMessage(store, fixture, {
      messageId: 'msg_cancelled_extra_empty'
    })],
  ['foreign authority-group message', (store, fixture) => {
    store.db.exec('PRAGMA foreign_keys = OFF');
    insertTurnLinkedMessage(store, fixture, {
      messageId: 'msg_cancelled_foreign_group',
      authorityGroupId: 'group_foreign_authority'
    });
  }]
]) {
  test(`cancelled redacted lineage rejects ${name} in scoped outcome and restart`, () =>
    assertCancelledRedactedReject(mutate));
}

test('redacted retry requires the complete immutable three-bubble batch header', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, { matrix: true });
    const store = new YuqiStore(path);
    try {
      convertRedactedFixtureToCancelled(store, fixture);
      const parent = store.getTurn(fixture.attemptTurnIds[2]);
      const makeEnvelope = suffix => {
        const value = threeBubbleEnvelope(1);
        value.turnId = `turn_v13_redacted_matrix_retry_${suffix}`;
        value.deviceSeq += 200;
        value.context = {
          ...value.context,
          retry: {
            retryOfTurnId: parent.turnId,
            canonicalMessageId: value.message.messageId
          }
        };
        return value;
      };
      const submit = value => store.createCanonicalVisibleTurnInternal({
        envelope: value,
        rolloutKey: parent.rolloutKey,
        expectedRolloutRevision: parent.rolloutRevision,
        authoritativeReleaseId: parent.authoritativeReleaseId,
        comparisonReleaseId: parent.comparisonReleaseId,
        comparisonDirection: parent.comparisonMode === 'none' ? null : parent.comparisonMode,
        laneKey: parent.laneKey,
        expectedLaneRevision: Number(parent.laneRevision) - 1,
        inputUserBatchId: parent.inputUserBatchId,
        inputVisibilitySequence: parent.inputVisibilitySequence,
        agencySnapshotChecksum: parent.agencySnapshotChecksum,
        annotationSnapshot: parent.annotationSnapshot
      });
      assert.equal(submit(makeEnvelope('valid')).status, 'redacted');
      const omitted = makeEnvelope('omitted');
      delete omitted.context.currentBatch.messages;
      assert.throws(
        () => submit(omitted), /turn input authority|batch.*authority|current batch/i
      );
      const missingId = makeEnvelope('missing_id');
      missingId.context.currentBatch.messageIds.unshift('msg_missing_prior_bubble');
      assert.throws(
        () => submit(missingId), /turn input authority|batch.*authority|current batch/i
      );
      for (const [field, mutate] of [
        ['batchId', batch => { batch.batchId += '_forged'; }],
        ['startedAt', batch => { batch.startedAt += 1; }],
        ['committedAt', batch => { batch.committedAt += 1; }]
      ]) {
        const changed = makeEnvelope(field);
        mutate(changed.context.currentBatch);
        assert.throws(
          () => submit(changed), /turn input authority|batch.*authority|current batch/i
        );
      }
    } finally {
      store.close();
    }
  }));

test('open canonical batch header tampering is rejected at restart', () => withTempPath(path => {
  const store = new YuqiStore(path);
  try {
    ensureDirectRollout(store);
    const turn = createCanonical(store, 96);
    store.db.prepare(`UPDATE current_user_batches
      SET started_at = started_at + 1, checksum = ? WHERE turn_id = ?`).run('a'.repeat(64), turn.turnId);
  } finally {
    store.close();
  }
  assert.throws(() => {
    const reopened = new YuqiStore(path);
    reopened.close();
  }, /turn input authority|batch.*authority/i);
}));

test('live canonical input rejects a tombstoned batch item in scoped and restart validation',
  () => withTempPath(path => {
    const store = new YuqiStore(path);
    let turn;
    try {
      turn = createCanonicalFromEnvelope(store, threeBubbleEnvelope(96));
      store.db.prepare(`
        UPDATE current_user_batch_items
        SET message_json = NULL, redacted_at = 60000
        WHERE turn_id = ? AND sequence = 1
      `).run(turn.turnId);
      assert.throws(() => store.assertCanonicalTurnInputAuthorityInternal({
        storedTurn: store.getTurn(turn.turnId),
        incomingEnvelope: JSON.parse(turn.envelopeJson),
        mode: 'live_reopen'
      }), /canonical turn input authority conflict/);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /canonical turn input authority conflict/);
  }));

test('canonical input validation rejects an unknown authority mode', () => withTempPath(path => {
  const store = new YuqiStore(path);
  try {
    const turn = createCanonicalFromEnvelope(store, threeBubbleEnvelope(97));
    assert.throws(() => store.assertCanonicalTurnInputAuthorityInternal({
      storedTurn: store.getTurn(turn.turnId),
      incomingEnvelope: JSON.parse(turn.envelopeJson),
      mode: 'unspecified'
    }), /canonical turn input authority mode conflict/);
  } finally {
    store.close();
  }
}));

test('canonical creation rolls back every authority write on a conflicting preexisting batch message',
  () => withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const input = threeBubbleEnvelope(98);
      const conflicting = envelope(998);
      conflicting.message.messageId = input.context.currentBatch.messages[1].messageId;
      conflicting.message.content = '冲突的预写入正文';
      store.submitTurn(conflicting);
      const snapshot = () => ({
        turns: Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value),
        lineages: Number(store.db.prepare(
          'SELECT COUNT(*) AS value FROM turn_authority_lineages'
        ).get().value),
        batches: Number(store.db.prepare(
          'SELECT COUNT(*) AS value FROM current_user_batches'
        ).get().value),
        batchItems: Number(store.db.prepare(
          'SELECT COUNT(*) AS value FROM current_user_batch_items'
        ).get().value),
        lanes: store.db.prepare(`
          SELECT role_id, lane_key, revision, local_sequence, generating_turn_id
          FROM interaction_lanes ORDER BY role_id, lane_key
        `).all()
      });
      const before = snapshot();
      assert.throws(() => createCanonicalFromEnvelope(store, input), /message checksum conflict/);
      assert.deepEqual(snapshot(), before);
      assert.equal(store.getTurn(input.turnId), null);
    } finally {
      store.close();
    }
  }));

for (const [field, mutation] of [
  ['batch_id', "batch_id = batch_id || '_forged'"],
  ['character_id', "character_id = 'other_role'"],
  ['source_message_id', "source_message_id = 'msg_forged_source'"],
  ['started_at', 'started_at = started_at + 1'],
  ['committed_at', 'committed_at = committed_at + 1'],
  ['checksum', `checksum = '${'b'.repeat(64)}'`],
  ['item_count', 'item_count = item_count + 1'],
  ['tombstone_commitment', `tombstone_commitment = '${'c'.repeat(64)}'`]
]) {
  test(`open canonical input rejects tampered batch header ${field}`, () => withTempPath(path => {
    const store = new YuqiStore(path);
    let turn;
    try {
      ensureDirectRollout(store);
      turn = createCanonicalFromEnvelope(store, threeBubbleEnvelope(97));
      store.db.prepare(`UPDATE current_user_batches SET ${mutation} WHERE turn_id = ?`)
        .run(turn.turnId);
    } finally {
      store.close();
    }
    assert.throws(
      () => new YuqiStore(path),
      /turn input authority|batch.*authority|v1[13] invariant/i
    );
  }));
}

test('redacted group preserves an explicit empty action tombstone set', () => withTempPath(path => {
  const fixture = buildRedactedV13Fixture(path, { rich: false });
  const store = new YuqiStore(path);
  try {
    const group = store.db.prepare(`
      SELECT action_count, tombstone_commitment FROM visible_result_groups WHERE group_id = ?
    `).get(fixture.groupId);
    assert.equal(Number(group.action_count), 0);
    assert.match(group.tombstone_commitment, /^[a-f0-9]{64}$/);
    assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
      purpose: 'reopen'
    }).status, 'redacted');
  } finally {
    store.close();
  }
}));

test('redacted automatic skip preserves explicit empty item and action commitments', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, {
      kind: 'PROACTIVE_CHAT', rich: false, items: [], actionSet: []
    });
    const store = new YuqiStore(path);
    try {
      const group = store.db.prepare(`
        SELECT item_count, action_count, tombstone_commitment FROM visible_result_groups WHERE group_id = ?
      `).get(fixture.groupId);
      assert.equal(Number(group.item_count), 0);
      assert.equal(Number(group.action_count), 0);
      assert.match(group.tombstone_commitment, /^[a-f0-9]{64}$/);
      const outcome = store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      });
      assert.equal(outcome.status, 'redacted');
      assert.equal(outcome.terminalDisposition, 'skip');
      assert.equal(outcome.group.itemCount, 0);
      assert.equal(outcome.group.actionCount, 0);
    } finally {
      store.close();
    }
  }));

function assertRedactedRolloutKeyCorruption(value) {
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.prepare('UPDATE turns SET rollout_key = ? WHERE turn_id = ?')
        .run(value, fixture.turnId);
      assert.throws(
        () => store.assertVisibleGroupAuthorityInternal(fixture.groupId, { purpose: 'reopen' }),
        /commitment conflict|kind anchor conflict/
      );
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /invariant|authority|commitment conflict/);
  });
}

test('redacted rollout key anchor rejects null', () => assertRedactedRolloutKeyCorruption(null));
test('redacted rollout key anchor rejects changes', () =>
  assertRedactedRolloutKeyCorruption('PROACTIVE_CHAT'));

test('redacted delivery commitment rejects a deleted retained delivery', () => withTempPath(path => {
  const fixture = buildRedactedV13Fixture(path);
  const store = new YuqiStore(path);
  try {
    store.db.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id = ?')
      .run(fixture.groupId);
    assert.throws(
      () => store.assertVisibleGroupAuthorityInternal(fixture.groupId, { purpose: 'reopen' }),
      /redacted authority delivery commitment conflict/
    );
  } finally {
    store.close();
  }
  assert.throws(() => new YuqiStore(path), /redacted authority delivery commitment conflict|v11 invariant canonical_delivery_join/);
}));

test('redacted delivery commitment rejects a changed retained relay identity', () => withTempPath(path => {
  const fixture = buildRedactedV13Fixture(path);
  const store = new YuqiStore(path);
  try {
    store.db.prepare(`
      UPDATE cloud_deliveries SET relay_message_id = 'relay_tampered'
      WHERE authority_group_id = ?
    `).run(fixture.groupId);
    assert.throws(
      () => store.assertVisibleGroupAuthorityInternal(fixture.groupId, { purpose: 'reopen' }),
      /redacted authority delivery commitment conflict/
    );
  } finally {
    store.close();
  }
  assert.throws(() => new YuqiStore(path), /redacted authority delivery commitment conflict/);
}));

test('redacted batch parent commitment rejects deleting its final retained item', () => withTempPath(path => {
  const fixture = buildRedactedV13Fixture(path);
  const store = new YuqiStore(path);
  try {
    store.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ?')
      .run(fixture.turnId);
    assert.throws(
      () => store.assertVisibleGroupAuthorityInternal(fixture.groupId, { purpose: 'reopen' }),
      /redacted authority.*(input batch|lineage batch).*conflict/
    );
  } finally {
    store.close();
  }
  assert.throws(() => new YuqiStore(path), /redacted authority.*(input batch|lineage batch).*conflict/);
}));

test('redacted audit shell rejects deleting a retained character message projection', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const item = store.db.prepare(`
        SELECT message_id FROM visible_result_items WHERE group_id = ? ORDER BY ordinal LIMIT 1
      `).get(fixture.groupId);
      store.db.prepare('DELETE FROM messages WHERE message_id = ?').run(item.message_id);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }), /redacted authority.*message.*conflict/);
    } finally {
      store.close();
    }
    assert.throws(
      () => new YuqiStore(path),
      /redacted authority.*message.*conflict|canonical_item_message_projection/
    );
  }));

test('redacted audit shell rejects deleting a retained user batch message projection', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const item = store.db.prepare(`
        SELECT message_id FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence LIMIT 1
      `).get(fixture.turnId);
      store.db.prepare('DELETE FROM messages WHERE message_id = ?').run(item.message_id);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }), /redacted authority.*message.*conflict/);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /redacted authority.*message.*conflict/);
  }));

test('redacted lineage permits clearing a nonempty annotation snapshot without changing its commitment',
  () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path, {
      annotationSnapshot: { lesson: '对方更喜欢自然的接话' }
    });
    const store = new YuqiStore(path);
    try {
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
    } finally {
      store.close();
    }
  }));

test('live batch parent count is authority-checked at reopen', () => withTempPath(path => {
  const store = new YuqiStore(path);
  try {
    ensureDirectRollout(store);
    const receipt = commitCanonical(store, createCanonical(store, 91), 91);
    store.db.prepare('UPDATE current_user_batches SET item_count = 8 WHERE turn_id = ?')
      .run(receipt.authoritativeTurnId);
    assert.throws(() => store.assertVisibleGroupAuthorityInternal(receipt.visibleGroupId, {
      purpose: 'reopen'
    }), /input batch authority conflict|canonical turn input authority conflict/);
  } finally {
    store.close();
  }
}));

test('live canonical envelope tampering is rejected by scoped validation and reopen', () =>
  withTempPath(path => {
    const store = new YuqiStore(path);
    let receipt;
    try {
      ensureDirectRollout(store);
      receipt = commitCanonical(store, createCanonical(store, 94), 94);
      const turn = store.getTurn(receipt.authoritativeTurnId);
      const changed = JSON.parse(turn.envelopeJson);
      changed.deviceSeq += 7;
      store.db.prepare('UPDATE turns SET envelope_json = ? WHERE turn_id = ?')
        .run(JSON.stringify(changed), turn.turnId);
      assert.throws(() => store.assertVisibleGroupAuthorityInternal(receipt.visibleGroupId, {
        purpose: 'reopen'
      }), /turn input authority|envelope.*authority|envelope.*checksum/i);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /turn input authority|envelope.*authority|envelope.*checksum/i);
  }));

test('open canonical envelope tampering is rejected before any visible group exists', () =>
  withTempPath(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const created = createCanonical(store, 95);
      const turn = store.getTurn(created.turnId);
      const changed = JSON.parse(turn.envelopeJson);
      changed.deviceSeq += 3;
      store.db.prepare('UPDATE turns SET envelope_json = ? WHERE turn_id = ?')
        .run(JSON.stringify(changed), turn.turnId);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /turn input authority|envelope.*authority|envelope.*checksum/i);
  }));

test('live automatic skip survives a close and reopen', () => withTempPath(path => {
  const store = new YuqiStore(path);
  ensureRollout(store, 'PROACTIVE_CHAT');
  const skipped = createCanonical(store, 92, 'PROACTIVE_CHAT');
  const receipt = commitCanonical(store, skipped, 92, { items: [], actionSet: [] });
  store.close();
  const reopened = new YuqiStore(path);
  try {
    assert.equal(reopened.assertVisibleGroupAuthorityInternal(receipt.visibleGroupId, {
      purpose: 'reopen'
    }).terminalDisposition, 'skip');
  } finally {
    reopened.close();
  }
}));

test('a redacted group does not suppress unrelated legacy authority-leak checks', () =>
  withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      const legacy = store.submitTurn(envelope(93));
      store.db.prepare(`
        UPDATE turns SET authority_lineage_key = 'forged_legacy_lineage' WHERE turn_id = ?
      `).run(legacy.turnId);
    } finally {
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /v11 invariant legacy_authority_leak/);
  }));

for (const [name, inject] of [
  ['turn reply JSON', (database, fixture) => database.prepare(`
    UPDATE turns SET reply_json = '{"content":"leak"}' WHERE turn_id = ?
  `).run(fixture.turnId)],
  ['turn envelope JSON', (database, fixture) => database.prepare(`
    UPDATE turns SET envelope_json = '{"kind":"DIRECT_REPLY"}' WHERE turn_id = ?
  `).run(fixture.turnId)],
  ['input batch JSON', (database, fixture) => database.prepare(`
    UPDATE current_user_batch_items SET message_json = '{"content":"leak"}'
    WHERE turn_id = ?
  `).run(fixture.turnId)],
  ['linked message content', (database, fixture) => database.prepare(`
    UPDATE messages SET content = 'leak' WHERE turn_id = ?
  `).run(fixture.turnId)],
  ['item semantic JSON', (database, fixture) => database.prepare(`
    UPDATE visible_result_items SET item_json = '{"content":"leak"}' WHERE group_id = ?
  `).run(fixture.groupId)],
  ['action target', (database, fixture) => database.prepare(`
    UPDATE visible_result_actions SET target_key = 'message:leak' WHERE group_id = ?
  `).run(fixture.groupId)],
  ['action semantic JSON', (database, fixture) => database.prepare(`
    UPDATE visible_result_actions SET action_json = '{"payload":"leak"}' WHERE group_id = ?
  `).run(fixture.groupId)],
  ['manifest semantic JSON', (database, fixture) => database.prepare(`
    UPDATE visible_result_manifests SET semantic_json = '{"leak":true}' WHERE group_id = ?
  `).run(fixture.groupId)],
  ['mailboxed delivery payload', (database, fixture) => database.prepare(`
    UPDATE cloud_deliveries SET state = 'mailboxed', payload_json = '{"leak":true}',
      checksum = '${SHA_A}' WHERE authority_group_id = ?
  `).run(fixture.groupId)],
  ['old annotation', (database, fixture) => database.prepare(`
    INSERT INTO annotations(annotation_id, turn_id, source_message_id, preset_version, annotation_json, status, created_at)
    VALUES ('ann_redacted_leak', ?, NULL, '1.9.2', '{"leak":true}', 'active', 1)
  `).run(fixture.turnId)],
  ['old diagnostic', (database, fixture) => database.prepare(`
    INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
    VALUES (?, 'test', 'info', '{"leak":true}', 1)
  `).run(fixture.turnId)],
  ['old sync payload', (database, fixture) => database.prepare(`
    INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
    VALUES ('turn', ?, 'update', '{"leak":true}', '${SHA_A}', 1)
  `).run(fixture.turnId)],
  ['old session link', (database, _fixture) => database.prepare(`
    INSERT INTO sessions(role, thread_id, turn_count, updated_at)
    VALUES ('yuqi', 'secret-thread', 1, 1)
  `).run()],
  ['lane cursor', (database, fixture) => database.prepare(`
    UPDATE interaction_lanes SET latest_authoritative_group_id = ?
    WHERE role_id = 'yuqi'
  `).run(fixture.groupId)]
]) {
  test(`redacted shell rejects ${name}`, () => withTempPath(path => {
    const fixture = buildRedactedV13Fixture(path);
    const store = new YuqiStore(path);
    try {
      store.db.exec('PRAGMA ignore_check_constraints = ON');
      inject(store.db, fixture);
    } finally {
      store.db.exec('PRAGMA ignore_check_constraints = OFF');
      store.close();
    }
    assert.throws(() => new YuqiStore(path), /redacted authority/);
  }));
}

test('v13 terminal dispositions permit automatic visible/action-only/skip but reject an empty direct reply', () => {
  withAuthorityV13(store => {
    const direct = createCanonical(store, 81, 'DIRECT_REPLY');
    assert.throws(
      () => commitCanonical(store, direct, 81, { items: [] }),
      /DIRECT_REPLY requires visible result items|terminal disposition/i
    );
  });

  withAuthorityV13(store => {

    const visible = createCanonical(store, 82, 'PROACTIVE_CHAT');
    assert.equal(commitCanonical(store, visible, 82).committed, true);

    const actionOnly = createCanonical(store, 83, 'PROACTIVE_MOMENT');
    const actionDraft = { kind: 'moment_create', payload: { text: '只发动态' } };
    const target = store.resolveCanonicalActionTargetInternal({ turn: actionOnly, action: actionDraft });
    assert.equal(commitCanonical(store, actionOnly, 83, {
      items: [],
      actionSet: [{
        ...actionDraft,
        targetKey: target.targetKey,
        targetRevision: target.targetRevision
      }]
    }).committed, true);

    const skip = createCanonical(store, 84, 'PROACTIVE_CHAT');
    const skipped = commitCanonical(store, skip, 84, { items: [], actionSet: [] });
    assert.equal(skipped.committed, true);
    const group = store.db.prepare(`
      SELECT group_id FROM visible_result_groups WHERE authoritative_turn_id = ?
    `).get(skip.turnId);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value FROM visible_result_items WHERE group_id = ?
    `).get(group.group_id).value, 0);
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value FROM visible_result_actions WHERE group_id = ?
    `).get(group.group_id).value, 0);
    assert.equal(store.assertVisibleGroupAuthorityInternal(group.group_id, {
      purpose: 'reopen'
    }).terminalDisposition, 'skip');
    const payload = store.visibleDeliveryPayload(group.group_id, 'phone');
    assert.equal(payload.terminalDisposition, 'skip');
    assert.equal(payload.inputVisibilitySequence, 0);
    assert.equal(payload.inputClearEpoch, 0);
    assert.deepEqual(payload.replyParts, []);
    assert.deepEqual(payload.actions, []);
  });
});

test('v3 proactive zero-result cannot claim a pinned motive', () =>
  withAuthorityV13(store => {
    const envelope = v3AutomaticEnvelope(85, 'PROACTIVE_CHAT');
    envelope.context.visibilityCursor.localSequence = 1;
    store.putLifePlan('yuqi', [{
      episodeId: 'episode_proactive_85',
      kind: 'personal',
      title: '测试事件',
      startAt: envelope.createdAt - 100,
      endAt: envelope.createdAt + 1000
    }]);
    const authority = store.rebuildProactiveMotiveAuthorityInternal({
      envelope
    }).annotationSnapshot.proactiveMotiveAuthority;
    const turn = createCanonicalFromEnvelope(store, envelope, {
      annotationSnapshot: { proactiveMotiveAuthority: authority }
    });
    const lane = store.getInteractionLane('yuqi', turn.laneKey);
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const contextRevision = contentHash({
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      proactiveMotiveAuthorityChecksum: authority.checksum
    });
    const before = store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value;
    assert.throws(() => commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      protocolVersion: 3,
      turnKind: 'PROACTIVE_CHAT',
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision: 0,
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup: { items: [] },
      actionSet: [],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      proactiveMotiveEvidenceIds: [authority.candidates[0].motiveId],
      generationFingerprint: generationFingerprint({
        roleId: turn.characterId,
        laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup: { items: [] },
        actionSet: [],
        contextRevision
      }),
      now: envelope.createdAt
    }), /motive evidence\/result disposition|skip authority/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value, before);
  }));

test('fresh v3 proactive store creation rejects a self-consistent forged motive snapshot', () =>
  withAuthorityV13(store => {
    store.putLifePlan('yuqi', [{
      episodeId: 'task17_authority_episode',
      kind: 'personal',
      title: '真实生活事件',
      startAt: 29_000,
      endAt: 31_000
    }]);
    const envelope = v3AutomaticEnvelope(86, 'PROACTIVE_CHAT');
    envelope.context.visibilityCursor.localSequence = 1;
    const lifeContext = {
      current: store.listLifeEpisodes('yuqi').find(item => item.status !== 'cancelled'),
      recent: [],
      upcoming: []
    };
    const authority = buildProactiveMotiveAuthority({
      consideredAt: envelope.createdAt,
      lifeContext,
      cognitiveState: store.getCognitiveState('yuqi'),
      consumedMotiveIds: [],
      hardConstraints: store.readAgencyAuthoritySnapshotInternal({
        roleId: 'yuqi', at: envelope.createdAt
      }).constraints
    });
    const forgedBody = {
      ...authority,
      candidates: authority.candidates.map(candidate => ({
        ...candidate,
        summary: 'caller-forged summary'
      }))
    };
    const forgedAuthority = {
      ...forgedBody,
      checksum: contentHash(forgedBody)
    };
    const before = store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value;
    assert.throws(
      () => createCanonicalFromEnvelope(store, envelope, {
        annotationSnapshot: { proactiveMotiveAuthority: forgedAuthority }
      }),
      /proactive motive authority conflict/
    );
    assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value), Number(before));
  }));

function v3FailureEnvelope({ suffix, parent = null }) {
  const parentWire = parent ? JSON.parse(parent.envelopeJson) : null;
  const rootMessageId = parentWire?.authority?.rootSourceId || `msg_v13_failure_${suffix}`;
  const retryOfTurnId = parent?.turnId || null;
  const claimedLineageRevision = parent
    ? Number(parent.lineageRevisionAtCreation) + 1
    : 1;
  const message = parentWire?.message || {
    messageId: rootMessageId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `failure fixture ${suffix}`,
    sentAt: 90_000
  };
  const currentBatch = parentWire?.context?.currentBatch || {
    batchId: `batch_v13_failure_${rootMessageId}`,
    messageIds: [rootMessageId],
    startedAt: message.sentAt,
    committedAt: 90_001,
    messages: [message]
  };
  const localSequence = parentWire
    ? Number(parentWire.context.visibilityCursor.localSequence) + 1
    : 1;
  const laneKey = 'private_chat';
  return {
    protocolVersion: 3,
    turnId: `turn_v13_failure_${suffix}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 10_000 + claimedLineageRevision,
    createdAt: 90_001 + claimedLineageRevision,
    kind: 'DIRECT_REPLY',
    message,
    context: {
      currentBatch,
      ...(retryOfTurnId ? {
        retry: { retryOfTurnId, canonicalMessageId: rootMessageId }
      } : {}),
      visibilityCursor: {
        nativeCompletedTurnId: null,
        nativeCompletedGroupId: null,
        nativeCompletedSequence: 0,
        uiAppliedTurnId: null,
        uiAppliedGroupId: null,
        uiAppliedSequence: 0,
        localSequence,
        clearedThroughSequence: 0,
        clearEpoch: 0,
        clearedAt: 0,
        chatOpen: true,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: rootMessageId,
      lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey, rootSourceId: rootMessageId }),
      claimedLineageRevision,
      retryOfTurnId
    }
  };
}

function createV3FailureTurn(store, suffix, parent = null) {
  ensureDirectRollout(store);
  const input = validateEnvelope(v3FailureEnvelope({ suffix, parent }));
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: input.message.sentAt });
  return store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: input.context.currentBatch.batchId,
    inputVisibilitySequence: input.context.visibilityCursor.localSequence,
    inputClearEpoch: input.context.visibilityCursor.clearEpoch,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
}

function failV3FailureTurn(store, turn) {
  return store.recordCanonicalTurnFailureInternal({
    turnId: turn.turnId,
    expectedState: turn.state,
    expectedTurnRevision: turn.turnRevision,
    failure: {
      name: 'TimeoutError',
      code: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
      message: 'canonical failure delivery fixture',
      failureClass: 'transient',
      retryAllowed: true
    }
  });
}

function prepareV3FailureDeliveryState(store, variant) {
  const parent = failV3FailureTurn(store, createV3FailureTurn(store, variant.name));
  const peerId = parent.deviceId;
  let claim = null;
  const claimFailure = () => {
    claim = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: parent.turnId, peerId, timestamp: 100_000
    });
    assert.ok(claim, `${variant.name} must claim the canonical failure delivery`);
  };
  const mailbox = () => store.markCanonicalFailureCloudDeliveryMailboxedInternal({
    turnId: parent.turnId,
    peerId,
    rawStatusChecksum: claim.rawStatusChecksum,
    leaseId: claim.leaseId,
    leaseAttempt: claim.leaseAttempt,
    relayMessageId: claim.relayMessageId,
    timestamp: 100_100
  });
  const quarantine = () => {
    const target = store.listCloudDeliveries(parent.turnId)[0];
    return store.quarantineCanonicalCloudDeliveryInternal({
      turnId: parent.turnId,
      peerId,
      expected: {
        state: target.state, payloadJson: target.payloadJson, checksum: target.checksum,
        attempts: target.attempts, relayMessageId: target.relayMessageId,
        deliveredAt: target.deliveredAt, updatedAt: target.updatedAt
      },
      reason: 'authority_validation_failed'
    });
  };
  switch (variant.prepare) {
    case 'waiting':
      break;
    case 'pending':
      claimFailure();
      break;
    case 'mailboxed':
      claimFailure();
      mailbox();
      break;
    case 'superseded_empty':
      createV3FailureTurn(store, `${variant.name}_child`, parent);
      break;
    case 'superseded_payload':
      claimFailure();
      createV3FailureTurn(store, `${variant.name}_child`, parent);
      break;
    case 'superseded_mailboxed':
      claimFailure();
      createV3FailureTurn(store, `${variant.name}_child`, parent);
      mailbox();
      break;
    case 'quarantined_waiting':
      quarantine();
      break;
    case 'quarantined_pending':
      claimFailure();
      quarantine();
      break;
    default:
      throw new Error(`unknown canonical failure fixture state: ${variant.prepare}`);
  }
  return { parent, peerId };
}

const CANONICAL_FAILURE_REOPEN_VARIANTS = [
  { name: 'waiting', prepare: 'waiting', state: 'waiting', payload: false, relay: false },
  { name: 'pending', prepare: 'pending', state: 'pending', payload: true, relay: false },
  { name: 'mailboxed', prepare: 'mailboxed', state: 'mailboxed', payload: true, relay: true },
  { name: 'superseded-empty', prepare: 'superseded_empty', state: 'superseded', payload: false, relay: false },
  { name: 'superseded-payload', prepare: 'superseded_payload', state: 'superseded', payload: true, relay: false },
  { name: 'superseded-mailboxed', prepare: 'superseded_mailboxed', state: 'superseded_mailboxed', payload: true, relay: true },
  { name: 'quarantined-from-waiting', prepare: 'quarantined_waiting', state: 'quarantined', payload: false, relay: false },
  { name: 'quarantined-from-pending', prepare: 'quarantined_pending', state: 'quarantined', payload: false, relay: false }
];

for (const variant of CANONICAL_FAILURE_REOPEN_VARIANTS) {
  test(`v13 canonical failure delivery ${variant.name} survives SQLite close and reopen`, () =>
    withTempPath(path => {
      const store = new YuqiStore(path, { targetVersion: 13 });
      let fixture;
      try {
        fixture = prepareV3FailureDeliveryState(store, variant);
        const delivery = store.db.prepare(`
          SELECT state, authority_group_id, payload_json, checksum, relay_message_id, delivered_at
          FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
        `).get(fixture.parent.turnId, fixture.peerId);
        assert.equal(delivery.state, variant.state);
      } finally {
        store.close();
      }
      const reopened = new YuqiStore(path, { targetVersion: 13 });
      try {
        const delivery = reopened.db.prepare(`
          SELECT state, authority_group_id, payload_json, checksum, relay_message_id, delivered_at
          FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
        `).get(fixture.parent.turnId, fixture.peerId);
        assert.equal(delivery.state, variant.state);
        assert.equal(delivery.authority_group_id, null);
        assert.equal(delivery.payload_json != null, variant.payload);
        assert.equal(delivery.checksum != null, variant.payload);
        assert.equal(delivery.relay_message_id != null, variant.relay);
        assert.equal(delivery.delivered_at != null, variant.relay);
        assert.doesNotThrow(() => reopened.assertVisibleAuthorityV13Invariants());
      } finally {
        reopened.close();
      }
    }));
}

function rawFailureDelivery(store, fixture) {
  return store.db.prepare(`
    SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
  `).get(fixture.parent.turnId, fixture.peerId);
}

function rawFailurePayload(store, fixture, change) {
  const delivery = rawFailureDelivery(store, fixture);
  const payload = JSON.parse(delivery.payload_json);
  change(payload, delivery);
  store.db.prepare(`UPDATE cloud_deliveries SET payload_json = ? WHERE turn_id = ? AND peer_id = ?`)
    .run(JSON.stringify(payload), fixture.parent.turnId, fixture.peerId);
}

function appendV3FailureGrandchild(store, fixture) {
  const child = store.getTurn(store.getTurnAuthorityLineage(fixture.parent.authorityLineageKey).latestTurnId);
  const failedChild = failV3FailureTurn(store, child);
  return createV3FailureTurn(store, 'corrupt_multilevel_grandchild', failedChild);
}

function assertV13FailureCorruptionRejected(scenario) {
  withTempPath(path => {
    const store = new YuqiStore(path, { targetVersion: 13 });
    try {
      const fixture = prepareV3FailureDeliveryState(store, {
        name: `corrupt_${scenario.name}`,
        prepare: scenario.prepare || 'pending'
      });
      scenario.mutate(store, fixture);
    } finally {
      store.close();
    }
    assert.throws(() => {
      const reopened = new YuqiStore(path, { targetVersion: 13 });
      reopened.close();
    }, /canonical failure|v13 invariant|v11 invariant|authority|retry permission/i, scenario.name);
  });
}

const V13_CANONICAL_FAILURE_CORRUPTIONS = [
  {
    name: 'result-authority-version',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET result_authority_version = 0 WHERE turn_id = ?
    `).run(fixture.parent.turnId)
  },
  {
    name: 'authority-group-id',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE cloud_deliveries SET authority_group_id = 'forged_failure_group'
      WHERE turn_id = ? AND peer_id = ?
    `).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'invalid-state',
    mutate: (store, fixture) => {
      store.db.exec('PRAGMA ignore_check_constraints = ON');
      try {
        store.db.prepare(`UPDATE cloud_deliveries SET state = 'delivered'
          WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId);
      } finally {
        store.db.exec('PRAGMA ignore_check_constraints = OFF');
      }
    }
  },
  {
    name: 'foreign-peer',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE cloud_deliveries SET peer_id = 'foreign_phone' WHERE turn_id = ? AND peer_id = ?
    `).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'parent-lineage',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET authority_lineage_key = 'forged_failure_lineage' WHERE turn_id = ?
    `).run(fixture.parent.turnId)
  },
  {
    name: 'direct-retry-parent',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET retry_of_turn_id = 'forged_parent'
      WHERE authority_lineage_key = ? AND retry_of_turn_id = ?
    `).run(fixture.parent.authorityLineageKey, fixture.parent.turnId)
  },
  {
    name: 'lineage-latest',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turn_authority_lineages SET latest_turn_id = ? WHERE lineage_key = ?
    `).run(fixture.parent.turnId, fixture.parent.authorityLineageKey)
  },
  {
    name: 'multilevel-retry',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => {
      const grandchild = appendV3FailureGrandchild(store, fixture);
      store.db.prepare(`UPDATE turns SET retry_of_turn_id = ? WHERE turn_id = ?`)
        .run(fixture.parent.turnId, grandchild.turnId);
    }
  },
  {
    name: 'error-extra-field',
    mutate: (store, fixture) => store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
      .run(JSON.stringify({ ...JSON.parse(fixture.parent.errorJson), extra: 'leak' }), fixture.parent.turnId)
  },
  {
    name: 'error-missing-code',
    mutate: (store, fixture) => {
      const error = JSON.parse(fixture.parent.errorJson);
      delete error.code;
      store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
        .run(JSON.stringify(error), fixture.parent.turnId);
    }
  },
  {
    name: 'error-nonboolean-retry',
    mutate: (store, fixture) => store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
      .run(JSON.stringify({ ...JSON.parse(fixture.parent.errorJson), retryAllowed: 'true' }), fixture.parent.turnId)
  },
  {
    name: 'payload-extra-field',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => { payload.extra = 'leak'; })
  },
  {
    name: 'payload-missing-failure',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => { delete payload.failure; })
  },
  {
    name: 'payload-value-change',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => {
      payload.failure.message = 'forged failure detail';
    })
  },
  {
    name: 'checksum',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET checksum = ?
      WHERE turn_id = ? AND peer_id = ?`).run('f'.repeat(64), fixture.parent.turnId, fixture.peerId)
  },
  ...['leaseId', 'leaseAttempt', 'leasedAt'].map(key => ({
    name: `lease-missing-${key}`,
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => { delete payload.lease[key]; })
  })),
  {
    name: 'lease-attempt',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => { payload.lease.leaseAttempt += 1; })
  },
  {
    name: 'lease-id',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, payload => { payload.lease.leaseId = 'lease_forged'; })
  },
  {
    name: 'lease-time',
    mutate: (store, fixture) => rawFailurePayload(store, fixture, (payload, delivery) => {
      payload.lease.leasedAt = Number(delivery.updated_at) + 1;
    })
  },
  {
    name: 'relay-id',
    prepare: 'mailboxed',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET relay_message_id = 'relay_forged'
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'delivered-at',
    prepare: 'mailboxed',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET delivered_at = NULL
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'quarantine-duplicate-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => {
      const diagnostic = store.db.prepare(`SELECT detail_json FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`).get(fixture.parent.turnId);
      store.db.prepare(`INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
        VALUES (?, 'canonical_failure_delivery_quarantined', 'error', ?, 1)`)
        .run(fixture.parent.turnId, diagnostic.detail_json);
    }
  },
  {
    name: 'quarantine-extra-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: fixture.peerId, reason: 'bad', extra: true }), fixture.parent.turnId)
  },
  {
    name: 'quarantine-secret-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: fixture.peerId, reason: 'bad', secret: 'leak' }), fixture.parent.turnId)
  },
  {
    name: 'quarantine-wrong-peer-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: 'foreign_phone', reason: 'bad' }), fixture.parent.turnId)
  },
  {
    name: 'pending-after-child',
    prepare: 'superseded_payload',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET state = 'pending'
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  }
];

for (const scenario of V13_CANONICAL_FAILURE_CORRUPTIONS) {
  test(`v13 reopen rejects canonical failure corruption: ${scenario.name}`, () =>
    assertV13FailureCorruptionRejected(scenario));
}
