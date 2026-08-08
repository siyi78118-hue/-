import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import {
  canonicalJson,
  contentHash,
  validateConversationClearApplied,
  validateConversationClearControl
} from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

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

function legacyV2AboveEnvelope(turnId = 'turn_legacy_above') {
  return {
    protocolVersion: 2,
    turnId,
    characterId: 'yuqi',
    deviceId: 'device1',
    deviceSeq: 3,
    createdAt: 1784400020003,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_legacy_above',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
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
  const aboveInput = legacyV2AboveEnvelope();
  const above = store.createTurnWithReleasePinInternal({
    envelope: aboveInput,
    rolloutKey: 'DIRECT_REPLY',
    laneKey: 'private_chat',
    expectedLaneRevision: Number(store.getInteractionLane('yuqi', 'private_chat').revision),
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
  'after_control_insert', 'after_applied_projection'
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
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM consolidation_jobs WHERE authority_group_id = ?')
      .get(fixture.groupId).value, 0);
    assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM stance_records WHERE authority_group_id = ?')
      .get(fixture.groupId).value, 0);
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
