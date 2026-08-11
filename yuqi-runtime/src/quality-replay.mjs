import { canonicalJson, contentHash } from './protocol.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  compileQualitySuite,
  isVerifiedCompiledQualitySuite
} from '../../scripts/compile-yuqi-lived-quality-scenes.mjs';

const LAYER_RULES = Object.freeze({
  sentinel: Object.freeze({ repeats: 3, expected: 24 }),
  coverage: Object.freeze({ repeats: 2, expected: 72 }),
  history: Object.freeze({ repeats: 1, expected: 30 })
});

const PLAN_TYPE = 'yuqi-lived-quality-replay-v1';
const PLAN_KEYS = new Set(['version', 'planType', 'items', 'finalKeys', 'commitments', 'historyManifest', 'planChecksum']);
const COMMITMENT_KEYS = new Set([
  'sourceGroundingChecksum', 'sentinelContentChecksum', 'coverageContentChecksum',
  'historyScenesChecksum', 'itemsChecksum'
]);
const EXPECTED_PROJECTION_KEYS = new Set([
  'version', 'planType', 'planChecksum', 'sourceGroundingChecksum', 'items', 'finalKeys', 'commitments', 'historyManifest'
]);

function deepFreezeClone(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

function assertSceneList(value, layer) {
  const rule = LAYER_RULES[layer];
  if (!Array.isArray(value) || value.length !== rule.expected) {
    throw new Error(`${layer} scene count must be ${rule.expected}`);
  }
  const ids = value.map(scene => scene?.sceneId);
  if (ids.some(id => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length) {
    throw new Error(`${layer} scene IDs must be unique strings`);
  }
  return value;
}

export function qualityFinalKey(value) {
  if (!value || !['sentinel', 'coverage', 'history'].includes(value.layer)
    || typeof value.sceneId !== 'string' || !value.sceneId
    || !Number.isSafeInteger(value.repeatIndex) || value.repeatIndex < 0) {
    throw new Error('invalid quality final identity');
  }
  return `${value.layer}:${value.sceneId}:${value.repeatIndex}`;
}

export function qualityAttemptKey(value) {
  qualityFinalKey(value);
  if (!Number.isSafeInteger(value.attemptIndex) || value.attemptIndex < 0
    || typeof value.evaluatorId !== 'string' || !value.evaluatorId) {
    throw new Error('invalid quality attempt identity');
  }
  return `${qualityFinalKey(value)}:${value.attemptIndex}:${value.evaluatorId}`;
}

export function buildQualityReplayPlan({ sentinelSeeds, coverageScenes, historyScenes }) {
  const layers = [
    ['sentinel', assertSceneList(sentinelSeeds, 'sentinel')],
    ['coverage', assertSceneList(coverageScenes, 'coverage')],
    ['history', assertSceneList(historyScenes, 'history')]
  ];
  const plan = [];
  for (const [layer, scenes] of layers) {
    const repeats = LAYER_RULES[layer].repeats;
    for (const scene of scenes) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
        const item = { layer, sceneId: scene.sceneId, repeatIndex, scene };
        qualityFinalKey(item);
        plan.push(item);
      }
    }
  }
  if (new Set(plan.map(qualityFinalKey)).size !== plan.length) {
    throw new Error('duplicate quality final identity');
  }
  return plan;
}

function assertHistoryManifestShape(historyManifest) {
  if (!historyManifest || typeof historyManifest !== 'object' || Array.isArray(historyManifest)
    || Object.keys(historyManifest).sort().join(',') !== 'sceneIds,scenesChecksum,schemaVersion'
    || historyManifest.schemaVersion !== 1
    || !Array.isArray(historyManifest.sceneIds)
    || historyManifest.sceneIds.length !== LAYER_RULES.history.expected
    || historyManifest.sceneIds.some(id => typeof id !== 'string' || !id)
    || new Set(historyManifest.sceneIds).size !== historyManifest.sceneIds.length
    || !/^[0-9a-f]{64}$/.test(historyManifest.scenesChecksum)) {
    throw new Error('history manifest/checksum authority conflict');
  }
}

function assertHistoryManifest(historyScenes, historyManifest) {
  if (!Array.isArray(historyScenes) || historyScenes.length !== LAYER_RULES.history.expected) {
    throw new Error('quality history scenes must contain exactly 30 entries');
  }
  assertHistoryManifestShape(historyManifest);
  if (historyManifest.sceneIds.join('\u0000') !== historyScenes.map(scene => scene?.sceneId).join('\u0000')
    || historyManifest.scenesChecksum !== contentHash(historyScenes)) {
    throw new Error('history manifest/checksum authority conflict');
  }
}

