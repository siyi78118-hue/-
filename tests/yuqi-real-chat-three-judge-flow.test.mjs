import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { importCompletedHumanReview } from '../scripts/import-yuqi-real-chat-human-review.mjs';
import {
  REAL_CHAT_JUDGE_OUTPUT_SCHEMA,
  runBlindJudges,
} from '../scripts/run-yuqi-real-chat-blind-judges.mjs';
import { finalizeRealChatThreeJudge } from '../scripts/finalize-yuqi-real-chat-three-judge.mjs';

function section(index, filled = false) {
  const value = index % 3 === 0 ? '差不多' : index % 2 ? 'A' : 'B';
  const answer = filled ? `__${value}__` : '____';
  return [
    `## 第 ${index} 题`, '', '### 聊天上下文', '', `- 用户：消息${index}`, '',
    '### 回答 A', '', `A${index}`, '', '### 回答 B', '', `B${index}`, '',
    `1. 总体更喜欢哪一个：${answer}（A / B / 差不多）`,
    `2. 哪个更像真人在微信里会回的话：${answer}（A / B / 差不多）`,
    `3. 哪个更懂用户真正想表达的意思：${answer}（A / B / 差不多）`,
    `4. 哪个更像虞栖本人，而不是通用温柔 AI：${answer}（A / B / 差不多）`,
    `5. 哪个更让人想继续聊下去：${answer}（A / B / 差不多）`,
    '6. 明显问题。', '',
    `- A：${filled ? `__A评语${index}__` : '____'}`,
    `- B：${filled ? `__B评语${index}__` : '____'}`,
  ].join('\n');
}

function markdown(filled = false) {
  return ['# 虞栖真实聊天盲评卷', '', '请填写。', '',
    ...Array.from({ length: 12 }, (_, index) => section(index + 1, filled)), ''].join('\n');
}

function judgeOutput(questions, choice) {
  return {
    version: 1,
    items: questions.map(question => ({
      ...question,
      overall: choice,
      humanLike: choice,
      understandsUser: choice,
      characterLike: choice,
      continueChat: choice,
      commentA: 'A简评',
      commentB: 'B简评',
      questionConcern: false,
    })),
  };
}

function makePackage() {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-three-judge-'));
  const questions = Array.from({ length: 12 }, (_, index) => ({
    question: index + 1,
    candidateId: `candidate_${index + 1}`,
  }));
  const template = {
    version: 1,
    completed: false,
    items: questions.map(item => ({
      ...item,
      overall: '', humanLike: '', understandsUser: '', characterLike: '', continueChat: '',
      problemsA: [], problemsB: [], note: '',
    })),
  };
  const runSummary = {
    version: 1,
    runId: 'bundle_fixture',
    scoredCount: 12,
    humanReviewChecksum: 'a'.repeat(64),
    sealedMappingChecksum: 'b'.repeat(64),
  };
  const config = {
    version: 1,
    stableRelease: { modelProfile: { cognitionFast: 'stable-fast' } },
    candidateRelease: { modelProfile: { cognitionFast: 'candidate-fast' } },
    lanes: {
      evaluator_primary: {
        version: 1, lane: 'evaluator_primary', command: 'codex', args: ['app-server'], cwd: root,
        env: {}, clientInfo: { name: 'test', title: 'test', version: '1' },
        requestTimeoutMs: 30_000, turnTimeoutMs: 600_000, maxRoleTurns: 1,
        sessionStorePath: 'private-primary.sqlite', sessionNamespace: 'primary',
        modelProfile: 'gpt-5.6-sol/medium', approvalPolicy: 'never', sandbox: 'read-only',
        schema: { version: 1, kind: 'blind_evaluation' },
      },
      evaluator_secondary: {
        version: 1, lane: 'evaluator_secondary', command: 'codex', args: ['app-server'], cwd: root,
        env: {}, clientInfo: { name: 'test', title: 'test', version: '1' },
        requestTimeoutMs: 30_000, turnTimeoutMs: 600_000, maxRoleTurns: 1,
        sessionStorePath: 'private-secondary.sqlite', sessionNamespace: 'secondary',
        modelProfile: 'gpt-5.6-terra/high', approvalPolicy: 'never', sandbox: 'read-only',
        schema: { version: 1, kind: 'blind_evaluation' },
      },
    },
  };
  const blankPath = join(root, 'human-review-questions.md');
  const filledPath = join(root, 'filled.md');
  const templatePath = join(root, 'human-review-score-template.json');
  const summaryPath = join(root, 'run-summary.json');
  const configPath = join(root, 'quality-production-config.json');
  writeFileSync(blankPath, markdown(), 'utf8');
  writeFileSync(filledPath, markdown(true), 'utf8');
  writeFileSync(templatePath, JSON.stringify(template), 'utf8');
  writeFileSync(summaryPath, JSON.stringify(runSummary), 'utf8');
  writeFileSync(configPath, JSON.stringify(config), 'utf8');
  writeFileSync(join(root, 'sealed-mapping.json'), 'THIS MUST NOT BE READ', 'utf8');
  return { root, filledPath, configPath, questions };
}

test('human review is imported and sealed before either model judge runs', () => {
  const fixture = makePackage();
  const human = importCompletedHumanReview({
    packageDir: fixture.root,
    filledReviewPath: fixture.filledPath,
    questionFlaws: [11],
  });
  const persisted = JSON.parse(readFileSync(join(fixture.root, 'human-judgment.json'), 'utf8'));
  assert.deepEqual(persisted, human);
  assert.equal(human.items.length, 12);
  assert.equal(human.questionFlags[0].question, 11);
  assert.match(human.artifactChecksum, /^[0-9a-f]{64}$/);
});

