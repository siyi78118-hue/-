import { createHash } from 'node:crypto';

import { contentHash } from './protocol.mjs';

export const REAL_CHAT_REVIEW_DIMENSIONS = Object.freeze([
  'overall', 'humanLike', 'understandsUser', 'characterLike', 'continueChat',
]);

const HEX64 = /^[0-9a-f]{64}$/;
const CHOICES = new Set(['A', 'B', 'tie']);
const HUMAN_ITEM_KEYS = Object.freeze([
  'question', 'candidateId', ...REAL_CHAT_REVIEW_DIMENSIONS,
  'commentA', 'commentB', 'questionConcern',
]);
const JUDGE_ITEM_KEYS = HUMAN_ITEM_KEYS;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`${label} shape conflict`);
  }
}

function frozenClone(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      Object.values(current).forEach(freeze);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function assertHex(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) throw new Error(`${label} conflict`);
}

function parseQuestionSections(markdown, { requireChoices }) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('human review markdown required');
  const normalized = markdown.replace(/\r\n?/gu, '\n');
  const heading = /^## 第 (\d+) 题\s*$/gmu;
  const matches = [...normalized.matchAll(heading)];
  if (matches.length !== 12 || matches.some((match, index) => Number(match[1]) !== index + 1)) {
    throw new Error('human review question count conflict');
  }
  return matches.map((match, index) => {
    const question = Number(match[1]);
    const start = match.index;
    const end = index + 1 < matches.length ? matches[index + 1].index : normalized.length;
    const section = normalized.slice(start, end);
    const contextMatch = section.match(/### 聊天上下文\s*\n([\s\S]*?)\n### 回答 A\s*\n/u);
    const answerAMatch = section.match(/### 回答 A\s*\n([\s\S]*?)\n### 回答 B\s*\n/u);
    const answerBMatch = section.match(/### 回答 B\s*\n([\s\S]*?)\n1\. 总体更喜欢哪一个/u);
    if (!contextMatch || !answerAMatch || !answerBMatch) {
      throw new Error('human review question content conflict');
    }
    const content = {
      context: contextMatch[1].trim(),
      answerA: answerAMatch[1].trim(),
      answerB: answerBMatch[1].trim(),
    };
    if (!content.context || !content.answerA || !content.answerB) {
      throw new Error('human review question content conflict');
    }
    if (!requireChoices) return { question, section, content };
    const choices = {};
    for (let choiceIndex = 1; choiceIndex <= REAL_CHAT_REVIEW_DIMENSIONS.length; choiceIndex += 1) {
      const line = section.split('\n').find(value => value.startsWith(`${choiceIndex}. `));
      const token = line?.match(/：\s*_*(A|B|差不多)_*\s*（A \/ B \/ 差不多）\s*$/u)?.[1];
      if (!token) throw new Error(`human review choice conflict: ${question}:${choiceIndex}`);
      choices[REAL_CHAT_REVIEW_DIMENSIONS[choiceIndex - 1]] = token === '差不多' ? 'tie' : token;
    }
    const parseComment = side => {
      const raw = section.match(new RegExp(`^- ${side}：(.*)$`, 'mu'))?.[1]?.trim() || '';
      const text = raw.replace(/^_+|_+$/gu, '').trim();
      if (!text) throw new Error(`human review comment conflict: ${question}:${side}`);
      return text;
    };
    return {
      question,
      section,
      content,
      choices,
      commentA: parseComment('A'),
      commentB: parseComment('B'),
    };
  });
}

function validateTemplate(template) {
  if (!template || typeof template !== 'object' || Array.isArray(template)
    || template.version !== 1 || !Array.isArray(template.items) || template.items.length !== 12) {
    throw new Error('human review template conflict');
  }
  const ids = new Set();
  return template.items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || item.question !== index + 1 || typeof item.candidateId !== 'string' || !item.candidateId
      || ids.has(item.candidateId)) {
      throw new Error('human review template item conflict');
    }
    ids.add(item.candidateId);
    return { question: item.question, candidateId: item.candidateId };
  });
}

