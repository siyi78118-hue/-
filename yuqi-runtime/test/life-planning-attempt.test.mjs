import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PromotionController } from '../src/promotion-controller.mjs';
import { contentHash } from '../src/protocol.mjs';
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
  assert.equal(attempt.inputSnapshot.contextAuthorityVersion, 2);
  assert.equal(store.getOpenLifePlanningAttempt('yuqi').planningId, attempt.planningId);
  assert.equal(store.listRecoverableConsolidationJobs().length, 0);
  let rolloutReads = 0;
  const originalGetRollout = store.getCognitionRollout.bind(store);
  store.getCognitionRollout = (...args) => {
    rolloutReads += 1;
    return originalGetRollout(...args);
  };
  assert.equal(controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 20_000, targetPlanEndAt: 60_000 },
    now: 2_000
  }).planningId, attempt.planningId);
  assert.equal(rolloutReads, 0);
}));

test('legacy life attempts without a context marker remain v1-compatible', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 50_000 },
    now: 1_000
  });
  const legacySnapshot = { ...created.inputSnapshot };
  delete legacySnapshot.contextAuthorityVersion;
  const legacyContextChecksum = contentHash({
    cognitiveState: legacySnapshot.cognitiveState,
    allowedActions: legacySnapshot.allowedActions
  });
  const legacyRequestBaseKey = contentHash({
    roleId: created.roleId,
    startAt: created.planningWindowStartAt,
    endAt: created.planningWindowEndAt,
    lifeBasisChecksum: created.lifeBasisChecksum,
    contextChecksum: legacyContextChecksum
  });
  store.db.prepare(`
    UPDATE cognition_life_planning_attempts
    SET input_snapshot_json = ?, input_checksum = ?, context_checksum = ?, request_base_key = ?
    WHERE planning_id = ?
  `).run(
    JSON.stringify(legacySnapshot), contentHash(legacySnapshot), legacyContextChecksum,
    legacyRequestBaseKey, created.planningId
  );
  assert.doesNotThrow(() => store.assertPersistedLifePlanningAttemptAuthorityInternal(
    created.planningId
  ));
}));

test('controller open coalescing rejects a corrupted persisted attempt before returning', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 50_000 },
    now: 1_000
  });
  const before = store.getLifePlanningAttempt(created.planningId);
  const corruptedSnapshot = { ...before.inputSnapshot, roleId: 'foreign-role' };
  store.db.prepare(`
    UPDATE cognition_life_planning_attempts
    SET input_snapshot_json = ?
    WHERE planning_id = ?
  `).run(JSON.stringify(corruptedSnapshot), created.planningId);
  assert.throws(() => controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 20_000, targetPlanEndAt: 60_000 },
    now: 2_000
  }), /life planning (?:evidence|attempt) authority conflict/);
  const after = store.getLifePlanningAttempt(created.planningId);
  assert.equal(after.executionState, before.executionState);
  assert.equal(after.planningId, created.planningId);
}));

test('life attempt open fast path rejects changed immutable identity before returning', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 50_000 },
    now: 1_000
  });
  const changedSnapshot = {
    ...created.inputSnapshot,
    planningWindow: { startAt: 20_000, targetEndAt: 60_000 }
  };
  assert.throws(() => store.createLifePlanningAttemptInternal({
    ...created,
    planningWindowStartAt: 20_000,
    planningWindowEndAt: 60_000,
    inputSnapshot: changedSnapshot,
    inputChecksum: contentHash(changedSnapshot),
    requestBaseKey: contentHash({
      roleId: created.roleId,
      startAt: 20_000,
      endAt: 60_000,
      lifeBasisChecksum: created.lifeBasisChecksum,
      contextChecksum: created.contextChecksum
    }),
    now: 2_000
  }), /life planning attempt authority conflict/);
  assert.equal(store.getLifePlanningAttempt(created.planningId).planningWindowStartAt, 10_000);
  assert.equal(store.getOpenLifePlanningAttempt('yuqi').planningId, created.planningId);
}));

