import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CodexAppServerClient } from '../yuqi-runtime/src/codex-client.mjs';
import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import {
  buildRealChatJudgeInput,
  validateRealChatJudgeOutput,
} from '../yuqi-runtime/src/real-chat-three-judge.mjs';
import { atomicWrite } from './import-yuqi-real-chat-human-review.mjs';

const CHOICE = Object.freeze({ type: 'string', enum: Object.freeze(['A', 'B', 'tie']) });
const JUDGE_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze([
    'question', 'candidateId', 'overall', 'humanLike', 'understandsUser',
    'characterLike', 'continueChat', 'commentA', 'commentB', 'questionConcern',
  ]),
  properties: Object.freeze({
    question: { type: 'integer', minimum: 1, maximum: 12 },
    candidateId: { type: 'string', minLength: 1 },
    overall: CHOICE,
    humanLike: CHOICE,
    understandsUser: CHOICE,
    characterLike: CHOICE,
    continueChat: CHOICE,
    commentA: { type: 'string', minLength: 1, maxLength: 2000 },
    commentB: { type: 'string', minLength: 1, maxLength: 2000 },
    questionConcern: { type: 'boolean' },
  }),
});

export const REAL_CHAT_JUDGE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: Object.freeze(['version', 'items']),
  properties: Object.freeze({
    version: { type: 'integer', const: 1 },
    items: {
      type: 'array', minItems: 12, maxItems: 12, items: JUDGE_ITEM_SCHEMA,
    },
  }),
});

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} unavailable`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function verifyHumanArtifact(value, runSummary) {
  if (!value || value.version !== 1 || value.completed !== true
    || value.bundleId !== runSummary.runId || !Array.isArray(value.items) || value.items.length !== 12) {
    throw new Error('completed human artifact conflict');
  }
  const { artifactChecksum, ...basis } = value;
  if (artifactChecksum !== contentHash(basis)) throw new Error('completed human artifact checksum conflict');
  return value;
}

function buildPrompt(input) {
  return [
    '你是虞栖真实聊天盲评中的独立评委。A/B 的版本身份完全隐藏；不要猜测模型或版本。',
    '只根据下面同一份匿名问卷评价 12 题。每题五项都只能选 A、B 或 tie；不要为了制造差异而强行选边。',
    'overall=总体更喜欢；humanLike=更像真人微信；understandsUser=更懂用户意思；characterLike=更像虞栖而非通用AI；continueChat=更让人想继续聊。',
    'commentA/commentB 各用一两句指出最关键的体验或问题，不要输出思维过程。题目本身不足以公平比较时 questionConcern=true，但仍给出最诚实的选择。',
    `机器题号清单：${canonicalJson(input.questions)}`,
    '',
    input.questionnaire,
  ].join('\n');
}

function parseProfile(profile, label) {
  if (typeof profile !== 'string' || !profile.includes('/')) {
    throw new Error(`${label} evaluator profile conflict`);
  }
  const separator = profile.lastIndexOf('/');
  const model = profile.slice(0, separator);
  const effort = profile.slice(separator + 1);
  if (!model || !['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) {
    throw new Error(`${label} evaluator profile conflict`);
  }
  return { model, effort };
}

function defaultClientFactory({ lane }) {
  return new CodexAppServerClient(lane);
}

function validateExistingArtifact(value, { evaluatorId, judgeInput, human }) {
  const keys = ['version', 'evaluatorId', 'judgeInputChecksum', 'humanArtifactChecksum', 'output', 'outputChecksum'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== keys.sort().join(',')
    || value.version !== 1 || value.evaluatorId !== evaluatorId
    || value.judgeInputChecksum !== contentHash(judgeInput)
    || value.humanArtifactChecksum !== human.artifactChecksum
    || value.outputChecksum !== contentHash(value.output)) {
    throw new Error(`${evaluatorId} artifact authority conflict`);
  }
  validateRealChatJudgeOutput({ value: value.output, judgeInput });
  return value;
}

async function runEvaluator({
  packageDir, evaluatorId, laneName, lane, judgeInput, human, clientFactory, now,
}) {
  const outputPath = join(packageDir, `${laneName.replace('_', '-')}.json`);
  if (existsSync(outputPath)) {
    return {
      artifact: validateExistingArtifact(readJson(outputPath, evaluatorId), {
        evaluatorId, judgeInput, human,
      }),
      attempts: [],
      resumed: true,
    };
  }
  const { model, effort } = parseProfile(lane.modelProfile, evaluatorId);
  const prompt = buildPrompt(judgeInput);
  const attempts = [];
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const client = clientFactory({ evaluatorId, laneName, lane, attempt });
    const startedAt = now();
    try {
      const completion = await client.runTurn('brain', prompt, {
        model,
        effort,
        outputSchema: REAL_CHAT_JUDGE_OUTPUT_SCHEMA,
        clientUserMessageId: `${judgeInput.bundleId}_${laneName}_${attempt}`,
        turnTimeoutMs: Number(lane.turnTimeoutMs) || 600_000,
      });
      const parsed = JSON.parse(completion.text);
      const output = validateRealChatJudgeOutput({ value: parsed, judgeInput });
      const artifact = {
        version: 1,
        evaluatorId,
        judgeInputChecksum: contentHash(judgeInput),
        humanArtifactChecksum: human.artifactChecksum,
        output,
        outputChecksum: contentHash(output),
      };
      atomicWrite(outputPath, `${canonicalJson(artifact)}\n`);
      attempts.push({
        attempt, state: 'succeeded', startedAt, completedAt: now(),
        threadId: String(completion.threadId || ''), turnId: String(completion.turnId || ''),
      });
      return { artifact, attempts, resumed: false, modelProfile: lane.modelProfile };
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt, state: 'failed', startedAt, completedAt: now(),
        errorCode: error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_OR_FAILED_JUDGMENT',
      });
    } finally {
      await client.stop?.();
    }
  }
  const failure = new Error(`${evaluatorId} failed after three attempts`);
  failure.cause = lastError;
  failure.attempts = attempts;
  throw failure;
}

export async function runBlindJudges({
  packageDir,
  productionConfigPath,
  clientFactory = defaultClientFactory,
  now = () => Date.now(),
} = {}) {
  const root = resolve(String(packageDir || ''));
  if (!packageDir || !productionConfigPath || typeof clientFactory !== 'function') {
    throw new Error('blind judge execution inputs required');
  }
  const runSummary = readJson(join(root, 'run-summary.json'), 'run summary');
  const human = verifyHumanArtifact(readJson(join(root, 'human-judgment.json'), 'human judgment'), runSummary);
  const template = readJson(join(root, 'human-review-score-template.json'), 'human score template');
  const blankMarkdown = readFileSync(join(root, 'human-review-questions.md'), 'utf8');
  const judgeInput = buildRealChatJudgeInput({
    blankMarkdown, template, runSummary, humanArtifactChecksum: human.artifactChecksum,
  });
  atomicWrite(join(root, 'judge-input.json'), `${canonicalJson(judgeInput)}\n`);

  const config = readJson(resolve(String(productionConfigPath)), 'production config');
  const primaryLane = config?.lanes?.evaluator_primary;
  const secondaryLane = config?.lanes?.evaluator_secondary;
  if (!primaryLane || !secondaryLane || primaryLane.modelProfile !== 'gpt-5.6-sol/medium'
    || secondaryLane.modelProfile !== 'gpt-5.6-terra/high') {
    throw new Error('frozen blind evaluator lanes conflict');
  }
  const [primary, secondary] = await Promise.all([
    runEvaluator({
      packageDir: root, evaluatorId: 'evaluator-primary', laneName: 'evaluator_primary',
      lane: primaryLane, judgeInput, human, clientFactory, now,
    }),
    runEvaluator({
      packageDir: root, evaluatorId: 'evaluator-secondary', laneName: 'evaluator_secondary',
      lane: secondaryLane, judgeInput, human, clientFactory, now,
    }),
  ]);
  const summaryBasis = {
    version: 1,
    bundleId: runSummary.runId,
    humanArtifactChecksum: human.artifactChecksum,
    judgeInputChecksum: contentHash(judgeInput),
    evaluators: {
      primary: {
        evaluatorId: primary.artifact.evaluatorId,
        modelProfile: primary.modelProfile || primaryLane.modelProfile,
        outputChecksum: primary.artifact.outputChecksum,
        attempts: primary.attempts,
        resumed: primary.resumed,
      },
      secondary: {
        evaluatorId: secondary.artifact.evaluatorId,
        modelProfile: secondary.modelProfile || secondaryLane.modelProfile,
        outputChecksum: secondary.artifact.outputChecksum,
        attempts: secondary.attempts,
        resumed: secondary.resumed,
      },
    },
  };
  atomicWrite(join(root, 'judge-run-summary.json'), `${canonicalJson({
    ...summaryBasis, artifactChecksum: contentHash(summaryBasis),
  })}\n`);
  return {
    humanArtifactChecksum: human.artifactChecksum,
    judgeInput,
    primary: primary.artifact,
    secondary: secondary.artifact,
  };
}

function parseCli(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--package-dir') result.packageDir = argv[++index];
    else if (token === '--production-config') result.productionConfigPath = argv[++index];
    else throw new Error(`unknown argument: ${token}`);
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const result = await runBlindJudges(parseCli(process.argv.slice(2)));
  process.stdout.write(`${canonicalJson({
    ok: true,
    humanArtifactChecksum: result.humanArtifactChecksum,
    judgeInputChecksum: contentHash(result.judgeInput),
    primaryOutputChecksum: result.primary.outputChecksum,
    secondaryOutputChecksum: result.secondary.outputChecksum,
  })}\n`);
}
