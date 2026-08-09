import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  V3DiagnosticAuthorityConflict,
  isV3DiagnosticAuthorityConflict,
  projectV3Diagnostics
} from '../src/v3-diagnostics.mjs';
import { contentHash } from '../src/protocol.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../src/store.mjs';
import { YuqiOrchestrator } from '../src/orchestrator.mjs';
import { resolvePipelinePair } from '../src/release-pair.mjs';

function realCanonicalFixture({ canary = false, shadow = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-diagnostic-'));
  const path = join(root, 'runtime.sqlite');
  const store = new YuqiStore(path);
  store.initializeCognitionRolloutsInternal({
    rows: [{ rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable', presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64) }],
    now: 1
  });
  if (canary) {
    const stable = store.getCognitionRollout('DIRECT_REPLY');
    const candidate = store.listPipelineReleases().find(release => release.releaseId !== stable.stableReleaseId);
    store.db.prepare(`UPDATE cognition_kind_rollouts
      SET current_mode = 'active', rollout_phase = 'canary',
          candidate_release_id = ?, candidate_phase = 'canary',
          pipeline_checksum = ?, revision = revision + 1,
          canary_epoch = 1, canary_started_count = 0,
          canary_completed_count = 0, canary_failure_count = 0,
          canary_started_at = NULL, canary_observe_until = 0
      WHERE rollout_key = 'DIRECT_REPLY'`).run(candidate.releaseId, candidate.releaseChecksum);
  } else if (shadow) {
    const stable = store.getCognitionRollout('DIRECT_REPLY');
    const candidate = store.listPipelineReleases().find(release => release.releaseId !== stable.stableReleaseId);
    store.db.prepare(`UPDATE cognition_kind_rollouts
      SET current_mode = 'shadow', rollout_phase = 'collecting',
          candidate_release_id = ?, candidate_phase = 'shadow',
          pipeline_checksum = ?, revision = revision + 1,
          shadow_epoch = 1, live_shadow_first_at = NULL,
          live_shadow_last_at = NULL,
          live_shadow_success_count = 0, live_shadow_failure_count = 0
      WHERE rollout_key = 'DIRECT_REPLY'`).run(candidate.releaseId, candidate.releaseChecksum);
  }
  store.claimInteractionLaneInternal({ roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0, localSequence: 0, now: 2 });
  const message = { messageId: 'msg_diagnostic_real', speakerId: 'user', speakerType: 'user', recipientId: 'yuqi', content: 'diagnostic input', sentAt: 1784400000000 };
  const envelope = {
    protocolVersion: 3, turnId: 'turn_diagnostic_real', characterId: 'yuqi', deviceId: 'device_diagnostic', deviceSeq: 1,
    createdAt: 1784400000000, kind: 'DIRECT_REPLY', message,
    context: { currentBatch: { batchId: 'batch_diagnostic_real', messageIds: [message.messageId], startedAt: message.sentAt, committedAt: message.sentAt, messages: [message] }, visibilityCursor: { nativeCompletedTurnId: null, nativeCompletedGroupId: null, nativeCompletedSequence: 0, uiAppliedTurnId: null, uiAppliedGroupId: null, uiAppliedSequence: 0, localSequence: 1, clearedThroughSequence: 0, clearEpoch: 0, clearedAt: 0, chatOpen: true, quotedMessageId: null } },
    authority: { algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId, lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: message.messageId }), claimedLineageRevision: 1, retryOfTurnId: null }
  };
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const pair = resolvePipelinePair(rollout);
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: message.sentAt });
  const turn = store.createCanonicalVisibleTurnInternal({ envelope, rolloutKey: 'DIRECT_REPLY', expectedRolloutRevision: rollout.revision, authoritativeReleaseId: pair.visibleReleaseId, comparisonReleaseId: pair.comparisonReleaseId, comparisonDirection: pair.comparisonDirection, laneKey: 'private_chat', expectedLaneRevision: 1, inputUserBatchId: envelope.context.currentBatch.batchId, inputVisibilitySequence: 1, agencySnapshotChecksum: agency.checksum, annotationSnapshot: {} }).turn;
  const releaseExecutor = { executeTurn: async () => ({ draft: { action: 'send', reply: 'private reply', bubblePlan: [{ text: 'private reply', purpose: 'reply' }], usedFactIds: [], actionIntent: {} } }), executeLife: async () => { throw new Error('unused'); } };
  return { root, path, store, turn, releaseExecutor };
}

