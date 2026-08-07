import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { normalizeCanonicalBrainDraft, YuqiOrchestrator } from '../src/orchestrator.mjs';
import { contentHash, validateEnvelope } from '../src/protocol.mjs';
import { canonicalCommitPayload, commitVisibleResult } from '../src/visible-result-commit.mjs';
import {
  YuqiStore,
  deriveAuthorityLineageKey,
  deriveVisibleActionId,
  deriveVisibleGroupId,
  deriveVisibleMessageId
} from '../src/store.mjs';

const SHA = 'a'.repeat(64);

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-authority-snapshot-'));
  const store = new YuqiStore(join(directory, 'memory.sqlite'));
  try {
    return run(store);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function putEvidenceMessage(store, messageId) {
  return store.putMessage({
    messageId,
    turnId: `turn_${messageId}`,
    characterId: 'yuqi',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `evidence ${messageId}`,
    sentAt: 1,
    origin: 'phone'
  });
}

test('al-authority-v1 identity vectors are stable across UTF-8 and ordinal boundaries', () => {
  const fixture = JSON.parse(readFileSync(
    join(process.cwd(), 'tests', 'fixtures', 'authority-identity-v1.json'),
    'utf8'
  ));
  assert.equal(fixture.algorithm, 'al-authority-v1');
  for (const vector of fixture.vectors) {
    const lineageKey = deriveAuthorityLineageKey(vector);
    const groupId = deriveVisibleGroupId(lineageKey);
    assert.equal(lineageKey, vector.lineageKey, vector.name);
    assert.equal(groupId, vector.groupId, vector.name);
    assert.equal(deriveVisibleMessageId(groupId, vector.ordinal), vector.messageId, vector.name);
    assert.equal(deriveVisibleActionId(groupId, vector.ordinal), vector.actionId, vector.name);
  }
});

test('agency authority snapshot includes verified referenced preferences and is order stable', () =>
  withStore(store => {
    putEvidenceMessage(store, 'u1');
    putEvidenceMessage(store, 'u2');
    for (const fact of [
      {
        factId: 'pref_b',
        characterId: 'yuqi',
        subjectId: 'user',
        predicate: 'drink',
        object: 'oolong',
        type: 'stable_preference',
        status: 'verified',
        confidence: 0.8,
        sourceMessageIds: ['u2']
      },
      {
        factId: 'pref_a',
        characterId: 'yuqi',
        subjectId: 'user',
        predicate: 'food',
        object: 'rice_noodles',
        type: 'stable_preference',
        status: 'verified',
        confidence: 0.9,
        sourceMessageIds: ['u1']
      }
    ]) store.putFact(fact);
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 1,
      lastTurnId: 'seed',
      state: {
        slowState: { preferenceFactIds: ['pref_b', 'pref_a'] },
        mediumState: {},
        fastState: {}
      },
      updatedAt: 1
    });
    const first = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 10 });
    const second = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 10 });
    assert.deepEqual(first.preferenceFacts.map(item => item.factId), ['pref_a', 'pref_b']);
    assert.equal(first.checksum, second.checksum);
    assert.equal(first.cognitiveState.revision, 1);
  }));

test('agency authority snapshot rejects an invalid referenced preference fact', () =>
  withStore(store => {
    putEvidenceMessage(store, 'u1');
    store.putFact({
      factId: 'pref_bad',
      characterId: 'yuqi',
      subjectId: 'user',
      predicate: 'food',
      object: 'rice_noodles',
      type: 'temporary_observation',
      status: 'verified',
      confidence: 0.9,
      sourceMessageIds: ['u1']
    });
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 1,
      lastTurnId: 'seed',
      state: {
        slowState: { preferenceFactIds: ['pref_bad'] },
        mediumState: {},
        fastState: {}
      },
      updatedAt: 1
    });
    assert.throws(
      () => store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 10 }),
      /preference fact is invalid/i
    );
  }));

test('agency authority snapshot rejects missing or suppressed preference evidence', () =>
  withStore(store => {
    for (const [factId, sourceMessageIds] of [
      ['pref_missing_evidence', ['missing_message']],
      ['pref_suppressed_evidence', ['suppressed_message']]
    ]) {
      if (sourceMessageIds[0] === 'suppressed_message') {
        putEvidenceMessage(store, 'suppressed_message');
        store.db.prepare(`
          INSERT INTO suppressed_messages(
            message_id,
            authoritative_message_id,
            reason,
            created_at
          ) VALUES (?, ?, 'test', 1)
        `).run('suppressed_message', 'suppressed_message');
      }
      store.putFact({
        factId,
        characterId: 'yuqi',
        subjectId: 'user',
        predicate: 'food',
        object: 'rice_noodles',
        type: 'stable_preference',
        status: 'verified',
        confidence: 0.9,
        sourceMessageIds
      });
      store.putCognitiveStateInternal({
        roleId: 'yuqi',
        schemaVersion: 2,
        revision: factId === 'pref_missing_evidence' ? 1 : 2,
        lastTurnId: factId,
        state: {
          slowState: { preferenceFactIds: [factId] },
          mediumState: {},
          fastState: {}
        },
        updatedAt: 1
      });
      assert.throws(
        () => store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 10 }),
        /preference fact is invalid/i
      );
    }
  }));

test('canonical creation recomputes agency authority and rejects a forged checksum without writes', () =>
  withStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const before = Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value);
    assert.throws(() => store.createCanonicalVisibleTurnInternal({
      envelope: envelope('turn_forged_agency'),
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: 'batch_msg_user_authority',
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: 'f'.repeat(64),
      annotationSnapshot: {}
    }), /agency snapshot authority conflict/i);
    assert.equal(
      Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value),
      before
    );
  }));

test('canonical commit checksum excludes top-level and nested attempt metadata', () => {
  const base = {
    authorityLineageKey: 'lin_semantic',
    turnId: 'turn_attempt_1',
    laneKey: 'private_chat',
    expectedLatestUserBatchId: 'batch_1',
    inputVisibilitySequence: 4,
    agencySnapshotChecksum: SHA,
    expectedCognitiveStateRevision: 2,
    authoritativeReleaseId: 'release_a',
    comparisonReleaseId: null,
    comparisonDirection: null,
    generationFingerprint: SHA,
    visibleGroup: {
      items: [{
        content: '一样的回复',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'user'
      }]
    },
    actionSet: [],
    statePatch: { mood: 'warm', currentStances: [], openThreads: [] },
    memoryJobs: [{
      jobId: 'job_attempt_1',
      jobType: 'turn_consolidation',
      dueAt: 100,
      workerId: 'worker_a',
      payload: {
        turnId: 'turn_attempt_1',
        createdAt: 100,
        cognitionPacketChecksum: 'b'.repeat(64),
        resultingCognitiveStateChecksum: 'c'.repeat(64)
      }
    }],
    comparisonJob: null
  };
  const retry = structuredClone(base);
  retry.turnId = 'turn_attempt_2';
  retry.memoryJobs[0].jobId = 'job_attempt_2';
  retry.memoryJobs[0].dueAt = 999;
  retry.memoryJobs[0].workerId = 'worker_b';
  retry.memoryJobs[0].payload.turnId = 'turn_attempt_2';
  retry.memoryJobs[0].payload.createdAt = 999;
  assert.equal(
    contentHash(canonicalCommitPayload(base)),
    contentHash(canonicalCommitPayload(retry))
  );
  retry.memoryJobs[0].payload.cognitionPacketChecksum = 'd'.repeat(64);
  assert.notEqual(
    contentHash(canonicalCommitPayload(base)),
    contentHash(canonicalCommitPayload(retry))
  );
});