function validateRunSummary(runSummary) {
  if (!runSummary || typeof runSummary !== 'object' || Array.isArray(runSummary)
    || runSummary.version !== 1 || typeof runSummary.runId !== 'string' || !runSummary.runId
    || runSummary.scoredCount !== 12) {
    throw new Error('real chat run summary conflict');
  }
  assertHex(runSummary.humanReviewChecksum, 'human review package checksum');
  return runSummary;
}

function normalizeQuestionFlags(flags) {
  if (!Array.isArray(flags)) throw new Error('human review question flags conflict');
  const seen = new Set();
  const normalized = flags.map(flag => {
    exactKeys(flag, ['question', 'code'], 'human review question flag');
    if (!Number.isSafeInteger(flag.question) || flag.question < 1 || flag.question > 12
      || typeof flag.code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(flag.code)
      || seen.has(flag.question)) {
      throw new Error('human review question flag conflict');
    }
    seen.add(flag.question);
    return { question: flag.question, code: flag.code };
  });
  return normalized.sort((a, b) => a.question - b.question);
}

export function parseCompletedHumanReview({
  blankMarkdown, filledMarkdown, template, runSummary, questionFlags = [],
} = {}) {
  const summary = validateRunSummary(runSummary);
  const identities = validateTemplate(template);
  const blank = parseQuestionSections(blankMarkdown, { requireChoices: false });
  const filled = parseQuestionSections(filledMarkdown, { requireChoices: true });
  const flags = normalizeQuestionFlags(questionFlags);
  const flagged = new Set(flags.map(flag => flag.question));
  const items = filled.map((item, index) => {
    if (contentHash(item.content) !== contentHash(blank[index].content)) {
      throw new Error(`human review question content conflict: ${item.question}`);
    }
    return {
      question: item.question,
      candidateId: identities[index].candidateId,
      ...item.choices,
      commentA: item.commentA,
      commentB: item.commentB,
      questionConcern: flagged.has(item.question),
    };
  });
  const basis = {
    version: 1,
    bundleId: summary.runId,
    humanReviewChecksum: summary.humanReviewChecksum,
    blankReviewSha256: sha256Text(blankMarkdown),
    filledReviewSha256: sha256Text(filledMarkdown),
    completed: true,
    questionFlags: flags,
    items,
  };
  return frozenClone({ ...basis, artifactChecksum: contentHash(basis) });
}

export function buildRealChatJudgeInput({
  blankMarkdown, template, runSummary, humanArtifactChecksum,
} = {}) {
  const summary = validateRunSummary(runSummary);
  const questions = validateTemplate(template);
  parseQuestionSections(blankMarkdown, { requireChoices: false });
  assertHex(humanArtifactChecksum, 'human artifact checksum');
  return frozenClone({
    version: 1,
    bundleId: summary.runId,
    humanReviewChecksum: summary.humanReviewChecksum,
    blankReviewSha256: sha256Text(blankMarkdown),
    humanArtifactChecksum,
    questions,
    questionnaire: blankMarkdown.replace(/\r\n?/gu, '\n'),
  });
}

function normalizeJudgeItem(item, expected) {
  exactKeys(item, JUDGE_ITEM_KEYS, 'judge item');
  if (item.question !== expected.question || item.candidateId !== expected.candidateId) {
    throw new Error('judge item identity conflict');
  }
  for (const dimension of REAL_CHAT_REVIEW_DIMENSIONS) {
    if (!CHOICES.has(item[dimension])) throw new Error(`judge choice conflict: ${dimension}`);
  }
  if (typeof item.commentA !== 'string' || !item.commentA.trim() || item.commentA.length > 2000
    || typeof item.commentB !== 'string' || !item.commentB.trim() || item.commentB.length > 2000
    || typeof item.questionConcern !== 'boolean') {
    throw new Error('judge comment conflict');
  }
  return {
    question: item.question,
    candidateId: item.candidateId,
    ...Object.fromEntries(REAL_CHAT_REVIEW_DIMENSIONS.map(key => [key, item[key]])),
    commentA: item.commentA.trim(),
    commentB: item.commentB.trim(),
    questionConcern: item.questionConcern,
  };
}

