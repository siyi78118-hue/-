import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import {
  buildHumanReviewMarkdown,
  buildSealedBlindPair,
  selectDiscriminatingPairs,
  validateRealChatCandidatePool,
} from '../yuqi-runtime/src/real-chat-blind-evaluation.mjs';

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label} JSON conflict`); }
}

function readJsonl(path, label) {
  try { return readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => JSON.parse(line)); }
  catch { throw new Error(`${label} JSONL conflict`); }
}

function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, text, { encoding: 'utf8', flag: 'wx' });
  rmSync(path, { force: true });
  renameSync(temporary, path);
}

function privateOutputPath(root, outputDir) {
  const rootPath = resolve(root);
  const value = resolve(outputDir || join(rootPath,
    'artifacts/yuqi-lived-agency-v3/private/real-chat-blind-evaluation'));
  if (value !== rootPath && !value.startsWith(`${rootPath}${sep}`)) {
    throw new Error('human review output must remain below root');
  }
  return value;
}

function assertDecisions(value, pool) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'items,version'
    || value.version !== 1 || !value.items || typeof value.items !== 'object' || Array.isArray(value.items)) {
    throw new Error('discriminability decisions shape conflict');
  }
  const poolIds = new Set(pool.items.map(item => item.candidateId));
  for (const [candidateId, checks] of Object.entries(value.items)) {
    if (!poolIds.has(candidateId) || !checks || typeof checks !== 'object' || Array.isArray(checks)
      || Object.keys(checks).sort().join(',') !== 'concreteContentOrActionDiffers,feltStyleOrEmotionDiffers,semanticStanceDiffers'
      || Object.values(checks).some(item => typeof item !== 'boolean')) {
      throw new Error(`discriminability decision conflict for ${candidateId}`);
    }
  }
  return structuredClone(value);
}

function projectExecutionOutput(output, side) {
  const sideResult = output?.[side];
  const draft = sideResult?.draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)
    || !['send', 'skip'].includes(draft.action)) {
    throw new Error(`${side} execution output shape conflict`);
  }
  const actionValues = [
    draft.paymentAction, draft.momentAction, draft.lifePlan, draft.lifeAdjustment,
    draft.relationshipStageAction,
    ...(Array.isArray(draft.rolePlanOperations) ? draft.rolePlanOperations : []),
    ...(draft.actionIntent && typeof draft.actionIntent === 'object'
      ? Object.values(draft.actionIntent) : []),
  ];
  if (actionValues.some(value => value !== undefined && value !== null)) {
    throw new Error(`${side} execution action output conflict`);
  }
  const reply = String(draft.reply || '');
  if (draft.action !== 'send' || !reply.trim()) {
    throw new Error(`${side} execution visible reply required`);
  }
  return {
    terminalDisposition: 'visible',
    replyParts: [{ ordinal: 0, type: 'text', text: reply }],
    actions: [],
  };
}

function replyText(output) {
  return output.replyParts.map(part => part.text).join('\n');
}

function loadExecutionPairs({ ledgerPath, runId, pool, decisions }) {
  const database = new DatabaseSync(ledgerPath, { readOnly: true });
  const pairsByCandidateId = {};
  const technicalFailures = [];
  try {
    const statement = database.prepare(`
      SELECT phase,state,output_json FROM quality_phases
      WHERE run_id=? AND final_key=? AND phase IN ('stable_execution','candidate_execution')
      ORDER BY phase
    `);
    for (const item of pool.items) {
      const finalKey = `history:${item.sceneId}:0`;
      const rows = statement.all(runId, finalKey);
      const byPhase = Object.fromEntries(rows.map(row => [row.phase, row]));
      if (!byPhase.stable_execution || !byPhase.candidate_execution
        || byPhase.stable_execution.state !== 'succeeded'
        || byPhase.candidate_execution.state !== 'succeeded') {
        technicalFailures.push({ candidateId: item.candidateId, finalKey, reason: 'execution_phase_incomplete' });
        continue;
      }
      try {
        const stableOutput = projectExecutionOutput(JSON.parse(byPhase.stable_execution.output_json), 'stable');
        const candidateOutput = projectExecutionOutput(JSON.parse(byPhase.candidate_execution.output_json), 'candidate');
        pairsByCandidateId[item.candidateId] = {
          answerA: replyText(stableOutput),
          answerB: replyText(candidateOutput),
          checks: decisions.items[item.candidateId],
          stableOutput,
          candidateOutput,
        };
      } catch (error) {
        technicalFailures.push({
          candidateId: item.candidateId,
          finalKey,
          reason: String(error?.message || error),
        });
      }
    }
  } finally {
    database.close();
  }
  return { pairsByCandidateId, technicalFailures };
}

function scoreTemplate(publicPairs) {
  return {
    version: 1,
    completed: false,
    items: publicPairs.map((pair, index) => ({
      question: index + 1,
      candidateId: pair.candidateId,
      overall: '',
      humanLike: '',
      understandsUser: '',
      characterLike: '',
      continueChat: '',
      problemsA: [],
      problemsB: [],
      note: '',
    })),
  };
}

export function exportRealChatHumanReview({
  root = process.cwd(), ledgerPath, runId, poolPath, historyScenesPath,
  decisionsPath, outputDir, seed,
} = {}) {
  if (!ledgerPath || !isAbsolute(ledgerPath) || typeof runId !== 'string' || !runId
    || !poolPath || !historyScenesPath || !decisionsPath || typeof seed !== 'string' || !seed) {
    throw new Error('human review export paths and seed are required');
  }
  const pool = validateRealChatCandidatePool(readJson(poolPath, 'candidate pool'));
  const decisions = assertDecisions(readJson(decisionsPath, 'discriminability decisions'), pool);
  const scenes = readJsonl(historyScenesPath, 'history scenes');
  const scenesById = new Map(scenes.map(scene => [scene.sceneId, scene]));
  if (scenes.length !== 30 || scenesById.size !== 30) throw new Error('history scene set conflict');
  const { pairsByCandidateId, technicalFailures } = loadExecutionPairs({ ledgerPath, runId, pool, decisions });
  const selection = selectDiscriminatingPairs({ pool, pairsByCandidateId });
  const sealed = selection.selected.map(item => {
    const scene = scenesById.get(item.sceneId);
    if (!scene) throw new Error(`history scene missing for ${item.sceneId}`);
    const result = buildSealedBlindPair({
      pair: {
        candidateId: item.candidateId,
        sceneId: item.sceneId,
        category: item.category,
        contextTurns: scene.turns.filter(turn => turn.speaker !== 'system'),
        stableOutput: item.pair.stableOutput,
        candidateOutput: item.pair.candidateOutput,
      },
      seed,
    });
    return result;
  });
  const publicPairs = sealed.map(item => item.publicPair);
  const mappingItems = sealed.map(item => item.sealedMapping);
  const mappingBasis = { version: 1, runId, items: mappingItems };
  const mapping = { ...mappingBasis, mappingChecksum: contentHash(mappingBasis) };
  const exactReplacementCount = selection.replacements
    .filter(item => item.classification.outcome === 'replace_exact').length;
  const substantiveReplacementCount = selection.replacements
    .filter(item => item.classification.outcome === 'replace_substantive').length;
  const audit = {
    version: 1,
    runId,
    selected: selection.selected.map(item => ({
      candidateId: item.candidateId,
      sceneId: item.sceneId,
      category: item.category,
      classification: item.classification,
    })),
    replacements: selection.replacements,
    technicalFailures,
    discriminabilityRate: selection.discriminabilityRate,
  };
  const summary = {
    version: 1,
    runId,
    scoredCount: publicPairs.length,
    candidatePoolCount: pool.items.length,
    executedPairCount: Object.keys(pairsByCandidateId).length,
    replacementCount: selection.replacements.length,
    exactReplacementCount,
    substantiveReplacementCount,
    technicalFailureCount: technicalFailures.length,
    multiBubbleScoredCount: selection.selected.filter(item => item.multiBubble).length,
    humanReviewChecksum: contentHash(publicPairs),
    sealedMappingChecksum: mapping.mappingChecksum,
  };
  const output = privateOutputPath(root, outputDir);
  const humanReviewPath = join(output, 'human-review-questions.md');
  const humanScoreTemplatePath = join(output, 'human-review-score-template.json');
  const sealedMappingPath = join(output, 'sealed-mapping.json');
  const discriminabilityAuditPath = join(output, 'discriminability-audit.json');
  const runSummaryPath = join(output, 'run-summary.json');
  const checksumManifestPath = join(output, 'package-checksums.json');
  atomicWrite(humanReviewPath, buildHumanReviewMarkdown({ pairs: publicPairs }));
  atomicWrite(humanScoreTemplatePath, `${canonicalJson(scoreTemplate(publicPairs))}\n`);
  atomicWrite(sealedMappingPath, `${canonicalJson(mapping)}\n`);
  atomicWrite(discriminabilityAuditPath, `${canonicalJson(audit)}\n`);
  atomicWrite(runSummaryPath, `${canonicalJson(summary)}\n`);
  const manifestBasis = {
    version: 1,
    humanReview: contentHash(buildHumanReviewMarkdown({ pairs: publicPairs })),
    humanScoreTemplate: contentHash(scoreTemplate(publicPairs)),
    sealedMapping: contentHash(mapping),
    discriminabilityAudit: contentHash(audit),
    runSummary: contentHash(summary),
  };
  atomicWrite(checksumManifestPath, `${canonicalJson({ ...manifestBasis, manifestChecksum: contentHash(manifestBasis) })}\n`);
  return {
    ...summary,
    humanReviewPath,
    humanScoreTemplatePath,
    sealedMappingPath,
    discriminabilityAuditPath,
    runSummaryPath,
    checksumManifestPath,
  };
}

function cliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--') || values.has(key)) {
      throw new Error('invalid human review export CLI arguments');
    }
    values.set(key, value);
  }
  return values;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = cliArgs(process.argv.slice(2));
  const result = exportRealChatHumanReview({
    root: resolve(args.get('--root') || process.cwd()),
    ledgerPath: resolve(args.get('--ledger') || ''),
    runId: args.get('--run-id') || '',
    poolPath: resolve(args.get('--pool') || ''),
    historyScenesPath: resolve(args.get('--history-scenes') || ''),
    decisionsPath: resolve(args.get('--decisions') || ''),
    outputDir: args.get('--output-dir') ? resolve(args.get('--output-dir')) : undefined,
    seed: args.get('--seed') || '',
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
