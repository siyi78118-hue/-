import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildProactiveMotiveAuthority,
  motiveIdForSource,
  proactiveMotiveSourceContext
} from '../src/life-simulation.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../src/store.mjs';
import {
  canonicalActionSetForDraft,
  shouldSkipProactiveSilence,
  YuqiOrchestrator
} from '../src/orchestrator.mjs';

const NOW = 1784400000000;
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function skipEnvelope(index) {
  const triggerId = `trigger_skip_${index}`;
  return {
    protocolVersion: 3,
    turnId: `turn_skip_${index}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: index,
    createdAt: NOW + index,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId,
      triggerType: 'proactive_chat',
      scheduledFor: NOW + index - 1,
      executedAt: NOW + index,
      context: {}
    },
    context: {
      visibilityCursor: {
        nativeCompletedTurnId: null,
        nativeCompletedGroupId: null,
        nativeCompletedSequence: 0,
        uiAppliedTurnId: null,
        uiAppliedGroupId: null,
        uiAppliedSequence: 0,
        localSequence: index,
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
      laneKey: 'private_chat',
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: triggerId }),
      claimedLineageRevision: 1,
      retryOfTurnId: null
    }
  };
}

function episode(overrides = {}) {
  return {
    episodeId: 'life-7',
    kind: 'personal',
    title: '散步',
    status: 'active',
    startAt: NOW - 30 * 60_000,
    endAt: NOW + 30 * 60_000,
    checksum: SHA_A,
    updatedAt: 7,
    payload: { summary: '傍晚散步' },
    ...overrides
  };
}

test('zero persisted motives yields structural skip authority without model input', () => {
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: null, recent: [], upcoming: [] },
    cognitiveState: null
  });
  assert.deepEqual(authority.candidates, []);
  assert.equal(authority.structuralSilence, null);
  assert.match(authority.checksum, /^[a-f0-9]{64}$/);
});

test('canonical v3 proactive structural silence is eligible for pre-model skip', () => {
  assert.equal(shouldSkipProactiveSilence({
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_CHAT',
    annotationSnapshot: { proactiveMotiveAuthority: { candidates: [], structuralSilence: null } }
  }), true);
  assert.equal(shouldSkipProactiveSilence({
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_CHAT',
    annotationSnapshot: { proactiveMotiveAuthority: { candidates: [{ motiveId: 'motive_1' }], structuralSilence: { reasonCode: 'ACTIVE_PRIVATE_CHAT_CONSTRAINT' } } }
  }), true);
  assert.equal(shouldSkipProactiveSilence({
    protocolVersion: 3,
    rolloutKey: 'PROACTIVE_CHAT',
    annotationSnapshot: { proactiveMotiveAuthority: { candidates: [{ motiveId: 'motive_1' }], structuralSilence: null } }
  }), false);
  assert.equal(shouldSkipProactiveSilence({
    protocolVersion: 2,
    rolloutKey: 'PROACTIVE_CHAT',
    annotationSnapshot: { proactiveMotiveAuthority: { candidates: [], structuralSilence: null } }
  }), false);
});

test('non-proactive structured skip keeps its canonical action while proactive skip stays empty', () => {
  const action = { kind: 'moment_like', targetKey: 'moment_1', targetRevision: '1' };
  assert.deepEqual(canonicalActionSetForDraft({
    isProactiveV3: false,
    draft: { action: 'skip' },
    resolve: () => [action]
  }), [action]);
  assert.deepEqual(canonicalActionSetForDraft({
    isProactiveV3: true,
    draft: { action: 'skip' },
    resolve: () => [action]
  }), []);
});

test('canonical v3 structural skip commits before image or model execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-task17-structural-skip-'));
  const store = new YuqiStore(join(root, 'runtime.sqlite'));
  const releaseCalls = [];
  try {
    store.initializeCognitionRolloutsInternal({
      rows: ['PROACTIVE_CHAT', 'DIRECT_REPLY'].map(rolloutKey => ({
        rolloutKey,
        currentMode: 'legacy',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: SHA_A
      })),
      now: 1
    });
    const envelope = skipEnvelope(1);
    const authority = buildProactiveMotiveAuthority({
      consideredAt: envelope.createdAt,
      lifeContext: { current: null, recent: [], upcoming: [] },
      cognitiveState: null
    });
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.createdAt });
    const rollout = store.getCognitionRollout('PROACTIVE_CHAT');
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'PROACTIVE_CHAT',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: 0,
      inputUserBatchId: envelope.trigger.triggerId,
      inputVisibilitySequence: 1,
      inputClearEpoch: 0,
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: { proactiveMotiveAuthority: authority }
    }).turn;
    const result = await new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {},
      releaseExecutor: {
        async executeTurn() {
          releaseCalls.push('turn');
          throw new Error('structural skip must not call model');
        },
        async executeLife() { throw new Error('life execution is not used'); }
      },
      clock: () => NOW + 10,
      lifePlanningEnabled: false
    }).run(turn.turnId);
    assert.deepEqual(releaseCalls, []);
    assert.equal(store.assertVisibleGroupAuthorityInternal(result.visibleGroupId, {
      purpose: 'reopen'
    }).terminalDisposition, 'skip');
    const group = store.db.prepare(
      'SELECT item_count, action_count FROM visible_result_groups WHERE authoritative_turn_id = ?'
    ).get(turn.turnId);
    assert.equal(Number(group.item_count), 0);
    assert.equal(Number(group.action_count), 0);
    assert.equal(Number(store.db.prepare(
      'SELECT COUNT(*) AS value FROM consolidation_jobs WHERE turn_id = ?'
    ).get(turn.turnId).value), 0);
    const nextDirect = skipEnvelope(2);
    nextDirect.kind = 'DIRECT_REPLY';
    delete nextDirect.trigger;
    nextDirect.message = {
      messageId: 'msg_after_committed_proactive',
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '继续',
      sentAt: nextDirect.createdAt
    };
    nextDirect.authority.rootSourceId = nextDirect.message.messageId;
    nextDirect.authority.lineageKey = deriveAuthorityLineageKey({
      roleId: nextDirect.characterId,
      laneKey: nextDirect.authority.laneKey,
      rootSourceId: nextDirect.authority.rootSourceId
    });
    nextDirect.context.currentBatch = {
      batchId: 'batch_after_committed_proactive',
      messageIds: [nextDirect.message.messageId],
      startedAt: nextDirect.message.sentAt,
      committedAt: nextDirect.createdAt,
      messages: [nextDirect.message]
    };
    nextDirect.context.visibilityCursor.localSequence =
      Number(store.getInteractionLane('yuqi', 'private_chat').localSequence || 0) + 1;
    const nextAgency = store.readAgencyAuthoritySnapshotInternal({
      roleId: 'yuqi', at: nextDirect.message.sentAt
    });
    const nextRollout = store.getCognitionRollout('DIRECT_REPLY');
    assert.equal(nextRollout != null, true);
    assert.doesNotThrow(() => store.createCanonicalVisibleTurnInternal({
      envelope: nextDirect,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: nextRollout.revision,
      authoritativeReleaseId: nextRollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey: 'private_chat',
      expectedLaneRevision: store.getInteractionLane('yuqi', 'private_chat').revision,
      inputUserBatchId: nextDirect.context.currentBatch.batchId,
      inputVisibilitySequence: nextDirect.context.visibilityCursor.localSequence,
      inputClearEpoch: 0,
      agencySnapshotChecksum: nextAgency.checksum,
      annotationSnapshot: {}
    }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a current active episode is a current_life_episode motive until its endAt', () => {
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: episode({ startAt: NOW - 1_000, endAt: NOW + 1_000 }), recent: [], upcoming: [] },
    cognitiveState: null
  });
  assert.equal(authority.candidates.length, 1);
  assert.equal(authority.candidates[0].sourceType, 'current_life_episode');
  assert.equal(authority.candidates[0].expiresAt, NOW + 1_000);
});

test('motive candidates use immutable source revisions, deterministic IDs, ordering, and a six-item cap', () => {
  const sources = Array.from({ length: 7 }, (_, index) => episode({
    episodeId: `life-${index}`,
    endAt: NOW - index * 60_000,
    updatedAt: index + 1,
    checksum: `${String(index + 1).repeat(64)}`
  }));
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: sources[0], recent: sources.slice(1), upcoming: [] },
    cognitiveState: null
  });
  assert.equal(authority.candidates.length, 6);
  assert.deepEqual(
    authority.candidates,
    [...authority.candidates].sort((left, right) =>
      right.occurredAt - left.occurredAt || left.motiveId.localeCompare(right.motiveId)
    )
  );
  for (const candidate of authority.candidates) {
    assert.equal(candidate.motiveId, motiveIdForSource(candidate));
    assert.match(candidate.sourceChecksum, /^[a-f0-9]{64}$/);
  }
});

test('life episode updatedAt churn does not mint a new motive or bypass consumption', () => {
  const unchanged = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: episode({ updatedAt: 7 }), recent: [], upcoming: [] },
    cognitiveState: null
  });
  const changedTimestamp = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: episode({ updatedAt: 8 }), recent: [], upcoming: [] },
    cognitiveState: null
  });
  assert.equal(unchanged.candidates.length, 1);
  assert.equal(changedTimestamp.candidates.length, 1);
  assert.equal(changedTimestamp.candidates[0].sourceRevision, null);
  assert.equal(changedTimestamp.candidates[0].motiveId, unchanged.candidates[0].motiveId);
  const changedMeaning = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: episode({ updatedAt: 8, checksum: SHA_B }), recent: [], upcoming: [] },
    cognitiveState: null
  });
  assert.notEqual(changedMeaning.candidates[0].motiveId, unchanged.candidates[0].motiveId);
  const consumed = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: episode({ updatedAt: 8 }), recent: [], upcoming: [] },
    cognitiveState: null,
    consumedMotiveIds: [unchanged.candidates[0].motiveId]
  });
  assert.deepEqual(consumed.candidates, []);
});

test('cancelled, expired, future, and checksum-missing sources never become motives', () => {
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: {
      current: episode({ status: 'cancelled' }),
      recent: [
        episode({ episodeId: 'life_old', endAt: NOW - 7 * 60 * 60_000 }),
        episode({ episodeId: 'life_missing_checksum', checksum: null }),
        episode({ episodeId: 'life_future', startAt: NOW + 60_000, endAt: NOW + 120_000 })
      ],
      upcoming: []
    },
    cognitiveState: {
      revision: 2,
      checksum: SHA_A,
      state: {
        openThreads: [
          { threadId: 'mood-only', summary: '', sourceTurnId: null, lastTouchedAt: NOW },
          { threadId: 'thread_missing_source', summary: 'has text', sourceTurnId: null, lastTouchedAt: NOW, checksum: SHA_A }
        ]
      }
    }
  });
  assert.deepEqual(authority.candidates, []);
});

test('schema-v2 rich open threads are pinned to the enclosing cognitive row', () => {
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: null, recent: [], upcoming: [] },
    cognitiveState: {
      schemaVersion: 2,
      revision: 7,
      lastTurnId: 'turn_source',
      checksum: SHA_A,
      state: {
        fastState: {
          openThreads: [{
            threadId: ' thread_1 ',
            summary: '  待确认的安排  ',
            sourceTurnId: ' turn_source ',
            lastTouchedAt: NOW,
            checksum: SHA_B,
            revision: 999
          }],
          openThreadIds: ['thread_1']
        },
        mediumState: {},
        slowState: {}
      }
    }
  });
  assert.equal(authority.candidates.length, 1);
  assert.equal(authority.candidates[0].sourceId, 'thread_1');
  assert.equal(authority.candidates[0].summary, '待确认的安排');
  assert.equal(authority.candidates[0].sourceTurnId, undefined);
  assert.equal(authority.candidates[0].sourceChecksum, SHA_A);
  assert.equal(authority.candidates[0].sourceRevision, 7);
  assert.equal(Object.isFrozen(authority), true);
});

test('schema-v2 openThreadIds or fabricated root openThreads are not rich evidence', () => {
  for (const state of [
    { fastState: { openThreadIds: ['thread_1'] }, mediumState: {}, slowState: {} },
    {
      fastState: {}, mediumState: {}, slowState: {},
      openThreads: [{ threadId: 'thread_1', summary: 'fake', sourceTurnId: 'turn', lastTouchedAt: NOW }]
    }
  ]) {
    const authority = buildProactiveMotiveAuthority({
      consideredAt: NOW,
      lifeContext: { current: null, recent: [], upcoming: [] },
      cognitiveState: { schemaVersion: 2, revision: 7, checksum: SHA_A, state }
    });
    assert.deepEqual(authority.candidates, []);
  }
});

test('active private-chat constraints create only the closed structural silence object', () => {
  const authority = buildProactiveMotiveAuthority({
    consideredAt: NOW,
    lifeContext: { current: null, recent: [], upcoming: [] },
    cognitiveState: null,
    hardConstraints: [{
      constraintId: 'constraint_private',
      revision: 4,
    kind: 'action',
    rule: 'deny_proactive_chat',
    status: 'active',
    scope: { channel: 'private_chat' }
    }]
  });
  assert.deepEqual(authority.structuralSilence, {
    reasonCode: 'ACTIVE_PRIVATE_CHAT_CONSTRAINT',
    constraintRefs: [{ constraintId: 'constraint_private', revision: 4 }]
  });
});

test('production motive source context scans all recent episodes before the six-candidate cap', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-proactive-sources-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    const recent = Array.from({ length: 5 }, (_, index) => {
      const endAt = NOW - index * 10_000;
      return {
        episodeId: `recent_${index}`,
        kind: 'personal',
        title: `最近事件${index}`,
        startAt: endAt - 5_000,
        endAt
      };
    });
    store.putLifePlan('yuqi', [
      ...recent,
      {
        episodeId: 'current',
        kind: 'personal',
        title: '当前事件',
        startAt: NOW,
        endAt: NOW + 100_000
      }
    ]);
    const sourceContext = proactiveMotiveSourceContext(store, 'yuqi', NOW);
    assert.equal(sourceContext.current.episodeId, 'current');
    assert.equal(sourceContext.recent.length, 5);
    const authority = buildProactiveMotiveAuthority({
      consideredAt: NOW,
      lifeContext: sourceContext,
      cognitiveState: null
    });
    assert.equal(authority.candidates.length, 6);
    assert.deepEqual(
      authority.candidates.map(candidate => candidate.sourceId),
      ['current', 'recent_0', 'recent_1', 'recent_2', 'recent_3', 'recent_4']
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('recent motive expiry is endAt plus six hours and excludes the exact boundary', () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-proactive-expiry-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    store.putLifePlan('yuqi', [{
      episodeId: 'recent_boundary',
      kind: 'personal',
      title: '边界事件',
      startAt: NOW - 5_000,
      endAt: NOW
    }]);
    const beforeBoundary = NOW + 6 * 60 * 60_000 - 1;
    const before = proactiveMotiveSourceContext(store, 'yuqi', beforeBoundary);
    assert.equal(before.recent.length, 1);
    const authority = buildProactiveMotiveAuthority({
      consideredAt: beforeBoundary,
      lifeContext: before,
      cognitiveState: null
    });
    assert.equal(authority.candidates[0].expiresAt, NOW + 6 * 60 * 60_000);
    const atBoundary = proactiveMotiveSourceContext(
      store,
      'yuqi',
      NOW + 6 * 60 * 60_000
    );
    assert.equal(atBoundary.recent.length, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
