import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadQualityPromotionRawBundle, reportSummaryFromArtifact } from '../scripts/cognition-rollout.mjs';
import { buildCandidateReleaseDefinition, deriveManualReviewRequirements, evidenceBoundaryChecksum } from '../scripts/report-yuqi-lived-quality.mjs';
import { createQualityReplayPlan } from '../scripts/run-yuqi-lived-quality-replay.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { QUALITY_DIMENSIONS, aggregateQualityGate, compileSceneExecutionInput } from '../yuqi-runtime/src/quality-evaluator.mjs';
import { expectedFinalKeysProjection, writeQualityReplayPlanArtifact } from '../yuqi-runtime/src/quality-replay.mjs';

const SOURCE_HEAD = 'd'.repeat(40);
const CANDIDATE = buildCandidateReleaseDefinition({
  pipelineVersion: 'yuqi-lived-agency-v3',
  presetVersion: '2.1.0',
  cognitionSchemaVersion: 'v3',
  expressionSchemaVersion: 'v2',
  evaluatorVersion: 'quality-evaluator-v1',
  modelProfile: 'blind-fixed',
  componentManifest: { evaluator: 'quality-evaluator-v1' },
  createdAt: 0
});
const TRACKED_PLAN = createQualityReplayPlan({ rootDir: process.cwd() });
const TRACKED_PLAN_CHECKSUM = TRACKED_PLAN.planChecksum;
const TRACKED_FINAL_KEYS = [
  ...expectedFinalKeysProjection(TRACKED_PLAN).finalKeys.sentinelFinalKeys,
  ...expectedFinalKeysProjection(TRACKED_PLAN).finalKeys.coverageFinalKeys,
  ...expectedFinalKeysProjection(TRACKED_PLAN).finalKeys.historyFinalKeys
];

function report(inputMode = 'preset_default', planChecksum = TRACKED_PLAN_CHECKSUM) {
  const artifact = {
    version: 1,
    productionReleaseMutation: false,
    eligible: true,
    failedGates: [],
    candidateRelease: CANDIDATE,
    sourceHead: SOURCE_HEAD,
    planChecksum,
    replayProvenance: {
      sourceHead: SOURCE_HEAD,
      executionPairs: TRACKED_FINAL_KEYS.map((finalKey, index) => ({
        finalKey, sourceHead: SOURCE_HEAD,
        stableReleaseId: 'stable-r2', stableReleaseChecksum: 'a'.repeat(64),
        candidateReleaseId: CANDIDATE.releaseId, candidateReleaseChecksum: CANDIDATE.releaseChecksum,
        executionChecksum: `${String(index).padStart(64, '0')}`,
        stableInputChecksum: `${String(index).padStart(64, '0')}`,
        candidateInputChecksum: `${String(index).padStart(64, '0')}`,
        dryRun: true,
        capabilities: { visible: false, actions: false }
      })),
      modelRuns: TRACKED_FINAL_KEYS.map((finalKey, index) => ({
        finalKey, attemptIndex: 0, evaluatorId: 'blind-evaluator-v1',
        inputChecksum: `${String(index).padStart(64, '0')}`, completed: true
      }))
    },
    qualityGate: { eligible: true, failedGates: [] },
    manualReview: { eligible: true, failedGates: [] },
    evidenceBoundary: {
      version: 1,
      inputMode,
      sourceClass: inputMode === 'preset_default'
        ? 'tracked_human_annotations'
        : 'explicit_history_override',
      offlineModelEvaluation: true,
      realHistoryEvidence: false,
      liveShadowEvidence: false
    }
  };
  const provenanceBasis = {
    sourceHead: artifact.replayProvenance.sourceHead,
    executionPairs: artifact.replayProvenance.executionPairs,
    modelRuns: artifact.replayProvenance.modelRuns
  };
  artifact.replayProvenance.provenanceChecksum = contentHash(provenanceBasis);
  artifact.evidenceBoundaryChecksum = evidenceBoundaryChecksum({
    evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum,
    sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum
  });
  return artifact;
}