test('PROACTIVE_CHAT wire-v3 commit payload preserves only pinned motive evidence', () => {
  const base = {
    authorityLineageKey: 'lin_proactive_v3',
    turnId: 'turn_proactive_v3',
    laneKey: 'private_chat',
    expectedLatestUserBatchId: null,
    inputVisibilitySequence: 4,
    inputClearEpoch: 0,
    agencySnapshotChecksum: SHA,
    expectedCognitiveStateRevision: 2,
    authoritativeReleaseId: 'release_a',
    comparisonReleaseId: null,
    comparisonDirection: null,
    generationFingerprint: SHA,
    visibleGroup: { items: [] },
    actionSet: [],
    statePatch: null,
    memoryJobs: [],
    comparisonJob: null,
    protocolVersion: 3,
    turnKind: 'PROACTIVE_CHAT',
    proactiveMotiveEvidenceIds: [],
    proactiveMotiveAuthorityChecksum: SHA
  };
  const payload = canonicalCommitPayload(base);
  assert.equal(payload.payloadVersion, 'pc-visible-commit-v3');
  assert.deepEqual(payload.proactiveMotiveEvidenceIds, []);
  assert.equal(Object.hasOwn(payload, 'proactiveMotiveAuthorityChecksum'), false);
  assert.equal('reply' in payload, false);
});

test('fresh wire-v3 moment kinds use the closed v4 payload fields', () => {
  const base = {
    authorityLineageKey: 'lin_public_moment_v4',
    laneKey: 'public_moment',
    expectedLatestUserBatchId: null,
    inputVisibilitySequence: 1,
    inputClearEpoch: 0,
    agencySnapshotChecksum: SHA,
    expectedCognitiveStateRevision: 0,
    authoritativeReleaseId: 'release_moment',
    comparisonReleaseId: null,
    comparisonDirection: null,
    generationFingerprint: SHA,
    visibleGroup: { items: [] },
    actionSet: [],
    statePatch: null,
    memoryJobs: [],
    comparisonJob: null,
    protocolVersion: 3
  };
  const proactive = canonicalCommitPayload({
    ...base,
    turnKind: 'PROACTIVE_MOMENT',
    publicMomentEvidenceIds: []
  });
  assert.equal(proactive.payloadVersion, 'pc-visible-commit-v4');
  assert.deepEqual(proactive.publicMomentEvidenceIds, []);
  assert.equal(Object.hasOwn(proactive, 'momentTargetAuthorityChecksum'), false);

  const interaction = canonicalCommitPayload({
    ...base,
    turnKind: 'MOMENT_INTERACTION',
    momentTargetAuthorityChecksum: SHA
  });
  assert.equal(interaction.payloadVersion, 'pc-visible-commit-v4');
  assert.equal(interaction.momentTargetAuthorityChecksum, SHA);
  assert.equal(Object.hasOwn(interaction, 'publicMomentEvidenceIds'), false);

  const historicalWire2 = canonicalCommitPayload({
    ...base,
    protocolVersion: 2,
    turnKind: 'MOMENT_INTERACTION',
    momentTargetAuthorityChecksum: SHA
  });
  assert.equal(historicalWire2.payloadVersion, 'pc-visible-commit-v2');
  assert.equal(Object.hasOwn(historicalWire2, 'momentTargetAuthorityChecksum'), false);
});

test('canonical memory and compare descriptors default-deny unknown semantic fields', () => {
  const base = {
    authorityLineageKey: 'lin_job_allowlist',
    turnId: 'turn_job_allowlist',
    laneKey: 'private_chat',
    expectedLatestUserBatchId: 'batch_1',
    inputVisibilitySequence: 4,
    agencySnapshotChecksum: SHA,
    expectedCognitiveStateRevision: 2,
    authoritativeReleaseId: 'release_a',
    comparisonReleaseId: null,
    comparisonDirection: null,
    generationFingerprint: SHA,
    visibleGroup: { items: [] },
    actionSet: [],
    statePatch: null,
    memoryJobs: [{
      jobType: 'turn_consolidation',
      payload: {
        cognitionPacketChecksum: 'b'.repeat(64),
        resultingCognitiveStateChecksum: 'c'.repeat(64),
        unregisteredSemanticInput: 'must-not-be-silently-ignored'
      }
    }],
    comparisonJob: null
  };
  assert.throws(
    () => canonicalCommitPayload(base),
    /memory job payload contains unsupported fields/i
  );
  const invalidChecksum = structuredClone(base);
  delete invalidChecksum.memoryJobs[0].payload.unregisteredSemanticInput;
  invalidChecksum.memoryJobs[0].payload.cognitionPacketChecksum = '';
  assert.throws(
    () => canonicalCommitPayload(invalidChecksum),
    /memory job cognitionPacketChecksum must be a sha-256 checksum/i
  );
  const comparison = structuredClone(base);
  comparison.memoryJobs = [];
  comparison.comparisonJob = {
    jobType: 'shadow_cognition',
    payload: {
      comparisonReleaseId: 'release_b',
      comparisonDirection: 'stable_visible_candidate_compare',
      rolloutEvidenceEpoch: 1,
      shadowEpoch: 1,
      canaryEpoch: null,
      canarySlot: null,
      annotationSnapshotChecksum: 'd'.repeat(64),
      inputChecksum: 'e'.repeat(64),
      unregisteredSemanticInput: 'must-not-be-silently-ignored'
    }
  };
  assert.throws(
    () => canonicalCommitPayload(comparison),
    /comparison job payload contains unsupported fields/i
  );
});

function envelope(turnId = 'turn_authority') {
  return {
    protocolVersion: 2,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: 'msg_user_authority',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '你在做什么',
      sentAt: 1000
    }
  };
}

function withAuthority(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-visible-commit-'));
  const path = join(directory, 'memory.sqlite');
  const store = new YuqiStore(path);
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 1,
      lastTurnId: 'turn_state_seed',
      state: {
        slowState: { identity: 'yuqi' },
        mediumState: { activeScene: 'chat' },
        fastState: {
          mood: 'neutral',
          body: 'resting',
          attention: 'user',
          openThreadIds: []
        }
      },
      updatedAt: 999
    });
    const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({
      roleId: 'yuqi',
      at: 1_000
    });
    const creationInput = {
      envelope: envelope(),
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: 'batch_msg_user_authority',
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: agencySnapshot.checksum,
      annotationSnapshot: {}
    };
    const creation = store.createCanonicalVisibleTurnInternal(creationInput);
    return run(store, creation.turn, creationInput);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function momentEnvelope(turnId = 'turn_moment_authority') {
  const triggerId = `trigger_${turnId.slice('turn_'.length)}`;
  const laneKey = 'moment_interaction:moment_real';
  return {
    protocolVersion: 3,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1000,
    kind: 'MOMENT_INTERACTION',
    trigger: {
      triggerId,
      triggerType: 'moment_interaction',
      scheduledFor: 999,
      executedAt: 1000,
      context: {
        targetMoment: {
          momentId: 'moment_real',
          authorType: 'character',
          authorId: 'yuqi',
          text: '公开动态',
          createdAt: 900,
          likes: [],
          comments: []
        },
        targetComment: null
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
        localSequence: 1,
        clearedThroughSequence: 0,
        clearEpoch: 0,
        clearedAt: 0,
        chatOpen: false,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey, rootSourceId: triggerId }),
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  };
}

function withMomentAuthority(run) {
  return withStore(store => {
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
    const envelope = validateEnvelope(momentEnvelope());
    const rollout = store.getCognitionRollout('MOMENT_INTERACTION');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1000 });
    const targetAuthority = {
      version: 'moment-target-authority-v1',
      targetMoment: envelope.trigger.context.targetMoment,
      targetComment: envelope.trigger.context.targetComment
    };
    targetAuthority.checksum = contentHash(targetAuthority);
    const created = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'MOMENT_INTERACTION',
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
      annotationSnapshot: { momentTargetAuthority: targetAuthority }
    });
    return run(store, created.turn);
  });
}

