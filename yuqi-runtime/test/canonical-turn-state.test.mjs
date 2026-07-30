import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { YuqiStore } from '../src/store.mjs';

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
      inputUserBatchId: 'msg_turn_canonical_state',
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
      assert.throws(stale, /canonical turn authority conflict/i);
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
  }));
