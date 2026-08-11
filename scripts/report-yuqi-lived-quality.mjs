import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { aggregateQualityGate, compileSceneExecutionInput, normalizeBlindEvaluation } from '../yuqi-runtime/src/quality-evaluator.mjs';
import { supportsPipelineVersion } from '../yuqi-runtime/src/release-executor.mjs';
import { loadLocalHistoryManifest, loadLocalHistoryScenes } from './run-yuqi-lived-quality-replay.mjs';
import { presetHistoryArtifactPaths } from './compile-yuqi-preset-history-scenes.mjs';
import { loadQualityReplayPlanArtifact, validateQualityReplayV2Rows } from '../yuqi-runtime/src/quality-replay.mjs';
import {
  assertVerifiedQualityReplayPlan,
  expectedFinalKeysProjection
} from '../yuqi-runtime/src/quality-replay.mjs';

const RELEASE_FIELDS = Object.freeze([
  'pipelineVersion', 'presetVersion', 'cognitionSchemaVersion', 'expressionSchemaVersion',
  'evaluatorVersion', 'modelProfile', 'componentManifest', 'createdAt'
]);

const CANDIDATE_RELEASE_FIELDS = Object.freeze([...RELEASE_FIELDS, 'releaseId', 'releaseChecksum']);
const ARTIFACT_MATERIALIZATION_TOKEN = Symbol('quality-artifact-materialization');

function assertReleaseFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('release definition object required');
  if (Object.keys(value).some(key => !RELEASE_FIELDS.includes(key))) {
    throw new Error('caller-supplied release identity is not accepted');
  }
  for (const key of RELEASE_FIELDS.filter(key => key !== 'componentManifest' && key !== 'createdAt')) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`release field ${key}`);
  }
  if (!supportsPipelineVersion(value.pipelineVersion)) {
    throw new Error(`unsupported release executor pipeline: ${value.pipelineVersion}`);
  }
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0) throw new Error('release createdAt');
  if (!value.componentManifest || typeof value.componentManifest !== 'object'
    || Array.isArray(value.componentManifest)) throw new Error('release component manifest');
}

export function buildCandidateReleaseDefinition(fields) {
  assertReleaseFields(fields);
  const basis = JSON.parse(canonicalJson(fields));
  const releaseChecksum = contentHash(basis);
  return {
    ...basis,
    releaseId: `quality_candidate_${releaseChecksum.slice(0, 16)}`,
    releaseChecksum
  };
}

function verifyCandidateRelease(candidateRelease) {
  if (!candidateRelease || typeof candidateRelease !== 'object') throw new Error('candidate release required');
  if (Object.keys(candidateRelease).some(key => !CANDIDATE_RELEASE_FIELDS.includes(key))) {
    throw new Error('candidate release contains unknown fields');
  }
  const fields = Object.fromEntries(RELEASE_FIELDS.map(key => [key, candidateRelease[key]]));
  const expected = buildCandidateReleaseDefinition(fields);
  if (candidateRelease.releaseId !== expected.releaseId
    || candidateRelease.releaseChecksum !== expected.releaseChecksum) {
    throw new Error('candidate release identity/checksum conflict');
  }
  return expected;
}

const MANUAL_REVIEW_KEYS = new Set([
  'reviewId', 'evalRunId', 'sceneId', 'repeatIndex', 'evidenceFindingIds',
  'decision', 'reason', 'reviewer', 'createdAt'
]);
const MANUAL_DECISIONS = new Set(['confirm', 'downgrade', 'reject_evaluator', 'unresolved']);
const STRUCTURED_ACTION_CODES = new Set([
  'ACTION_TARGET_ESCALATION', 'PAYMENT_OBJECT_MUTATION', 'DUPLICATE_VISIBLE_EFFECT',
  'ILLEGAL_STAGE_TRANSITION'
]);
const REPLAY_PROVENANCE_KEYS = new Set(['executionPairs', 'modelRuns', 'provenanceChecksum', 'sourceHead', 'runId']);
const EXECUTION_PROVENANCE_KEYS = new Set([
  'finalKey', 'sourceHead', 'stableReleaseId', 'stableReleaseChecksum', 'candidateReleaseId',
  'candidateReleaseChecksum', 'executionChecksum', 'stableInputChecksum',
  'candidateInputChecksum', 'dryRun', 'capabilities'
]);
const MODEL_PROVENANCE_KEYS = new Set([
  'finalKey', 'attemptIndex', 'evaluatorId', 'inputChecksum', 'completed'
]);
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MANUAL_V2_DECISIONS = new Set(['accept_primary', 'accept_secondary', 'merge', 'reject_both', 'unresolved']);
const MANUAL_V2_METADATA_KEYS = Object.freeze([
  'schemaVersion', 'recordType', 'runId', 'sourceHead', 'candidateReleaseId',
  'candidateReleaseChecksum', 'planChecksum', 'replayProvenanceChecksum', 'requirementsChecksum'
]);
const MANUAL_V2_REVIEW_KEYS = Object.freeze([
  'schemaVersion', 'recordType', 'runId', 'reviewId', 'finalKey',
  'primaryJudgmentChecksum', 'secondaryJudgmentChecksum', 'executionChecksum',
  'finalValueChecksum', 'evidenceFindingIds', 'decision', 'resolvedOutput', 'reason',
  'reviewer', 'createdAt'
]);
const MANUAL_V2_PROVENANCE_KEYS = Object.freeze([
  'schemaVersion', 'recordType', 'runId', 'recordCounts', 'recordsChecksum', 'manualProvenanceChecksum'
]);

