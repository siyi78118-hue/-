import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { contentHash } from '../src/protocol.mjs';
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
  const fingerprint = generationFingerprint({
    roleId: turn.characterId,
    laneKey: turn.laneKey,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    visibleGroup,
    actionSet,
    contextRevision: turn.agencySnapshotChecksum
  });
  return {
    store,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
    expectedCognitiveStateRevision: 1,
    expectedLatestUserBatchId: turn.inputUserBatchId,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet,
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
    momentEnvelope.context = {
      targetMoment: { momentId: 'moment_real', revision: 3 }
    };
    const momentTurn = { ...turn, envelopeJson: JSON.stringify(momentEnvelope) };
    assert.throws(() => store.resolveCanonicalActionTargetInternal({
      turn: momentTurn,
      action: {
        kind: 'moment_like',
        payload: { momentId: 'moment_forged' }
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
      targetComment: { commentId: 'comment_real', content: 'hi' },
      roleOccurrence: {
        occurrenceId: 'occurrence_real',
        characterId: 'yuqi',
        revision: 2
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
          targetMoment: { momentId: 'moment_1', revision: 3 },
          commentId: 'comment_1',
          rolePlan: { rolePlanId: 'plan_1', revision: 2 },
          relationship: { phase: 'familiar', revision: 4 }
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
      ['moment_create', {}, 'lineage_create:lin_registry:moment_create'],
      ['moment_like', { momentId: 'moment_1' }, 'moment:moment_1'],
      ['moment_comment', { momentId: 'moment_1' }, 'moment:moment_1'],
      ['moment_reply', { commentId: 'comment_1' }, 'comment:comment_1'],
      ['role_plan_create', {}, 'lineage_create:lin_registry:role_plan_create'],
      ['role_plan_update', { rolePlanId: 'plan_1' }, 'role_plan:plan_1'],
      ['life_episode_create', {}, 'lineage_create:lin_registry:life_episode_create'],
      ['life_episode_update', { episodeId: 'life_1' }, 'life_episode:life_1'],
      ['relationship_transition', {}, 'relationship:yuqi']
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
      comparisonDirection: turn.comparisonMode,
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
        comparisonDirection: turn.comparisonMode,
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
    assert.doesNotThrow(() => store.assertVisibleAuthorityV12Invariants());
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
