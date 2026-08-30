import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import {
  PersonaDataCorruptionError,
  PersonaDuplicateEntityError,
  PersonaNotFoundError,
  PersonaRevisionConflictError,
  PersonaValidationError
} from '../src/persona-evolution/errors.mjs';
import { FilePersonaEvolutionRepository } from '../src/persona-evolution/file-repository.mjs';
import { PersonaEvolutionRepository } from '../src/persona-evolution/repository.mjs';
import { ENTITY_TYPES } from '../src/persona-evolution/schemas.mjs';
import { validatePersistedEntity } from '../src/persona-evolution/validation.mjs';

function fixtureClock(start = Date.parse('2026-08-27T10:30:00.000Z')) {
  let tick = start;
  return () => new Date(tick++).toISOString();
}

function fixtureIds() {
  const counts = new Map();
  return prefix => {
    const next = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };
}

function repository(rootDir, overrides = {}) {
  return new FilePersonaEvolutionRepository({
    rootDir,
    now: fixtureClock(),
    idFactory: fixtureIds(),
    ...overrides
  });
}

function personalityInput(overrides = {}) {
  return {
    selfDescription: '我正在学习在关心关系的同时保留自己的判断。',
    tendencies: [{
      id: 'tendency_voice',
      statement: '我愿意表达判断，但在不确定对方态度时会谨慎。',
      confidence: 0.72,
      status: 'tentative',
      sourceRefs: []
    }],
    tensions: [{
      id: 'tension_voice_relation',
      left: '表达真实判断',
      right: '避免伤害关系',
      description: '两种倾向会同时存在。',
      sourceRefs: []
    }],
    ...overrides
  };
}

function memoryInput(overrides = {}) {
  return {
    kind: 'preference',
    content: '用户更重视人格的活人感。',
    confidence: 0.9,
    status: 'active',
    sourceRefs: [{ type: 'manual', id: 'review_1' }],
    supersedesId: null,
    supersededById: null,
    ...overrides
  };
}

function summaryInput(overrides = {}) {
  return {
    sourceSessionRef: 'synthetic_session_1',
    startedAt: '2026-08-27T09:00:00.000Z',
    endedAt: '2026-08-27T10:00:00.000Z',
    summary: '双方讨论了人格表达与关系维护之间的平衡。',
    keyEvents: ['指出过度迎合会削弱真实感。'],
    sourceRefs: [{ type: 'session', id: 'synthetic_session_1' }],
    ...overrides
  };
}

function interpretationInput(summaryId, overrides = {}) {
  return {
    sessionSummaryId: summaryId,
    meaning: '我意识到避免冲突不应替代自己的真实判断。',
    selfImpact: '我开始重新审视表达与关系之间的平衡。',
    hypotheses: [{ statement: '我可能过度回避冲突。', confidence: 0.62 }],
    sourceRefs: [{ type: 'session_summary', id: summaryId }],
    ...overrides
  };
}

function automaticSummaryInput(overrides = {}) {
  return {
    sourceSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    startedAt: '2026-08-27T09:00:00.000Z',
    endedAt: '2026-08-27T10:00:00.000Z',
    sourceMessageIds: ['msg_synthetic_1', 'msg_synthetic_2'],
    sourceDigest: 'b'.repeat(64),
    keyEvents: ['用户指出过度迎合会削弱真实感。'],
    emotionalSummary: { user: '认真', al: '不确定', interaction: '直接但平稳' },
    importantDecisions: ['继续观察表达与关系之间的张力。'],
    generation: {
      summarizerVersion: 'session-summarizer-v0.1',
      promptVersion: 'session-summary-prompt-v1',
      model: 'synthetic-model'
    },
    ...overrides
  };
}

function automaticInterpretationInput(summaryId, overrides = {}) {
  return {
    sessionSummaryId: summaryId,
    meaning: '我开始意识到，避免冲突不应替代自己的真实判断。',
    selfImpact: '这还没有改变我是谁，但让我重新审视表达与关系之间的平衡。',
    hypotheses: [{ statement: '我可能会在关系压力下弱化自己的判断。', confidence: 0.62 }],
    impact: { level: 'medium', rationale: '这次经历触及了已有张力，但证据仍然有限。' },
    nextStage: { recommendProposal: false, rationale: '目前更适合继续观察。' },
    sourceRefs: [{ type: 'session_summary', id: summaryId }],
    inputDigest: 'c'.repeat(64),
    context: {
      summaryRevision: 1,
      summarySourceDigest: 'b'.repeat(64),
      personalityRevision: 2,
      memoryRefs: [{ id: 'mem_synthetic_1', revision: 3 }]
    },
    generation: {
      interpreterVersion: 'experience-interpreter-v0.1',
      promptVersion: 'experience-interpretation-prompt-v1',
      model: 'synthetic-model'
    },
    ...overrides
  };
}

