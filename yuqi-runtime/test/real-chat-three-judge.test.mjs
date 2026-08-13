import assert from 'node:assert/strict';
import test from 'node:test';

import { contentHash } from '../src/protocol.mjs';
import {
  buildRealChatJudgeInput,
  combineRealChatThreeJudgeResults,
  parseCompletedHumanReview,
  validateRealChatJudgeOutput,
} from '../src/real-chat-three-judge.mjs';

const CHOICES = ['overall', 'humanLike', 'understandsUser', 'characterLike', 'continueChat'];

function questionSection(index, { filled = false } = {}) {
  const choice = index === 7 ? '差不多' : index % 2 ? 'A' : 'B';
  const answer = filled
    ? (index === 7 ? `_差不多___` : `__${choice}__`)
    : '____';
  return [
    `## 第 ${index} 题`,
    '',
    '### 聊天上下文',
    '',
    `- 用户：上下文${index}`,
    '',
    '### 回答 A',
    '',
    `回答A-${index}`,
    '',
    '### 回答 B',
    '',
    `回答B-${index}`,
    '',
    `1. 总体更喜欢哪一个：${answer}（A / B / 差不多）`,
    `2. 哪个更像真人在微信里会回的话：${answer}（A / B / 差不多）`,
    `3. 哪个更懂用户真正想表达的意思：${answer}（A / B / 差不多）`,
    `4. 哪个更像虞栖本人，而不是通用温柔 AI：${answer}（A / B / 差不多）`,
    `5. 哪个更让人想继续聊下去：${answer}（A / B / 差不多）`,
    '6. 明显问题（分别填写 A / B）。',
    '',
    `- A：${filled ? `__A评语${index}__` : '____'}`,
    `- B：${filled ? `__B评语${index}__` : '____'}`,
  ].join('\n');
}

function reviewMarkdown(options = {}) {
  return [
    '# 虞栖真实聊天盲评卷',
    '',
    '请只根据聊天体验填写。',
    '',
    ...Array.from({ length: 12 }, (_, index) => questionSection(index + 1, options)),
    '',
  ].join('\n');
}

function template() {
  return {
    version: 1,
    completed: false,
    items: Array.from({ length: 12 }, (_, index) => ({
      question: index + 1,
      candidateId: `candidate_${String(index + 1).padStart(2, '0')}`,
      overall: '', humanLike: '', understandsUser: '', characterLike: '', continueChat: '',
      problemsA: [], problemsB: [], note: '',
    })),
  };
}

function runSummary() {
  return {
    version: 1,
    runId: 'bundle_1234567890abcdef',
    scoredCount: 12,
    humanReviewChecksum: 'a'.repeat(64),
    sealedMappingChecksum: '',
  };
}

function judgeOutput(items, preference = 'A') {
  return {
    version: 1,
    items: items.map(item => ({
      question: item.question,
      candidateId: item.candidateId,
      overall: preference,
      humanLike: preference,
      understandsUser: preference,
      characterLike: preference,
      continueChat: preference,
      commentA: 'A comment',
      commentB: 'B comment',
      questionConcern: false,
    })),
  };
}

test('completed human Markdown is sealed without changing the anonymous question content', () => {
  const summary = runSummary();
  const human = parseCompletedHumanReview({
    blankMarkdown: reviewMarkdown(),
    filledMarkdown: reviewMarkdown({ filled: true }),
    template: template(),
    runSummary: summary,
    questionFlags: [{ question: 11, code: 'source_question_flaw' }],
  });

  assert.equal(human.completed, true);
  assert.equal(human.items.length, 12);
  assert.equal(human.items[0].overall, 'A');
  assert.equal(human.items[1].humanLike, 'B');
  assert.equal(human.items[6].overall, 'tie');
  assert.equal(human.items[10].questionConcern, true);
  assert.deepEqual(human.questionFlags, [{ question: 11, code: 'source_question_flaw' }]);
  assert.match(human.artifactChecksum, /^[0-9a-f]{64}$/);

  const changed = reviewMarkdown({ filled: true }).replace('回答B-4', '被改过的回答');
  assert.throws(() => parseCompletedHumanReview({
    blankMarkdown: reviewMarkdown(), filledMarkdown: changed,
    template: template(), runSummary: summary,
  }), /human review question content conflict/);
});

