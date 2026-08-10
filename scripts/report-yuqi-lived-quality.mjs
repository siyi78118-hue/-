import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { aggregateQualityGate } from '../yuqi-runtime/src/quality-evaluator.mjs';
import { supportsPipelineVersion } from '../yuqi-runtime/src/release-executor.mjs';
import { loadLocalHistoryManifest, loadLocalHistoryScenes } from './run-yuqi-lived-quality-replay.mjs';
import { loadQualityReplayPlanArtifact } from '../yuqi-runtime/src/quality-replay.mjs';
import {
  assertVerifiedQualityReplayPlan,
  expectedFinalKeysProjection
} from '../yuqi-runtime/src/quality-replay.mjs';

const RELEASE_FIELDS = Object.freeze([
  'pipelineVersion', 'presetVersion', 'cognitionSchemaVersion', 'expressionSchemaVersion',
  'evaluatorVersion', 'modelProfile', 'componentManifest', 'createdAt'
]);

const CANDIDATE_RELEASE_FIELDS = Object.freeze([...RELEASE_FIELDS, 'releaseId', 'releaseChecksum']);

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
  { expectedFinalKeys = null, candidateRelease = null, sourceHead = null } = {}
) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || !(['executionPairs,modelRuns,provenanceChecksum,sourceHead',
      'executionPairs,modelRuns,provenanceChecksum,runId,sourceHead'].includes(Object.keys(provenance).sort().join(',')))
    || !Array.isArray(provenance.executionPairs) || !Array.isArray(provenance.modelRuns)
    || provenance.executionPairs.length === 0) {
    throw new Error('replay execution/model provenance required');
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceHead)
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
      || record.stableInputChecksum !== record.executionChecksum
      || record.candidateInputChecksum !== record.executionChecksum
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

