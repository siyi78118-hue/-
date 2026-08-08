import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { stableId } from '../src/cloud-relay-pump.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { publicTurnStatus } from '../src/turn-status.mjs';
import {
  canonicalJson,
  contentHash,
  validateConversationClearApplied,
  validateConversationClearControl
} from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';
import { ConsolidationWorker } from '../src/consolidation-worker.mjs';

const V15_COLUMNS = [
  'control_id', 'role_id', 'peer_id', 'clear_epoch', 'cleared_through_sequence',
  'requested_at', 'applied_at', 'input_cursor_checksum', 'checksum', 'applied_checksum',
  'authority_version', 'semantic_json'
];

function tempPath(prefix = 'yuqi-v15-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, path: join(dir, 'runtime.sqlite') };
}

function closeDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function rawSnapshot(path) {
  const db = new DatabaseSync(path);
  try {
    const schema = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type, name
    `).all();
    const rows = db.prepare(
      'SELECT * FROM conversation_clear_controls ORDER BY control_id'
    ).all();
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    return { schema, rows, userVersion };
  } finally {
    db.close();
  }
}

function createV14Source({ row = null } = {}) {
  const { dir, path } = tempPath();
  const store = new YuqiStore(path, { targetVersion: 14 });
  if (row) {
    store.db.prepare(`
      INSERT INTO conversation_clear_controls(
        control_id, role_id, clear_epoch, cleared_through_sequence,
        requested_at, applied_at, checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.control_id, row.role_id, row.clear_epoch, row.cleared_through_sequence,
      row.requested_at, row.applied_at, row.checksum
    );
  }
  store.close();
  return { dir, path };
}

function clearWire(overrides = {}) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR',
    controlVersion: 'conversation_clear_v1',
    roleId: 'yuqi',
    peerId: 'device1',
    clearEpoch: 1,
    clearedThroughSequence: 4,
    requestedAt: 1784400000000,
    inputCursorChecksum: 'a'.repeat(64),
    ...overrides,
    controlId: null
  };
  body.controlId = `ctl_${contentHash({
    contract: 'android-lifecycle-control-id-v1',
    controlKind: 'conversation_clear_v1',
    characterId: body.roleId,
    peerId: body.peerId,
    clearEpoch: body.clearEpoch,
    clearedThroughSequence: body.clearedThroughSequence,
    requestedAt: body.requestedAt,
    inputCursorChecksum: body.inputCursorChecksum
  })}`;
  return { ...body, checksum: contentHash(body) };
}

const V1_FIXTURE_CONTROL_ID = clearWire().controlId;

function appliedWire(wire, appliedAt = 1784400000100) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR_APPLIED',
    controlId: wire.controlId,
    controlChecksum: wire.checksum,
    roleId: wire.roleId,
    peerId: wire.peerId,
    clearEpoch: wire.clearEpoch,
    clearedThroughSequence: wire.clearedThroughSequence,
    appliedAt
  };
  return { ...body, checksum: contentHash(body) };
}

function insertV1Row(store, wire = clearWire()) {
  const semanticJson = canonicalJson(validateConversationClearControl(wire));
  const appliedAt = 1784400000100;
  const applied = appliedWire(wire, appliedAt);
  validateConversationClearApplied(applied);
  store.db.prepare(`
    INSERT INTO conversation_clear_controls(
      control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
      requested_at, applied_at, input_cursor_checksum, checksum,
      applied_checksum, authority_version, semantic_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    wire.controlId, wire.roleId, wire.peerId, wire.clearEpoch, wire.clearedThroughSequence,
    wire.requestedAt, appliedAt, wire.inputCursorChecksum, wire.checksum,
    applied.checksum, 1, semanticJson
  );
  return { wire, semanticJson, applied, appliedChecksum: applied.checksum };
}

test('v14 populated seven-column controls migrate to authority-v0 without invented peer or cursor', () => {
  const legacy = {
    control_id: 'legacy_clear_1',
    role_id: 'yuqi',
    clear_epoch: 2,
    cleared_through_sequence: 7,
    requested_at: 1000,
    applied_at: 2000,
    checksum: 'legacy-history-checksum'
  };
  const { dir, path } = createV14Source({ row: legacy });
  try {
    const store = new YuqiStore(path, { targetVersion: 15 });
    assert.equal(store.userVersion(), 15);
    assert.deepEqual(
      store.db.prepare('PRAGMA table_info(conversation_clear_controls)').all()
        .map(column => column.name),
      V15_COLUMNS
    );
    assert.deepEqual({ ...store.db.prepare(
      `SELECT control_id, role_id, clear_epoch, cleared_through_sequence,
              requested_at, applied_at, checksum, peer_id,
              input_cursor_checksum, applied_checksum,
              authority_version, semantic_json
       FROM conversation_clear_controls WHERE control_id = ?`
    ).get(legacy.control_id) }, {
      ...legacy,
      peer_id: null,
      input_cursor_checksum: null,
      applied_checksum: null,
      authority_version: 0,
      semantic_json: null
    });
    store.close();

    const reopened = new YuqiStore(path, { targetVersion: 15 });
    assert.equal(reopened.userVersion(), 15);
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('fresh v15 creates exact control schema and reopens a complete authority-v1 projection', () => {
  const { dir, path } = tempPath('yuqi-v15-fresh-');
  try {
    const store = new YuqiStore(path);
    assert.equal(store.userVersion(), 15);
    assert.deepEqual(
      store.db.prepare('PRAGMA table_info(conversation_clear_controls)').all()
        .map(column => column.name),
      V15_COLUMNS
    );
    const fixture = insertV1Row(store);
    store.close();

    const reopened = new YuqiStore(path);
    assert.deepEqual({ ...reopened.db.prepare(
      `SELECT control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
              requested_at, applied_at, input_cursor_checksum, checksum, applied_checksum,
              authority_version, semantic_json
       FROM conversation_clear_controls WHERE control_id = ?`
    ).get(fixture.wire.controlId) }, {
      control_id: fixture.wire.controlId,
      role_id: fixture.wire.roleId,
      peer_id: fixture.wire.peerId,
      clear_epoch: fixture.wire.clearEpoch,
      cleared_through_sequence: fixture.wire.clearedThroughSequence,
      requested_at: fixture.wire.requestedAt,
      applied_at: 1784400000100,
      input_cursor_checksum: fixture.wire.inputCursorChecksum,
      checksum: fixture.wire.checksum,
      applied_checksum: fixture.appliedChecksum,
      authority_version: 1,
      semantic_json: fixture.semanticJson
    });
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

const V1_CORRUPTIONS = [
  {
    name: 'partial-v1',
    mutate: db => db.prepare(
      'UPDATE conversation_clear_controls SET peer_id = NULL WHERE control_id = ?'
    ).run(V1_FIXTURE_CONTROL_ID)
  },
  {
    name: 'forged-peer',
    mutate: db => db.prepare(
      'UPDATE conversation_clear_controls SET peer_id = ? WHERE control_id = ?'
    ).run('device2', V1_FIXTURE_CONTROL_ID)
  },
  {
    name: 'forged-semantic',
    mutate: db => db.prepare(
      'UPDATE conversation_clear_controls SET semantic_json = ? WHERE control_id = ?'
    ).run('{"forged":true}', V1_FIXTURE_CONTROL_ID)
  },
  {
    name: 'changed-applied-at',
    mutate: db => db.prepare(
      'UPDATE conversation_clear_controls SET applied_at = applied_at + 1 WHERE control_id = ?'
    ).run(V1_FIXTURE_CONTROL_ID)
  },
  {
    name: 'v0-with-v1-fields',
    mutate: db => db.prepare(
      `UPDATE conversation_clear_controls
       SET authority_version = 0, peer_id = ?, input_cursor_checksum = ?, semantic_json = ?, applied_checksum = ?
       WHERE control_id = ?`
    ).run('device1', 'a'.repeat(64), '{}', 'b'.repeat(64), V1_FIXTURE_CONTROL_ID)
  }
];

for (const corruption of V1_CORRUPTIONS) {
  test(`v15 reopen rejects ${corruption.name} without mutation`, () => {
    const { dir, path } = tempPath(`yuqi-v15-${corruption.name}-`);
    try {
      const store = new YuqiStore(path, { targetVersion: 15 });
      insertV1Row(store);
      store.close();
      const db = new DatabaseSync(path);
      db.exec('PRAGMA ignore_check_constraints = ON');
      corruption.mutate(db);
      db.close();
      const before = rawSnapshot(path);
      assert.throws(
        () => new YuqiStore(path, { targetVersion: 15 }),
        /v15|authority|control/i
      );
      assert.deepEqual(rawSnapshot(path), before);
    } finally {
      closeDir(dir);
    }
  });
}

test('v15 control identity collisions fail closed without overwriting the first authority row', () => {
  const { dir, path } = tempPath('yuqi-v15-collision-');
  try {
    const store = new YuqiStore(path, { targetVersion: 15 });
    const first = insertV1Row(store);
    const second = clearWire({ peerId: 'device2' });
    assert.throws(
      () => insertV1Row(store, { ...second, clearEpoch: first.wire.clearEpoch }),
      /constraint|unique/i
    );
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls'
    ).get().count, 1);
    store.close();
  } finally {
    closeDir(dir);
  }
});

const V15_FAULT_STEPS = [
  'after_new_table',
  'after_row_copy',
  'after_projection_verification',
  'after_table_swap',
  'after_index_recreation',
  'after_version_write'
];

for (const step of V15_FAULT_STEPS) {
  test(`v14 to v15 migration fault ${step} leaves the populated source unchanged`, () => {
    const source = createV14Source({ row: {
      control_id: 'legacy_clear_fault', role_id: 'yuqi', clear_epoch: 3,
      cleared_through_sequence: 9, requested_at: 1000, applied_at: 2000,
      checksum: 'd'.repeat(64)
    } });
    const target = tempPath(`yuqi-v15-fault-${step}-`);
    try {
      copyFileSync(source.path, target.path);
      const before = rawSnapshot(target.path);
      assert.throws(
        () => new YuqiStore(target.path, { targetVersion: 15, v15MigrationFaultStep: step }),
        new RegExp(`forced v15 migration fault: ${step}`)
      );
      assert.deepEqual(rawSnapshot(target.path), before);
    } finally {
      closeDir(source.dir);
      closeDir(target.dir);
    }
  });
}

test('database user_version above v15 is rejected before reopening', () => {
  const { dir, path } = tempPath('yuqi-v15-too-new-');
  try {
    const store = new YuqiStore(path);
    store.close();
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version = 16');
    db.close();
    assert.throws(() => new YuqiStore(path, { targetVersion: 15 }), /unsupported database user_version 16/);
  } finally {
    closeDir(dir);
  }
});

function seedPrivateLane(store, {
  roleId = 'yuqi',
  revision = 0,
  clearEpoch = 0,
  clearedThroughSequence = 0,
  localSequence = 0,
  lastCommitChecksum = null,
  now = 1784400000000
} = {}) {
  return store.claimInteractionLaneInternal({
    roleId,
    laneKey: 'private_chat',
    expectedRevision: revision,
    clearEpoch,
    clearedThroughSequence,
    localSequence,
    lastCommitChecksum,
    now
  });
}

function clearStateSnapshot(store) {
  return {
    lane: store.db.prepare(
      `SELECT role_id, lane_key, revision, clear_epoch, cleared_through_sequence,
              local_sequence, last_commit_checksum, updated_at
       FROM interaction_lanes ORDER BY role_id, lane_key`
    ).all(),
    controls: store.db.prepare(
      `SELECT control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
              requested_at, applied_at, input_cursor_checksum, checksum,
              applied_checksum, authority_version, semantic_json
       FROM conversation_clear_controls ORDER BY control_id`
    ).all()
  };
}

function emptySessionClear(overrides = {}) {
  return clearWire({
    controlId: 'clear_device1_empty_1',
    clearedThroughSequence: 0,
    ...overrides
  });
}

test('empty private lane applies a closed clear atomically and returns persisted applied proof', () => {
  const { dir, path } = tempPath('yuqi-clear-empty-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { lastCommitChecksum: null });
    const control = emptySessionClear();
    const proof = store.applyConversationClearInternal(control, { appliedAt: 1784400000100 });
    assert.deepEqual(proof, appliedWire(control, 1784400000100));
    assert.deepEqual(store.getInteractionLane('yuqi', 'private_chat'), {
      roleId: 'yuqi', laneKey: 'private_chat', revision: 2,
      generatingTurnId: null, latestUserBatchId: null,
      latestAuthoritativeGroupId: null, nativeCompletedGroupId: null,
      nativeCompletedSequence: 0, uiAppliedGroupId: null, uiAppliedSequence: 0,
      localSequence: 0, clearEpoch: 1, clearedThroughSequence: 0,
      lastCommitChecksum: null, updatedAt: 1784400000100
    });
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls'
    ).get().count, 1);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('exact control replay and restart return original appliedAt and bytes without a second row', () => {
  const { dir, path } = tempPath('yuqi-clear-replay-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { nativeCompletedSequence: 4, clearedThroughSequence: 4 });
    const control = emptySessionClear({ clearedThroughSequence: 4 });
    const first = store.applyConversationClearInternal(control, { appliedAt: 1784400000100 });
    const replay = store.applyConversationClearInternal(control, { appliedAt: 1784400000999 });
    assert.deepEqual(replay, first);
    store.close();
    const reopened = new YuqiStore(path);
    assert.deepEqual(
      reopened.applyConversationClearInternal(control, { appliedAt: 1784400001999 }),
      first
    );
    assert.equal(reopened.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls'
    ).get().count, 1);
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('changed clear identity and lower/skip epoch or boundary reject without writes', () => {
  const { dir, path } = tempPath('yuqi-clear-conflicts-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { nativeCompletedSequence: 4, clearedThroughSequence: 4 });
    const control = emptySessionClear({ clearedThroughSequence: 4 });
    store.applyConversationClearInternal(control, { appliedAt: 1784400000100 });
    const before = clearStateSnapshot(store);
    const cases = [
      ['peer', { peerId: 'device2', controlId: 'clear_device2_empty_1' }],
      ['cursor', { inputCursorChecksum: 'b'.repeat(64), controlId: 'clear_device1_cursor_1' }],
      ['epoch-skip', { clearEpoch: 3, controlId: 'clear_device1_skip_1' }],
      ['epoch-lower', { clearEpoch: 0, controlId: 'clear_device1_lower_1' }],
      ['boundary-lower', { clearedThroughSequence: 3, clearEpoch: 2, controlId: 'clear_device1_lower_2' }],
      ['checksum', { checksum: 'c'.repeat(64) }]
    ];
    for (const [name, overrides] of cases) {
      assert.throws(
        () => store.applyConversationClearInternal(emptySessionClear(overrides), { appliedAt: 1784400000200 }),
        /conflict|invalid|epoch|boundary|checksum/i,
        name
      );
      assert.deepEqual(clearStateSnapshot(store), before, name);
    }
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('v0 shell at the same role epoch is a collision, not an upgrade path', () => {
  const { dir, path } = tempPath('yuqi-clear-v0-collision-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store);
    store.db.prepare(`
      INSERT INTO conversation_clear_controls(
        control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
        requested_at, applied_at, input_cursor_checksum, checksum,
        applied_checksum, authority_version, semantic_json
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL)
    `).run('legacy_clear_epoch_1', 'yuqi', 1, 0, 1000, 1001, 'legacy-history-checksum');
    const before = clearStateSnapshot(store);
    assert.throws(
      () => store.applyConversationClearInternal(emptySessionClear(), { appliedAt: 1784400000100 }),
      /collision|conflict/i
    );
    assert.deepEqual(clearStateSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('two Room handles converge on one exact empty-lane control row', () => {
  const { dir, path } = tempPath('yuqi-clear-two-handles-');
  try {
    const first = new YuqiStore(path);
    seedPrivateLane(first);
    const second = new YuqiStore(path);
    const control = emptySessionClear();
    const applied = first.applyConversationClearInternal(control, { appliedAt: 1784400000100 });
    assert.deepEqual(
      second.applyConversationClearInternal(control, { appliedAt: 1784400000200 }),
      applied
    );
    assert.equal(second.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls'
    ).get().count, 1);
    second.close();
    first.close();
  } finally {
    closeDir(dir);
  }
});

for (const faultAfterStep of ['after_lane_update', 'after_control_insert']) {
  test(`empty clear fault ${faultAfterStep} rolls back every write`, () => {
    const { dir, path } = tempPath(`yuqi-clear-fault-${faultAfterStep}-`);
    try {
      const store = new YuqiStore(path);
      seedPrivateLane(store);
      const control = emptySessionClear();
      const before = clearStateSnapshot(store);
      assert.throws(
        () => store.applyConversationClearInternal(control, {
          appliedAt: 1784400000100,
          faultAfterStep
        }),
        /forced|fault/i
      );
      assert.deepEqual(clearStateSnapshot(store), before);
      store.close();
    } finally {
      closeDir(dir);
    }
  });
}

function canonicalRedactionEnvelope(index, { retryOfTurnId = null, roleId = 'yuqi' } = {}) {
  const messages = [0, 1, 2].map(offset => ({
    messageId: `msg_redact_${index}_${offset}`,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: roleId,
    content: `redaction bubble ${offset}`,
    sentAt: 1784400010000 + index * 10 + offset,
    type: 'text'
  }));
  const rootSourceId = messages.at(-1).messageId;
  const triggerId = `redact_trigger_${index}`;
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
  const envelope = {
    protocolVersion: 3,
    turnId: `turn_redact_${index}`,
    characterId: roleId,
    deviceId: 'device1',
    deviceSeq: index,
    createdAt: 1784400020000 + index,
    kind: 'DIRECT_REPLY',
    message: messages.at(-1),
    context: {
      currentBatch: {
        batchId: `batch_redact_${index}`,
        messageIds: messages.map(message => message.messageId),
        startedAt: messages[0].sentAt,
        committedAt: 1784400020000 + index,
        messages
      },
      visibilityCursor: cursor
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId,
      laneKey: 'private_chat',
      rootSourceId,
      lineageKey: deriveAuthorityLineageKey({
        roleId, laneKey: 'private_chat', rootSourceId
      }),
      claimedLineageRevision: retryOfTurnId ? 2 : 1,
      retryOfTurnId
    }
  };
  return envelope;
}

function legacyV2AboveEnvelope(
  turnId = 'turn_legacy_above', roleId = 'yuqi', deviceId = 'device1'
) {
  return {
    protocolVersion: 2,
    turnId,
    characterId: roleId,
    deviceId,
    deviceSeq: 3,
    createdAt: 1784400020003,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_legacy_above',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: roleId,
      content: 'legacy above boundary',
      sentAt: 1784400010030
    }
  };
}

function ensureDirectRollout(store) {
  if (store.getCognitionRollout('DIRECT_REPLY')) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
      presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64)
    }],
    now: 1
  });
}

function createCanonicalRedactionFixture(store, {
  deliveryState = 'waiting',
  includeRetry = true
} = {}) {
  ensureDirectRollout(store);
  seedPrivateLane(store, { now: 1784400000000 });
  const firstInput = canonicalRedactionEnvelope(1);
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: firstInput.createdAt });
  const first = store.createCanonicalVisibleTurnInternal({
    envelope: firstInput,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: 1,
    inputUserBatchId: firstInput.context.currentBatch.batchId,
    inputVisibilitySequence: firstInput.context.visibilityCursor.localSequence,
    inputClearEpoch: firstInput.context.visibilityCursor.clearEpoch,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
  let terminal = first;
  let committed;
  if (includeRetry) {
    terminal = store.recordCanonicalTurnFailureInternal({
      turnId: first.turnId,
      expectedState: first.state,
      expectedTurnRevision: first.turnRevision,
      failure: {
        name: 'TimeoutError',
        code: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
        message: 'redaction retry fixture',
        failureClass: 'transient',
        retryAllowed: true
      }
    });
    const retryInput = canonicalRedactionEnvelope(2, { retryOfTurnId: first.turnId });
    retryInput.context.currentBatch = firstInput.context.currentBatch;
    retryInput.context.visibilityCursor = firstInput.context.visibilityCursor;
    retryInput.context.visibilityCursor.localSequence = 2;
    retryInput.message = firstInput.message;
    retryInput.authority.rootSourceId = firstInput.authority.rootSourceId;
    retryInput.authority.lineageKey = firstInput.authority.lineageKey;
    retryInput.context.retry = {
      retryOfTurnId: first.turnId,
      canonicalMessageId: firstInput.message.messageId
    };
    const retry = store.createCanonicalVisibleTurnInternal({
      envelope: retryInput,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: Number(store.getInteractionLane('yuqi', 'private_chat').revision),
      inputUserBatchId: first.inputUserBatchId,
      inputVisibilitySequence: 2,
      inputClearEpoch: first.inputClearEpoch,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: first.annotationSnapshot
    }).turn;
    terminal = retry;
  }
  const actionDraft = { kind: 'moment_create', payload: { text: 'redaction action' } };
  const resolved = store.resolveCanonicalActionTargetInternal({ turn: terminal, action: actionDraft });
  const actionSet = [{ ...actionDraft, targetKey: resolved.targetKey, targetRevision: resolved.targetRevision }];
  const visibleGroup = {
    items: [0, 1, 2].map(offset => ({
      content: `reply ${offset}`,
      speakerId: 'yuqi', speakerType: 'character', recipientId: 'user'
    }))
  };
  const state = store.getCognitiveState('yuqi');
  committed = commitVisibleResult({
    store,
    turnId: terminal.turnId,
    authorityLineageKey: terminal.authorityLineageKey,
    laneKey: terminal.laneKey,
    expectedTurnRevision: terminal.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(terminal.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', terminal.laneKey).revision,
    expectedCognitiveStateRevision: Number(state?.revision || 0),
    expectedLatestUserBatchId: terminal.inputUserBatchId,
    inputVisibilitySequence: terminal.inputVisibilitySequence,
    inputClearEpoch: terminal.inputClearEpoch,
    protocolVersion: terminal.protocolVersion,
    turnKind: terminal.rolloutKey,
    agencySnapshotChecksum: terminal.agencySnapshotChecksum,
    authoritativeReleaseId: terminal.authoritativeReleaseId,
    visibleGroup,
    actionSet,
    proactiveMotiveEvidenceIds: [],
    statePatch: {
      mood: 'warm',
      currentStances: [{
        operation: 'create',
        stanceId: 'stance_redaction_fixture',
        topic: 'topic',
        position: 'position',
        reason: 'reason',
        strength: 0.7,
        flexibility: 0.8,
        evidenceMessageIds: [terminal.inputUserBatchId
          ? JSON.parse(terminal.envelopeJson).message.messageId : 'msg_redact_2_2'],
        expiresAt: 1784400090000,
        remainingRelevantUserBatches: 3
      }],
      openThreads: []
    },
    memoryJobs: [{
      jobId: 'job_redaction_fixture',
      jobType: 'turn_consolidation',
      dueAt: 1784400023000,
      workerId: 'worker_redaction',
      payload: {
        turnId: terminal.turnId,
        createdAt: 1784400023000,
        cognitionPacketChecksum: 'b'.repeat(64),
        resultingCognitiveStateChecksum: 'c'.repeat(64)
      }
    }],
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: terminal.characterId,
      laneKey: terminal.laneKey,
      inputVisibilitySequence: terminal.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: terminal.agencySnapshotChecksum
    }),
    now: 1784400021000
  });
  if (!store.getInteractionLane('other', 'private_chat')) {
    store.claimInteractionLaneInternal({
      roleId: 'other', laneKey: 'private_chat', expectedRevision: 0,
      clearEpoch: 0, clearedThroughSequence: 0, localSequence: 0,
      now: 1784400000000
    });
  }
  const aboveInput = legacyV2AboveEnvelope('turn_legacy_above', 'other', 'device_other_above');
  const above = store.createTurnWithReleasePinInternal({
    envelope: aboveInput,
    rolloutKey: 'DIRECT_REPLY',
    laneKey: 'private_chat',
    expectedLaneRevision: Number(store.getInteractionLane('other', 'private_chat').revision),
    inputVisibilitySequence: 3,
    presetVersion: rollout.presetVersion,
    annotationSnapshot: {}
  });
  if (deliveryState === 'mailboxed' || deliveryState === 'confirmed') {
    const delivery = store.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id LIMIT 1'
    ).get(terminal.turnId);
    const deliveryPayload = canonicalJson({
      groupId: committed.visibleGroupId,
      commitChecksum: committed.commitChecksum
    });
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = ?, payload_json = ?, checksum = ?, attempts = 1,
          relay_message_id = ?, delivered_at = ?, confirmed_at = ?, updated_at = ?
      WHERE turn_id = ? AND peer_id = ?
    `).run(
      deliveryState,
      deliveryPayload,
      contentHash(JSON.parse(deliveryPayload)),
      `relay_${terminal.turnId}`,
      1784400021100,
      deliveryState === 'confirmed' ? 1784400021200 : null,
      1784400021300,
      delivery.turn_id,
      delivery.peer_id
    );
  }
  return {
    first,
    terminal,
    committed: store.getTurn(committed.authoritativeTurnId),
    groupId: committed.visibleGroupId,
    lineageKey: terminal.authorityLineageKey,
    above
  };
}