test('life attempt exact terminal fast path rejects changed historical input', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'life-worker',
    validatedResult: { episodes: [] },
    now: 2_000
  });
  const terminal = store.getLifePlanningAttempt(created.planningId);
  const changedSnapshot = { ...terminal.inputSnapshot, roleId: 'foreign-role' };
  assert.throws(() => store.createLifePlanningAttemptInternal({
    ...terminal,
    inputSnapshot: changedSnapshot,
    inputChecksum: contentHash(changedSnapshot),
    now: 3_000
  }), /life planning attempt authority conflict/);
  assert.equal(store.getLifePlanningAttempt(created.planningId).executionState, 'completed');
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

test('life attempt basis evidence survives a close and restart without creating an early compare', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-life-restart-'));
  const file = join(dir, 'runtime.sqlite');
  const first = new YuqiStore(file);
  try {
    const controller = new PromotionController({ store: first, presetRegistry: registry(), clock: () => 1_000 });
    controller.initialize();
    const created = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: 1_000
    });
    const running = first.claimDueLifePlanningAttempt({ workerId: 'worker', now: 1_000 });
    assert.equal(running.lifeBasisChecksum, created.lifeBasisChecksum);
    assert.equal(first.listRecoverableConsolidationJobs().length, 0);
    first.close();

    const reopened = new YuqiStore(file);
    try {
      const recovered = reopened.getOpenLifePlanningAttempt('yuqi');
      assert.equal(recovered.planningId, created.planningId);
      assert.equal(recovered.executionState, 'running');
      assert.equal(recovered.lifeBasisChecksum, created.lifeBasisChecksum);
      assert.equal(reopened.listRecoverableConsolidationJobs().length, 0);
    } finally {
      reopened.close();
    }
  } finally {
    try { first.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('generic life-plan writer rejects reserved public moment marker with zero writes', () => withStore(store => {
  assert.throws(() => store.putLifePlan('yuqi', [{
    episodeId: 'episode-reserved',
    kind: 'work',
    title: '工作室',
    startAt: 10_000,
    endAt: 20_000,
    payload: { publicMomentCandidate: { motiveId: 'motive-forbidden' } }
  }]), /reserved public moment candidate/);
  assert.equal(store.listLifeEpisodes('yuqi').length, 0);
}));

test('trusted life result writer accepts only the closed public moment marker', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const marker = {
    version: 'public-moment-candidate-v1',
    visibility: 'public',
    summary: '今天的天气让人想起一段平静的散步。'
  };
  const committed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'life-worker',
    validatedResult: {
      episodes: [{
        kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
        payload: { publicMomentCandidate: marker }
      }]
    },
    now: 2_000
  });
  assert.equal(committed.executionState, 'completed');
  assert.deepEqual(store.getLifeEpisode(`life:${created.planningId}:1`).payload.publicMomentCandidate, marker);
  const replay = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'old-worker',
    validatedResult: {
      episodes: [{
        kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
        payload: { publicMomentCandidate: marker }
      }]
    },
    now: 3_000
  });
  assert.equal(replay.authoritativeResultChecksum, committed.authoritativeResultChecksum);
  assert.equal(store.listLifeEpisodes('yuqi').length, 1);
}));