function commitInput(store, turn) {
  const visibleGroup = {
    items: [
      { content: '刚在整理东西。', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' },
      { content: '你呢？', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }
    ]
  };
  const actionSet = [{
    kind: 'moment_create',
    targetKey: `lineage_create:${turn.authorityLineageKey}:moment_create`,
    targetRevision: '1',
    payload: { privacy: 'private', content: '雨后的灯。' }
  }];
  const momentTargetAuthorityChecksum = turn.annotationSnapshot?.momentTargetAuthority?.checksum || null;
  const fingerprint = generationFingerprint({
    roleId: turn.characterId,
    laneKey: turn.laneKey,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    visibleGroup,
    actionSet,
    contextRevision: momentTargetAuthorityChecksum
      ? contentHash({
          agencySnapshotChecksum: turn.agencySnapshotChecksum,
          momentTargetAuthorityChecksum
        })
      : turn.agencySnapshotChecksum
  });
  return {
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
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet,
    ...(momentTargetAuthorityChecksum ? { momentTargetAuthorityChecksum } : {}),
    statePatch: {
      mood: 'engaged',
      openThreads: [],
      currentStances: [{
        operation: 'create',
        stanceId: 'stance_authority',
        topic: 'conversation',
        position: '想继续聊',
        reason: '当前互动',
        strength: 0.7,
        flexibility: 0.8,
        evidenceMessageIds: ['msg_user_authority'],
        expiresAt: 3000,
        remainingRelevantUserBatches: 3
      }]
    },
    memoryJobs: [{
      jobId: 'job_authority',
      jobType: 'turn_consolidation',
      payload: {
        turnId: turn.turnId,
        cognitionPacketChecksum: 'b'.repeat(64),
        resultingCognitiveStateChecksum: 'c'.repeat(64)
      }
    }],
    comparisonJob: null,
    generationFingerprint: fingerprint,
    now: 2000
  };
}

function sideEffectCounts(store) {
  return Object.fromEntries([
    'visible_result_groups',
    'visible_result_items',
    'visible_result_actions',
    'visible_result_manifests',
    'visible_commit_receipts',
    'messages',
    'stance_records',
    'consolidation_jobs',
    'cloud_deliveries'
  ].map(table => [
    table,
    Number(store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value)
  ]));
}

function canonicalCreationCounts(store) {
  return Object.fromEntries([
    'turns',
    'turn_authority_lineages',
    'current_user_batches',
    'current_user_batch_items',
    'messages',
    'interaction_lanes'
  ].map(table => [
    table,
    Number(store.db.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get().value)
  ]));
}

test('canonical group projections action state memory outbox and receipt commit together', () =>
  withAuthority((store, turn) => {
    const result = commitVisibleResult(commitInput(store, turn));
    assert.equal(result.committed, true);
    assert.equal(store.visibleGroupsForLineage(turn.authorityLineageKey).length, 1);
    assert.equal(store.visibleItemsForGroup(result.visibleGroupId).length, 2);
    assert.equal(store.actionsForGroup(result.visibleGroupId).length, 1);
    assert.equal(store.getCognitiveState('yuqi').lastAuthorityGroupId, result.visibleGroupId);
    assert.equal(store.memoryJobsForGroup(result.visibleGroupId).length, 1);
    assert.equal(store.comparisonJobsForGroup(result.visibleGroupId).length, 0);
    assert.equal(
      store.db.prepare(
        'SELECT authority_group_id FROM stance_records WHERE stance_id = ?'
      ).get('stance_authority').authority_group_id,
      result.visibleGroupId
    );
    assert.equal(store.outboxForGroup(result.visibleGroupId).length, 1);
    assert.equal(store.getVisibleCommitReceipt(turn.authorityLineageKey).commitChecksum,
      result.commitChecksum);
    assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 2);
    const state = store.getCognitiveState('yuqi').state;
    assert.deepEqual(state.slowState, { identity: 'yuqi' });
    assert.deepEqual(state.mediumState, { activeScene: 'chat' });
    assert.equal(state.fastState.body, 'resting');
    assert.equal(state.fastState.attention, 'user');
    assert.equal(state.fastState.mood, 'engaged');
  }));

test('an agency head change invalidates an open result but not an exact committed receipt replay', () =>
  withAuthority((store, turn) => {
    const input = commitInput(store, turn);
    store.putConstraintRevisionInternal({
      constraintId: 'constraint_new',
      revision: 1,
      roleId: 'yuqi',
      authority: 'system',
      kind: 'privacy',
      subject: 'both',
      scope: { channel: 'private_chat', target: 'all' },
      rule: 'keep_private',
      sourceMessageIds: [],
      status: 'active',
      createdAt: 1_000,
      updatedAt: 1_000
    });
    assert.throws(() => commitVisibleResult(input), /AGENCY_AUTHORITY_STALE/);
    store.db.prepare('DELETE FROM constraint_records WHERE constraint_id = ?').run('constraint_new');
    const first = commitVisibleResult(input);
    store.putConstraintRevisionInternal({
      constraintId: 'constraint_after_commit',
      revision: 1,
      roleId: 'yuqi',
      authority: 'system',
      kind: 'privacy',
      subject: 'both',
      scope: { channel: 'private_chat', target: 'all' },
      rule: 'keep_private',
      sourceMessageIds: [],
      status: 'active',
      createdAt: 1_000,
      updatedAt: 1_000
    });
    assert.equal(commitVisibleResult(input).commitChecksum, first.commitChecksum);
  }));

for (const [name, mutate] of [
  ['hard constraints', patch => { patch.hardConstraints = []; }],
  ['preference evidence', patch => { patch.preferenceEvidence = []; }],
  ['foreign role', patch => { patch.roleId = 'other'; }],
  ['slow state', patch => { patch.slowState = {}; }],
  ['medium state', patch => { patch.mediumState = {}; }],
  ['extra top-level key', patch => { patch.extra = true; }],
  ['stale stance evidence', patch => {
    patch.currentStances[0].evidenceMessageIds = ['missing_message'];
  }],
  ['unsupported stance transition', patch => {
    patch.currentStances[0].operation = 'delete';
  }]
]) {
  test(`state patch rejects ${name} without side effects`, () =>
    withAuthority((store, turn) => {
      const input = commitInput(store, turn);
      const before = sideEffectCounts(store);
      mutate(input.statePatch);
      assert.throws(() => commitVisibleResult(input));
      assert.deepEqual(sideEffectCounts(store), before);
    }));
}

test('unknown action kinds and injected stable comparison jobs are rejected', () =>
  withAuthority((store, turn) => {
    const unknown = commitInput(store, turn);
    unknown.actionSet[0].kind = 'arbitrary_action';
    unknown.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: unknown.visibleGroup,
      actionSet: unknown.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    assert.throws(() => commitVisibleResult(unknown), /unknown canonical action/i);
    const injected = commitInput(store, turn);
    injected.comparisonJob = {
      jobId: 'compare_injected',
      jobType: 'shadow_cognition',
      payload: {}
    };
    assert.throws(() => commitVisibleResult(injected), /comparison authority conflict/i);
  }));

test('interleaved role-plan action ordinals are rejected before any visible write', () =>
  withAuthority((store, turn) => {
    const input = commitInput(store, turn);
    input.actionSet = [
      {
        kind: 'role_plan_create',
        targetKey: `lineage_create:${turn.authorityLineageKey}:role_plan_create`,
        targetRevision: '1',
        payload: { op: 'create', planId: 'plan_new' }
      },
      {
        kind: 'moment_create',
        targetKey: `lineage_create:${turn.authorityLineageKey}:moment_create`,
        targetRevision: '1',
        payload: { privacy: 'private', content: '中间动作' }
      },
      {
        kind: 'role_plan_update',
        targetKey: 'role_plan:plan_existing',
        targetRevision: '1',
        payload: { op: 'update', planId: 'plan_existing' }
      }
    ];
    input.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    const before = sideEffectCounts(store);
    assert.throws(
      () => commitVisibleResult(input),
      /role plan actions must form one contiguous ordinal block/i
    );
    assert.deepEqual(sideEffectCounts(store), before);
  }));

