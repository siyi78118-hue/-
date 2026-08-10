import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { QUALITY_DIMENSIONS, compileSceneExecutionInput } from '../src/quality-evaluator.mjs';
import { contentHash } from '../src/protocol.mjs';
import { buildVerifiedQualityReplayPlan, writeQualityReplayPlanArtifact } from '../src/quality-replay.mjs';
import { compileQualitySuite } from '../../scripts/compile-yuqi-lived-quality-scenes.mjs';
import {
  buildCandidateReleaseDefinition,
  deriveManualReviewRequirements,
  materializeQualityReport as materializeQualityReportImpl,
  materializeQualityReportFromArtifacts
} from '../../scripts/report-yuqi-lived-quality.mjs';

const COMPILED_SUITE = compileQualitySuite({ rootDir: process.cwd(), checkOnly: true });
const HISTORY_SCENES = Array.from({ length: 30 }, (_, index) => ({
  sceneId: `history-${index}`,
  rolloutKey: 'direct',
  turns: []
}));
const AUTHORITY_PLAN = buildVerifiedQualityReplayPlan({
  compiledSuite: COMPILED_SUITE,
  historyScenes: HISTORY_SCENES,
  historyManifest: {
    schemaVersion: 1,
    sceneIds: HISTORY_SCENES.map(scene => scene.sceneId),
    scenesChecksum: contentHash(HISTORY_SCENES)
  }
});
const SOURCE_HEAD = 'd'.repeat(40);

function evidence() {
  const make = (layer) => AUTHORITY_PLAN.items.filter(item => item.layer === layer).map(item => ({
    ...(() => { const executionChecksum = contentHash(compileSceneExecutionInput(item.scene)); return { executionChecksum }; })(),
    layer, sceneId: item.sceneId, repeatIndex: item.repeatIndex, finalized: true,
    scores: Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, 4])),
    preference: 'candidate', regression: false, severe: false, tie: false,
    findings: [], unresolved: false, structuralRegression: false, protocolFailure: false,
    attempts: [{ attemptIndex: 0, evaluatorId: `${layer}-${item.sceneId}-${item.repeatIndex}`,
      accepted: true, unresolved: false, executionChecksum: contentHash(compileSceneExecutionInput(item.scene)),
      latencyMs: 0, evaluatorVersion: 'blind-evaluator-v1' }],
    latencyMs: 0, evaluatorVersion: 'blind-evaluator-v1'
  }));
  return { sentinelRuns: make('sentinel'), coverageRuns: make('coverage'), historyRuns: make('history') };
}

function replayProvenance(plan, candidate) {
  const keys = plan.items.map(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}`);
  const executionPairs = keys.map(finalKey => ({
      executionChecksum: contentHash(compileSceneExecutionInput(plan.items.find(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}` === finalKey).scene)),
      finalKey,
      sourceHead: SOURCE_HEAD,
      stableReleaseId: 'stable-release-v1',
      stableReleaseChecksum: 'a'.repeat(64),
      candidateReleaseId: candidate.releaseId,
      candidateReleaseChecksum: candidate.releaseChecksum,
      stableInputChecksum: contentHash(compileSceneExecutionInput(plan.items.find(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}` === finalKey).scene)),
      candidateInputChecksum: contentHash(compileSceneExecutionInput(plan.items.find(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}` === finalKey).scene)),
      dryRun: true,
      capabilities: { visible: false, actions: false }
    }));
  const modelRuns = keys.map(finalKey => ({
      finalKey,
      attemptIndex: 0,
      evaluatorId: 'blind-evaluator-v1',
      inputChecksum: 'c'.repeat(64),
      completed: true
    }));
  const provenance = { sourceHead: SOURCE_HEAD, executionPairs, modelRuns };
  return { ...provenance, provenanceChecksum: contentHash(provenance) };
}

