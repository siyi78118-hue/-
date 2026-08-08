import {
  copyFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  createVerifiedYuqiBackup,
  inspectMemorySnapshot,
  verifyYuqiBackup
} from './backup-yuqi-memory.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

function assertStoppedTarget(targetDatabasePath) {
  const database = new DatabaseSync(targetDatabasePath);
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE);');
  } finally {
    database.close();
  }
  const walPath = `${targetDatabasePath}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new Error('Yuqi restore requires the runtime to be stopped');
  }
  for (const sidecar of [walPath, `${targetDatabasePath}-shm`]) {
    if (existsSync(sidecar)) rmSync(sidecar, { force: true });
  }
}

function validateReadyClone(readyPath) {
  const store = new YuqiStore(readyPath);
  store.close();
  return inspectMemorySnapshot(readyPath);
}

function replaceTarget(readyPath, targetDatabasePath) {
  try {
    renameSync(readyPath, targetDatabasePath);
  } catch (error) {
    throw new Error('Yuqi restore target replacement failed', { cause: error });
  }
}

export function restoreVerifiedYuqiBackup(options = {}) {
  const artifact = verifyYuqiBackup({ artifactDir: options.artifactDir });
  const targetDatabasePath = resolve(options.targetDatabasePath || '');
  if (!targetDatabasePath || !existsSync(targetDatabasePath)) {
    throw new Error('Yuqi restore target database does not exist');
  }
  const snapshotsDir = resolve(options.snapshotsDir ||
    join(dirname(targetDatabasePath), 'snapshots'));
  const createdAt = options.createdAt == null ? Date.now() : options.createdAt;
  if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0) {
    throw new Error('Yuqi restore createdAt is invalid');
  }

  assertStoppedTarget(targetDatabasePath);
  const preRestore = createVerifiedYuqiBackup({
    databasePath: targetDatabasePath,
    snapshotsDir,
    roleId: 'restore_target',
    createdAt
  });
  const readyPath = `${targetDatabasePath}.restore-ready-${createdAt}`;
  const rollbackReadyPath = `${targetDatabasePath}.restore-rollback-${createdAt}`;
  for (const path of [readyPath, rollbackReadyPath]) {
    if (existsSync(path)) throw new Error('Yuqi restore working path already exists');
  }

  try {
    copyFileSync(artifact.snapshotPath, readyPath);
    const readyInspection = validateReadyClone(readyPath);
    assertStoppedTarget(targetDatabasePath);
    replaceTarget(readyPath, targetDatabasePath);
    try {
      const restoredStore = new YuqiStore(targetDatabasePath);
      restoredStore.close();
    } catch (error) {
      copyFileSync(preRestore.snapshotPath, rollbackReadyPath);
      validateReadyClone(rollbackReadyPath);
      replaceTarget(rollbackReadyPath, targetDatabasePath);
      throw new Error('Yuqi restore post-replacement invariant failed and was rolled back', { cause: error });
    }
    const postInspection = inspectMemorySnapshot(targetDatabasePath);
    return {
      ok: true,
      sourceManifestChecksum: artifact.manifest.manifestChecksum,
      sourceLogicalChecksum: artifact.manifest.logicalChecksum,
      preRestoreReceiptId: preRestore.receipt.receiptId,
      preRestoreArtifactDir: preRestore.artifactDir,
      preRestoreLogicalChecksum: preRestore.manifest.logicalChecksum,
      preRestoreSchemaVersion: preRestore.manifest.schemaVersion,
      postRestoreLogicalChecksum: postInspection.logicalChecksum,
      postRestoreSchemaVersion: postInspection.schemaVersion,
      migratedReadyLogicalChecksum: readyInspection.logicalChecksum
    };
  } finally {
    for (const path of [readyPath, rollbackReadyPath]) {
      if (existsSync(path)) rmSync(path, { force: true });
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) rmSync(`${path}${suffix}`, { force: true });
      }
    }
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const artifactDir = resolve(process.argv[2] || '');
  const targetDatabasePath = resolve(process.argv[3] || '');
  if (!process.argv[2] || !process.argv[3]) {
    throw new Error('Usage: node scripts/restore-yuqi-memory.mjs <verified-artifact-dir> <target.sqlite>');
  }
  const report = restoreVerifiedYuqiBackup({ artifactDir, targetDatabasePath });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