function canonicalAuthoritySnapshot(store, turnId) {
  const turn = store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId);
  const lineage = store.db.prepare('SELECT * FROM turn_authority_lineages WHERE lineage_key = ?')
    .get(turn.authority_lineage_key);
  return {
    turn,
    lineage,
    batches: store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(turnId),
    batchItems: store.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(turnId),
    messages: store.db.prepare('SELECT * FROM messages WHERE turn_id = ? ORDER BY message_id').all(turnId),
    deliveries: store.db.prepare('SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id').all(turnId)
  };
}

function redactionDatabaseSnapshot(store) {
  const tables = [
    'interaction_lanes', 'conversation_clear_controls', 'turns',
    'turn_authority_lineages', 'current_user_batches', 'current_user_batch_items',
    'messages', 'visible_result_groups', 'visible_result_items',
    'visible_result_actions', 'visible_result_manifests', 'visible_commit_receipts',
    'cloud_deliveries', 'annotations', 'diagnostics', 'consolidation_jobs',
    'stance_records', 'cognitive_states', 'sessions', 'sync_log'
  ];
  return Object.fromEntries(tables.map(table => [table,
    store.db.prepare(`SELECT * FROM "${table}"`).all()
      .map(row => JSON.stringify(row)).sort()
  ]));
}

for (const deliveryState of ['waiting', 'mailboxed', 'confirmed']) {
  test(`canonical RA1 ${deliveryState} delivery closes with exact redaction lifecycle`, () => {
    const { dir, path } = tempPath(`yuqi-clear-${deliveryState}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createCanonicalRedactionFixture(store, { deliveryState });
      const beforeTurns = store.db.prepare(`
        SELECT turn_id, turn_revision, input_clear_epoch, input_visibility_sequence
        FROM turns WHERE authority_lineage_key = ? ORDER BY lineage_revision_at_creation, turn_id
      `).all(fixture.lineageKey);
      store.applyConversationClearInternal(emptySessionClear({ clearedThroughSequence: 2 }), {
        appliedAt: 1784400035000
      });
      const afterTurns = store.db.prepare(`
        SELECT turn_id, turn_revision, input_clear_epoch, input_visibility_sequence
        FROM turns WHERE authority_lineage_key = ? ORDER BY lineage_revision_at_creation, turn_id
      `).all(fixture.lineageKey);
      assert.deepEqual(afterTurns, beforeTurns);
      const delivery = store.db.prepare(
        'SELECT state, relay_message_id, payload_json, checksum, redaction_requested_at, redaction_acknowledged_at '
        + 'FROM cloud_deliveries WHERE authority_group_id = ?'
      ).get(fixture.groupId);
      if (deliveryState === 'waiting') {
        assert.equal(delivery.state, 'redacted');
        assert.equal(delivery.relay_message_id, null);
        assert.equal(delivery.payload_json, null);
        assert.equal(delivery.checksum, null);
        assert.equal(delivery.redaction_requested_at, null);
        assert.equal(delivery.redaction_acknowledged_at, 1784400035000);
      } else {
        assert.equal(delivery.state, 'redaction_pending');
        assert.equal(delivery.relay_message_id, `relay_${fixture.terminal.turnId}`);
        assert.equal(delivery.payload_json, null);
        assert.equal(delivery.checksum, null);
        assert.equal(delivery.redaction_requested_at, 1784400035000);
        assert.equal(delivery.redaction_acknowledged_at, null);
      }
      store.close();
      const reopened = new YuqiStore(path);
      assert.doesNotThrow(() => reopened.assertVisibleGroupAuthorityInternal(
        fixture.groupId, { purpose: 'reopen' }
      ));
      reopened.close();
    } finally {
      closeDir(dir);
    }
  });
}

test('redaction delivery authority conflict quarantines once and reopens as a non-semantic shell', () => {
  const { dir, path } = tempPath('yuqi-redaction-quarantine-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { deliveryState: 'mailboxed' });
    store.applyConversationClearInternal(emptySessionClear({ clearedThroughSequence: 2 }), {
      appliedAt: 1784400036000
    });
    const before = store.db.prepare(`
      SELECT peer_id, state, payload_json, checksum, attempts, relay_message_id,
             redaction_requested_at, redaction_acknowledged_at FROM cloud_deliveries
      WHERE authority_group_id = ?
    `).get(fixture.groupId);
    const first = store.quarantineRedactionDeliveryInternal({
      turnId: fixture.committed.turnId,
      peerId: before.peer_id,
      relayMessageId: before.relay_message_id,
      requestAt: before.redaction_requested_at,
      reasonCode: 'authority_conflict'
    });
    const second = store.quarantineRedactionDeliveryInternal({
      turnId: fixture.committed.turnId,
      peerId: before.peer_id,
      relayMessageId: before.relay_message_id,
      requestAt: before.redaction_requested_at,
      reasonCode: 'authority_conflict'
    });
    assert.equal(first.quarantineOutcome, 'quarantined');
    assert.equal(second.quarantineOutcome, 'already_quarantined');
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS value FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_redaction_delivery_quarantined'
    `).get(fixture.committed.turnId).value, 1);
    store.close();
    const reopened = new YuqiStore(path);
    assert.equal(reopened.db.prepare(`
      SELECT state, payload_json, checksum, relay_message_id
      FROM cloud_deliveries WHERE authority_group_id = ?
    `).get(fixture.groupId).state, 'quarantined');
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('live legacy turns expose no redacted status until a validated shell exists', () => {
  const { dir, path } = tempPath('yuqi-live-legacy-status-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    assert.equal(store.publicLegacyRedactedTurnStatusInternal(fixture.v2.turnId), null);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('canonical RA1 corrupted commitment is rejected with zero writes', () => {
  const { dir, path } = tempPath('yuqi-clear-corrupt-commitment-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store);
    store.db.prepare('UPDATE visible_result_groups SET tombstone_commitment = ? WHERE group_id = ?')
      .run('f'.repeat(64), fixture.groupId);
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400036000 }
    ), /authority|commitment|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutateEnvelope] of [
  ['missing protocol', envelope => { delete envelope.protocolVersion; }],
  ['string protocol', envelope => { envelope.protocolVersion = '3'; }],
  ['fractional protocol', envelope => { envelope.protocolVersion = 3.5; }],
  ['unknown protocol', envelope => { envelope.protocolVersion = 4; }],
  ['null protocol', envelope => { envelope.protocolVersion = null; }]
]) {
  test(`canonical RA1 ${label} is rejected before affected-set filtering`, () => {
    const { dir, path } = tempPath(`yuqi-clear-malformed-envelope-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createCanonicalRedactionFixture(store);
      const envelope = JSON.parse(fixture.terminal.envelopeJson);
      mutateEnvelope(envelope);
      store.db.prepare('UPDATE turns SET envelope_json = ? WHERE turn_id = ?')
        .run(JSON.stringify(envelope), fixture.terminal.turnId);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400036500 }
      ), /envelope|protocol|authority|conflict/i);
      assert.deepEqual(redactionDatabaseSnapshot(store), before);
      store.close();
    } finally {
      closeDir(dir);
    }
  });
}

test('canonical RA1 corrupt null-group failure delivery is rejected before deletion', () => {
  const { dir, path } = tempPath('yuqi-clear-corrupt-failure-delivery-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store);
    const failedTurnId = fixture.first.turnId;
    store.db.prepare(`UPDATE cloud_deliveries
      SET payload_json = ?, checksum = ?, attempts = 1, updated_at = ?
      WHERE turn_id = ? AND authority_group_id IS NULL`).run(
      '{"failure":"corrupt"}', 'f'.repeat(64), 1784400025000, failedTurnId
    );
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400036600 }
    ), /failure|delivery|authority|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('canonical RA1 post-audit shell validation failure rolls back the complete transaction', () => {
  const { dir, path } = tempPath('yuqi-clear-post-audit-shell-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store);
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), {
        appliedAt: 1784400036700,
        faultAfterStep: 'after_audit_invalid_shell'
      }
    ), /redacted|shell|fault|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('canonical RA1 null visibility sequence fails closed with zero writes', () => {
  const { dir, path } = tempPath('yuqi-clear-null-sequence-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store);
    store.db.prepare('UPDATE turns SET input_visibility_sequence = NULL WHERE turn_id = ?')
      .run(fixture.terminal.turnId);
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400037000 }
    ), /sequence|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('canonical RA1 open lineage is cancelled and reopens as a redacted shell', () => {
  const { dir, path } = tempPath('yuqi-clear-open-lineage-');
  try {
    const store = new YuqiStore(path);
    ensureDirectRollout(store);
    seedPrivateLane(store, { now: 1784400000000 });
    const input = canonicalRedactionEnvelope(1);
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: input.createdAt });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: input,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 1,
      inputUserBatchId: input.context.currentBatch.batchId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    const proof = store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 1 }), { appliedAt: 1784400038000 }
    );
    assert.equal(proof.type, 'CONVERSATION_CLEAR_APPLIED');
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    assert.equal(lineage.state, 'cancelled');
    assert.equal(lineage.committedGroupId, null);
    assert.doesNotThrow(() => store.assertRedactedLineageAuthorityInternal(
      turn.authorityLineageKey, { purpose: 'reopen' }
    ));
    store.close();
    const reopened = new YuqiStore(path);
    assert.doesNotThrow(() => reopened.assertRedactedLineageAuthorityInternal(
      turn.authorityLineageKey, { purpose: 'reopen' }
    ));
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

for (const faultAfterStep of [
  'after_direct_refs', 'after_batches', 'after_messages', 'after_group',
  'after_delivery', 'after_audit', 'after_lane_update',
  'after_control_insert', 'after_post_write_validation', 'after_applied_projection'
]) {
  test(`canonical RA1 fault ${faultAfterStep} rolls back the complete clear transaction`, () => {
    const { dir, path } = tempPath(`yuqi-clear-fault-${faultAfterStep}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createCanonicalRedactionFixture(store);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 2 }), {
          appliedAt: 1784400040000,
          faultAfterStep
        }
      ), /forced conversation clear fault/i);
      assert.deepEqual(redactionDatabaseSnapshot(store), before);
      store.close();
      const reopened = new YuqiStore(path);
      assert.deepEqual(redactionDatabaseSnapshot(reopened), before);
      reopened.close();
    } finally {
      closeDir(dir);
    }
  });
}

