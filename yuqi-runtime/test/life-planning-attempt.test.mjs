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

test('fresh shadow life result executes its persisted comparison and records live evidence', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
    controller.initialize();
    const stable = store.getCognitionRollout('LIFE_PLANNING').stableReleaseId;
    const candidate = store.listPipelineReleases().find(release => release.releaseId !== stable);
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET current_mode = 'shadow', rollout_phase = 'collecting',
          candidate_release_id = ?, candidate_phase = 'shadow', shadow_epoch = 1
      WHERE rollout_key = 'LIFE_PLANNING'
    `).run(candidate.releaseId);
    const created = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: 1_000
    });
    assert.equal(created.pipelineChecksum, created.authoritativePipelineChecksum);
    assert.equal(created.presetVersion, store.getPipelineRelease(created.authoritativeReleaseId).presetVersion);
    store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
    const committed = controller.commitLifePlanningAuthoritativeResult({
      planningId: created.planningId,
      workerId: 'life-worker',
      validatedResult: {
        episodes: [{ kind: 'work', title: '在工作室', startAt: 10_000, endAt: 30_000_000 }]
      },
      now: 2_000
    });
    assert.equal(committed.executionState, 'result_committed');
    const job = store.claimDueConsolidationJob({
      workerId: 'comparison-worker',
      jobTypes: ['shadow_cognition'],
      now: 2_001,
      leaseMs: 60_000
    });
    const authority = store.loadComparisonExecutionAuthorityInternal({
      jobId: job.jobId,
      workerId: 'comparison-worker'
    });
    assert.equal(authority.status, 'ready');
    store.recordComparisonOutcomeInternal({
      jobId: job.jobId,
      workerId: 'comparison-worker',
      run: {
        runId: 'run_life_shadow',
        comparisonResultChecksum: 'a'.repeat(64),
        metrics: { schemaValid: true }
      },
      report: { reportId: 'report_life_shadow', summary: {} },
      now: 2_100
    });
    assert.equal(store.getCognitionRollout('LIFE_PLANNING').liveShadowSuccessCount, 1);
    const finished = store.getLifePlanningAttempt(created.planningId);
    assert.equal(finished.executionState, 'completed');
    assert.equal(finished.comparisonState, 'completed');
  }));

test('terminal canary life failure closes its slot exactly once', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const rollout = store.getCognitionRollout('LIFE_PLANNING');
  const candidate = store.listPipelineReleases().find(
    release => release.releaseId !== rollout.stableReleaseId
  );
  store.db.prepare(`
    UPDATE cognition_kind_rollouts
    SET current_mode = 'active', rollout_phase = 'canary',
        candidate_release_id = ?, candidate_phase = 'canary', canary_epoch = 1,
        canary_started_count = 0, canary_completed_count = 0, canary_failure_count = 0
    WHERE rollout_key = 'LIFE_PLANNING'
  `).run(candidate.releaseId);
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  assert.equal(created.canarySlot, 1);
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const failed = controller.failLifePlanningAttempt({
    planningId: created.planningId,
    workerId: 'life-worker',
    errorCode: 'INVALID_PLAN',
    failureClass: 'deterministic',
    now: 2_000
  });
  assert.equal(failed.executionState, 'failed');
  const after = store.getCognitionRollout('LIFE_PLANNING');
  assert.equal(after.canaryStartedCount, 1);
  assert.equal(after.canaryFailureCount, 1);
  assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
    rolloutKey: 'LIFE_PLANNING', canaryEpoch: 1
  }), { count: 0, oldestAt: null });
}));

test('successful canary life comparison closes completion accounting', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const rollout = store.getCognitionRollout('LIFE_PLANNING');
  const candidate = store.listPipelineReleases().find(
    release => release.releaseId !== rollout.stableReleaseId
  );
  store.db.prepare(`
    UPDATE cognition_kind_rollouts
    SET current_mode = 'active', rollout_phase = 'canary',
        candidate_release_id = ?, candidate_phase = 'canary', canary_epoch = 2,
        canary_started_count = 0, canary_completed_count = 0, canary_failure_count = 0
    WHERE rollout_key = 'LIFE_PLANNING'
  `).run(candidate.releaseId);
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'life-worker',
    validatedResult: {
      episodes: [{ kind: 'work', title: '在工作室', startAt: 10_000, endAt: 30_000_000 }]
    },
    now: 2_000
  });
  const job = store.claimDueConsolidationJob({
    workerId: 'comparison-worker',
    jobTypes: ['active_canary_compare'],
    now: 2_001,
    leaseMs: 60_000
  });
  store.recordComparisonOutcomeInternal({
    jobId: job.jobId,
    workerId: 'comparison-worker',
    run: {
      runId: 'run_life_canary',
      comparisonResultChecksum: 'b'.repeat(64),
      metrics: { schemaValid: true }
    },
    report: { reportId: 'report_life_canary', summary: {} },
    criticalFindings: [],
    now: 2_100
  });
  const after = store.getCognitionRollout('LIFE_PLANNING');
  assert.equal(after.canaryStartedCount, 1);
  assert.equal(after.canaryCompletedCount, 1);
  assert.equal(after.canaryFailureCount, 0);
  assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
    rolloutKey: 'LIFE_PLANNING', canaryEpoch: 2
  }), { count: 0, oldestAt: null });
  assert.equal(store.getLifePlanningAttempt(created.planningId).comparisonState, 'completed');
}));