export function validateRealChatJudgeOutput({ value, judgeInput } = {}) {
  exactKeys(value, ['version', 'items'], 'judge output');
  if (value.version !== 1 || !Array.isArray(value.items) || value.items.length !== 12
    || !judgeInput || !Array.isArray(judgeInput.questions) || judgeInput.questions.length !== 12) {
    throw new Error('judge output item count conflict');
  }
  return frozenClone({
    version: 1,
    items: value.items.map((item, index) => normalizeJudgeItem(item, judgeInput.questions[index])),
  });
}

function validateHumanArtifact(human, runSummary) {
  if (!human || typeof human !== 'object' || Array.isArray(human) || human.version !== 1
    || human.bundleId !== runSummary.runId || human.completed !== true
    || !Array.isArray(human.items) || human.items.length !== 12) {
    throw new Error('human artifact conflict');
  }
  const { artifactChecksum, ...basis } = human;
  assertHex(artifactChecksum, 'human artifact checksum');
  if (contentHash(basis) !== artifactChecksum) throw new Error('human artifact checksum conflict');
  human.items.forEach((item, index) => {
    exactKeys(item, HUMAN_ITEM_KEYS, 'human artifact item');
    normalizeJudgeItem(item, { question: index + 1, candidateId: item.candidateId });
  });
}

function validateJudgmentArtifact(value, { human, judgeInput, label }) {
  exactKeys(value, [
    'version', 'evaluatorId', 'judgeInputChecksum', 'humanArtifactChecksum', 'output', 'outputChecksum',
  ], `${label} judgment artifact`);
  if (value.version !== 1 || typeof value.evaluatorId !== 'string' || !value.evaluatorId
    || value.humanArtifactChecksum !== human.artifactChecksum
    || value.judgeInputChecksum !== contentHash(judgeInput)) {
    throw new Error(`${label} judgment authority conflict`);
  }
  if (value.outputChecksum !== contentHash(value.output)) {
    throw new Error(`${label} judgment checksum conflict`);
  }
  return validateRealChatJudgeOutput({ value: value.output, judgeInput });
}

function validateSealedMapping(mapping, { runSummary, questions }) {
  exactKeys(mapping, ['version', 'runId', 'items', 'mappingChecksum'], 'sealed mapping');
  const basis = { version: mapping.version, runId: mapping.runId, items: mapping.items };
  if (mapping.version !== 1 || mapping.runId !== runSummary.runId
    || mapping.mappingChecksum !== contentHash(basis)
    || (runSummary.sealedMappingChecksum && mapping.mappingChecksum !== runSummary.sealedMappingChecksum)
    || !Array.isArray(mapping.items) || mapping.items.length !== 12) {
    throw new Error('sealed mapping checksum conflict');
  }
  return mapping.items.map((item, index) => {
    exactKeys(item, [
      'version', 'candidateId', 'sides', 'outputChecksums', 'mappingChecksum',
    ], 'sealed mapping item');
    const itemBasis = {
      version: item.version,
      candidateId: item.candidateId,
      sides: item.sides,
      outputChecksums: item.outputChecksums,
    };
    if (item.version !== 1 || item.candidateId !== questions[index].candidateId
      || item.mappingChecksum !== contentHash(itemBasis)
      || !item.sides || !['stable', 'candidate'].includes(item.sides.A)
      || !['stable', 'candidate'].includes(item.sides.B) || item.sides.A === item.sides.B) {
      throw new Error('sealed mapping item conflict');
    }
    return item;
  });
}

function voteForCandidate(choice, candidateSide) {
  if (choice === 'tie') return 0.5;
  return choice === candidateSide ? 1 : 0;
}

