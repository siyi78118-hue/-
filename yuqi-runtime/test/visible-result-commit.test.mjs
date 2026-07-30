import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';
import {
  YuqiStore,
  deriveAuthorityLineageKey,
  deriveVisibleActionId,
  deriveVisibleGroupId,
  deriveVisibleMessageId
} from '../src/store.mjs';

const SHA = 'a'.repeat(64);

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
    const creationInput = {
      envelope: envelope(),
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: 'msg_user_authority',
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: SHA,
      annotationSnapshot: {}
    };
    const creation = store.createCanonicalVisibleTurnInternal(creationInput);
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 1,
      lastTurnId: creation.turn.turnId,
      state: {
        slowState: {},
        mediumState: {},
        fastState: { mood: 'neutral' }
      },
      updatedAt: 1001
    });
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
    kind: 'chat_marker',
    targetKey: 'conversation:yuqi:user',
    targetRevision: '1',
    payload: { marker: 'replied' }
  }];
  const fingerprint = generationFingerprint({
    roleId: turn.characterId,
    laneKey: turn.laneKey,
    laneRevision: turn.laneRevision,
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
      roleId: 'yuqi',
      schemaVersion: 2,
      revision: 2,
      state: {
        slowState: {},
        mediumState: {},
        fastState: { mood: 'engaged' }
      },
      stanceRevisions: [{
        stanceId: 'stance_authority',
        revision: 1,
        topic: 'conversation',
        position: '想继续聊',
        reason: '当前互动',
        strength: 0.7,
        flexibility: 0.8,
        sourceMessageIds: ['msg_user_authority'],
        createdAt: 2000,
        lastConfirmedAt: 2000,
        expiresAt: 3000,
        remainingRelevantUserBatches: 3,
        status: 'active',
        supersedes: null
      }]
    },
    memoryJobs: [{
      jobId: 'job_authority',
      jobType: 'turn_consolidation',
      payload: { turnId: turn.turnId }
    }],
    comparisonJob: {
      jobId: 'job_authority_compare',
      jobType: 'shadow_cognition',
      payload: { comparisonReleaseId: 'release_candidate' }
    },
    generationFingerprint: fingerprint,
    now: 2000
  };
}

function sideEffectCounts(store) {
  return Object.fromEntries([
    'visible_result_groups',
    'visible_result_items',
    'visible_result_actions',
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
    assert.equal(store.comparisonJobsForGroup(result.visibleGroupId).length, 1);
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

for (const step of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
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
      laneRevision: 1,
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