test('trusted life result writer rejects malformed public moment markers before any write', () => {
  const markers = [
    {
      name: 'version',
      value: { version: 'public-moment-candidate-v2', visibility: 'public', summary: '合法摘要' }
    },
    {
      name: 'visibility',
      value: { version: 'public-moment-candidate-v1', visibility: 'private', summary: '合法摘要' }
    },
    {
      name: 'extra',
      value: { version: 'public-moment-candidate-v1', visibility: 'public', summary: '合法摘要', secret: 'x' }
    },
    {
      name: 'trim',
      value: { version: 'public-moment-candidate-v1', visibility: 'public', summary: ' 合法摘要' }
    },
    {
      name: 'length',
      value: { version: 'public-moment-candidate-v1', visibility: 'public', summary: 'x'.repeat(281) }
    }
  ];
  for (const markerCase of markers) {
    withStore(store => {
      const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
      controller.initialize();
      const created = controller.createLifePlanningAttempt({
        roleId: 'yuqi',
        planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
        now: 1_000
      });
      store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
      assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
        planningId: created.planningId,
        workerId: 'life-worker',
        validatedResult: {
          episodes: [{
            kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
            payload: { publicMomentCandidate: markerCase.value }
          }]
        },
        now: 2_000
      }), /public moment candidate authority conflict/);
      assert.equal(store.listLifeEpisodes('yuqi').length, 0, markerCase.name);
      assert.equal(store.listRecoverableConsolidationJobs().length, 0, markerCase.name);
      assert.equal(store.getLifePlanningAttempt(created.planningId).authoritativeResultChecksum, null);
    });
  }
});

test('exact replay after restart revalidates persisted input evidence before early return', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-life-replay-input-'));
  const file = join(dir, 'runtime.sqlite');
  const marker = {
    version: 'public-moment-candidate-v1', visibility: 'public', summary: '一段平静的散步。'
  };
  const result = {
    episodes: [{
      kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
      payload: { publicMomentCandidate: marker }
    }]
  };
  const first = new YuqiStore(file);
  try {
    const controller = new PromotionController({ store: first, presetRegistry: registry(), clock: () => 1_000 });
    controller.initialize();
    const created = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: 1_000
    });
    first.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
    const committed = controller.commitLifePlanningAuthoritativeResult({
      planningId: created.planningId, workerId: 'life-worker', validatedResult: result, now: 2_000
    });
    first.close();

    const reopened = new YuqiStore(file);
    try {
      reopened.db.prepare(`
        UPDATE cognition_life_planning_attempts
        SET input_snapshot_json = ?
        WHERE planning_id = ?
      `).run(JSON.stringify({ roleId: 'foreign-role', cognitiveState: {}, allowedActions: [] }), created.planningId);
      assert.throws(() => reopened.commitLifePlanningResultInternal({
        planningId: created.planningId,
        workerId: 'old-worker',
        validatedResult: result,
        now: 3_000
      }), /life planning evidence authority conflict/);
      assert.equal(reopened.getLifePlanningAttempt(created.planningId).authoritativeResultChecksum,
        committed.authoritativeResultChecksum);
      assert.equal(reopened.listLifeEpisodes('yuqi').length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    try { first.close(); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('exact replay rejects a tampered committed episode proof after restart', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const result = {
    episodes: [{
      kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
      payload: { note: '原始事实' }
    }]
  };
  const committed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId, workerId: 'life-worker', validatedResult: result, now: 2_000
  });
  store.db.prepare(`
    UPDATE life_episodes SET payload_json = ? WHERE episode_id = ?
  `).run(JSON.stringify({ note: '篡改事实' }), `life:${created.planningId}:1`);
  assert.throws(() => store.commitLifePlanningResultInternal({
    planningId: created.planningId,
    workerId: 'old-worker',
    validatedResult: result,
    now: 3_000
  }), /life planning episode authority conflict/);
  assert.equal(store.getLifePlanningAttempt(created.planningId).authoritativeResultChecksum,
    committed.authoritativeResultChecksum);
  assert.equal(store.listLifeEpisodes('yuqi').length, 1);
}));

