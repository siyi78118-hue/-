import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { buildCognitionV3Input } from '../src/cognition-context.mjs';
import { buildCognitionEnvelopeV3 } from '../src/cognition-v3-adapters.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import {
  assertCanonicalActionSetForTurn,
  shouldSkipPublicMomentSilence
} from '../src/orchestrator.mjs';
import { contentHash, validateEnvelope } from '../src/protocol.mjs';
import { YuqiOrchestrator } from '../src/orchestrator.mjs';
import { YuqiStore } from '../src/store.mjs';
import { canonicalCommitPayload, commitVisibleResult } from '../src/visible-result-commit.mjs';

const SHA = 'a'.repeat(64);

function withTempStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-moments-v3-'));
  const path = join(directory, 'memory.sqlite');
  const store = new YuqiStore(path);
  try {
    return run(store, path);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
}

function targetMoment() {
  return {
    momentId: 'moment_public_1',
    authorType: 'character',
    authorId: 'yuqi',
    text: '今天的公开动态',
    createdAt: 1_000,
    likes: ['user'],
    comments: [{
      commentId: 'comment_public_1',
      authorType: 'user',
      authorId: 'user',
      text: '看到了',
      createdAt: 1_100,
      replyToCommentId: null
    }]
  };
}

function v3MomentEnvelope(index, kind = 'MOMENT_INTERACTION', context = {}) {
  const triggerId = `trigger_moment_${index}`;
  const moment = targetMoment();
  const laneKey = ['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'].includes(kind)
    ? 'public_moment'
    : `moment_interaction:${moment.momentId}`;
  const envelope = {
    protocolVersion: 3,
    turnId: `turn_moment_${index}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: index,
    createdAt: 2_000 + index,
    kind,
    trigger: {
      triggerId,
      triggerType: kind.toLowerCase(),
      scheduledFor: 1_900 + index,
      executedAt: 2_000 + index,
      context: {
        ...(kind === 'MOMENT_INTERACTION' || kind === 'MOMENT_REPLY' ? {
          targetMoment: moment,
          targetComment: kind === 'MOMENT_REPLY' ? moment.comments[0] : null
        } : {}),
        ...context
      }
    },
    context: {
      visibilityCursor: {
        nativeCompletedTurnId: null,
        nativeCompletedGroupId: null,
        nativeCompletedSequence: 0,
        uiAppliedTurnId: null,
        uiAppliedGroupId: null,
        uiAppliedSequence: 0,
        // Each temporary store starts with an empty lane; the first canonical
        // input watermark is therefore sequence 1.  The device sequence stays
        // unique per fixture, but must not be confused with the lane cursor.
        localSequence: 1,
        clearedThroughSequence: 0,
        clearEpoch: 0,
        clearedAt: 0,
        chatOpen: true,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey, rootSourceId: triggerId
      }),
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  };
  return envelope;
}

function publicCandidate() {
  return {
    version: 'public-moment-candidate-v1',
    visibility: 'public',
    summary: '公开安全摘要'
  };
}

test('generic life-plan writers reject the reserved public moment marker before any write', () =>
  withTempStore(store => {
    const before = store.db.prepare('SELECT COUNT(*) AS value FROM life_episodes').get().value;
    assert.throws(() => store.putLifePlan('yuqi', [{
      episodeId: 'episode_public_marker_forbidden',
      kind: 'personal',
      title: '普通生活计划',
      startAt: 0,
      endAt: 10_000,
      payload: { publicMomentCandidate: publicCandidate() }
    }]), /reserved public moment candidate/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM life_episodes').get().value, before);
  }));

test('valid v3 interaction and reply targets normalize without changing order', () => {
  const interaction = v3MomentEnvelope(90, 'MOMENT_INTERACTION');
  const reply = v3MomentEnvelope(91, 'MOMENT_REPLY');
  assert.doesNotThrow(() => validateEnvelope(interaction));
  assert.doesNotThrow(() => validateEnvelope(reply));
  const normalizedReply = validateEnvelope(reply);
  assert.deepEqual(
    normalizedReply.trigger.context.targetMoment.comments.map(comment => comment.commentId),
    ['comment_public_1']
  );
  assert.deepEqual(
    normalizedReply.trigger.context.targetComment,
    normalizedReply.trigger.context.targetMoment.comments[0]
  );
});

test('v3 moment target identity is closed across authors and likes', () => {
  const valid = v3MomentEnvelope(92, 'MOMENT_INTERACTION');
  valid.trigger.context.targetMoment.likes = ['user'];
  assert.doesNotThrow(() => validateEnvelope(valid));
  const wrongUser = structuredClone(valid);
  wrongUser.trigger.context.targetMoment.authorType = 'user';
  wrongUser.trigger.context.targetMoment.authorId = 'character_1';
  assert.throws(() => validateEnvelope(wrongUser), /author identity|author/);
  const wrongCharacter = structuredClone(valid);
  wrongCharacter.trigger.context.targetMoment.authorType = 'character';
  wrongCharacter.trigger.context.targetMoment.authorId = 'user';
  assert.throws(() => validateEnvelope(wrongCharacter), /author identity|author/);
  const aliasLike = structuredClone(valid);
  aliasLike.trigger.context.targetMoment.likes = ['player'];
  assert.throws(() => validateEnvelope(aliasLike), /likes/);
});

test('wire-v3 moment triggers reject generic and legacy target fields', () => {
  const generic = v3MomentEnvelope(1, 'MOMENT_INTERACTION', {
    snapshot: { moment: targetMoment() }
  });
  assert.throws(() => validateEnvelope(generic), /target|context|snapshot|keys conflict/);

  const legacy = v3MomentEnvelope(2, 'MOMENT_REPLY', {
    moment: targetMoment(),
    playerComment: targetMoment().comments[0],
    replyToCommentId: 'comment_public_1'
  });
  assert.throws(() => validateEnvelope(legacy), /target|context|legacy|keys conflict/);
});

test('wire-v3 moment reply requires the exact player-authored comment in its target thread', () => {
  const changed = v3MomentEnvelope(3, 'MOMENT_REPLY');
  changed.trigger.context.targetComment = {
    ...changed.trigger.context.targetMoment.comments[0],
    text: '伪造评论'
  };
  assert.throws(() => validateEnvelope(changed), /comment|target|authority/);

  const foreign = v3MomentEnvelope(4, 'MOMENT_REPLY');
  foreign.trigger.context.targetComment = {
    ...foreign.trigger.context.targetMoment.comments[0],
    authorId: 'other_user'
  };
  assert.throws(() => validateEnvelope(foreign), /comment|author|target|authority/);
});

test('fresh wire-v3 PROACTIVE_MOMENT cannot accept a caller-forged public authority', () =>
  withTempStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'PROACTIVE_MOMENT',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const envelope = v3MomentEnvelope(5, 'PROACTIVE_MOMENT');
    const authorityBody = {
      version: 'public-moment-authority-v1',
      consideredAt: envelope.createdAt,
      candidates: [{
        evidenceId: 'public_event_forged',
        sourceEpisodeId: 'episode_missing',
        sourceChecksum: SHA,
        occurredAt: envelope.createdAt - 1,
        expiresAt: envelope.createdAt + 1,
        summary: '伪造公开证据'
      }],
      structuralSilence: null
    };
    const before = store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value;
    const rollout = store.getCognitionRollout('PROACTIVE_MOMENT');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    assert.throws(() => store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'PROACTIVE_MOMENT',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'public_moment',
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {
        publicMomentAuthority: {
          ...authorityBody,
          checksum: contentHash(authorityBody)
        }
      }
    }), /public moment authority/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value, before);
  }));

test('public moment empty candidates or structural silence is a pre-model zero-result skip', () => {
  assert.equal(shouldSkipPublicMomentSilence({
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_MOMENT',
    annotationSnapshot: { publicMomentAuthority: { candidates: [], structuralSilence: null } }
  }), true);
  assert.equal(shouldSkipPublicMomentSilence({
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_MOMENT',
    annotationSnapshot: {
      publicMomentAuthority: {
        candidates: [{ evidenceId: 'event_1' }],
        structuralSilence: { reasonCode: 'ACTIVE_PUBLIC_MOMENT_CONSTRAINT' }
      }
    }
  }), true);
  assert.equal(shouldSkipPublicMomentSilence({
    protocolVersion: 3,
    rolloutKey: 'MOMENT_INTERACTION',
    annotationSnapshot: { publicMomentAuthority: { candidates: [] } }
  }), false);
});

test('fresh wire-v3 moment interaction derives and pins target authority in the store transaction', () =>
  withTempStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'MOMENT_INTERACTION',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const envelope = v3MomentEnvelope(7, 'MOMENT_INTERACTION');
    const rollout = store.getCognitionRollout('MOMENT_INTERACTION');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    const targetAuthority = {
      version: 'moment-target-authority-v1',
      targetMoment: envelope.trigger.context.targetMoment,
      targetComment: null
    };
    targetAuthority.checksum = contentHash(targetAuthority);
    const input = {
      envelope,
      rolloutKey: 'MOMENT_INTERACTION',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'moment_interaction:moment_public_1',
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { momentTargetAuthority: targetAuthority }
    };
    assert.throws(() => store.createCanonicalVisibleTurnInternal({
      ...input,
      annotationSnapshot: {}
    }), /moment target authority/);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value, 0);
    const created = store.createCanonicalVisibleTurnInternal(input);
    assert.equal(created.status, 'created');
    assert.deepEqual(created.turn.annotationSnapshot.momentTargetAuthority, targetAuthority);
    const persisted = store.getTurn(envelope.turnId);
    assert.deepEqual(persisted.annotationSnapshot.momentTargetAuthority, targetAuthority);
  }));

test('moment target authority survives close/reopen and changed exact replay is zero-write', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-moment-reopen-'));
  const path = join(directory, 'memory.sqlite');
  const envelope = v3MomentEnvelope(10, 'MOMENT_REPLY');
  const targetAuthority = {
    version: 'moment-target-authority-v1',
    targetMoment: envelope.trigger.context.targetMoment,
    targetComment: envelope.trigger.context.targetComment
  };
  targetAuthority.checksum = contentHash(targetAuthority);
  const buildInput = store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'MOMENT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('MOMENT_REPLY');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    return {
      envelope,
      rolloutKey: 'MOMENT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'moment_interaction:moment_public_1',
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { momentTargetAuthority: targetAuthority }
    };
  };
  try {
    const first = new YuqiStore(path);
    const input = buildInput(first);
    const created = first.createCanonicalVisibleTurnInternal(input);
    assert.equal(created.status, 'created');
    first.close();

    const reopened = new YuqiStore(path);
    assert.deepEqual(
      reopened.getTurn(envelope.turnId).annotationSnapshot.momentTargetAuthority,
      targetAuthority
    );
    const replay = reopened.createCanonicalVisibleTurnInternal(input);
    assert.equal(replay.status, 'created');
    const before = reopened.db.prepare('SELECT annotation_snapshot_json FROM turns WHERE turn_id = ?')
      .get(envelope.turnId).annotation_snapshot_json;
    const changed = structuredClone(input);
    changed.envelope = structuredClone(envelope);
    changed.envelope.trigger.context.targetMoment.text = 'changed target';
    assert.throws(() => reopened.createCanonicalVisibleTurnInternal(changed), /canonical turn authority/);
    assert.equal(
      reopened.db.prepare('SELECT annotation_snapshot_json FROM turns WHERE turn_id = ?')
        .get(envelope.turnId).annotation_snapshot_json,
      before
    );
    const missing = structuredClone(input);
    missing.annotationSnapshot = {};
    assert.throws(() => reopened.createCanonicalVisibleTurnInternal(missing), /canonical turn authority/);
    assert.equal(
      reopened.db.prepare('SELECT COUNT(*) AS value FROM turns WHERE turn_id = ?')
        .get(envelope.turnId).value,
      1
    );
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('fresh wire-v3 moment action commits v4 and exact replay preserves its payload version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-moment-v4-'));
  const path = join(directory, 'memory.sqlite');
  const envelope = v3MomentEnvelope(30, 'MOMENT_INTERACTION');
  const authority = {
    version: 'moment-target-authority-v1',
    targetMoment: envelope.trigger.context.targetMoment,
    targetComment: null
  };
  authority.checksum = contentHash(authority);
  const build = store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'MOMENT_INTERACTION',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('MOMENT_INTERACTION');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    return store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'MOMENT_INTERACTION',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: envelope.authority.laneKey,
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { momentTargetAuthority: authority }
    }).turn;
  };
  try {
    const first = new YuqiStore(path);
    const turn = build(first);
    const payload = { momentId: 'moment_public_1', like: true, comment: '', replyToCommentId: null };
    const resolved = first.resolveCanonicalActionTargetInternal({
      turn,
      action: { kind: 'moment_like', payload }
    });
    const actionSet = [{
      kind: 'moment_like',
      payload,
      targetKey: resolved.targetKey,
      targetRevision: resolved.targetRevision
    }];
    const visibleGroup = { items: [] };
    const contextRevision = contentHash({
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      momentTargetAuthorityChecksum: authority.checksum
    });
    const input = {
      store: first,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: first.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: first.getInteractionLane('yuqi', turn.laneKey).revision,
      expectedCognitiveStateRevision: 0,
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet,
      momentTargetAuthorityChecksum: authority.checksum,
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generationFingerprint({
        roleId: turn.characterId,
        laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup,
        actionSet,
        contextRevision
      }),
      now: 2000
    };
    const receipt = commitVisibleResult(input);
    assert.equal(receipt.commitPayloadVersion, 'pc-visible-commit-v4');
    first.close();

    const reopened = new YuqiStore(path);
    const outcome = reopened.readCanonicalCommitOutcomeInternal({
      lineageKey: turn.authorityLineageKey,
      expectedTurnId: turn.turnId,
      expectedOrigin: 'pc'
    });
    assert.equal(outcome.receipt.commitPayloadVersion, 'pc-visible-commit-v4');
    const replay = commitVisibleResult({ ...input, store: reopened });
    assert.equal(replay.commitPayloadVersion, 'pc-visible-commit-v4');
    const manifestRow = reopened.db.prepare(
      'SELECT semantic_json FROM visible_result_manifests WHERE group_id = ?'
    ).get(replay.visibleGroupId);
    const forgedManifest = JSON.parse(manifestRow.semantic_json);
    forgedManifest.publicMomentEvidenceIds = [];
    reopened.db.prepare(`
      UPDATE visible_result_manifests
      SET semantic_json = ?, semantic_checksum = ?
      WHERE group_id = ?
    `).run(JSON.stringify(forgedManifest), contentHash(forgedManifest), replay.visibleGroupId);
    assert.throws(() => reopened.readCanonicalCommitOutcomeInternal({
      lineageKey: turn.authorityLineageKey,
      expectedTurnId: turn.turnId,
      expectedOrigin: 'pc'
    }), /moment authority|canonical commit authority/);
    reopened.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('v4 moment payload rejects cross-kind authority fields', () => {
  assert.throws(() => canonicalCommitPayload({
    protocolVersion: 3,
    turnKind: 'PROACTIVE_MOMENT',
    publicMomentEvidenceIds: [],
    momentTargetAuthorityChecksum: SHA
  }), /v4 field conflict/);
  assert.throws(() => canonicalCommitPayload({
    protocolVersion: 3,
    turnKind: 'MOMENT_REPLY',
    momentTargetAuthorityChecksum: SHA,
    publicMomentEvidenceIds: []
  }), /v4 field conflict/);
});

test('moment action kinds are closed per interaction kind and non-skip empty intent fails closed', () => {
  assert.throws(() => assertCanonicalActionSetForTurn({
    turnKind: 'MOMENT_INTERACTION',
    action: 'respond',
    actionSet: [{ kind: 'moment_reply' }]
  }), /moment action authority/);
  assert.throws(() => assertCanonicalActionSetForTurn({
    turnKind: 'MOMENT_REPLY',
    action: 'respond',
    actionSet: [{ kind: 'moment_comment' }]
  }), /moment action authority/);
  assert.throws(() => assertCanonicalActionSetForTurn({
    turnKind: 'MOMENT_INTERACTION',
    action: 'respond',
    actionSet: []
  }), /moment action authority/);
  assert.doesNotThrow(() => assertCanonicalActionSetForTurn({
    turnKind: 'MOMENT_INTERACTION',
    action: 'skip',
    actionSet: []
  }));
});

test('wire-v3 role-plan moments use public_moments projections across reopen and reject private action kinds', () =>
  withTempStore((store, path) => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'ROLE_PLAN_MOMENT',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const envelope = v3MomentEnvelope(71, 'ROLE_PLAN_MOMENT');
    const rollout = store.getCognitionRollout('ROLE_PLAN_MOMENT');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    const created = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'ROLE_PLAN_MOMENT',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: envelope.authority.laneKey,
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    });
    const turn = created.turn;
    const visibleGroup = {
      items: [{
        content: '公开计划动态',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'public_moments'
      }]
    };
    const generationFingerprintValue = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: [],
      contextRevision: turn.agencySnapshotChecksum
    });
    const commit = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
      expectedCognitiveStateRevision: Number(store.getCognitiveState('yuqi')?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet: [],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generationFingerprintValue,
      now: 3000
    });
    assert.equal(commit.committed, true);
    const message = store.db.prepare(
      'SELECT recipient_id FROM messages WHERE authority_group_id = ?'
    ).get(commit.visibleGroupId);
    assert.equal(message.recipient_id, 'public_moments');
    assert.equal(store.db.prepare(
      'SELECT payload_version FROM visible_result_manifests WHERE group_id = ?'
    ).get(commit.visibleGroupId).payload_version, 'pc-visible-commit-v2');
    assert.throws(() => commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      actionSet: [{ kind: 'payment_accept', targetKey: 'payment:private', targetRevision: '1', payload: {} }]
    }), /public moment action authority conflict/);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.visibleGroupsForLineage(turn.authorityLineageKey).length, 1);
      const reopenedMessage = reopened.db.prepare(
        'SELECT recipient_id FROM messages WHERE authority_group_id = ?'
      ).get(commit.visibleGroupId);
      assert.equal(reopenedMessage.recipient_id, 'public_moments');
      assert.equal(Number(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value), 1);
      reopened.db.prepare(
        'UPDATE messages SET recipient_id = ? WHERE authority_group_id = ?'
      ).run('user', commit.visibleGroupId);
      assert.throws(() => reopened.assertVisibleAuthorityV13Invariants(), /canonical_item_message_projection/);
      reopened.close();
      assert.throws(() => new YuqiStore(path), /canonical_item_message_projection/);
    } finally {
      try { reopened.close(); } catch {}
    }
  }));

test('wire-v3 PROACTIVE_MOMENT visible items persist public_moments recipient through reopen', () =>
  withTempStore((store, path) => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'PROACTIVE_MOMENT',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const marker = publicCandidate();
    store.db.prepare(`
      INSERT INTO life_episodes(
        episode_id, character_id, kind, title, start_at, end_at, status,
        payload_json, checksum, source_turn_id, adjustment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'episode_public_moment_v3', 'yuqi', 'personal', '公开事件', 0, 1_000, 'completed',
      JSON.stringify({ publicMomentCandidate: marker }), SHA, null, '', 1, 1
    );
    store.db.prepare(`
      INSERT INTO life_episodes(
        episode_id, character_id, kind, title, start_at, end_at, status,
        payload_json, checksum, source_turn_id, adjustment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'episode_public_moment_v3_second', 'yuqi', 'personal', '第二公开事件', 0, 900, 'completed',
      JSON.stringify({ publicMomentCandidate: marker }), 'b'.repeat(64), null, '', 1, 1
    );
    const envelope = v3MomentEnvelope(72, 'PROACTIVE_MOMENT');
    store.db.prepare(`
      INSERT INTO life_episodes(
        episode_id, character_id, kind, title, start_at, end_at, status,
        payload_json, checksum, source_turn_id, adjustment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'episode_public_moment_expired', 'yuqi', 'personal', '过期公开事件', 0,
      envelope.createdAt - 12 * 60 * 60_000, 'completed',
      JSON.stringify({ publicMomentCandidate: marker }), 'c'.repeat(64), null, '', 1, 1
    );
    const rollout = store.getCognitionRollout('PROACTIVE_MOMENT');
    const authority = store.rebuildPublicMomentAuthorityInternal({ envelope });
    assert.equal(authority.candidates.length, 2);
    assert.equal(
      authority.candidates.some(candidate => candidate.sourceEpisodeId === 'episode_public_moment_expired'),
      false
    );
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    const created = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'PROACTIVE_MOMENT',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: envelope.authority.laneKey,
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { publicMomentAuthority: authority }
    });
    const turn = created.turn;
    const visibleGroup = {
      items: [{
        content: '今天的公开动态',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'public_moments'
      }]
    };
    const fingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: [],
      contextRevision: contentHash({
        agencySnapshotChecksum: turn.agencySnapshotChecksum,
        momentTargetAuthorityChecksum: authority.checksum
      })
    });
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const lane = store.getInteractionLane('yuqi', turn.laneKey);
    const commit = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision: Number(store.getCognitiveState('yuqi')?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet: [],
      publicMomentEvidenceIds: [authority.candidates[0].evidenceId],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: fingerprint,
      now: 3_000
    });
    const message = store.db.prepare(
      'SELECT recipient_id FROM messages WHERE authority_group_id = ?'
    ).get(commit.visibleGroupId);
    assert.equal(message.recipient_id, 'public_moments');
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.visibleGroupsForLineage(turn.authorityLineageKey).length, 1);
      const afterCommitAuthority = reopened.rebuildPublicMomentAuthorityInternal({ envelope });
      assert.equal(afterCommitAuthority.candidates.length, 1);
      assert.notEqual(
        afterCommitAuthority.candidates[0].evidenceId,
        authority.candidates[0].evidenceId
      );
      const reopenedMessage = reopened.db.prepare(
        'SELECT recipient_id FROM messages WHERE authority_group_id = ?'
      ).get(commit.visibleGroupId);
      assert.equal(reopenedMessage.recipient_id, 'public_moments');
    } finally {
      reopened.close();
    }
  }));