function finalKeysForPlan(plan) {
  const keys = {
    sentinelFinalKeys: [],
    coverageFinalKeys: [],
    historyFinalKeys: []
  };
  for (const item of plan) {
    const key = qualityFinalKey(item);
    keys[`${item.layer}FinalKeys`].push(key);
  }
  for (const key of Object.keys(keys)) Object.freeze(keys[key]);
  return Object.freeze(keys);
}

function planBasis({
  finalKeys,
  sourceGroundingChecksum,
  sentinelContentChecksum,
  compiledCoverageChecksum,
  historyManifest,
  itemsChecksum
}) {
  return {
    version: 1,
    planType: PLAN_TYPE,
    finalKeys,
    commitments: {
      sourceGroundingChecksum,
      sentinelContentChecksum,
      coverageContentChecksum: compiledCoverageChecksum,
      historyScenesChecksum: historyManifest.scenesChecksum,
      itemsChecksum
    },
    historyManifest
  };
}

export function buildVerifiedQualityReplayPlan({ compiledSuite, historyScenes, historyManifest } = {}) {
  if (!isVerifiedCompiledQualitySuite(compiledSuite)) {
    throw new Error('verified compiled quality suite required');
  }
  assertHistoryManifest(historyScenes, historyManifest);
  const planItems = buildQualityReplayPlan({
    sentinelSeeds: compiledSuite.sentinelSeeds,
    coverageScenes: compiledSuite.coverageScenes,
    historyScenes
  });
  const finalKeys = finalKeysForPlan(planItems);
  const sourceGroundingChecksum = contentHash(compiledSuite.sourceGroundingIndex);
  const sentinelContentChecksum = contentHash(compiledSuite.sentinelSeeds);
  const compiledCoverageChecksum = contentHash(compiledSuite.coverageScenes);
  const frozenItems = deepFreezeClone(planItems);
  const frozenHistoryManifest = deepFreezeClone(historyManifest);
  const itemsChecksum = contentHash(frozenItems);
  const basis = planBasis({
    finalKeys,
    sourceGroundingChecksum,
    sentinelContentChecksum,
    compiledCoverageChecksum,
    historyManifest: frozenHistoryManifest,
    itemsChecksum
  });
  return deepFreezeClone({
    version: 1,
    planType: PLAN_TYPE,
    items: frozenItems,
    finalKeys,
    commitments: {
      sourceGroundingChecksum,
      sentinelContentChecksum,
      coverageContentChecksum: compiledCoverageChecksum,
      historyScenesChecksum: frozenHistoryManifest.scenesChecksum,
      itemsChecksum
    },
    historyManifest: frozenHistoryManifest,
    planChecksum: contentHash(basis)
  });
}

export function assertVerifiedQualityReplayPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some(key => !PLAN_KEYS.has(key))
    || Object.keys(plan).length !== PLAN_KEYS.size
    || plan.version !== 1 || plan.planType !== PLAN_TYPE || !Array.isArray(plan.items)) {
    throw new Error('verified quality replay plan required');
  }
  if (!plan.commitments || Object.keys(plan.commitments).some(key => !COMMITMENT_KEYS.has(key))
    || Object.keys(plan.commitments).length !== COMMITMENT_KEYS.size
    || Object.values(plan.commitments).some(value => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error('quality replay commitment shape conflict');
  }
  assertHistoryManifestShape(plan.historyManifest);
  const recomputedKeys = finalKeysForPlan(plan.items);
  if (canonicalJson(recomputedKeys) !== canonicalJson(plan.finalKeys)) {
    throw new Error('quality replay final key authority conflict');
  }
  const itemsChecksum = contentHash(plan.items);
  if (plan.commitments.itemsChecksum !== itemsChecksum
    || plan.commitments.historyScenesChecksum !== plan.historyManifest.scenesChecksum) {
    throw new Error('quality replay content checksum/authority conflict');
  }
  const basis = planBasis({
    finalKeys: recomputedKeys,
    sourceGroundingChecksum: plan.commitments.sourceGroundingChecksum,
    sentinelContentChecksum: plan.commitments.sentinelContentChecksum,
    compiledCoverageChecksum: plan.commitments.coverageContentChecksum,
    historyManifest: plan.historyManifest,
    itemsChecksum
  });
  if (plan.planChecksum !== contentHash(basis)) {
    throw new Error('quality replay plan checksum conflict');
  }
  return plan;
}

export function expectedFinalKeysProjection(plan) {
  const verified = assertVerifiedQualityReplayPlan(plan);
  return deepFreezeClone({
    version: 1,
    planType: PLAN_TYPE,
    planChecksum: verified.planChecksum,
    sourceGroundingChecksum: verified.commitments.sourceGroundingChecksum,
    items: verified.items,
    finalKeys: verified.finalKeys,
    commitments: verified.commitments,
    historyManifest: verified.historyManifest
  });
}

