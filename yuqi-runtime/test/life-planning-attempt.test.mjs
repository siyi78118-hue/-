import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PromotionController } from '../src/promotion-controller.mjs';
import { LifePlanningResultConflictError, YuqiStore } from '../src/store.mjs';

function registry() {
  return {
    evidenceManifest(rolloutKey) {
      return { checksum: `checksum:${rolloutKey}`, presetVersion: '2.0.0' };
    }
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-life-attempt-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try { return run(store); } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

test('life attempt pins rollout identity without creating compare before the result', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const attempt = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 50_000 },
    now: 1_000
  });
  assert.equal(attempt.executionState, 'created');
  assert.equal(attempt.comparisonState, 'not_applicable');
  assert.equal(store.getOpenLifePlanningAttempt('yuqi').planningId, attempt.planningId);
  assert.equal(store.listRecoverableConsolidationJobs().length, 0);
  assert.equal(controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 20_000, targetPlanEndAt: 60_000 },
    now: 2_000
  }).planningId, attempt.planningId);
}));

test('life result and episodes commit atomically and duplicate checksum is idempotent', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  const running = store.claimDueLifePlanningAttempt({ workerId: 'worker', now: 1_000 });
  assert.equal(running.planningId, created.planningId);
  const result = { episodes: [{ kind: 'work', title: '在工作室', startAt: 10_000, endAt: 30_000_000 }] };
  const committed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId, workerId: 'worker', validatedResult: result, now: 2_000
  });
  assert.equal(committed.executionState, 'completed');
  assert.equal(store.listLifeEpisodes('yuqi').length, 1);
  assert.equal(controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId, workerId: 'old-worker', validatedResult: result, now: 3_000
  }).authoritativeResultChecksum, committed.authoritativeResultChecksum);
  assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'old-worker',
    validatedResult: { episodes: [{ kind: 'rest', title: '休息', startAt: 10_000, endAt: 30_000_000 }] },
    now: 3_000
  }), LifePlanningResultConflictError);
}));

test('a changed life basis cancels an old result without writing episodes', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'worker', now: 1_000 });
  store.advanceLifeState('yuqi', 5_000, {});
  const cancelled = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'worker',
    validatedResult: { episodes: [{ kind: 'work', title: '在工作室', startAt: 10_000, endAt: 30_000_000 }] },
    now: 2_000
  });
  assert.equal(cancelled.executionState, 'cancelled');
  assert.equal(cancelled.lastErrorCode, 'LIFE_BASIS_STALE');
  assert.equal(store.listLifeEpisodes('yuqi').length, 0);
}));
