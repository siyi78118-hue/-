import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const SHA = 'a'.repeat(64);

function envelope(turnId = 'turn_canonical_state') {
  return {
    protocolVersion: 2,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 1,
    createdAt: 1_000,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_${turnId}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '测试 canonical 状态',
      sentAt: 1_000
    }
  };
}

function withCanonical(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-canonical-state-'));
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
    const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({
      roleId: 'yuqi',
      at: 1_000
    });
    const created = store.createCanonicalVisibleTurnInternal({
      envelope: envelope(),
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: 'batch_msg_turn_canonical_state',
      inputVisibilitySequence: 0,
      agencySnapshotChecksum: agencySnapshot.checksum,
      annotationSnapshot: {}
    }).turn;
    return run(store, created);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function commitCanonical(store, turn) {
  const visibleGroup = {
    items: [{
      content: '已提交。',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user'
    }]
  };
  return commitVisibleResult({
    store,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
    expectedCognitiveStateRevision: 0,
    expectedLatestUserBatchId: turn.inputUserBatchId,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet: [],
    statePatch: null,
    memoryJobs: [],
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet: [],
      contextRevision: turn.agencySnapshotChecksum
    }),
    now: 2_000
  });
}

for (const [name, prepare, call] of [
  [
    'claimTurnById',
    () => {},
    (store, turn) => store.claimTurnById(turn.turnId, 'legacy-worker')
  ],
  [
    'advanceTurn',
    () => {},
    (store, turn) => store.advanceTurn(turn.turnId, 'queued', 'memory_running')
  ],
  [
    'recoverFailedDraft',
    (store, turn) => store.db.prepare(`
      UPDATE turns
      SET state = 'failed', brain_draft_json = ?
      WHERE turn_id = ?
    `).run(JSON.stringify({ reply: '旧恢复路径不得提交' }), turn.turnId),
    (store, turn) => store.recoverFailedDraft(turn.turnId)
  ],
  [
    'requeueTransientFailedTurn',
    (store, turn) => store.db.prepare(`
      UPDATE turns
      SET state = 'failed', error_json = ?
      WHERE turn_id = ?
    `).run(JSON.stringify({ name: 'CodexTurnError', message: 'request timed out' }), turn.turnId),
    (store, turn) => store.requeueTransientFailedTurn(turn.turnId)
  ]
]) {
  test(`legacy ${name} cannot mutate a canonical turn`, () =>
    withCanonical((store, turn) => {
      prepare(store, turn);
      const before = store.getTurn(turn.turnId);
      assert.throws(() => call(store, turn), /canonical turn API required/i);
      assert.deepEqual(store.getTurn(turn.turnId), before);
    }));
}

test('canonical lifecycle uses explicit turn revisions for claim checkpoint failure and requeue', () =>
  withCanonical((store, turn) => {
    const claimed = store.claimCanonicalTurnInternal({
      turnId: turn.turnId,
      workerId: 'canonical-worker',
      expectedTurnRevision: 1
    });
    assert.equal(claimed.state, 'memory_running');
    assert.equal(claimed.turnRevision, 2);

    const checkpoint = store.advanceCanonicalTurnInternal({
      turnId: turn.turnId,
      expectedState: 'memory_running',
      nextState: 'memory_done',
      expectedTurnRevision: 2,
      patch: { memoryPacketJson: JSON.stringify({ ok: true }) }
    });
    assert.equal(checkpoint.turnRevision, 3);

    const failed = store.recordCanonicalTurnFailureInternal({
      turnId: turn.turnId,
      expectedState: 'memory_done',
      expectedTurnRevision: 3,
      failure: {
        name: 'CodexTurnError',
        message: 'request timed out',
        failureClass: 'transient'
      }
    });
    assert.equal(failed.state, 'failed');
    assert.equal(failed.turnRevision, 4);
    assert.equal(
      store.getTurnAuthorityLineage(turn.authorityLineageKey).state,
      'open'
    );

    for (const stale of [
      () => store.claimCanonicalTurnInternal({
        turnId: turn.turnId,
        workerId: 'stale',
        expectedTurnRevision: 1
      }),
      () => store.advanceCanonicalTurnInternal({
        turnId: turn.turnId,
        expectedState: 'failed',
        nextState: 'queued',
        expectedTurnRevision: 3,
        patch: {}
      }),
      () => store.recordCanonicalTurnFailureInternal({
        turnId: turn.turnId,
        expectedState: 'failed',
        expectedTurnRevision: 3,
        failure: { name: 'Error', message: 'stale' }
      }),
      () => store.requeueCanonicalFailedTurnInternal({
        turnId: turn.turnId,
        expectedTurnRevision: 3,
        allowedFailureClass: 'transient'
      })
    ]) {
      assert.throws(stale, /canonical (turn|transition) authority conflict/i);
    }

    const requeued = store.requeueCanonicalFailedTurnInternal({
      turnId: turn.turnId,
      expectedTurnRevision: 4,
      allowedFailureClass: 'transient'
    });
    assert.equal(requeued.state, 'memory_done');
    assert.equal(requeued.turnRevision, 5);
  }));