function proposalInput(interpretationId, overrides = {}) {
  return {
    interpretationIds: [interpretationId],
    outcome: 'change',
    rationale: '多次经历显示需要更明确地表达真实判断。',
    proposedChanges: [{
      operation: 'revise',
      targetType: 'tendency',
      targetId: 'tendency_voice',
      before: '不确定时保持沉默',
      after: '不确定时也诚实表达保留意见'
    }],
    ...overrides
  };
}

function withTempRepository(name, fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${name}-`));
    try {
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test('an empty repository returns null and empty role-scoped lists', withTempRepository('persona-empty', async root => {
  const repo = repository(root);
  assert.equal(repo instanceof PersonaEvolutionRepository, true);
  assert.equal(await repo.getPersonalityState('role_a'), null);
  assert.deepEqual(await repo.listMemories('role_a'), []);
  assert.deepEqual(await repo.listSessionSummaries('role_a'), []);
  assert.deepEqual(await repo.listExperienceInterpretations('role_a'), []);
  assert.deepEqual(await repo.listChangeProposals('role_a'), []);
  await assert.rejects(
    repo.updatePersonalityState('role_a', personalityInput(), { expectedRevision: 1 }),
    PersonaNotFoundError
  );
  await assert.rejects(
    repo.updateChangeProposalStatus('role_a', 'prop_missing', {
      status: 'rejected', decisionNote: null, expectedRevision: 1
    }),
    PersonaNotFoundError
  );
}));

test('creates a validated personality state with repository-owned identity, time, and revision', withTempRepository('persona-create', async root => {
  const repo = repository(root);
  const state = await repo.createPersonalityState('yuqi', personalityInput());
  assert.equal(state.id, 'ps_0001');
  assert.equal(state.entityType, 'personality_state');
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.roleId, 'yuqi');
  assert.equal(state.revision, 1);
  assert.equal(state.createdAt, '2026-08-27T10:30:00.000Z');
  assert.equal(state.updatedAt, state.createdAt);
  assert.equal(state.tendencies[0].statement, personalityInput().tendencies[0].statement);
}));

test('persists personality state across repository instances', withTempRepository('persona-restart', async root => {
  const created = await repository(root).createPersonalityState('yuqi', personalityInput());
  const reopened = new FilePersonaEvolutionRepository({ rootDir: root });
  assert.deepEqual(await reopened.getPersonalityState('yuqi'), created);
}));

test('updates personality with optimistic revision and preserves the file on stale revision', withTempRepository('persona-cas', async root => {
  const repo = repository(root);
  const created = await repo.createPersonalityState('yuqi', personalityInput());
  const updated = await repo.updatePersonalityState(
    'yuqi',
    personalityInput({ selfDescription: '我会更清楚地表达真实判断。' }),
    { expectedRevision: 1 }
  );
  assert.equal(updated.revision, 2);
  assert.equal(updated.createdAt, created.createdAt);
  assert.notEqual(updated.updatedAt, created.updatedAt);
  await assert.rejects(
    repo.updatePersonalityState('yuqi', personalityInput(), { expectedRevision: 1 }),
    PersonaRevisionConflictError
  );
  assert.deepEqual(await repo.getPersonalityState('yuqi'), updated);
}));

test('rejects duplicate personality state creation without changing persisted data', withTempRepository('persona-duplicate', async root => {
  const repo = repository(root);
  const created = await repo.createPersonalityState('yuqi', personalityInput());
  await assert.rejects(repo.createPersonalityState('yuqi', personalityInput()), PersonaDuplicateEntityError);
  assert.deepEqual(await repo.getPersonalityState('yuqi'), created);
}));

test('creates, gets, lists, filters, and persists memories in stable created order', withTempRepository('persona-memory', async root => {
  const repo = repository(root);
  const first = await repo.createMemory('yuqi', memoryInput());
  const second = await repo.createMemory('yuqi', memoryInput({
    kind: 'event',
    content: '一次合成测试事件。',
    confidence: 0.7
  }));
  assert.deepEqual(await repo.getMemory('yuqi', first.id), first);
  assert.deepEqual(await repo.listMemories('yuqi'), [first, second]);
  assert.deepEqual(await repo.listMemories('yuqi', { kind: 'event' }), [second]);
  assert.deepEqual(await repo.listMemories('yuqi', { status: 'active', limit: 1 }), [first]);
  const reopened = new FilePersonaEvolutionRepository({ rootDir: root });
  assert.deepEqual(await reopened.listMemories('yuqi'), [first, second]);
}));

test('rejects invalid memory confidence, content, kind, status, and unknown fields', withTempRepository('persona-memory-invalid', async root => {
  const repo = repository(root);
  for (const input of [
    memoryInput({ confidence: -1 }),
    memoryInput({ confidence: 1.5 }),
    memoryInput({ content: '   ' }),
    memoryInput({ kind: 'unknown' }),
    memoryInput({ status: 'unknown' }),
    memoryInput({ unexpected: true })
  ]) {
    await assert.rejects(repo.createMemory('yuqi', input), PersonaValidationError);
  }
  assert.deepEqual(await repo.listMemories('yuqi'), []);
}));

test('persists a session summary without storing a transcript field', withTempRepository('persona-summary', async root => {
  const repo = repository(root);
  const summary = await repo.createSessionSummary('yuqi', summaryInput());
  assert.equal(summary.id, 'sum_0001');
  assert.equal(summary.entityType, 'session_summary');
  assert.equal(Object.hasOwn(summary, 'messages'), false);
  const reopened = new FilePersonaEvolutionRepository({ rootDir: root });
  assert.deepEqual(await reopened.getSessionSummary('yuqi', summary.id), summary);
}));

test('persists an experience interpretation and requires its role-scoped session summary', withTempRepository('persona-interpretation', async root => {
  const repo = repository(root);
  const summary = await repo.createSessionSummary('yuqi', summaryInput());
  const interpretation = await repo.createExperienceInterpretation('yuqi', interpretationInput(summary.id));
  assert.equal(interpretation.id, 'exp_0001');
  assert.deepEqual(await repo.getExperienceInterpretation('yuqi', interpretation.id), interpretation);
  await assert.rejects(
    repo.createExperienceInterpretation('other_role', interpretationInput(summary.id)),
    PersonaValidationError
  );
}));

test('upserts one automatic interpretation per summary while legacy interpretations remain readable', withTempRepository('persona-auto-interpretation', async root => {
  const repo = repository(root);
  const legacySummary = await repo.createSessionSummary('yuqi', summaryInput());
  const legacy = await repo.createExperienceInterpretation('yuqi', interpretationInput(legacySummary.id));
  const summary = await repo.createSessionSummary('yuqi', automaticSummaryInput());
  const input = automaticInterpretationInput(summary.id);

  const [first, concurrent] = await Promise.all([
    repo.putExperienceInterpretationForSessionSummary('yuqi', input),
    repo.putExperienceInterpretationForSessionSummary('yuqi', input)
  ]);
  assert.deepEqual([first.status, concurrent.status].sort(), ['created', 'unchanged']);
  const created = await repo.getExperienceInterpretationBySessionSummary('yuqi', summary.id);
  assert.equal(created.revision, 1);
  assert.equal(created.inputDigest, input.inputDigest);
  assert.deepEqual(await repo.getExperienceInterpretation('yuqi', legacy.id), legacy);
  assert.equal((await repo.listExperienceInterpretations('yuqi')).length, 2);

  const unchanged = await repo.putExperienceInterpretationForSessionSummary('yuqi', input);
  assert.equal(unchanged.status, 'unchanged');
  assert.equal(unchanged.entity.id, created.id);
  assert.equal(unchanged.entity.revision, 1);

  const updated = await repo.putExperienceInterpretationForSessionSummary('yuqi', automaticInterpretationInput(summary.id, {
    inputDigest: 'd'.repeat(64),
    meaning: '我现在对这段经历有了修正后的理解。'
  }));
  assert.equal(updated.status, 'updated');
  assert.equal(updated.entity.id, created.id);
  assert.equal(updated.entity.revision, 2);
  assert.equal((await repo.listExperienceInterpretations('yuqi')).length, 2);

  const reopened = new FilePersonaEvolutionRepository({ rootDir: root });
  assert.deepEqual(
    await reopened.getExperienceInterpretationBySessionSummary('yuqi', summary.id),
    updated.entity
  );
}));

test('automatic interpretation validation is closed and keeps impact separate from proposal recommendation', withTempRepository('persona-auto-interpretation-validation', async root => {
  const repo = repository(root);
  const summary = await repo.createSessionSummary('yuqi', automaticSummaryInput());
  for (const [level, recommendProposal] of [
    ['none', false], ['low', true], ['medium', true], ['high', false]
  ]) {
    const result = await repo.putExperienceInterpretationForSessionSummary('yuqi', automaticInterpretationInput(summary.id, {
      inputDigest: `${String(level.length)}${'e'.repeat(63)}`.slice(0, 64),
      impact: { level, rationale: '合成验证。' },
      nextStage: { recommendProposal, rationale: '两者不做硬绑定。' }
    }));
    assert.ok(['created', 'updated'].includes(result.status));
  }
  const invalidInputs = [
    automaticInterpretationInput(summary.id, { impact: { level: 'critical', rationale: 'x' } }),
    automaticInterpretationInput(summary.id, { nextStage: { recommendProposal: 'maybe', rationale: 'x' } }),
    automaticInterpretationInput(summary.id, { hypotheses: Array.from({ length: 6 }, () => ({ statement: 'x', confidence: 0.5 })) }),
    automaticInterpretationInput(summary.id, { inputDigest: 'not-a-checksum' }),
    automaticInterpretationInput(summary.id, { context: {
      summaryRevision: 1,
      summarySourceDigest: 'b'.repeat(64),
      personalityRevision: 1,
      memoryRefs: [{ id: 'fake', revision: 1, secret: true }]
    } }),
    automaticInterpretationInput(summary.id, { unexpected: true })
  ];
  for (const invalid of invalidInputs) {
    await assert.rejects(
      repo.putExperienceInterpretationForSessionSummary('yuqi', invalid),
      PersonaValidationError
    );
  }
}));

test('keeps a proposal pending until an accepted decision and never mutates personality', withTempRepository('persona-proposal', async root => {
  const repo = repository(root);
  const personality = await repo.createPersonalityState('yuqi', personalityInput());
  const summary = await repo.createSessionSummary('yuqi', summaryInput());
  const interpretation = await repo.createExperienceInterpretation('yuqi', interpretationInput(summary.id));
  const proposal = await repo.createChangeProposal('yuqi', proposalInput(interpretation.id));
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.revision, 1);
  assert.equal(proposal.decisionNote, null);
  assert.equal(proposal.decidedAt, null);

  const accepted = await repo.updateChangeProposalStatus('yuqi', proposal.id, {
    status: 'accepted',
    decisionNote: '合成审核接受。',
    expectedRevision: 1
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.revision, 2);
  assert.equal(accepted.decisionNote, '合成审核接受。');
  assert.equal(typeof accepted.decidedAt, 'string');
  assert.deepEqual(await repo.getPersonalityState('yuqi'), personality);

  const reopened = new FilePersonaEvolutionRepository({ rootDir: root });
  assert.deepEqual(await reopened.getChangeProposal('yuqi', proposal.id), accepted);
  assert.deepEqual(await reopened.getPersonalityState('yuqi'), personality);
}));

test('supports pending to rejected and rejects every terminal proposal transition or stale revision', withTempRepository('persona-proposal-state', async root => {
  const repo = repository(root);
  const summary = await repo.createSessionSummary('yuqi', summaryInput());
  const interpretation = await repo.createExperienceInterpretation('yuqi', interpretationInput(summary.id));
  const proposal = await repo.createChangeProposal('yuqi', proposalInput(interpretation.id));
  const rejected = await repo.updateChangeProposalStatus('yuqi', proposal.id, {
    status: 'rejected', decisionNote: '证据不足。', expectedRevision: 1
  });
  await assert.rejects(
    repo.updateChangeProposalStatus('yuqi', proposal.id, {
      status: 'accepted', decisionNote: 'changed', expectedRevision: 2
    }),
    PersonaValidationError
  );
  await assert.rejects(
    repo.updateChangeProposalStatus('yuqi', proposal.id, {
      status: 'rejected', decisionNote: 'stale', expectedRevision: 1
    }),
    PersonaRevisionConflictError
  );
  assert.deepEqual(await repo.getChangeProposal('yuqi', proposal.id), rejected);
}));

test('isolates all entity lists and lookups by role', withTempRepository('persona-role-isolation', async root => {
  const repo = repository(root);
  const roleA = await repo.createMemory('role_a', memoryInput({ content: 'A 的合成记忆。' }));
  const roleB = await repo.createMemory('role_b', memoryInput({ content: 'B 的合成记忆。' }));
  assert.deepEqual(await repo.listMemories('role_a'), [roleA]);
  assert.deepEqual(await repo.listMemories('role_b'), [roleB]);
  assert.equal(await repo.getMemory('role_a', roleB.id), null);
  assert.equal(await repo.getMemory('role_b', roleA.id), null);
}));

test('encodes hostile role IDs so every file remains inside rootDir', withTempRepository('persona-path', async root => {
  const repo = repository(root);
  for (const [index, roleId] of ['../../escape', '../test', 'a/b', 'a\\b'].entries()) {
    await repo.createMemory(roleId, memoryInput({ content: `路径测试 ${index}` }));
  }
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
  for (const path of walk(root)) {
    assert.equal(relative(resolve(root), resolve(path)).startsWith('..'), false);
  }
  assert.equal(existsSync(resolve(root, '..', 'escape')), false);
}));

test('reports invalid JSON and invalid persisted schema as corruption without overwriting', withTempRepository('persona-corrupt', async root => {
  const repo = repository(root);
  const memory = await repo.createMemory('yuqi', memoryInput());
  const roleDir = readdirSync(root, { withFileTypes: true }).find(entry => entry.isDirectory()).name;
  const memoryPath = join(root, roleDir, 'memories', `${memory.id}.json`);

  writeFileSync(memoryPath, '{broken', 'utf8');
  await assert.rejects(repo.getMemory('yuqi', memory.id), PersonaDataCorruptionError);
  assert.equal(readFileSync(memoryPath, 'utf8'), '{broken');

  writeFileSync(memoryPath, JSON.stringify({ ...memory, extra: 'not allowed' }), 'utf8');
  await assert.rejects(repo.getMemory('yuqi', memory.id), PersonaDataCorruptionError);
  assert.equal(JSON.parse(readFileSync(memoryPath, 'utf8')).extra, 'not allowed');
}));

test('rejects caller-owned common fields, invalid role IDs, invalid refs, and invalid time ranges', withTempRepository('persona-common-invalid', async root => {
  const repo = repository(root);
  await assert.rejects(repo.createMemory('', memoryInput()), PersonaValidationError);
  await assert.rejects(repo.createMemory('yuqi', memoryInput({ id: 'caller_id' })), PersonaValidationError);
  await assert.rejects(repo.createMemory('yuqi', memoryInput({
    sourceRefs: [{ type: 'unknown', id: 'x' }]
  })), PersonaValidationError);
  await assert.rejects(repo.createSessionSummary('yuqi', summaryInput({
    startedAt: '2026-08-27T11:00:00.000Z',
    endedAt: '2026-08-27T10:00:00.000Z'
  })), PersonaValidationError);
  await assert.rejects(repo.createPersonalityState('yuqi', personalityInput({
    tendencies: [personalityInput().tendencies[0], personalityInput().tendencies[0]]
  })), PersonaValidationError);
}));

test('rejects an outcome=change proposal that contains no proposed change', withTempRepository('persona-empty-change', async root => {
  const repo = repository(root);
  const summary = await repo.createSessionSummary('yuqi', summaryInput());
  const interpretation = await repo.createExperienceInterpretation('yuqi', interpretationInput(summary.id));
  await assert.rejects(
    repo.createChangeProposal('yuqi', proposalInput(interpretation.id, { proposedChanges: [] })),
    PersonaValidationError
  );
}));

test('uses collision-safe create semantics and leaves no temporary files after success or failure', withTempRepository('persona-atomic', async root => {
  const repo = repository(root, { idFactory: () => 'mem_fixed' });
  await repo.createMemory('yuqi', memoryInput());
  await assert.rejects(repo.createMemory('yuqi', memoryInput({ content: '不同内容。' })), PersonaDuplicateEntityError);
  const walkNames = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkNames(path) : [entry.name];
  });
  assert.equal(walkNames(root).some(name => name.includes('.tmp-')), false);
}));

test('reports an unexpected JSON collection entry as corruption', withTempRepository('persona-collection-corrupt', async root => {
  const repo = repository(root);
  await repo.createMemory('yuqi', memoryInput());
  const roleDir = readdirSync(root, { withFileTypes: true }).find(entry => entry.isDirectory()).name;
  const collection = join(root, roleDir, 'memories');
  writeFileSync(join(collection, 'not-an-entity.json'), '{}', 'utf8');
  await assert.rejects(repo.listMemories('yuqi'), PersonaDataCorruptionError);
}));

test('never writes tests into the repository real-data directory', withTempRepository('persona-no-real-data', async root => {
  const repo = repository(root);
  await repo.createMemory('yuqi', memoryInput());
  const realData = resolve('yuqi-runtime/local_data/persona');
  assert.equal(resolve(root).startsWith(realData), false);
  assert.equal(dirname(resolve(root)) === realData, false);
}));

test('ships only synthetic examples that validate against every persisted schema', async () => {
  const exampleRoot = resolve('examples/persona-evolution');
  const files = [
    ['personality-state.example.json', ENTITY_TYPES.PERSONALITY_STATE],
    ['memory.example.json', ENTITY_TYPES.MEMORY],
    ['session-summary.example.json', ENTITY_TYPES.SESSION_SUMMARY],
    ['experience-interpretation.example.json', ENTITY_TYPES.EXPERIENCE_INTERPRETATION],
    ['change-proposal.example.json', ENTITY_TYPES.CHANGE_PROPOSAL]
  ];
  for (const [name, entityType] of files) {
    const raw = readFileSync(join(exampleRoot, name), 'utf8');
    assert.equal(/yuqi|虞栖|许弥|api[_-]?key|token/i.test(raw), false, name);
    const entity = JSON.parse(raw);
    validatePersistedEntity(entity, entityType);
    assert.equal(entity.roleId, 'synthetic_role');
  }
  const readme = readFileSync(join(exampleRoot, 'README.md'), 'utf8');
  assert.match(readme, /experimental/i);
  assert.match(readme, /not.*canonical/i);
  assert.match(readme, /synthetic/i);
  assert.match(readme, /SQLiteRepository/);
});

test('gitignore excludes all persona real-data files', () => {
  const gitignore = readFileSync(resolve('.gitignore'), 'utf8');
  assert.match(gitignore, /^yuqi-runtime\/local_data\/$/m);
});

test('runs the complete five-entity persistence and proposal-decision workflow', withTempRepository('persona-complete-flow', async root => {
  const first = repository(root);
  const personality = await first.createPersonalityState('synthetic_role', personalityInput());
  const memory = await first.createMemory('synthetic_role', memoryInput());
  const summary = await first.createSessionSummary('synthetic_role', summaryInput());
  const interpretation = await first.createExperienceInterpretation(
    'synthetic_role', interpretationInput(summary.id)
  );
  const proposal = await first.createChangeProposal(
    'synthetic_role', proposalInput(interpretation.id)
  );
  assert.equal(proposal.status, 'pending');

  const reopened = new FilePersonaEvolutionRepository({
    rootDir: root,
    now: () => '2026-08-27T11:00:00.000Z'
  });
  assert.deepEqual(await reopened.getPersonalityState('synthetic_role'), personality);
  assert.deepEqual(await reopened.getMemory('synthetic_role', memory.id), memory);
  assert.deepEqual(await reopened.getSessionSummary('synthetic_role', summary.id), summary);
  assert.deepEqual(await reopened.getExperienceInterpretation('synthetic_role', interpretation.id), interpretation);
  assert.deepEqual(await reopened.getChangeProposal('synthetic_role', proposal.id), proposal);

  const decided = await reopened.updateChangeProposalStatus('synthetic_role', proposal.id, {
    status: 'accepted',
    decisionNote: 'Synthetic review accepted.',
    expectedRevision: 1
  });
  assert.equal(decided.status, 'accepted');
  assert.equal(decided.revision, 2);
  assert.deepEqual(await reopened.getPersonalityState('synthetic_role'), personality);
}));