test('terminal life replay does not recompute mutable post-write life basis', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  store.putLifePlan('yuqi', [{
    episodeId: 'life_historical_source', kind: 'walk', title: '旧散步', startAt: 100, endAt: 200,
    payload: {}
  }]);
  const source = store.getLifeEpisode('life_historical_source');
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: {
      planWindowStartAt: 100,
      targetPlanEndAt: 30_000_000,
      current: source,
      recent: [],
      upcoming: []
    },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const result = { episodes: [{ kind: 'work', title: '写作', startAt: 1_000, endAt: 2_000 }] };
  const committed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId, workerId: 'life-worker', validatedResult: result, now: 2_000
  });
  store.db.prepare(`
    UPDATE life_episodes SET checksum = ? WHERE episode_id = ?
  `).run('d'.repeat(64), source.episodeId);
  const replayed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId, workerId: 'old-worker', validatedResult: result, now: 3_000
  });
  assert.equal(replayed.authoritativeResultChecksum, committed.authoritativeResultChecksum);
}));

test('life result commit rejects malformed result shapes without closing the leased attempt', () => {
  for (const validatedResult of [
    null,
    {},
    [],
    { episodes: null },
    { episodes: {} },
    { episodes: [], evidenceIds: [] },
    { episodes: [], sourceMessageIds: [] },
    { episodes: [], usedFactIds: [] },
    { episodes: [], lifeBasisChecksum: 'a'.repeat(64) },
    { episodes: [], contextChecksum: 'b'.repeat(64) }
  ]) {
    withStore(store => {
      const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
      controller.initialize();
      const created = controller.createLifePlanningAttempt({
        roleId: 'yuqi',
        planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
        now: 1_000
      });
      store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
      assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
        planningId: created.planningId,
        workerId: 'life-worker',
        validatedResult,
        now: 2_000
      }), /life planning result authority conflict/);
      assert.equal(store.getLifePlanningAttempt(created.planningId).executionState, 'running');
      assert.equal(store.listLifeEpisodes('yuqi').length, 0);
      assert.equal(store.listRecoverableConsolidationJobs().length, 0);
    });
  }
});

test('coordinated input snapshot rehash cannot change attempt role or planning window', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const attempt = store.getLifePlanningAttempt(created.planningId);
  const tamperedSnapshot = {
    ...attempt.inputSnapshot,
    roleId: 'foreign-role',
    planningWindow: { startAt: 1, targetEndAt: 2 }
  };
  store.db.prepare(`
    UPDATE cognition_life_planning_attempts
    SET input_snapshot_json = ?, input_checksum = ?
    WHERE planning_id = ?
  `).run(JSON.stringify(tamperedSnapshot), contentHash(tamperedSnapshot), created.planningId);
  assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'life-worker',
    validatedResult: { episodes: [] },
    now: 2_000
  }), /life planning evidence authority conflict/);
  assert.equal(store.getLifePlanningAttempt(created.planningId).executionState, 'running');
  assert.equal(store.listLifeEpisodes('yuqi').length, 0);
}));

test('life planning attempt references must resolve to same-role persisted episode checksums', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  store.putLifePlan('yuqi', [{
    episodeId: 'life_yuqi_real', kind: 'walk', title: '散步', startAt: 10_000, endAt: 20_000,
    payload: {}
  }]);
  store.putLifePlan('other-role', [{
    episodeId: 'life_foreign_real', kind: 'walk', title: '外部散步', startAt: 10_000, endAt: 20_000,
    payload: {}
  }]);
  const real = store.getLifeEpisode('life_yuqi_real');
  const foreign = store.getLifeEpisode('life_foreign_real');
  assert.throws(() => controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: {
      planWindowStartAt: 10_000,
      targetPlanEndAt: 30_000_000,
      current: foreign,
      recent: [real],
      upcoming: []
    },
    now: 1_000
  }), /life planning input authority conflict/);
  assert.equal(store.getOpenLifePlanningAttempt('yuqi'), null);
  const changed = { ...real, checksum: 'c'.repeat(64) };
  assert.throws(() => controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: {
      planWindowStartAt: 10_000,
      targetPlanEndAt: 30_000_000,
      current: null,
      recent: [changed],
      upcoming: []
    },
    now: 1_000
  }), /life planning input authority conflict/);
  assert.equal(store.getOpenLifePlanningAttempt('yuqi'), null);
  const accepted = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: {
      planWindowStartAt: 10_000,
      targetPlanEndAt: 30_000_000,
      current: real,
      recent: [],
      upcoming: []
    },
    now: 1_000
  });
  assert.equal(accepted.roleId, 'yuqi');
}));