test('canonical RA1 clear redacts a real three-bubble retry lineage and preserves above-boundary bytes', () => {
  const { dir, path } = tempPath('yuqi-clear-canonical-redaction-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { deliveryState: 'waiting' });
    assert.doesNotThrow(() => store.assertVisibleGroupAuthorityInternal(fixture.groupId, { purpose: 'reopen' }));
    const aboveBefore = canonicalAuthoritySnapshot(store, fixture.above.turnId);
    const targetTurnIds = store.db.prepare(
      'SELECT turn_id FROM turns WHERE authority_lineage_key = ? ORDER BY turn_id'
    ).all(fixture.lineageKey).map(row => row.turn_id);
    store.db.prepare(`INSERT INTO annotations(
      annotation_id, turn_id, source_message_id, preset_version, annotation_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'annotation_redaction_fixture', targetTurnIds[0], null, '1.9.2', '{}', 'active', 1784400022000
    );
    store.db.prepare(`INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(targetTurnIds[0], 'brain', 'error', '{"secret":"x"}', 1784400022001);
    store.db.prepare(`INSERT INTO sessions(role, thread_id, turn_count, updated_at)
      VALUES ('yuqi', 'unrelated_thread', 1, ?)`).run(1784400023000);
    store.db.prepare(`INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES ('turn', ?, 'update', ?, ?, ?)`).run(
      targetTurnIds[0], '{}', contentHash({}), 1784400023000
    );
    store.db.prepare(`UPDATE interaction_lanes
      SET generating_turn_id = ?, latest_authoritative_group_id = ?,
          native_completed_group_id = ?, ui_applied_group_id = ?
      WHERE role_id = 'yuqi' AND lane_key = 'private_chat'`).run(
      targetTurnIds.at(-1), fixture.groupId, fixture.groupId, fixture.groupId
    );
    const clear = emptySessionClear({ clearedThroughSequence: 2 });
    const applied = store.applyConversationClearInternal(clear, { appliedAt: 1784400030000 });
    assert.equal(applied.type, 'CONVERSATION_CLEAR_APPLIED');
    assert.equal(store.db.prepare(
      'SELECT redacted_at FROM visible_result_groups WHERE group_id = ?'
    ).get(fixture.groupId).redacted_at, 1784400030000);
    assert.equal(store.db.prepare(
      'SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id IN '
      + '(SELECT turn_id FROM turns WHERE authority_lineage_key = ?) AND authority_group_id IS NULL'
    ).get(fixture.lineageKey).value, 0);
    assert.doesNotThrow(() => store.assertVisibleGroupAuthorityInternal(
      fixture.groupId, { purpose: 'reopen' }
    ));
    store.close();
    const reopened = new YuqiStore(path);
    assert.doesNotThrow(() => reopened.assertVisibleGroupAuthorityInternal(
      fixture.groupId, { purpose: 'reopen' }
    ));
    assert.deepEqual(
      reopened.applyConversationClearInternal(clear, { appliedAt: 1784400040000 }),
      applied
    );
    assert.deepEqual(canonicalAuthoritySnapshot(reopened, fixture.above.turnId), aboveBefore);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM annotations WHERE turn_id IN ('
      + targetTurnIds.map(() => '?').join(',') + ')').get(...targetTurnIds).value, 0);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM diagnostics WHERE turn_id IN ('
      + targetTurnIds.map(() => '?').join(',') + ')').get(...targetTurnIds).value, 0);
    assert.deepEqual(reopened.db.prepare(`
      SELECT state, lease_owner, lease_expires_at, last_error_code
      FROM consolidation_jobs WHERE authority_group_id = ?
    `).all(fixture.groupId).map(row => ({ ...row })), [{
      state: 'cancelled', lease_owner: null, lease_expires_at: null,
      last_error_code: 'SOURCE_REDACTED'
    }]);
    assert.equal(reopened.db.prepare(`SELECT COUNT(*) AS value FROM stance_records
      WHERE authority_group_id = ? AND revision = (
        SELECT MAX(latest.revision) FROM stance_records latest
        WHERE latest.stance_id = stance_records.stance_id
      )`).get(fixture.groupId).value, 0);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM cognitive_states WHERE last_authority_group_id = ?')
      .get(fixture.groupId).value, 0);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM sessions WHERE role = 'yuqi'").get().value, 0);
    assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM sync_log WHERE entity_id = ? AND entity_type != 'authority_redaction'")
      .get(targetTurnIds[0]).value, 0);
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

function legacyV1ScrubEnvelope(turnId, deviceId, deviceSeq) {
  return {
    protocolVersion: 1,
    turnId,
    characterId: 'yuqi',
    deviceId,
    deviceSeq,
    createdAt: 1784400100000 + deviceSeq,
    message: {
      messageId: `msg_${turnId}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: 'legacy private plaintext',
      sentAt: 1784400100000 + deviceSeq
    }
  };
}

function legacyV2ScrubEnvelope(
  turnId, deviceId, deviceSeq, roleId = 'yuqi', kind = 'DIRECT_REPLY'
) {
  const envelope = {
    protocolVersion: 2,
    turnId,
    characterId: roleId,
    deviceId,
    deviceSeq,
    createdAt: 1784400101000 + deviceSeq,
    kind,
    message: {
      messageId: `msg_${turnId}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: roleId,
      content: 'legacy v2 private plaintext',
      sentAt: 1784400101000 + deviceSeq
    }
  };
  if (kind === 'PROACTIVE_MOMENT') {
    delete envelope.message;
    envelope.trigger = {
      triggerId: `trigger_${turnId}`,
      triggerType: 'proactive_moment',
      scheduledFor: envelope.createdAt,
      executedAt: envelope.createdAt
    };
  }
  return envelope;
}

function legacyV2ThreeBubbleEnvelope(turnId = 'turn_ra0_v2_three', deviceId = 'device_v2_three') {
  const messages = [1, 2, 3].map(index => ({
    messageId: `msg_${turnId}_${index}`,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `legacy v2 bubble ${index}`,
    sentAt: 1784400101000 + index
  }));
  const envelope = legacyV2ScrubEnvelope(turnId, deviceId, 88);
  envelope.message = messages[2];
  envelope.context = {
    currentBatch: {
      batchId: `batch_${turnId}`,
      messageIds: messages.map(message => message.messageId),
      startedAt: messages[0].sentAt,
      committedAt: messages[2].sentAt,
      messages
    }
  };
  return envelope;
}

function createAuthorityV0ScrubFixture(store) {
  if (!store.getInteractionLane('yuqi', 'private_chat')) {
    seedPrivateLane(store, { now: 1784400100000 });
  }
  const makeTurn = (envelope, { failed = false } = {}) => {
    const turn = store.submitTurn(envelope);
    store.claimTurnById(turn.turnId, `legacy-worker-${turn.turnId}`);
    store.advanceTurn(turn.turnId, 'memory_running', failed ? 'failed' : 'memory_done', {
      memoryPacketJson: JSON.stringify({ secretMemory: 'legacy memory secret' }),
      brainDraftJson: JSON.stringify({ reply: 'legacy failed draft secret' }),
      ...(failed ? {
        errorJson: JSON.stringify({ name: 'LegacyError', message: 'legacy error secret' })
      } : {})
    });
    if (failed) return store.getTurn(turn.turnId);
    store.advanceTurn(turn.turnId, 'memory_done', 'brain_running');
    store.advanceTurn(turn.turnId, 'brain_running', 'brain_done', {
      brainDraftJson: JSON.stringify({ reply: 'legacy brain secret' })
    });
    store.advanceTurn(turn.turnId, 'brain_done', 'supervisor_running');
    store.advanceTurn(turn.turnId, 'supervisor_running', 'approved', {
      supervisorJson: JSON.stringify({ approved: true, secret: 'legacy supervisor secret' })
    });
    store.advanceTurn(turn.turnId, 'approved', 'committed', {
      replyJson: JSON.stringify({
        reply: { content: 'legacy reply secret' },
        actions: [{ kind: 'legacy_action', payload: { secret: 'legacy action secret' } }],
        route: 'legacy route secret'
      })
    });
    store.putMessage({
      messageId: `msg_reply_${turn.turnId}`,
      turnId: turn.turnId,
      characterId: 'yuqi',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user',
      content: 'legacy reply message secret',
      sentAt: 1784400105000,
      origin: 'legacy'
    });
    return store.getTurn(turn.turnId);
  };
  const v1 = makeTurn(legacyV1ScrubEnvelope('turn_ra0_v1', 'device_v1', 1));
  // RA0/v1 historical turns have no current-user-batch authority.  The
  // submit path may materialize a compatibility batch; remove it here so the
  // positive scrub fixture reflects the real legacy shape and the preflight
  // rejection is exercised separately below.
  store.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ?').run(v1.turnId);
  store.db.prepare('DELETE FROM current_user_batches WHERE turn_id = ?').run(v1.turnId);
  const v2 = makeTurn(legacyV2ScrubEnvelope('turn_ra0_v2', 'device_v2', 2));
  const failed = makeTurn(
    legacyV2ScrubEnvelope('turn_ra0_failed', 'device_failed', 3),
    { failed: true }
  );
  const confirmed = makeTurn(legacyV2ScrubEnvelope('turn_ra0_confirmed', 'device_confirmed', 4));
  const delivered = makeTurn(legacyV2ScrubEnvelope('turn_ra0_delivered', 'device_delivered', 5));
  const publicMoment = makeTurn(legacyV2ScrubEnvelope(
    'turn_ra0_public_moment', 'device_public_moment', 6, 'yuqi', 'PROACTIVE_MOMENT'
  ));
  const targetTurns = [v1, v2, failed, confirmed, delivered];
  const deliveryStates = new Map([
    [v1.turnId, 'waiting'],
    [v2.turnId, 'pending'],
    [failed.turnId, 'mailboxed'],
    [confirmed.turnId, 'confirmed'],
    [delivered.turnId, 'delivered']
  ]);
  for (const turn of targetTurns) {
    store.registerCloudDelivery(turn.turnId, 'phone_legacy', 7);
    const state = deliveryStates.get(turn.turnId);
    if (state !== 'waiting') {
      const prepared = store.prepareCloudDelivery(turn.turnId, 'phone_legacy', {
        turnId: turn.turnId,
        secret: 'legacy delivery secret'
      });
      if (state !== 'pending') {
        store.markCloudDeliveryAttempt(turn.turnId, 'phone_legacy');
        store.markCloudDeliveryMailboxed(turn.turnId, 'phone_legacy', prepared.checksum);
      }
      if (state === 'confirmed') {
        const message = store.getMessage(`msg_reply_${turn.turnId}`);
        const contentSha256 = createHash('sha256').update(message.content, 'utf8').digest('hex');
        store.confirmCloudDelivery(turn.turnId, 'phone_legacy', {
          messageId: message.messageId,
          contentSha256,
          receivedAt: Date.now() + 1000
        });
        // The legacy API does not persist a stable relay identity; keep only
        // that historical transport fact as a deterministic raw fixture.
        store.db.prepare(`
          UPDATE cloud_deliveries SET relay_message_id = ?
          WHERE turn_id = ? AND peer_id = ?
        `).run(stableId('relay_pc', `${turn.turnId}:phone_legacy:${prepared.checksum}`),
          turn.turnId, 'phone_legacy');
      } else if (state === 'delivered') {
        // Explicit historical compatibility shape: delivered without a
        // receipt/confirmedAt, but with the production relay identity.
        store.db.prepare(`
          UPDATE cloud_deliveries SET state = 'delivered', confirmed_at = NULL,
            relay_message_id = ?
          WHERE turn_id = ? AND peer_id = ?
        `).run(stableId('relay_pc', `${turn.turnId}:phone_legacy:${prepared.checksum}`),
          turn.turnId, 'phone_legacy');
      } else if (state === 'mailboxed') {
        store.db.prepare(`
          UPDATE cloud_deliveries SET relay_message_id = ?
          WHERE turn_id = ? AND peer_id = ?
        `).run(stableId('relay_pc', `${turn.turnId}:phone_legacy:${prepared.checksum}`),
          turn.turnId, 'phone_legacy');
      }
    }
    store.putDiagnostic({
      turnId: turn.turnId,
      stage: 'legacy_secret',
      level: 'error',
      detail: { secret: 'legacy diagnostic secret' }
    });
  }
  store.db.prepare('INSERT INTO sessions(role, thread_id, turn_count, updated_at) VALUES (?, ?, ?, ?)')
    .run('yuqi', 'legacy-session', 3, 1784400106000);
  const other = store.submitTurn(legacyV2ScrubEnvelope(
    'turn_other_role', 'device_other', 1, 'other'
  ));
  const publicBefore = store.db.prepare(
    'SELECT * FROM turns WHERE turn_id = ?'
  ).get(publicMoment.turnId);
  const publicScopeBefore = {
    turn: publicBefore,
    messages: store.db.prepare('SELECT * FROM messages WHERE turn_id = ?').all(publicMoment.turnId),
    batches: store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(publicMoment.turnId),
    batchItems: store.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ?').all(publicMoment.turnId),
    sync: store.db.prepare('SELECT * FROM sync_log WHERE entity_id = ? ORDER BY seq').all(publicMoment.turnId)
  };
  const targetIds = targetTurns.map(turn => turn.turnId);
  const deliveryBefore = store.db.prepare(`
    SELECT turn_id, peer_id, state, payload_json, checksum, relay_message_id,
           delivered_at, confirmed_at, recovery_ack_seq
    FROM cloud_deliveries WHERE turn_id IN (${targetIds.map(() => '?').join(',')})
    ORDER BY turn_id, peer_id
  `).all(...targetIds).map(row => ({ ...row }));
  const before = redactionDatabaseSnapshot(store);
  const immutable = store.db.prepare(`
    SELECT turn_id, character_id, device_id, device_seq, source_message_id,
           envelope_checksum, result_authority_version
    FROM turns WHERE turn_id IN (${targetIds.map(() => '?').join(',')}) ORDER BY turn_id
  `).all(...targetIds).map(row => ({ ...row }));
  return {
    v1, v2, failed, confirmed, delivered, publicMoment, other, publicBefore, publicScopeBefore,
    targetIds, before, immutable, deliveryBefore
  };
}