test('one contiguous role-plan action block commits with consecutive ordinals', () =>
  withAuthority((store, turn) => {
    store.db.exec(`
      CREATE TABLE role_plans(
        plan_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      INSERT INTO role_plans(plan_id, character_id, revision)
      VALUES ('plan_existing', 'yuqi', 3);
    `);
    const actionInputs = [
      { kind: 'role_plan_create', payload: { op: 'create', planId: 'plan_new' } },
      { kind: 'role_plan_update', payload: { op: 'update', planId: 'plan_existing' } },
      { kind: 'moment_create', payload: { privacy: 'private', content: '动作块之后' } }
    ];
    const input = commitInput(store, turn);
    input.actionSet = actionInputs.map(action => {
      const target = store.resolveCanonicalActionTargetInternal({ turn, action });
      return {
        ...action,
        targetKey: target.targetKey,
        targetRevision: target.targetRevision
      };
    });
    input.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    const receipt = commitVisibleResult(input);
    assert.deepEqual(
      store.actionsForGroup(receipt.visibleGroupId)
        .filter(action => action.kind.startsWith('role_plan_'))
        .map(action => action.ordinal),
      [0, 1]
    );
  }));

test('input snapshot target id and revision must come from the same object', () =>
  withAuthority((store, turn) => {
    const paymentEnvelope = JSON.parse(turn.envelopeJson);
    paymentEnvelope.context = {
      payment: { messageId: 'pay_real', amount: 20, currency: 'CNY' }
    };
    const paymentTurn = { ...turn, envelopeJson: JSON.stringify(paymentEnvelope) };
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: paymentTurn,
      action: {
        kind: 'payment_accept',
        payload: { messageId: 'pay_forged' }
      }
    }), /target identity conflict/i);

    const momentEnvelope = JSON.parse(turn.envelopeJson);
    momentEnvelope.trigger = {
      context: {
        input: { targetMoment: { momentId: 'moment_real', revision: 3 } }
      }
    };
    const momentTurn = { ...turn, envelopeJson: JSON.stringify(momentEnvelope) };
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: momentTurn,
      action: {
        kind: 'moment_like',
        payload: {
          momentId: 'moment_forged', like: true, comment: '', replyToCommentId: null
        }
      }
    }), /target identity conflict/i);
  }));

test('one target-ref resolver covers message conversation comment and role occurrence', () =>
  withAuthority((store, turn) => {
    const sourceEnvelope = JSON.parse(turn.envelopeJson);
    const message = store.resolveCanonicalTargetRefInternal({
      turn,
      namespace: 'message',
      targetId: sourceEnvelope.message.messageId
    });
    assert.equal(message.targetKey, `message:${sourceEnvelope.message.messageId}`);
    const conversation = store.resolveCanonicalTargetRefInternal({
      turn,
      namespace: 'conversation',
      targetId: `${turn.characterId}:${turn.deviceId}`
    });
    assert.equal(conversation.targetKey, `conversation:${turn.characterId}:${turn.deviceId}`);

    const contextualEnvelope = structuredClone(sourceEnvelope);
    contextualEnvelope.context = {
      roleOccurrence: {
        occurrenceId: 'occurrence_real',
        characterId: 'yuqi',
        revision: 2
      }
    };
    contextualEnvelope.trigger = {
      context: {
        input: { targetComment: { commentId: 'comment_real', content: 'hi' } }
      }
    };
    const contextualTurn = { ...turn, envelopeJson: JSON.stringify(contextualEnvelope) };
    assert.equal(store.resolveCanonicalTargetRefInternal({
      turn: contextualTurn,
      namespace: 'comment',
      targetId: 'comment_real'
    }).targetKey, 'comment:comment_real');
    assert.equal(store.resolveCanonicalTargetRefInternal({
      turn: contextualTurn,
      namespace: 'role_occurrence',
      targetId: 'occurrence_real'
    }).targetKey, 'role_occurrence:occurrence_real');
    assert.throws(() => store.resolveCanonicalTargetRefInternal({
      turn: contextualTurn,
      namespace: 'role_occurrence',
      targetId: 'occurrence_forged'
    }), /target identity conflict|target not found/i);

    store.db.exec(`
      CREATE TABLE role_plans(
        plan_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        revision INTEGER NOT NULL
      );
      INSERT INTO role_plans(plan_id, character_id, revision)
      VALUES ('plan_foreign', 'other_role', 1);
    `);
    assert.throws(() => store.resolveCanonicalTargetRefInternal({
      turn: contextualTurn,
      namespace: 'role_plan',
      targetId: 'plan_foreign'
    }), /role authority conflict/i);
  }));

test('canonical visible items cannot spoof speaker recipient or blank content', () =>
  withAuthority((store, turn) => {
    for (const mutate of [
      item => { item.speakerId = 'user'; },
      item => { item.speakerType = 'user'; },
      item => { item.recipientId = 'other_peer'; },
      item => { item.content = '   '; }
    ]) {
      const input = commitInput(store, turn);
      mutate(input.visibleGroup.items[0]);
      input.generationFingerprint = generationFingerprint({
        roleId: turn.characterId,
        laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup: input.visibleGroup,
        actionSet: input.actionSet,
        contextRevision: turn.agencySnapshotChecksum
      });
      const before = sideEffectCounts(store);
      assert.throws(() => commitVisibleResult(input), /visible item (identity|content)/i);
      assert.deepEqual(sideEffectCounts(store), before);
    }
  }));

test('caller projection identity cannot override deterministic group identities', () =>
  withAuthority((store, turn) => {
    const input = commitInput(store, turn);
    input.visibleGroup.items[0].messageId = 'forged_message';
    input.visibleGroup.items[0].ordinal = 99;
    input.actionSet[0].actionId = 'forged_action';
    input.actionSet[0].ordinal = 99;
    const receipt = commitVisibleResult(input);
    const item = store.visibleItemsForGroup(receipt.visibleGroupId)[0];
    const action = store.actionsForGroup(receipt.visibleGroupId)[0];
    assert.equal(item.messageId, deriveVisibleMessageId(receipt.visibleGroupId, 0));
    assert.equal(item.ordinal, 0);
    assert.equal(action.actionId, deriveVisibleActionId(receipt.visibleGroupId, 0));
    assert.equal(action.ordinal, 0);
  }));

test('state commit inserts revision one when cognitive state is absent', () =>
  withStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const source = envelope('turn_state_insert');
    const snapshot = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: source,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: `batch_${source.message.messageId}`,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: snapshot.checksum,
      annotationSnapshot: {}
    }).turn;
    const visibleGroup = {
      items: [{
        content: '在呢。',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'user'
      }]
    };
    const generation = generationFingerprint({
      roleId: 'yuqi',
      laneKey: 'private_chat',
      inputVisibilitySequence: 0,
      visibleGroup,
      actionSet: [],
      contextRevision: snapshot.checksum
    });
    commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      expectedCognitiveStateRevision: 0,
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: snapshot.checksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      visibleGroup,
      actionSet: [],
      statePatch: { mood: 'awake', currentStances: [], openThreads: ['chat'] },
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generation,
      now: 2_000
    });
    const state = store.getCognitiveState('yuqi');
    assert.equal(state.revision, 1);
    assert.equal(state.state.fastState.mood, 'awake');
    assert.deepEqual(state.state.fastState.openThreadIds, ['chat']);
  }));