function assertReplayProvenance(provenance, expectedPlan, candidateRelease) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || !(['executionPairs,modelRuns,provenanceChecksum,sourceHead',
      'executionPairs,modelRuns,provenanceChecksum,runId,sourceHead'].includes(Object.keys(provenance).sort().join(',')))
    || !Array.isArray(provenance.executionPairs) || !Array.isArray(provenance.modelRuns)) {
    throw new Error('replay execution/model provenance required');
  }
  if (!/^[0-9a-f]{40}$/.test(provenance.sourceHead)
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
      || record.stableInputChecksum !== record.executionChecksum
      || record.candidateInputChecksum !== record.executionChecksum
      || record.dryRun !== true
      || !record.capabilities || Object.keys(record.capabilities).sort().join(',') !== 'actions,visible'
      || record.capabilities.actions !== false || record.capabilities.visible !== false) {
      throw new Error('execution provenance authority conflict');
    }
  }
  const provenanceBasis = {
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    sourceHead: provenance.sourceHead,
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

function assertEvidenceExecutionJoins(evidence, provenance, expectedFinalKeys) {
  assertQualityReportProvenance(provenance, { expectedFinalKeys });
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

function assessManualReviewQueue(queue, evidence, expectedPlan, { includePassingSample = false } = {}) {
  const requirements = deriveManualReviewRequirements(evidence, expectedPlan, { includePassingSample });
  const normalizedQueue = normalizeManualReviewQueue(queue);
  const requiredByKey = new Map(requirements.map(item => [item.key, item]));
  const queueByKey = new Map();
  for (const item of normalizedQueue) {
    const key = `${item.sceneId}:${item.repeatIndex}`;
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
    if (review.decision === 'unresolved') {
      unresolvedCount += 1;
      failedGates.push('UNRESOLVED_MANUAL_REVIEW');
    }
  }
  for (const review of normalizedQueue) {
    if (!requiredByKey.has(`${review.sceneId}:${review.repeatIndex}`)) {
      if (review.decision === 'unresolved') {
        unresolvedCount += 1;
        failedGates.push('UNRESOLVED_MANUAL_REVIEW');
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
    provenance,
    evidence,
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
  historyScenes,
  historyManifest,
  candidateRelease,
  manualReviewQueue,
  replayProvenance,
  outPath = null
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
  if (!replayProvenance) return blocked('REPLAY_PROVENANCE_REQUIRED', 'replay execution/model provenance required');
  if (typeof planArtifactPath !== 'string' || !planArtifactPath) {
    return blocked('QUALITY_PLAN_ARTIFACT_REQUIRED', 'disk-verified quality plan artifact required');
  }
  if (typeof historyPath !== 'string' || !historyPath
    || typeof historyManifestPath !== 'string' || !historyManifestPath) {
    return blocked('QUALITY_HISTORY_ARTIFACT_REQUIRED', 'disk-verified history scenes and manifest required');
  }
  let verifiedPlan;
  let release;
  try {
    const diskHistoryScenes = loadLocalHistoryScenes({ rootDir, path: historyPath });
    const diskHistoryManifest = loadLocalHistoryManifest({ rootDir, path: historyManifestPath });
    verifiedPlan = loadQualityReplayPlanArtifact({
      artifactPath: planArtifactPath,
      rootDir,
      historyScenes: diskHistoryScenes,
      historyManifest: diskHistoryManifest
    });
    release = verifyCandidateRelease(candidateRelease);
    assertReplayProvenance(replayProvenance, verifiedPlan, release);
    const expected = expectedFinalKeysProjection(verifiedPlan);
    assertEvidenceExecutionJoins(evidence, replayProvenance, [
      ...expected.finalKeys.sentinelFinalKeys,
      ...expected.finalKeys.coverageFinalKeys,
      ...expected.finalKeys.historyFinalKeys
    ]);
  } catch (error) {
    return blocked('QUALITY_REPORT_AUTHORITY_INVALID', error);
  }
  const expectedProjection = expectedFinalKeysProjection(verifiedPlan);
  const qualityGate = aggregateQualityGate(evidence, expectedProjection);
  const manualReview = assessManualReviewQueue(
    manualReviewQueue,
    evidence,
    verifiedPlan,
    { includePassingSample: true }
  );
  const failedGates = [...qualityGate.failedGates, ...manualReview.failedGates];
  const eligible = qualityGate.eligible && manualReview.eligible;
  const report = {
    version: 1,
    productionReleaseMutation: false,
    candidateRelease: release,
    sourceHead: replayProvenance.sourceHead,
    planChecksum: verifiedPlan.planChecksum,
    replayProvenance,
    qualityGate,
    manualReview,
    eligible,
    failedGates
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
  historyScenes,
  historyManifest,
  candidateRelease,
  outPath = null
} = {}) {
  if (typeof replayArtifactPath !== 'string' || typeof manualReviewArtifactPath !== 'string') {
    throw new Error('quality raw artifact paths required');
  }
  const diskHistoryScenes = loadLocalHistoryScenes({ rootDir, path: historyPath });
  const diskHistoryManifest = loadLocalHistoryManifest({ rootDir, path: historyManifestPath });
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
    historyScenes: diskHistoryScenes,
    historyManifest: diskHistoryManifest,
    candidateRelease,
    manualReviewQueue: bundle.manualReviewQueue,
    replayProvenance: bundle.provenance,
    outPath: null
  });
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const rootDir = cliOption('--root') || process.cwd();
  const outPath = resolve(rootDir, cliOption('--out') || 'artifacts/yuqi-lived-agency-v3/quality-report.json');
  try {
    const historyPath = cliOption('--history') || resolve(
      rootDir, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.jsonl'
    );
    const historyManifestPath = cliOption('--history-manifest') || resolve(
      rootDir, 'artifacts/yuqi-lived-agency-v3/private/real-history-scenes.manifest.json'
    );
    const historyScenes = loadLocalHistoryScenes({ rootDir, path: historyPath });
    const historyManifest = loadLocalHistoryManifest({ rootDir, path: historyManifestPath });
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
