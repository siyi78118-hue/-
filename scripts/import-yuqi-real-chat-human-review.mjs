import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonicalJson } from '../yuqi-runtime/src/protocol.mjs';
import { parseCompletedHumanReview } from '../yuqi-runtime/src/real-chat-three-judge.mjs';

function readJson(path, label) {
  if (!existsSync(path)) throw new Error(`${label} unavailable`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicWrite(path, value) {
  const temporary = join(dirname(path), `.${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`);
  writeFileSync(temporary, value, 'utf8');
  renameSync(temporary, path);
}

export function importCompletedHumanReview({
  packageDir,
  filledReviewPath,
  questionFlaws = [],
} = {}) {
  const root = resolve(String(packageDir || ''));
  const input = resolve(String(filledReviewPath || ''));
  if (!packageDir || !filledReviewPath || !existsSync(input)) {
    throw new Error('completed human review input required');
  }
  const blankPath = join(root, 'human-review-questions.md');
  const templatePath = join(root, 'human-review-score-template.json');
  const summaryPath = join(root, 'run-summary.json');
  if (!existsSync(blankPath)) throw new Error('blank human review unavailable');
  const normalizedFlaws = questionFlaws.map(question => ({
    question: Number(question), code: 'source_question_flaw',
  }));
  const artifact = parseCompletedHumanReview({
    blankMarkdown: readFileSync(blankPath, 'utf8'),
    filledMarkdown: readFileSync(input, 'utf8'),
    template: readJson(templatePath, 'human score template'),
    runSummary: readJson(summaryPath, 'run summary'),
    questionFlags: normalizedFlaws,
  });
  atomicWrite(join(root, 'human-judgment.json'), `${canonicalJson(artifact)}\n`);
  return artifact;
}

function parseCli(argv) {
  const result = { questionFlaws: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--package-dir') result.packageDir = argv[++index];
    else if (token === '--filled-review') result.filledReviewPath = argv[++index];
    else if (token === '--question-flaw') result.questionFlaws.push(Number(argv[++index]));
    else throw new Error(`unknown argument: ${token}`);
  }
  return result;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const artifact = importCompletedHumanReview(parseCli(process.argv.slice(2)));
  process.stdout.write(`${canonicalJson({
    ok: true,
    bundleId: artifact.bundleId,
    scoredCount: artifact.items.length,
    artifactChecksum: artifact.artifactChecksum,
  })}\n`);
}

export { atomicWrite };