test('canonical action target registry resolves every supported authority namespace', () =>
  withStore(store => {
    store.putLifePlanInternal('yuqi', [{
      episodeId: 'life_1',
      kind: 'work',
      title: '整理画稿',
      startAt: 2_000,
      endAt: 3_000,
      payload: {}
    }]);
    const turn = {
      turnId: 'turn_registry',
      characterId: 'yuqi',
      authorityLineageKey: 'lin_registry',
      envelopeJson: JSON.stringify({
        context: {
          pendingPayment: { messageId: 'pay_1', amountMinor: 2000, currency: 'CNY' },
          rolePlan: { rolePlanId: 'plan_1', revision: 2 },
          scene: {
            relationshipStage: { phase: 'familiar' },
            stagePersonaRevision: 4
          }
        },
        trigger: {
          context: {
            input: {
              targetMoment: { momentId: 'moment_1', revision: 3 },
              targetComment: { commentId: 'comment_1', revision: 2 }
            }
          }
        }
      })
    };
    store.db.prepare(`
      INSERT INTO turn_authority_lineages(
        lineage_key,
        role_id,
        lane_key,
        root_source_id,
        latest_turn_id,
        revision,
        state,
        committed_group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'open', NULL, 1, 1)
    `).run(
      turn.authorityLineageKey,
      turn.characterId,
      'direct:device_1',
      'registry_source',
      turn.turnId
    );
    const cases = [
      ['payment_accept', { messageId: 'pay_1' }, 'payment:pay_1'],
      ['payment_decline', { messageId: 'pay_1' }, 'payment:pay_1'],
      ['moment_create', {}, 'lineage_create:lin_registry:moment_create'],
      ['moment_like', {
        momentId: 'moment_1', like: true, comment: '', replyToCommentId: null
      }, 'moment:moment_1'],
      ['moment_comment', {
        momentId: 'moment_1', like: true, comment: '同感。', replyToCommentId: null
      }, 'moment:moment_1'],
      ['moment_reply', {
        momentId: 'moment_1', like: false, comment: '是呀。', replyToCommentId: 'comment_1'
      }, 'comment:comment_1'],
      ['role_plan_create', {}, 'lineage_create:lin_registry:role_plan_create'],
      ['role_plan_update', { op: 'update', planId: 'plan_1' }, 'role_plan:plan_1'],
      ['role_plan_cancel', { op: 'cancel', planId: 'plan_1' }, 'role_plan:plan_1'],
      ['role_plan_pause', { op: 'pause', planId: 'plan_1' }, 'role_plan:plan_1'],
      ['role_plan_resume', { op: 'resume', planId: 'plan_1' }, 'role_plan:plan_1'],
      ['role_plan_complete', { op: 'complete', planId: 'plan_1' }, 'role_plan:plan_1'],
      ['life_episode_create', {}, 'lineage_create:lin_registry:life_episode_create'],
      ['life_episode_update', { type: 'reschedule', targetEpisodeId: 'life_1' }, 'life_episode:life_1'],
      ['life_episode_cancel', { type: 'cancel', targetEpisodeId: 'life_1' }, 'life_episode:life_1'],
      ['relationship_transition', {
        baseAction: {
          from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历充分',
          confidence: 0.9, evidenceMessageIds: ['msg_1', 'msg_2'],
          explicitMutualChange: false, changedAt: 2000
        },
        phaseAction: null,
        expectedSceneRevision: 4,
        label: '熟悉',
        changedAt: 2000
      }, 'relationship:yuqi']
    ];
    for (const [kind, payload, targetKey] of cases) {
      const resolved = store.resolveCanonicalActionTargetInternal({
        turn,
        action: { kind, payload }
      });
      assert.equal(resolved.targetKey, targetKey, kind);
      assert.ok(resolved.targetRevision, kind);
    }
  }));

test('canonical wire target names are exact while domain target sources stay native', () =>
  withStore(store => {
    store.putLifePlanInternal('yuqi', [{
      episodeId: 'life_1',
      kind: 'work',
      title: '整理画稿',
      startAt: 2_000,
      endAt: 3_000,
      payload: {}
    }]);
    const turn = {
      turnId: 'turn_exact_wire_target',
      characterId: 'yuqi',
      authorityLineageKey: 'lin_exact_wire_target',
      envelopeJson: JSON.stringify({
        context: { rolePlan: { rolePlanId: 'plan_1', revision: 2 } },
        trigger: {
          context: {
            input: {
              targetComment: { commentId: 'comment_1', revision: 2 },
              commentId: 'comment_legacy_scalar'
            },
            planId: 'plan_nested_only'
          }
        }
      })
    };
    store.db.prepare(`
      INSERT INTO turn_authority_lineages(
        lineage_key,
        role_id,
        lane_key,
        root_source_id,
        latest_turn_id,
        revision,
        state,
        committed_group_id,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, 'open', NULL, 1, 1)
    `).run(
      turn.authorityLineageKey,
      turn.characterId,
      'private_chat',
      'exact_wire_source',
      turn.turnId
    );

    const cases = [
      {
        kind: 'moment_reply',
        canonicalKey: 'replyToCommentId',
        legacyKey: 'commentId',
        targetId: 'comment_1',
        targetKey: 'comment:comment_1',
        payloadBase: { momentId: 'moment_1', like: false, comment: '是呀。' },
        domainId: resolved => resolved.canonicalTarget.commentId
      },
      {
        kind: 'role_plan_update',
        canonicalKey: 'planId',
        legacyKey: 'rolePlanId',
        targetId: 'plan_1',
        targetKey: 'role_plan:plan_1',
        domainId: resolved => resolved.canonicalTarget.rolePlanId
      },
      {
        kind: 'life_episode_update',
        canonicalKey: 'targetEpisodeId',
        legacyKey: 'episodeId',
        targetId: 'life_1',
        targetKey: 'life_episode:life_1',
        domainId: resolved => resolved.canonicalTarget.episodeId
      }
    ];
    for (const entry of cases) {
      const resolved = store.resolveCanonicalActionTargetInternal({
        turn,
        action: {
          kind: entry.kind,
          payload: { ...(entry.payloadBase || {}), [entry.canonicalKey]: entry.targetId }
        }
      });
      assert.equal(resolved.targetKey, entry.targetKey, entry.kind);
      assert.equal(entry.domainId(resolved), entry.targetId, `${entry.kind} domain source`);

      assert.throws(() => store.resolveCanonicalActionTargetInternal({
        turn,
        action: {
          kind: entry.kind,
          payload: { ...(entry.payloadBase || {}), [entry.legacyKey]: entry.targetId }
        }
      }), /canonical .* target|target identity conflict|moment action payload/i,
      `${entry.kind} legacy wire key`);
      assert.throws(() => store.resolveCanonicalActionTargetInternal({
        turn,
        action: {
          kind: entry.kind,
          payload: {
            ...(entry.payloadBase || {}),
            [entry.canonicalKey]: entry.targetId,
            [entry.legacyKey]: entry.targetId
          }
        }
      }), /canonical .* target|target identity conflict|moment action payload/i,
      `${entry.kind} dual wire keys`);
      const inheritedPayload = Object.assign(
        Object.create({ [entry.canonicalKey]: entry.targetId }),
        entry.payloadBase || {}
      );
      assert.throws(() => store.resolveCanonicalActionTargetInternal({
        turn,
        action: { kind: entry.kind, payload: inheritedPayload }
      }), /canonical .* target|target identity conflict|moment action payload/i,
      `${entry.kind} inherited wire key`);
      for (const invalid of ['', null, 1, [entry.targetId], { id: entry.targetId }]) {
        assert.throws(() => store.resolveCanonicalActionTargetInternal({
          turn,
          action: {
            kind: entry.kind,
            payload: { ...(entry.payloadBase || {}), [entry.canonicalKey]: invalid }
          }
        }), /canonical .* target|target identity conflict|moment .* payload/i,
        `${entry.kind} invalid wire type`);
      }
      assert.throws(() => store.resolveCanonicalActionTargetInternal({
        turn,
        action: {
          kind: entry.kind,
          payload: {
            ...(entry.payloadBase || {}),
            [entry.canonicalKey]: `${entry.targetId}_foreign`
          }
        }
      }), /canonical .* target|target identity conflict|moment action payload/i,
      `${entry.kind} foreign target`);
    }

    const nestedOnly = {
      ...turn,
      envelopeJson: JSON.stringify({
        trigger: { context: { input: { commentId: 'comment_nested_only' } } }
      })
    };
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: nestedOnly,
      action: {
        kind: 'moment_reply',
        payload: {
          momentId: 'moment_1', like: false, comment: '回复。',
          replyToCommentId: 'comment_nested_only'
        }
      }
    }), /target identity conflict/i);
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: nestedOnly,
      action: { kind: 'role_plan_update', payload: { planId: 'plan_nested_only' } }
    }), /target identity conflict/i);
  }));