const AUTHORITY_DIRECTORY = mkdtempSync(join(tmpdir(), 'yuqi-quality-report-authority-'));
const AUTHORITY_PLAN_PATH = join(AUTHORITY_DIRECTORY, 'plan.json');
const AUTHORITY_HISTORY_PATH = join(AUTHORITY_DIRECTORY, 'history.json');
const AUTHORITY_MANIFEST_PATH = join(AUTHORITY_DIRECTORY, 'history-manifest.json');
const AUTHORITY_MANIFEST = {
  schemaVersion: 1,
  sceneIds: HISTORY_SCENES.map(scene => scene.sceneId),
  scenesChecksum: contentHash(HISTORY_SCENES)
};
writeQualityReplayPlanArtifact(AUTHORITY_PLAN, AUTHORITY_PLAN_PATH);
writeFileSync(AUTHORITY_HISTORY_PATH, JSON.stringify(HISTORY_SCENES));
writeFileSync(AUTHORITY_MANIFEST_PATH, JSON.stringify(AUTHORITY_MANIFEST));
test.after(() => rmSync(AUTHORITY_DIRECTORY, { recursive: true, force: true }));

function materializeQualityReport(args = {}) {
  if (args.expected === undefined && args.expectedPlan === undefined && args.planArtifactPath === undefined) {
    return materializeQualityReportImpl(args);
  }
  const candidate = args.candidateRelease;
  const { expected: _expected, expectedPlan: _expectedPlan, ...rest } = args;
  return materializeQualityReportImpl({
    planArtifactPath: AUTHORITY_PLAN_PATH,
    rootDir: process.cwd(),
    historyPath: AUTHORITY_HISTORY_PATH,
    historyManifestPath: AUTHORITY_MANIFEST_PATH,
    historyScenes: HISTORY_SCENES,
    historyManifest: AUTHORITY_MANIFEST,
    replayProvenance: candidate ? replayProvenance(AUTHORITY_PLAN, candidate) : undefined,
    ...rest
  });
}

function manualQueueFor(evidenceValue) {
  return deriveManualReviewRequirements(evidenceValue, AUTHORITY_PLAN, { includePassingSample: true })
    .map((requirement, index) => ({
      reviewId: `review_${index}`,
      evalRunId: 'run_1',
      sceneId: requirement.sceneId,
      repeatIndex: requirement.repeatIndex,
      evidenceFindingIds: requirement.evidenceFindingIds,
      decision: 'confirm',
      reason: 'deterministic review',
      reviewer: 'central_window',
      createdAt: 0
    }));
}

test('candidate release definition and quality report are deterministic and metadata-only', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.1.0', cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2',
    evaluatorVersion: 'quality-evaluator-v1', modelProfile: 'blind-fixed',
    componentManifest: { evaluator: 'quality-evaluator-v1' }, createdAt: 0
  });
  assert.match(candidate.releaseId, /^quality_candidate_/);
  assert.match(candidate.releaseChecksum, /^[0-9a-f]{64}$/);
  const report = materializeQualityReport({ evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate });
  assert.equal(report.qualityGate.eligible, true);
  assert.deepEqual(report.evidenceBoundary, {
    version: 1,
    inputMode: 'explicit_override',
    sourceClass: 'explicit_history_override',
    offlineModelEvaluation: true,
    realHistoryEvidence: false,
    liveShadowEvidence: false
  });
  assert.equal(report.productionReleaseMutation, false);
  assert.deepEqual(report.candidateRelease, candidate);
  assert.equal(report.sourceHead, SOURCE_HEAD);
  assert.equal(report.evidenceBoundaryChecksum, contentHash({
    evidenceBoundary: report.evidenceBoundary,
    planChecksum: report.planChecksum,
    sourceHead: report.sourceHead,
    provenanceChecksum: report.replayProvenance.provenanceChecksum
  }));
});

test('report rejects final and attempt evidence without exact execution/input/source/candidate pair joins', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const forgedEvidence = evidence();
  delete forgedEvidence.historyRuns[0].attempts[0].executionChecksum;
  const report = materializeQualityReport({
    evidence: forgedEvidence, expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
    manualReviewQueue: manualQueueFor(forgedEvidence)
  });
  assert.equal(report.eligible, false);
});

