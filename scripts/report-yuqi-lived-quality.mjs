import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const REPLAY_PROVENANCE_KEYS = new Set(['executionPairs', 'modelRuns']);
const EXECUTION_PROVENANCE_KEYS = new Set([
  'finalKey', 'stableReleaseId', 'stableReleaseChecksum', 'candidateReleaseId',
  'candidateReleaseChecksum', 'executionChecksum', 'stableInputChecksum',
  'candidateInputChecksum', 'dryRun', 'capabilities'
]);
const MODEL_PROVENANCE_KEYS = new Set([
  'finalKey', 'attemptIndex', 'evaluatorId', 'inputChecksum', 'completed'
]);

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function assertReplayProvenance(provenance, expectedPlan, candidateRelease) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)
    || Object.keys(provenance).sort().join(',') !== 'executionPairs,modelRuns'
    || !Array.isArray(provenance.executionPairs) || !Array.isArray(provenance.modelRuns)) {
    throw new Error('replay execution/model provenance required');
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
    const evidence = readCliJson(cliOption('--evidence'), 'quality evidence');
    const candidateInput = readCliJson(cliOption('--candidate-release'), 'candidate release');
    const candidateRelease = candidateInput.releaseId
      ? candidateInput
      : buildCandidateReleaseDefinition(candidateInput);
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