function exactKeysV2(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} closed schema conflict`);
  }
}

function parseV2FinalKey(finalKey) {
  const parts = typeof finalKey === 'string' ? finalKey.split(':') : [];
  if (parts.length !== 3 || !parts[0] || !parts[1] || !/^\d+$/.test(parts[2])) {
    throw new Error('quality replay v2 final key conflict');
  }
  return { layer: parts[0], sceneId: parts[1], repeatIndex: Number(parts[2]) };
}

function manualReviewId({ runId, finalKey, primaryJudgmentChecksum, secondaryJudgmentChecksum, executionChecksum, finalValueChecksum }) {
  return `qreview_${contentHash({
    runId, finalKey, primaryJudgmentChecksum, secondaryJudgmentChecksum, executionChecksum, finalValueChecksum
  }).slice(0, 48)}`;
}

export function validateManualV2Rows(rows, { runId, plan, provenanceRow, sourceHead, candidateRelease, evidence, validated }) {
  if (!Array.isArray(rows) || rows.length < 2) throw new Error('quality manual review v2 rows required');
  const metadata = rows.filter(row => row?.recordType === 'manual_metadata');
  const reviews = rows.filter(row => row?.recordType === 'review');
  const provenance = rows.filter(row => row?.recordType === 'manual_provenance');
  if (metadata.length !== 1 || provenance.length !== 1) throw new Error('quality manual review v2 cardinality conflict');
  exactKeysV2(metadata[0], MANUAL_V2_METADATA_KEYS, 'manual metadata');
  exactKeysV2(provenance[0], MANUAL_V2_PROVENANCE_KEYS, 'manual provenance');
  const meta = metadata[0];
  if (meta.schemaVersion !== 2 || meta.runId !== runId || meta.sourceHead !== sourceHead
    || meta.candidateReleaseId !== candidateRelease.releaseId
    || meta.candidateReleaseChecksum !== candidateRelease.releaseChecksum
    || meta.planChecksum !== plan.planChecksum
    || !isSha256(meta.replayProvenanceChecksum)
    || meta.replayProvenanceChecksum !== provenanceRow.provenanceChecksum
    || !isSha256(meta.requirementsChecksum)) {
    throw new Error('quality manual review v2 binding conflict');
  }
  const projection = expectedFinalKeysProjection(plan);
  const orderedFinalKeys = [
    ...projection.finalKeys.sentinelFinalKeys,
    ...projection.finalKeys.coverageFinalKeys,
    ...projection.finalKeys.historyFinalKeys
  ];
  const finalKeys = new Set(orderedFinalKeys);
  const orderedRequirements = deriveManualV2RequirementsFromValidated(validated, plan);
  const orderedRequirementRows = orderedRequirements.map(requirement => {
    const judgments = validated.judgments.filter(row => row.finalKey === requirement.finalKey);
    return {
      finalKey: requirement.finalKey,
      primaryJudgmentChecksum: judgments.find(row => row.phase === 'evaluator_primary')?.judgmentChecksum,
      secondaryJudgmentChecksum: judgments.find(row => row.phase === 'evaluator_secondary')?.judgmentChecksum,
      executionChecksum: requirement.executionChecksum,
      finalValueChecksum: requirement.finalValueChecksum,
      evidenceFindingIds: requirement.evidenceFindingIds
    };
  });
  const seen = new Set();
  const effectiveOutputs = new Map();
  const requiredFinalKeys = orderedRequirements.map(requirement => requirement.finalKey);
  if (reviews.length !== requiredFinalKeys.length) throw new Error('quality manual review v2 missing or extra review');
  for (const [index, row] of reviews.entries()) {
    exactKeysV2(row, MANUAL_V2_REVIEW_KEYS, 'manual review');
    if (row.schemaVersion !== 2 || row.runId !== runId || row.finalKey !== requiredFinalKeys[index] || !finalKeys.has(row.finalKey)
      || seen.has(row.finalKey) || typeof row.reviewId !== 'string' || !row.reviewId
      || !isSha256(row.primaryJudgmentChecksum) || !isSha256(row.secondaryJudgmentChecksum)
      || !isSha256(row.executionChecksum) || !isSha256(row.finalValueChecksum)
      || !Array.isArray(row.evidenceFindingIds)
      || row.evidenceFindingIds.some(id => typeof id !== 'string' || !id)
      || !MANUAL_V2_DECISIONS.has(row.decision) || typeof row.reason !== 'string' || !row.reason
      || (row.resolvedOutput !== null && (typeof row.resolvedOutput !== 'object' || Array.isArray(row.resolvedOutput)))
      || (['accept_primary', 'accept_secondary', 'merge'].includes(row.decision) && row.resolvedOutput === null)
      || (['reject_both', 'unresolved'].includes(row.decision) && row.resolvedOutput !== null)
      || new Set(row.evidenceFindingIds).size !== row.evidenceFindingIds.length
      || row.reviewer !== 'central_window' || !Number.isSafeInteger(row.createdAt) || row.createdAt < 0) {
      throw new Error('quality manual review v2 row conflict');
    }
    const final = validated.finals.find(item => item.finalKey === row.finalKey);
    const judgments = validated.judgments.filter(item => item.finalKey === row.finalKey);
    if (!final || judgments.length !== 2) throw new Error('quality manual review v2 review join conflict');
    const primary = judgments.find(item => item.phase === 'evaluator_primary');
    const secondary = judgments.find(item => item.phase === 'evaluator_secondary');
    if (!primary || !secondary || row.primaryJudgmentChecksum !== primary.judgmentChecksum
      || row.secondaryJudgmentChecksum !== secondary.judgmentChecksum
      || row.executionChecksum !== final.executionChecksum
      || row.finalValueChecksum !== final.valueChecksum
      || row.reviewId !== manualReviewId({
        runId, finalKey: row.finalKey, primaryJudgmentChecksum: primary.judgmentChecksum,
        secondaryJudgmentChecksum: secondary.judgmentChecksum,
        executionChecksum: final.executionChecksum, finalValueChecksum: final.valueChecksum
      })) {
      throw new Error('quality manual review v2 deterministic binding conflict');
    }
    const requirement = orderedRequirements[index];
    if (!requirement || canonicalJson([...row.evidenceFindingIds]) !== canonicalJson([...requirement.evidenceFindingIds])) {
      throw new Error('quality manual review v2 finding binding conflict');
    }
    const primaryOutput = requirement.primary;
    const secondaryOutput = requirement.secondary;
    let effectiveOutput = null;
    if (row.decision === 'accept_primary' && canonicalJson(row.resolvedOutput) !== canonicalJson(primaryOutput)) {
      throw new Error('quality manual review v2 primary output conflict');
    }
    if (row.decision === 'accept_primary') effectiveOutput = primaryOutput;
    if (row.decision === 'accept_secondary' && canonicalJson(row.resolvedOutput) !== canonicalJson(secondaryOutput)) {
      throw new Error('quality manual review v2 secondary output conflict');
    }
    if (row.decision === 'accept_secondary') effectiveOutput = secondaryOutput;
    if (row.decision === 'merge') {
      try { effectiveOutput = normalizeBlindEvaluation(row.resolvedOutput); } catch (error) {
        throw new Error(`quality manual review v2 merge output conflict: ${error.message}`);
      }
    }
    if (row.decision === 'reject_both' || row.decision === 'unresolved') effectiveOutput = null;
    effectiveOutputs.set(row.finalKey, effectiveOutput);
    seen.add(row.finalKey);
  }
  if (meta.requirementsChecksum !== contentHash(orderedRequirementRows)) {
    throw new Error('quality manual review v2 requirements checksum conflict');
  }
  const body = rows.filter(row => row.recordType !== 'manual_provenance');
  const recordCounts = { manualMetadata: 1, review: reviews.length };
  if (provenance[0].schemaVersion !== 2 || provenance[0].runId !== runId
    || canonicalJson(provenance[0].recordCounts) !== canonicalJson(recordCounts)
    || provenance[0].recordsChecksum !== contentHash(body)
    || provenance[0].manualProvenanceChecksum !== contentHash({
      runId, requirementsChecksum: meta.requirementsChecksum, recordCounts,
      recordsChecksum: provenance[0].recordsChecksum
    })) {
    throw new Error('quality manual review v2 provenance conflict');
  }
  for (const finalKey of orderedFinalKeys) {
    if (requiredFinalKeys.includes(finalKey)) continue;
    const final = validated.finals.find(item => item.finalKey === finalKey);
    const primary = normalizeBlindEvaluation(final?.value?.primary?.output);
    const secondary = normalizeBlindEvaluation(final?.value?.secondary?.output);
    if (canonicalJson(primary) !== canonicalJson(secondary)) {
      throw new Error('quality manual review v2 missing difference review');
    }
    effectiveOutputs.set(finalKey, primary);
  }
  return {
    metadata: meta,
    reviews,
    provenance: provenance[0],
    eligible: reviews.every(row => row.decision !== 'reject_both' && row.decision !== 'unresolved'),
    effectiveOutputs,
    requirements: orderedRequirementRows.map(row => ({
      finalKey: row.finalKey,
      sceneId: parseV2FinalKey(row.finalKey).sceneId,
      repeatIndex: parseV2FinalKey(row.finalKey).repeatIndex,
      evidenceFindingIds: row.evidenceFindingIds,
      executionChecksum: row.executionChecksum,
      finalValueChecksum: row.finalValueChecksum
    }))
  };
}

export function deriveManualV2RequirementsFromValidated(validated, expectedPlan, { includePassingSample = true } = {}) {
  const projection = expectedFinalKeysProjection(expectedPlan);
  const orderedFinalKeys = [
    ...projection.finalKeys.sentinelFinalKeys,
    ...projection.finalKeys.coverageFinalKeys,
    ...projection.finalKeys.historyFinalKeys
  ];
  const planByKey = new Map((expectedPlan?.items || []).map(item => [
    `${item.layer}:${item.sceneId}:${item.repeatIndex}`, item
  ]));
  const requirements = [];
  for (const finalKey of orderedFinalKeys) {
    const final = validated.finals.find(row => row.finalKey === finalKey);
    const primary = final?.value?.primary?.output;
    const secondary = final?.value?.secondary?.output;
    if (!final || !primary || !secondary) throw new Error('quality manual v2 judgment output missing');
    const first = normalizeBlindEvaluation(primary);
    const second = normalizeBlindEvaluation(secondary);
    const findingIds = [...new Set([...first.findings, ...second.findings]
      .filter(finding => finding?.critical === true || finding?.severity === 'critical')
      .map(finding => finding.code)
      .filter(code => typeof code === 'string'))];
    const scoreOne = Object.values(first.scores).some(score => score === 1)
      || Object.values(second.scores).some(score => score === 1);
    const structured = [...first.findings, ...second.findings].some(finding =>
      STRUCTURED_ACTION_CODES.has(finding?.code)
      && (finding?.critical === true || finding?.severity === 'critical'));
    const difference = canonicalJson(first) !== canonicalJson(second)
      || (final.value.comparison?.differences?.length || 0) > 0;
    const parsed = parseV2FinalKey(finalKey);
    const item = planByKey.get(finalKey);
    const sampledPassing = includePassingSample && !findingIds.length && !scoreOne && !structured
      && !difference && isSampledPassingScene({
        kind: sceneKind(item?.scene), sceneId: parsed.sceneId, repeatIndex: parsed.repeatIndex
      });
    if (findingIds.length || scoreOne || structured || difference || sampledPassing) {
      const reasons = [...findingIds];
      if (scoreOne) reasons.push('score_1');
      if (structured) reasons.push('structured_action');
      if (difference) reasons.push('judgment_difference');
      if (sampledPassing) reasons.push('sampled_structured_action');
      requirements.push({
        finalKey,
        sceneId: parsed.sceneId,
        repeatIndex: parsed.repeatIndex,
        evidenceFindingIds: [...new Set(reasons)],
        primary: first,
        secondary: second,
        executionChecksum: final.executionChecksum,
        finalValueChecksum: final.valueChecksum
      });
    }
  }
  return requirements;
}

export function projectV2Evidence(validated, effectiveOutputs = new Map()) {
  const groups = { sentinelRuns: [], coverageRuns: [], historyRuns: [] };
  for (const final of validated.finals) {
    const identity = parseV2FinalKey(final.finalKey);
    const value = final.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('quality replay v2 final value conflict');
    const judgments = validated.judgments.filter(row => row.finalKey === final.finalKey);
    const primaryOutput = value.primary?.output;
    const secondaryOutput = value.secondary?.output;
    const fallbackOutput = canonicalJson(primaryOutput) === canonicalJson(secondaryOutput)
      ? normalizeBlindEvaluation(primaryOutput) : null;
    const effective = effectiveOutputs.has(final.finalKey)
      ? effectiveOutputs.get(final.finalKey)
      : fallbackOutput;
    // reject_both/unresolved intentionally leave no effective output. Keep
    // that row absent so the exact evidence-set gate blocks without choosing
    // either evaluator by default.
    if (!effective) continue;
    const attempts = judgments.map((judgment, index) => ({
      attemptIndex: index,
      evaluatorId: judgment.evaluatorId,
      evaluatorVersion: judgment.evaluatorVersion,
      executionChecksum: final.executionChecksum,
      latencyMs: 0,
      accepted: index === 0,
      unresolved: index !== 0 || effective.unresolved === true
    }));
    const row = {
      ...identity,
      finalized: true,
      scores: effective.scores,
      preference: effective.preference,
      regression: effective.preference === 'A',
      severe: Object.values(effective.scores).some(score => score === 1)
        || effective.findings.some(finding => finding?.critical === true || finding?.severity === 'critical'),
      tie: effective.preference === 'tie',
      unresolved: effective.unresolved,
      structuralRegression: effective.findings.some(finding => finding?.code === 'ILLEGAL_STAGE_TRANSITION'),
      protocolFailure: effective.findings.some(finding => finding?.code === 'DIRECT_REPLY_SKIP'),
      findings: effective.findings,
      executionChecksum: final.executionChecksum,
      latencyMs: Number.isSafeInteger(value.latencyMs) ? value.latencyMs : 0,
      evaluatorVersion: judgments[0]?.evaluatorVersion || 'quality-replay-v2',
      attempts
    };
    const group = identity.layer === 'sentinel' ? groups.sentinelRuns
      : identity.layer === 'history' ? groups.historyRuns : groups.coverageRuns;
    group.push(row);
  }
  return groups;
}

export function projectV2ComparisonSummary(validated, expectedFinalKeys = null) {
  const finals = Array.isArray(validated?.finals) ? validated.finals : [];
  const expected = expectedFinalKeys ? [...expectedFinalKeys] : finals.map(row => row.finalKey);
  if (new Set(expected).size !== expected.length || finals.length !== expected.length
    || finals.some(row => !expected.includes(row.finalKey))) {
    throw new Error('quality v2 comparison final set conflict');
  }
  const summary = {
    decisionCount: finals.length,
    differenceCount: 0,
    comparisonUnresolvedCount: 0,
    comparisonManualReviewCount: 0
  };
  for (const row of finals) {
    const comparison = row?.value?.comparison;
    if (!comparison || typeof comparison !== 'object' || Array.isArray(comparison)
      || !Array.isArray(comparison.differences)
      || typeof comparison.unresolved !== 'boolean'
      || typeof comparison.manualReview !== 'boolean') {
      throw new Error('quality v2 comparison summary conflict');
    }
    if (comparison.differences.length > 0) summary.differenceCount += 1;
    if (comparison.unresolved) summary.comparisonUnresolvedCount += 1;
    if (comparison.manualReview) summary.comparisonManualReviewCount += 1;
  }
  return summary;
}

export function projectV2Provenance(validated) {
  const header = validated?.run?.header;
  const stable = header?.stableRelease;
  const candidate = header?.candidateRelease;
  if (!header || !stable || !candidate || typeof header.sourceHead !== 'string') {
    throw new Error('quality replay v2 provenance release/header missing');
  }
  const executionPairs = validated.executions.map(execution => ({
    finalKey: execution.finalKey,
    sourceHead: header.sourceHead,
    stableReleaseId: stable.releaseId,
    stableReleaseChecksum: stable.releaseChecksum,
    candidateReleaseId: candidate.releaseId,
    candidateReleaseChecksum: candidate.releaseChecksum,
    executionChecksum: execution.executionChecksum,
    stableInputChecksum: execution.stablePhase.inputChecksum,
    candidateInputChecksum: execution.candidatePhase.inputChecksum,
    dryRun: true,
    capabilities: { visible: false, actions: false }
  }));
  if (executionPairs.some(pair => !isSha256(pair.stableInputChecksum)
    || !isSha256(pair.candidateInputChecksum))) {
    throw new Error('quality replay v2 phase input provenance missing');
  }
  const modelRuns = validated.finals.flatMap(final =>
    ['evaluator_primary', 'evaluator_secondary'].map((phase, attemptIndex) => {
      const judgment = validated.judgments.find(row => row.finalKey === final.finalKey && row.phase === phase);
      return { finalKey: final.finalKey, attemptIndex,
        evaluatorId: judgment.evaluatorId, inputChecksum: judgment.inputChecksum, completed: true };
    }));
  const basis = { runId: validated.run.runId, sourceHead: header.sourceHead,
    phaseInputMode: 'v2', executionPairs, modelRuns };
  return { ...basis, provenanceChecksum: contentHash(basis) };
}

function readJsonLinesArtifact(path, label) {
  if (typeof path !== 'string' || !path || !existsSync(path)) throw new Error(`${label} artifact missing`);
  const bytes = readFileSync(path);
  const raw = bytes.toString('utf8');
  const rows = raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
  return { bytes, rows };
}

function artifactSha(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertRunId(value, label = 'runId') {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value)) {
    throw new Error(`${label} identity conflict`);
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function assertQualityReportProvenance(
  provenance,
  { expectedFinalKeys = null, candidateRelease = null, sourceHead = null, allowDistinctPhaseInputs = false } = {}
) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || !(['executionPairs,modelRuns,provenanceChecksum,sourceHead',
      'executionPairs,modelRuns,provenanceChecksum,runId,sourceHead',
      'executionPairs,modelRuns,phaseInputMode,provenanceChecksum,runId,sourceHead'].includes(Object.keys(provenance).sort().join(',')))
    || !Array.isArray(provenance.executionPairs) || !Array.isArray(provenance.modelRuns)
    || provenance.executionPairs.length === 0) {
    throw new Error('replay execution/model provenance required');
  }
  if ((provenance.phaseInputMode !== undefined && provenance.phaseInputMode !== 'v2')
    || !/^[0-9a-f]{40}$/.test(provenance.sourceHead)
    || (sourceHead !== null && provenance.sourceHead !== sourceHead)
    || !isSha256(provenance.provenanceChecksum)) {
    throw new Error('replay source provenance identity conflict');
  }
  if (Object.prototype.hasOwnProperty.call(provenance, 'runId')
    && (typeof provenance.runId !== 'string' || !RUN_ID_PATTERN.test(provenance.runId))) {
    throw new Error('replay run identity conflict');
  }
  const expectedKeys = expectedFinalKeys === null
    ? null
    : [...expectedFinalKeys].sort();
  if (expectedKeys && (new Set(expectedKeys).size !== expectedKeys.length || expectedKeys.length === 0)) {
    throw new Error('replay final key authority conflict');
  }
  const pairKeys = [];
  for (const record of provenance.executionPairs) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== [...EXECUTION_PROVENANCE_KEYS].sort().join(',')
      || typeof record.finalKey !== 'string' || !record.finalKey
      || pairKeys.includes(record.finalKey)
      || (expectedKeys && !expectedKeys.includes(record.finalKey))
      || record.sourceHead !== provenance.sourceHead
      || typeof record.stableReleaseId !== 'string' || !record.stableReleaseId
      || !isSha256(record.stableReleaseChecksum)
      || typeof record.candidateReleaseId !== 'string' || !record.candidateReleaseId
      || !isSha256(record.candidateReleaseChecksum)
      || !isSha256(record.executionChecksum)
      || !isSha256(record.stableInputChecksum)
      || !isSha256(record.candidateInputChecksum)
      || (!(allowDistinctPhaseInputs || provenance.phaseInputMode === 'v2')
        && (record.stableInputChecksum !== record.executionChecksum
          || record.candidateInputChecksum !== record.executionChecksum))
      || record.dryRun !== true
      || !record.capabilities || Object.keys(record.capabilities).sort().join(',') !== 'actions,visible'
      || record.capabilities.actions !== false || record.capabilities.visible !== false) {
      throw new Error('execution provenance authority conflict');
    }
    if (candidateRelease && (record.candidateReleaseId !== candidateRelease.releaseId
      || record.candidateReleaseChecksum !== candidateRelease.releaseChecksum)) {
      throw new Error('execution candidate provenance conflict');
    }
    pairKeys.push(record.finalKey);
  }
  pairKeys.sort();
  if (expectedKeys && pairKeys.join('\u0000') !== expectedKeys.join('\u0000')) {
    throw new Error('execution provenance key set conflict');
  }
  const provenanceBasis = {
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    sourceHead: provenance.sourceHead,
    ...(provenance.phaseInputMode ? { phaseInputMode: provenance.phaseInputMode } : {}),
    executionPairs: provenance.executionPairs,
    modelRuns: provenance.modelRuns
  };
  if (provenance.provenanceChecksum !== contentHash(provenanceBasis)) throw new Error('replay provenance checksum conflict');
  if (![pairKeys.length, pairKeys.length * 2].includes(provenance.modelRuns.length)) {
    throw new Error('model provenance count conflict');
  }
  const modelIdentities = [];
  for (const record of provenance.modelRuns) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).sort().join(',') !== [...MODEL_PROVENANCE_KEYS].sort().join(',')
      || typeof record.finalKey !== 'string' || !pairKeys.includes(record.finalKey)
      || !Number.isSafeInteger(record.attemptIndex) || record.attemptIndex < 0
      || record.attemptIndex > 1 || typeof record.evaluatorId !== 'string' || !record.evaluatorId
      || !isSha256(record.inputChecksum) || record.completed !== true) {
      throw new Error('model provenance authority conflict');
    }
    const identity = `${record.finalKey}:${record.attemptIndex}`;
    if (modelIdentities.includes(identity)) throw new Error('model provenance identity conflict');
    modelIdentities.push(identity);
  }
  const expectedModelIdentities = pairKeys.flatMap(finalKey =>
    provenance.modelRuns.length === pairKeys.length ? [`${finalKey}:0`] : [`${finalKey}:0`, `${finalKey}:1`]
  ).sort();
  if (modelIdentities.sort().join('\u0000') !== expectedModelIdentities.join('\u0000')) {
    throw new Error('model provenance key set conflict');
  }
  return provenance;
}

function assertReplayProvenance(provenance, expectedPlan, candidateRelease, { allowDistinctPhaseInputs = false } = {}) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || !(['executionPairs,modelRuns,provenanceChecksum,sourceHead',
      'executionPairs,modelRuns,provenanceChecksum,runId,sourceHead',
      'executionPairs,modelRuns,phaseInputMode,provenanceChecksum,runId,sourceHead'].includes(Object.keys(provenance).sort().join(',')))
    || !Array.isArray(provenance.executionPairs) || !Array.isArray(provenance.modelRuns)) {
    throw new Error('replay execution/model provenance required');
  }
  if ((provenance.phaseInputMode !== undefined && provenance.phaseInputMode !== 'v2')
    || !/^[0-9a-f]{40}$/.test(provenance.sourceHead)
    || !isSha256(provenance.provenanceChecksum)) {
    throw new Error('replay source provenance identity conflict');
  }
  if (Object.prototype.hasOwnProperty.call(provenance, 'runId')
    && (typeof provenance.runId !== 'string' || !RUN_ID_PATTERN.test(provenance.runId))) {
    throw new Error('replay run identity conflict');
  }
  const expectedKeys = [
    ...expectedPlan.finalKeys.sentinelFinalKeys,
    ...expectedPlan.finalKeys.coverageFinalKeys,
    ...expectedPlan.finalKeys.historyFinalKeys
  ].sort();
  const assertExactRecords = (records, allowed, label) => {
    if (records.length !== expectedKeys.length) throw new Error(`${label} provenance count conflict`);
    const seen = new Set();
    for (const record of records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).some(key => !allowed.has(key))
        || Object.keys(record).length !== allowed.size
        || typeof record.finalKey !== 'string' || seen.has(record.finalKey)
        || !expectedKeys.includes(record.finalKey)) {
        throw new Error(`${label} provenance identity conflict`);
      }
      seen.add(record.finalKey);
    }
    if ([...seen].sort().join('\u0000') !== expectedKeys.join('\u0000')) {
      throw new Error(`${label} provenance key set conflict`);
    }
  };
  assertExactRecords(provenance.executionPairs, EXECUTION_PROVENANCE_KEYS, 'execution');
  for (const record of provenance.executionPairs) {
    if (typeof record.stableReleaseId !== 'string' || !record.stableReleaseId
      || record.sourceHead !== provenance.sourceHead
      || typeof record.candidateReleaseId !== 'string' || record.candidateReleaseId !== candidateRelease.releaseId
      || !isSha256(record.stableReleaseChecksum)
      || record.candidateReleaseChecksum !== candidateRelease.releaseChecksum
      || !isSha256(record.executionChecksum)
      || !isSha256(record.stableInputChecksum)
      || !isSha256(record.candidateInputChecksum)
      || (!(allowDistinctPhaseInputs || provenance.phaseInputMode === 'v2')
        && (record.stableInputChecksum !== record.executionChecksum
          || record.candidateInputChecksum !== record.executionChecksum))
      || record.dryRun !== true
      || !record.capabilities || Object.keys(record.capabilities).sort().join(',') !== 'actions,visible'
      || record.capabilities.actions !== false || record.capabilities.visible !== false) {
      throw new Error('execution provenance authority conflict');
    }
  }
  const provenanceBasis = {
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    sourceHead: provenance.sourceHead,
    ...(provenance.phaseInputMode ? { phaseInputMode: provenance.phaseInputMode } : {}),
    executionPairs: provenance.executionPairs,
    modelRuns: provenance.modelRuns
  };
  if (provenance.provenanceChecksum !== contentHash(provenanceBasis)) throw new Error('replay provenance checksum conflict');
  if (![expectedKeys.length, expectedKeys.length * 2].includes(provenance.modelRuns.length)) {
    throw new Error('model provenance count conflict');
  }
  const modelSeen = new Set();
  for (const record of provenance.modelRuns) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || Object.keys(record).some(key => !MODEL_PROVENANCE_KEYS.has(key))
      || Object.keys(record).length !== MODEL_PROVENANCE_KEYS.size
      || typeof record.finalKey !== 'string' || !expectedKeys.includes(record.finalKey)
      || !Number.isSafeInteger(record.attemptIndex) || record.attemptIndex < 0
      || record.attemptIndex > 1 || typeof record.evaluatorId !== 'string' || !record.evaluatorId
      || !isSha256(record.inputChecksum) || record.completed !== true) {
      throw new Error('model provenance authority conflict');
    }
    const identity = `${record.finalKey}:${record.attemptIndex}`;
    if (modelSeen.has(identity)) throw new Error('model provenance identity conflict');
    modelSeen.add(identity);
  }
  const expectedModelIdentities = expectedKeys.flatMap(finalKey =>
    provenance.modelRuns.length === expectedKeys.length ? [`${finalKey}:0`] : [`${finalKey}:0`, `${finalKey}:1`]
  ).sort();
  if ([...modelSeen].sort().join('\u0000') !== expectedModelIdentities.join('\u0000')) {
    throw new Error('model provenance key set conflict');
  }
  return provenance;
}

function assertEvidenceExecutionJoins(evidence, provenance, expectedFinalKeys, { allowDistinctPhaseInputs = false } = {}) {
  assertQualityReportProvenance(provenance, { expectedFinalKeys, allowDistinctPhaseInputs });
  const expected = [...expectedFinalKeys].sort();
  const rows = [
    ...(evidence?.sentinelRuns || []),
    ...(evidence?.coverageRuns || []),
    ...(evidence?.historyRuns || [])
  ];
  if (rows.length !== expected.length) throw new Error('quality evidence final count conflict');
  const pairByKey = new Map(provenance.executionPairs.map(pair => [pair.finalKey, pair]));
  const seenFinal = new Set();
  for (const row of rows) {
    const key = `${row?.layer}:${row?.sceneId}:${row?.repeatIndex}`;
    if (!pairByKey.has(key) || seenFinal.has(key)
      || typeof row.executionChecksum !== 'string'
      || row.executionChecksum !== pairByKey.get(key).executionChecksum
      || !Array.isArray(row.attempts) || row.attempts.length === 0) {
      throw new Error('quality evidence execution pair join conflict');
    }
    seenFinal.add(key);
    const seenAttempts = new Set();
    for (const attempt of row.attempts) {
      const identity = `${attempt?.attemptIndex}:${attempt?.evaluatorId}`;
      if (!Number.isSafeInteger(attempt?.attemptIndex) || attempt.attemptIndex < 0
        || typeof attempt?.evaluatorId !== 'string' || !attempt.evaluatorId
        || seenAttempts.has(identity)
        || attempt.executionChecksum !== pairByKey.get(key).executionChecksum) {
        throw new Error('quality evidence attempt execution pair join conflict');
      }
      seenAttempts.add(identity);
    }
    if (!provenance.modelRuns.some(run => run.finalKey === key)) {
      throw new Error('quality evidence model pair join conflict');
    }
  }
  if ([...seenFinal].sort().join('\u0000') !== expected.join('\u0000')) {
    throw new Error('quality evidence final key join conflict');
  }
}

function sceneKind(scene) {
  if (!scene || typeof scene !== 'object') return null;
  const rolloutKey = typeof scene.rolloutKey === 'string' ? scene.rolloutKey : '';
  if (rolloutKey === 'LIFE_PLANNING') return 'life';
  if (rolloutKey.startsWith('ROLE_PLAN_')) return 'role-plan';
  if (rolloutKey.includes('MOMENT') || (scene.turns || [])
    .some(turn => (turn.batch || []).some(message => message?.type === 'moment'))) return 'moment';
  if ((scene.turns || []).some(turn => (turn.batch || [])
    .some(message => message?.type === 'payment'))) return 'payment';
  if (typeof scene.focus === 'string' && /stage|阶段/i.test(scene.focus)) return 'stage';
  return null;
}

function isSampledPassingScene({ kind, sceneId, repeatIndex }) {
  if (!kind) return false;
  const digest = contentHash({ kind, sceneId, repeatIndex, sample: 'manual-review-v1' });
  return Number.parseInt(digest.slice(0, 8), 16) % 10 === 0;
}

export function deriveManualReviewRequirements(evidence, expectedPlan, { includePassingSample = false } = {}) {
  const requirements = [];
  const planByKey = new Map((expectedPlan?.items || []).map(item => [
    `${item.layer}:${item.sceneId}:${item.repeatIndex}`, item
  ]));
  for (const rows of [evidence?.sentinelRuns, evidence?.coverageRuns, evidence?.historyRuns]) {
    for (const row of rows || []) {
      const findingIds = (row.findings || [])
        .filter(finding => finding?.critical === true || finding?.severity === 'critical')
        .map(finding => finding.code)
        .filter(code => typeof code === 'string');
      const scoreOne = Object.values(row.scores || {}).some(score => score === 1);
      const structured = (row.findings || [])
        .some(finding => STRUCTURED_ACTION_CODES.has(finding?.code)
          && (finding?.critical === true || finding?.severity === 'critical'));
      const kind = sceneKind(planByKey.get(`${row.layer}:${row.sceneId}:${row.repeatIndex}`)?.scene);
      const sampledPassing = includePassingSample
        && !findingIds.length && !scoreOne && !structured
        && isSampledPassingScene({ kind, sceneId: row.sceneId, repeatIndex: row.repeatIndex });
      if (findingIds.length || scoreOne || structured || sampledPassing) {
        const reasons = [...findingIds];
        if (scoreOne) reasons.push('score_1');
        if (structured) reasons.push('structured_action');
        if (sampledPassing) reasons.push('sampled_structured_action');
        requirements.push({
          key: `${row.sceneId}:${row.repeatIndex}`,
          sceneId: row.sceneId,
          repeatIndex: row.repeatIndex,
          evidenceFindingIds: [...new Set(reasons)]
        });
      }
    }
  }
  return requirements;
}

function normalizeManualReviewQueue(queue) {
  if (queue === undefined) return [];
  if (!Array.isArray(queue)) throw new Error('manual review queue must be an array');
  return queue.map(item => {
    if (item && (item.schemaVersion === 2 || Object.prototype.hasOwnProperty.call(item, 'resolvedOutput')
      || Object.prototype.hasOwnProperty.call(item, 'finalKey'))) {
      exactKeysV2(item, MANUAL_V2_REVIEW_KEYS, 'manual v2 review queue');
      if (item.schemaVersion !== 2 || typeof item.runId !== 'string' || !RUN_ID_PATTERN.test(item.runId)
        || typeof item.finalKey !== 'string' || !item.finalKey || typeof item.reviewId !== 'string' || !item.reviewId
        || !MANUAL_V2_DECISIONS.has(item.decision) || !Array.isArray(item.evidenceFindingIds)
        || item.evidenceFindingIds.some(id => typeof id !== 'string' || !id)
        || (item.resolvedOutput !== null && (typeof item.resolvedOutput !== 'object' || Array.isArray(item.resolvedOutput)))) {
        throw new Error('manual v2 review queue closed schema conflict');
      }
      return { ...item, evidenceFindingIds: [...item.evidenceFindingIds] };
    }
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !MANUAL_REVIEW_KEYS.has(key))
      || Object.keys(item).length !== MANUAL_REVIEW_KEYS.size
      || typeof item.reviewId !== 'string' || !item.reviewId
      || typeof item.evalRunId !== 'string' || !item.evalRunId
      || typeof item.sceneId !== 'string' || !item.sceneId
      || !Number.isSafeInteger(item.repeatIndex) || item.repeatIndex < 0
      || !Array.isArray(item.evidenceFindingIds)
      || item.evidenceFindingIds.some(id => typeof id !== 'string' || !id)
      || new Set(item.evidenceFindingIds).size !== item.evidenceFindingIds.length
      || !MANUAL_DECISIONS.has(item.decision)
      || typeof item.reason !== 'string' || !item.reason
      || item.reviewer !== 'central_window'
      || !Number.isSafeInteger(item.createdAt) || item.createdAt < 0) {
      throw new Error('manual review queue closed schema conflict');
    }
    return {
      reviewId: item.reviewId,
      evalRunId: item.evalRunId,
      sceneId: item.sceneId,
      repeatIndex: item.repeatIndex,
      evidenceFindingIds: [...item.evidenceFindingIds],
      decision: item.decision,
      reason: item.reason,
      reviewer: item.reviewer,
      createdAt: item.createdAt
    };
  });
}

export function assessManualReviewQueue(
  queue,
  evidence,
  expectedPlan,
  { includePassingSample = false, frozenRequirements = null } = {}
) {
  const requirements = frozenRequirements
    ? frozenRequirements.map(requirement => ({
      ...requirement,
      key: requirement.key || `${requirement.sceneId}:${requirement.repeatIndex}`
    }))
    : deriveManualReviewRequirements(evidence, expectedPlan, { includePassingSample });
  const normalizedQueue = normalizeManualReviewQueue(queue);
  const requiredByKey = new Map(requirements.map(item => [item.key, item]));
  const queueByKey = new Map();
  for (const item of normalizedQueue) {
    const key = item.finalKey
      ? (() => { const parsed = parseV2FinalKey(item.finalKey); return `${parsed.sceneId}:${parsed.repeatIndex}`; })()
      : `${item.sceneId}:${item.repeatIndex}`;
    if (queueByKey.has(key)) throw new Error('manual review duplicate evidence identity');
    queueByKey.set(key, item);
  }
  const failedGates = [];
  let unresolvedCount = 0;
  for (const requirement of requirements) {
    const review = queueByKey.get(requirement.key);
    const expectedFindingIds = [...new Set(requirement.evidenceFindingIds)].sort();
    const actualFindingIds = [...new Set(review?.evidenceFindingIds || [])].sort();
    if (!review
      || expectedFindingIds.length !== actualFindingIds.length
      || expectedFindingIds.some((id, index) => id !== actualFindingIds[index])) {
      failedGates.push('MISSING_MANUAL_REVIEW');
      continue;
    }
    if (review.decision === 'unresolved' || review.decision === 'reject_both') {
      unresolvedCount += 1;
      failedGates.push(review.decision === 'reject_both'
        ? 'REJECTED_MANUAL_REVIEW' : 'UNRESOLVED_MANUAL_REVIEW');
    }
  }
  for (const review of normalizedQueue) {
    const reviewKey = review.finalKey
      ? (() => { const parsed = parseV2FinalKey(review.finalKey); return `${parsed.sceneId}:${parsed.repeatIndex}`; })()
      : `${review.sceneId}:${review.repeatIndex}`;
    if (!requiredByKey.has(reviewKey)) {
      if (review.decision === 'unresolved' || review.decision === 'reject_both') {
        unresolvedCount += 1;
        failedGates.push(review.decision === 'reject_both'
          ? 'REJECTED_MANUAL_REVIEW' : 'UNRESOLVED_MANUAL_REVIEW');
      } else {
        failedGates.push('UNEXPECTED_MANUAL_REVIEW');
      }
    }
  }
  return {
    eligible: failedGates.length === 0,
    failedGates: [...new Set(failedGates)],
    unresolvedCount,
    requiredCount: requirements.length,
    requirements,
    queue: normalizedQueue
  };
}

const REPLAY_ATTEMPT_KEYS = Object.freeze([
  'layer', 'sceneId', 'repeatIndex', 'attemptIndex', 'evaluatorId', 'evaluatorVersion',
  'executionChecksum', 'latencyMs', 'accepted', 'unresolved'
]);
const REPLAY_FINAL_KEYS = Object.freeze([
  'layer', 'sceneId', 'repeatIndex', 'finalized', 'scores', 'preference', 'findings',
  'regression', 'severe', 'tie', 'unresolved', 'structuralRegression', 'protocolFailure',
  'executionChecksum', 'latencyMs', 'evaluatorVersion', 'attempts'
]);

function exactRecordKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} closed schema conflict: ${Object.keys(value || {}).sort().join(',')}`);
  }
}