test('report rejects mixed, missing, or mismatched execution source/candidate provenance', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const variants = [
    provenance => {
      delete provenance.executionPairs[0].sourceHead;
      provenance.provenanceChecksum = contentHash({
        sourceHead: provenance.sourceHead, executionPairs: provenance.executionPairs, modelRuns: provenance.modelRuns
      });
    },
    provenance => {
      provenance.executionPairs[1].sourceHead = 'e'.repeat(40);
      provenance.provenanceChecksum = contentHash({
        sourceHead: provenance.sourceHead, executionPairs: provenance.executionPairs, modelRuns: provenance.modelRuns
      });
    },
    provenance => {
      provenance.executionPairs[2].candidateReleaseChecksum = 'f'.repeat(64);
      provenance.provenanceChecksum = contentHash({
        sourceHead: provenance.sourceHead, executionPairs: provenance.executionPairs, modelRuns: provenance.modelRuns
      });
    }
  ];
  for (const mutate of variants) {
    const provenance = replayProvenance(AUTHORITY_PLAN, candidate);
    mutate(provenance);
    const report = materializeQualityReport({
      evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
      replayProvenance: provenance
    });
    assert.equal(report.eligible, false);
    assert.ok(report.failedGates.includes('QUALITY_REPORT_AUTHORITY_INVALID'));
  }
});

test('report rejects unresolved evidence and caller-supplied release identity', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const incomplete = evidence();
  incomplete.historyRuns[0].unresolved = true;
  incomplete.historyRuns[0].attempts[0].accepted = false;
  incomplete.historyRuns[0].attempts[0].unresolved = true;
  const incompleteReport = materializeQualityReport({ evidence: incomplete, expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate });
  assert.equal(incompleteReport.eligible, false);
  assert.ok(incompleteReport.qualityGate.failedGates.includes('INCOMPLETE_QUALITY_EVIDENCE'));
  assert.throws(() => buildCandidateReleaseDefinition({ ...candidate, releaseId: 'caller-id' }), /caller|release/i);
});

test('report rejects unsupported executor releases and unresolved manual review', () => {
  assert.throws(() => buildCandidateReleaseDefinition({
    pipelineVersion: 'not-supported-by-release-executor', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  }), /unsupported|executor|pipeline/i);
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const report = materializeQualityReport({
    evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
    manualReviewQueue: [{
      reviewId: 'review_1', evalRunId: 'run_1', sceneId: 'history-0', repeatIndex: 0,
      evidenceFindingIds: [], decision: 'unresolved', reason: 'pending', reviewer: 'central_window', createdAt: 0
    }]
  });
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('UNRESOLVED_MANUAL_REVIEW'));
});

test('manual review queue has a closed schema and rejects secret fields', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  assert.throws(() => materializeQualityReport({
    evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
    manualReviewQueue: [{
      reviewId: 'review_1', evalRunId: 'run_1', sceneId: 'history-0', repeatIndex: 0,
      evidenceFindingIds: [], decision: 'confirm', reason: 'ok', reviewer: 'central_window', createdAt: 0,
      secret: 'leak'
    }]
}), /manual review|unknown|closed/i);
});

test('manual review requirements are recomputed from findings rather than caller severity flags', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const criticalEvidence = evidence();
  criticalEvidence.historyRuns[0].findings = [{
    code: 'CUSTOM_CRITICAL', severity: 'critical', owner: 'comparison-evaluator-v1',
    summary: 'target', critical: true
  }];
  criticalEvidence.historyRuns[0].severe = false;
  criticalEvidence.historyRuns[0].protocolFailure = false;
  const report = materializeQualityReport({
    evidence: criticalEvidence, expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
    manualReviewQueue: manualQueueFor(criticalEvidence)
  });
  assert.equal(report.eligible, true);
  assert.equal(report.manualReview.eligible, true);
  const missing = materializeQualityReport({
    evidence: criticalEvidence, expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.failedGates.includes('MISSING_MANUAL_REVIEW'));
});