export function assertVerifiedExpectedFinalKeys(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)
    || Object.keys(projection).some(key => !EXPECTED_PROJECTION_KEYS.has(key))
    || Object.keys(projection).length !== EXPECTED_PROJECTION_KEYS.size
    || projection.version !== 1 || projection.planType !== PLAN_TYPE
    || !Array.isArray(projection.items)) {
    throw new Error('verified expected final key projection required');
  }
  assertHistoryManifestShape(projection.historyManifest);
  if (!projection.commitments || Object.keys(projection.commitments).some(key => !COMMITMENT_KEYS.has(key))
    || Object.keys(projection.commitments).length !== COMMITMENT_KEYS.size
    || projection.commitments.sourceGroundingChecksum !== projection.sourceGroundingChecksum
    || projection.commitments.historyScenesChecksum !== projection.historyManifest.scenesChecksum) {
    throw new Error('verified expected final key projection conflict');
  }
  assertVerifiedQualityReplayPlan({
    version: projection.version,
    planType: projection.planType,
    items: projection.items,
    finalKeys: projection.finalKeys,
    commitments: projection.commitments,
    historyManifest: projection.historyManifest,
    planChecksum: projection.planChecksum
  });
  return projection;
}

export function writeQualityReplayPlanArtifact(plan, artifactPath) {
  const verified = assertVerifiedQualityReplayPlan(plan);
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('quality plan artifact path required');
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
  return artifactPath;
}

export function loadQualityReplayPlanArtifact({
  artifactPath,
  rootDir = process.cwd(),
  historyScenes,
  historyManifest
} = {}) {
  if (typeof artifactPath !== 'string' || !artifactPath || !existsSync(artifactPath)) {
    throw new Error('quality plan artifact not found');
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assertVerifiedQualityReplayPlan(artifact);
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  const recomputed = buildVerifiedQualityReplayPlan({
    compiledSuite: suite,
    historyScenes,
    historyManifest
  });
  if (canonicalJson(artifact) !== canonicalJson(recomputed)) {
    throw new Error('quality plan artifact/source commitment conflict');
  }
  return recomputed;
}

export function appendQualityAttempt(attempts, attempt) {
  if (!Array.isArray(attempts)) throw new Error('quality attempts array required');
  const key = qualityAttemptKey(attempt);
  if (attempts.some(existing => qualityAttemptKey(existing) === key)) {
    throw new Error('duplicate attempt identity');
  }
  const finalKey = qualityFinalKey(attempt);
  const siblings = attempts.filter(existing => qualityFinalKey(existing) === finalKey);
  const expectedIndex = siblings.length;
  if (attempt.attemptIndex !== expectedIndex) {
    throw new Error('quality attempt index gap');
  }
  attempts.push({ ...attempt });
  return attempt;
}

// Task6 v2 replay artifact contract.  This is intentionally the only
// canonical JSONL validator/serializer; callers must not invent projections.
const V2_RECORD_TYPES = Object.freeze([
  'run', 'execution', 'phase', 'model_call', 'judgment', 'final', 'provenance'
]);
const V2_RECORD_SET = new Set(V2_RECORD_TYPES);
const V2_SHA = /^[0-9a-f]{64}$/;
const V2_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const V2_PHASES = Object.freeze([
  'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
]);
const V2_PHASE_SET = new Set(V2_PHASES);

function v2Object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`quality replay v2 ${label} must be object`);
  }
  return value;
}

function v2Keys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`quality replay v2 ${label} keys conflict`);
  }
}

function v2Safe(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`quality replay v2 ${label} time conflict`);
}

function v2Sha(value, label) {
  if (typeof value !== 'string' || !V2_SHA.test(value)) throw new Error(`quality replay v2 ${label} checksum conflict`);
}

function v2Canonical(value, label) {
  try { canonicalJson(value); } catch { throw new Error(`quality replay v2 ${label} JSON conflict`); }
}

const V2_FINAL_KEYS = Object.freeze([
  'version', 'finalKey', 'subjectType', 'subjectChecksum', 'stablePhase', 'candidatePhase',
  'blindInputChecksum', 'primary', 'secondary', 'comparison'
]);
const V2_FINAL_PHASE_KEYS = Object.freeze(['inputChecksum', 'outputChecksum']);
const V2_FINAL_JUDGMENT_KEYS = Object.freeze([
  'evaluatorId', 'evaluatorVersion', 'inputChecksum', 'output', 'outputChecksum'
]);
const V2_FINAL_OUTPUT_KEYS = Object.freeze(['version', 'scores', 'preference', 'findings', 'unresolved']);
const V2_FINAL_COMPARISON_KEYS = Object.freeze([
  'version', 'differences', 'manualReview', 'unresolved', 'agreedCriticalFindings'
]);
const V2_QUALITY_DIMENSIONS = Object.freeze([
  'socialUnderstanding', 'agency', 'relationshipParticipation',
  'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'
]);
const V2_DIFFERENCES = new Set(['scores', 'preference', 'unresolved', 'findings']);