function createCanonicalV2TurnFixture(store, { kind, laneKey, index }) {
  const envelope = canonicalRedactionEnvelope(index);
  envelope.protocolVersion = 2;
  envelope.kind = kind;
  delete envelope.authority;
  if (kind === 'MOMENT_REPLY' || kind === 'PROACTIVE_MOMENT') {
    delete envelope.message;
    delete envelope.context;
    envelope.trigger = {
      triggerId: `trigger_legacy_moment_${index}`,
      triggerType: kind === 'MOMENT_REPLY' ? 'moment_reply' : 'proactive_moment',
      scheduledFor: envelope.createdAt,
      executedAt: envelope.createdAt,
      ...(kind === 'MOMENT_REPLY' ? { context: {
        targetMoment: { momentId: 'moment_legacy', authorType: 'user', authorId: 'user' },
        targetComment: { commentId: 'comment_legacy', authorType: 'user', authorId: 'user' }
      } } : {})
    };
  }
  const lane = store.getInteractionLane('yuqi', laneKey)
    || store.claimInteractionLaneInternal({
      roleId: 'yuqi', laneKey, expectedRevision: 0,
      clearEpoch: 0, clearedThroughSequence: 0, localSequence: 0,
      now: 1784400100000
    });
  const rollout = store.getCognitionRollout(kind);
  if (!rollout) throw new Error(`missing rollout fixture: ${kind}`);
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
  const turn = store.createCanonicalVisibleTurnInternal({
    envelope,
    rolloutKey: kind,
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey,
    expectedLaneRevision: Number(lane.revision),
    inputUserBatchId: envelope.context?.currentBatch?.batchId || envelope.trigger?.triggerId,
    inputVisibilitySequence: Number(lane.localSequence || 0),
    inputClearEpoch: Number(lane.clearEpoch || 0),
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
  const before = store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turn.turnId);
  return { turn, before };
}

function createCanonicalV3PublicMomentFixture(store) {
  const triggerId = 'trigger_public_moment_v3_scrub';
  const envelope = {
    protocolVersion: 3,
    turnId: 'turn_public_moment_v3_scrub',
    characterId: 'yuqi',
    deviceId: 'device_public_v3',
    deviceSeq: 30,
    createdAt: 1784400103000,
    kind: 'PROACTIVE_MOMENT',
    trigger: {
      triggerId,
      triggerType: 'proactive_moment',
      scheduledFor: 1784400103000,
      executedAt: 1784400103000,
      context: {}
    },
    context: {
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
        chatOpen: true,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey: 'public_moment',
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey: 'public_moment', rootSourceId: triggerId
      }),
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  };
  const lane = store.getInteractionLane('yuqi', 'public_moment')
    || store.claimInteractionLaneInternal({
      roleId: 'yuqi', laneKey: 'public_moment', expectedRevision: 0,
      clearEpoch: 0, clearedThroughSequence: 0, localSequence: 0,
      now: 1784400100000
    });
  const rollout = store.getCognitionRollout('PROACTIVE_MOMENT');
  const authority = store.rebuildPublicMomentAuthorityInternal({ envelope });
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi', at: envelope.createdAt
  });
  const turn = store.createCanonicalVisibleTurnInternal({
    envelope,
    rolloutKey: 'PROACTIVE_MOMENT',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'public_moment',
    expectedLaneRevision: Number(lane.revision),
    inputUserBatchId: triggerId,
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: { publicMomentAuthority: authority }
  }).turn;
  const contextRevision = contentHash({
    agencySnapshotChecksum: agency.checksum,
    momentTargetAuthorityChecksum: authority.checksum
  });
  const fingerprint = generationFingerprint({
    roleId: 'yuqi',
    laneKey: 'public_moment',
    inputVisibilitySequence: turn.inputVisibilitySequence,
    visibleGroup: { items: [] },
    actionSet: [],
    contextRevision
  });
  const committed = commitVisibleResult({
    store,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', 'public_moment').revision,
    expectedCognitiveStateRevision: Number(store.getCognitiveState('yuqi')?.revision || 0),
    expectedLatestUserBatchId: triggerId,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    inputClearEpoch: 0,
    protocolVersion: 3,
    turnKind: 'PROACTIVE_MOMENT',
    agencySnapshotChecksum: agency.checksum,
    authoritativeReleaseId: rollout.stableReleaseId,
    visibleGroup: { items: [] },
    actionSet: [],
    publicMomentEvidenceIds: [],
    statePatch: null,
    memoryJobs: [],
    comparisonJob: null,
    generationFingerprint: fingerprint,
    now: 1784400104000
  });
  const groupId = committed.visibleGroupId;
  const snapshot = {
    lane: store.db.prepare(
      'SELECT * FROM interaction_lanes WHERE role_id = ? AND lane_key = ?'
    ).get('yuqi', 'public_moment'),
    turn: store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turn.turnId),
    lineage: store.db.prepare(
      'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
    ).get(turn.authorityLineageKey),
    batches: store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(turn.turnId),
    batchItems: store.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ?').all(turn.turnId),
    messages: store.db.prepare('SELECT * FROM messages WHERE turn_id = ?').all(turn.turnId),
    groups: store.db.prepare('SELECT * FROM visible_result_groups WHERE group_id = ?').all(groupId),
    items: store.db.prepare('SELECT * FROM visible_result_items WHERE group_id = ?').all(groupId),
    actions: store.db.prepare('SELECT * FROM visible_result_actions WHERE group_id = ?').all(groupId),
    manifests: store.db.prepare('SELECT * FROM visible_result_manifests WHERE group_id = ?').all(groupId),
    receipts: store.db.prepare('SELECT * FROM visible_commit_receipts WHERE group_id = ?').all(groupId),
    deliveries: store.db.prepare('SELECT * FROM cloud_deliveries WHERE authority_group_id = ?').all(groupId),
    diagnostics: store.db.prepare('SELECT * FROM diagnostics WHERE turn_id = ?').all(turn.turnId),
    jobs: store.db.prepare('SELECT * FROM consolidation_jobs WHERE authority_group_id = ?').all(groupId),
    sync: store.db.prepare(
      'SELECT * FROM sync_log WHERE entity_id IN (?, ?, ?) ORDER BY seq'
    ).all(turn.turnId, turn.authorityLineageKey, groupId)
  };
  return { turn, groupId, snapshot };
}

function readCanonicalV3PublicMomentSnapshot(store, fixture) {
  return {
    lane: store.db.prepare(
      'SELECT * FROM interaction_lanes WHERE role_id = ? AND lane_key = ?'
    ).get('yuqi', 'public_moment'),
    turn: store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.turn.turnId),
    lineage: store.db.prepare(
      'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
    ).get(fixture.turn.authorityLineageKey),
    batches: store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(fixture.turn.turnId),
    batchItems: store.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ?').all(fixture.turn.turnId),
    messages: store.db.prepare('SELECT * FROM messages WHERE turn_id = ?').all(fixture.turn.turnId),
    groups: store.db.prepare('SELECT * FROM visible_result_groups WHERE group_id = ?').all(fixture.groupId),
    items: store.db.prepare('SELECT * FROM visible_result_items WHERE group_id = ?').all(fixture.groupId),
    actions: store.db.prepare('SELECT * FROM visible_result_actions WHERE group_id = ?').all(fixture.groupId),
    manifests: store.db.prepare('SELECT * FROM visible_result_manifests WHERE group_id = ?').all(fixture.groupId),
    receipts: store.db.prepare('SELECT * FROM visible_commit_receipts WHERE group_id = ?').all(fixture.groupId),
    deliveries: store.db.prepare('SELECT * FROM cloud_deliveries WHERE authority_group_id = ?').all(fixture.groupId),
    diagnostics: store.db.prepare('SELECT * FROM diagnostics WHERE turn_id = ?').all(fixture.turn.turnId),
    jobs: store.db.prepare('SELECT * FROM consolidation_jobs WHERE authority_group_id = ?').all(fixture.groupId),
    sync: store.db.prepare(
      'SELECT * FROM sync_log WHERE entity_id IN (?, ?, ?) ORDER BY seq'
    ).all(fixture.turn.turnId, fixture.turn.authorityLineageKey, fixture.groupId)
  };
}