function summarize(items, excludedQuestions = []) {
  const excluded = new Set(excludedQuestions);
  const included = items.filter(item => !excluded.has(item.question));
  const probabilities = Object.fromEntries(REAL_CHAT_REVIEW_DIMENSIONS.map(dimension => [
    dimension,
    included.reduce((sum, item) => sum + item.weightedCandidateProbability[dimension], 0)
      / included.length,
  ]));
  const overall = probabilities.overall;
  return {
    itemCount: included.length,
    excludedQuestions: [...excluded].sort((a, b) => a - b),
    candidateProbabilityByDimension: probabilities,
    candidateItemWins: included.filter(item => item.weightedCandidateProbability.overall > 0.5).length,
    stableItemWins: included.filter(item => item.weightedCandidateProbability.overall < 0.5).length,
    tiedItems: included.filter(item => item.weightedCandidateProbability.overall === 0.5).length,
    verdict: overall >= 0.625
      ? 'candidate_directional'
      : overall <= 0.375 ? 'stable_directional' : 'no_clear_winner',
  };
}

export function combineRealChatThreeJudgeResults({
  human, primary, secondary, judgeInput, sealedMapping, runSummary,
} = {}) {
  const summary = validateRunSummary(runSummary);
  validateHumanArtifact(human, summary);
  if (!judgeInput || judgeInput.bundleId !== summary.runId
    || judgeInput.humanArtifactChecksum !== human.artifactChecksum) {
    throw new Error('judge input authority conflict');
  }
  const primaryOutput = validateJudgmentArtifact(primary, {
    human, judgeInput, label: 'primary',
  });
  const secondaryOutput = validateJudgmentArtifact(secondary, {
    human, judgeInput, label: 'secondary',
  });
  if (primary.evaluatorId === secondary.evaluatorId) {
    throw new Error('independent evaluator identity conflict');
  }
  const mappings = validateSealedMapping(sealedMapping, {
    runSummary: summary, questions: judgeInput.questions,
  });
  const weights = { human: 0.5, primary: 0.25, secondary: 0.25 };
  const items = human.items.map((humanItem, index) => {
    const candidateSide = Object.entries(mappings[index].sides)
      .find(([, release]) => release === 'candidate')?.[0];
    const byJudge = {
      human: humanItem,
      primary: primaryOutput.items[index],
      secondary: secondaryOutput.items[index],
    };
    const weightedCandidateProbability = Object.fromEntries(
      REAL_CHAT_REVIEW_DIMENSIONS.map(dimension => [
        dimension,
        weights.human * voteForCandidate(byJudge.human[dimension], candidateSide)
          + weights.primary * voteForCandidate(byJudge.primary[dimension], candidateSide)
          + weights.secondary * voteForCandidate(byJudge.secondary[dimension], candidateSide),
      ])
    );
    return {
      question: humanItem.question,
      candidateId: humanItem.candidateId,
      candidateSide,
      questionConcern: humanItem.questionConcern,
      votes: Object.fromEntries(Object.entries(byJudge).map(([judge, item]) => [judge,
        Object.fromEntries(REAL_CHAT_REVIEW_DIMENSIONS.map(dimension => [dimension, item[dimension]]))])),
      weightedCandidateProbability,
      comments: {
        human: { A: humanItem.commentA, B: humanItem.commentB },
        primary: { A: primaryOutput.items[index].commentA, B: primaryOutput.items[index].commentB },
        secondary: { A: secondaryOutput.items[index].commentA, B: secondaryOutput.items[index].commentB },
      },
    };
  });
  const excludedQuestions = human.questionFlags.map(flag => flag.question);
  return frozenClone({
    version: 1,
    bundleId: summary.runId,
    sealedMappingChecksum: sealedMapping.mappingChecksum,
    weights,
    items,
    rawSummary: summarize(items),
    sensitivitySummary: summarize(items, excludedQuestions),
  });
}