function stripRecordEnvelope(row) {
  const { recordType: _recordType, runId: _runId, ...value } = row;
  return value;
}

export function validateQualityArtifactBundle({
  plan,
  replayArtifactPath,
  manualReviewArtifactPath,
  replayBytes = null,
  manualReviewBytes = null,
  candidateRelease,
  qualityReport = null
} = {}) {
  if (!plan || typeof plan !== 'object') throw new Error('quality plan artifact required');
  plan = assertVerifiedQualityReplayPlan(plan);
  if (!candidateRelease || typeof candidateRelease !== 'object' || Array.isArray(candidateRelease)) {
    throw new Error('candidate release required');
  }
  const replayArtifact = replayBytes ? { bytes: replayBytes, rows: replayBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    : readJsonLinesArtifact(replayArtifactPath, 'quality replay');
  const manualArtifact = manualReviewBytes
    ? { bytes: manualReviewBytes, rows: manualReviewBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse) }
    : readJsonLinesArtifact(manualReviewArtifactPath, 'quality manual review');
  if (replayArtifact.rows.length === 0 || manualArtifact.rows.length === 0) throw new Error('quality bundle rows missing');
  const isV2 = replayArtifact.rows.some(row => row?.schemaVersion === 2 || row?.recordType === 'run');
  if (isV2) {
    const validated = validateQualityReplayV2Rows({ rows: replayArtifact.rows, plan });
    const runId = validated.run.runId;
    const manual = validateManualV2Rows(manualArtifact.rows, {
      runId,
      plan,
      provenanceRow: validated.provenance,
      sourceHead: validated.run.header?.sourceHead,
      candidateRelease,
      evidence: null,
      validated
    });
    const expected = expectedFinalKeysProjection(plan);
    const expectedFinalKeys = [
      ...expected.finalKeys.sentinelFinalKeys,
      ...expected.finalKeys.coverageFinalKeys,
      ...expected.finalKeys.historyFinalKeys
    ];
    const comparisonSummary = projectV2ComparisonSummary(validated, expectedFinalKeys);
    const evidence = projectV2Evidence(validated, manual.effectiveOutputs);
    const provenance = projectV2Provenance(validated);
    assertQualityReportProvenance(provenance, {
      expectedFinalKeys,
      candidateRelease,
      sourceHead: validated.run.header.sourceHead,
      allowDistinctPhaseInputs: true
    });
    const manualQueue = manual.reviews.map(row => ({ ...row }));
    const expectedProjection = expectedFinalKeysProjection(plan);
    const qualityGate = {
      ...aggregateQualityGate(evidence, expectedProjection),
      ...comparisonSummary
    };
    const manualReview = assessManualReviewQueue(
      manualQueue, evidence, plan, { includePassingSample: true, frozenRequirements: manual.requirements }
    );
    const derivedEligible = qualityGate.eligible && manualReview.eligible
      && comparisonSummary.comparisonUnresolvedCount === 0;
    if (qualityReport) {
      if (!qualityReport || typeof qualityReport !== 'object' || Array.isArray(qualityReport)
        || qualityReport.version !== 1 || qualityReport.productionReleaseMutation !== false
        || qualityReport.planChecksum !== plan.planChecksum || qualityReport.replayRunId !== runId
        || qualityReport.sourceHead !== validated.run.header.sourceHead
        || qualityReport.candidateRelease?.releaseId !== candidateRelease.releaseId
        || qualityReport.candidateRelease?.releaseChecksum !== candidateRelease.releaseChecksum
        || canonicalJson(qualityReport.replayProvenance) !== canonicalJson(provenance)
        || (qualityReport.qualityReplaySha256 !== undefined
          && qualityReport.qualityReplaySha256 !== artifactSha(replayArtifact.bytes))
        || (qualityReport.qualityManualReviewSha256 !== undefined
          && qualityReport.qualityManualReviewSha256 !== artifactSha(manualArtifact.bytes))
        || (qualityReport.evidenceBoundaryChecksum !== undefined
          && (!isSha256(qualityReport.evidenceBoundaryChecksum)
            || qualityReport.evidenceBoundaryChecksum !== evidenceBoundaryChecksum({
              evidenceBoundary: qualityReport.evidenceBoundary,
              planChecksum: plan.planChecksum,
              sourceHead: validated.run.header.sourceHead,
              provenanceChecksum: provenance.provenanceChecksum
            })))
        || canonicalJson(qualityReport.qualityGate) !== canonicalJson(qualityGate)
        || canonicalJson(qualityReport.manualReview) !== canonicalJson(manualReview)
        || qualityReport.eligible !== derivedEligible) {
        throw new Error('quality report raw derivation conflict');
      }
    }
    return {
      runId,
      evidenceClass: 'quality_replay_v2',
      evidenceEligible: manual.eligible === true,
      v2: validated,
      manualV2: manual,
      provenance,
      evidence,
      comparisonSummary,
      qualityGate,
      manualReview,
      manualReviewRequirements: manual.requirements,
      manualReviewQueue: manualQueue,
      derivedEligible,
      qualityPlanSha256: null,
      qualityReplaySha256: artifactSha(replayArtifact.bytes),
      qualityManualReviewSha256: artifactSha(manualArtifact.bytes)
    };
  }
  // The historical JSONL format is retained only for offline structural compatibility.
  // A production report supplied with a legacy bundle is always ineligible.
  if (qualityReport) {
    throw new Error('quality report legacy_structural bundle is ineligible');
  }
  const runIds = new Set([...replayArtifact.rows, ...manualArtifact.rows].map(row => row?.runId));
  if (runIds.size !== 1) throw new Error('quality bundle run identity conflict');
  const runId = [...runIds][0];
  assertRunId(runId);
  const counts = new Map();
  const seen = new Map();
  for (const row of [...replayArtifact.rows, ...manualArtifact.rows]) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || row.runId !== runId
      || typeof row.recordType !== 'string') throw new Error('quality bundle row identity conflict');
    const identityPart = row.recordType === 'model'
      ? `${row.finalKey}:${row.attemptIndex}`
      : row.recordType === 'attempt'
        ? `${row.finalKey}:${row.attemptIndex}:${row.evaluatorId}`
        : row.recordType === 'final'
          ? `${row.layer}:${row.sceneId}:${row.repeatIndex}`
        : (row.finalKey || row.reviewId || row.sourceHead || 'singleton');
    const key = `${row.recordType}:${identityPart}`;
    if (['provenance', 'metadata'].includes(row.recordType)) {
      if (seen.has(key)) throw new Error('quality bundle duplicate singleton');
    } else if (seen.has(key) && row.recordType !== 'attempt') {
      throw new Error(`quality bundle duplicate identity: ${key}`);
    }
    seen.set(key, true);
    counts.set(row.recordType, (counts.get(row.recordType) || 0) + 1);
  }
  const provenanceRows = replayArtifact.rows.filter(row => row.recordType === 'provenance');
  const executionRows = replayArtifact.rows.filter(row => row.recordType === 'execution');
  const modelRows = replayArtifact.rows.filter(row => row.recordType === 'model');
  const attemptRows = replayArtifact.rows.filter(row => row.recordType === 'attempt');
  const finalRows = replayArtifact.rows.filter(row => row.recordType === 'final');
  const checksumRows = replayArtifact.rows.filter(row => row.recordType === 'final-checksum');
  const allowedReplay = new Set(['attempt', 'final', 'provenance', 'execution', 'model', 'final-checksum']);
  if (replayArtifact.rows.some(row => !allowedReplay.has(row.recordType)) || provenanceRows.length !== 1) {
    throw new Error('quality replay record set conflict');
  }
  exactRecordKeys(provenanceRows[0], ['recordType', 'runId', 'sourceHead', 'provenanceChecksum'], 'replay provenance');
  const provenanceRow = provenanceRows[0];
  const executionPairs = executionRows.map(row => {
    exactRecordKeys(row, ['recordType', 'runId', ...EXECUTION_PROVENANCE_KEYS], 'execution record');
    return stripRecordEnvelope(row);
  });
  const modelRuns = modelRows.map(row => {
    exactRecordKeys(row, ['recordType', 'runId', ...MODEL_PROVENANCE_KEYS], 'model record');
    return stripRecordEnvelope(row);
  });
  const provenance = {
    runId,
    sourceHead: provenanceRow.sourceHead,
    executionPairs,
    modelRuns,
    provenanceChecksum: provenanceRow.provenanceChecksum
  };
  const expected = expectedFinalKeysProjection(plan);
  const expectedFinalKeys = [
    ...expected.finalKeys.sentinelFinalKeys, ...expected.finalKeys.coverageFinalKeys,
    ...expected.finalKeys.historyFinalKeys
  ];
  const expectedExecutionChecksums = new Map(plan.items.map(item => [
    `${item.layer}:${item.sceneId}:${item.repeatIndex}`,
    contentHash(compileSceneExecutionInput(item.scene))
  ]));
  if (expectedExecutionChecksums.size !== expectedFinalKeys.length
    || expectedFinalKeys.some(key => !expectedExecutionChecksums.has(key))) {
    throw new Error('quality plan execution input identity conflict');
  }
  for (const pair of executionPairs) {
    const expectedChecksum = expectedExecutionChecksums.get(pair.finalKey);
    if (!expectedChecksum || pair.executionChecksum !== expectedChecksum
      || pair.stableInputChecksum !== expectedChecksum
      || pair.candidateInputChecksum !== expectedChecksum) {
      throw new Error(`quality execution input checksum authority conflict: ${pair.finalKey}`);
    }
  }
  assertQualityReportProvenance(provenance, { expectedFinalKeys, candidateRelease, sourceHead: provenance.sourceHead });
  if (finalRows.length !== expectedFinalKeys.length || checksumRows.length !== expectedFinalKeys.length) {
    throw new Error('quality final record count conflict');
  }
  const finals = finalRows.map(row => {
    exactRecordKeys(row, ['recordType', 'runId', ...REPLAY_FINAL_KEYS], 'final record');
    const final = stripRecordEnvelope(row);
    final.attempts = final.attempts?.map(attempt => {
      const normalized = { ...attempt };
      delete normalized.layer; delete normalized.sceneId; delete normalized.repeatIndex;
      return normalized;
    });
    if (!expectedFinalKeys.includes(`${final.layer}:${final.sceneId}:${final.repeatIndex}`)) throw new Error('final key conflict');
    return final;
  });
  const finalByKey = new Map(finals.map(row => [`${row.layer}:${row.sceneId}:${row.repeatIndex}`, row]));
  if (finalByKey.size !== expectedFinalKeys.length) throw new Error('final key duplicate');
  const attemptByKey = new Map();
  for (const row of attemptRows) {
    exactRecordKeys(row, ['recordType', 'runId', ...REPLAY_ATTEMPT_KEYS], 'attempt record');
    const attempt = stripRecordEnvelope(row);
    const key = `${attempt.layer}:${attempt.sceneId}:${attempt.repeatIndex}`;
    const identity = `${key}:${attempt.attemptIndex}:${attempt.evaluatorId}`;
    if (attemptByKey.has(identity)) throw new Error('attempt duplicate identity');
    attemptByKey.set(identity, attempt);
  }
  const nestedAttemptIdentities = new Set();
  for (const row of finals) {
    const key = `${row.layer}:${row.sceneId}:${row.repeatIndex}`;
    if (!Array.isArray(row.attempts) || row.attempts.length === 0) throw new Error('final attempts missing');
    for (const attempt of row.attempts) {
      exactRecordKeys(attempt, ['attemptIndex', 'evaluatorId', 'evaluatorVersion', 'executionChecksum', 'latencyMs', 'accepted', 'unresolved'], 'nested attempt');
      const identity = `${key}:${attempt.attemptIndex}:${attempt.evaluatorId}`;
      if (nestedAttemptIdentities.has(identity)) throw new Error('nested attempt duplicate identity');
      nestedAttemptIdentities.add(identity);
      const sourceAttempt = attemptByKey.get(identity);
      const normalizedSource = sourceAttempt && {
        attemptIndex: sourceAttempt.attemptIndex, evaluatorId: sourceAttempt.evaluatorId,
        evaluatorVersion: sourceAttempt.evaluatorVersion, executionChecksum: sourceAttempt.executionChecksum,
        latencyMs: sourceAttempt.latencyMs, accepted: sourceAttempt.accepted, unresolved: sourceAttempt.unresolved
      };
      if (!sourceAttempt || contentHash(normalizedSource) !== contentHash(attempt)) {
        throw new Error('final attempt join conflict');
      }
    }
  }
  if (nestedAttemptIdentities.size !== attemptByKey.size
    || [...attemptByKey.keys()].some(identity => !nestedAttemptIdentities.has(identity))) {
    throw new Error('attempt record set join conflict');
  }
  for (const row of checksumRows) {
    exactRecordKeys(row, ['recordType', 'runId', 'finalKey', 'executionChecksum', 'latencyMs', 'evaluatorVersion'], 'final checksum');
    const final = finalByKey.get(row.finalKey);
    if (!final || final.executionChecksum !== row.executionChecksum
      || final.latencyMs !== row.latencyMs || final.evaluatorVersion !== row.evaluatorVersion) {
      throw new Error('final checksum join conflict');
    }
  }
  const evidence = {
    sentinelRuns: finals.filter(row => row.layer === 'sentinel'),
    coverageRuns: finals.filter(row => row.layer === 'coverage'),
    historyRuns: finals.filter(row => row.layer === 'history')
  };
  assertEvidenceExecutionJoins(evidence, provenance, expectedFinalKeys);
  const metadataRows = manualArtifact.rows.filter(row => row.recordType === 'metadata');
  if (metadataRows.length !== 1) throw new Error('manual metadata identity conflict');
  exactRecordKeys(metadataRows[0], ['recordType', 'runId', 'sourceHead', 'candidateReleaseId', 'candidateReleaseChecksum', 'planChecksum'], 'manual metadata');
  const metadata = metadataRows[0];
  if (metadata.sourceHead !== provenance.sourceHead
    || metadata.candidateReleaseId !== candidateRelease.releaseId
    || metadata.candidateReleaseChecksum !== candidateRelease.releaseChecksum
    || metadata.planChecksum !== plan.planChecksum) throw new Error('manual metadata binding conflict');
  const manualRows = manualArtifact.rows.filter(row => row.recordType === 'review').map(row => {
    exactRecordKeys(row, ['recordType', 'runId', ...MANUAL_REVIEW_KEYS], 'manual review');
    return stripRecordEnvelope(row);
  });
  if (manualArtifact.rows.some(row => !['metadata', 'review'].includes(row.recordType))) throw new Error('manual record set conflict');
  if (qualityReport) {
    if (qualityReport.planChecksum !== plan.planChecksum
      || qualityReport.replayRunId !== runId
      || qualityReport.sourceHead !== provenance.sourceHead
      || qualityReport.candidateRelease?.releaseId !== candidateRelease.releaseId
      || qualityReport.candidateRelease?.releaseChecksum !== candidateRelease.releaseChecksum) {
      throw new Error('quality report raw bundle identity conflict');
    }
    const derivedGate = aggregateQualityGate(evidence, expected);
    const derivedManual = assessManualReviewQueue(manualRows, evidence, plan, { includePassingSample: true });
    if (canonicalJson(qualityReport.qualityGate) !== canonicalJson(derivedGate)
      || canonicalJson(qualityReport.manualReview) !== canonicalJson(derivedManual)
      || qualityReport.eligible !== (derivedGate.eligible && derivedManual.eligible)) {
      throw new Error('quality report raw derivation conflict');
    }
  }
  return {
    runId,
    evidenceClass: 'legacy_structural',
    evidenceEligible: false,
    ineligibleReason: 'legacy_structural quality replay is view-only',
    provenance,
    evidence: { ...evidence, evidenceClass: 'legacy_structural', evidenceEligible: false },
    manualReviewQueue: manualRows,
    qualityPlanSha256: null,
    qualityReplaySha256: artifactSha(replayArtifact.bytes),
    qualityManualReviewSha256: artifactSha(manualArtifact.bytes)
  };
}