test('authority-v0 v1/v2 Yuqi scrub clears plaintext and legacy recovery/delivery surfaces without RA1 upgrade', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-');
  try {
     const store = new YuqiStore(path);
     store.initializeCognitionRolloutsInternal({
       rows: [
         { rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
           presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64) },
         { rolloutKey: 'PROACTIVE_MOMENT', currentMode: 'legacy', rolloutPhase: 'stable',
           presetVersion: '1.9.2', pipelineChecksum: 'b'.repeat(64) }
       ],
       now: 1784400100000
     });
     seedPrivateLane(store, { now: 1784400100000 });
     const canonicalV2Private = createCanonicalV2TurnFixture(
       store, { kind: 'DIRECT_REPLY', laneKey: 'private_chat', index: 20 }
     );
     const canonicalV3Public = createCanonicalV3PublicMomentFixture(store);
     const fixture = createAuthorityV0ScrubFixture(store);
      const otherBefore = store.getTurn(fixture.other.turnId);
    const control = emptySessionClear({ clearedThroughSequence: 3 });
    const applied = store.applyConversationClearInternal(control, { appliedAt: 1784400110000 });
    assert.equal(applied.type, 'CONVERSATION_CLEAR_APPLIED');
     const rows = store.db.prepare(`
       SELECT turn_id, character_id, device_id, device_seq, source_message_id,
              envelope_checksum, result_authority_version, envelope_json,
              input_clear_epoch, input_visibility_sequence,
              memory_packet_json, brain_draft_json, supervisor_json, reply_json,
              error_json, route_reasons_json
       FROM turns WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')}) ORDER BY turn_id
     `).all(...fixture.targetIds);
    assert.deepEqual(rows.map(row => ({
      turn_id: row.turn_id,
      character_id: row.character_id,
      device_id: row.device_id,
      device_seq: row.device_seq,
      source_message_id: row.source_message_id,
      envelope_checksum: row.envelope_checksum,
      result_authority_version: row.result_authority_version
    })), fixture.immutable);
     for (const row of rows) {
       assert.equal(Number(row.result_authority_version), 0);
       assert.equal(row.input_visibility_sequence, null);
       assert.equal(row.input_clear_epoch, 0);
       assert.equal(row.envelope_json, canonicalJson({ redacted: true }));
       assert.equal(row.memory_packet_json, null);
      assert.equal(row.brain_draft_json, null);
      assert.equal(row.supervisor_json, null);
      assert.equal(row.reply_json, null);
      assert.equal(row.error_json, null);
      assert.deepEqual(JSON.parse(row.route_reasons_json), []);
      assert.equal(JSON.stringify(row).includes('secret'), false);
    }
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS value FROM turn_stages
      WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')})`).get(...fixture.targetIds).value, 0);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS value FROM messages
      WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')}) AND content <> ''`)
      .get(...fixture.targetIds).value, 0);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS value FROM diagnostics
      WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')})`).get(...fixture.targetIds).value, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM sessions WHERE role = 'yuqi'").get().value, 0);
    assert.equal(store.listRecoverableTurns().some(turn => fixture.targetIds.includes(turn.turnId)), false);
    assert.equal(store.listPendingCloudDeliveries().some(delivery => fixture.targetIds.includes(delivery.turnId)), false);
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS value FROM cloud_deliveries
      WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')}) AND payload_json IS NOT NULL`)
      .get(...fixture.targetIds).value, 0);
     assert.equal(store.db.prepare(`SELECT COUNT(*) AS value FROM visible_result_groups
       WHERE authoritative_turn_id IN (${fixture.targetIds.map(() => '?').join(',')})`)
       .get(...fixture.targetIds).value, 0);
     const deliveries = store.db.prepare(`
       SELECT turn_id, peer_id, state, payload_json, checksum, relay_message_id,
              delivered_at, confirmed_at, attempts, redaction_requested_at,
              redaction_acknowledged_at, recovery_ack_seq
       FROM cloud_deliveries WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')})
       ORDER BY turn_id, peer_id
     `).all(...fixture.targetIds);
     assert.equal(deliveries.length, fixture.targetIds.length);
     for (const delivery of deliveries) {
       const before = fixture.deliveryBefore.find(row =>
         row.turn_id === delivery.turn_id && row.peer_id === delivery.peer_id);
       assert.ok(before);
       if (before.state === 'waiting') {
         assert.equal(delivery.state, 'redacted');
         assert.equal(delivery.relay_message_id, null);
         assert.equal(delivery.redaction_requested_at, null);
         assert.equal(delivery.redaction_acknowledged_at, 1784400110000);
       } else {
       assert.equal(delivery.state, 'redaction_pending');
         assert.equal(delivery.relay_message_id, before.relay_message_id || stableId(
           'relay_pc', `${before.turn_id}:${before.peer_id}:${before.checksum}`
         ));
         assert.equal(delivery.redaction_requested_at, 1784400110000);
         assert.equal(delivery.redaction_acknowledged_at, null);
       }
       assert.equal(delivery.payload_json, null);
       assert.equal(delivery.checksum, null);
       assert.equal(delivery.attempts, 0);
       assert.equal(Number(delivery.recovery_ack_seq), Number(before.recovery_ack_seq));
     }
     const auditRows = store.db.prepare(`
       SELECT seq, entity_type, entity_id, operation, payload_json, checksum, created_at
       FROM sync_log WHERE entity_type = 'legacy_turn_redaction'
         AND entity_id IN (${fixture.targetIds.map(() => '?').join(',')})
       ORDER BY entity_id
     `).all(...fixture.targetIds);
     assert.equal(auditRows.length, fixture.targetIds.length);
     for (const audit of auditRows) {
       const turn = rows.find(row => row.turn_id === audit.entity_id);
       const beforeDeliveries = fixture.deliveryBefore
         .filter(row => row.turn_id === turn.turn_id)
         .map(row => ({
           peerId: row.peer_id,
           originalState: row.state,
           relayMessageId: row.relay_message_id || (row.checksum
             ? stableId('relay_pc', `${row.turn_id}:${row.peer_id}:${row.checksum}`) : null),
           deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
           confirmedAt: row.confirmed_at == null ? null : Number(row.confirmed_at),
           recoveryAckSeq: Number(row.recovery_ack_seq),
           originalChecksum: row.checksum
         }));
       const payload = JSON.parse(audit.payload_json);
       assert.deepEqual(Object.keys(payload).sort(), [
         'auditVersion', 'controlId', 'deliveryCommitment', 'deliveryCount',
         'deliveries', 'messageTombstoneCommitment', 'messageTombstoneCount',
         'batchTombstoneCommitment', 'batchTombstoneCount', 'protocolVersion',
         'redactedAt', 'roleId', 'turnId'
       ].sort());
       assert.equal(payload.auditVersion, 'legacy_turn_redaction_v1');
       assert.equal(payload.controlId, control.controlId);
       assert.equal(payload.roleId, 'yuqi');
       assert.equal(payload.turnId, turn.turn_id);
       assert.equal(payload.protocolVersion, turn.turn_id === fixture.v1.turnId ? 1 : 2);
       assert.equal(payload.redactedAt, 1784400110000);
       assert.equal(payload.deliveryCount, beforeDeliveries.length);
       assert.deepEqual(payload.deliveries, beforeDeliveries);
       assert.equal(payload.messageTombstoneCount, store.db.prepare(
         'SELECT COUNT(*) AS value FROM messages WHERE turn_id = ?'
       ).get(turn.turn_id).value);
       assert.equal(payload.batchTombstoneCount, turn.turn_id === fixture.v1.turnId ? 0 : 1);
       const persistedMessages = store.db.prepare(
         'SELECT * FROM messages WHERE turn_id = ? ORDER BY message_id'
       ).all(turn.turn_id);
       const persistedItems = store.db.prepare(
         'SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
       ).all(turn.turn_id);
       const itemByMessage = new Map(persistedItems.map(item => [item.message_id, item]));
       const expectedMessageTuples = persistedMessages.map(message => {
         const item = itemByMessage.get(message.message_id);
         return {
           messageId: message.message_id,
           turnId: message.turn_id,
           batchId: item?.batch_id ?? null,
           batchSequence: item == null ? null : Number(item.sequence),
           characterId: message.character_id,
           speakerId: message.speaker_id,
           speakerType: message.speaker_type,
           recipientId: message.recipient_id,
           sentAt: Number(message.sent_at),
           origin: message.origin,
           deviceId: message.device_id ?? null,
           deviceSeq: message.device_seq == null ? null : Number(message.device_seq),
           checksum: message.checksum
         };
       });
       if (expectedMessageTuples.length) {
         assert.deepEqual(Object.keys(expectedMessageTuples[0]).sort(), [
           'batchId', 'batchSequence', 'characterId', 'checksum', 'deviceId',
           'deviceSeq', 'messageId', 'origin', 'recipientId', 'sentAt',
           'speakerId', 'speakerType', 'turnId'
         ].sort());
       }
       assert.equal(payload.messageTombstoneCommitment, contentHash({
         auditVersion: 'legacy-turn-messages-v1',
         turnId: turn.turn_id,
         messages: expectedMessageTuples
       }));
       const persistedBatches = store.db.prepare(
         'SELECT * FROM current_user_batches WHERE turn_id = ? ORDER BY batch_id'
       ).all(turn.turn_id);
       const expectedBatchTuples = persistedBatches.map(batch => {
         const batchItems = persistedItems.filter(item => item.batch_id === batch.batch_id)
           .map(item => ({
             sequence: Number(item.sequence), messageId: item.message_id, checksum: item.checksum
           }));
         return {
           turnId: batch.turn_id,
           batchId: batch.batch_id,
           characterId: batch.character_id,
           sourceMessageId: batch.source_message_id,
           startedAt: Number(batch.started_at),
           committedAt: Number(batch.committed_at),
           checksum: batch.checksum,
           itemCount: Number(batch.item_count),
           itemCommitment: contentHash({
             auditVersion: 'legacy-turn-batch-items-v1',
             turnId: batch.turn_id,
             batchId: batch.batch_id,
             items: batchItems
           })
         };
       });
       if (expectedBatchTuples.length) {
         assert.deepEqual(Object.keys(expectedBatchTuples[0]).sort(), [
           'batchId', 'characterId', 'checksum', 'committedAt', 'itemCommitment',
           'itemCount', 'sourceMessageId', 'startedAt', 'turnId'
         ].sort());
       }
       assert.equal(payload.batchTombstoneCommitment, contentHash({
         auditVersion: 'legacy-turn-batches-v1',
         turnId: turn.turn_id,
         batches: expectedBatchTuples
       }));
       assert.equal(payload.deliveryCommitment, contentHash({
         auditVersion: 'legacy-turn-deliveries-v1',
         turnId: turn.turn_id,
         deliveries: beforeDeliveries
       }));
       assert.equal(audit.operation, 'redact');
       assert.equal(Number(audit.created_at), 1784400110000);
       assert.equal(audit.checksum, contentHash(payload));
     }
     assert.equal(JSON.stringify(store.getTurn(fixture.v2.turnId)).includes('secret'), false);
     assert.equal(JSON.stringify(store.getTurn(fixture.failed.turnId)).includes('secret'), false);
     assert.throws(() => store.recoverFailedDraft(fixture.failed.turnId),
       /redacted|cancelled|authority|conflict/i);
      assert.equal(typeof store.loadValidatedLegacyTurnRedactionInternal, 'function');
      assert.throws(() => publicTurnStatus(store.getTurn(fixture.v2.turnId)),
        /validated|authority|redaction/i);
      assert.throws(() => publicTurnStatus(store.getTurn(fixture.v2.turnId), {
        legacyRedaction: { kind: 'legacy_turn_redaction_v1', turnId: fixture.v2.turnId }
      }), /validated|authority|redaction/i);
      const publicStatus = store.publicLegacyRedactedTurnStatusInternal(fixture.v2.turnId);
      assert.deepEqual(publicStatus, {
        status: 'redacted',
        deliverable: false,
        terminal: true
      });
      assert.equal(JSON.stringify(publicStatus).includes('secret'), false);

      // A redacted RA0 turn must not be writable through any legacy delivery
      // or recovery entry point. Each call is checked against the complete
      // database snapshot so a hidden upsert/updated_at mutation cannot pass.
      const blockedLegacyWriters = [
        () => store.registerCloudDelivery(fixture.v2.turnId, 'phone_legacy', 0),
        () => store.prepareCloudDelivery(fixture.v2.turnId, 'phone_legacy', {
          turnId: fixture.v2.turnId, secret: 'must-not-persist'
        }),
        () => store.markCloudDeliveryAttempt(fixture.v2.turnId, 'phone_legacy'),
        () => store.markCloudDeliveryMailboxed(
          fixture.v2.turnId, 'phone_legacy', 'f'.repeat(64)
        ),
        () => store.confirmCloudDelivery(fixture.v2.turnId, 'phone_legacy', {
          messageId: 'missing-redacted-message',
          contentSha256: '0'.repeat(64),
          receivedAt: 1784400111000
        }),
        () => store.recoverFailedDraft(fixture.v2.turnId, {
          peerId: 'phone_legacy', sentAt: 1784400111000
        }),
        () => store.requeueTransientFailedTurn(fixture.v2.turnId)
      ];
      for (const write of blockedLegacyWriters) {
        const beforeBlocked = redactionDatabaseSnapshot(store);
        assert.throws(write, /redacted|cancelled|authority|conflict|delivery|turn/i);
        assert.deepEqual(redactionDatabaseSnapshot(store), beforeBlocked);
      }
     store.close();
    const reopened = new YuqiStore(path);
    assert.deepEqual(reopened.applyConversationClearInternal(control, { appliedAt: 1784400120000 }), applied);
     assert.deepEqual(reopened.db.prepare(`
       SELECT turn_id, character_id, device_id, device_seq, source_message_id,
              envelope_checksum, result_authority_version
       FROM turns WHERE turn_id IN (${fixture.targetIds.map(() => '?').join(',')}) ORDER BY turn_id
     `).all(...fixture.targetIds).map(row => ({ ...row })), fixture.immutable);
     assert.deepEqual(reopened.getTurn(fixture.other.turnId), otherBefore);
     assert.deepEqual(reopened.db.prepare(
       'SELECT * FROM turns WHERE turn_id = ?'
     ).get(fixture.publicMoment.turnId), fixture.publicBefore);
     assert.deepEqual({
       turn: reopened.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.publicMoment.turnId),
       messages: reopened.db.prepare('SELECT * FROM messages WHERE turn_id = ?').all(fixture.publicMoment.turnId),
       batches: reopened.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(fixture.publicMoment.turnId),
       batchItems: reopened.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ?').all(fixture.publicMoment.turnId),
       sync: reopened.db.prepare('SELECT * FROM sync_log WHERE entity_id = ? ORDER BY seq').all(fixture.publicMoment.turnId)
     }, fixture.publicScopeBefore);
     const reopenedCanonicalV2 = reopened.db.prepare(
       'SELECT * FROM turns WHERE turn_id = ?'
     ).get(canonicalV2Private.turn.turnId);
     assert.equal(reopenedCanonicalV2.result_authority_version, 1);
     assert.equal(reopenedCanonicalV2.envelope_json, canonicalJson({ redacted: true }));
     assert.deepEqual(
       readCanonicalV3PublicMomentSnapshot(reopened, canonicalV3Public),
       canonicalV3Public.snapshot
     );
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('authority-v0 scrub fault rolls back Yuqi legacy rows and leaves other role unchanged', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-fault-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const before = redactionDatabaseSnapshot(store);
    const otherBefore = store.getTurn(fixture.other.turnId);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), {
        appliedAt: 1784400115000,
        faultAfterStep: 'after_legacy_scrub'
      }
    ), /legacy|fault|scrub|conversation clear/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    assert.deepEqual(store.getTurn(fixture.other.turnId), otherBefore);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('authority-v0 selector rejects a self-consistent envelope whose stored checksum is stale', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-envelope-checksum-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const row = store.db.prepare('SELECT envelope_json FROM turns WHERE turn_id = ?')
      .get(fixture.v2.turnId);
    const envelope = JSON.parse(row.envelope_json);
    envelope.message.content = 'forged legacy content';
    store.db.prepare('UPDATE turns SET envelope_json = ? WHERE turn_id = ?')
      .run(canonicalJson(envelope), fixture.v2.turnId);
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400116000 }
    ), /envelope|checksum|authority|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('canonical RA1 selector rejects a lineage lane changed to public before first mutation', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-ra1-lane-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false });
    store.db.prepare('UPDATE turn_authority_lineages SET lane_key = ? WHERE lineage_key = ?')
      .run('public_moment', fixture.lineageKey);
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400117000 }
    ), /lane|authority|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('authority-v0 rejects canonical refs and noncanonical delivery payloads before any scrub write', () => {
  for (const [label, mutate] of [
    ['canonical group ref', store => {
      store.db.prepare(`UPDATE cloud_deliveries SET authority_group_id = ?, authority_commit_checksum = ?
        WHERE turn_id = ? AND peer_id = ?`).run('rogue_group', 'f'.repeat(64), 'turn_ra0_v2', 'phone_legacy');
    }],
    ['waiting attempts', store => {
      store.db.prepare(`UPDATE cloud_deliveries SET attempts = 1
        WHERE turn_id = ? AND peer_id = ?`).run('turn_ra0_v1', 'phone_legacy');
    }],
    ['noncanonical payload', store => {
      const row = store.db.prepare(`SELECT payload_json, checksum FROM cloud_deliveries
        WHERE turn_id = ? AND peer_id = ?`).get('turn_ra0_v2', 'phone_legacy');
      const payload = JSON.parse(row.payload_json);
      store.db.prepare(`UPDATE cloud_deliveries SET payload_json = ?, checksum = ?
        WHERE turn_id = ? AND peer_id = ?`).run(` ${canonicalJson(payload)} `, contentHash(payload),
        'turn_ra0_v2', 'phone_legacy');
    }],
    ['pending relay identity', store => {
      store.db.prepare(`UPDATE cloud_deliveries SET relay_message_id = ?
        WHERE turn_id = ? AND peer_id = ?`).run('relay_wrong', 'turn_ra0_v2', 'phone_legacy');
    }]
  ]) {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      createAuthorityV0ScrubFixture(store);
      mutate(store);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400118000 }
      ), /canonical|delivery|attempt|relay|conflict/i, label);
      assert.deepEqual(redactionDatabaseSnapshot(store), before, label);
      store.close();
    } finally {
      closeDir(dir);
    }
  }
});