function v2ExactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`quality replay v2 ${label} shape conflict`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`quality replay v2 ${label} keys conflict`);
  }
}

function v2Finding(value) {
  v2ExactKeys(value, ['code', 'severity', 'owner', 'summary', 'critical'], 'finding');
  if (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(value.code)
    || !['critical', 'warning', 'info'].includes(value.severity)
    || typeof value.owner !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.owner)
    || typeof value.summary !== 'string' || !value.summary
    || typeof value.critical !== 'boolean') {
    throw new Error('quality replay v2 finding conflict');
  }
}

function v2JudgmentOutput(value) {
  v2ExactKeys(value, V2_FINAL_OUTPUT_KEYS, 'judgment output');
  if (value.version !== 1 || !value.scores || typeof value.scores !== 'object'
    || Array.isArray(value.scores) || !Array.isArray(value.findings)
    || !['A', 'B', 'tie', 'unresolved'].includes(value.preference)
    || typeof value.unresolved !== 'boolean') {
    throw new Error('quality replay v2 judgment output conflict');
  }
  v2ExactKeys(value.scores, V2_QUALITY_DIMENSIONS, 'judgment scores');
  for (const dimension of V2_QUALITY_DIMENSIONS) {
    if (!Number.isSafeInteger(value.scores[dimension]) || value.scores[dimension] < 1 || value.scores[dimension] > 5) {
      throw new Error('quality replay v2 score conflict');
    }
  }
  value.findings.forEach(v2Finding);
}

function v2Judgment(value, label) {
  v2ExactKeys(value, V2_FINAL_JUDGMENT_KEYS, label);
  for (const key of ['evaluatorId', 'evaluatorVersion']) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`quality replay v2 ${label} identity conflict`);
  }
  v2Sha(value.inputChecksum, `${label}.input`);
  v2JudgmentOutput(value.output);
  v2Sha(value.outputChecksum, `${label}.output`);
  if (value.outputChecksum !== contentHash(value.output)) throw new Error(`quality replay v2 ${label}.output checksum conflict`);
}

