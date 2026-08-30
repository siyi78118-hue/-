import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { FilePersonaEvolutionRepository } from '../src/persona-evolution/file-repository.mjs';
import {
  CodexExperienceInterpretationGenerator,
  validateExperienceInterpretationOutput
} from '../src/persona-evolution/experience-interpretation-generator.mjs';
import { ExperienceInterpreter } from '../src/persona-evolution/experience-interpreter.mjs';
import { ExperienceInterpretationWorker } from '../src/persona-evolution/experience-interpretation-worker.mjs';
import { ExperienceMemoryRetriever } from '../src/persona-evolution/experience-memory-retriever.mjs';

function clock() {
  let current = Date.parse('2026-08-28T00:00:00.000Z');
  return () => new Date(current++).toISOString();
}

function ids() {
  const counts = new Map();
  return prefix => {
    const next = (counts.get(prefix) || 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${String(next).padStart(4, '0')}`;
  };
}

function withRepository(name, fn) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), `${name}-`));
    try {
      const repository = new FilePersonaEvolutionRepository({ rootDir: root, now: clock(), idFactory: ids() });
      await fn(repository, root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function summaryInput(overrides = {}) {
  return {
    sourceSessionId: `ses_${'a'.repeat(64)}`,
    startedAt: '2026-08-27T09:00:00.000Z',
    endedAt: '2026-08-27T10:00:00.000Z',
    sourceMessageIds: ['msg_1', 'msg_2'],
    sourceDigest: 'b'.repeat(64),
    keyEvents: ['用户指出我在关系压力下回避直接冲突。'],
    emotionalSummary: { user: '认真', al: '犹豫', interaction: '平静地讨论分歧' },
    importantDecisions: ['继续观察我是否会隐藏自己的意见。'],
    generation: { summarizerVersion: 'v', promptVersion: 'p', model: 'summary-model' },
    ...overrides
  };
}

function personalityInput(overrides = {}) {
  return {
    selfDescription: '我正在学习在关心关系时保留自己的判断。',
    tendencies: [{
      id: 'tendency_voice', statement: '我会谨慎表达。', confidence: 0.7,
      status: 'tentative', sourceRefs: []
    }],
    tensions: [{
      id: 'tension_voice', left: '表达判断', right: '维护关系',
      description: '两种倾向同时存在。', sourceRefs: []
    }],
    ...overrides
  };
}

function memoryInput(content, overrides = {}) {
  return {
    kind: 'event', content, confidence: 0.6, status: 'active', sourceRefs: [],
    supersedesId: null, supersededById: null, ...overrides
  };
}

function output(overrides = {}) {
  return {
    meaning: '我开始意识到，避免冲突不应替代自己的真实判断。',
    selfImpact: '这还没有改变我是谁，但让我重新审视表达与关系之间的平衡。',
    hypotheses: [{ statement: '我可能会在关系压力下弱化自己的判断。', confidence: 0.62 }],
    impact: { level: 'medium', rationale: '这触及已有张力，但证据仍然有限。' },
    nextStage: { recommendProposal: false, rationale: '目前更适合继续观察。' },
    memoryRefsUsed: [],
    ...overrides
  };
}

test('generator output is closed while impact and proposal recommendation remain independent', () => {
  for (const candidate of [
    output({ impact: { level: 'none', rationale: '普通经历。' } }),
    output({ impact: { level: 'high', rationale: '重要但方向未定。' }, nextStage: { recommendProposal: false, rationale: '暂不提案。' } }),
    output({ impact: { level: 'medium', rationale: '重复模式。' }, nextStage: { recommendProposal: true, rationale: '值得进一步评估。' } })
  ]) assert.deepEqual(validateExperienceInterpretationOutput(candidate, { allowedMemoryIds: [] }), candidate);

  for (const invalid of [
    output({ impact: { level: 'critical', rationale: 'x' } }),
    output({ nextStage: { recommendProposal: 'maybe', rationale: 'x' } }),
    output({ hypotheses: Array.from({ length: 6 }, () => ({ statement: 'x', confidence: 0.5 })) }),
    output({ hypotheses: [{ statement: 'x', confidence: 1.1 }] }),
    output({ memoryRefsUsed: ['mem_fake'] }),
    output({ unexpected: true })
  ]) assert.throws(
    () => validateExperienceInterpretationOutput(invalid, { allowedMemoryIds: [] }),
    /experience interpretation/i
  );
});

test('Codex adapter uses one isolated strict-JSON turn', async () => {
  const calls = [];
  const expected = output();
  const generator = new CodexExperienceInterpretationGenerator({
    codexClient: { async runIsolatedTurn(payload, options) { calls.push({ payload, options }); return { text: JSON.stringify(expected) }; } },
    model: 'synthetic-model', effort: 'medium', turnTimeoutMs: 1234
  });
  assert.deepEqual(await generator.generate({ sessionSummary: {}, personalityState: null, relevantMemories: [] }), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.model, 'synthetic-model');
  assert.equal(calls[0].options.turnTimeoutMs, 1234);
  assert.equal(typeof calls[0].options.outputSchema, 'object');
  assert.equal(
    Object.hasOwn(calls[0].options.outputSchema.properties.memoryRefsUsed, 'uniqueItems'),
    false,
    'Codex structured-output schemas do not accept uniqueItems; runtime validation owns uniqueness'
  );
});

test('interpreter persists one grounded interpretation without mutating any source or proposal', withRepository('experience-basic', async repository => {
  const personality = await repository.createPersonalityState('role_a', personalityInput());
  const usedMemory = await repository.createMemory('role_a', memoryInput('我曾经在关系压力下回避直接冲突。'));
  await repository.createMemory('role_a', memoryInput('用户喜欢芒果味冰淇淋。', { kind: 'preference' }));
  await repository.createMemory('role_a', memoryInput('回避直接冲突。', { status: 'redacted' }));
  const sessionSummary = await repository.createSessionSummary('role_a', summaryInput());
  const before = {
    personality: await repository.getPersonalityState('role_a'),
    memories: await repository.listMemories('role_a'),
    summary: await repository.getSessionSummary('role_a', sessionSummary.id),
    proposals: await repository.listChangeProposals('role_a')
  };
  const generatorInputs = [];
  const generator = {
    model: 'fake-model',
    async generate(context) {
      generatorInputs.push(structuredClone(context));
      return output({ memoryRefsUsed: [usedMemory.id] });
    }
  };
  const interpreter = new ExperienceInterpreter({
    repository, retriever: new ExperienceMemoryRetriever(), generator, memoryLimit: 8
  });
  const result = await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id });
  assert.equal(result.status, 'created');
  assert.equal(result.impactLevel, 'medium');
  assert.equal(result.recommendProposal, false);
  const stored = await repository.getExperienceInterpretation('role_a', result.interpretationId);
  assert.deepEqual(stored.sourceRefs, [
    { type: 'session_summary', id: sessionSummary.id },
    { type: 'memory', id: usedMemory.id }
  ]);
  assert.equal(stored.context.personalityRevision, personality.revision);
  assert.equal(stored.context.summaryRevision, sessionSummary.revision);
  assert.equal(stored.context.summarySourceDigest, sessionSummary.sourceDigest);
  assert.deepEqual(stored.context.memoryRefs, [{ id: usedMemory.id, revision: usedMemory.revision }]);
  assert.equal(generatorInputs[0].relevantMemories.length, 1);
  assert.deepEqual(await repository.getPersonalityState('role_a'), before.personality);
  assert.deepEqual(await repository.listMemories('role_a'), before.memories);
  assert.deepEqual(await repository.getSessionSummary('role_a', sessionSummary.id), before.summary);
  assert.deepEqual(await repository.listChangeProposals('role_a'), before.proposals);
}));

test('interpreter accepts null personality and zero relevant memories', withRepository('experience-empty-context', async repository => {
  const sessionSummary = await repository.createSessionSummary('role_a', summaryInput());
  let context;
  const interpreter = new ExperienceInterpreter({
    repository,
    retriever: new ExperienceMemoryRetriever(),
    generator: { model: 'fake', async generate(value) { context = value; return output({ impact: { level: 'none', rationale: '普通交流。' }, hypotheses: [] }); } }
  });
  const result = await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id });
  assert.equal(result.impactLevel, 'none');
  assert.equal(context.personalityState, null);
  assert.deepEqual(context.relevantMemories, []);
}));

test('same input and concurrent triggers call the generator once; later personality change does not rewrite history', withRepository('experience-idempotent', async repository => {
  const personality = await repository.createPersonalityState('role_a', personalityInput());
  const sessionSummary = await repository.createSessionSummary('role_a', summaryInput());
  let calls = 0;
  const interpreter = new ExperienceInterpreter({
    repository,
    retriever: new ExperienceMemoryRetriever(),
    generator: { model: 'fake', async generate() { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); return output(); } }
  });
  const [left, right] = await Promise.all([
    interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id }),
    interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id })
  ]);
  assert.equal(calls, 1);
  assert.equal(left.interpretationId, right.interpretationId);
  assert.equal((await repository.listExperienceInterpretations('role_a')).length, 1);
  assert.equal((await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id })).status, 'unchanged');
  assert.equal(calls, 1);

  await repository.updatePersonalityState('role_a', personalityInput({ selfDescription: '后来的人格状态。' }), {
    expectedRevision: personality.revision
  });
  assert.equal((await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id })).status, 'unchanged');
  assert.equal(calls, 1);
}));

test('a revised summary regenerates the same interpretation entity and increments revision', withRepository('experience-summary-revision', async repository => {
  const sessionSummary = await repository.createSessionSummary('role_a', summaryInput());
  let calls = 0;
  const interpreter = new ExperienceInterpreter({
    repository, retriever: new ExperienceMemoryRetriever(),
    generator: { model: 'fake', async generate() { calls += 1; return output({ meaning: `第 ${calls} 次理解。` }); } }
  });
  const first = await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id });
  await repository.putSessionSummaryForSession('role_a', summaryInput({
    sourceDigest: 'c'.repeat(64), keyEvents: ['修正后的关键事件。']
  }));
  const second = await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id });
  assert.equal(second.status, 'updated');
  assert.equal(second.interpretationId, first.interpretationId);
  assert.equal(second.revision, 2);
  assert.equal(calls, 2);
}));

test('invalid memory refs or generator failure persist no partial interpretation and remain retryable', withRepository('experience-failure', async repository => {
  const sessionSummary = await repository.createSessionSummary('role_a', summaryInput());
  let mode = 'throw';
  const interpreter = new ExperienceInterpreter({
    repository, retriever: new ExperienceMemoryRetriever(),
    generator: {
      model: 'fake',
      async generate() {
        if (mode === 'throw') throw new Error('synthetic generator failure');
        if (mode === 'fake-ref') return output({ memoryRefsUsed: ['mem_not_provided'] });
        return output();
      }
    }
  });
  await assert.rejects(
    interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id }),
    /synthetic generator failure/
  );
  assert.deepEqual(await repository.listExperienceInterpretations('role_a'), []);
  mode = 'fake-ref';
  await assert.rejects(
    interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id }),
    /memory/i
  );
  assert.deepEqual(await repository.listExperienceInterpretations('role_a'), []);
  mode = 'valid';
  assert.equal((await interpreter.interpretSession({ roleId: 'role_a', sessionSummaryId: sessionSummary.id })).status, 'created');
}));

test('role-scoped summary identity cannot cross into another role', withRepository('experience-role-isolation', async repository => {
  const summaryA = await repository.createSessionSummary('role_a', summaryInput());
  const interpreter = new ExperienceInterpreter({
    repository, retriever: new ExperienceMemoryRetriever(),
    generator: { model: 'fake', async generate() { return output(); } }
  });
  await assert.rejects(
    interpreter.interpretSession({ roleId: 'role_b', sessionSummaryId: summaryA.id }),
    /summary/i
  );
  assert.deepEqual(await repository.listExperienceInterpretations('role_a'), []);
  assert.deepEqual(await repository.listExperienceInterpretations('role_b'), []);
}));

test('restart recovery fills missing interpretations, isolates failures, and skips existing results', withRepository('experience-recovery', async repository => {
  const first = await repository.createSessionSummary('role_a', summaryInput());
  const second = await repository.createSessionSummary('role_a', summaryInput({
    sourceSessionId: `ses_${'d'.repeat(64)}`,
    sourceDigest: 'e'.repeat(64),
    sourceMessageIds: ['msg_3']
  }));
  let calls = 0;
  let failFirst = true;
  const interpreter = new ExperienceInterpreter({
    repository,
    retriever: new ExperienceMemoryRetriever(),
    generator: {
      model: 'fake',
      async generate(context) {
        calls += 1;
        if (failFirst) {
          failFirst = false;
          throw new Error('synthetic first recovery failure');
        }
        return output({ meaning: `解释 ${context.sessionSummary.id}` });
      }
    }
  });
  const worker = new ExperienceInterpretationWorker({
    repository, interpreter, roleIds: ['role_a'], sweepIntervalMs: 60_000
  });
  assert.deepEqual(await worker.recover(), { created: 1, updated: 0, unchanged: 0, failed: 1 });
  assert.equal(await repository.getExperienceInterpretationBySessionSummary('role_a', first.id), null);
  assert.ok(await repository.getExperienceInterpretationBySessionSummary('role_a', second.id));
  assert.deepEqual(await worker.recover(), { created: 1, updated: 0, unchanged: 1, failed: 0 });
  assert.equal(calls, 3);
  assert.equal((await repository.listExperienceInterpretations('role_a')).length, 2);
  assert.equal(worker.observeSummary({ roleId: 'role_a', summaryId: first.id }), undefined);
  await worker.idle();
  assert.equal(calls, 3);
  worker.stop();
}));

test('production composition shares one persona repository and keeps Stage 3 disabled by default', () => {
  const config = JSON.parse(readFileSync('yuqi-runtime/config.example.json', 'utf8'));
  assert.deepEqual(config.experienceInterpreter, {
    enabled: false,
    memoryLimit: 8,
    interpreterVersion: 'experience-interpreter-v0.1',
    promptVersion: 'experience-interpretation-prompt-v1',
    model: 'gpt-5.6-sol',
    effort: 'medium',
    turnTimeoutMs: 120000,
    sweepIntervalMs: 60000
  });
  const main = readFileSync('yuqi-runtime/src/main.mjs', 'utf8');
  assert.match(main, /const personaRepository = new FilePersonaEvolutionRepository/);
  assert.match(main, /repository: personaRepository/g);
  assert.match(main, /onSummaryFinalized: event => experienceInterpretationWorker\?\.observeSummary\(event\)/);
  assert.match(main, /experienceInterpretationWorker\?\.start\(\)/);
  assert.match(main, /experienceInterpretationWorker\?\.stop\(\)/);
  assert.match(main, /await experienceInterpretationWorker\?\.idle\(\)/);
});