test('authority-v0 exact replay re-runs the scoped shell validator after same-process corruption', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-replay-corrupt-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const control = emptySessionClear({ clearedThroughSequence: 3 });
    const applied = store.applyConversationClearInternal(control, { appliedAt: 1784400119000 });
    store.db.prepare('UPDATE messages SET content = ? WHERE turn_id = ?')
      .run('restored plaintext', fixture.v2.turnId);
    assert.throws(() => store.applyConversationClearInternal(control, { appliedAt: 1784400120000 }),
      /message|redaction|authority|closure|conflict/i);
    assert.equal(store.db.prepare('SELECT content FROM messages WHERE turn_id = ?')
      .get(fixture.v2.turnId).content, 'restored plaintext');
    store.db.prepare('UPDATE messages SET content = ? WHERE turn_id = ?')
      .run('', fixture.v2.turnId);
    assert.deepEqual(store.applyConversationClearInternal(control, { appliedAt: 1784400121000 }), applied);
    store.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutateAudit] of [
  ['extra audit key', (store, row) => {
    const payload = JSON.parse(row.payload_json);
    payload.secret = 'must reject';
    store.db.prepare('UPDATE sync_log SET payload_json = ?, checksum = ? WHERE seq = ?')
      .run(canonicalJson(payload), contentHash(payload), row.seq);
  }],
  ['deleted audit', (store, row) => {
    store.db.prepare('DELETE FROM sync_log WHERE seq = ?').run(row.seq);
  }],
  ['foreign audit', (store, row) => {
    store.db.prepare('UPDATE sync_log SET entity_id = ? WHERE seq = ?')
      .run('turn_other_role', row.seq);
  }],
  ['duplicate audit', (store, row) => {
    store.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      SELECT entity_type, entity_id, operation, payload_json, checksum, created_at
      FROM sync_log WHERE seq = ?
    `).run(row.seq);
  }],
  ['self-consistent audit relay mutation', (store, row) => {
    const payload = JSON.parse(row.payload_json);
    const delivery = payload.deliveries.find(item => item.originalState !== 'waiting');
    delivery.relayMessageId = stableId('relay_pc', `${payload.turnId}:${delivery.peerId}:${'b'.repeat(64)}`);
    store.db.prepare('UPDATE sync_log SET payload_json = ?, checksum = ? WHERE seq = ?')
      .run(canonicalJson(payload), contentHash(payload), row.seq);
  }]
]) {
  test(`authority-v0 ${label} is rejected on close/reopen`, () => {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createAuthorityV0ScrubFixture(store);
      const control = emptySessionClear({ clearedThroughSequence: 3 });
      const applied = store.applyConversationClearInternal(control, { appliedAt: 1784400110000 });
      assert.equal(applied.type, 'CONVERSATION_CLEAR_APPLIED');
      const auditTurnId = label === 'self-consistent audit relay mutation'
        ? fixture.v2.turnId : fixture.v1.turnId;
      const audit = store.db.prepare(`
        SELECT seq, payload_json FROM sync_log
        WHERE entity_type = 'legacy_turn_redaction' AND entity_id = ?
      `).get(auditTurnId);
      assert.ok(audit);
      mutateAudit(store, audit);
      store.close();
      assert.throws(() => new YuqiStore(path), /legacy|redaction|audit|authority|conflict/i);
    } finally {
      closeDir(dir);
    }
  });
}

for (const [label, mutateDelivery] of [
  ['deleted delivery', (store, row) => {
    store.db.prepare(`DELETE FROM cloud_deliveries
      WHERE turn_id = ? AND peer_id = ?`).run(row.turn_id, row.peer_id);
  }],
  ['extra delivery', (store, row) => {
    store.db.prepare(`INSERT INTO cloud_deliveries(
      turn_id, peer_id, recovery_ack_seq, state, attempts, created_at, updated_at
    ) VALUES (?, ?, 0, 'redaction_pending', 0, ?, ?)`)
      .run(row.turn_id, 'foreign_extra_peer', 1784400110000, 1784400110000);
  }],
  ['foreign delivery', (store, row) => {
    store.db.prepare(`UPDATE cloud_deliveries SET peer_id = ?
      WHERE turn_id = ? AND peer_id = ?`).run('foreign_peer', row.turn_id, row.peer_id);
  }],
  ['relay identity corruption', (store, row) => {
    store.db.prepare(`UPDATE cloud_deliveries SET relay_message_id = ?
      WHERE turn_id = ? AND peer_id = ?`).run('relay_wrong', row.turn_id, row.peer_id);
  }],
  ['delivery time corruption', (store, row) => {
    store.db.prepare(`UPDATE cloud_deliveries SET delivered_at = ?
      WHERE turn_id = ? AND peer_id = ?`).run(0, row.turn_id, row.peer_id);
  }],
  ['final attempts corruption', (store, row) => {
    store.db.prepare(`UPDATE cloud_deliveries SET attempts = ?
      WHERE turn_id = ? AND peer_id = ?`).run(1, row.turn_id, row.peer_id);
  }]
]) {
  test(`authority-v0 ${label} is rejected on close/reopen`, () => {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-delivery-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createAuthorityV0ScrubFixture(store);
      const applied = store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 3 }),
        { appliedAt: 1784400110000 }
      );
      assert.equal(applied.type, 'CONVERSATION_CLEAR_APPLIED');
      const delivery = store.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
      `).get(fixture.failed.turnId, 'phone_legacy');
      assert.ok(delivery);
      mutateDelivery(store, delivery);
      store.close();
      assert.throws(() => new YuqiStore(path), /legacy|delivery|redaction|authority|conflict/i);
    } finally {
      closeDir(dir);
    }
  });
}

test('authority-v0 audit time fields remain native after self-consistent corruption', () => {
  for (const [field, value] of [['deliveredAt', '1784400109000'], ['confirmedAt', [1784400109000]]]) {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-audit-${field}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createAuthorityV0ScrubFixture(store);
      const control = emptySessionClear({ clearedThroughSequence: 3 });
      store.applyConversationClearInternal(control, { appliedAt: 1784400110000 });
      const audit = store.db.prepare(`SELECT seq, payload_json FROM sync_log
        WHERE entity_type = 'legacy_turn_redaction' AND entity_id = ?`)
        .get(fixture.confirmed.turnId);
      const payload = JSON.parse(audit.payload_json);
      const delivery = payload.deliveries.find(item => item.originalState === 'confirmed');
      delivery[field] = value;
      store.db.prepare('UPDATE sync_log SET payload_json = ?, checksum = ? WHERE seq = ?')
        .run(canonicalJson(payload), contentHash(payload), audit.seq);
      assert.throws(() => store.loadValidatedLegacyTurnRedactionInternal(fixture.confirmed.turnId),
        /delivery|audit|time|native|redaction|authority/i);
      store.close();
      assert.throws(() => new YuqiStore(path), /delivery|audit|time|native|redaction|authority/i);
    } finally {
      closeDir(dir);
    }
  }
});

test('authority-v0 scoped closure tracks source-message annotations, role sessions and subject jobs', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-linked-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const control = emptySessionClear({ clearedThroughSequence: 3 });
    store.applyConversationClearInternal(control, { appliedAt: 1784400110000 });
    const messageId = store.db.prepare('SELECT message_id FROM messages WHERE turn_id = ? LIMIT 1')
      .get(fixture.v2.turnId).message_id;
    store.db.prepare(`INSERT INTO annotations(annotation_id, turn_id, source_message_id,
      preset_version, annotation_json, status, created_at)
      VALUES (?, ?, ?, '1.0', '{}', 'active', ?)`)
      .run('ann-restored', 'unrelated-turn', messageId, 1784400111000);
    store.db.prepare(`INSERT INTO consolidation_jobs(job_id, subject_type, subject_id, turn_id,
      role_id, job_type, state, attempt_count, due_at, payload_json, payload_checksum, created_at, updated_at)
      VALUES (?, 'role_history', ?, NULL, 'yuqi', 'restore', 'queued', 0, ?, '{}', ?, ?, ?)`)
      .run('job-restored', fixture.v2.turnId, 1784400111000, contentHash({}), 1784400111000, 1784400111000);
    store.db.prepare('UPDATE sessions SET thread_id = ?, turn_count = ?, updated_at = ? WHERE role = ?')
      .run('old-session-restored', 3, 1784400109000, 'yuqi');
    assert.throws(() => store.loadValidatedLegacyTurnRedactionInternal(fixture.v2.turnId),
      /annotation|session|job|linked|redaction|authority/i);
    store.db.prepare('DELETE FROM annotations WHERE annotation_id = ?').run('ann-restored');
    store.db.prepare('DELETE FROM consolidation_jobs WHERE job_id = ?').run('job-restored');
    store.db.prepare('INSERT INTO sessions(role, thread_id, turn_count, updated_at) VALUES (?, ?, ?, ?)')
      .run('yuqi', 'new-session', 1, 1784400110001);
    assert.deepEqual(store.publicLegacyRedactedTurnStatusInternal(fixture.v2.turnId), {
      status: 'redacted', deliverable: false, terminal: true
    });
    store.db.prepare('UPDATE sessions SET thread_id = ?, turn_count = ?, updated_at = ? WHERE role = ?')
      .run('old-session-restored', 3, 1784400109000, 'yuqi');
    assert.throws(() => store.applyConversationClearInternal(control, { appliedAt: 1784400120000 }),
      /session|redaction|authority|closure/i);
    store.close();
    assert.throws(() => new YuqiStore(path), /session|redaction|authority|closure/i);
  } finally {
    closeDir(dir);
  }
});