test('redacted v4 public moment receipt is semantic-free and excluded from consumption', () =>
  withTempStore((store, path) => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'PROACTIVE_MOMENT',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const marker = publicCandidate();
    store.db.prepare(`
      INSERT INTO life_episodes(
        episode_id, character_id, kind, title, start_at, end_at, status,
        payload_json, checksum, source_turn_id, adjustment_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'episode_redacted_public_moment', 'yuqi', 'personal', '需删除的公开事件', 0, 1_000,
      'completed', JSON.stringify({ publicMomentCandidate: marker }), SHA, null, '', 1, 1
    );
    const envelope = v3MomentEnvelope(73, 'PROACTIVE_MOMENT');
    const rollout = store.getCognitionRollout('PROACTIVE_MOMENT');
    const authority = store.rebuildPublicMomentAuthorityInternal({ envelope });
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    const created = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'PROACTIVE_MOMENT',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: envelope.authority.laneKey,
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { publicMomentAuthority: authority }
    });
    const turn = created.turn;
    const visibleGroup = {
      items: [{
        content: '待删除的公开动态', speakerId: 'yuqi', speakerType: 'character', recipientId: 'public_moments'
      }]
    };
    const fingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: [],
      contextRevision: contentHash({
        agencySnapshotChecksum: turn.agencySnapshotChecksum,
        momentTargetAuthorityChecksum: authority.checksum
      })
    });
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const lane = store.getInteractionLane('yuqi', turn.laneKey);
    const commit = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision: Number(store.getCognitiveState('yuqi')?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet: [],
      publicMomentEvidenceIds: [authority.candidates[0].evidenceId],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: fingerprint,
      now: 3_000
    });
    const groupId = commit.visibleGroupId;
    const redactedAt = 50_000;
    const group = store.db.prepare(
      'SELECT lineage_key, authoritative_turn_id FROM visible_result_groups WHERE group_id = ?'
    ).get(groupId);
    const deliveries = store.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id'
    ).all(groupId);
    const deliveryCommitment = contentHash({
      version: 'authority-redaction-deliveries-v1',
      groupId,
      deliveryCount: deliveries.length,
      deliveries: deliveries.map(row => ({
        peerId: row.peer_id,
        recoveryAckSeq: Number(row.recovery_ack_seq),
        relayMessageId: row.relay_message_id == null ? null : row.relay_message_id,
        authorityCommitChecksum: row.authority_commit_checksum
      }))
    });
    store.db.exec('BEGIN IMMEDIATE');
    try {
      store.db.prepare(`
        UPDATE cloud_deliveries
        SET state = CASE WHEN relay_message_id IS NULL THEN 'redacted' ELSE 'redaction_pending' END,
            payload_json = NULL, checksum = NULL,
            redaction_requested_at = CASE WHEN relay_message_id IS NULL THEN NULL ELSE ? END,
            redaction_acknowledged_at = CASE WHEN relay_message_id IS NULL THEN ? ELSE NULL END,
            updated_at = ?
        WHERE authority_group_id = ?
      `).run(redactedAt, redactedAt, redactedAt, groupId);
      store.db.prepare(`
        UPDATE turns
        SET envelope_json = '{"redacted":true}', memory_packet_json = NULL,
            brain_draft_json = NULL, supervisor_json = NULL, reply_json = NULL,
            error_json = NULL, route_reasons_json = '[]', annotation_snapshot_json = '{}',
            authority_redacted_at = ?, updated_at = ?
        WHERE authority_lineage_key = ?
      `).run(redactedAt, redactedAt, group.lineage_key);
      store.db.prepare(`
        UPDATE current_user_batch_items
        SET message_json = NULL, redacted_at = ?
        WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?)
      `).run(redactedAt, group.lineage_key);
      store.db.prepare('UPDATE messages SET content = ? WHERE authority_group_id = ?')
        .run('', groupId);
      store.db.prepare('DELETE FROM annotations WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?)')
        .run(group.lineage_key);
      store.db.prepare('DELETE FROM diagnostics WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?)')
        .run(group.lineage_key);
      store.db.prepare('DELETE FROM sessions WHERE role = ?').run('yuqi');
      store.db.prepare(`
        UPDATE interaction_lanes
        SET latest_authoritative_group_id = NULL, native_completed_group_id = NULL,
            ui_applied_group_id = NULL, last_commit_checksum = NULL
        WHERE latest_authoritative_group_id = ? OR native_completed_group_id = ? OR ui_applied_group_id = ?
      `).run(groupId, groupId, groupId);
      store.db.prepare('UPDATE visible_result_items SET item_json = NULL, redacted_at = ? WHERE group_id = ?')
        .run(redactedAt, groupId);
      store.db.prepare(`
        UPDATE visible_result_actions
        SET action_kind = NULL, target_key = NULL, target_revision = NULL, action_json = NULL, redacted_at = ?
        WHERE group_id = ?
      `).run(redactedAt, groupId);
      store.db.prepare('UPDATE visible_result_manifests SET semantic_json = NULL, redacted_at = ? WHERE group_id = ?')
        .run(redactedAt, groupId);
      store.db.prepare(`
        UPDATE visible_result_groups
        SET redacted_at = ?, redaction_delivery_count = ?, redaction_delivery_commitment = ?
        WHERE group_id = ?
      `).run(redactedAt, deliveries.length, deliveryCommitment, groupId);
      store.db.prepare('UPDATE turn_authority_lineages SET redacted_at = ? WHERE lineage_key = ?')
        .run(redactedAt, group.lineage_key);
      store.db.prepare(`
        DELETE FROM sync_log
        WHERE entity_id = ? OR entity_id IN (SELECT message_id FROM messages WHERE authority_group_id = ?)
      `).run(group.authoritative_turn_id, groupId);
      const audit = { groupId, reasonCode: 'user_clear', redactedAt };
      store.db.prepare(`
        INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
        VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)
      `).run(groupId, JSON.stringify(audit), contentHash(audit), redactedAt);
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(store.listConsumedPublicMomentEvidenceIdsInternal({ roleId: 'yuqi' }), []);
    assert.equal(store.assertVisibleGroupAuthorityInternal(groupId, {
      purpose: 'public_moment_consumption'
    }).status, 'redacted');
    store.close();
    assert.doesNotThrow(() => new YuqiStore(path).close());
  }));

test('orchestrator accept supplies store-owned public and target annotations before canonical creation', () =>
  withTempStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [
        {
          rolloutKey: 'PROACTIVE_MOMENT',
          currentMode: 'legacy',
          rolloutPhase: 'stable',
          presetVersion: '1.9.2',
          pipelineChecksum: SHA
        },
        {
          rolloutKey: 'MOMENT_INTERACTION',
          currentMode: 'legacy',
          rolloutPhase: 'stable',
          presetVersion: '1.9.2',
          pipelineChecksum: SHA
        }
      ],
      now: 1
    });
    const promotionController = {
      selectPipelinePairForFreshSubject(kind) {
        const rollout = store.getCognitionRollout(kind);
        return {
          rollout,
          pair: {
            visibleReleaseId: rollout.stableReleaseId,
            comparisonReleaseId: null,
            comparisonDirection: null
          }
        };
      }
    };
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }) },
      codex: {},
      promotionController,
      releaseExecutor: { executeTurn() {}, executeLife() {} },
      lifePlanningEnabled: false,
      clock: () => 20_000
    });
    const envelope = v3MomentEnvelope(8, 'PROACTIVE_MOMENT');
    const accepted = orchestrator.accept(envelope);
    assert.equal(accepted.resultAuthorityVersion, 1);
    const persisted = store.getTurn(envelope.turnId);
    assert.equal(persisted.annotationSnapshot.publicMomentAuthority.version,
      'public-moment-authority-v1');

    const interaction = v3MomentEnvelope(9, 'MOMENT_INTERACTION');
    const interactionAccepted = orchestrator.accept(interaction);
    assert.equal(interactionAccepted.resultAuthorityVersion, 1);
    assert.equal(store.getTurn(interaction.turnId).annotationSnapshot
      .momentTargetAuthority.version, 'moment-target-authority-v1');
  }));

test('PROACTIVE_MOMENT structural silence commits a v4 zero result before executor/image work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-moment-skip-'));
  const path = join(directory, 'memory.sqlite');
  const store = new YuqiStore(path);
  let executions = 0;
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'PROACTIVE_MOMENT',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('PROACTIVE_MOMENT');
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }) },
      codex: {},
      promotionController: {
        selectPipelinePairForFreshSubject() {
          return {
            rollout,
            pair: {
              visibleReleaseId: rollout.stableReleaseId,
              comparisonReleaseId: null,
              comparisonDirection: null
            }
          };
        }
      },
      releaseExecutor: { executeTurn() { executions += 1; }, executeLife() {} },
      lifePlanningEnabled: false,
      clock: () => 20_000
    });
    const envelope = v3MomentEnvelope(40, 'PROACTIVE_MOMENT');
    const accepted = orchestrator.accept(envelope);
    const result = await orchestrator.runCanonicalReleaseTurn(store.getTurn(accepted.turnId));
    assert.equal(executions, 0);
    assert.equal(result.commitPayloadVersion, 'pc-visible-commit-v4');
    assert.deepEqual(
      store.getVisibleResultManifest(result.visibleGroupId).semantic.publicMomentEvidenceIds,
      []
    );
    const current = store.getTurn(accepted.turnId);
    const lineage = store.getTurnAuthorityLineage(current.authorityLineageKey);
    const lane = store.getInteractionLane(current.characterId, current.laneKey);
    const emptyGroup = { items: [] };
    const emptyFingerprint = generationFingerprint({
      roleId: current.characterId,
      laneKey: current.laneKey,
      inputVisibilitySequence: current.inputVisibilitySequence,
      visibleGroup: emptyGroup,
      actionSet: [],
      contextRevision: contentHash({
        agencySnapshotChecksum: current.agencySnapshotChecksum,
        momentTargetAuthorityChecksum: current.annotationSnapshot.publicMomentAuthority.checksum
      })
    });
    assert.throws(() => commitVisibleResult({
      store,
      turnId: current.turnId,
      authorityLineageKey: current.authorityLineageKey,
      laneKey: current.laneKey,
      expectedTurnRevision: current.turnRevision,
      expectedLineageRevision: lineage.revision,
      expectedLaneRevision: lane.revision,
      expectedCognitiveStateRevision: Number(store.getCognitiveState('yuqi')?.revision || 0),
      expectedLatestUserBatchId: current.inputUserBatchId,
      inputVisibilitySequence: current.inputVisibilitySequence,
      inputClearEpoch: current.inputClearEpoch,
      agencySnapshotChecksum: current.agencySnapshotChecksum,
      authoritativeReleaseId: current.authoritativeReleaseId,
      visibleGroup: emptyGroup,
      actionSet: [],
      statePatch: null,
      memoryJobs: [{ jobId: 'forbidden', jobType: 'turn_consolidation', payload: {} }],
      comparisonJob: null,
      generationFingerprint: emptyFingerprint,
      publicMomentEvidenceIds: [],
      now: 20_001
    }), /canonical moment skip must not carry memory jobs/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('public cognition input does not read private history, facts, payment, or relationship state', async () => {
  const calls = [];
  const store = {
    listMessages() {
      calls.push('messages');
      return [{
        messageId: 'msg_private_canary',
        speakerId: 'user',
        speakerType: 'user',
        recipientId: 'yuqi',
        content: 'PRIVATE_CANARY_7f2c',
        sentAt: 1
      }];
    },
    listFacts() {
      calls.push('facts');
      return [{
        type: 'pc_verified_fact',
        subjectId: 'yuqi',
        predicate: 'private',
        object: { secret: 'PRIVATE_FACT_CANARY' },
        status: 'verified',
        confidence: 1,
        sourceMessageIds: []
      }];
    },
    listActiveConstraints() {
      calls.push('constraints');
      return [{ constraintId: 'private_constraint', secret: 'PRIVATE_CONSTRAINT_CANARY' }];
    },
    listActiveStances() {
      calls.push('stances');
      return [{ stanceId: 'private_stance', secret: 'PRIVATE_STANCE_CANARY' }];
    }
  };
  const envelope = v3MomentEnvelope(6, 'MOMENT_INTERACTION');
  const result = await buildCognitionV3Input({
    store,
    envelope,
    currentBatch: { messageIds: [], messages: [] },
    scene: { relationshipStage: { base: 'PRIVATE_RELATIONSHIP_CANARY' } },
    lifeContext: { secret: 'PRIVATE_LIFE_CANARY' },
    localMemoryHints: []
  });
  assert.deepEqual(result.relevantHistory, []);
  assert.deepEqual(result.verifiedFacts, []);
  assert.deepEqual(result.relationship, null);
  assert.deepEqual(result.lifeSignals, []);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.deepEqual(calls, []);
});

test('all public moment-family v3 requests keep private agency/history surfaces empty', () => {
  const kinds = [
    'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION',
    'MOMENT_REPLY',
    'ROLE_PLAN_MOMENT',
    'ROLE_PLAN_MOMENT_PRIVATE'
  ];
  for (const [index, kind] of kinds.entries()) {
    const moment = targetMoment();
    const result = buildCognitionEnvelopeV3({
      envelope: {
        protocolVersion: 3,
        turnId: `turn_public_${index}`,
        characterId: 'yuqi',
        kind
      },
      relevantHistory: [{
        messageId: 'private_history_1',
        turnId: 'private_turn_1',
        speakerType: 'user',
        speakerId: 'user',
        recipientId: 'yuqi',
        sentAt: 1,
        content: 'PRIVATE_HISTORY_CANARY'
      }],
      verifiedFacts: [{
        factId: 'private_fact_1',
        subjectId: 'yuqi',
        predicate: 'secret',
        object: { secret: 'PRIVATE_FACT_CANARY' },
        status: 'verified',
        confidence: 1,
        sourceMessageIds: []
      }],
      constraints: [{
        constraintId: 'private_constraint',
        authority: 'user',
        authorityRank: 300,
        scope: { kinds: ['all'] },
        rule: 'PRIVATE_CONSTRAINT_CANARY',
        status: 'active',
        evidenceIds: ['private_history_1'],
        createdAt: 1,
        secret: 'PRIVATE_CONSTRAINT_SECRET'
      }],
      preferences: [{
        preferenceId: 'private_preference',
        topic: 'PRIVATE_PREF_TOPIC',
        value: 'PRIVATE_PREF_VALUE',
        weight: 1,
        scope: { kinds: ['all'] },
        secret: 'PRIVATE_PREF_SECRET'
      }],
      stances: [{
        stanceId: 'private_stance',
        topic: 'PRIVATE_STANCE_TOPIC',
        position: 'PRIVATE_STANCE_POSITION',
        strength: 1,
        status: 'active',
        scope: { kinds: ['all'] },
        lastConfirmedAt: 1,
        secret: 'PRIVATE_STANCE_SECRET'
      }],
      relationship: { base: { secret: 'PRIVATE_REL_CANARY' }, phase: { secret: 'PRIVATE_REL_CANARY' } },
      lifeSignals: [{ secret: 'PRIVATE_LIFE_CANARY' }],
      openThreads: [{ secret: 'PRIVATE_THREAD_CANARY' }],
      socialExperience: [{ secret: 'PRIVATE_SOCIAL_CANARY' }],
      authorSettings: { publicSetting: 'ok' },
      publicPrivacy: { allowPublic: true },
      committedLifeEvents: [{ evidenceId: 'public_event_1', state: 'committed', privacy: 'public' }],
      targetMoment: moment,
      targetComment: kind === 'MOMENT_REPLY' ? moment.comments[0] : null,
      thread: moment.comments,
      rolePlan: { rolePlanId: 'safe' },
      occurrence: { occurrenceId: 'safe' }
    });
    assert.deepEqual(result.relevantHistory, [], kind);
    assert.deepEqual(result.verifiedFacts, [], kind);
    assert.deepEqual(result.relationshipBasePhase.base, null, kind);
    assert.deepEqual(result.relationshipBasePhase.phase, null, kind);
    assert.deepEqual(result.lifeSignals, [], kind);
    assert.deepEqual(result.openThreads, [], kind);
    assert.equal(JSON.stringify(result).includes('PRIVATE_'), false, kind);
  }
});

test('direct public role-plan adapters do not accept caller occurrence or role-plan secrets', () => {
  const result = buildCognitionEnvelopeV3({
    envelope: {
      protocolVersion: 3,
      turnId: 'turn_role_plan_direct_canary',
      characterId: 'yuqi',
      kind: 'ROLE_PLAN_MOMENT_PRIVATE'
    },
    rolePlan: { rolePlanId: 'PRIVATE_ROLE_PLAN', secret: 'PRIVATE_ROLE_PLAN_CANARY' },
    occurrence: { occurrenceId: 'PRIVATE_OCCURRENCE', scene: 'PRIVATE_OCCURRENCE_CANARY' }
  });
  assert.equal(result.featureContext.rolePlan, null);
  assert.equal(result.featureContext.occurrence, null);
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('public moment feature context uses only turn-owned authority, never caller targets/events', () => {
  const persistedMoment = targetMoment();
  const callerMoment = { ...persistedMoment, momentId: 'caller_forged_moment' };
  const persistedCandidate = {
    evidenceId: 'public_event_persisted',
    sourceEpisodeId: 'episode_public_1',
    sourceChecksum: SHA,
    occurredAt: 900,
    expiresAt: 50_000,
    summary: 'persisted public event'
  };
  const callerCandidate = { ...persistedCandidate, evidenceId: 'caller_forged_event' };

  const proactive = buildCognitionEnvelopeV3({
    envelope: { protocolVersion: 3, turnId: 'turn_proactive_moment', characterId: 'yuqi', kind: 'PROACTIVE_MOMENT' },
    turn: { annotationSnapshot: {
      publicMomentAuthority: { candidates: [persistedCandidate] }
    } },
    committedLifeEvents: [callerCandidate],
    targetMoment: callerMoment,
    publicPrivacy: { allowPublic: true }
  });
  assert.deepEqual(proactive.featureContext.committedLifeEvents, [persistedCandidate]);
  assert.equal(JSON.stringify(proactive.featureContext).includes('caller_forged'), false);

  for (const kind of ['MOMENT_INTERACTION', 'MOMENT_REPLY']) {
    const targetAuthority = {
      targetMoment: persistedMoment,
      targetComment: kind === 'MOMENT_REPLY' ? persistedMoment.comments[0] : null
    };
    const result = buildCognitionEnvelopeV3({
      envelope: { protocolVersion: 3, turnId: `turn_${kind}`, characterId: 'yuqi', kind },
      turn: { annotationSnapshot: { momentTargetAuthority: targetAuthority } },
      targetMoment: callerMoment,
      targetComment: kind === 'MOMENT_REPLY' ? { ...persistedMoment.comments[0], commentId: 'caller_comment' } : null,
      thread: [{ ...persistedMoment.comments[0], commentId: 'caller_comment' }]
    });
    assert.deepEqual(result.featureContext.targetMoment, persistedMoment);
    assert.deepEqual(result.featureContext.targetComment, targetAuthority.targetComment);
    assert.deepEqual(result.featureContext.thread, persistedMoment.comments);
    assert.deepEqual(result.featureContext.publicPrivacy, {
      version: 'public-boundary-v1',
      visibility: 'public',
      recipientId: 'public_moments',
      allowPrivateChatContext: false,
      allowPaymentContext: false,
      allowRelationshipContext: false,
      allowPrivateMemoryContext: false
    });
    assert.equal(JSON.stringify(result.featureContext).includes('caller_'), false);
  }

  const missingAuthority = buildCognitionEnvelopeV3({
    envelope: { protocolVersion: 3, turnId: 'turn_missing_authority', characterId: 'yuqi', kind: 'PROACTIVE_MOMENT' },
    turn: { annotationSnapshot: {} },
    committedLifeEvents: [callerCandidate],
    proactiveMotiveAuthority: { candidates: [callerCandidate] }
  });
  assert.deepEqual(missingAuthority.featureContext.committedLifeEvents, []);
});

test('public role-plan v3 input strips private trigger context instead of forwarding envelope', async () => {
  const envelope = v3MomentEnvelope(120, 'ROLE_PLAN_MOMENT', {
    input: { privateDecision: 'PRIVATE_ROLE_DECISION_CANARY' },
    snapshot: { secret: 'PRIVATE_ROLE_SNAPSHOT_CANARY' },
    scene: { relationshipStage: { secret: 'PRIVATE_ROLE_SCENE_CANARY' } },
    cloudJobId: 'private-job-canary'
  });
  const result = await buildCognitionV3Input({
    store: {
      listMessages() { throw new Error('private reader must not be called'); },
      listFacts() { throw new Error('private reader must not be called'); },
      listActiveConstraints() { throw new Error('private reader must not be called'); },
      listActiveStances() { throw new Error('private reader must not be called'); }
    },
    envelope,
    turn: { protocolVersion: 3, rolloutKey: 'ROLE_PLAN_MOMENT', annotationSnapshot: {} },
    currentBatch: { messageIds: [], messages: [] },
    scene: { relationshipStage: { secret: 'PRIVATE_SCENE_CANARY' } },
    lifeContext: { secret: 'PRIVATE_LIFE_CANARY' },
    localMemoryHints: []
  });
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
  assert.deepEqual(result.envelope.trigger.context, {});
});