test('canonical cancellation atomically closes the lineage and rejects stale cancellation', () =>
  withCanonical((store, turn) => {
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    const cancelled = store.cancelCanonicalTurnInternal({
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: lineage.revision,
      reasonCode: 'SUPERSEDED_BY_DIRECT_REPLY'
    });
    assert.equal(cancelled.turn.state, 'failed');
    assert.equal(cancelled.turn.turnRevision, turn.turnRevision + 1);
    assert.equal(cancelled.lineage.state, 'cancelled');
    assert.equal(cancelled.lineage.revision, lineage.revision + 1);
    assert.throws(() => store.cancelCanonicalTurnInternal({
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: lineage.revision,
      reasonCode: 'STALE'
    }), /canonical turn authority conflict/i);
    assert.throws(() => store.requeueCanonicalFailedTurnInternal({
      turnId: turn.turnId,
      expectedTurnRevision: cancelled.turn.turnRevision,
      allowedFailureClass: ''
    }), /canonical (committed authority is immutable|turn authority conflict)/i);
  }));

test('all legacy turn execution writers reject a canonical turn', () =>
  withCanonical((store, turn) => {
    const characterMessage = {
      messageId: 'msg_canonical_output_bypass',
      turnId: turn.turnId,
      characterId: 'yuqi',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user',
      content: '不得旁路写入',
      sentAt: 2_000
    };
    for (const write of [
      () => store.setTurnRoute(turn.turnId, 'fast', ['test']),
      () => store.beginStage(turn.turnId, 'memory'),
      () => store.finishStage(turn.turnId, 'memory'),
      () => store.putMessageInternal(characterMessage)
    ]) {
      const before = store.getTurn(turn.turnId);
      assert.throws(write, /canonical .* API required/i);
      assert.equal(store.getTurn(turn.turnId).turnRevision, before.turnRevision);
    }
    assert.equal(store.getMessage(characterMessage.messageId), null);
  }));

test('canonical route and stage writers CAS the turn revision', () =>
  withCanonical((store, turn) => {
    const routed = store.setCanonicalTurnRouteInternal({
      turnId: turn.turnId,
      expectedState: 'queued',
      expectedTurnRevision: 1,
      route: 'fast',
      reasons: ['direct_reply']
    });
    assert.equal(routed.turnRevision, 2);
    assert.equal(routed.route, 'fast');
    assert.throws(() => store.beginCanonicalStageInternal({
      turnId: turn.turnId,
      expectedState: 'queued',
      expectedTurnRevision: 1,
      stage: 'memory',
      model: 'codex',
      effort: 'medium',
      startedAt: 10
    }), /canonical turn authority conflict/i);
    const begun = store.beginCanonicalStageInternal({
      turnId: turn.turnId,
      expectedState: 'queued',
      expectedTurnRevision: 2,
      stage: 'memory',
      model: 'codex',
      effort: 'medium',
      startedAt: 10
    });
    assert.equal(begun.turn.turnRevision, 3);
    assert.equal(begun.stage.finishedAt, null);
    const finished = store.finishCanonicalStageInternal({
      turnId: turn.turnId,
      expectedState: 'queued',
      expectedTurnRevision: 3,
      stage: 'memory',
      finishedAt: 20
    });
    assert.equal(finished.turn.turnRevision, 4);
    assert.equal(finished.stage.finishedAt, 20);
  }));

test('a committed canonical lineage is immutable through every attempt writer', () =>
  withCanonical((store, turn) => {
    commitCanonical(store, turn);
    const receipt = store.getVisibleCommitReceipt(turn.authorityLineageKey);
    const writes = [
      () => store.setCanonicalTurnRouteInternal({
        turnId: turn.turnId,
        expectedState: 'committed',
        expectedTurnRevision: receipt.turnRevisionAfter,
        route: 'fast',
        reasons: ['forged']
      }),
      () => store.beginCanonicalStageInternal({
        turnId: turn.turnId,
        expectedState: 'committed',
        expectedTurnRevision: receipt.turnRevisionAfter,
        stage: 'memory',
        model: 'codex',
        effort: 'medium',
        startedAt: 3_000
      }),
      () => store.advanceCanonicalTurnInternal({
        turnId: turn.turnId,
        expectedState: 'committed',
        nextState: 'queued',
        expectedTurnRevision: receipt.turnRevisionAfter
      }),
      () => store.recordCanonicalTurnFailureInternal({
        turnId: turn.turnId,
        expectedState: 'committed',
        expectedTurnRevision: receipt.turnRevisionAfter,
        failure: { failureClass: 'terminal', code: 'FORGED' }
      })
    ];
    for (const write of writes) {
      assert.throws(write, /canonical committed authority is immutable/i);
      assert.deepEqual(store.getVisibleCommitReceipt(turn.authorityLineageKey), receipt);
      assert.equal(store.getTurn(turn.turnId).turnRevision, receipt.turnRevisionAfter);
      assert.equal(store.getTurn(turn.turnId).state, 'committed');
    }
  }));

test('generic canonical advance accepts only the explicit forward graph', () =>
  withCanonical((store, turn) => {
    const claimed = store.claimCanonicalTurnInternal({
      turnId: turn.turnId,
      workerId: 'worker',
      expectedTurnRevision: turn.turnRevision
    });
    const before = store.getTurn(turn.turnId);
    for (const nextState of [
      'memory_running', 'brain_running', 'approved', 'committed', 'queued', 'failed'
    ]) {
      assert.throws(() => store.advanceCanonicalTurnInternal({
        turnId: turn.turnId,
        expectedState: claimed.state,
        nextState,
        expectedTurnRevision: before.turnRevision
      }), /canonical transition authority conflict/i);
      assert.deepEqual(store.getTurn(turn.turnId), before);
    }
    const advanced = store.advanceCanonicalTurnInternal({
      turnId: turn.turnId,
      expectedState: 'memory_running',
      nextState: 'memory_done',
      expectedTurnRevision: before.turnRevision
    });
    assert.equal(advanced.state, 'memory_done');
  }));