test('v3 moment commits reject private relationship actions even with fixed targets', () =>
  withMomentAuthority((store, turn) => {
    const relationshipPayload = {
      baseAction: {
        from: 'new',
        to: 'acquainted',
        label: '熟悉',
        reason: '共同经历充分',
        confidence: 0.91,
        evidenceMessageIds: ['msg_evidence_1', 'msg_evidence_2'],
        explicitMutualChange: false,
        changedAt: 2000
      },
      phaseAction: null,
      expectedSceneRevision: 4,
      label: '熟悉',
      changedAt: 2000
    };
    const actions = [
      ['moment_like', {
        momentId: 'moment_real', like: true, comment: '', replyToCommentId: null
      }],
      ['moment_comment', {
        momentId: 'moment_real', like: true, comment: '我也喜欢这一张。', replyToCommentId: null
      }],
    ].map(([kind, payload]) => {
      const target = store.resolveCanonicalActionTargetInternal({ turn, action: { kind, payload } });
      return { kind, payload, targetKey: target.targetKey, targetRevision: target.targetRevision };
    });
    actions.push({
      kind: 'relationship_transition',
      payload: relationshipPayload,
      targetKey: 'relationship:yuqi',
      targetRevision: '4'
    });
    const input = commitInput(store, turn);
    input.actionSet = actions;
    input.statePatch = null;
    input.memoryJobs = [];
    input.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    const before = sideEffectCounts(store);
    assert.throws(() => commitVisibleResult(input), /canonical moment action authority|relationship/i);
    assert.deepEqual(sideEffectCounts(store), before);
  }));

test('invalid v3 moment target authority is rejected before a canonical turn can write', () =>
  withStore(store => {
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
    const before = canonicalCreationCounts(store);
    for (const [label, mutate] of [
      ['missing', input => { input.annotationSnapshot = {}; }],
      ['changed', input => { input.envelope.trigger.context.targetMoment.text = 'changed'; }],
      ['foreign', input => { input.envelope.trigger.context.targetMoment.momentId = 'moment_foreign'; }]
    ]) {
      const raw = momentEnvelope(`turn_invalid_scene_revision_${label}`);
      const envelope = validateEnvelope(raw);
      const rollout = store.getCognitionRollout('MOMENT_INTERACTION');
      const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1000 });
      const authority = {
        version: 'moment-target-authority-v1',
        targetMoment: envelope.trigger.context.targetMoment,
        targetComment: envelope.trigger.context.targetComment
      };
      authority.checksum = contentHash(authority);
      const input = {
        envelope,
        rolloutKey: 'MOMENT_INTERACTION',
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
        annotationSnapshot: { momentTargetAuthority: authority }
      };
      mutate(input);
      assert.throws(() => {
        store.createCanonicalVisibleTurnInternal(input);
      }, /moment target authority|canonical turn authority|authority lane mismatch/i, label);
      assert.deepEqual(canonicalCreationCounts(store), before, label);
    }
  }));

test('invalid raw canonical action sources cannot be cleaned into visible SQLite writes', () =>
  withMomentAuthority((store, turn) => {
    const orchestrator = Object.create(YuqiOrchestrator.prototype);
    orchestrator.store = store;
    const moment = {
      momentId: 'moment_real', like: true, comment: '', replyToCommentId: null
    };
    const relationship = {
      baseAction: {
        from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历充分',
        confidence: 0.91, evidenceMessageIds: ['msg_1', 'msg_2'],
        explicitMutualChange: false, changedAt: 2000
      },
      phaseAction: null,
      expectedSceneRevision: 4,
      label: '熟悉',
      changedAt: 2000,
      from: 'new',
      to: 'acquainted',
      reason: '共同经历充分',
      confidence: 0.91,
      evidenceMessageIds: ['msg_1', 'msg_2'],
      explicitMutualChange: false
    };
    const invalid = [
      { actionIntent: { moment: { ...moment, secret: 'leak' } } },
      { momentAction: Object.assign(Object.create({ secret: 'prototype' }), moment) },
      { momentAction: { ...moment, comment: 1 } },
      { momentAction: { ...moment, comment: ['array'] } },
      { relationshipStageAction: { ...relationship, expectedSceneRevision: '4' } },
      { relationshipStageAction: { ...relationship, secret: 'leak' } },
      {
        relationshipStageAction: Object.assign(
          Object.create({ secret: 'prototype' }),
          relationship
        )
      }
    ];
    const before = sideEffectCounts(store);
    for (const rawDraft of invalid) {
      assert.throws(() => {
        const draft = normalizeCanonicalBrainDraft(rawDraft);
        orchestrator.canonicalActionSet(turn, draft);
      }, /canonical (moment|relationship)/i);
      assert.deepEqual(sideEffectCounts(store), before);
    }
  }));

test('moment and relationship payload shapes are closed before canonical writes', () =>
  withMomentAuthority((store, turn) => {
    const relationship = {
      baseAction: {
        from: 'new', to: 'acquainted', label: '熟悉', reason: '共同经历充分',
        confidence: 0.91, evidenceMessageIds: ['msg_1', 'msg_2'],
        explicitMutualChange: false, changedAt: 2000
      },
      phaseAction: null,
      expectedSceneRevision: 4,
      label: '熟悉',
      changedAt: 2000
    };
    const invalid = [
      ['moment_like', {
        momentId: 'moment_real', like: true, comment: '不能伪装成纯点赞', replyToCommentId: null
      }],
      ['moment_comment', {
        momentId: 'moment_real', like: false, comment: '', replyToCommentId: null
      }],
      ['moment_reply', {
        momentId: 'moment_real', like: true, comment: '不能静默丢点赞', replyToCommentId: 'comment_real'
      }],
      ['moment_like', {
        momentId: 'moment_real', like: true, comment: '', replyToCommentId: null, secret: 'leak'
      }],
      ['relationship_transition', { ...relationship, from: 'legacy_flattened' }],
      ['relationship_transition', {
        ...relationship,
        baseAction: { ...relationship.baseAction, secret: 'leak' }
      }],
      ['relationship_transition', { ...relationship, expectedSceneRevision: 5 }]
    ];
    const before = sideEffectCounts(store);
    for (const [kind, payload] of invalid) {
      const input = commitInput(store, turn);
      input.statePatch = null;
      input.memoryJobs = [];
      input.actionSet = [{
        kind,
        payload,
        targetKey: kind === 'moment_reply'
          ? 'comment:comment_real'
          : kind === 'relationship_transition'
            ? 'relationship:yuqi'
            : 'moment:moment_real',
        targetRevision: 'forged'
      }];
      input.generationFingerprint = generationFingerprint({
        roleId: turn.characterId,
        laneKey: turn.laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup: input.visibleGroup,
        actionSet: input.actionSet,
        contextRevision: turn.agencySnapshotChecksum
      });
      assert.throws(() => commitVisibleResult(input), /canonical .* payload|canonical relationship|moment action authority|action-only/i);
      assert.deepEqual(sideEffectCounts(store), before, kind);
    }
  }));

