import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createVerifiedYuqiBackup,
  verifyYuqiBackup
} from '../scripts/backup-yuqi-memory.mjs';
import { restoreVerifiedYuqiBackup } from '../scripts/restore-yuqi-memory.mjs';
import {
  canonicalJson,
  contentHash,
  validateAndroidRoomBackupHead,
  validateYuqiBackupReceipt
} from '../yuqi-runtime/src/protocol.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const MANIFEST_KEYS = [
  'androidRoomHead', 'createdAt', 'logicalChecksum', 'manifestChecksum', 'manifestVersion',
  'redactedInvariantSummary', 'roleLifecycleHeads', 'schemaVersion',
  'snapshotSha256', 'tableRowCounts'
].sort();
const RECEIPT_KEYS = [
  'createdAt', 'logicalChecksum', 'manifestChecksum', 'receiptChecksum',
  'receiptId', 'receiptVersion', 'roleId', 'snapshotSha256'
].sort();

async function withWorkspace(run) {
  const root = await mkdtemp(join(tmpdir(), 'yuqi-memory-lifecycle-'));
  try {
    await run({
      root,
      databasePath: join(root, 'yuqi.sqlite'),
      snapshotsDir: join(root, 'snapshots')
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function seedDatabase(databasePath, marker = 'before') {
  const store = new YuqiStore(databasePath);
  try {
    store.appendSync('fixture', `fixture-${marker}`, 'insert', { marker });
  } finally {
    store.close();
  }
}

function clearWire(overrides = {}) {
  const body = {
    protocolVersion: 3,
    type: 'CONVERSATION_CLEAR',
    controlVersion: 'conversation_clear_v1',
    roleId: 'yuqi',
    peerId: 'device1',
    clearEpoch: 1,
    clearedThroughSequence: 0,
    requestedAt: 1_784_400_000_000,
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

function seedPrivateLane(store) {
  store.db.prepare(`
    INSERT INTO interaction_lanes(
      role_id,lane_key,revision,generating_turn_id,latest_user_batch_id,
      latest_authoritative_group_id,native_completed_group_id,native_completed_sequence,
      ui_applied_group_id,ui_applied_sequence,local_sequence,last_commit_checksum,
      updated_at,clear_epoch,cleared_through_sequence
    ) VALUES ('yuqi','private_chat',1,NULL,NULL,NULL,NULL,0,NULL,0,0,NULL,1,0,0)
  `).run();
}

function androidRoomHead(overrides = {}) {
  const cursor = {
    characterId: 'yuqi',
    nativeCompletedTurnId: 'turn_android_1',
    nativeCompletedGroupId: 'grp_android_1',
    nativeCompletedSequence: 7,
    uiAppliedTurnId: 'turn_android_1',
    uiAppliedGroupId: 'grp_android_1',
    uiAppliedSequence: 7,
    localSequence: 7,
    clearedThroughSequence: 3,
    clearEpoch: 1,
    clearedAt: 1_800_000_000_000,
    chatOpen: true,
    updatedAt: 1_800_000_000_100
  };
  cursor.cursorChecksum = contentHash({
    contract: 'conversation-cursor-clear-v1',
    ...cursor
  });
  const lifecycleHead = {
    controlId: 'ctl_android_1',
    controlKind: 'conversation_clear_v1',
    peerId: 'device1',
    state: 'applied',
    semanticChecksum: 'b'.repeat(64),
    clearEpoch: 1,
    clearedThroughSequence: 3,
    requestedAt: 1_800_000_000_000,
    appliedAt: 1_800_000_000_200,
    updatedAt: 1_800_000_000_200
  };
  const basis = {
    headVersion: 'android-room-backup-head-v1',
    roleId: 'yuqi',
    roomSchemaVersion: 14,
    cursor,
    lifecycleHead,
    capturedAt: 1_800_000_000_300,
    ...overrides
  };
  return { ...basis, checksum: contentHash(basis) };
}

test('verified backup writes one closed manifest and one immutable receipt audit', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const first = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_000
    });

    assert.deepEqual(readdirSync(first.artifactDir).sort(), ['manifest.json', 'snapshot.sqlite']);
    assert.deepEqual(Object.keys(first.manifest).sort(), MANIFEST_KEYS);
    assert.deepEqual(Object.keys(first.receipt).sort(), RECEIPT_KEYS);
    assert.equal(first.manifest.manifestVersion, 'yuqi-backup-manifest-v1');
    assert.equal(first.manifest.androidRoomHead, null);
    assert.equal(first.receipt.receiptVersion, 'yuqi-backup-receipt-v1');
    assert.deepEqual(validateYuqiBackupReceipt(first.receipt), first.receipt);
    assert.equal(first.manifest.manifestChecksum, contentHash({
      ...first.manifest,
      manifestChecksum: undefined
    }));

    const verified = verifyYuqiBackup({ artifactDir: first.artifactDir });
    assert.deepEqual(verified.manifest, first.manifest);
    assert.equal(verified.logicalChecksum, first.manifest.logicalChecksum);

    const replay = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_000
    });
    assert.equal(replay.receipt.receiptId, first.receipt.receiptId);
    const auditStore = new YuqiStore(databasePath);
    try {
      const rows = auditStore.db.prepare(`
        SELECT * FROM sync_log
        WHERE entity_type='backup_receipt' AND entity_id=? AND operation='create'
      `).all(first.receipt.receiptId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].payload_json, canonicalJson(first.receipt));
      assert.equal(rows[0].checksum, contentHash(first.receipt));
      assert.equal(rows[0].created_at, first.receipt.createdAt);
    } finally {
      auditStore.close();
    }
  });
});

