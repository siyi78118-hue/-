import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyStanceTransitions,
  compileAgencyView,
  normalizeCurrentStance,
  normalizeHardConstraint,
  normalizePreference,
  transitionHardConstraint
} from '../src/agency-state.mjs';

function stance(overrides = {}) {
  return {
    stanceId: 's1',
    topic: 'gift_play',
    position: 'not accepting another gift today',
    reason: 'already accepted one',
    strength: 0.8,
    flexibility: 0.7,
    sourceTurnId: 'turn_1',
    sourceMessageIds: ['a1'],
    createdAt: 1000,
    lastConfirmedAt: 1000,
    expiresAt: null,
    remainingRelevantUserBatches: 2,
    status: 'active',
    revision: 1,
    supersedes: null,
    ...overrides
  };
}

function userConstraint(overrides = {}) {
  return {
    constraintId: 'c1',
    authority: 'user',
    kind: 'consent',
    subject: 'both',
    scope: { channel: 'private_chat', target: 'gift_play' },
    rule: 'stop when I ask',
    sourceMessageIds: ['u1'],
    sourceConfigRef: null,
    createdAt: 1000,
    releaseCondition: '用户明确解除',
    status: 'active',
    revision: 1,
    supersedes: null,
    ...overrides
  };
}

test('Yuqi-authored ordinary refusal cannot become a hard constraint', () => {
  assert.throws(
    () => normalizeHardConstraint({
      constraintId: 'c1',
      authority: 'yuqi',
      kind: 'consent',
      sourceMessageIds: ['a1'],
      status: 'active',
      revision: 1
    }, new Map([['a1', { speakerType: 'assistant' }]])),
    /authority/
  );
});

test('a user hard constraint requires only matching user message evidence', () => {
  const evidence = new Map([
    ['u1', { messageId: 'u1', speakerType: 'user', content: '停一下' }],
    ['a1', { messageId: 'a1', speakerType: 'assistant', content: '好' }]
  ]);
  assert.throws(
    () => normalizeHardConstraint(userConstraint({ sourceMessageIds: ['u1', 'a1'] }), evidence),
    /user message evidence/
  );
  const normalized = normalizeHardConstraint(userConstraint(), evidence);
  assert.equal(normalized.authority, 'user');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.scope), true);
});

test('a user constraint is released only by matching user authority evidence', () => {
  const current = userConstraint({ revision: 1, releaseCondition: '用户明确解除' });
  assert.throws(() => transitionHardConstraint({
    constraint: current,
    operation: 'release',
    authorityEvidence: [{ messageId: 'a2', speakerType: 'assistant', content: '那就算了' }],
    now: 2000
  }), /matching authority/);
  const released = transitionHardConstraint({
    constraint: current,
    operation: 'release',
    authorityEvidence: [{ messageId: 'u2', speakerType: 'user', content: '这个限制可以取消了' }],
    now: 2000
  });
  assert.equal(released.status, 'released');
  assert.equal(released.revision, 2);
  assert.equal(released.supersedes, 'c1');
  assert.equal(current.status, 'active');
});

test('preferences stay advisory and cannot smuggle binding language', () => {
  const original = { preferenceId: 'p1', topic: 'food', value: 'sweet', binding: true };
  const normalized = normalizePreference(original);
  assert.equal(normalized.binding, false);
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(original.binding, true);
});

test('normalization clamps stance strength, flexibility, duration, and expires by time', () => {
  const normalized = normalizeCurrentStance(stance({
    strength: 7,
    flexibility: -2,
    remainingRelevantUserBatches: 12,
    expiresAt: 1500
  }), 2000);
  assert.equal(normalized.strength, 1);
  assert.equal(normalized.flexibility, 0);
  assert.equal(normalized.remainingRelevantUserBatches, 3);
  assert.equal(normalized.status, 'expired');
});