test('projectV3Diagnostics emits a closed legacy identity projection', () => {
  const result = projectV3Diagnostics({
    turn: {
      turnId: 'turn_legacy_diagnostic',
      kind: 'legacy_turn_identity',
      state: 'completed',
      protocolVersion: 1,
      resultAuthorityVersion: 0,
      turnRevision: 2,
      inputVisibilitySequence: 0,
      inputClearEpoch: 0,
      createdAt: 1784400000000,
      updatedAt: 1784400000100
    },
    authority: {
      kind: 'legacy_turn_identity',
      lineageKey: null,
      lineageRevision: null,
      origin: 'legacy',
      commitPayloadVersion: null,
      commitChecksum: null,
      chainValid: true,
      errorCode: null, retryAllowed: null
    },
    visibleGroup: null,
    outbox: null,
    lane: null,
    pipeline: { turnPin: null, currentRollout: null },
    comparison: null,
    timings: { acceptedAt: null, updatedAt: 1784400000100, committedAt: null }
  });
  assert.equal(result.authority.kind, 'legacy_turn_identity');
  assert.equal(result.visibleGroup, null);
  assert.equal(result.authority.commitChecksum, null);
});

test('legacy RA0 rejects a canonical lineage marker attached at its root when latest points elsewhere', () => {
  const fixture = realCanonicalFixture();
  try {
    fixture.store.db.prepare('UPDATE turns SET result_authority_version = 0 WHERE turn_id = ?')
      .run(fixture.turn.turnId);
    fixture.store.db.prepare('UPDATE turn_authority_lineages SET latest_turn_id = ? WHERE lineage_key = ?')
      .run('turn_other_latest_marker', fixture.turn.authorityLineageKey);
    assert.throws(
      () => fixture.store.loadTurnDiagnosticsAuthorityInternal(fixture.turn.turnId),
      V3DiagnosticAuthorityConflict
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('projectV3Diagnostics rejects unknown and non-native projection fields', () => {
  assert.throws(() => projectV3Diagnostics({}), V3DiagnosticAuthorityConflict);
  assert.throws(() => projectV3Diagnostics({
    turn: { turnId: 'x', state: 'completed', protocolVersion: '1' }
  }), V3DiagnosticAuthorityConflict);
});

test('redacted diagnostics keep only identity/state/authority and null semantic fields', () => {
  const result = projectV3Diagnostics({
    turn: {
      turnId: 'turn_redacted_diag', kind: 'DIRECT_REPLY', state: 'cancelled', protocolVersion: 3,
      resultAuthorityVersion: 1, turnRevision: 4, inputVisibilitySequence: 2,
      inputClearEpoch: 1, createdAt: 10, updatedAt: 20
    },
    authority: {
      kind: 'redacted', lineageKey: 'secret', lineageRevision: 2, origin: 'pc',
      commitPayloadVersion: 'pc-visible-commit-v2', commitChecksum: 'a'.repeat(64),
      chainValid: true, errorCode: null, retryAllowed: null
    },
    visibleGroup: null, outbox: null, lane: null,
    pipeline: { turnPin: null, currentRollout: null }, comparison: null,
    timings: { acceptedAt: null, updatedAt: 20, committedAt: 10 }
  });
  assert.deepEqual(result.turn, { turnId: 'turn_redacted_diag', state: 'cancelled', resultAuthorityVersion: 1 });
  assert.deepEqual(result.authority, { kind: 'redacted' });
  assert.equal(result.visibleGroup, null);
  assert.equal(result.timings, null);
});

test('diagnostic authority classifier does not trust a forgeable error code', () => {
  assert.equal(isV3DiagnosticAuthorityConflict({ code: 'V3_DIAGNOSTIC_AUTHORITY_CONFLICT' }), false);
  assert.equal(isV3DiagnosticAuthorityConflict(new V3DiagnosticAuthorityConflict()), true);
});

test('fallback and failure diagnostic projections allow their null target shapes', () => {
  const baseTurn = { turnId: 'turn_fallback_diag', kind: 'PROACTIVE_CHAT', state: 'completed', protocolVersion: 3, resultAuthorityVersion: 1, turnRevision: 1, inputVisibilitySequence: 1, inputClearEpoch: 0, createdAt: 10, updatedAt: 20 };
  const common = { visibleGroup: null, lane: null, pipeline: { turnPin: null, currentRollout: null }, comparison: null, timings: { acceptedAt: null, updatedAt: 20, committedAt: 10 } };
  assert.doesNotThrow(() => projectV3Diagnostics({
    turn: baseTurn,
    authority: { kind: 'android_fallback', lineageKey: 'lin_fallback', lineageRevision: 1, origin: 'android_fallback', commitPayloadVersion: 'android-fallback-commit-v2', commitChecksum: 'a'.repeat(64), chainValid: true, errorCode: null, retryAllowed: null },
    outbox: { authorityGroupId: 'group_fallback', peerId: null, state: 'not_applicable_external_visibility', recoveryAckSeq: 0 },
    ...common
  }));
  const failureProjection = projectV3Diagnostics({
    turn: { ...baseTurn, turnId: 'turn_failure_diag', state: 'failed' },
    authority: { kind: 'canonical_failure', lineageKey: 'lin_failure', lineageRevision: 1, origin: 'pc', commitPayloadVersion: 'canonical-failure-status-v1', commitChecksum: null, chainValid: true, errorCode: 'YUQI_TRANSIENT_EXECUTION_FAILURE', retryAllowed: true },
    outbox: { authorityGroupId: null, peerId: 'device_failure', state: 'waiting', recoveryAckSeq: 42 },
    ...common
  });
  assert.equal(failureProjection.outbox.recoveryAckSeq, 42);
});

test('canonical failure diagnostics require native retryAllowed while other kinds expose null', () => {
  const baseTurn = { turnId: 'turn_retry_flag_diag', kind: 'DIRECT_REPLY', state: 'failed', protocolVersion: 3, resultAuthorityVersion: 1, turnRevision: 1, inputVisibilitySequence: 1, inputClearEpoch: 0, createdAt: 10, updatedAt: 20 };
  const common = { visibleGroup: null, outbox: { authorityGroupId: null, peerId: 'device', state: 'waiting', recoveryAckSeq: 0 }, lane: null, pipeline: { turnPin: null, currentRollout: null }, comparison: null, timings: { acceptedAt: null, updatedAt: 20, committedAt: null } };
  assert.throws(() => projectV3Diagnostics({
    turn: baseTurn,
    authority: { kind: 'canonical_failure', lineageKey: 'lin', lineageRevision: 1, origin: 'pc', commitPayloadVersion: 'canonical-failure-status-v1', commitChecksum: null, chainValid: true, errorCode: 'YUQI_TRANSIENT_EXECUTION_FAILURE', retryAllowed: 'true' },
    ...common
  }), V3DiagnosticAuthorityConflict);
  assert.throws(() => projectV3Diagnostics({
    turn: { ...baseTurn, state: 'completed' },
    authority: { kind: 'pc_canonical_live', lineageKey: 'lin', lineageRevision: 1, origin: 'pc', commitPayloadVersion: 'pc-visible-commit-v2', commitChecksum: 'a'.repeat(64), chainValid: true, errorCode: null, retryAllowed: true },
    ...common
  }), V3DiagnosticAuthorityConflict);
});

test('candidate phase follows release-pair closed phases', () => {
  const input = {
    turn: { turnId: 'turn_phase_diag', kind: 'DIRECT_REPLY', state: 'completed', protocolVersion: 3, resultAuthorityVersion: 1, turnRevision: 1, inputVisibilitySequence: 1, inputClearEpoch: 0, createdAt: 10, updatedAt: 20 },
    authority: { kind: 'pc_canonical_live', lineageKey: 'lin_phase', lineageRevision: 1, origin: 'pc', commitPayloadVersion: 'pc-visible-commit-v2', commitChecksum: 'a'.repeat(64), chainValid: true, errorCode: null, retryAllowed: null },
    visibleGroup: { groupId: 'group_phase', authoritativeTurnId: 'turn_phase_diag', redacted: false },
    outbox: { authorityGroupId: 'group_phase', peerId: 'device_phase', state: 'waiting', recoveryAckSeq: 0 },
    lane: { key: 'private_chat', revision: 1, localSequence: 1, clearEpoch: 0, clearedThroughSequence: 0 },
    pipeline: { turnPin: null, currentRollout: { candidatePhase: 'stable', revision: 1, evidenceEpoch: 1, stableReleaseId: 'stable', candidateReleaseId: null, lastReasonCode: null } },
    comparison: null, timings: { acceptedAt: null, updatedAt: 20, committedAt: 10 }
  };
  assert.throws(() => projectV3Diagnostics(input), V3DiagnosticAuthorityConflict);
});

test('comparison diagnostics use closed run states and critical code allow-list', () => {
  const base = {
    turn: { turnId: 'turn_comparison_shape', kind: 'DIRECT_REPLY', state: 'completed', protocolVersion: 3, resultAuthorityVersion: 1, turnRevision: 1, inputVisibilitySequence: 1, inputClearEpoch: 0, createdAt: 10, updatedAt: 20 },
    authority: { kind: 'pc_canonical_live', lineageKey: 'lin_comparison_shape', lineageRevision: 1, origin: 'pc', commitPayloadVersion: 'pc-visible-commit-v2', commitChecksum: 'a'.repeat(64), chainValid: true, errorCode: null, retryAllowed: null },
    visibleGroup: { groupId: 'group_comparison_shape', authoritativeTurnId: 'turn_comparison_shape', redacted: false },
    outbox: { authorityGroupId: 'group_comparison_shape', peerId: 'device_comparison_shape', state: 'waiting', recoveryAckSeq: 0 },
    lane: { key: 'private_chat', revision: 1, localSequence: 1, clearEpoch: 0, clearedThroughSequence: 0 },
    pipeline: { turnPin: null, currentRollout: null },
    timings: { acceptedAt: null, updatedAt: 20, committedAt: 10 }
  };
  assert.throws(() => projectV3Diagnostics({
    ...base,
    comparison: { stateCounts: { made_up_state: 1 }, staleCount: 0, criticalCodes: [] }
  }), V3DiagnosticAuthorityConflict);
  assert.throws(() => projectV3Diagnostics({
    ...base,
    comparison: { stateCounts: { completed: 1 }, staleCount: 0, criticalCodes: ['MADE_UP_CRITICAL'] }
  }), V3DiagnosticAuthorityConflict);
  assert.doesNotThrow(() => projectV3Diagnostics({
    ...base,
    comparison: { stateCounts: { completed: 1, retry_wait: 2 }, staleCount: 0, criticalCodes: ['CURRENT_BATCH_OMISSION', 'DUPLICATE_VISIBLE_EFFECT'] }
  }));
});

test('real v15 canonical store loader joins scoped authority and strips semantic material', async () => {
  const fixture = realCanonicalFixture();
  try {
    await new YuqiOrchestrator({
      store: fixture.store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor: fixture.releaseExecutor, clock: () => 1784400000100, lifePlanningEnabled: false
    }).run(fixture.turn.turnId);
    const projection = fixture.store.loadTurnDiagnosticsAuthorityInternal(fixture.turn.turnId);
    const result = projectV3Diagnostics(projection);
    assert.equal(result.authority.kind, 'pc_canonical_live');
    assert.equal(result.visibleGroup.authoritativeTurnId, fixture.turn.turnId);
    assert.equal(result.timings.acceptedAt, null);
    assert.equal(JSON.stringify(result).includes('private reply'), false);
    assert.equal(JSON.stringify(result).includes('reply_json'), false);
    fixture.store.db.prepare(`
      UPDATE turns SET reply_json = ?, error_json = ?, annotation_snapshot_json = ?
      WHERE turn_id = ?
    `).run(
      JSON.stringify({ prose: 'SECRET_REPLY_JSON', privatePath: 'C:/secret/private' }),
      JSON.stringify({ message: 'SECRET_ERROR_JSON', evaluatorProse: 'SECRET_EVALUATOR' }),
      JSON.stringify({ secret: 'SECRET_ANNOTATION', privatePath: 'C:/secret/private' }),
      fixture.turn.turnId
    );
    const afterSentinels = projectV3Diagnostics(fixture.store.loadTurnDiagnosticsAuthorityInternal(fixture.turn.turnId));
    const serialized = JSON.stringify(afterSentinels);
    for (const sentinel of ['SECRET_REPLY_JSON', 'SECRET_ERROR_JSON', 'SECRET_ANNOTATION', 'SECRET_EVALUATOR', 'C:/secret/private']) {
      assert.equal(serialized.includes(sentinel), false);
    }
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('diagnostics scoped corruption matrix rejects receipt/group/delivery/release/lane drift without full scan', async () => {
  const fixture = realCanonicalFixture();
  try {
    await new YuqiOrchestrator({
      store: fixture.store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor: fixture.releaseExecutor, clock: () => 1784400000100, lifePlanningEnabled: false
    }).run(fixture.turn.turnId);
    const originalFull = fixture.store.assertVisibleAuthorityV13Invariants;
    fixture.store.assertVisibleAuthorityV13Invariants = () => {
      throw new Error('diagnostics must not perform a full invariant scan');
    };
    const assertConflict = () => assert.throws(
      () => fixture.store.loadTurnDiagnosticsAuthorityInternal(fixture.turn.turnId),
      V3DiagnosticAuthorityConflict
    );
    const receipt = fixture.store.db.prepare(
      'SELECT group_id, commit_checksum FROM visible_commit_receipts WHERE authoritative_turn_id = ?'
    ).get(fixture.turn.turnId);
    const delivery = fixture.store.db.prepare(
      'SELECT peer_id, recovery_ack_seq FROM cloud_deliveries WHERE authority_group_id = ?'
    ).get(receipt.group_id);
    const lane = fixture.store.getInteractionLane('yuqi', 'private_chat');
    const group = fixture.store.db.prepare('SELECT role_id FROM visible_result_groups WHERE group_id = ?').get(receipt.group_id);
    const release = fixture.store.db.prepare(
      'SELECT release_id, release_checksum FROM pipeline_releases WHERE release_id = ?'
    ).get(fixture.store.getTurn(fixture.turn.turnId).authoritativeReleaseId);
    fixture.store.db.prepare('UPDATE visible_commit_receipts SET commit_checksum = ? WHERE group_id = ?')
      .run('e'.repeat(64), receipt.group_id);
    assertConflict();
    fixture.store.db.prepare('UPDATE visible_commit_receipts SET commit_checksum = ? WHERE group_id = ?')
      .run(receipt.commit_checksum, receipt.group_id);
    fixture.store.db.prepare('UPDATE visible_result_groups SET role_id = ? WHERE group_id = ?')
      .run('foreign-role', receipt.group_id);
    assertConflict();
    fixture.store.db.prepare('UPDATE visible_result_groups SET role_id = ? WHERE group_id = ?')
      .run(group.role_id, receipt.group_id);
    fixture.store.db.prepare('UPDATE cloud_deliveries SET recovery_ack_seq = ? WHERE authority_group_id = ?')
      .run(-1, receipt.group_id);
    assertConflict();
    fixture.store.db.prepare('UPDATE cloud_deliveries SET recovery_ack_seq = ? WHERE authority_group_id = ?')
      .run(delivery.recovery_ack_seq, receipt.group_id);
    fixture.store.db.prepare('UPDATE pipeline_releases SET release_checksum = ? WHERE release_id = ?')
      .run('f'.repeat(64), release.release_id);
    assertConflict();
    fixture.store.db.prepare('UPDATE pipeline_releases SET release_checksum = ? WHERE release_id = ?')
      .run(release.release_checksum, release.release_id);
    fixture.store.db.prepare('UPDATE interaction_lanes SET clear_epoch = ? WHERE role_id = ? AND lane_key = ?')
      .run(Number(lane.clearEpoch) + 1, 'yuqi', 'private_chat');
    assertConflict();
    fixture.store.db.prepare('UPDATE interaction_lanes SET clear_epoch = ? WHERE role_id = ? AND lane_key = ?')
      .run(lane.clearEpoch, 'yuqi', 'private_chat');
    fixture.store.assertVisibleAuthorityV13Invariants = originalFull;
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('comparison diagnostics use real canary writer pins and never trust job criticalCodes', async () => {
  const fixture = realCanonicalFixture({ canary: true });
  try {
    await new YuqiOrchestrator({
      store: fixture.store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor: fixture.releaseExecutor, clock: () => 1784400000100, lifePlanningEnabled: false
    }).run(fixture.turn.turnId);
    const turn = fixture.store.getTurn(fixture.turn.turnId);
    assert.equal(turn.comparisonMode, 'legacy_compare');
    const receipt = fixture.store.db.prepare(`SELECT lineage_key, group_id, commit_checksum FROM visible_commit_receipts WHERE authoritative_turn_id = ?`).get(turn.turnId);
    const job = fixture.store.comparisonJobsForGroup(receipt.group_id)[0];
    assert.ok(job);
    assert.equal(job.subjectId, receipt.lineage_key);
    assert.equal(job.turnId, turn.turnId);
    assert.equal(job.authorityGroupId, receipt.group_id);
    const pipelineChecksum = turn.comparisonPipelineChecksum;
    const turnPin = {
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      rolloutRevision: Number(turn.rolloutRevision),
      evidenceEpoch: Number(turn.rolloutEvidenceEpoch),
      shadowEpoch: Number(turn.shadowEpoch ?? 0),
      canaryEpoch: Number(turn.canaryEpoch ?? 0),
      canarySlot: turn.canarySlot == null ? null : Number(turn.canarySlot),
      authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
      comparisonPipelineChecksum: pipelineChecksum
    };
    // A canonical turn's persisted comparison mode owns one direction/job.
    // Keep an opposite production-shaped job red until the scoped loader rejects it.
    const rawJob = fixture.store.db.prepare(
      'SELECT * FROM consolidation_jobs WHERE job_id = ?'
    ).get(job.jobId);
    fixture.store.db.prepare('DELETE FROM consolidation_jobs WHERE job_id = ?').run(job.jobId);
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare(`
      INSERT INTO consolidation_jobs(
        job_id, subject_type, subject_id, turn_id, role_id, job_type, state,
        attempt_count, due_at, lease_owner, lease_expires_at, payload_json,
        payload_checksum, last_error_code, created_at, updated_at,
        authority_group_id, authority_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rawJob.job_id, rawJob.subject_type, rawJob.subject_id, rawJob.turn_id,
      rawJob.role_id, rawJob.job_type, rawJob.state, rawJob.attempt_count,
      rawJob.due_at, rawJob.lease_owner, rawJob.lease_expires_at, rawJob.payload_json,
      rawJob.payload_checksum, rawJob.last_error_code, rawJob.created_at,
      rawJob.updated_at, rawJob.authority_group_id, rawJob.authority_ordinal
    );
    const oppositeJobType = job.job_type === 'shadow_cognition'
      ? 'active_canary_compare' : 'shadow_cognition';
    fixture.store.db.prepare(`
      INSERT INTO consolidation_jobs(
        job_id, subject_type, subject_id, turn_id, role_id, job_type, state,
        attempt_count, due_at, lease_owner, lease_expires_at, payload_json,
        payload_checksum, last_error_code, created_at, updated_at,
        authority_group_id, authority_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      'job_diag_opposite_direction', rawJob.subject_type, rawJob.subject_id,
      rawJob.turn_id, rawJob.role_id, oppositeJobType, rawJob.due_at,
      rawJob.payload_json, rawJob.payload_checksum, rawJob.created_at,
      rawJob.updated_at, rawJob.authority_group_id, Number(rawJob.authority_ordinal) + 1
    );
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare('DELETE FROM consolidation_jobs WHERE job_id = ?')
      .run('job_diag_opposite_direction');
    const originalGetTurn = fixture.store.getTurn.bind(fixture.store);
    fixture.store.getTurn = () => {
      throw new Error('diagnostics comparison loader must not call getTurn');
    };
    const pending = fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    });
    assert.deepEqual(pending.stateCounts, {});
    fixture.store.getTurn = originalGetTurn;
    const claimed = fixture.store.claimDueConsolidationJob({
      workerId: 'diagnostic-worker', jobTypes: [job.jobType], now: turn.updatedAt, leaseMs: 60_000
    });
    assert.equal(claimed.jobId, job.jobId);
    fixture.store.recordComparisonOutcomeInternal({
      jobId: job.jobId,
      workerId: 'diagnostic-worker',
      run: {
        runId: 'run_diag_comparison', comparisonDirection: job.payload.comparisonDirection,
        evidenceEpoch: turn.rolloutEvidenceEpoch, shadowEpoch: turn.shadowEpoch,
        canaryEpoch: turn.canaryEpoch, canarySlot: turn.canarySlot,
        rolloutRevision: turn.rolloutRevision, pipelineChecksum,
        state: 'completed', authoritativeResultChecksum: receipt.commitChecksum,
        comparisonResultChecksum: 'b'.repeat(64), criticalFindings: [{ code: 'CURRENT_BATCH_OMISSION' }],
        metrics: {}, createdAt: turn.updatedAt, updatedAt: turn.updatedAt
      },
      report: { summary: {} },
      criticalFindings: [{ code: 'CURRENT_BATCH_OMISSION' }],
      now: turn.updatedAt + 1
    });
    fixture.store.getTurn = () => {
      throw new Error('diagnostics comparison loader must not call getTurn');
    };
    const comparison = fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    });
    assert.deepEqual(comparison.stateCounts, { completed: 1 });
    assert.deepEqual(comparison.criticalCodes, ['CURRENT_BATCH_OMISSION']);
    const persistedRun = fixture.store.getCognitionShadowRun('run_diag_comparison');
    fixture.store.db.prepare('DELETE FROM cognition_shadow_runs WHERE run_id = ?').run('run_diag_comparison');
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.putCognitionShadowRunInternal(persistedRun);
    fixture.store.db.prepare('UPDATE consolidation_jobs SET state = ? WHERE job_id = ?')
      .run('queued', job.jobId);
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare('UPDATE consolidation_jobs SET state = ? WHERE job_id = ?')
      .run('completed', job.jobId);
    const reportRow = fixture.store.db.prepare(
      `SELECT summary_json, artifact_checksum FROM cognition_evaluation_reports
       WHERE source_type = 'comparison_run' AND source_ref = ?`
    ).get(job.jobId);
    const forgedSummary = { ...JSON.parse(reportRow.summary_json), staleForRollout: 0 };
    fixture.store.db.prepare(
      'UPDATE cognition_evaluation_reports SET summary_json = ?, artifact_checksum = ? WHERE source_type = ? AND source_ref = ?'
    ).run(JSON.stringify(forgedSummary), contentHash(forgedSummary), 'comparison_run', job.jobId);
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare(
      'UPDATE cognition_evaluation_reports SET summary_json = ?, artifact_checksum = ? WHERE source_type = ? AND source_ref = ?'
    ).run(reportRow.summary_json, reportRow.artifact_checksum, 'comparison_run', job.jobId);
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET authoritative_result_checksum = ? WHERE run_id = ?'
    ).run('c'.repeat(64), 'run_diag_comparison');
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET authoritative_result_checksum = ? WHERE run_id = ?'
    ).run(receipt.commit_checksum, 'run_diag_comparison');
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET comparison_result_checksum = ? WHERE run_id = ?'
    ).run('d'.repeat(64), 'run_diag_comparison');
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET comparison_result_checksum = ? WHERE run_id = ?'
    ).run('b'.repeat(64), 'run_diag_comparison');
    // A known code is not sufficient evidence: the checksummed comparison report
    // must still exactly close over the run's findings.
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET critical_findings_json = ? WHERE run_id = ?'
    ).run(JSON.stringify([{ code: 'DIRECT_REPLY_SKIP' }]), 'run_diag_comparison');
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
    fixture.store.db.prepare(
      'UPDATE cognition_shadow_runs SET critical_findings_json = ? WHERE run_id = ?'
    ).run(JSON.stringify([{ code: 'CURRENT_BATCH_OMISSION' }]), 'run_diag_comparison');
    fixture.store.db.prepare(`UPDATE cognition_shadow_runs SET critical_findings_json = ? WHERE run_id = ?`)
      .run(JSON.stringify([{ code: 'MADE_UP_RUN_CODE' }]), 'run_diag_comparison');
    assert.throws(() => fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    }), V3DiagnosticAuthorityConflict);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('comparison diagnostics use the real shadow writer and unique mode direction', async () => {
  const fixture = realCanonicalFixture({ shadow: true });
  try {
    await new YuqiOrchestrator({
      store: fixture.store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor: fixture.releaseExecutor, clock: () => 1784400000100, lifePlanningEnabled: false
    }).run(fixture.turn.turnId);
    const turn = fixture.store.getTurn(fixture.turn.turnId);
    assert.equal(turn.comparisonMode, 'cognition_compare');
    const receipt = fixture.store.db.prepare(
      `SELECT lineage_key, group_id FROM visible_commit_receipts WHERE authoritative_turn_id = ?`
    ).get(turn.turnId);
    const job = fixture.store.comparisonJobsForGroup(receipt.group_id)[0];
    assert.equal(job.jobType, 'shadow_cognition');
    const turnPin = {
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      rolloutRevision: Number(turn.rolloutRevision),
      evidenceEpoch: Number(turn.rolloutEvidenceEpoch),
      shadowEpoch: Number(turn.shadowEpoch ?? 0),
      canaryEpoch: Number(turn.canaryEpoch ?? 0),
      canarySlot: turn.canarySlot == null ? null : Number(turn.canarySlot),
      authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
      comparisonPipelineChecksum: turn.comparisonPipelineChecksum
    };
    const comparison = fixture.store.loadTurnComparisonDiagnosticsInternal({
      turnId: turn.turnId, lineageKey: receipt.lineage_key, rolloutKey: turn.rolloutKey,
      groupId: receipt.group_id, turnPin
    });
    assert.deepEqual(comparison.stateCounts, {});
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