test('manual review queue derives score-one and structured-action requirements from evidence', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const flagged = evidence();
  const row = flagged.historyRuns[0];
  row.scores.socialUnderstanding = 1;
  row.severe = false;
  row.findings = [{
    code: 'ACTION_TARGET_ESCALATION', severity: 'critical', owner: 'comparison-evaluator-v1',
    summary: 'structured action sample', critical: false
  }];
  const report = materializeQualityReport({
    evidence: flagged,
    expectedPlan: AUTHORITY_PLAN,
    candidateRelease: candidate,
    manualReviewQueue: manualQueueFor(flagged)
  });
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('SEVERE_SCORE_ONE'));
  assert.equal(report.manualReview.eligible, true);
});

test('manual review evidence IDs must match the derived finding set exactly', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const flagged = evidence();
  const row = flagged.historyRuns[0];
  row.findings = [{
    code: 'CUSTOM_CRITICAL', severity: 'critical', owner: 'comparison-evaluator-v1',
    summary: 'target', critical: true
  }];
  const report = materializeQualityReport({
    evidence: flagged,
    expectedPlan: AUTHORITY_PLAN,
    candidateRelease: candidate,
    manualReviewQueue: [{
      reviewId: 'review_extra', evalRunId: 'run_1', sceneId: row.sceneId, repeatIndex: row.repeatIndex,
      evidenceFindingIds: ['CUSTOM_CRITICAL', 'UNRELATED_FINDING'], decision: 'confirm', reason: 'reviewed',
      reviewer: 'central_window', createdAt: 0
    }]
  });
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('MISSING_MANUAL_REVIEW'));
});

test('report CLI reloads the closed plan artifact instead of trusting caller keys', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-report-'));
  try {
    const planPath = join(directory, 'plan.json');
    const historyPath = join(directory, 'history.json');
    const manifestPath = join(directory, 'history-manifest.json');
    const evidencePath = join(directory, 'evidence.json');
    const candidatePath = join(directory, 'candidate.json');
    const provenancePath = join(directory, 'provenance.json');
    const manualReviewPath = join(directory, 'manual-review.jsonl');
    const outPath = join(directory, 'report.json');
    writeQualityReplayPlanArtifact(AUTHORITY_PLAN, planPath);
    writeFileSync(historyPath, JSON.stringify(HISTORY_SCENES));
    writeFileSync(manifestPath, JSON.stringify({
      schemaVersion: 1,
      sceneIds: HISTORY_SCENES.map(scene => scene.sceneId),
      scenesChecksum: contentHash(HISTORY_SCENES)
    }));
    writeFileSync(evidencePath, JSON.stringify(evidence()));
    writeFileSync(candidatePath, JSON.stringify(candidate));
    writeFileSync(provenancePath, JSON.stringify(replayProvenance(AUTHORITY_PLAN, candidate)));
    const queue = deriveManualReviewRequirements(evidence(), AUTHORITY_PLAN, { includePassingSample: true })
      .map((requirement, index) => JSON.stringify({
        reviewId: `review_${index}`,
        evalRunId: 'run_1',
        sceneId: requirement.sceneId,
        repeatIndex: requirement.repeatIndex,
        evidenceFindingIds: requirement.evidenceFindingIds,
        decision: 'confirm',
        reason: 'deterministic sample reviewed',
        reviewer: 'central_window',
        createdAt: 0
      })).join('\n');
    writeFileSync(manualReviewPath, `${queue}${queue ? '\n' : ''}`);
    execFileSync(process.execPath, [
      'scripts/report-yuqi-lived-quality.mjs', '--root', process.cwd(), '--plan', planPath,
      '--history', historyPath, '--history-manifest', manifestPath, '--evidence', evidencePath,
      '--candidate-release', candidatePath, '--replay-provenance', provenancePath,
      '--manual-review', manualReviewPath, '--out', outPath
    ], { cwd: process.cwd(), encoding: 'utf8' });
    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    assert.equal(report.eligible, true);
    assert.equal(report.productionReleaseMutation, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('report rejects caller-supplied expected final keys instead of treating them as an authority plan', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const forgedKeys = materializeQualityReportImpl({
    evidence: evidence(), expected: AUTHORITY_PLAN.finalKeys, candidateRelease: candidate
  });
  assert.equal(forgedKeys.eligible, false);
  const forgedPlan = materializeQualityReportImpl({
    evidence: evidence(), expectedPlan: { ...AUTHORITY_PLAN, planChecksum: '0'.repeat(64) }, candidateRelease: candidate
  });
  assert.equal(forgedPlan.eligible, false);
  assert.ok(forgedPlan.failedGates.includes('REPLAY_PROVENANCE_REQUIRED'));
});

test('report rejects absent or forged replay execution provenance', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const missing = materializeQualityReportImpl({
    evidence: evidence(), planArtifactPath: AUTHORITY_PLAN_PATH, rootDir: process.cwd(),
    historyPath: AUTHORITY_HISTORY_PATH, historyManifestPath: AUTHORITY_MANIFEST_PATH,
    historyScenes: HISTORY_SCENES, historyManifest: AUTHORITY_MANIFEST, candidateRelease: candidate,
    replayProvenance: { executionPairs: [], modelRuns: [] }
  });
  assert.equal(missing.eligible, false);
  assert.ok(missing.failedGates.includes('QUALITY_REPORT_AUTHORITY_INVALID'));
  const report = materializeQualityReportImpl({
    evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate,
    replayProvenance: replayProvenance(AUTHORITY_PLAN, candidate)
  });
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('QUALITY_PLAN_ARTIFACT_REQUIRED'));
});