test('judge input is anonymous and judge output is closed and ordered', () => {
  const summary = runSummary();
  const human = parseCompletedHumanReview({
    blankMarkdown: reviewMarkdown(), filledMarkdown: reviewMarkdown({ filled: true }),
    template: template(), runSummary: summary,
  });
  const input = buildRealChatJudgeInput({
    blankMarkdown: reviewMarkdown(), template: template(), runSummary: summary,
    humanArtifactChecksum: human.artifactChecksum,
  });

  assert.equal(input.questions.length, 12);
  assert.equal(input.humanArtifactChecksum, human.artifactChecksum);
  assert.doesNotMatch(JSON.stringify(input), /A评语|B评语|stable|candidateOutput|modelProfile/);

  const output = validateRealChatJudgeOutput({
    value: judgeOutput(input.questions, 'B'), judgeInput: input,
  });
  assert.equal(output.items[0].overall, 'B');
  const changed = structuredClone(output);
  changed.items[0].candidateId = 'wrong';
  assert.throws(() => validateRealChatJudgeOutput({ value: changed, judgeInput: input }),
    /judge item identity conflict/);
});

test('human half-weight and two quarter-weight judges combine only after sealed mapping validation', () => {
  const summary = runSummary();
  const human = parseCompletedHumanReview({
    blankMarkdown: reviewMarkdown(), filledMarkdown: reviewMarkdown({ filled: true }),
    template: template(), runSummary: summary,
    questionFlags: [{ question: 11, code: 'source_question_flaw' }],
  });
  const input = buildRealChatJudgeInput({
    blankMarkdown: reviewMarkdown(), template: template(), runSummary: summary,
    humanArtifactChecksum: human.artifactChecksum,
  });
  const primaryOutput = validateRealChatJudgeOutput({
    value: judgeOutput(input.questions, 'A'), judgeInput: input,
  });
  const secondaryOutput = validateRealChatJudgeOutput({
    value: judgeOutput(input.questions, 'B'), judgeInput: input,
  });
  const mappingItems = input.questions.map((item, index) => {
    const basis = {
      version: 1,
      candidateId: item.candidateId,
      sides: { A: 'candidate', B: 'stable' },
      outputChecksums: { stable: 'b'.repeat(64), candidate: 'c'.repeat(64) },
    };
    return { ...basis, mappingChecksum: contentHash(basis) };
  });
  const mappingBasis = { version: 1, runId: summary.runId, items: mappingItems };
  const sealedMapping = { ...mappingBasis, mappingChecksum: contentHash(mappingBasis) };
  summary.sealedMappingChecksum = sealedMapping.mappingChecksum;

  const wrap = (evaluatorId, output) => ({
    version: 1,
    evaluatorId,
    judgeInputChecksum: contentHash(input),
    humanArtifactChecksum: human.artifactChecksum,
    output,
    outputChecksum: contentHash(output),
  });
  const result = combineRealChatThreeJudgeResults({
    human,
    primary: wrap('primary', primaryOutput),
    secondary: wrap('secondary', secondaryOutput),
    judgeInput: input,
    sealedMapping,
    runSummary: summary,
  });

  assert.equal(result.weights.human, 0.5);
  assert.equal(result.weights.primary, 0.25);
  assert.equal(result.weights.secondary, 0.25);
  assert.equal(result.items[0].weightedCandidateProbability.overall, 0.75);
  assert.equal(result.items[1].weightedCandidateProbability.overall, 0.25);
  assert.equal(result.rawSummary.itemCount, 12);
  assert.equal(result.sensitivitySummary.itemCount, 11);
  assert.equal(result.sensitivitySummary.excludedQuestions[0], 11);
  assert.equal(result.rawSummary.verdict, 'no_clear_winner');

  const forged = structuredClone(sealedMapping);
  forged.items[0].sides = { A: 'stable', B: 'candidate' };
  assert.throws(() => combineRealChatThreeJudgeResults({
    human, primary: wrap('primary', primaryOutput), secondary: wrap('secondary', secondaryOutput),
    judgeInput: input, sealedMapping: forged, runSummary: summary,
  }), /sealed mapping checksum conflict/);
});

test('all five comparable dimensions remain exact and complete', () => {
  assert.deepEqual(CHOICES, [
    'overall', 'humanLike', 'understandsUser', 'characterLike', 'continueChat',
  ]);
});
