import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  canonicalJson,
  contentHash,
  validateConversationClearApplied,
  validateConversationClearControl
} from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';

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
