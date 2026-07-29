import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeCognitiveState,
  reduceCognitiveState
} from '../src/cognitive-state.mjs';

function packet(overrides = {}) {
  return {
    cognitionResult: {
      conversationFrame: {
        activeHooks: ['聊完手里的工作', '晚饭吃什么', '明天的安排', '第四个会被裁掉'],
        priorTopic: {
          status: 'open',
          summary: '继续当前话题',
          waitingOn: 'yuqi'
        },
        explicitBoundaries: [{
          type: 'no_pressure',
          reason: '用户明确说过',
          evidenceMessageIds: ['msg_1'],
          expiresAfterBatches: 2
        }],
        recentCorrection: {
          active: true,
          rejectedInterpretation: '不是在生气',
          expiresAfterBatches: 2,
          evidenceMessageIds: ['msg_1']
        }
      },
      selfState: {
        mood: '开心',
        moodCause: '聊天自然',
        bodyState: '有点累',
        attention: '当前聊天',
        stanceTowardUser: '亲近',
        ownNeed: '先休息一下',
        intensity: 0.8
      },
      decision: { shouldRespond: true },
      ...overrides
    }
  };
}

test('normalizes an empty state without allowing base or phase ownership', () => {
  const state = normalizeCognitiveState({ base: 'close', phase: 'conflict' });
  assert.equal(state.revision, 0);
  assert.equal(state.openThreads.length, 0);
  assert.equal(Object.hasOwn(state, 'base'), false);
  assert.equal(Object.hasOwn(state, 'phase'), false);
  assert.match(state.checksum, /^[a-f0-9]{64}$/);
});

test('committed cognition advances continuity idempotently and keeps only three sourced threads', () => {
  const input = {
    previous: null,
    cognitionPacket: packet(),
    committedTurn: {
      turnId: 'turn_1',
      kind: 'DIRECT_REPLY',
      state: 'committed',
      hasUserBatch: true
    },
    lifeState: {},
    now: 1_000
  };
  const first = reduceCognitiveState(input);
  assert.equal(first.revision, 1);
  assert.equal(first.openThreads.length, 3);
  assert.ok(first.openThreads.every(thread => thread.sourceTurnId === 'turn_1'));
  assert.equal(first.recentCorrection.remainingBatches, 2);
  assert.equal(reduceCognitiveState({ ...input, previous: first }).checksum, first.checksum);
});

test('failed or rejected turns do not mutate state', () => {
  const before = normalizeCognitiveState({ revision: 3, lastTurnId: 'turn_old' });
  for (const committedTurn of [
    { turnId: 'failed', state: 'failed', kind: 'DIRECT_REPLY' },
    { turnId: 'rejected', state: 'committed', kind: 'DIRECT_REPLY', supervisorDecision: 'reject' }
  ]) {
    assert.equal(reduceCognitiveState({
      previous: before,
      cognitionPacket: packet(),
      committedTurn,
      now: 2_000
    }).checksum, before.checksum);
  }
});

test('mood persists with elapsed-time decay and life signals without inventing user attitude', () => {
  const previous = normalizeCognitiveState({
    revision: 1,
    lastTurnId: 'turn_old',
    mood: { label: '开心', cause: '昨天聊天', intensity: 0.9, updatedAt: 1_000 },
    stanceTowardUser: '亲近',
    updatedAt: 1_000
  });
  const next = reduceCognitiveState({
    previous,
    cognitionPacket: packet({ selfState: { ...packet().cognitionResult.selfState, intensity: 0 } }),
    committedTurn: {
      turnId: 'turn_2',
      kind: 'PROACTIVE_CHAT',
      state: 'committed',
      hasUserBatch: false
    },
    lifeState: {
      cognitiveSignals: {
        bodyState: '困倦',
        attention: '准备休息',
        intensityDelta: -0.1
      }
    },
    now: 1_000 + 7 * 24 * 60 * 60_000
  });
  assert.equal(next.bodyState, '困倦');
  assert.equal(next.attention, '准备休息');
  assert.ok(next.mood.intensity < previous.mood.intensity);
  assert.equal(next.stanceTowardUser, '亲近');
});

test('a direct state proposal can never authorize silence', () => {
  assert.throws(() => reduceCognitiveState({
    previous: null,
    cognitionPacket: packet({ decision: { shouldRespond: false } }),
    committedTurn: {
      turnId: 'turn_skip',
      kind: 'DIRECT_REPLY',
      state: 'committed',
      hasUserBatch: true
    },
    now: 1_000
  }), /cannot authorize skip/);
});