function v2FinalValue(value, expectedFinalKey, phaseRows, callRows, judgmentRows) {
  v2ExactKeys(value, V2_FINAL_KEYS, 'final value');
  if (value.version !== 1 || value.finalKey !== expectedFinalKey || !['turn', 'life_planning'].includes(value.subjectType)) {
    throw new Error('quality replay v2 final identity conflict');
  }
  v2Sha(value.subjectChecksum, 'final subject');
  v2Sha(value.blindInputChecksum, 'final blind input');
  for (const side of ['stablePhase', 'candidatePhase']) {
    v2ExactKeys(value[side], V2_FINAL_PHASE_KEYS, `final ${side}`);
    v2Sha(value[side].inputChecksum, `final ${side}.input`);
    v2Sha(value[side].outputChecksum, `final ${side}.output`);
    const phaseName = side === 'stablePhase' ? 'stable_execution' : 'candidate_execution';
    const phase = phaseRows.find(row => row.phase === phaseName);
    if (!phase || phase.subjectChecksum !== value.subjectChecksum
      || phase.inputChecksum !== value[side].inputChecksum || phase.outputChecksum !== value[side].outputChecksum) {
      throw new Error('quality replay v2 final phase authority conflict');
    }
  }
  v2Judgment(value.primary, 'primary judgment');
  v2Judgment(value.secondary, 'secondary judgment');
  if (value.primary.inputChecksum !== value.blindInputChecksum
    || value.secondary.inputChecksum !== value.blindInputChecksum
    || value.primary.evaluatorId === value.secondary.evaluatorId) {
    throw new Error('quality replay v2 blind judgment identity conflict');
  }
  const expectedCalls = ['evaluator_primary', 'evaluator_secondary'].map(phase => {
    const owned = callRows.filter(row => row.phase === phase && row.state === 'succeeded');
    if (!owned.length) throw new Error('quality replay v2 evaluator call missing');
    return owned.reduce((latest, row) => (latest === null || row.ordinal > latest.ordinal ? row : latest), null);
  });
  for (const call of expectedCalls) {
    if (!call.request || typeof call.request.input !== 'string'
      || call.requestChecksum !== contentHash(call.request)) throw new Error('quality replay v2 evaluator request conflict');
    let requestInput;
    try { requestInput = JSON.parse(call.request.input); } catch { throw new Error('quality replay v2 evaluator request conflict'); }
    if (contentHash(requestInput) !== value.blindInputChecksum) throw new Error('quality replay v2 evaluator blind input conflict');
  }
  const primaryRow = judgmentRows.find(row => row.phase === 'evaluator_primary');
  const secondaryRow = judgmentRows.find(row => row.phase === 'evaluator_secondary');
  if (!primaryRow || !secondaryRow
    || primaryRow.inputChecksum !== value.primary.inputChecksum
    || secondaryRow.inputChecksum !== value.secondary.inputChecksum
    || primaryRow.outputChecksum !== value.primary.outputChecksum
    || secondaryRow.outputChecksum !== value.secondary.outputChecksum
    || primaryRow.evaluatorId !== value.primary.evaluatorId
    || secondaryRow.evaluatorId !== value.secondary.evaluatorId
    || primaryRow.evaluatorVersion !== value.primary.evaluatorVersion
    || secondaryRow.evaluatorVersion !== value.secondary.evaluatorVersion
    || canonicalJson(primaryRow.output) !== canonicalJson(value.primary.output)
    || canonicalJson(secondaryRow.output) !== canonicalJson(value.secondary.output)) {
    throw new Error('quality replay v2 judgment/final join conflict');
  }
  for (const phaseName of ['evaluator_primary', 'evaluator_secondary']) {
    const phaseRow = phaseRows.find(row => row.phase === phaseName);
    const judgmentRow = judgmentRows.find(row => row.phase === phaseName);
    if (!phaseRow || !judgmentRow
      || phaseRow.outputChecksum !== judgmentRow.outputChecksum
      || canonicalJson(phaseRow.output) !== canonicalJson(judgmentRow.output)) {
      throw new Error('quality replay v2 evaluator phase/judgment output join conflict');
    }
  }
  v2ExactKeys(value.comparison, V2_FINAL_COMPARISON_KEYS, 'final comparison');
  if (value.comparison.version !== 1 || !Array.isArray(value.comparison.differences)
    || typeof value.comparison.manualReview !== 'boolean' || typeof value.comparison.unresolved !== 'boolean'
    || !Array.isArray(value.comparison.agreedCriticalFindings)
    || new Set(value.comparison.differences).size !== value.comparison.differences.length
    || value.comparison.differences.some(item => !V2_DIFFERENCES.has(item))) {
    throw new Error('quality replay v2 comparison conflict');
  }
  value.comparison.agreedCriticalFindings.forEach(v2Finding);
  const differences = [];
  if (canonicalJson(value.primary.output.scores) !== canonicalJson(value.secondary.output.scores)) differences.push('scores');
  if (value.primary.output.preference !== value.secondary.output.preference) differences.push('preference');
  if (value.primary.output.unresolved !== value.secondary.output.unresolved) differences.push('unresolved');
  if (canonicalJson(value.primary.output.findings) !== canonicalJson(value.secondary.output.findings)) differences.push('findings');
  if (canonicalJson(differences) !== canonicalJson(value.comparison.differences)
    || value.comparison.manualReview !== (differences.length > 0 || value.primary.output.unresolved || value.secondary.output.unresolved)
    || value.comparison.unresolved !== (value.primary.output.unresolved || value.secondary.output.unresolved)) {
    throw new Error('quality replay v2 comparison derivation conflict');
  }
}

function v2FinalKeys(plan) {
  if (!plan || typeof plan !== 'object') return null;
  if (Array.isArray(plan.finalKeys)) return [...plan.finalKeys];
  if (plan.finalKeys && typeof plan.finalKeys === 'object') {
    return Object.values(plan.finalKeys).flatMap(value => Array.isArray(value) ? value : []);
  }
  return null;
}