test('moment aliases foreign identities and changed target proofs fail without visible writes', () =>
  withMomentAuthority((store, turn) => {
    const before = sideEffectCounts(store);
    const persistedEnvelope = JSON.parse(turn.envelopeJson);
    const aliasTurn = {
      ...turn,
      envelopeJson: JSON.stringify({
        ...persistedEnvelope,
        context: {
          ...persistedEnvelope.context,
          targetMoment: { momentId: 'moment_real', revision: 3 },
          momentId: 'moment_real'
        },
        trigger: {
          ...persistedEnvelope.trigger,
          context: { input: { id: 'moment_real', momentId: 'moment_real' } }
        }
      })
    };
    const likePayload = {
      momentId: 'moment_real', like: true, comment: '', replyToCommentId: null
    };
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: aliasTurn,
      action: { kind: 'moment_like', payload: likePayload }
    }), /target identity conflict/i);
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn,
      action: {
        kind: 'moment_like',
        payload: { ...likePayload, momentId: 'moment_foreign' }
      }
    }), /target identity conflict/i);
    assert.deepEqual(sideEffectCounts(store), before);

    const target = store.resolveCanonicalActionTargetInternal({
      turn,
      action: { kind: 'moment_like', payload: likePayload }
    });
    const changed = commitInput(store, turn);
    changed.actionSet = [{
      kind: 'moment_like',
      payload: likePayload,
      targetKey: target.targetKey,
      targetRevision: `${target.targetRevision}_changed`
    }];
    changed.visibleGroup = { items: [] };
    changed.statePatch = null;
    changed.memoryJobs = [];
    changed.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: changed.visibleGroup,
      actionSet: changed.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    assert.throws(() => commitVisibleResult(changed), /target revision authority conflict/i);
    assert.deepEqual(sideEffectCounts(store), before);
  }));

test('legacy wire target aliases fail a visible commit without side effects', () =>
  withAuthority((store, turn) => {
    store.putLifePlanInternal('yuqi', [{
      episodeId: 'life_commit_alias',
      kind: 'work',
      title: '整理画稿',
      startAt: 2_000,
      endAt: 3_000,
      payload: {}
    }]);
    const target = store.resolveCanonicalTargetRefInternal({
      turn,
      namespace: 'life_episode',
      targetId: 'life_commit_alias'
    });
    const input = commitInput(store, turn);
    input.actionSet = [{
      kind: 'life_episode_update',
      targetKey: target.targetKey,
      targetRevision: target.targetRevision,
      payload: {
        type: 'reschedule',
        episodeId: 'life_commit_alias',
        startAt: 2_500,
        endAt: 3_500,
        reason: '旧wire别名不得成为权威目标'
      }
    }];
    input.generationFingerprint = generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: turn.agencySnapshotChecksum
    });
    const before = sideEffectCounts(store);
    assert.throws(
      () => commitVisibleResult(input),
      /canonical life_episode target|target identity conflict/i
    );
    assert.deepEqual(sideEffectCounts(store), before);
    assert.equal(store.getTurn(turn.turnId).state, 'queued');
    assert.equal(store.getTurnAuthorityLineage(turn.authorityLineageKey).state, 'open');
  }));

test('shadow commit requires the exact pinned comparison descriptor', () =>
  withStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const initial = store.getCognitionRollout('DIRECT_REPLY');
    const candidate = store.listPipelineReleases().find(
      release => release.releaseId !== initial.stableReleaseId
    );
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET current_mode = 'shadow', rollout_phase = 'collecting',
          candidate_release_id = ?, candidate_phase = 'shadow', shadow_epoch = 1
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run(candidate.releaseId);
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const source = envelope('turn_shadow_compare');
    const snapshot = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: source,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: rollout.candidateReleaseId,
      comparisonDirection: 'stable_authoritative_candidate_compare',
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: `batch_${source.message.messageId}`,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: snapshot.checksum,
      annotationSnapshot: { training: 'v4' }
    }).turn;
    const visibleGroup = {
      items: [{
        content: '在。',
        speakerId: 'yuqi',
        speakerType: 'character',
        recipientId: 'user'
      }]
    };
    const generation = generationFingerprint({
      roleId: 'yuqi',
      laneKey: 'private_chat',
      inputVisibilitySequence: 0,
      visibleGroup,
      actionSet: [],
      contextRevision: snapshot.checksum
    });
    const base = {
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      expectedCognitiveStateRevision: 0,
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: snapshot.checksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonDirection: 'stable_authoritative_candidate_compare',
      visibleGroup,
      actionSet: [],
      statePatch: null,
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generation,
      now: 2_000
    };
    assert.throws(() => commitVisibleResult(base), /comparison authority conflict/i);
    const valid = {
      ...base,
      comparisonJob: {
      jobId: 'compare_shadow',
      jobType: 'shadow_cognition',
      payload: {
        comparisonReleaseId: turn.comparisonReleaseId,
        comparisonDirection: 'stable_authoritative_candidate_compare',
        rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
        shadowEpoch: turn.shadowEpoch,
        canaryEpoch: null,
        canarySlot: null,
        annotationSnapshotChecksum: contentHash(turn.annotationSnapshot),
        inputChecksum: contentHash({
          envelope: source,
          authoritativeReleaseId: turn.authoritativeReleaseId,
          authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
          comparisonReleaseId: turn.comparisonReleaseId,
          comparisonPipelineChecksum: turn.comparisonPipelineChecksum,
          rolloutRevision: turn.rolloutRevision,
          rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
          shadowEpoch: turn.shadowEpoch,
          canaryEpoch: turn.canaryEpoch,
          canarySlot: turn.canarySlot
        })
      }
    }};
    const wrong = {
      ...valid,
      comparisonJob: structuredClone(valid.comparisonJob)
    };
    wrong.comparisonJob.payload.inputChecksum = 'f'.repeat(64);
    assert.throws(() => commitVisibleResult(wrong), /comparison authority conflict/i);
    const receipt = commitVisibleResult(valid);
    assert.equal(store.comparisonJobsForGroup(receipt.visibleGroupId).length, 1);
    const claimed = store.claimDueConsolidationJob({
      workerId: 'comparison-worker',
      jobTypes: ['shadow_cognition'],
      now: 2_001,
      leaseMs: 60_000
    });
    const authority = store.loadComparisonExecutionAuthorityInternal({
      jobId: claimed.jobId,
      workerId: 'comparison-worker'
    });
    assert.equal(authority.status, 'ready');
    assert.equal(authority.subjectId, turn.authorityLineageKey);
    store.recordComparisonOutcomeInternal({
      jobId: claimed.jobId,
      workerId: 'comparison-worker',
      run: {
        runId: 'run_real_shadow_compare',
        comparisonResultChecksum: 'a'.repeat(64),
        metrics: { schemaValid: true },
        latencyMs: 12
      },
      report: { reportId: 'report_real_shadow_compare', summary: {} },
      criticalFindings: [],
      now: 2_010
    });
    assert.equal(store.getCognitionRollout('DIRECT_REPLY').liveShadowSuccessCount, 1);
    assert.doesNotThrow(() => store.assertVisibleAuthorityV13Invariants());
  }));

test('exact repeated commit returns one receipt and changed payload conflicts', () =>
  withAuthority((store, turn) => {
    const input = commitInput(store, turn);
    const first = commitVisibleResult(input);
    const second = commitVisibleResult(input);
    assert.equal(second.commitChecksum, first.commitChecksum);
    assert.equal(second.visibleGroupId, first.visibleGroupId);
    const changed = commitInput(store, turn);
    changed.visibleGroup.items[0].content = '不同回复';
    assert.throws(() => commitVisibleResult(changed), /different checksum/i);
  }));

test('committed canonical creation replay returns its original receipt after rollout changes', () =>
  withAuthority((store, turn, creationInput) => {
    const receipt = commitVisibleResult(commitInput(store, turn));
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET revision = revision + 1, candidate_phase = 'shadow',
          rollout_phase = 'collecting', current_mode = 'shadow'
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    const replay = store.createCanonicalVisibleTurnInternal(structuredClone(creationInput));
    assert.equal(replay.status, 'already_committed');
    assert.equal(replay.receipt.visibleGroupId, receipt.visibleGroupId);
    assert.equal(replay.receipt.commitChecksum, receipt.commitChecksum);
  }));

test('exact commit replay rejects an in-process corrupted manifest', () =>
  withAuthority((store, turn) => {
    const input = commitInput(store, turn);
    commitVisibleResult(input);
    store.db.prepare(`
      UPDATE visible_result_manifests
      SET semantic_json = '{"tampered":true}'
    `).run();
    assert.throws(
      () => commitVisibleResult(input),
      /canonical commit authority conflict/
    );
  }));