test('Android initiated backup closes Room schema, cursor and lifecycle head into the manifest', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const head = androidRoomHead();
    assert.deepEqual(validateAndroidRoomBackupHead(head, { roleId: 'yuqi' }), head);
    const backup = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_600,
      androidRoomHead: head
    });
    assert.deepEqual(backup.manifest.androidRoomHead, head);
    assert.deepEqual(verifyYuqiBackup({ artifactDir: backup.artifactDir }).manifest, backup.manifest);

    const changedBasis = {
      ...head,
      capturedAt: head.capturedAt + 1
    };
    delete changedBasis.checksum;
    const changedHead = { ...changedBasis, checksum: contentHash(changedBasis) };
    assert.throws(() => createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_600,
      androidRoomHead: changedHead
    }), /replay Android Room head conflict/i);

    for (const changed of [
      { ...head, roleId: 'other' },
      { ...head, roomSchemaVersion: '14' },
      { ...head, cursor: { ...head.cursor, uiAppliedSequence: 8 } },
      { ...head, lifecycleHead: { ...head.lifecycleHead, state: 'unknown' } },
      { ...head, secret: 'leak' }
    ]) {
      assert.throws(() => validateAndroidRoomBackupHead(changed, { roleId: 'yuqi' }),
        /Android Room backup head|cursor|lifecycle|checksum/i);
    }
  });
});

test('manifest or snapshot tampering rejects before the source database changes', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const backup = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_100
    });
    const sourceBefore = readFileSync(databasePath);
    const manifestPath = join(backup.artifactDir, 'manifest.json');
    const originalManifest = readFileSync(manifestPath, 'utf8');

    writeFileSync(manifestPath, `${canonicalJson({ ...backup.manifest, secret: 'leak' })}\n`);
    assert.throws(() => verifyYuqiBackup({ artifactDir: backup.artifactDir }), /manifest.*shape/i);
    writeFileSync(manifestPath, originalManifest);

    const snapshotPath = join(backup.artifactDir, 'snapshot.sqlite');
    const snapshot = readFileSync(snapshotPath);
    writeFileSync(snapshotPath, Buffer.concat([snapshot, Buffer.from('changed')]));
    assert.throws(() => verifyYuqiBackup({ artifactDir: backup.artifactDir }), /snapshot.*checksum/i);
    assert.deepEqual(readFileSync(databasePath), sourceBefore);
  });
});

test('backup receipt validation rejects coercion unknown fields and changed commitments', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const { receipt } = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_125
    });
    for (const changed of [
      { ...receipt, extra: true },
      { ...receipt, createdAt: String(receipt.createdAt) },
      { ...receipt, roleId: 'other' },
      { ...receipt, manifestChecksum: 'A'.repeat(64) },
      { ...receipt, receiptChecksum: 'f'.repeat(64) }
    ]) {
      assert.throws(() => validateYuqiBackupReceipt(changed), /backup receipt/i);
    }
  });
});