function writeValidRawBundle(root) {
  const runId = '22222222-2222-4222-8222-222222222222';
  const executionPairs = TRACKED_PLAN.items.map(item => {
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    const executionChecksum = contentHash(compileSceneExecutionInput(item.scene));
    return {
      finalKey, sourceHead: SOURCE_HEAD, stableReleaseId: 'stable-r2', stableReleaseChecksum: 'a'.repeat(64),
      candidateReleaseId: CANDIDATE.releaseId, candidateReleaseChecksum: CANDIDATE.releaseChecksum,
      executionChecksum, stableInputChecksum: executionChecksum, candidateInputChecksum: executionChecksum,
      dryRun: true, capabilities: { visible: false, actions: false }
    };
  });
  const modelRuns = executionPairs.map(pair => ({
    finalKey: pair.finalKey, attemptIndex: 0, evaluatorId: 'blind-evaluator-v1', inputChecksum: 'b'.repeat(64), completed: true
  }));
  const finals = TRACKED_PLAN.items.map(item => {
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    const executionChecksum = executionPairs.find(pair => pair.finalKey === finalKey).executionChecksum;
    const attempt = {
      attemptIndex: 0, evaluatorId: 'blind-evaluator-v1', evaluatorVersion: 'blind-evaluator-v1',
      executionChecksum, latencyMs: 1, accepted: true, unresolved: false
    };
    return {
      layer: item.layer, sceneId: item.sceneId, repeatIndex: item.repeatIndex, finalized: true,
      scores: Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, 4])), preference: 'candidate', findings: [],
      regression: false, severe: false, tie: false, unresolved: false, structuralRegression: false,
      protocolFailure: false, executionChecksum, latencyMs: 1, evaluatorVersion: 'blind-evaluator-v1', attempts: [attempt]
    };
  });
  const provenanceBase = { runId, sourceHead: SOURCE_HEAD, executionPairs, modelRuns };
  const provenance = { ...provenanceBase, provenanceChecksum: contentHash(provenanceBase) };
  const replayRows = [
    ...finals.flatMap(row => row.attempts.map(attempt => ({ recordType: 'attempt', runId,
      layer: row.layer, sceneId: row.sceneId, repeatIndex: row.repeatIndex, ...attempt }))),
    ...finals.map(row => ({ recordType: 'final', runId, ...row })),
    { recordType: 'provenance', runId, sourceHead: SOURCE_HEAD, provenanceChecksum: provenance.provenanceChecksum },
    ...executionPairs.map(row => ({ recordType: 'execution', runId, ...row })),
    ...modelRuns.map(row => ({ recordType: 'model', runId, ...row })),
    ...finals.map(row => ({ recordType: 'final-checksum', runId,
      finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`, executionChecksum: row.executionChecksum,
      latencyMs: row.latencyMs, evaluatorVersion: row.evaluatorVersion }))
  ];
  const evidence = {
    sentinelRuns: finals.filter(row => row.layer === 'sentinel'),
    coverageRuns: finals.filter(row => row.layer === 'coverage'),
    historyRuns: finals.filter(row => row.layer === 'history')
  };
  const expected = expectedFinalKeysProjection(TRACKED_PLAN);
  const requirements = deriveManualReviewRequirements(evidence, TRACKED_PLAN, { includePassingSample: true });
  const manualRows = [{ recordType: 'metadata', runId, sourceHead: SOURCE_HEAD,
    candidateReleaseId: CANDIDATE.releaseId, candidateReleaseChecksum: CANDIDATE.releaseChecksum,
    planChecksum: TRACKED_PLAN.planChecksum }, ...requirements.map((requirement, index) => ({
      recordType: 'review', runId, reviewId: `review-${index}`, evalRunId: runId,
      sceneId: requirement.sceneId, repeatIndex: requirement.repeatIndex,
      evidenceFindingIds: requirement.evidenceFindingIds, decision: 'confirm', reason: 'fixture',
      reviewer: 'central_window', createdAt: 0
    }))];
  const planPath = join(root, 'quality-replay-plan.json');
  const replayPath = join(root, 'quality-replay.jsonl');
  const manualPath = join(root, 'quality-manual-review.jsonl');
  writeQualityReplayPlanArtifact(TRACKED_PLAN, planPath);
  writeFileSync(replayPath, `${replayRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(manualPath, `${manualRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const planSha = createHash('sha256').update(readFileSync(planPath)).digest('hex');
  const replaySha = createHash('sha256').update(readFileSync(replayPath)).digest('hex');
  const manualSha = createHash('sha256').update(readFileSync(manualPath)).digest('hex');
  const artifact = report();
  const qualityGate = aggregateQualityGate(evidence, expected);
  artifact.qualityGate = qualityGate;
  artifact.manualReview = {
    eligible: true, failedGates: [], unresolvedCount: 0, requiredCount: requirements.length,
    requirements,
    queue: manualRows.slice(1).map(({ recordType: _recordType, runId: _runId, ...row }) => row)
  };
  artifact.eligible = qualityGate.eligible && artifact.manualReview.eligible;
  artifact.replayRunId = runId;
  artifact.replayProvenance = provenance;
  artifact.qualityPlanSha256 = planSha;
  artifact.qualityReplaySha256 = replaySha;
  artifact.qualityManualReviewSha256 = manualSha;
  artifact.evidenceBoundaryChecksum = evidenceBoundaryChecksum({
    evidenceBoundary: artifact.evidenceBoundary, planChecksum: artifact.planChecksum,
    sourceHead: artifact.sourceHead, provenanceChecksum: provenance.provenanceChecksum
  });
  const artifactPath = join(root, 'quality-report.json');
  writeFileSync(artifactPath, JSON.stringify(artifact));
  return { artifact, artifactPath };
}

test('production rollout accepts only the tracked-annotation offline quality boundary', () => {
  assert.throws(() => reportSummaryFromArtifact({ artifact: report(), rollout: { stableReleaseId: 'stable-r2' } }), /validated quality raw bundle/i);
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-valid-'));
  const { artifact, artifactPath } = writeValidRawBundle(root);
  const rawBundle = loadQualityPromotionRawBundle({ artifactPath, artifact, rootDir: process.cwd() });
  const summary = reportSummaryFromArtifact({ artifact, rollout: { stableReleaseId: 'stable-r2' }, rootDir: process.cwd(), rawBundle });
  assert.equal(summary.eligible, true);
  assert.throws(() => reportSummaryFromArtifact({
    artifact, rollout: { stableReleaseId: 'stable-r2' }, rawBundle: { ...rawBundle }
  }), /validated quality raw bundle/i);
  assert.throws(() => reportSummaryFromArtifact({
    artifact: report('explicit_override'),
    rollout: { stableReleaseId: 'stable-r2' }
  }), /validated quality raw bundle/i);
  rmSync(root, { recursive: true, force: true });
});

test('production rollout rejects an explicit-override report even with a valid raw bundle', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-override-'));
  const valid = writeValidRawBundle(root);
  const artifact = valid.artifact;
  artifact.evidenceBoundary = {
    ...artifact.evidenceBoundary,
    inputMode: 'explicit_override',
    sourceClass: 'explicit_history_override'
  };
  artifact.evidenceBoundaryChecksum = evidenceBoundaryChecksum({
    evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum,
    sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum
  });
  const rawBundle = loadQualityPromotionRawBundle({ artifactPath: valid.artifactPath, artifact, rootDir: process.cwd() });
  assert.throws(() => reportSummaryFromArtifact({
    artifact,
    rollout: { stableReleaseId: 'stable-r2' }, rawBundle
  }), /checksum|provenance|boundary|quality report/i);
  rmSync(root, { recursive: true, force: true });
});

test('promotion raw bundle is mandatory and tampered raw files fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-raw-'));
  try {
    const reportPath = join(root, 'quality-report.json');
    const artifact = report();
    writeFileSync(reportPath, JSON.stringify(artifact));
    assert.throws(() => loadQualityPromotionRawBundle({ artifactPath: reportPath, artifact, rootDir: process.cwd() }), /raw bundle is incomplete/i);
    writeQualityReplayPlanArtifact(TRACKED_PLAN, join(root, 'quality-replay-plan.json'));
    writeFileSync(join(root, 'quality-replay.jsonl'), '{"recordType":"tampered"}\n');
    writeFileSync(join(root, 'quality-manual-review.jsonl'), '{"recordType":"tampered"}\n');
    artifact.qualityPlanSha256 = createHash('sha256').update(readFileSync(join(root, 'quality-replay-plan.json'))).digest('hex');
    artifact.qualityReplaySha256 = '0'.repeat(64);
    artifact.qualityManualReviewSha256 = '1'.repeat(64);
    assert.throws(() => loadQualityPromotionRawBundle({ artifactPath: reportPath, artifact, rootDir: process.cwd() }), /raw artifact checksum|quality bundle|manual|record/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw evidence failures cannot be hidden by an eligible quality report', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-gate-'));
  try {
    const valid = writeValidRawBundle(root);
    const rows = readFileSync(join(root, 'quality-replay.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const target = TRACKED_PLAN.items[0];
    const targetKey = `${target.layer}:${target.sceneId}:${target.repeatIndex}`;
    for (const row of rows) {
      const rowKey = row.finalKey || `${row.layer}:${row.sceneId}:${row.repeatIndex}`;
      if (rowKey !== targetKey) continue;
      if (row.recordType === 'attempt') {
        row.accepted = false;
        row.unresolved = true;
      } else if (row.recordType === 'final') {
        row.unresolved = true;
        row.attempts = row.attempts.map(attempt => ({ ...attempt, accepted: false, unresolved: true }));
      }
    }
    writeFileSync(join(root, 'quality-replay.jsonl'), `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    valid.artifact.qualityReplaySha256 = createHash('sha256')
      .update(readFileSync(join(root, 'quality-replay.jsonl'))).digest('hex');
    assert.throws(() => loadQualityPromotionRawBundle({
      artifactPath: valid.artifactPath, artifact: valid.artifact, rootDir: process.cwd()
    }), /raw derivation|quality report|eligible|manual/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
