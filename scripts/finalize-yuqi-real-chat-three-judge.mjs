import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import {
  combineRealChatThreeJudgeResults,
  validateRealChatJudgeOutput,
} from '../yuqi-runtime/src/real-chat-three-judge.mjs';
import { atomicWrite } from './import-yuqi-real-chat-human-review.mjs';

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} unavailable`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function validateBeforeUnseal({ human, judgeInput, primary, secondary, judgeSummary, runSummary }) {
  if (!human || human.bundleId !== runSummary.runId || human.completed !== true) {
    throw new Error('human judgment authority conflict');
  }
  const { artifactChecksum: humanChecksum, ...humanBasis } = human;
  if (humanChecksum !== contentHash(humanBasis)) throw new Error('human judgment checksum conflict');
  if (!judgeInput || judgeInput.bundleId !== runSummary.runId
    || judgeInput.humanArtifactChecksum !== humanChecksum) {
    throw new Error('judge input authority conflict');
  }
  const judgeInputChecksum = contentHash(judgeInput);
  for (const [label, artifact] of [['primary', primary], ['secondary', secondary]]) {
    if (!artifact || artifact.version !== 1
      || artifact.humanArtifactChecksum !== humanChecksum
      || artifact.judgeInputChecksum !== judgeInputChecksum
      || artifact.outputChecksum !== contentHash(artifact.output)) {
      throw new Error(`${label} judgment authority conflict`);
    }
    validateRealChatJudgeOutput({ value: artifact.output, judgeInput });
  }
  if (primary.evaluatorId === secondary.evaluatorId) {
    throw new Error('independent evaluator identity conflict');
  }
  const { artifactChecksum: summaryChecksum, ...summaryBasis } = judgeSummary;
  if (summaryChecksum !== contentHash(summaryBasis)
    || judgeSummary.bundleId !== runSummary.runId
    || judgeSummary.humanArtifactChecksum !== humanChecksum
    || judgeSummary.judgeInputChecksum !== judgeInputChecksum
    || judgeSummary.evaluators?.primary?.outputChecksum !== primary.outputChecksum
    || judgeSummary.evaluators?.secondary?.outputChecksum !== secondary.outputChecksum) {
    throw new Error('judge run summary authority conflict');
  }
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function verdictText(value) {
  if (value === 'candidate_directional') return '新版方向性占优';
  if (value === 'stable_directional') return '旧版方向性占优';
  return '暂时没有清晰胜者';
}

function renderMarkdown(report) {
  const lines = [
    '# 虞栖真实聊天三方盲评结果',
    '',
    '本报告由同一份匿名 A/B 问卷得出：人工 50%，AI 主评 25%，AI 副评 25%。A/B 身份只在三份评分全部落盘后解封。',
    '',
    `- 12题原始结论：${verdictText(report.rawSummary.verdict)}（新版总体偏好 ${percent(report.rawSummary.candidateProbabilityByDimension.overall)}）`,
    `- 排除“题目本身有问题”的第 11 题后：${verdictText(report.sensitivitySummary.verdict)}（新版总体偏好 ${percent(report.sensitivitySummary.candidateProbabilityByDimension.overall)}）`,
    '- 这是小样本体验比较，不代表统计学定论。',
    '',
    '## 两个版本',
    '',
    `- 旧版配置：${canonicalJson(report.releaseProfiles.stable)}`,
    `- 新版配置：${canonicalJson(report.releaseProfiles.candidate)}`,
    '',
    '## 五个体验维度（排除第 11 题）',
    '',
    `- 总体更喜欢新版：${percent(report.sensitivitySummary.candidateProbabilityByDimension.overall)}`,
    `- 更像真人：${percent(report.sensitivitySummary.candidateProbabilityByDimension.humanLike)}`,
    `- 更懂用户：${percent(report.sensitivitySummary.candidateProbabilityByDimension.understandsUser)}`,
    `- 更像虞栖：${percent(report.sensitivitySummary.candidateProbabilityByDimension.characterLike)}`,
    `- 更想继续聊：${percent(report.sensitivitySummary.candidateProbabilityByDimension.continueChat)}`,
    '',
    '## 逐题人工意见',
    '',
  ];
  for (const item of report.items) {
    lines.push(
      `### 第 ${item.question} 题`,
      '',
      `- 匿名映射：${item.candidateSide} 是新版；三方加权新版总体偏好 ${percent(item.weightedCandidateProbability.overall)}`,
      ...(item.questionConcern ? ['- 题目本身有问题：本题保留在原始结果，但不进入敏感性结论。'] : []),
      `- 人工对 A 的意见：${item.comments.human.A}`,
      `- 人工对 B 的意见：${item.comments.human.B}`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

export function finalizeRealChatThreeJudge({
  packageDir,
  productionConfigPath,
} = {}) {
  const root = resolve(String(packageDir || ''));
  if (!packageDir || !productionConfigPath) throw new Error('three-judge finalization inputs required');
  const runSummary = readJson(join(root, 'run-summary.json'), 'run summary');
  const human = readJson(join(root, 'human-judgment.json'), 'human judgment');
  const judgeInput = readJson(join(root, 'judge-input.json'), 'judge input');
  const primary = readJson(join(root, 'evaluator-primary.json'), 'primary judgment');
  const secondary = readJson(join(root, 'evaluator-secondary.json'), 'secondary judgment');
  const judgeSummary = readJson(join(root, 'judge-run-summary.json'), 'judge run summary');

  // Deliberately validate every non-mapping authority before opening the mapping.
  validateBeforeUnseal({ human, judgeInput, primary, secondary, judgeSummary, runSummary });
  const config = readJson(resolve(String(productionConfigPath)), 'production config');
  const releaseProfiles = {
    stable: config?.stableRelease?.modelProfile,
    candidate: config?.candidateRelease?.modelProfile,
  };
  if (!releaseProfiles.stable || !releaseProfiles.candidate) {
    throw new Error('release profile authority conflict');
  }

  const sealedMapping = readJson(join(root, 'sealed-mapping.json'), 'sealed mapping');
  const combined = combineRealChatThreeJudgeResults({
    human, primary, secondary, judgeInput, sealedMapping, runSummary,
  });
  const reportBasis = {
    ...combined,
    releaseProfiles,
    judgeAuthorities: {
      humanArtifactChecksum: human.artifactChecksum,
      judgeInputChecksum: contentHash(judgeInput),
      primaryOutputChecksum: primary.outputChecksum,
      secondaryOutputChecksum: secondary.outputChecksum,
    },
  };
  const report = { ...reportBasis, reportChecksum: contentHash(reportBasis) };
  atomicWrite(join(root, 'three-judge-final-report.json'), `${canonicalJson(report)}\n`);
  atomicWrite(join(root, 'three-judge-final-report.md'), renderMarkdown(report));
  return { report, releaseProfiles };
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
  const result = finalizeRealChatThreeJudge(parseCli(process.argv.slice(2)));
  process.stdout.write(`${canonicalJson({
    ok: true,
    bundleId: result.report.bundleId,
    rawVerdict: result.report.rawSummary.verdict,
    sensitivityVerdict: result.report.sensitivitySummary.verdict,
    reportChecksum: result.report.reportChecksum,
  })}\n`);
}