export function materializeQualityReport({
  evidence,
  planArtifactPath,
  rootDir = process.cwd(),
  historyPath,
  historyManifestPath,
  historyInputMode,
  historyScenes,
  historyManifest,
  candidateRelease,
  manualReviewQueue,
  replayProvenance,
  manualRequirements = null,
  outPath = null,
  materializationToken = null,
  comparisonSummary = null
} = {}) {
  const blocked = (failedGate, error) => {
    const report = {
      version: 1,
      productionReleaseMutation: false,
      eligible: false,
      failedGates: [failedGate],
      blockingReason: error instanceof Error ? error.message : String(error)
    };
    if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  };
  if (evidence?.evidenceClass === 'legacy_structural' || evidence?.evidenceEligible === false) {
    return blocked('LEGACY_STRUCTURAL_EVIDENCE_INELIGIBLE', 'legacy_structural quality replay is view-only');
  }
  if (!replayProvenance) return blocked('REPLAY_PROVENANCE_REQUIRED', 'replay execution/model provenance required');
  if (typeof planArtifactPath !== 'string' || !planArtifactPath) {
    return blocked('QUALITY_PLAN_ARTIFACT_REQUIRED', 'disk-verified quality plan artifact required');
  }
  let verifiedPlan;
  let release;
  let evidenceBoundary;
  try {
    const {
      historyScenes: diskHistoryScenes,
      historyManifest: diskHistoryManifest,
      historyInputMode: verifiedHistoryInputMode
    } =
      loadQualityHistoryArtifacts({ rootDir, historyPath, historyManifestPath, historyInputMode });
    evidenceBoundary = qualityEvidenceBoundary(verifiedHistoryInputMode);
    verifiedPlan = loadQualityReplayPlanArtifact({
      artifactPath: planArtifactPath,
      rootDir,
      historyScenes: diskHistoryScenes,
      historyManifest: diskHistoryManifest
    });
    release = verifyCandidateRelease(candidateRelease);
    assertReplayProvenance(replayProvenance, verifiedPlan, release, {
      allowDistinctPhaseInputs: replayProvenance.executionPairs?.some(pair =>
        pair.stableInputChecksum !== pair.executionChecksum || pair.candidateInputChecksum !== pair.executionChecksum)
    });
    const expected = expectedFinalKeysProjection(verifiedPlan);
    assertEvidenceExecutionJoins(evidence, replayProvenance, [
      ...expected.finalKeys.sentinelFinalKeys,
      ...expected.finalKeys.coverageFinalKeys,
      ...expected.finalKeys.historyFinalKeys
    ], { allowDistinctPhaseInputs: replayProvenance.executionPairs?.some(pair =>
      pair.stableInputChecksum !== pair.executionChecksum || pair.candidateInputChecksum !== pair.executionChecksum) });
  } catch (error) {
    return blocked('QUALITY_REPORT_AUTHORITY_INVALID', error);
  }
  const expectedProjection = expectedFinalKeysProjection(verifiedPlan);
  const qualityGate = aggregateQualityGate(evidence, expectedProjection);
  const manualReview = assessManualReviewQueue(
    manualReviewQueue,
    evidence,
    verifiedPlan,
    { includePassingSample: true, frozenRequirements: manualRequirements }
  );
  const failedGates = [...qualityGate.failedGates, ...manualReview.failedGates];
  const eligible = qualityGate.eligible && manualReview.eligible;
  const report = {
    version: 1,
    productionReleaseMutation: false,
    candidateRelease: release,
    evidenceBoundary,
    sourceHead: replayProvenance.sourceHead,
    planChecksum: verifiedPlan.planChecksum,
    replayProvenance,
    evidenceBoundaryChecksum: evidenceBoundaryChecksum({
      evidenceBoundary,
      planChecksum: verifiedPlan.planChecksum,
      sourceHead: replayProvenance.sourceHead,
      provenanceChecksum: replayProvenance.provenanceChecksum
    }),
    qualityGate: comparisonSummary ? { ...qualityGate, ...comparisonSummary } : qualityGate,
    manualReview,
    eligible: materializationToken === ARTIFACT_MATERIALIZATION_TOKEN
      ? eligible && (!comparisonSummary || comparisonSummary.comparisonUnresolvedCount === 0)
      : false,
    failedGates: materializationToken === ARTIFACT_MATERIALIZATION_TOKEN
      ? [...failedGates, ...(
        comparisonSummary?.comparisonUnresolvedCount > 0 ? ['COMPARISON_UNRESOLVED'] : [])]
      : [...failedGates, 'QUALITY_REPORT_RAW_BUNDLE_REQUIRED']
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function materializeQualityReportFromArtifacts({
  planArtifactPath,
  replayArtifactPath,
  manualReviewArtifactPath,
  rootDir = process.cwd(),
  historyPath,
  historyManifestPath,
  historyInputMode,
  historyScenes,
  historyManifest,
  candidateRelease,
  outPath = null
} = {}) {
  if (typeof replayArtifactPath !== 'string' || typeof manualReviewArtifactPath !== 'string') {
    throw new Error('quality raw artifact paths required');
  }
  const { historyScenes: diskHistoryScenes, historyManifest: diskHistoryManifest } =
    loadQualityHistoryArtifacts({ rootDir, historyPath, historyManifestPath, historyInputMode });
  const verifiedPlan = loadQualityReplayPlanArtifact({
    artifactPath: planArtifactPath,
    rootDir,
    historyScenes: diskHistoryScenes,
    historyManifest: diskHistoryManifest
  });
  const bundle = validateQualityArtifactBundle({
    plan: verifiedPlan,
    replayArtifactPath,
    manualReviewArtifactPath,
    candidateRelease
  });
  const report = materializeQualityReport({
    evidence: bundle.evidence,
    planArtifactPath,
    rootDir,
    historyPath,
    historyManifestPath,
    historyInputMode,
    historyScenes: diskHistoryScenes,
    historyManifest: diskHistoryManifest,
    candidateRelease,
    manualReviewQueue: bundle.manualReviewQueue,
    manualRequirements: bundle.manualReviewRequirements || null,
    replayProvenance: bundle.provenance,
    comparisonSummary: bundle.comparisonSummary,
    materializationToken: ARTIFACT_MATERIALIZATION_TOKEN,
    outPath: null
  });
  if (Object.prototype.hasOwnProperty.call(report, 'blockingReason')) {
    if (outPath) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  }
  const result = {
    ...report,
    replayRunId: bundle.runId,
    qualityPlanSha256: artifactSha(readFileSync(resolve(rootDir, planArtifactPath))),
    qualityReplaySha256: bundle.qualityReplaySha256,
    qualityManualReviewSha256: bundle.qualityManualReviewSha256
  };
  if (outPath) writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}

function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readCliJson(path, label) {
  if (!path || !existsSync(path)) throw new Error(`${label} not found`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readCliJsonLines(path, label) {
  if (!path || !existsSync(path)) throw new Error(`${label} not found`);
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  if (raw.startsWith('[')) return JSON.parse(raw);
  return raw.split(/\r?\n/).filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is not JSON: ${error.message}`);
    }
  });
}

function writeBlockedReport(outPath, error) {
  const report = {
    version: 1,
    productionReleaseMutation: false,
    eligible: false,
    failedGates: ['QUALITY_REPORT_INPUT_UNAVAILABLE'],
    blockingReason: error instanceof Error ? error.message : String(error)
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export function loadQualityHistoryInputs({
  rootDir = process.cwd(),
  historyPath,
  historyManifestPath
} = {}) {
  const hasHistoryPath = typeof historyPath === 'string' && historyPath.length > 0;
  const hasManifestPath = typeof historyManifestPath === 'string' && historyManifestPath.length > 0;
  if (hasHistoryPath !== hasManifestPath) {
    throw new Error('explicit history override requires scenes and manifest paths');
  }
  const defaults = presetHistoryArtifactPaths(rootDir);
  const historyInputMode = hasHistoryPath ? 'explicit_override' : 'preset_default';
  return {
    historyPath: historyPath || defaults.scenesPath,
    historyManifestPath: historyManifestPath || defaults.manifestPath,
    historyInputMode,
    historyScenes: loadLocalHistoryScenes({ rootDir, path: hasHistoryPath ? historyPath : undefined }),
    historyManifest: loadLocalHistoryManifest({ rootDir, path: hasManifestPath ? historyManifestPath : undefined })
  };
}

export function loadQualityHistoryArtifacts({ rootDir, historyPath, historyManifestPath, historyInputMode } = {}) {
  const inferredMode = historyInputMode || (
    typeof historyPath === 'string' && historyPath && typeof historyManifestPath === 'string' && historyManifestPath
      ? 'explicit_override'
      : 'preset_default'
  );
  if (!['preset_default', 'explicit_override'].includes(inferredMode)) {
    throw new Error('quality history input mode conflict');
  }
  if (inferredMode === 'preset_default') {
    const defaults = presetHistoryArtifactPaths(rootDir);
    if ((historyPath && resolve(historyPath) !== resolve(defaults.scenesPath))
      || (historyManifestPath && resolve(historyManifestPath) !== resolve(defaults.manifestPath))) {
      throw new Error('preset history path conflict');
    }
    return {
      historyScenes: loadLocalHistoryScenes({ rootDir }),
      historyManifest: loadLocalHistoryManifest({ rootDir }),
      historyInputMode: 'preset_default'
    };
  }
  if (typeof historyPath !== 'string' || !historyPath
    || typeof historyManifestPath !== 'string' || !historyManifestPath) {
    throw new Error('explicit history override requires scenes and manifest paths');
  }
  return {
    historyScenes: loadLocalHistoryScenes({ rootDir, path: historyPath }),
    historyManifest: loadLocalHistoryManifest({ rootDir, path: historyManifestPath }),
    historyInputMode: 'explicit_override'
  };
}

function qualityEvidenceBoundary(historyInputMode) {
  return {
    version: 1,
    inputMode: historyInputMode,
    sourceClass: historyInputMode === 'preset_default'
      ? 'tracked_human_annotations'
      : 'explicit_history_override',
    offlineModelEvaluation: true,
    realHistoryEvidence: false,
    liveShadowEvidence: false
  };
}

export function evidenceBoundaryChecksum({ evidenceBoundary, planChecksum, sourceHead, provenanceChecksum }) {
  return contentHash({ evidenceBoundary, planChecksum, sourceHead, provenanceChecksum });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const rootDir = cliOption('--root') || process.cwd();
  const outPath = resolve(rootDir, cliOption('--out') || 'artifacts/yuqi-lived-agency-v3/quality-report.json');
  try {
    const {
      historyPath,
      historyManifestPath,
      historyInputMode,
      historyScenes,
      historyManifest
    } = loadQualityHistoryInputs({
      rootDir,
      historyPath: cliOption('--history'),
      historyManifestPath: cliOption('--history-manifest')
    });
    if (!cliOption('--plan')) throw new Error('quality plan artifact required');
    const expectedPlan = loadQualityReplayPlanArtifact({
      artifactPath: resolve(rootDir, cliOption('--plan')),
      rootDir,
      historyScenes,
      historyManifest
    });
    const candidateInput = readCliJson(cliOption('--candidate-release'), 'candidate release');
    const candidateRelease = candidateInput.releaseId
      ? candidateInput
      : buildCandidateReleaseDefinition(candidateInput);
    const rawReplayPath = cliOption('--replay-artifact') || cliOption('--quality-replay');
    const rawManualPath = cliOption('--manual-review-artifact') || cliOption('--quality-manual-review');
    if (rawReplayPath || rawManualPath) {
      if (!rawReplayPath || !rawManualPath) throw new Error('quality raw artifact bundle requires replay and manual review');
      const report = materializeQualityReportFromArtifacts({
        planArtifactPath: resolve(rootDir, cliOption('--plan')),
        replayArtifactPath: resolve(rootDir, rawReplayPath),
        manualReviewArtifactPath: resolve(rootDir, rawManualPath),
        rootDir,
        historyPath,
        historyManifestPath,
        historyInputMode,
        historyScenes,
        historyManifest,
        candidateRelease,
        outPath
      });
      process.exit(report.eligible ? 0 : 2);
    }
    const evidence = readCliJson(cliOption('--evidence'), 'quality evidence');
    const replayProvenance = cliOption('--replay-provenance')
      ? readCliJson(cliOption('--replay-provenance'), 'replay execution/model provenance')
      : (() => { throw new Error('replay execution/model provenance required'); })();
    const manualReviewQueue = cliOption('--manual-review')
      ? readCliJsonLines(cliOption('--manual-review'), 'manual review queue')
      : undefined;
    const report = materializeQualityReport({
      evidence,
      planArtifactPath: resolve(rootDir, cliOption('--plan')),
      rootDir,
      historyPath,
      historyManifestPath,
      historyInputMode,
      historyScenes,
      historyManifest,
      candidateRelease,
      manualReviewQueue,
      replayProvenance,
      outPath
    });
    if (!report.eligible) process.exitCode = 2;
  } catch (error) {
    writeBlockedReport(outPath, error);
    process.exitCode = 2;
  }
}
