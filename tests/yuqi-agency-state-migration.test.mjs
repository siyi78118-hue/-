import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  classifyLegacyBoundary,
  migrateAgencyState
} from '../scripts/migrate-yuqi-agency-state.mjs';
import { inspectMemorySnapshot } from '../scripts/backup-yuqi-memory.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

test('only explicit matching user evidence can migrate to a user hard constraint', () => {
  const result = classifyLegacyBoundary({
    boundary: { sourceMessageIds: ['u1'], text: '不要再提我的公司' },
    messages: [{ messageId: 'u1', speakerType: 'user', content: '不要再提我的公司' }],
    now: 1000
  });
  assert.equal(result.classification, 'hard_constraint');
  assert.equal(result.record.authority, 'user');
  assert.deepEqual(result.record.sourceMessageIds, ['u1']);

  assert.equal(classifyLegacyBoundary({
    boundary: { sourceMessageIds: ['u1'], text: '不要再提我的公司' },
    messages: [{ messageId: 'u1', speakerType: 'user', content: '我今天去了公司' }],
    now: 1000
  }).classification, 'archive');
});

test('Yuqi temporary attitude becomes a short stance, not a hard constraint', () => {
  const result = classifyLegacyBoundary({
    boundary: {
      boundaryId: 'b1',
      sourceTurnId: 't1',
      sourceMessageIds: ['a1'],
      text: '今天不想收第二次'
    },
    messages: [{
      messageId: 'a1',
      speakerType: 'assistant',
      content: '今天不想收第二次',
      createdAt: 1000
    }],
    now: 1000
  });
  assert.equal(result.classification, 'current_stance');
  assert.ok(result.record.remainingRelevantUserBatches <= 3);
  assert.ok(result.record.expiresAt > 1000);
});

test('expired Yuqi attitudes and ambiguous mixed evidence archive instead of inventing authority', () => {
  assert.equal(classifyLegacyBoundary({
    boundary: {
      sourceTurnId: 't1',
      sourceMessageIds: ['a1'],
      text: '今天不想收第二次',
      expiresAt: 900
    },
    messages: [{ messageId: 'a1', speakerType: 'assistant', content: '今天不想收第二次' }],
    now: 1000
  }).classification, 'archive');
  assert.equal(classifyLegacyBoundary({
    boundary: { sourceMessageIds: ['u1', 'a1'], text: '先不说了' },
    messages: [
      { messageId: 'u1', speakerType: 'user', content: '先不说了' },
      { messageId: 'a1', speakerType: 'assistant', content: '先不说了' }
    ],
    now: 1000
  }).classification, 'archive');
});

function withMigrationStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-agency-migration-'));
  const databasePath = join(directory, 'memory.sqlite');
  const store = new YuqiStore(databasePath);
  try {
    store.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type,
        recipient_id, content, sent_at, origin, checksum, created_at
      ) VALUES (?, ?, 'yuqi', ?, ?, ?, ?, ?, 'test', ?, ?)
    `).run('u1', 'turn_u1', 'user', 'user', 'yuqi', '不要再提我的公司', 1000, 'u1', 1000);
    store.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type,
        recipient_id, content, sent_at, origin, checksum, created_at
      ) VALUES (?, ?, 'yuqi', ?, ?, ?, ?, ?, 'test', ?, ?)
    `).run('a1', 'turn_a1', 'yuqi', 'assistant', 'user', '今天不想收第二次', 1001, 'a1', 1001);
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 1,
      revision: 1,
      lastTurnId: 'turn_a1',
      state: {
        activeBoundaries: [
          { boundaryId: 'boundary_user', sourceMessageIds: ['u1'], text: '不要再提我的公司' },
          {
            boundaryId: 'boundary_yuqi',
            sourceTurnId: 'turn_a1',
            sourceMessageIds: ['a1'],
            text: '今天不想收第二次'
          },
          { boundaryId: 'boundary_unknown', sourceMessageIds: ['missing'], text: '不确定' }
        ]
      },
      updatedAt: 1001
    });
    return run(store, databasePath);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('dry run and apply use the same decisions, preserve structural rows, and are idempotent', () =>
  withMigrationStore((store, databasePath) => {
    const dryRun = migrateAgencyState({ store, apply: false, now: 2000 });
    const first = migrateAgencyState({ store, apply: true, now: 2000 });
    const second = migrateAgencyState({ store, apply: true, now: 2000 });
    assert.equal(first.decisionChecksum, dryRun.decisionChecksum);
    assert.equal(first.beforeCounts.messages, first.afterCounts.messages);
    assert.equal(first.beforeCounts.facts, first.afterCounts.facts);
    assert.equal(first.insertedCount, 3);
    assert.equal(second.insertedCount, 0);
    assert.equal(store.listActiveConstraints('yuqi').length, 1);
    assert.equal(store.listActiveStances('yuqi', 2000).length, 1);
    assert.equal(
      store.db.prepare('SELECT COUNT(*) AS value FROM state_migration_audit').get().value,
      3
    );

    const snapshot = inspectMemorySnapshot(databasePath);
    for (const table of [
      'pipeline_releases',
      'constraint_records',
      'stance_records',
      'interaction_lanes',
      'quality_eval_runs',
      'quality_findings',
      'state_migration_audit'
    ]) {
      assert.equal(Object.hasOwn(snapshot.tableCounts, table), true, table);
    }
    assert.match(snapshot.sha256, /^[a-f0-9]{64}$/);
  }));