test('authority-v0 v1 rejects persisted user batches before control insert', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-v1-batch-');
  try {
    const store = new YuqiStore(path);
    const envelope = legacyV1ScrubEnvelope('turn_ra0_v1_batch', 'device_v1_batch', 99);
    const turn = store.submitTurn(envelope);
    assert.ok(store.db.prepare('SELECT 1 FROM current_user_batches WHERE turn_id = ?')
      .get(turn.turnId), 'submitTurn must expose the persisted v1 batch that clear rejects');
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
    ), /batch|legacy|authority|conflict/i);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
    store.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutate] of [
  ['deleted middle item', store => {
    store.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ? AND sequence = 1')
      .run('turn_ra0_v2_three');
  }],
  ['reordered item', store => {
    store.db.prepare('UPDATE current_user_batch_items SET sequence = 9 WHERE turn_id = ? AND sequence = 1')
      .run('turn_ra0_v2_three');
  }],
  ['extra item', store => {
    const row = store.db.prepare(`SELECT batch_id FROM current_user_batches WHERE turn_id = ?`)
      .get('turn_ra0_v2_three');
    const message = { messageId: 'msg_extra', speakerId: 'user', speakerType: 'user',
      recipientId: 'yuqi', content: 'extra', sentAt: 1784400101004 };
    store.db.prepare(`INSERT INTO current_user_batch_items(
      turn_id, batch_id, message_id, sequence, message_json, checksum
    ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('turn_ra0_v2_three', row.batch_id, message.messageId, 3,
        canonicalJson(message), contentHash(message));
  }],
  ['self-consistent content mutation', store => {
    const message = { messageId: 'msg_turn_ra0_v2_three_2', speakerId: 'user',
      speakerType: 'user', recipientId: 'yuqi', content: 'forged bubble', sentAt: 1784400101003 };
    store.db.prepare(`UPDATE current_user_batch_items SET message_json = ?, checksum = ?
      WHERE turn_id = ? AND sequence = 2`)
      .run(canonicalJson(message), contentHash(message), 'turn_ra0_v2_three');
  }]
]) {
  test(`authority-v0 v2 three-bubble ${label} rejects before control insert`, () => {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-v2-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      const envelope = legacyV2ThreeBubbleEnvelope();
      store.submitTurn(envelope);
      mutate(store);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
      ), /batch|input|legacy|authority|conflict/i);
      assert.deepEqual(redactionDatabaseSnapshot(store), before);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
      store.close();
    } finally {
      closeDir(dir);
    }
  });
}

test('agency redaction cognitive audit is validated on store startup before replay', () => {
  const { dir, path } = tempPath('yuqi-agency-startup-audit-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const control = emptySessionClear({ clearedThroughSequence: 3 });
    store.applyConversationClearInternal(control, { appliedAt: 1784400131800 });
    store.close();
    const raw = new DatabaseSync(path);
    try {
      raw.prepare(`UPDATE cognitive_states
        SET revision = revision + 1
        WHERE role_id = ?`).run('yuqi');
    } finally {
      raw.close();
    }
    assert.throws(() => new YuqiStore(path), /agency|cognitive|audit|conflict/i);
  } finally {
    closeDir(dir);
  }
});

test('multiple clear audits keep prior action scope isolated on restart', () => {
  const { dir, path } = tempPath('yuqi-agency-audit-history-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { lastCommitChecksum: null });
    const first = emptySessionClear({ clearEpoch: 1, clearedThroughSequence: 0 });
    store.applyConversationClearInternal(first, { appliedAt: 1784400131810 });
    const second = emptySessionClear({ clearEpoch: 2, clearedThroughSequence: 0 });
    store.applyConversationClearInternal(second, { appliedAt: 1784400131820 });
    store.close();
    const reopened = new YuqiStore(path);
    assert.equal(reopened.db.prepare(
      "SELECT COUNT(*) AS count FROM sync_log WHERE entity_type = 'agency_redaction'"
    ).get().count, 2);
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('conversation clear cancels an affected running consolidation job and rejects its old lease completion', () => {
  const { dir, path } = tempPath('yuqi-clear-job-cancel-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false, deliveryState: 'waiting' });
    const claimed = store.claimDueConsolidationJob({
      workerId: 'worker_clear_job',
      jobTypes: ['turn_consolidation'],
      now: 1784400023000,
      leaseMs: 60000
    });
    assert.ok(claimed);
    assert.equal(claimed.state, 'running');
    assert.equal(claimed.leaseOwner, 'worker_clear_job');
    const indirect = store.createConsolidationJobInternal({
      jobId: 'job_clear_role_history', subjectType: 'role_history',
      subjectId: 'history_clear', roleId: 'yuqi', jobType: 'history_backfill',
      payload: { roleHistory: { sourceTurnId: fixture.terminal.turnId } },
      createdAt: 1784400024000, dueAt: 1784400024000
    });
    assert.ok(indirect);

    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }),
      { appliedAt: 1784400130000 }
    );

    const cancelled = store.getConsolidationJob(claimed.jobId);
    assert.ok(cancelled);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.leaseOwner, null);
    assert.equal(cancelled.leaseExpiresAt, null);
    assert.equal(cancelled.lastErrorCode, 'SOURCE_REDACTED');
    assert.throws(() => store.completeConsolidationJob({
      jobId: claimed.jobId,
      workerId: claimed.leaseOwner,
      now: 1784400130001
    }), /lease mismatch|consolidation/i);
    assert.equal(store.getConsolidationJob(indirect.jobId).state, 'cancelled');
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('conversation clear cancels an action-only job by its canonical action source', () => {
  const { dir, path } = tempPath('yuqi-clear-action-job-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false, deliveryState: 'waiting' });
    const actionId = store.db.prepare(
      'SELECT action_id FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal LIMIT 1'
    ).get(fixture.groupId).action_id;
    const job = store.createConsolidationJobInternal({
      jobId: 'job_clear_action_only', subjectType: 'role_history',
      subjectId: 'history_action_only', roleId: 'yuqi', jobType: 'history_backfill',
      payload: { roleHistory: { sourceActionId: actionId } },
      createdAt: 1784400024000, dueAt: 1784400024000
    });
    assert.equal(job.state, 'queued');
    const claimed = store.claimDueConsolidationJob({
      workerId: 'worker_action_only', jobTypes: ['history_backfill'],
      now: 1784400024000, leaseMs: 60000
    });
    assert.equal(claimed.jobId, job.jobId);
    assert.equal(claimed.state, 'running');
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 2 }), { appliedAt: 1784400130500 }
    );
    const cancelled = store.getConsolidationJob(job.jobId);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.leaseOwner, null);
    assert.equal(cancelled.leaseExpiresAt, null);
    assert.equal(cancelled.lastErrorCode, 'SOURCE_REDACTED');
    assert.throws(() => store.completeConsolidationJob({
      jobId: claimed.jobId, workerId: claimed.leaseOwner, now: 1784400130501
    }), /lease mismatch|consolidation/i);
    const control = emptySessionClear({ clearedThroughSequence: 2 });
    store.close();
    const reopened = new YuqiStore(path);
    assert.doesNotThrow(() => reopened.applyConversationClearInternal(control, {
      appliedAt: 1784400130999
    }));
    assert.equal(reopened.getConsolidationJob(job.jobId).state, 'cancelled');
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

test('conversation clear appends archived constraint and expired stance revisions and rebuilds a deterministic cognitive anchor', () => {
  const { dir, path } = tempPath('yuqi-clear-agency-state-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    const constraint = store.putConstraintRevisionInternal({
      constraintId: 'constraint_clear_user', revision: 1, roleId: 'yuqi', authority: 'user',
      kind: 'privacy', subject: 'user', scope: { channel: 'private_chat', target: 'all' },
      rule: 'keep private', sourceMessageIds: [sourceMessageId], sourceConfigRef: null,
      releaseCondition: null, status: 'active', supersedes: null,
      createdAt: 1784400100000, updatedAt: 1784400100000
    });
    const stance = store.putStanceRevisionInternal({
      stanceId: 'stance_clear_user', revision: 1, roleId: 'yuqi', topic: 'privacy',
      position: 'private', reason: 'source-backed', strength: 0.8, flexibility: 0.2,
      sourceTurnId: fixture.v1.turnId, sourceMessageIds: [sourceMessageId],
      createdAt: 1784400100000, lastConfirmedAt: 1784400100000, expiresAt: null,
      remainingRelevantUserBatches: 2, status: 'active', supersedes: null
    });
    store.putCognitiveStateInternal({
      roleId: 'yuqi', schemaVersion: 2, revision: 1, lastTurnId: fixture.v1.turnId,
      state: { fastState: { mood: 'warm', openThreadIds: [], openThreads: [] },
        mediumState: {}, slowState: { preferenceFactIds: [] } }, updatedAt: 1784400100000
    });

    const beforeConstraint = store.db.prepare(
      'SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = 1'
    ).get(constraint.constraintId);
    const beforeStance = store.db.prepare(
      'SELECT * FROM stance_records WHERE stance_id = ? AND revision = 1'
    ).get(stance.stanceId);
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400131000 }
    );

    assert.deepEqual({ ...store.db.prepare(
      'SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = 1'
    ).get(constraint.constraintId) }, { ...beforeConstraint });
    const archivedConstraint = store.db.prepare(
      'SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = 2'
    ).get(constraint.constraintId);
    assert.equal(archivedConstraint.status, 'archived');
    assert.equal(archivedConstraint.supersedes, 'constraint_clear_user@1');
    assert.deepEqual({ ...store.db.prepare(
      'SELECT * FROM stance_records WHERE stance_id = ? AND revision = 1'
    ).get(stance.stanceId) }, { ...beforeStance });
    const expiredStance = store.db.prepare(
      'SELECT * FROM stance_records WHERE stance_id = ? AND revision = 2'
    ).get(stance.stanceId);
    assert.equal(expiredStance.status, 'expired');
    assert.equal(expiredStance.supersedes, 'stance_clear_user@1');

    const state = store.getCognitiveState('yuqi');
    assert.equal(state.schemaVersion, 2);
    assert.equal(state.lastTurnId, stableId(
      'cognitive_clear_anchor',
      `yuqi:${emptySessionClear({ clearedThroughSequence: 3 }).controlId}`
    ));
    assert.equal(state.revision, 2);
    assert.deepEqual(state.state, {
      fastState: { mood: '', openThreadIds: [], openThreads: [] },
      mediumState: {}, slowState: { preferenceFactIds: [] }
    });
    const replay = store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400131999 }
    );
    assert.equal(store.getCognitiveState('yuqi').revision, 2);
    assert.equal(replay.type, 'CONVERSATION_CLEAR_APPLIED');
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('agency revision writers reject malformed authority and non-contiguous supersedes', () => {
  const { dir, path } = tempPath('yuqi-agency-writer-closure-');
  try {
    const store = new YuqiStore(path);
    const baseConstraint = {
      constraintId: 'writer_constraint', revision: 1, roleId: 'yuqi', authority: 'user',
      kind: 'privacy', subject: 'user', scope: { channel: 'private_chat' }, rule: 'keep',
      sourceMessageIds: ['m1'], sourceConfigRef: null, releaseCondition: null,
      status: 'active', supersedes: null, createdAt: 1784400100000, updatedAt: 1784400100000
    };
    assert.throws(() => store.putConstraintRevisionInternal({
      ...baseConstraint, constraintId: 'writer_bad_authority', authority: 'alien'
    }), /constraint|authority/i);
    assert.throws(() => store.putConstraintRevisionInternal({
      ...baseConstraint, constraintId: 'writer_bad_status', status: 'pending'
    }), /constraint|status/i);
    assert.throws(() => store.putConstraintRevisionInternal({
      ...baseConstraint, revision: 3, supersedes: 'writer_constraint@2'
    }), /constraint|revision|supersedes/i);
    assert.throws(() => store.putStanceRevisionInternal({
      stanceId: 'writer_bad_stance', revision: 2, roleId: 'yuqi', topic: 't',
      position: 'p', reason: 'r', strength: 0.5, flexibility: 0.5, sourceTurnId: 'turn',
      sourceMessageIds: ['m1'], createdAt: 1784400100000, lastConfirmedAt: 1784400100000,
      expiresAt: null, remainingRelevantUserBatches: 1, status: 'active',
      supersedes: 'writer_bad_stance@1'
    }), /stance|revision|supersedes/i);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('mixed user constraint keeps only surviving evidence in a new active revision', () => {
  const { dir, path } = tempPath('yuqi-agency-mixed-constraint-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const privateMessageId = `msg_${fixture.v1.turnId}`;
    const publicMessageId = `msg_reply_${fixture.publicMoment.turnId}`;
    store.putConstraintRevisionInternal({
      constraintId: 'constraint_mixed_user', revision: 1, roleId: 'yuqi', authority: 'user',
      kind: 'privacy', subject: 'user', scope: { channel: 'private_chat' }, rule: 'keep',
      sourceMessageIds: [privateMessageId, publicMessageId], sourceConfigRef: null,
      releaseCondition: null, status: 'active', supersedes: null,
      createdAt: 1784400100000, updatedAt: 1784400100000
    });
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400132000 }
    );
    const head = store.db.prepare(
      'SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = 2'
    ).get('constraint_mixed_user');
    assert.equal(head.status, 'active');
    assert.deepEqual(JSON.parse(head.source_message_ids_json), [publicMessageId]);
    assert.equal(head.supersedes, 'constraint_mixed_user@1');
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('mixed stance keeps a surviving source turn in its append-only active revision', () => {
  const { dir, path } = tempPath('yuqi-agency-mixed-stance-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const privateMessageId = `msg_${fixture.v1.turnId}`;
    const publicMessageId = `msg_reply_${fixture.publicMoment.turnId}`;
    store.putStanceRevisionInternal({
      stanceId: 'stance_mixed_user', revision: 1, roleId: 'yuqi', topic: 'privacy',
      position: 'private', reason: 'source-backed', strength: 0.8, flexibility: 0.2,
      sourceTurnId: fixture.v1.turnId, sourceMessageIds: [privateMessageId, publicMessageId],
      createdAt: 1784400100000, lastConfirmedAt: 1784400100000, expiresAt: null,
      remainingRelevantUserBatches: 2, status: 'active', supersedes: null
    });
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400132500 }
    );
    const head = store.db.prepare(
      'SELECT * FROM stance_records WHERE stance_id = ? AND revision = 2'
    ).get('stance_mixed_user');
    assert.equal(head.status, 'active');
    assert.equal(head.source_turn_id, fixture.publicMoment.turnId);
    assert.deepEqual(JSON.parse(head.source_message_ids_json), [publicMessageId]);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('cognitive state deletion is rejected and clear replay validates the rebuilt anchor', () => {
  const { dir, path } = tempPath('yuqi-agency-cognitive-no-delete-');
  try {
    const store = new YuqiStore(path);
    store.putCognitiveStateInternal({
      roleId: 'yuqi', schemaVersion: 2, revision: 1, lastTurnId: 'turn_anchor',
      state: { fastState: { mood: 'x', openThreadIds: [], openThreads: [] },
        mediumState: {}, slowState: { preferenceFactIds: [] } }, updatedAt: 1784400100000
    });
    assert.throws(() => store.deleteCognitiveStateInternal('yuqi'), /cognitive|delete|unsupported/i);
    store.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutate] of [
  ['revision', db => db.prepare(
    'UPDATE cognitive_states SET revision = revision + 1 WHERE role_id = ?'
  ).run('yuqi')],
  ['last turn identity', db => db.prepare(
    'UPDATE cognitive_states SET last_turn_id = ? WHERE role_id = ?'
  ).run('forged-anchor', 'yuqi')],
  ['state', db => db.prepare(
    'UPDATE cognitive_states SET state_json = ? WHERE role_id = ?'
  ).run('{}', 'yuqi')],
  ['checksum', db => db.prepare(
    'UPDATE cognitive_states SET checksum = ? WHERE role_id = ?'
  ).run('f'.repeat(64), 'yuqi')]
]) {
  test(`cognitive clear replay rejects a tampered ${label} after restart`, () => {
    const { dir, path } = tempPath(`yuqi-agency-cognitive-replay-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      const fixture = createAuthorityV0ScrubFixture(store);
      store.putCognitiveStateInternal({
        roleId: 'yuqi', schemaVersion: 2, revision: 1, lastTurnId: fixture.v1.turnId,
        state: { fastState: { mood: 'x', openThreadIds: [], openThreads: [] },
          mediumState: {}, slowState: { preferenceFactIds: [] } }, updatedAt: 1784400100000
      });
      const control = emptySessionClear({ clearedThroughSequence: 3 });
      store.applyConversationClearInternal(control, { appliedAt: 1784400131500 });
      store.close();
      const raw = new DatabaseSync(path);
      try {
        mutate(raw);
      } finally {
        raw.close();
      }
      assert.throws(() => new YuqiStore(path), /agency|cognitive|conflict/i);
    } finally {
      closeDir(dir);
    }
  });
}

test('agency prune fault rolls back constraints, stances, cognitive state, and jobs with the clear', () => {
  const { dir, path } = tempPath('yuqi-agency-prune-fault-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    store.putConstraintRevisionInternal({
      constraintId: 'constraint_fault_user', revision: 1, roleId: 'yuqi', authority: 'user',
      kind: 'privacy', subject: 'user', scope: { channel: 'private_chat', target: 'all' },
      rule: 'keep', sourceMessageIds: [sourceMessageId], sourceConfigRef: null,
      releaseCondition: null, status: 'active', supersedes: null,
      createdAt: 1784400100000, updatedAt: 1784400100000
    });
    store.putStanceRevisionInternal({
      stanceId: 'stance_fault_user', revision: 1, roleId: 'yuqi', topic: 'privacy',
      position: 'private', reason: 'source-backed', strength: 0.8, flexibility: 0.2,
      sourceTurnId: fixture.v1.turnId, sourceMessageIds: [sourceMessageId],
      createdAt: 1784400100000, lastConfirmedAt: 1784400100000, expiresAt: null,
      remainingRelevantUserBatches: 2, status: 'active', supersedes: null,
      authorityGroupId: null, authorityOrdinal: null
    });
    const before = redactionDatabaseSnapshot(store);
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }),
      { appliedAt: 1784400133000, faultAfterStep: 'after_agency_prune' }
    ), /forced conversation clear fault/);
    assert.deepEqual(redactionDatabaseSnapshot(store), before);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('v3 current-batch user fact resolves without result-group authority and is pruned by private clear', () => {
  const { dir, path } = tempPath('yuqi-memory-v3-current-batch-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false, deliveryState: 'waiting' });
    const batch = store.getCurrentUserBatch(fixture.terminal.turnId);
    assert.ok(batch?.messageIds?.length);
    const sourceMessageId = batch.messageIds[0];
    const source = store.getMessage(sourceMessageId);
    assert.equal(source.authorityGroupId ?? null, null);
    store.putFact({
      factId: 'fact_v3_current_batch_user', characterId: 'yuqi', type: 'user_fact',
      subjectId: 'user', predicate: 'likes_food', object: { value: 'noodles' },
      evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'memory',
      evidenceSource: 'user_visible_message', authorityContractVersion: 'v3'
    });
    assert.doesNotThrow(() => store.resolveMemoryFactEvidenceInternal(
      store.listFacts('yuqi').find(fact => fact.factId === 'fact_v3_current_batch_user')
    ));
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_v3_current_batch_user'), true);
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400120000 }
    );
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_v3_current_batch_user'), false);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('real consolidation worker uses the store-owned current-batch authority through retrieval and clear', async () => {
  const { dir, path } = tempPath('yuqi-memory-worker-current-batch-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false, deliveryState: 'waiting' });
    const batch = store.getCurrentUserBatch(fixture.terminal.turnId);
    const source = store.getMessage(batch.messageIds[0]);
    const job = store.getConsolidationJob('job_redaction_fixture');
    assert.ok(job);
    const presetRegistry = {
      current: () => ({ version: '2.0.0' }),
      resolvePresetBundle: () => '只整理有原文证据的记忆'
    };
    const worker = new ConsolidationWorker({
      store,
      presetRegistry,
      clock: () => 1784400124000,
      codexClient: {
        async runTurn() {
          return { text: JSON.stringify({ candidates: [{
            factId: 'fact_worker_current_batch', characterId: 'yuqi', type: 'user_fact',
            subjectId: 'user', predicate: 'likes_food', object: { value: 'noodles' },
            evidenceMode: 'direct', sourceMessageIds: [source.messageId],
            exactQuotes: [{ messageId: source.messageId, speakerId: source.speakerId, text: source.content }],
            confidence: 0.9
          }] }) };
        }
      }
    });
    const claimed = store.claimDueConsolidationJob({
      workerId: 'worker_current_batch', jobTypes: ['turn_consolidation'],
      now: 1784400124000, leaseMs: 60_000
    });
    assert.equal(claimed.jobId, job.jobId);
    const result = await worker.processJob(claimed);
    assert.equal(result.verified.length, 1);
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_worker_current_batch'), true);
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400125000 }
    );
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_worker_current_batch'), false);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('store-owned consolidation commit loses cleanly to a prior conversation clear', async () => {
  const { dir, path } = tempPath('yuqi-memory-worker-clear-race-');
  try {
    const store = new YuqiStore(path);
    const fixture = createCanonicalRedactionFixture(store, { includeRetry: false, deliveryState: 'waiting' });
    const batch = store.getCurrentUserBatch(fixture.terminal.turnId);
    const source = store.getMessage(batch.messageIds[0]);
    const job = store.getConsolidationJob('job_redaction_fixture');
    assert.ok(job);
    const claimed = store.claimDueConsolidationJob({
      workerId: 'worker_clear_race', jobTypes: ['turn_consolidation'],
      now: 1784400126000, leaseMs: 60_000
    });
    assert.equal(claimed.jobId, job.jobId);
    const candidate = {
      factId: 'fact_worker_clear_race', characterId: 'yuqi', type: 'user_fact',
      subjectId: 'user', predicate: 'likes_food', object: { value: 'noodles' },
      evidenceMode: 'direct', sourceMessageIds: [source.messageId],
      exactQuotes: [{ messageId: source.messageId, speakerId: source.speakerId, text: source.content }],
      confidence: 0.9, origin: 'consolidation', evidenceSource: 'user_visible_message',
      authorityContractVersion: 'v3'
    };
    const beforeFactCount = store.listFacts('yuqi').length;
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400127000 }
    );
    assert.throws(() => store.commitConsolidationFactsInternal({
      jobId: claimed.jobId, workerId: claimed.leaseOwner, roleId: 'yuqi',
      candidates: [candidate], rawMessages: [source], now: 1784400127001
    }), /consolidation|source|lease|authority|conflict/i);
    assert.equal(store.listFacts('yuqi').length, beforeFactCount);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('public consolidation facts remain retrievable across private clear', () => {
  const { dir, path } = tempPath('yuqi-memory-public-fact-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_reply_${fixture.publicMoment.turnId}`;
    const source = store.getMessage(sourceMessageId);
    store.putFact({
      factId: 'fact_public_moment', characterId: 'yuqi', type: 'public_fact',
      subjectId: 'public_moment', predicate: 'public_text', object: { value: source.content },
      evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'consolidation',
      evidenceSource: 'user_visible_message', authorityContractVersion: 'v3'
    });
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_public_moment'), true);
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400121000 }
    );
    assert.equal(store.listRetrievableFacts('yuqi').some(fact => fact.factId === 'fact_public_moment'), true);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('legacy user-derived facts are pruned while closed author authority is retained and forged origin fails closed', () => {
  const { dir, path } = tempPath('yuqi-memory-origin-authority-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    const source = store.getMessage(sourceMessageId);
    store.putFact({
      factId: 'fact_legacy_user', characterId: 'yuqi', type: 'user_fact', subjectId: 'user',
      predicate: 'prefers_quiet', object: { value: true }, evidenceMode: 'direct',
      sourceMessageIds: [sourceMessageId], exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'legacy'
    });
    store.putFact({
      factId: 'fact_author_config', characterId: 'yuqi', type: 'author_fact', subjectId: 'yuqi',
      predicate: 'style', object: { value: 'warm' }, evidenceMode: 'config', sourceMessageIds: [],
      exactQuotes: [], status: 'verified', confidence: 1, origin: 'author',
      authority: 'author', sourceConfigRef: 'author-style-v1'
    });
    store.putFact({
      factId: 'fact_forged_author', characterId: 'yuqi', type: 'user_fact', subjectId: 'user',
      predicate: 'secret', object: { value: true }, evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'author'
    });
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400122000 }
    ), /origin|authority|fact|source|conflict/i);
    assert.equal(store.db.prepare('SELECT status FROM facts WHERE fact_id = ?').get('fact_legacy_user').status, 'verified');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('fact redaction set audit is exact and replay rejects missing or extra fact entries', () => {
  const { dir, path } = tempPath('yuqi-memory-fact-set-audit-');
  try {
    const store = new YuqiStore(path);
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    const source = store.getMessage(sourceMessageId);
    store.putFact({
      factId: 'fact_set_audit', characterId: 'yuqi', type: 'user_fact', subjectId: 'user',
      predicate: 'prefers_quiet', object: { value: true }, evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'consolidation'
    });
    const control = emptySessionClear({ clearedThroughSequence: 3 });
    store.applyConversationClearInternal(control, { appliedAt: 1784400123000 });
    const summary = store.db.prepare(
      "SELECT payload_json FROM sync_log WHERE entity_type = 'fact_redaction_set' AND entity_id = ?"
    ).get(control.controlId);
    assert.ok(summary);
    const payload = JSON.parse(summary.payload_json);
    assert.equal(payload.factCount, 1);
    store.db.prepare('DELETE FROM sync_log WHERE entity_type = ? AND entity_id = ?')
      .run('fact_redaction_set', control.controlId);
    assert.throws(() => store.applyConversationClearInternal(control, { appliedAt: 1784400123000 }), /fact|redaction|audit|closure|conflict/i);
    store.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutate] of [
  ['missing outer source message', store => {
    store.db.prepare('DELETE FROM messages WHERE message_id = ?')
      .run('msg_turn_ra0_v1_authority');
  }],
  ['foreign outer owner with self-consistent checksum', store => {
    const row = store.db.prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('msg_turn_ra0_v1_authority');
    const projection = {
      messageId: row.message_id, turnId: row.turn_id, characterId: 'other',
      speakerId: row.speaker_id, speakerType: row.speaker_type,
      recipientId: row.recipient_id, content: row.content, sentAt: row.sent_at,
      origin: row.origin, deviceId: row.device_id, deviceSeq: row.device_seq
    };
    store.db.prepare('UPDATE messages SET character_id = ?, checksum = ? WHERE message_id = ?')
      .run('other', contentHash(projection), row.message_id);
  }],
  ['self-consistent outer content mutation', store => {
    const row = store.db.prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('msg_turn_ra0_v1_authority');
    const projection = {
      messageId: row.message_id, turnId: row.turn_id, characterId: row.character_id,
      speakerId: row.speaker_id, speakerType: row.speaker_type,
      recipientId: row.recipient_id, content: 'forged v1 outer message', sentAt: row.sent_at,
      origin: row.origin, deviceId: row.device_id, deviceSeq: row.device_seq
    };
    store.db.prepare('UPDATE messages SET content = ?, checksum = ? WHERE message_id = ?')
      .run(projection.content, contentHash(projection), row.message_id);
  }]
]) {
  test(`authority-v0 v1 outer source ${label} rejects before control insert`, () => {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-v1-outer-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      seedPrivateLane(store, { now: 1784400100000 });
      const turn = store.submitTurn(legacyV1ScrubEnvelope(
        'turn_ra0_v1_authority', 'device_v1_authority', 101
      ));
      store.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ?').run(turn.turnId);
      store.db.prepare('DELETE FROM current_user_batches WHERE turn_id = ?').run(turn.turnId);
      mutate(store);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
      ), /message|source|batch|legacy|authority|conflict/i);
      assert.deepEqual(redactionDatabaseSnapshot(store), before);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
      store.close();
    } finally {
      closeDir(dir);
    }
  });
}