test('life planning references require the complete persisted episode projection', () => {
  const mutations = [
    ['title', value => ({ ...value, title: 'forged title' })],
    ['payload', value => ({ ...value, payload: { forged: true } })],
    ['status', value => ({ ...value, status: 'cancelled' })],
    ['characterId', value => ({ ...value, characterId: 'foreign-role' })]
  ];
  for (const [field, mutate] of mutations) {
    withStore(store => {
      const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
      controller.initialize();
      store.putLifePlan('yuqi', [{
        episodeId: `life_projection_${field}`, kind: 'walk', title: 'projection',
        startAt: 10_000, endAt: 20_000, payload: { note: 'persisted' }
      }]);
      const real = store.getLifeEpisode(`life_projection_${field}`);
      const forged = mutate(real);
      assert.throws(() => controller.createLifePlanningAttempt({
        roleId: 'yuqi',
        planningContext: {
          planWindowStartAt: 10_000,
          targetPlanEndAt: 30_000_000,
          current: forged,
          recent: [],
          upcoming: []
        },
        now: 1_000
      }), /life planning input authority conflict/);
      assert.equal(store.getOpenLifePlanningAttempt('yuqi'), null);
    });
  }
});

test('life planning references cannot duplicate one persisted episode across groups', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  store.putLifePlan('yuqi', [{
    episodeId: 'life_duplicate_reference', kind: 'walk', title: 'duplicate',
    startAt: 1_000, endAt: 9_000, payload: {}
  }]);
  const source = store.getLifeEpisode('life_duplicate_reference');
  assert.throws(() => controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: {
      planWindowStartAt: 10_000,
      targetPlanEndAt: 30_000_000,
      current: null,
      recent: [source, source],
      upcoming: []
    },
    now: 1_000
  }), /life planning input authority conflict: duplicate/);
  assert.equal(store.getOpenLifePlanningAttempt('yuqi'), null);
}));

test('fresh life planning references obey anchor group windows and reject cancelled rows', () => {
  const cases = [
    { name: 'cancelled current', status: 'cancelled', group: 'current', startAt: 1_000, endAt: 20_000 },
    { name: 'future current', status: 'planned', group: 'current', startAt: 20_000, endAt: 30_000 },
    { name: 'ended current', status: 'completed', group: 'current', startAt: 1_000, endAt: 9_000 },
    { name: 'unfinished recent', status: 'active', group: 'recent', startAt: 1_000, endAt: 20_000 },
    { name: 'anchor upcoming', status: 'planned', group: 'upcoming', startAt: 10_000, endAt: 20_000 },
    { name: 'past upcoming', status: 'completed', group: 'upcoming', startAt: 5_000, endAt: 9_000 }
  ];
  for (const item of cases) {
    withStore(store => {
      const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
      controller.initialize();
      const episodeId = `life_anchor_${item.name.replaceAll(' ', '_')}`;
      store.putLifePlan('yuqi', [{
        episodeId, kind: 'walk', title: item.name,
        startAt: item.startAt, endAt: item.endAt, payload: {}
      }]);
      if (item.status !== 'planned') {
        store.db.prepare('UPDATE life_episodes SET status = ? WHERE episode_id = ?')
          .run(item.status, episodeId);
      }
      const source = store.getLifeEpisode(episodeId);
      const planningContext = {
        planWindowStartAt: 10_000,
        targetPlanEndAt: 30_000_000,
        current: item.group === 'current' ? source : null,
        recent: item.group === 'recent' ? [source] : [],
        upcoming: item.group === 'upcoming' ? [source] : []
      };
      assert.throws(() => controller.createLifePlanningAttempt({
        roleId: 'yuqi', planningContext, now: 1_000
      }), /life planning input authority conflict/,
      item.name);
      assert.equal(store.getOpenLifePlanningAttempt('yuqi'), null);
    });
  }
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
    controller.initialize();
    store.putLifePlan('yuqi', [{
      episodeId: 'life_anchor_current_valid', kind: 'walk', title: 'valid current',
      startAt: 10_000, endAt: 20_000, payload: {}
    }]);
    const current = store.getLifeEpisode('life_anchor_current_valid');
    assert.doesNotThrow(() => controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: {
        planWindowStartAt: 10_000,
        targetPlanEndAt: 30_000_000,
        current,
        recent: [],
        upcoming: []
      },
      now: 1_000
    }));
  });
});

