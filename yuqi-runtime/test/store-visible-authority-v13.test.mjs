import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { generationFingerprint, laneKeyForEnvelope } from '../src/interaction-lanes.mjs';
import { contentHash } from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';
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
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

function createCanonical(store, index, kind = 'DIRECT_REPLY') {
  const input = envelope(index, kind);
  ensureRollout(store, kind);
  const rollout = store.getCognitionRollout(kind);
  const laneKey = laneKeyForEnvelope(input);
  const lane = store.getInteractionLane('yuqi', laneKey);
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi',
    at: input.message?.sentAt ?? input.trigger.executedAt
  });
  return store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: kind,
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey,
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: input.message ? `batch_${input.message.messageId}` : input.trigger.triggerId,
    inputVisibilitySequence: Number(lane?.localSequence || 0),
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
}

function createCanonicalRetry(store, parent, index) {
  const input = JSON.parse(parent.envelopeJson);
  input.turnId = `turn_v13_retry_${index}`;
  input.deviceSeq = Number(input.deviceSeq) + index;
  input.context = {
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
    comparisonDirection: parent.comparisonMode,
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
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet: resolvedActionSet,
    statePatch,
    memoryJobs,
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: resolvedActionSet,
      contextRevision: turn.agencySnapshotChecksum
    }),
    now: 20_000 + index
  });
}

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

test('fresh and populated v12 migrate atomically to exact v13 tombstone schema', () =>
  withTempPath(path => {
    buildLiveV12Database(path, { groups: 2, statePatches: 2 });
    const before = snapshotDatabase(path);
    const store = new YuqiStore(path);
    try {
      assert.equal(store.userVersion(), 13);
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
  annotationSnapshot = null
} = {}) {
  const store = new YuqiStore(path);
  ensureRollout(store, kind);
  const receipt = commitCanonical(store, createCanonical(store, 1, kind), 1, {
    rich, items, actionSet
  });
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
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'redacted', payload_json = NULL, checksum = NULL,
          relay_message_id = NULL, redaction_requested_at = NULL,
          redaction_acknowledged_at = ?
      WHERE authority_group_id = ?
    `).run(redactedAt, groupId);
    const frozenDeliveries = store.db.prepare(`
      SELECT peer_id, recovery_ack_seq, relay_message_id, authority_commit_checksum
      FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id
    `).all(groupId);
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
    expectedRolloutKey, expectedAttemptCommitment
  };
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
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
      assert.throws(
        () => store.visibleDeliveryPayload(fixture.groupId, 'phone'),
        /redacted/
      );
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

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
    } finally {
      store.close();
    }
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

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
      assert.equal(store.assertVisibleGroupAuthorityInternal(fixture.groupId, {
        purpose: 'reopen'
      }).status, 'redacted');
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
      /redacted authority input batch shell conflict/
    );
  } finally {
    store.close();
  }
  assert.throws(() => new YuqiStore(path), /redacted authority input batch shell conflict/);
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
    }), /input batch authority conflict/);
  } finally {
    store.close();
  }
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

test('v13 terminal dispositions permit automatic visible/action-only/skip but reject an empty direct reply', () =>
  withAuthorityV13(store => {
    const direct = createCanonical(store, 81, 'DIRECT_REPLY');
    assert.throws(
      () => commitCanonical(store, direct, 81, { items: [] }),
      /DIRECT_REPLY requires visible result items|terminal disposition/i
    );

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
  }));
