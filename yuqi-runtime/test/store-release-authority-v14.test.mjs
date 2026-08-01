import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PromotionController } from '../src/promotion-controller.mjs';
import { YuqiStore } from '../src/store.mjs';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-'));
  const path = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    return run(store, path);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function snapshotV13(path) {
  const store = new YuqiStore(path, { targetVersion: 13 });
  try {
    const schema = store.db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type, name
    `).all();
    const counts = Object.fromEntries(store.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => [
      name,
      Number(store.db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)
    ]));
    return { userVersion: store.userVersion(), schema, counts };
  } finally {
    store.close();
  }
}

test('fresh store is v14 with retry-safe canary ownership indexes', () => withStore(store => {
  assert.equal(store.userVersion(), 14);
  const indexes = store.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turns' ORDER BY name"
  ).all();
  const byName = new Map(indexes.map(row => [row.name, row.sql || '']));
  assert.equal(byName.has('idx_turns_rollout_canary_slot'), false);
  assert.match(
    byName.get('idx_turns_rollout_canary_root_slot') || '',
    /retry_of_turn_id IS NULL/
  );
  assert.match(
    byName.get('idx_turns_rollout_canary_lineage_slot') || '',
    /authority_lineage_key/
  );
  assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
}));

test('v14 outstanding authority is scoped to rollout key and counts one lineage or life attempt', () =>
  withStore(store => {
    assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY',
      canaryEpoch: 0
    }), { count: 0, oldestAt: null });
    assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'LIFE_PLANNING',
      canaryEpoch: 0
    }), { count: 0, oldestAt: null });
  }));

test('v14 outstanding authority rejects counters without durable allocation owners', () =>
  withStore(store => {
    const controller = new PromotionController({
      store,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET canary_started_count = 1, canary_completed_count = 0,
          canary_failure_count = 0
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    assert.throws(() => store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY', canaryEpoch: 0
    }), /CANARY_ACCOUNTING_INVARIANT/);
  }));

test('v14 preflight rejects an invalid life-planning canary slot before any migration DDL', () =>
  withStore(store => {
    const controller = new PromotionController({
      store,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    const attempt = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: 1_000
    });
    store.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET canary_epoch = 0, canary_slot = 11
      WHERE planning_id = ?
    `).run(attempt.planningId);

    assert.throws(
      () => store.assertReleaseAuthorityV14PreflightInternal(),
      /v14 migration life canary slot conflict/
    );
  }));

test('every v14 migration fault restores the exact v13 schema and row counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-faults-'));
  try {
    const source = join(dir, 'source.sqlite');
    const sourceStore = new YuqiStore(source, { targetVersion: 13 });
    sourceStore.close();
    const before = snapshotV13(source);
    for (const step of [
      'before_drop',
      'after_drop',
      'after_root_index_create',
      'after_lineage_index_create',
      'after_invariant_verification',
      'before_version_write'
    ]) {
      const target = join(dir, `${step}.sqlite`);
      copyFileSync(source, target);
      assert.throws(
        () => new YuqiStore(target, {
          expectedSourceVersion: 13,
          v14MigrationFaultStep: step
        }),
        new RegExp(`forced v14 migration fault: ${step}`)
      );
      assert.deepEqual(snapshotV13(target), before, step);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('inconsistent populated v13 canary counters refuse v14 migration without writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-accounting-'));
  const path = join(dir, 'source.sqlite');
  try {
    const source = new YuqiStore(path, { targetVersion: 13 });
    const controller = new PromotionController({
      store: source,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    source.db.prepare(`
      UPDATE cognition_kind_rollouts SET canary_started_count = 1
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    source.close();
    const before = snapshotV13(path);
    assert.throws(
      () => new YuqiStore(path),
      /v14 migration canary accounting conflict/
    );
    assert.deepEqual(snapshotV13(path), before);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