for (const protocolVersion of [1, 2]) {
  for (const field of ['turnId', 'characterId', 'deviceId', 'deviceSeq']) {
    test(`authority-v0 v${protocolVersion} rejects self-consistent envelope ${field} identity drift`, () => {
      const { dir, path } = tempPath(`yuqi-clear-authority-v0-v${protocolVersion}-${field}-`);
      try {
        const store = new YuqiStore(path);
        seedPrivateLane(store, { now: 1784400100000 });
        const envelope = protocolVersion === 1
          ? legacyV1ScrubEnvelope('turn_ra0_v1_identity', 'device_v1_identity', 102)
          : legacyV2ThreeBubbleEnvelope('turn_ra0_v2_identity', 'device_v2_identity');
        const turn = store.submitTurn(envelope);
        if (protocolVersion === 1) {
          store.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ?').run(turn.turnId);
          store.db.prepare('DELETE FROM current_user_batches WHERE turn_id = ?').run(turn.turnId);
        }
        const persisted = store.db.prepare(
          'SELECT envelope_json FROM turns WHERE turn_id = ?'
        ).get(turn.turnId);
        const forged = JSON.parse(persisted.envelope_json);
        const alternate = {
          turnId: 'turn_forged_identity',
          characterId: 'other',
          deviceId: 'device_forged_identity',
          deviceSeq: 999
        };
        forged[field] = alternate[field];
        store.db.prepare(
          'UPDATE turns SET envelope_json = ?, envelope_checksum = ? WHERE turn_id = ?'
        ).run(canonicalJson(forged), contentHash(forged), turn.turnId);
        const before = redactionDatabaseSnapshot(store);
        assert.throws(() => store.applyConversationClearInternal(
          emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
        ), /envelope|turn|character|device|source|batch|legacy|authority|conflict/i);
        assert.deepEqual(redactionDatabaseSnapshot(store), before);
        assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
        store.close();
      } finally {
        closeDir(dir);
      }
    });
  }
}

test('conversation clear archives a sole-source fact and removes it from retrieval', () => {
  const { dir, path } = tempPath('yuqi-clear-memory-sole-source-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { now: 1784400100000 });
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    const source = store.getMessage(sourceMessageId);
    store.putFact({
      factId: 'fact_sole_source', characterId: 'yuqi', type: 'user_fact',
      subjectId: 'user', predicate: 'prefers_quiet', object: { value: true },
      evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'consolidation',
      evidenceSource: 'user_visible_message', authorityContractVersion: 'v3'
    });
    const before = store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_sole_source');
    assert.ok(before);
    store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
    );
    const after = store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_sole_source');
    assert.equal(after.status, 'archived');
    assert.equal(after.subject_id, '__redacted__');
    assert.equal(after.predicate, 'redacted');
    assert.equal(after.object_json, 'null');
    assert.deepEqual(JSON.parse(after.source_message_ids_json), []);
    assert.equal(after.confidence, 0);
    assert.deepEqual(store.listRetrievableFacts('yuqi'), []);
    const audit = store.db.prepare(
      "SELECT payload_json FROM sync_log WHERE entity_type = 'fact_redaction' AND entity_id = ?"
    ).get('fact_sole_source');
    assert.ok(audit);
    const payload = JSON.parse(audit.payload_json);
    assert.deepEqual(Object.keys(payload).sort(), [
      'auditVersion', 'controlId', 'factId', 'newChecksum', 'oldChecksum',
      'redactedAt', 'replacementFactId', 'roleId'
    ].sort());
    assert.equal(payload.auditVersion, 'fact_redaction_v1');
    assert.equal(payload.replacementFactId, null);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('conversation clear rejects a fact mixing private and public evidence before writes', () => {
  const { dir, path } = tempPath('yuqi-clear-memory-mixed-source-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { now: 1784400100000 });
    const fixture = createAuthorityV0ScrubFixture(store);
    const privateMessageId = `msg_${fixture.v1.turnId}`;
    const publicMessageId = `msg_reply_${fixture.publicMoment.turnId}`;
    const privateMessage = store.getMessage(privateMessageId);
    const publicMessage = store.getMessage(publicMessageId);
    store.putFact({
      factId: 'fact_mixed_lane', characterId: 'yuqi', type: 'user_fact',
      subjectId: 'user', predicate: 'mixed', object: { value: true },
      evidenceMode: 'direct', sourceMessageIds: [privateMessageId, publicMessageId],
      exactQuotes: [
        { messageId: privateMessageId, speakerId: privateMessage.speakerId, text: privateMessage.content },
        { messageId: publicMessageId, speakerId: publicMessage.speakerId, text: publicMessage.content }
      ],
      status: 'verified', confidence: 0.9, origin: 'consolidation',
      evidenceSource: 'user_visible_message', authorityContractVersion: 'v3'
    });
    const before = {
      fact: store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_mixed_lane'),
      controls: store.db.prepare('SELECT * FROM conversation_clear_controls').all(),
      turn: store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.v1.turnId)
    };
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
    ), /evidence|lane|authority|ambiguous|memory|conflict/i);
    assert.deepEqual(store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_mixed_lane'), before.fact);
    assert.deepEqual(store.db.prepare('SELECT * FROM conversation_clear_controls').all(), before.controls);
    assert.deepEqual(store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.v1.turnId), before.turn);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('conversation clear memory prune fault rolls facts and control back atomically', () => {
  const { dir, path } = tempPath('yuqi-clear-memory-fault-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { now: 1784400100000 });
    const fixture = createAuthorityV0ScrubFixture(store);
    const sourceMessageId = `msg_${fixture.v1.turnId}`;
    const source = store.getMessage(sourceMessageId);
    store.putFact({
      factId: 'fact_memory_fault', characterId: 'yuqi', type: 'user_fact',
      subjectId: 'user', predicate: 'prefers_quiet', object: { value: true },
      evidenceMode: 'direct', sourceMessageIds: [sourceMessageId],
      exactQuotes: [{ messageId: sourceMessageId, speakerId: source.speakerId, text: source.content }],
      status: 'verified', confidence: 0.9, origin: 'consolidation',
      evidenceSource: 'user_visible_message', authorityContractVersion: 'v3'
    });
    const before = {
      fact: store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_memory_fault'),
      controls: store.db.prepare('SELECT * FROM conversation_clear_controls').all(),
      turn: store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.v1.turnId)
    };
    assert.throws(() => store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }),
      { appliedAt: 1784400110000, faultAfterStep: 'after_memory_prune' }
    ), /forced conversation clear fault/);
    assert.deepEqual(store.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get('fact_memory_fault'), before.fact);
    assert.deepEqual(store.db.prepare('SELECT * FROM conversation_clear_controls').all(), before.controls);
    assert.deepEqual(store.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(fixture.v1.turnId), before.turn);
    store.close();
  } finally {
    closeDir(dir);
  }
});

test('authority-v0 v2 three-bubble scrub preserves batch identity and tombstone closure', () => {
  const { dir, path } = tempPath('yuqi-clear-authority-v0-v2-three-success-');
  try {
    const store = new YuqiStore(path);
    seedPrivateLane(store, { now: 1784400100000 });
    const envelope = legacyV2ThreeBubbleEnvelope();
    const turn = store.submitTurn(envelope);
    const before = store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(turn.turnId);
    assert.equal(before.item_count, 3);
    const applied = store.applyConversationClearInternal(
      emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
    );
    assert.equal(applied.type, 'CONVERSATION_CLEAR_APPLIED');
    const batch = store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(turn.turnId);
    const items = store.db.prepare(
      'SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
    ).all(turn.turnId);
    assert.equal(batch.batch_id, before.batch_id);
    assert.equal(batch.item_count, 3);
    assert.equal(items.length, 3);
    assert.deepEqual(items.map(item => item.sequence), [0, 1, 2]);
    assert.equal(items.every(item => item.message_json === null
      && item.redacted_at === 1784400110000), true);
    assert.deepEqual(store.publicLegacyRedactedTurnStatusInternal(turn.turnId), {
      status: 'redacted', deliverable: false, terminal: true
    });
    store.close();
    const reopened = new YuqiStore(path);
    assert.deepEqual(reopened.publicLegacyRedactedTurnStatusInternal(turn.turnId), {
      status: 'redacted', deliverable: false, terminal: true
    });
    reopened.close();
  } finally {
    closeDir(dir);
  }
});

for (const [label, mutate] of [
  ['missing outer source message', store => {
    store.db.prepare('DELETE FROM messages WHERE message_id = ?')
      .run('msg_turn_ra0_v2_three_3');
  }],
  ['foreign outer owner with self-consistent checksum', store => {
    const row = store.db.prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('msg_turn_ra0_v2_three_3');
    const projection = {
      messageId: row.message_id, turnId: row.turn_id, characterId: 'other',
      speakerId: row.speaker_id, speakerType: row.speaker_type,
      recipientId: row.recipient_id, content: row.content, sentAt: row.sent_at,
      origin: row.origin, deviceId: row.device_id, deviceSeq: row.device_seq
    };
    store.db.prepare('UPDATE messages SET character_id = ?, checksum = ? WHERE message_id = ?')
      .run('other', contentHash(projection), row.message_id);
  }],
  ['self-consistent outer content mutation', store => {
    const row = store.db.prepare('SELECT * FROM messages WHERE message_id = ?')
      .get('msg_turn_ra0_v2_three_3');
    const projection = {
      messageId: row.message_id, turnId: row.turn_id, characterId: row.character_id,
      speakerId: row.speaker_id, speakerType: row.speaker_type,
      recipientId: row.recipient_id, content: 'forged outer bubble', sentAt: row.sent_at,
      origin: row.origin, deviceId: row.device_id, deviceSeq: row.device_seq
    };
    store.db.prepare('UPDATE messages SET content = ?, checksum = ? WHERE message_id = ?')
      .run(projection.content, contentHash(projection), row.message_id);
  }]
]) {
  test(`authority-v0 v2 outer source ${label} rejects before control insert`, () => {
    const { dir, path } = tempPath(`yuqi-clear-authority-v0-outer-${label.replaceAll(' ', '-')}-`);
    try {
      const store = new YuqiStore(path);
      seedPrivateLane(store, { now: 1784400100000 });
      store.submitTurn(legacyV2ThreeBubbleEnvelope());
      mutate(store);
      const before = redactionDatabaseSnapshot(store);
      assert.throws(() => store.applyConversationClearInternal(
        emptySessionClear({ clearedThroughSequence: 3 }), { appliedAt: 1784400110000 }
      ), /message|source|batch|legacy|authority|conflict/i);
      assert.deepEqual(redactionDatabaseSnapshot(store), before);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM conversation_clear_controls').get().value, 0);
      store.close();
    } finally {
      closeDir(dir);
    }
  });
}