test('two frozen evaluators see one identical anonymous input and invalid output retries at most three times', async () => {
  const fixture = makePackage();
  const human = importCompletedHumanReview({
    packageDir: fixture.root, filledReviewPath: fixture.filledPath, questionFlaws: [11],
  });
  const calls = [];
  const attempts = new Map();
  const clientFactory = ({ evaluatorId, lane }) => ({
    async runTurn(role, prompt, options) {
      calls.push({ evaluatorId, lane, role, prompt, options });
      const count = (attempts.get(evaluatorId) || 0) + 1;
      attempts.set(evaluatorId, count);
      if (evaluatorId === 'evaluator-primary' && count === 1) {
        return { text: '{"invalid":true}', threadId: 'thread_bad', turnId: 'turn_bad' };
      }
      const input = JSON.parse(readFileSync(join(fixture.root, 'judge-input.json'), 'utf8'));
      return {
        text: JSON.stringify(judgeOutput(input.questions, evaluatorId === 'evaluator-primary' ? 'A' : 'B')),
        threadId: `thread_${evaluatorId}_${count}`,
        turnId: `turn_${evaluatorId}_${count}`,
      };
    },
    async stop() {},
  });

  const result = await runBlindJudges({
    packageDir: fixture.root,
    productionConfigPath: fixture.configPath,
    clientFactory,
    now: (() => { let value = 10; return () => value++; })(),
  });

  assert.equal(attempts.get('evaluator-primary'), 2);
  assert.equal(attempts.get('evaluator-secondary'), 1);
  assert.equal(result.humanArtifactChecksum, human.artifactChecksum);
  assert.equal(result.primary.output.items.length, 12);
  assert.equal(result.secondary.output.items.length, 12);
  assert.equal(result.primary.judgeInputChecksum, result.secondary.judgeInputChecksum);
  assert.equal(new Set(calls.map(call => call.prompt)).size, 1);
  const primaryCall = calls.findLast(call => call.evaluatorId === 'evaluator-primary');
  const secondaryCall = calls.find(call => call.evaluatorId === 'evaluator-secondary');
  assert.doesNotMatch(primaryCall.prompt, /A评语1|B评语1|stable|candidateOutput/);
  assert.equal(primaryCall.options.model, 'gpt-5.6-sol');
  assert.equal(primaryCall.options.effort, 'medium');
  assert.equal(secondaryCall.options.model, 'gpt-5.6-terra');
  assert.equal(secondaryCall.options.effort, 'high');
  assert.deepEqual(primaryCall.options.outputSchema, REAL_CHAT_JUDGE_OUTPUT_SCHEMA);
  assert.equal(result.primary.outputChecksum, contentHash(result.primary.output));
  assert.equal(result.secondary.outputChecksum, contentHash(result.secondary.output));
});

test('mapping remains sealed until three complete judgments exist and final report includes a flagged-question sensitivity view', async () => {
  const fixture = makePackage();
  importCompletedHumanReview({
    packageDir: fixture.root, filledReviewPath: fixture.filledPath, questionFlaws: [11],
  });
  assert.throws(() => finalizeRealChatThreeJudge({
    packageDir: fixture.root, productionConfigPath: fixture.configPath,
  }), /(judge input|primary judgment) unavailable/);

  const clientFactory = ({ evaluatorId }) => ({
    async runTurn() {
      const input = JSON.parse(readFileSync(join(fixture.root, 'judge-input.json'), 'utf8'));
      return {
        text: JSON.stringify(judgeOutput(input.questions, evaluatorId === 'evaluator-primary' ? 'A' : 'B')),
        threadId: `thread_${evaluatorId}`,
        turnId: `turn_${evaluatorId}`,
      };
    },
    async stop() {},
  });
  await runBlindJudges({
    packageDir: fixture.root, productionConfigPath: fixture.configPath, clientFactory,
  });
  const mappingItems = fixture.questions.map((item, index) => {
    const basis = {
      version: 1,
      candidateId: item.candidateId,
      sides: index % 2 ? { A: 'stable', B: 'candidate' } : { A: 'candidate', B: 'stable' },
      outputChecksums: { stable: 'c'.repeat(64), candidate: 'd'.repeat(64) },
    };
    return { ...basis, mappingChecksum: contentHash(basis) };
  });
  const mappingBasis = { version: 1, runId: 'bundle_fixture', items: mappingItems };
  const mapping = { ...mappingBasis, mappingChecksum: contentHash(mappingBasis) };
  writeFileSync(join(fixture.root, 'sealed-mapping.json'), JSON.stringify(mapping), 'utf8');
  const summaryPath = join(fixture.root, 'run-summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  summary.sealedMappingChecksum = mapping.mappingChecksum;
  writeFileSync(summaryPath, JSON.stringify(summary), 'utf8');

  const result = finalizeRealChatThreeJudge({
    packageDir: fixture.root, productionConfigPath: fixture.configPath,
  });
  assert.equal(result.report.rawSummary.itemCount, 12);
  assert.equal(result.report.sensitivitySummary.itemCount, 11);
  assert.deepEqual(result.report.sensitivitySummary.excludedQuestions, [11]);
  assert.deepEqual(result.releaseProfiles.stable, { cognitionFast: 'stable-fast' });
  assert.deepEqual(result.releaseProfiles.candidate, { cognitionFast: 'candidate-fast' });
  const markdownReport = readFileSync(join(fixture.root, 'three-judge-final-report.md'), 'utf8');
  assert.match(markdownReport, /人工 50%/);
  assert.match(markdownReport, /题目本身有问题/);
  assert.match(markdownReport, /A评语1/);
  assert.equal(JSON.parse(readFileSync(join(fixture.root, 'three-judge-final-report.json'), 'utf8')).version, 1);
});
