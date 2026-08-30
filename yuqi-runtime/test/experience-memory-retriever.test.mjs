import assert from 'node:assert/strict';
import test from 'node:test';

import { buildExperienceContext } from '../src/persona-evolution/experience-context-builder.mjs';
import { ExperienceMemoryRetriever } from '../src/persona-evolution/experience-memory-retriever.mjs';

function summary(overrides = {}) {
  return {
    id: 'sum_synthetic_1',
    entityType: 'session_summary',
    schemaVersion: 1,
    roleId: 'role_a',
    createdAt: '2026-08-27T10:00:00.000Z',
    updatedAt: '2026-08-27T10:00:00.000Z',
    revision: 1,
    sourceSessionId: `ses_${'a'.repeat(64)}`,
    startedAt: '2026-08-27T09:00:00.000Z',
    endedAt: '2026-08-27T09:30:00.000Z',
    sourceMessageIds: ['msg_1'],
    sourceDigest: 'b'.repeat(64),
    keyEvents: ['我在关系压力下回避了直接冲突，也谈到 DIRECT 表达。'],
    emotionalSummary: { user: '认真', al: '犹豫', interaction: '直接讨论表达问题' },
    importantDecisions: ['以后继续观察是否会隐藏自己的意见。'],
    generation: { summarizerVersion: 'v', promptVersion: 'p', model: 'm' },
    hiddenCognition: 'must-not-enter-context',
    systemPrompt: 'must-not-enter-context',
    ...overrides
  };
}

function memory(id, overrides = {}) {
  return {
    id,
    entityType: 'memory',
    schemaVersion: 1,
    roleId: 'role_a',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    revision: 1,
    kind: 'event',
    content: '我曾经在关系压力下回避直接冲突。',
    confidence: 0.7,
    status: 'active',
    sourceRefs: [],
    supersedesId: null,
    supersededById: null,
    diagnostic: 'must-not-enter-context',
    ...overrides
  };
}

test('retrieval is deterministic, Unicode-aware, active-only, bounded, and preserves conflicting evidence', () => {
  const retriever = new ExperienceMemoryRetriever();
  const memories = [
    memory('mem_explicit', {
      content: '一条没有词面重叠但直接引用当前摘要的记忆。',
      sourceRefs: [{ type: 'session_summary', id: 'sum_synthetic_1' }]
    }),
    memory('mem_conflict_a', { content: '我经常会回避直接冲突。', confidence: 0.4 }),
    memory('mem_conflict_b', { content: '我通常愿意直接面对冲突。', confidence: 0.45 }),
    memory('mem_latin', { content: 'DIRECT conflict avoidance was observed.', confidence: 0.2 }),
    memory('mem_irrelevant', { content: '用户喜欢芒果味冰淇淋。', kind: 'preference' }),
    memory('mem_redacted', { content: '回避直接冲突。', status: 'redacted' }),
    memory('mem_other_role', { roleId: 'role_b', content: '回避直接冲突。' })
  ];

  const selected = retriever.retrieve({
    roleId: 'role_a', sessionSummary: summary(), memories, limit: 4
  });
  assert.deepEqual(selected.map(item => item.id), [
    'mem_explicit', 'mem_conflict_a', 'mem_conflict_b', 'mem_latin'
  ]);
  assert.equal(selected.some(item => item.id === 'mem_redacted'), false);
  assert.equal(selected.some(item => item.id === 'mem_other_role'), false);
  assert.equal(selected.length, 4);
  assert.deepEqual(
    retriever.retrieve({ roleId: 'role_a', sessionSummary: summary(), memories, limit: 4 }),
    selected
  );
});

test('retrieval allows zero results and never fills the limit with unrelated memories', () => {
  const retriever = new ExperienceMemoryRetriever();
  const selected = retriever.retrieve({
    roleId: 'role_a',
    sessionSummary: summary({
      keyEvents: ['讨论了量子计算。'],
      emotionalSummary: { user: null, al: null, interaction: null },
      importantDecisions: []
    }),
    memories: [memory('mem_unrelated', { content: '用户喜欢芒果味冰淇淋。' })],
    limit: 8
  });
  assert.deepEqual(selected, []);
});

test('context builder exposes only the closed summary, personality, and memory projections', () => {
  const personalityState = {
    id: 'ps_synthetic_1', entityType: 'personality_state', schemaVersion: 1,
    roleId: 'role_a', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    revision: 4,
    selfDescription: '我正在学习保留自己的判断。',
    tendencies: [{ id: 't_1', statement: '我会谨慎表达。', confidence: 0.7, status: 'tentative', sourceRefs: [] }],
    tensions: [{ id: 'x_1', left: '直接表达', right: '维护关系', description: '两者同时存在。', sourceRefs: [] }],
    secret: 'must-not-enter-context'
  };
  const relevant = [memory('mem_low_confidence', { confidence: 0.12 })];
  const context = buildExperienceContext({
    sessionSummary: summary(), personalityState, relevantMemories: relevant
  });
  assert.deepEqual(Object.keys(context).sort(), ['personalityState', 'relevantMemories', 'sessionSummary']);
  assert.deepEqual(Object.keys(context.sessionSummary).sort(), [
    'emotionalSummary', 'id', 'importantDecisions', 'keyEvents', 'revision', 'sourceDigest'
  ]);
  assert.deepEqual(Object.keys(context.personalityState).sort(), ['selfDescription', 'tendencies', 'tensions']);
  assert.deepEqual(Object.keys(context.relevantMemories[0]).sort(), ['confidence', 'content', 'id', 'kind']);
  assert.equal(context.relevantMemories[0].confidence, 0.12);
  assert.equal(JSON.stringify(context).includes('must-not-enter-context'), false);
  assert.equal(buildExperienceContext({
    sessionSummary: summary(), personalityState: null, relevantMemories: []
  }).personalityState, null);
});