test('duplicate or changed backup receipt audits fail the v15 restart invariant', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const backup = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_150
    });
    const database = new (await import('node:sqlite')).DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO sync_log(entity_type,entity_id,operation,payload_json,checksum,created_at)
        VALUES ('backup_receipt',?,?,?,?,?)
      `).run(
        backup.receipt.receiptId,
        'create',
        canonicalJson(backup.receipt),
        contentHash(backup.receipt),
        backup.receipt.createdAt
      );
    } finally {
      database.close();
    }
    assert.throws(() => new YuqiStore(databasePath), /backup receipt audit conflict/i);
  });
});

test('clone-first restore replaces one complete history and keeps a verified rollback backup', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath, 'before');
    const backup = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_200
    });
    const changed = new YuqiStore(databasePath);
    try {
      changed.appendSync('fixture', 'fixture-after', 'insert', { marker: 'after' });
    } finally {
      changed.close();
    }

    const report = restoreVerifiedYuqiBackup({
      artifactDir: backup.artifactDir,
      targetDatabasePath: databasePath,
      snapshotsDir,
      createdAt: 1_800_000_000_300
    });
    assert.equal(report.sourceManifestChecksum, backup.manifest.manifestChecksum);
    assert.ok(report.preRestoreReceiptId.startsWith('bkrcpt_'));
    assert.ok(existsSync(report.preRestoreArtifactDir));

    const restored = new YuqiStore(databasePath);
    try {
      assert.equal(Number(restored.db.prepare(
        "SELECT COUNT(*) AS value FROM sync_log WHERE entity_id='fixture-before'"
      ).get().value), 1);
      assert.equal(Number(restored.db.prepare(
        "SELECT COUNT(*) AS value FROM sync_log WHERE entity_id='fixture-after'"
      ).get().value), 0);
    } finally {
      restored.close();
    }
  });
});

test('restore never merges pre-clear and post-clear lifecycle histories', async () => {
  await withWorkspace(async ({ databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const laneStore = new YuqiStore(databasePath);
    try {
      seedPrivateLane(laneStore);
    } finally {
      laneStore.close();
    }
    const preClear = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_325
    });
    const clearStore = new YuqiStore(databasePath);
    const control = clearWire();
    try {
      clearStore.applyConversationClearInternal(control, { appliedAt: 1_784_400_000_100 });
    } finally {
      clearStore.close();
    }
    const postClear = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_350
    });

    restoreVerifiedYuqiBackup({
      artifactDir: preClear.artifactDir,
      targetDatabasePath: databasePath,
      snapshotsDir,
      createdAt: 1_800_000_000_360
    });
    let restored = new YuqiStore(databasePath);
    try {
      assert.equal(Number(restored.db.prepare(
        'SELECT COUNT(*) AS value FROM conversation_clear_controls'
      ).get().value), 0);
    } finally {
      restored.close();
    }

    restoreVerifiedYuqiBackup({
      artifactDir: postClear.artifactDir,
      targetDatabasePath: databasePath,
      snapshotsDir,
      createdAt: 1_800_000_000_370
    });
    restored = new YuqiStore(databasePath);
    try {
      const row = restored.db.prepare(
        'SELECT * FROM conversation_clear_controls WHERE control_id=?'
      ).get(control.controlId);
      assert.equal(row.clear_epoch, 1);
      assert.equal(row.cleared_through_sequence, 0);
    } finally {
      restored.close();
    }
  });
});

test('a corrupt restore artifact leaves the target byte-for-byte unchanged', async () => {
  await withWorkspace(async ({ root, databasePath, snapshotsDir }) => {
    seedDatabase(databasePath);
    const backup = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir,
      roleId: 'yuqi',
      createdAt: 1_800_000_000_400
    });
    const corruptDir = join(root, 'corrupt-artifact');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(corruptDir);
    copyFileSync(join(backup.artifactDir, 'manifest.json'), join(corruptDir, 'manifest.json'));
    copyFileSync(join(backup.artifactDir, 'snapshot.sqlite'), join(corruptDir, 'snapshot.sqlite'));
    const corruptManifestPath = join(corruptDir, 'manifest.json');
    const corruptManifest = JSON.parse(readFileSync(corruptManifestPath, 'utf8'));
    corruptManifest.logicalChecksum = 'f'.repeat(64);
    writeFileSync(corruptManifestPath, JSON.stringify(corruptManifest));
    const targetBefore = readFileSync(databasePath);

    assert.throws(() => restoreVerifiedYuqiBackup({
      artifactDir: corruptDir,
      targetDatabasePath: databasePath,
      snapshotsDir,
      createdAt: 1_800_000_000_500
    }), /manifest.*checksum|logical.*checksum/i);
    assert.deepEqual(readFileSync(databasePath), targetBefore);
  });
});
