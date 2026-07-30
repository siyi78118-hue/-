import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideLaneAdmission,
  generationFingerprint,
  laneKeyForEnvelope,
  priorityForEnvelope
} from '../src/interaction-lanes.mjs';

function envelope(kind, context = {}) {
  return { kind, characterId: 'yuqi', context };
}

function turn(turnId, kind, state = 'generating') {
  return { turnId, kind, state, committed: false };
}

test('lane keys isolate private chat, public posting, and individual moment threads', () => {
  assert.equal(laneKeyForEnvelope(envelope('DIRECT_REPLY')), 'private_chat');
  assert.equal(laneKeyForEnvelope(envelope('ROLE_PLAN_MOMENT')), 'public_moment');
  assert.equal(laneKeyForEnvelope(envelope('MOMENT_REPLY', {
    targetMoment: { momentId: 'moment_7' }
  })), 'moment_interaction:moment_7');
  assert.throws(() => laneKeyForEnvelope(envelope('LIFE_PLANNING')), /no interaction lane/);
});

test('private priority is direct reply over due plan over proactive chat', () => {
  assert.equal(priorityForEnvelope(envelope('DIRECT_REPLY')), 300);
  assert.equal(priorityForEnvelope(envelope('ROLE_PLAN_CHAT')), 200);
  assert.equal(priorityForEnvelope(envelope('PROACTIVE_CHAT')), 100);
});

test('new user batch supersedes an uncommitted ordinary proactive turn', () => {
  const result = decideLaneAdmission({
    lane: { generatingTurn: turn('proactive_1', 'PROACTIVE_CHAT') },
    incoming: turn('direct_1', 'DIRECT_REPLY', 'queued'),
    now: 1000
  });
  assert.equal(result.admitted, true);
  assert.equal(result.supersededTurnId, 'proactive_1');
  assert.equal(result.reasonCode, 'superseded_by_user_batch');
  assert.equal(result.requeueTurnId, null);
});

test('a due commitment is postponed, not deleted', () => {
  const result = decideLaneAdmission({
    lane: { generatingTurn: turn('plan_1', 'ROLE_PLAN_CHAT') },
    incoming: turn('direct_1', 'DIRECT_REPLY', 'queued'),
    now: 1000
  });
  assert.equal(result.admitted, true);
  assert.equal(result.requeueTurnId, 'plan_1');
  assert.equal(result.supersededTurnId, null);
  assert.equal(result.cancelTurnId, null);
  assert.equal(result.reasonCode, 'postponed_by_user_batch');
});

test('a committed visible turn is never retroactively superseded', () => {
  const result = decideLaneAdmission({
    lane: {
      generatingTurn: {
        ...turn('proactive_1', 'PROACTIVE_CHAT'),
        committed: true
      }
    },
    incoming: turn('direct_1', 'DIRECT_REPLY', 'queued'),
    now: 1000
  });
  assert.equal(result.admitted, false);
  assert.equal(result.reasonCode, 'current_turn_already_committed');
});

test('fingerprint only deduplicates adjacent matching authority contexts', () => {
  const value = {
    roleId: 'yuqi',
    laneKey: 'private_chat',
    inputVisibilitySequence: 8,
    visibleGroup: [{ text: ' 你好  ' }, { text: '今天怎么样' }],
    actionSet: [{ type: 'payment', messageId: 'pay_1', action: 'received' }],
    contextRevision: 'ctx_1'
  };
  assert.equal(generationFingerprint(value), generationFingerprint(structuredClone(value)));
  assert.notEqual(
    generationFingerprint(value),
    generationFingerprint({ ...value, inputVisibilitySequence: 9 })
  );
  assert.notEqual(
    generationFingerprint(value),
    generationFingerprint({ ...value, contextRevision: 'ctx_2' })
  );
});

test('generation fingerprint follows input visibility, not retry lane revision', () => {
  const base = {
    roleId: 'yuqi',
    laneKey: 'private_chat',
    inputVisibilitySequence: 7,
    visibleGroup: { items: [{ content: '收到。' }] },
    actionSet: [],
    contextRevision: 'agency-1'
  };
  assert.equal(
    generationFingerprint({ ...base, laneRevision: 2 }),
    generationFingerprint({ ...base, laneRevision: 99 })
  );
  assert.notEqual(
    generationFingerprint(base),
    generationFingerprint({ ...base, inputVisibilitySequence: 8 })
  );
  assert.notEqual(
    generationFingerprint(base),
    generationFingerprint({
      ...base,
      visibleGroup: { items: [{ content: '不同回复' }] }
    })
  );
});