test('expired life lease rejects the old worker and lets the new worker commit one marker', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'old-worker', now: 1_000, leaseMs: 10 });
  store.recoverExpiredLifePlanningAttempts({ now: 1_011 });
  assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'old-worker',
    validatedResult: { episodes: [] },
    now: 1_012
  }), /lease mismatch/);
  store.claimDueLifePlanningAttempt({ workerId: 'new-worker', now: 1_011, leaseMs: 10_000 });
  const committed = controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'new-worker',
    validatedResult: {
      episodes: [{
        kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
        payload: {
          publicMomentCandidate: {
            version: 'public-moment-candidate-v1', visibility: 'public', summary: '一段平静的散步。'
          }
        }
      }]
    },
    now: 1_020
  });
  assert.equal(committed.executionState, 'completed');
  assert.equal(store.listLifeEpisodes('yuqi').length, 1);
}));

test('tampered persisted life input evidence is rejected before episode or compare writes', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const created = controller.createLifePlanningAttempt({
    roleId: 'yuqi',
    planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
    now: 1_000
  });
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  store.db.prepare(`
    UPDATE cognition_life_planning_attempts
    SET input_snapshot_json = ?
    WHERE planning_id = ?
  `).run(JSON.stringify({ roleId: 'foreign-role', cognitiveState: {}, allowedActions: [] }), created.planningId);
  assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
    planningId: created.planningId,
    workerId: 'life-worker',
    validatedResult: { episodes: [] },
    now: 2_000
  }), /life planning evidence authority conflict/);
  assert.equal(store.listLifeEpisodes('yuqi').length, 0);
  assert.equal(store.listRecoverableConsolidationJobs().length, 0);
}));

test('life episode and compare job rollback together when the compare write fails', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 1_000 });
  controller.initialize();
  const rollout = store.getCognitionRollout('LIFE_PLANNING');
  const candidate = store.listPipelineReleases().find(release => release.releaseId !== rollout.stableReleaseId);
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
  store.claimDueLifePlanningAttempt({ workerId: 'life-worker', now: 1_000 });
  const originalCreateJob = store.createConsolidationJobInternal;
  store.createConsolidationJobInternal = () => { throw new Error('forced compare fault'); };
  try {
    assert.throws(() => controller.commitLifePlanningAuthoritativeResult({
      planningId: created.planningId,
      workerId: 'life-worker',
      validatedResult: {
        episodes: [{
          kind: 'walk', title: '散步', startAt: 10_000, endAt: 30_000_000,
          payload: {
            publicMomentCandidate: {
              version: 'public-moment-candidate-v1', visibility: 'public', summary: '一段平静的散步。'
            }
          }
        }]
      },
      now: 2_000
    }), /forced compare fault/);
  } finally {
    store.createConsolidationJobInternal = originalCreateJob;
  }
  assert.equal(store.listLifeEpisodes('yuqi').length, 0);
  const after = store.getLifePlanningAttempt(created.planningId);
  assert.equal(after.authoritativeResultChecksum, null);
  assert.equal(after.compareJobId, null);
}));