test('same-turn create and committed retry replay share manifest closure', () =>
  withAuthority((store, turn, creationInput) => {
    commitVisibleResult(commitInput(store, turn));
    const retryInput = structuredClone(creationInput);
    retryInput.envelope = structuredClone(creationInput.envelope);
    retryInput.envelope.turnId = `${turn.turnId}_retry`;
    retryInput.envelope.deviceSeq += 1;
    retryInput.envelope.context = {
      retry: {
        retryOfTurnId: turn.turnId,
        canonicalMessageId: creationInput.envelope.message.messageId
      }
    };
    retryInput.expectedLaneRevision = store.getInteractionLane('yuqi', 'private_chat').revision;
    retryInput.inputUserBatchId = turn.inputUserBatchId;
    retryInput.inputVisibilitySequence = turn.inputVisibilitySequence;
    store.db.prepare('DELETE FROM visible_result_manifests').run();
    assert.throws(
      () => store.createCanonicalVisibleTurnInternal(structuredClone(creationInput)),
      /canonical commit authority conflict/
    );
    assert.throws(
      () => store.createCanonicalVisibleTurnInternal(retryInput),
      /canonical commit authority conflict/
    );
  }));

test('fresh v13 commits pin clear epoch while committed retry replay ignores mutable cursor state', () =>
  withStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    store.claimInteractionLaneInternal({
      roleId: 'yuqi',
      laneKey: 'private_chat',
      expectedRevision: 0,
      now: 1
    });
    store.db.prepare(`
      UPDATE interaction_lanes SET clear_epoch = 3
      WHERE role_id = 'yuqi' AND lane_key = 'private_chat'
    `).run();
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    const originalEnvelope = envelope('turn_clear_epoch');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const originalInput = {
      envelope: originalEnvelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: lane.revision,
      inputUserBatchId: `batch_${originalEnvelope.message.messageId}`,
      inputVisibilitySequence: lane.localSequence,
      inputClearEpoch: 3,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    };
    assert.throws(
      () => store.createCanonicalVisibleTurnInternal({
        ...structuredClone(originalInput),
        inputClearEpoch: 2
      }),
      /clear epoch authority/
    );
    const original = store.createCanonicalVisibleTurnInternal(originalInput).turn;
    assert.equal(original.inputClearEpoch, 3);
    const commit = commitInput(store, original);
    commit.inputClearEpoch = 3;
    commit.expectedCognitiveStateRevision = 0;
    const receipt = commitVisibleResult(commit);
    assert.equal(receipt.commitPayloadVersion, 'pc-visible-commit-v2');

    const retryInput = structuredClone(originalInput);
    retryInput.envelope.turnId = 'turn_clear_epoch_retry';
    retryInput.envelope.deviceSeq += 1;
    retryInput.envelope.context = {
      retry: {
        retryOfTurnId: original.turnId,
        canonicalMessageId: originalEnvelope.message.messageId
      }
    };
    retryInput.expectedLaneRevision = store.getInteractionLane('yuqi', 'private_chat').revision;
    retryInput.inputUserBatchId = original.inputUserBatchId;
    retryInput.inputVisibilitySequence = original.inputVisibilitySequence;
    const changedCursorReplay = store.createCanonicalVisibleTurnInternal({
      ...structuredClone(retryInput),
      inputClearEpoch: 4
    });
    assert.equal(changedCursorReplay.status, 'already_committed');
    assert.equal(changedCursorReplay.receipt.commitChecksum, receipt.commitChecksum);
    const replay = store.createCanonicalVisibleTurnInternal(retryInput);
    assert.equal(replay.status, 'already_committed');
    assert.equal(replay.receipt.commitChecksum, receipt.commitChecksum);
  }));

test('open canonical retry inherits release pins but refreshes lane visibility authority', () =>
  withStore(store => {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA
      }],
      now: 1
    });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const originalEnvelope = envelope('turn_lane_retry_original');
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const original = store.createCanonicalVisibleTurnInternal({
      envelope: originalEnvelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: `batch_${originalEnvelope.message.messageId}`,
      inputVisibilitySequence: 0,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    store.recordCanonicalTurnFailureInternal({
      turnId: original.turnId,
      expectedState: original.state,
      expectedTurnRevision: original.turnRevision,
      failure: { failureClass: 'transient', code: 'TIMEOUT' }
    });
    store.db.prepare(`
      UPDATE interaction_lanes
      SET revision = revision + 1, local_sequence = local_sequence + 3,
          clear_epoch = clear_epoch + 1
      WHERE role_id = 'yuqi' AND lane_key = 'private_chat'
    `).run();
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    const retryEnvelope = structuredClone(originalEnvelope);
    retryEnvelope.turnId = 'turn_lane_retry_child';
    retryEnvelope.deviceSeq += 1;
    retryEnvelope.context = {
      retry: {
        retryOfTurnId: original.turnId,
        canonicalMessageId: originalEnvelope.message.messageId
      }
    };
    const retry = store.createCanonicalVisibleTurnInternal({
      envelope: retryEnvelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: original.rolloutRevision,
      authoritativeReleaseId: original.authoritativeReleaseId,
      comparisonReleaseId: original.comparisonReleaseId,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: lane.revision,
      inputUserBatchId: original.inputUserBatchId,
      inputVisibilitySequence: lane.localSequence,
      inputClearEpoch: lane.clearEpoch,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: original.annotationSnapshot
    }).turn;
    assert.equal(retry.authoritativeReleaseId, original.authoritativeReleaseId);
    assert.equal(retry.authoritativePipelineChecksum, original.authoritativePipelineChecksum);
    assert.equal(retry.inputVisibilitySequence, lane.localSequence);
    assert.equal(retry.inputClearEpoch, lane.clearEpoch);
  }));

for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
  test(`forced failure after commit step ${step} rolls back canonical authority`, () =>
    withAuthority((store, turn) => {
      const before = sideEffectCounts(store);
      store.commitFaultAfterStep = step;
      assert.throws(() => commitVisibleResult(commitInput(store, turn)), /forced commit fault/);
      assert.deepEqual(sideEffectCounts(store), before);
      assert.equal(store.getTurnAuthorityLineage(turn.authorityLineageKey).state, 'open');
      assert.equal(store.getTurn(turn.turnId).state, 'queued');
    }));
}

for (const [name, mutate] of [
  ['new user batch', input => { input.expectedLatestUserBatchId = 'msg_newer'; }],
  ['visibility sequence', input => { input.inputVisibilitySequence += 1; }],
  ['turn revision', input => { input.expectedTurnRevision += 1; }],
  ['lineage revision', input => { input.expectedLineageRevision += 1; }],
  ['lane revision', input => { input.expectedLaneRevision += 1; }],
  ['cognitive state revision', input => { input.expectedCognitiveStateRevision += 1; }],
  ['agency snapshot checksum', input => { input.agencySnapshotChecksum = 'b'.repeat(64); }],
  ['release pin', input => { input.authoritativeReleaseId = 'release_wrong'; }],
  ['generation fingerprint', input => { input.generationFingerprint = 'f'.repeat(64); }],
  ['action target revision', input => {
    input.actionSet[0].targetRevision = '99';
    input.generationFingerprint = generationFingerprint({
      roleId: 'yuqi',
      laneKey: input.laneKey,
      inputVisibilitySequence: input.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet,
      contextRevision: input.agencySnapshotChecksum
    });
  }]
]) {
  test(`${name} conflict rolls back every visible side effect`, () =>
    withAuthority((store, turn) => {
      const input = commitInput(store, turn);
      const before = sideEffectCounts(store);
      mutate(input);
      assert.throws(() => commitVisibleResult(input), /authority conflict/i);
      assert.deepEqual(sideEffectCounts(store), before);
      assert.equal(store.getTurnAuthorityLineage(turn.authorityLineageKey).state, 'open');
    }));
}