test('materializeQualityReport cannot pass without replay provenance and a disk authority context', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0',
    cognitionSchemaVersion: 'v3', expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1',
    modelProfile: 'blind-fixed', componentManifest: {}, createdAt: 0
  });
  const report = materializeQualityReportImpl({
    evidence: evidence(), expectedPlan: AUTHORITY_PLAN, candidateRelease: candidate
  });
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('REPLAY_PROVENANCE_REQUIRED'));
});

test('formal quality reporter selects one raw run and binds all three artifact checksums', () => {
  const candidate = buildCandidateReleaseDefinition({
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.1.0', cognitionSchemaVersion: 'v3',
    expressionSchemaVersion: 'v2', evaluatorVersion: 'quality-evaluator-v1', modelProfile: 'blind-fixed',
    componentManifest: {}, createdAt: 0
  });
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-bundle-'));
  try {
    const runId = '22222222-2222-4222-8222-222222222222';
    const base = replayProvenance(AUTHORITY_PLAN, candidate);
    const provenanceBase = { runId, sourceHead: base.sourceHead, executionPairs: base.executionPairs, modelRuns: base.modelRuns };
    const provenance = { ...provenanceBase, provenanceChecksum: contentHash(provenanceBase) };
    const rows = [
      ...Object.values(evidence()).flatMap(group => group.flatMap(row => row.attempts.map(attempt => ({
        recordType: 'attempt', runId, layer: row.layer, sceneId: row.sceneId, repeatIndex: row.repeatIndex, ...attempt
      })))),
      ...Object.values(evidence()).flatMap(group => group.map(row => ({ recordType: 'final', runId, ...row }))),
      { recordType: 'provenance', runId, sourceHead: provenance.sourceHead, provenanceChecksum: provenance.provenanceChecksum },
      ...provenance.executionPairs.map(row => ({ recordType: 'execution', runId, ...row })),
      ...provenance.modelRuns.map(row => ({ recordType: 'model', runId, ...row })),
      ...Object.values(evidence()).flatMap(group => group.map(row => ({
        recordType: 'final-checksum', runId, finalKey: `${row.layer}:${row.sceneId}:${row.repeatIndex}`,
        executionChecksum: row.executionChecksum, latencyMs: row.latencyMs, evaluatorVersion: row.attempts[0].evaluatorVersion || 'blind-evaluator-v1'
      })))
    ];
    const requirements = deriveManualReviewRequirements(evidence(), AUTHORITY_PLAN, { includePassingSample: true });
    const manualRows = [
      { recordType: 'metadata', runId, sourceHead: SOURCE_HEAD, candidateReleaseId: candidate.releaseId,
        candidateReleaseChecksum: candidate.releaseChecksum, planChecksum: AUTHORITY_PLAN.planChecksum },
      ...requirements.map((requirement, index) => ({
        recordType: 'review', runId, reviewId: `review-${index}`, evalRunId: runId,
        sceneId: requirement.sceneId, repeatIndex: requirement.repeatIndex,
        evidenceFindingIds: requirement.evidenceFindingIds, decision: 'confirm', reason: 'fixture',
        reviewer: 'central_window', createdAt: 0
      }))
    ];
    const planPath = AUTHORITY_PLAN_PATH;
    const replayPath = join(directory, 'quality-replay.jsonl');
    const manualPath = join(directory, 'quality-manual-review.jsonl');
    writeFileSync(replayPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    writeFileSync(manualPath, `${manualRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const report = materializeQualityReportFromArtifacts({
      planArtifactPath: planPath, replayArtifactPath: replayPath, manualReviewArtifactPath: manualPath,
      rootDir: process.cwd(), historyPath: AUTHORITY_HISTORY_PATH, historyManifestPath: AUTHORITY_MANIFEST_PATH,
      candidateRelease: candidate
    });
    assert.equal(report.replayRunId, runId);
    assert.match(report.qualityPlanSha256, /^[0-9a-f]{64}$/);
    assert.match(report.qualityReplaySha256, /^[0-9a-f]{64}$/);
    assert.match(report.qualityManualReviewSha256, /^[0-9a-f]{64}$/);
    const replayRows = readFileSync(replayPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const forgedKey = `${AUTHORITY_PLAN.items[0].layer}:${AUTHORITY_PLAN.items[0].sceneId}:${AUTHORITY_PLAN.items[0].repeatIndex}`;
    const forgedChecksum = 'c'.repeat(64);
    for (const row of replayRows) {
      const rowKey = row.finalKey || `${row.layer}:${row.sceneId}:${row.repeatIndex}`;
      if (rowKey !== forgedKey) continue;
      if (row.recordType === 'execution' || row.recordType === 'attempt' || row.recordType === 'final-checksum') {
        row.executionChecksum = forgedChecksum;
        if (row.recordType === 'execution') {
          row.stableInputChecksum = forgedChecksum;
          row.candidateInputChecksum = forgedChecksum;
        }
      }
      if (row.recordType === 'final') {
        row.executionChecksum = forgedChecksum;
        row.attempts = row.attempts.map(attempt => ({ ...attempt, executionChecksum: forgedChecksum }));
      }
    }
    const forgedExecutionPairs = replayRows.filter(row => row.recordType === 'execution').map(row => {
      const copy = { ...row };
      delete copy.recordType; delete copy.runId;
      return copy;
    });
    const forgedModelRuns = replayRows.filter(row => row.recordType === 'model').map(row => {
      const copy = { ...row };
      delete copy.recordType; delete copy.runId;
      return copy;
    });
    const provenanceRow = replayRows.find(row => row.recordType === 'provenance');
    const forgedProvenance = {
      runId, sourceHead: provenanceRow.sourceHead,
      executionPairs: forgedExecutionPairs, modelRuns: forgedModelRuns
    };
    provenanceRow.provenanceChecksum = contentHash(forgedProvenance);
    writeFileSync(replayPath, `${replayRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => materializeQualityReportFromArtifacts({
      planArtifactPath: planPath, replayArtifactPath: replayPath, manualReviewArtifactPath: manualPath,
      rootDir: process.cwd(), historyPath: AUTHORITY_HISTORY_PATH, historyManifestPath: AUTHORITY_MANIFEST_PATH,
      candidateRelease: candidate
    }), /execution input checksum authority conflict/i);
    // Recreate the untouched valid raw replay before the independent run-identity mutation.
    writeFileSync(replayPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
    const validRows = rows.map(row => ({ ...row }));
    validRows[0].runId = '33333333-3333-4333-8333-333333333333';
    writeFileSync(replayPath, `${validRows.map(row => JSON.stringify(row)).join('\n')}\n`);
    assert.throws(() => materializeQualityReportFromArtifacts({
      planArtifactPath: planPath, replayArtifactPath: replayPath, manualReviewArtifactPath: manualPath,
      rootDir: process.cwd(), historyPath: AUTHORITY_HISTORY_PATH, historyManifestPath: AUTHORITY_MANIFEST_PATH,
      candidateRelease: candidate
    }), /run identity|run/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