test('a relevant user batch decrements a stance and expires it at zero', () => {
  const result = applyStanceTransitions({
    stances: [stance({ remainingRelevantUserBatches: 1 })],
    transitions: [{ stanceId: 's1', operation: 'maintain', evidenceMessageIds: ['u2'] }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    evidenceIndex: new Map([['u2', { messageId: 'u2', speakerType: 'user' }]]),
    now: 2000
  });
  assert.equal(result.activeStances.length, 0);
  assert.equal(result.changedRecords[0].status, 'expired');
  assert.equal(result.changedRecords[0].revision, 2);
  assert.deepEqual(result.auditRecords, [{
    stanceId: 's1',
    revision: 2,
    status: 'expired',
    supersedes: 's1@1',
    sourceMessageIds: ['u2'],
    lastConfirmedAt: 2000
  }]);
});

test('an irrelevant user batch neither requires coverage nor decrements a stance', () => {
  const current = stance({ remainingRelevantUserBatches: 2 });
  const result = applyStanceTransitions({
    stances: [current],
    transitions: [],
    relevantBatch: { messageIds: ['u2'], topics: ['work'] },
    now: 2000
  });
  assert.equal(result.activeStances[0].remainingRelevantUserBatches, 2);
  assert.equal(result.changedRecords.length, 0);
});

test('every relevant active stance requires exactly one transition', () => {
  const input = {
    stances: [stance()],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    evidenceIndex: new Map([['u2', { messageId: 'u2', speakerType: 'user' }]]),
    now: 2000
  };
  assert.throws(() => applyStanceTransitions({ ...input, transitions: [] }), /transition coverage/);
  assert.throws(() => applyStanceTransitions({
    ...input,
    transitions: [
      { stanceId: 's1', operation: 'maintain', evidenceMessageIds: ['u2'] },
      { stanceId: 's1', operation: 'soften', evidenceMessageIds: ['u2'] }
    ]
  }), /transition coverage/);
});

test('maintain requires fresh evidence from the submitted batch', () => {
  assert.throws(() => applyStanceTransitions({
    stances: [stance()],
    transitions: [{ stanceId: 's1', operation: 'maintain', evidenceMessageIds: ['old'] }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    evidenceIndex: new Map([['old', { messageId: 'old', speakerType: 'user' }]]),
    now: 2000
  }), /fresh evidence/);
});

test('soften and reverse create revisions rather than mutating history', () => {
  const original = stance({ strength: 0.8, flexibility: 0.7 });
  const result = applyStanceTransitions({
    stances: [original],
    transitions: [{
      stanceId: 's1',
      operation: 'reverse',
      position: 'accept playful affection',
      reason: 'the new bid changed her mind',
      evidenceMessageIds: ['u2']
    }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    evidenceIndex: new Map([['u2', { messageId: 'u2', speakerType: 'user' }]]),
    now: 2000
  });
  assert.equal(result.changedRecords.length, 1);
  assert.equal(result.changedRecords[0].stanceId, 's1');
  assert.equal(result.changedRecords[0].status, 'active');
  assert.equal(result.changedRecords[0].supersedes, 's1@1');
  assert.equal(result.activeStances[0].stanceId, 's1');
  assert.equal(result.activeStances[0].supersedes, 's1@1');
  assert.equal(result.activeStances[0].revision, 2);
  assert.equal(original.status, 'active');
  assert.equal(original.position, 'not accepting another gift today');
});

test('strengthen and soften are bounded and extensions cannot exceed three batches', () => {
  const strengthened = applyStanceTransitions({
    stances: [stance({ strength: 0.8, remainingRelevantUserBatches: 3 })],
    transitions: [{
      stanceId: 's1',
      operation: 'strengthen',
      strength: 2,
      extendRelevantUserBatches: 9,
      evidenceMessageIds: ['u2']
    }],
    relevantBatch: { messageIds: ['u2'], topics: ['gift_play'] },
    evidenceIndex: new Map([['u2', { messageId: 'u2', speakerType: 'user' }]]),
    now: 2000
  });
  assert.equal(strengthened.activeStances[0].strength, 1);
  assert.equal(strengthened.activeStances[0].remainingRelevantUserBatches, 3);

  const softened = applyStanceTransitions({
    stances: strengthened.activeStances,
    transitions: [{
      stanceId: strengthened.activeStances[0].stanceId,
      operation: 'soften',
      strength: -1,
      evidenceMessageIds: ['u3']
    }],
    relevantBatch: { messageIds: ['u3'], topics: ['gift_play'] },
    evidenceIndex: new Map([['u3', { messageId: 'u3', speakerType: 'user' }]]),
    now: 3000
  });
  assert.equal(softened.activeStances[0].strength, 0);
});

test('create and explicit expire preserve auditable records', () => {
  const created = applyStanceTransitions({
    stances: [],
    transitions: [{
      stanceId: 'new',
      operation: 'create',
      topic: 'work',
      position: 'needs quiet',
      reason: 'deadline',
      strength: 0.6,
      flexibility: 0.4,
      evidenceMessageIds: ['u2']
    }],
    relevantBatch: { messageIds: ['u2'], topics: ['work'], turnId: 'turn_2' },
    evidenceIndex: new Map([['u2', { messageId: 'u2', speakerType: 'user' }]]),
    now: 2000
  });
  assert.equal(created.activeStances.length, 1);
  assert.equal(created.activeStances[0].revision, 1);

  const expired = applyStanceTransitions({
    stances: created.activeStances,
    transitions: [{
      stanceId: created.activeStances[0].stanceId,
      operation: 'expire',
      evidenceMessageIds: ['u3']
    }],
    relevantBatch: { messageIds: ['u3'], topics: ['work'] },
    evidenceIndex: new Map([['u3', { messageId: 'u3', speakerType: 'user' }]]),
    now: 3000
  });
  assert.equal(expired.activeStances.length, 0);
  assert.equal(expired.changedRecords.at(-1).status, 'expired');
});

test('time expiry appends a terminal revision under the stable stance id', () => {
  const result = applyStanceTransitions({
    stances: [stance({ expiresAt: 1_500 })],
    transitions: [],
    relevantBatch: { messageIds: [], topics: [] },
    now: 2_000
  });
  assert.equal(result.activeStances.length, 0);
  assert.equal(result.changedRecords[0].stanceId, 's1');
  assert.equal(result.changedRecords[0].revision, 2);
  assert.equal(result.changedRecords[0].status, 'expired');
  assert.equal(result.changedRecords[0].supersedes, 's1@1');
});

test('agency view expires by time, filters by feature relevance, ranks deterministically, and is bounded', () => {
  const constraints = Array.from({ length: 7 }, (_, index) => userConstraint({
    constraintId: `c${index}`,
    kind: index === 0 ? 'privacy' : 'consent',
    scope: {
      channel: index === 6 ? 'public_moment' : 'private_chat',
      target: index % 2 ? 'gift_play' : 'all'
    },
    createdAt: 1000 + index
  }));
  const preferences = Array.from({ length: 6 }, (_, index) => ({
    preferenceId: `p${index}`,
    topic: index === 5 ? 'unrelated' : 'gift_play',
    value: `v${index}`,
    binding: false,
    weight: index / 10,
    updatedAt: 1000 + index
  }));
  const stances = [
    stance({ stanceId: 'expired', expiresAt: 1500, lastConfirmedAt: 9000 }),
    stance({ stanceId: 's2', strength: 0.9, lastConfirmedAt: 3000 }),
    stance({ stanceId: 's3', strength: 0.9, lastConfirmedAt: 4000 }),
    stance({ stanceId: 's4', topic: 'unrelated', strength: 1, lastConfirmedAt: 5000 })
  ];
  const view = compileAgencyView({
    constraints,
    preferences,
    stances,
    featureContext: { channel: 'private_chat', topics: ['gift_play'], target: 'gift_play', now: 2000 },
    limits: { hardConstraints: 5, currentStances: 2, preferences: 4 }
  });
  assert.ok(view.hardConstraints.length <= 5);
  assert.ok(view.currentStances.length <= 2);
  assert.ok(view.preferences.length <= 4);
  assert.ok(view.preferences.every(item => item.binding === false));
  assert.equal(view.currentStances.some(item => item.stanceId === 'expired'), false);
  assert.equal(view.currentStances.some(item => item.stanceId === 's4'), false);
  assert.deepEqual(view.currentStances.map(item => item.stanceId), ['s3', 's2']);
  assert.equal(view.hardConstraints.some(item => item.constraintId === 'c6'), false);
});
