import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createMemorySnapshot,
  inspectMemorySnapshot
} from '../scripts/backup-yuqi-memory.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

test('memory snapshot retains cognition tables and exposes only counts and checksums', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-memory-backup-'));
  const databasePath = join(dir, 'runtime', 'yuqi.sqlite');
  const snapshotsDir = join(dir, 'snapshots');
  try {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const store = new YuqiStore(databasePath);
    store.transaction(() => {
      store.putCognitiveStateInternal({
        roleId: 'yuqi',
        revision: 1,
        lastTurnId: 'turn_1',
        state: { secretPrompt: 'must not be printed by inspection' }
      });
      store.createConsolidationJobInternal({
        jobId: 'job_1',
        subjectType: 'role_history',
        subjectId: 'yuqi:first',
        roleId: 'yuqi',
        jobType: 'history_backfill',
        dueAt: 1,
        payload: { privateText: 'must not be printed by inspection' }
      });
    });
    store.close();

    const snapshotPath = createMemorySnapshot({
      databasePath,
      snapshotsDir,
      now: new Date('2026-07-30T00:00:00Z')
    });
    const inspection = inspectMemorySnapshot(snapshotPath);
    assert.equal(typeof snapshotPath, 'string');
    assert.equal(inspection.schemaVersion, 15);
    assert.equal(inspection.tableCounts.cognitive_states, 1);
    assert.equal(inspection.tableCounts.consolidation_jobs, 1);
    assert.match(inspection.sha256, /^[a-f0-9]{64}$/);
    assert.match(inspection.logicalChecksum, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(inspection).includes('must not be printed'), false);

    const reopened = new YuqiStore(snapshotPath);
    assert.equal(reopened.getCognitiveState('yuqi').revision, 1);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy v12 snapshots remain inspectable without inventing later clear fields', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-memory-backup-v12-'));
  const databasePath = join(dir, 'runtime', 'yuqi-v12.sqlite');
  const snapshotsDir = join(dir, 'snapshots');
  try {
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const store = new YuqiStore(databasePath, { targetVersion: 12 });
    store.close();
    const snapshotPath = createMemorySnapshot({
      databasePath,
      snapshotsDir,
      now: new Date('2026-07-30T00:01:00Z')
    });
    const inspection = inspectMemorySnapshot(snapshotPath);
    assert.equal(inspection.schemaVersion, 12);
    assert.deepEqual(inspection.roleLifecycleHeads, []);
    assert.deepEqual(inspection.redactedInvariantSummary, {
      legacyRedactedTurns: 0,
      redactedLineages: 0,
      redactedGroups: 0,
      authorityRedactionAudits: 0,
      agencyRedactionAudits: 0,
      factRedactionAudits: 0,
      factRedactionSetAudits: 0
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