function v2AssertRecordShape(row) {
  v2Object(row, 'row');
  if (row.schemaVersion !== 2 || !V2_RECORD_SET.has(row.recordType)) {
    throw new Error('quality replay v2 record type/schema conflict');
  }
  if (typeof row.runId !== 'string' || !V2_UUID.test(row.runId)) {
    throw new Error('quality replay v2 run identity conflict');
  }
  if (row.recordType === 'run') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'header', 'headerChecksum', 'state', 'createdAt', 'finalizedAt'], 'run');
    v2Object(row.header, 'header'); v2Sha(row.headerChecksum, 'header');
    if (row.headerChecksum !== contentHash(row.header) || row.state !== 'finalized') throw new Error('quality replay v2 run conflict');
    v2Safe(row.createdAt, 'run.createdAt'); v2Safe(row.finalizedAt, 'run.finalizedAt');
    if (row.finalizedAt < row.createdAt) throw new Error('quality replay v2 run time conflict');
  } else if (row.recordType === 'execution') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'finalKey', 'subjectType', 'subjectChecksum', 'stablePhase', 'candidatePhase', 'executionChecksum'], 'execution');
    if (typeof row.finalKey !== 'string' || !row.finalKey || !['turn', 'life_planning'].includes(row.subjectType)) throw new Error('quality replay v2 execution identity conflict');
    v2Sha(row.subjectChecksum, 'execution.subject');
    for (const side of ['stablePhase', 'candidatePhase']) {
      v2Object(row[side], `execution.${side}`); v2Keys(row[side], ['inputChecksum', 'outputChecksum'], `execution.${side}`);
      v2Sha(row[side].inputChecksum, `${side}.input`); v2Sha(row[side].outputChecksum, `${side}.output`);
    }
    v2Sha(row.executionChecksum, 'execution');
    if (row.executionChecksum !== contentHash({
      finalKey: row.finalKey, subjectType: row.subjectType, subjectChecksum: row.subjectChecksum,
      stablePhase: row.stablePhase, candidatePhase: row.candidatePhase
    })) throw new Error('quality replay v2 execution checksum conflict');
  } else if (row.recordType === 'phase') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'finalKey', 'phase', 'state', 'subjectChecksum', 'authorityInputChecksum', 'input', 'inputChecksum', 'output', 'outputChecksum', 'createdAt', 'startingAt', 'runningAt', 'updatedAt'], 'phase');
    if (typeof row.finalKey !== 'string' || !V2_PHASE_SET.has(row.phase) || row.state !== 'succeeded') throw new Error('quality replay v2 phase state conflict');
    v2Sha(row.subjectChecksum, 'phase.subject'); v2Sha(row.authorityInputChecksum, 'phase.authority');
    v2Canonical(row.input, 'phase.input'); v2Sha(row.inputChecksum, 'phase.input');
    if (row.inputChecksum !== contentHash({ subjectChecksum: row.subjectChecksum, authorityInputChecksum: row.authorityInputChecksum, input: row.input })) throw new Error('quality replay v2 phase input checksum conflict');
    v2Canonical(row.output, 'phase.output'); v2Sha(row.outputChecksum, 'phase.output');
    if (row.outputChecksum !== contentHash(row.output)) throw new Error('quality replay v2 phase output checksum conflict');
    for (const key of ['createdAt', 'startingAt', 'runningAt', 'updatedAt']) v2Safe(row[key], `phase.${key}`);
    if (!(row.createdAt <= row.startingAt && row.startingAt <= row.runningAt && row.runningAt <= row.updatedAt)) throw new Error('quality replay v2 phase time conflict');
  } else if (row.recordType === 'model_call') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'finalKey', 'phase', 'ordinal', 'state', 'role', 'callId', 'clientUserMessageId', 'threadId', 'turnId', 'baseline', 'baselineChecksum', 'request', 'requestChecksum', 'model', 'effort', 'schemaChecksum', 'output', 'outputChecksum', 'runningAt', 'createdAt', 'updatedAt'], 'model_call');
    if (typeof row.finalKey !== 'string' || !V2_PHASE_SET.has(row.phase) || row.state !== 'succeeded' || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0) throw new Error('quality replay v2 model call identity conflict');
    for (const key of ['role', 'callId', 'clientUserMessageId', 'threadId', 'model', 'effort']) if (typeof row[key] !== 'string' || !row[key]) throw new Error(`quality replay v2 model call ${key} conflict`);
    v2Canonical(row.baseline, 'model baseline'); v2Sha(row.baselineChecksum, 'model baseline');
    if (row.baselineChecksum !== contentHash(row.baseline)) throw new Error('quality replay v2 baseline checksum conflict');
    v2Canonical(row.request, 'model request'); v2Sha(row.requestChecksum, 'model request');
    if (row.requestChecksum !== contentHash(row.request)) throw new Error('quality replay v2 request checksum conflict');
    v2Sha(row.schemaChecksum, 'model schema'); v2Canonical(row.output, 'model output'); v2Sha(row.outputChecksum, 'model output');
    if (row.outputChecksum !== contentHash(row.output)) throw new Error('quality replay v2 model output checksum conflict');
    for (const key of ['runningAt', 'createdAt', 'updatedAt']) v2Safe(row[key], `model.${key}`);
    if (row.createdAt > row.runningAt || row.runningAt > row.updatedAt) throw new Error('quality replay v2 model time conflict');
    if (typeof row.turnId !== 'string' || !row.turnId) throw new Error('quality replay v2 model turn identity conflict');
  } else if (row.recordType === 'judgment') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'finalKey', 'phase', 'evaluatorId', 'evaluatorVersion', 'inputChecksum', 'output', 'outputChecksum', 'judgmentChecksum'], 'judgment');
    if (typeof row.finalKey !== 'string' || !['evaluator_primary', 'evaluator_secondary'].includes(row.phase) || typeof row.evaluatorId !== 'string' || typeof row.evaluatorVersion !== 'string') throw new Error('quality replay v2 judgment identity conflict');
    v2Sha(row.inputChecksum, 'judgment input'); v2Canonical(row.output, 'judgment output'); v2Sha(row.outputChecksum, 'judgment output');
    v2JudgmentOutput(row.output);
    if (row.outputChecksum !== contentHash(row.output) || row.judgmentChecksum !== contentHash({ finalKey: row.finalKey, phase: row.phase, evaluatorId: row.evaluatorId, evaluatorVersion: row.evaluatorVersion, inputChecksum: row.inputChecksum, output: row.output, outputChecksum: row.outputChecksum })) throw new Error('quality replay v2 judgment checksum conflict');
    v2Sha(row.judgmentChecksum, 'judgment');
  } else if (row.recordType === 'final') {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'finalKey', 'value', 'valueChecksum', 'executionChecksum', 'finalizedAt'], 'final');
    if (typeof row.finalKey !== 'string' || !row.finalKey) throw new Error('quality replay v2 final identity conflict');
    v2Canonical(row.value, 'final value'); v2Sha(row.valueChecksum, 'final value'); v2Sha(row.executionChecksum, 'final execution'); v2Safe(row.finalizedAt, 'finalizedAt');
    if (row.valueChecksum !== contentHash(row.value)) throw new Error('quality replay v2 final checksum conflict');
  } else {
    v2Keys(row, ['schemaVersion', 'recordType', 'runId', 'recordCounts', 'recordsChecksum', 'provenanceChecksum'], 'provenance');
    v2Object(row.recordCounts, 'record counts');
    v2Keys(row.recordCounts, ['run', 'execution', 'phase', 'modelCall', 'judgment', 'final'], 'record counts');
    for (const value of Object.values(row.recordCounts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('quality replay v2 record count conflict');
    v2Sha(row.recordsChecksum, 'records'); v2Sha(row.provenanceChecksum, 'provenance');
  }
}

export function validateQualityReplayV2Rows({ rows, plan, expectedHeader } = {}) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('quality replay v2 rows required');
  rows.forEach(v2AssertRecordShape);
  const runRows = rows.filter(row => row.recordType === 'run');
  const provenanceRows = rows.filter(row => row.recordType === 'provenance');
  if (runRows.length !== 1 || provenanceRows.length !== 1) throw new Error('quality replay v2 run/provenance cardinality conflict');
  const runId = runRows[0].runId;
  if (rows.some(row => row.runId !== runId)) throw new Error('quality replay v2 run identity conflict');
  if (expectedHeader !== undefined && canonicalJson(expectedHeader) !== canonicalJson(runRows[0].header)) throw new Error('quality replay v2 header conflict');
  const expectedFinalKeys = v2FinalKeys(plan);
  const finals = rows.filter(row => row.recordType === 'final');
  const executions = rows.filter(row => row.recordType === 'execution');
  if (expectedFinalKeys && (finals.length !== expectedFinalKeys.length || new Set(finals.map(row => row.finalKey)).size !== finals.length
    || finals.some((row, index) => row.finalKey !== expectedFinalKeys[index]))) throw new Error('quality replay v2 final key set/order conflict');
  if (new Set(finals.map(row => row.finalKey)).size !== finals.length) throw new Error('quality replay v2 duplicate final conflict');
  if (new Set(executions.map(row => row.finalKey)).size !== executions.length || executions.some(row => !finals.some(final => final.finalKey === row.finalKey))
    || (expectedFinalKeys && executions.some((row, index) => row.finalKey !== expectedFinalKeys[index]))) throw new Error('quality replay v2 execution join/order conflict');
  const phaseRows = rows.filter(row => row.recordType === 'phase');
  const callRows = rows.filter(row => row.recordType === 'model_call');
  const judgmentRows = rows.filter(row => row.recordType === 'judgment');
  if (expectedFinalKeys) {
    const expectedPhaseIdentity = expectedFinalKeys.flatMap(finalKey => V2_PHASES.map(phase => `${finalKey}|${phase}`));
    const actualPhaseIdentity = phaseRows.map(row => `${row.finalKey}|${row.phase}`);
    if (canonicalJson(actualPhaseIdentity) !== canonicalJson(expectedPhaseIdentity)) throw new Error('quality replay v2 phase order/owner conflict');
    const expectedJudgmentIdentity = expectedFinalKeys.flatMap(finalKey => ['evaluator_primary', 'evaluator_secondary']
      .map(phase => `${finalKey}|${phase}`));
    const actualJudgmentIdentity = judgmentRows.map(row => `${row.finalKey}|${row.phase}`);
    if (canonicalJson(actualJudgmentIdentity) !== canonicalJson(expectedJudgmentIdentity)) throw new Error('quality replay v2 judgment order/owner conflict');
    const expectedCallIdentity = [];
    for (const finalKey of expectedFinalKeys) {
      for (const phase of V2_PHASES) {
        const group = callRows.filter(row => row.finalKey === finalKey && row.phase === phase);
        if (!group.length || group.some((row, index) => row.ordinal !== index)) throw new Error('quality replay v2 model call order/ordinal conflict');
        expectedCallIdentity.push(...group.map(row => `${row.finalKey}|${row.phase}|${row.ordinal}`));
      }
    }
    const actualCallIdentity = callRows.map(row => `${row.finalKey}|${row.phase}|${row.ordinal}`);
    if (canonicalJson(actualCallIdentity) !== canonicalJson(expectedCallIdentity)) throw new Error('quality replay v2 model call order/owner conflict');
  }
  for (const final of finals) {
    if (final.finalizedAt > runRows[0].finalizedAt) throw new Error('quality replay v2 final time conflict');
    const execution = executions.find(row => row.finalKey === final.finalKey);
    if (!execution || final.executionChecksum !== execution.executionChecksum) throw new Error('quality replay v2 final execution join conflict');
    const ownedPhases = phaseRows.filter(row => row.finalKey === final.finalKey);
    if (ownedPhases.length !== V2_PHASES.length || new Set(ownedPhases.map(row => row.phase)).size !== V2_PHASES.length) throw new Error('quality replay v2 phase cardinality conflict');
    for (const phase of V2_PHASES) {
      const phaseRow = ownedPhases.find(row => row.phase === phase);
      if (!phaseRow || phaseRow.updatedAt > final.finalizedAt) throw new Error('quality replay v2 phase/final time conflict');
      const ownedCalls = callRows.filter(row => row.finalKey === final.finalKey && row.phase === phase);
      if (ownedCalls.length === 0 || ownedCalls.some(row => row.state !== 'succeeded')
        || ownedCalls.some((row, index) => row.ordinal !== index || row.updatedAt > phaseRow.updatedAt)) throw new Error('quality replay v2 model call ownership conflict');
    }
    const stablePhase = ownedPhases.find(row => row.phase === 'stable_execution');
    const candidatePhase = ownedPhases.find(row => row.phase === 'candidate_execution');
    if (execution.subjectChecksum !== stablePhase.subjectChecksum || candidatePhase.subjectChecksum !== execution.subjectChecksum
      || execution.stablePhase.inputChecksum !== stablePhase.inputChecksum
      || execution.stablePhase.outputChecksum !== stablePhase.outputChecksum
      || execution.candidatePhase.inputChecksum !== candidatePhase.inputChecksum
      || execution.candidatePhase.outputChecksum !== candidatePhase.outputChecksum) {
      throw new Error('quality replay v2 execution phase authority conflict');
    }
    const ownedJudgments = judgmentRows.filter(row => row.finalKey === final.finalKey);
    if (ownedJudgments.length !== 2 || new Set(ownedJudgments.map(row => row.phase)).size !== 2) throw new Error('quality replay v2 judgment cardinality conflict');
    v2FinalValue(final.value, final.finalKey, ownedPhases,
      callRows.filter(row => row.finalKey === final.finalKey), ownedJudgments);
  }
  const counts = { run: 1, execution: executions.length, phase: rows.filter(row => row.recordType === 'phase').length, modelCall: rows.filter(row => row.recordType === 'model_call').length, judgment: rows.filter(row => row.recordType === 'judgment').length, final: finals.length };
  const provenance = provenanceRows[0];
  if (canonicalJson(provenance.recordCounts) !== canonicalJson(counts)) throw new Error('quality replay v2 provenance counts conflict');
  const body = rows.filter(row => row.recordType !== 'provenance');
  if (provenance.recordsChecksum !== contentHash(body)) throw new Error('quality replay v2 records checksum conflict');
  if (provenance.provenanceChecksum !== contentHash({ runId, headerChecksum: runRows[0].headerChecksum, recordCounts: counts, recordsChecksum: provenance.recordsChecksum })) throw new Error('quality replay v2 provenance checksum conflict');
  const order = rows.map(row => V2_RECORD_TYPES.indexOf(row.recordType));
  if (order.some((value, index) => index > 0 && value < order[index - 1])) throw new Error('quality replay v2 record order conflict');
  return Object.freeze({
    evidenceClass: 'quality_replay_v2', evidenceEligible: true, run: runRows[0], header: runRows[0].header, executions,
    phases: rows.filter(row => row.recordType === 'phase'), modelCalls: rows.filter(row => row.recordType === 'model_call'),
    judgments: rows.filter(row => row.recordType === 'judgment'), finals, provenance: provenanceRows[0], rows: [...rows]
  });
}

export function canonicalQualityReplayV2Jsonl({ rows, plan, expectedHeader } = {}) {
  const validated = validateQualityReplayV2Rows({ rows, plan, expectedHeader });
  return `${validated.rows.map(row => canonicalJson(row)).join('\n')}\n`;
}
