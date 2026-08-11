import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  COGNITION_ROLLOUT_KEYS,
  PromotionController
} from '../src/promotion-controller.mjs';
import { RolloutRevisionConflictError, YuqiStore } from '../src/store.mjs';
import { contentHash } from '../src/protocol.mjs';
import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { YuqiOrchestrator } from '../src/orchestrator.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';
import {
  executeRolloutCommand,
  loadQualityPromotionRawBundle,
  preflightRolloutSourceAuthority,
  reportSummaryFromArtifact,
  setRolloutCommandRunnerForTests
} from '../../scripts/cognition-rollout.mjs';
import { QUALITY_DIMENSIONS, aggregateQualityGate, compileSceneExecutionInput } from '../src/quality-evaluator.mjs';
import { deriveManualReviewRequirements } from '../../scripts/report-yuqi-lived-quality.mjs';
import { createQualityReplayPlan } from '../../scripts/run-yuqi-lived-quality-replay.mjs';
import { expectedFinalKeysProjection, validateQualityReplayV2Rows, writeQualityReplayPlanArtifact } from '../src/quality-replay.mjs';
import { deriveManualV2RequirementsFromValidated, projectV2Provenance, evidenceBoundaryChecksum,
  validateQualityArtifactBundle } from '../../scripts/report-yuqi-lived-quality.mjs';

function silentStdout() {
  return { write() {} };
}

function currentSourceHead() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function installCleanSourceRunner({ head = currentSourceHead(), status = '' } = {}) {
  setRolloutCommandRunnerForTests((executable, args) => {
    if (executable !== 'git') return { exitCode: 1, stdout: '' };
    if (args[0] === 'rev-parse') return { exitCode: 0, stdout: `${head}\n` };
    if (args[0] === 'status') return { exitCode: 0, stdout: status };
    return { exitCode: 1, stdout: '' };
  });
  return () => setRolloutCommandRunnerForTests(null);
}

function promotionEvidenceTempDir(prefix) {
  const evidenceRoot = join(process.cwd(), 'artifacts', 'yuqi-lived-agency-v3');
  mkdirSync(evidenceRoot, { recursive: true });
  return mkdtempSync(join(evidenceRoot, `.tmp-${prefix}-`));
}

function sha256File(path) {
  return contentHash(readFileSync(path).toString('base64'));
}

function rawFileHash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function criticalJudgments(subjectId, code = 'PUBLIC_PRIVACY_VIOLATION') {
  return [
    {
      evaluatorId: 'evaluator-a', judgmentId: `${subjectId}-judgment-a`,
      subjectId, severity: 'critical', code
    },
    {
      evaluatorId: 'evaluator-b', judgmentId: `${subjectId}-judgment-b`,
      subjectId, severity: 'critical', code
    }
  ];
}

function registry(checksum = 'evidence-a') {
  return {
    evidenceManifest(rolloutKey) {
      return {
        manifest: { rolloutKey, checksum },
        checksum: `${checksum}:${rolloutKey}`,
        presetVersion: '2.0.0'
      };
    }
  };
}

function envelope(sequence = 1, kind = 'DIRECT_REPLY') {
  return {
    protocolVersion: 2,
    turnId: `turn_rollout_${sequence}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: sequence,
    createdAt: 1_000 + sequence,
    kind,
    message: {
      messageId: `msg_rollout_${sequence}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `消息 ${sequence}`,
      sentAt: 1_000 + sequence
    }
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-rollout-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    return run(store);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function candidateRelease(releaseId = 'candidate-r3') {
  const release = {
    releaseId,
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.0.0',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    evaluatorVersion: 'yuqi-lived-quality-v1',
    modelProfile: { cognition: 'candidate-model' },
    componentManifest: { suite: 'quality-suite-v1' },
    createdAt: 2_000,
    retiredAt: null
  };
  const checksum = contentHash({
    pipelineVersion: release.pipelineVersion,
    presetVersion: release.presetVersion,
    cognitionSchemaVersion: release.cognitionSchemaVersion,
    expressionSchemaVersion: release.expressionSchemaVersion,
    evaluatorVersion: release.evaluatorVersion,
    modelProfile: release.modelProfile,
    componentManifest: release.componentManifest,
    createdAt: release.createdAt
  });
  return {
    ...release,
    releaseId: releaseId === 'candidate-r3' ? `quality_candidate_${checksum.slice(0, 16)}` : releaseId,
    releaseChecksum: checksum
  };
}

function materializedCandidateReport(store, rolloutKey = 'DIRECT_REPLY', candidate = candidateRelease()) {
  const stable = store.getCognitionRollout(rolloutKey);
  const summary = {
    eligible: true,
    candidateRelease: candidate,
    stableBaselineReleaseId: stable.stableReleaseId,
    stableBaselineReleaseChecksum: store.getPipelineRelease(stable.stableReleaseId).releaseChecksum,
    evaluatorVersion: 'yuqi-lived-quality-v1',
    suiteChecksum: 'suite-checksum-v1',
    liveShadowSuccessCount: 30,
    criticalErrors: 0
  };
  const report = store.putEvaluationReportInternal({
    reportId: `quality-report-${rolloutKey}`,
    reportType: 'promotion',
    rolloutKey,
    sourceType: 'aggregate_gate',
    sourceRef: `quality-report-${rolloutKey}.json`,
    artifactPath: `artifacts/${rolloutKey}.json`,
    summary,
    createdAt: 2_100
  });
  store.markEvaluationReportMaterialized({
    reportId: report.reportId,
    expectedChecksum: report.artifactChecksum,
    now: 2_200
  });
  return store.getEvaluationReport(report.reportId);
}

function qualityReportArtifact(store, rolloutKey = 'DIRECT_REPLY', reportId = 'cli-quality-report') {
  const rollout = store.getCognitionRollout(rolloutKey);
  const stable = store.getPipelineRelease(rollout.stableReleaseId);
  return {
    version: 1,
    productionReleaseMutation: false,
    eligible: true,
    failedGates: [],
    reportId,
    candidateRelease: candidateRelease(),
    planChecksum: 'task23-plan-checksum',
    replayProvenance: {
      executionPairs: [{
        stableReleaseId: stable.releaseId,
        stableReleaseChecksum: stable.releaseChecksum
      }],
      modelRuns: [{ runId: `${reportId}-model-run`, completed: true }]
    },
    qualityGate: {
      eligible: true,
      failedGates: [],
      liveShadowSuccessCount: 30,
      criticalErrors: 0
    },
    manualReview: { eligible: true, failedGates: [] }
  };
}

function writeTrackedRawBundle(directory, artifact, {
  stableReleaseId = 'stable-r2', stableReleaseChecksum = 'b'.repeat(64),
  sourceHead = 'a'.repeat(40)
} = {}) {
  const plan = createQualityReplayPlan({ rootDir: process.cwd() });
  const runId = '33333333-3333-4333-8333-333333333333';
  const executionPairs = plan.items.map(item => {
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    const executionChecksum = contentHash(compileSceneExecutionInput(item.scene));
    return {
      finalKey, sourceHead, stableReleaseId, stableReleaseChecksum,
      candidateReleaseId: artifact.candidateRelease.releaseId,
      candidateReleaseChecksum: artifact.candidateRelease.releaseChecksum,
      executionChecksum, stableInputChecksum: executionChecksum, candidateInputChecksum: executionChecksum,
      dryRun: true, capabilities: { visible: false, actions: false }
    };
  });
  const modelRuns = executionPairs.map(pair => ({
    finalKey: pair.finalKey, attemptIndex: 0, evaluatorId: 'blind-evaluator-v1', inputChecksum: 'c'.repeat(64), completed: true
  }));
  const finals = plan.items.map(item => {
    const finalKey = `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
    const executionChecksum = executionPairs.find(pair => pair.finalKey === finalKey).executionChecksum;
    const attempt = { attemptIndex: 0, evaluatorId: 'blind-evaluator-v1', evaluatorVersion: 'blind-evaluator-v1',
      executionChecksum, latencyMs: 1, accepted: true, unresolved: false };
    return {
      layer: item.layer, sceneId: item.sceneId, repeatIndex: item.repeatIndex, finalized: true,
      scores: Object.fromEntries(QUALITY_DIMENSIONS.map(key => [key, 4])), preference: 'candidate', findings: [],
      regression: false, severe: false, tie: false, unresolved: false, structuralRegression: false,
      protocolFailure: false, executionChecksum, latencyMs: 1, evaluatorVersion: 'blind-evaluator-v1', attempts: [attempt]
    };
  });
  const provenanceBase = { runId, sourceHead, executionPairs, modelRuns };
  const provenance = { ...provenanceBase, provenanceChecksum: contentHash(provenanceBase) };
  const replayRows = [
    ...finals.flatMap(row => row.attempts.map(attempt => ({ recordType: 'attempt', runId,
      layer: row.layer, sceneId: row.sceneId, repeatIndex: row.repeatIndex, ...attempt }))),
    ...finals.map(row => ({ recordType: 'final', runId, ...row })),
    { recordType: 'provenance', runId, sourceHead, provenanceChecksum: provenance.provenanceChecksum },
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
  const expected = expectedFinalKeysProjection(plan);
  const requirements = deriveManualReviewRequirements(evidence, plan, { includePassingSample: true });
  const manualRows = [{ recordType: 'metadata', runId, sourceHead,
    candidateReleaseId: artifact.candidateRelease.releaseId,
    candidateReleaseChecksum: artifact.candidateRelease.releaseChecksum, planChecksum: plan.planChecksum },
    ...requirements.map((requirement, index) => ({ recordType: 'review', runId, reviewId: `review-${index}`, evalRunId: runId,
      sceneId: requirement.sceneId, repeatIndex: requirement.repeatIndex, evidenceFindingIds: requirement.evidenceFindingIds,
      decision: 'confirm', reason: 'fixture', reviewer: 'central_window', createdAt: 0 }))];
  const planPath = join(directory, 'quality-replay-plan.json');
  const replayPath = join(directory, 'quality-replay.jsonl');
  const manualPath = join(directory, 'quality-manual-review.jsonl');
  writeQualityReplayPlanArtifact(plan, planPath);
  writeFileSync(replayPath, `${replayRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(manualPath, `${manualRows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const fileSha = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  artifact.planChecksum = plan.planChecksum;
  artifact.sourceHead = sourceHead;
  artifact.replayRunId = runId;
  artifact.replayProvenance = provenance;
  artifact.qualityPlanSha256 = fileSha(planPath);
  artifact.qualityReplaySha256 = fileSha(replayPath);
  artifact.qualityManualReviewSha256 = fileSha(manualPath);
  artifact.qualityGate = aggregateQualityGate(evidence, expected);
  artifact.manualReview = {
    eligible: true, failedGates: [], unresolvedCount: 0, requiredCount: requirements.length,
    requirements, queue: manualRows.slice(1).map(({ recordType: _recordType, runId: _runId, ...row }) => row)
  };
  artifact.eligible = artifact.qualityGate.eligible && artifact.manualReview.eligible;
  artifact.evidenceBoundary = { version: 1, inputMode: 'preset_default', sourceClass: 'tracked_human_annotations',
    offlineModelEvaluation: true, realHistoryEvidence: false, liveShadowEvidence: false };
  artifact.evidenceBoundaryChecksum = contentHash({ evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum, sourceHead, provenanceChecksum: provenance.provenanceChecksum });
  return artifact;
}

function writeGenuineV2PendingBundle(directory, artifact, stableRelease) {
  const plan = createQualityReplayPlan({ rootDir: process.cwd() });
  const runId = '44444444-4444-4444-8444-444444444444';
  const finalKeys = plan.items.map(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}`);
  const header = { version: 1, sourceHead: currentSourceHead(), finalKeys,
    stableRelease: { releaseId: stableRelease.releaseId, releaseChecksum: stableRelease.releaseChecksum },
    candidateRelease: artifact.candidateRelease };
  const run = { schemaVersion: 2, recordType: 'run', runId, header, headerChecksum: contentHash(header), state: 'finalized', createdAt: 1, finalizedAt: 1000 };
  const executions = [], phases = [], calls = [], judgments = [], finals = [];
  const dimensions = [...QUALITY_DIMENSIONS];
  for (const [index, finalKey] of finalKeys.entries()) {
    const subjectType = 'turn';
    const subjectChecksum = contentHash({ finalKey, subjectType, index });
    const phaseMap = {};
    for (const [phaseIndex, phase] of ['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'].entries()) {
      const input = { finalKey, phase, index };
      const authorityInputChecksum = contentHash({ finalKey, phase, authority: true });
      const inputChecksum = contentHash({ subjectChecksum, authorityInputChecksum, input });
      const evaluation = phase.startsWith('evaluator_')
        ? { version: 1, scores: Object.fromEntries(dimensions.map(key => [key, 4])), preference: 'B', findings: [], unresolved: false }
        : null;
      const output = evaluation ?? { finalKey, phase, ok: true };
      const outputChecksum = contentHash(output);
      phaseMap[phase] = { inputChecksum, outputChecksum };
      phases.push({ schemaVersion: 2, recordType: 'phase', runId, finalKey, phase, state: 'succeeded', subjectChecksum, authorityInputChecksum,
        input, inputChecksum, output, outputChecksum, createdAt: 10 + phaseIndex, startingAt: 10 + phaseIndex, runningAt: 10 + phaseIndex, updatedAt: 20 + phaseIndex });
      const blindInput = { version: 1, finalKey, subjectType, subjectChecksum };
      const request = phase.startsWith('evaluator_') ? { input: JSON.stringify(blindInput), phase } : { phase, finalKey };
      const modelOutput = { phase, ok: true };
      calls.push({ schemaVersion: 2, recordType: 'model_call', runId, finalKey, phase, ordinal: 0, state: 'succeeded', role: 'brain',
        callId: `call-${index}-${phase}`, clientUserMessageId: `msg-${index}-${phase}`, threadId: `thread-${index}`, turnId: `turn-${index}-${phase}`,
        baseline: { phase }, baselineChecksum: contentHash({ phase }), request, requestChecksum: contentHash(request), model: 'model-v1', effort: 'high',
        schemaChecksum: contentHash({ schema: 1 }), output: modelOutput, outputChecksum: contentHash(modelOutput), runningAt: 10 + phaseIndex,
        createdAt: 10 + phaseIndex, updatedAt: 15 + phaseIndex });
      if (phase.startsWith('evaluator_')) {
        const evaluatorId = phase === 'evaluator_primary' ? 'evaluator-primary' : 'evaluator-secondary';
        const evaluatorVersion = phase === 'evaluator_primary' ? 'eval-v1' : 'eval-v1b';
        const inputChecksumForJudgment = contentHash(blindInput);
        const outputChecksumForJudgment = outputChecksum;
        judgments.push({ schemaVersion: 2, recordType: 'judgment', runId, finalKey, phase, evaluatorId, evaluatorVersion, inputChecksum: inputChecksumForJudgment,
          output: evaluation, outputChecksum: outputChecksumForJudgment, judgmentChecksum: contentHash({ finalKey, phase, evaluatorId, evaluatorVersion,
            inputChecksum: inputChecksumForJudgment, output: evaluation, outputChecksum: outputChecksumForJudgment }) });
      }
    }
    const primary = judgments.find(row => row.finalKey === finalKey && row.phase === 'evaluator_primary');
    const secondary = judgments.find(row => row.finalKey === finalKey && row.phase === 'evaluator_secondary');
    const value = { version: 1, finalKey, subjectType, subjectChecksum, stablePhase: phaseMap.stable_execution, candidatePhase: phaseMap.candidate_execution,
      blindInputChecksum: primary.inputChecksum,
      primary: { evaluatorId: primary.evaluatorId, evaluatorVersion: primary.evaluatorVersion, inputChecksum: primary.inputChecksum, output: primary.output, outputChecksum: primary.outputChecksum },
      secondary: { evaluatorId: secondary.evaluatorId, evaluatorVersion: secondary.evaluatorVersion, inputChecksum: secondary.inputChecksum, output: secondary.output, outputChecksum: secondary.outputChecksum },
      comparison: { version: 1, differences: [], manualReview: false, unresolved: false, agreedCriticalFindings: [] } };
    const execution = { schemaVersion: 2, recordType: 'execution', runId, finalKey, subjectType, subjectChecksum, stablePhase: phaseMap.stable_execution, candidatePhase: phaseMap.candidate_execution };
    execution.executionChecksum = contentHash({ finalKey, subjectType, subjectChecksum, stablePhase: execution.stablePhase, candidatePhase: execution.candidatePhase });
    executions.push(execution);
    finals.push({ schemaVersion: 2, recordType: 'final', runId, finalKey, value, valueChecksum: contentHash(value), executionChecksum: execution.executionChecksum, finalizedAt: 100 });
  }
  const bodyRows = [run, ...executions, ...phases, ...calls, ...judgments, ...finals];
  const recordCounts = { run: 1, execution: executions.length, phase: phases.length, modelCall: calls.length, judgment: judgments.length, final: finals.length };
  const provenance = { schemaVersion: 2, recordType: 'provenance', runId, recordCounts, recordsChecksum: contentHash(bodyRows),
    provenanceChecksum: contentHash({ runId, headerChecksum: run.headerChecksum, recordCounts, recordsChecksum: contentHash(bodyRows) }) };
  const validated = validateQualityReplayV2Rows({ rows: [...bodyRows, provenance], plan });
  const requirements = deriveManualV2RequirementsFromValidated(validated, plan);
  const requirementRows = requirements.map(requirement => {
    const js = validated.judgments.filter(row => row.finalKey === requirement.finalKey);
    return { finalKey: requirement.finalKey, primaryJudgmentChecksum: js.find(row => row.phase === 'evaluator_primary').judgmentChecksum,
      secondaryJudgmentChecksum: js.find(row => row.phase === 'evaluator_secondary').judgmentChecksum, executionChecksum: requirement.executionChecksum,
      finalValueChecksum: requirement.finalValueChecksum, evidenceFindingIds: requirement.evidenceFindingIds };
  });
  const meta = { schemaVersion: 2, recordType: 'manual_metadata', runId, sourceHead: header.sourceHead, candidateReleaseId: artifact.candidateRelease.releaseId,
    candidateReleaseChecksum: artifact.candidateRelease.releaseChecksum, planChecksum: plan.planChecksum, replayProvenanceChecksum: provenance.provenanceChecksum,
    requirementsChecksum: contentHash(requirementRows) };
  const reviews = requirementRows.map((item, index) => {
    const final = validated.finals.find(row => row.finalKey === item.finalKey);
    return { schemaVersion: 2, recordType: 'review', runId, reviewId: `qreview_${contentHash({ runId, finalKey: item.finalKey,
        primaryJudgmentChecksum: item.primaryJudgmentChecksum, secondaryJudgmentChecksum: item.secondaryJudgmentChecksum,
        executionChecksum: item.executionChecksum, finalValueChecksum: item.finalValueChecksum }).slice(0, 48)}`,
      finalKey: item.finalKey, primaryJudgmentChecksum: item.primaryJudgmentChecksum, secondaryJudgmentChecksum: item.secondaryJudgmentChecksum,
      executionChecksum: item.executionChecksum, finalValueChecksum: item.finalValueChecksum, evidenceFindingIds: item.evidenceFindingIds,
      decision: 'accept_primary', resolvedOutput: final.value.primary.output, reason: 'fixture', reviewer: 'central_window', createdAt: index };
  });
  const manualBody = [meta, ...reviews];
  const manualRecordCounts = { manualMetadata: 1, review: reviews.length };
  const manualProvenance = { schemaVersion: 2, recordType: 'manual_provenance', runId, recordCounts: manualRecordCounts,
    recordsChecksum: contentHash(manualBody), manualProvenanceChecksum: contentHash({ runId, requirementsChecksum: meta.requirementsChecksum,
      recordCounts: manualRecordCounts, recordsChecksum: contentHash(manualBody) }) };
  const planPath = join(directory, 'quality-replay-plan.json');
  const replayPath = join(directory, 'quality-replay.jsonl');
  const manualPath = join(directory, 'quality-manual-review.jsonl');
  writeQualityReplayPlanArtifact(plan, planPath);
  writeFileSync(replayPath, `${[...bodyRows, provenance].map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(manualPath, `${[...manualBody, manualProvenance].map(row => JSON.stringify(row)).join('\n')}\n`);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  artifact.planChecksum = plan.planChecksum; artifact.sourceHead = header.sourceHead; artifact.replayRunId = runId;
  artifact.replayProvenance = projectV2Provenance(validated);
  artifact.evidenceBoundary = { version: 1, inputMode: 'preset_default', sourceClass: 'tracked_human_annotations',
    offlineModelEvaluation: true, realHistoryEvidence: false, liveShadowEvidence: false };
  artifact.evidenceBoundaryChecksum = evidenceBoundaryChecksum({ evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum, sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum });
  artifact.qualityPlanSha256 = hash(planPath); artifact.qualityReplaySha256 = hash(replayPath); artifact.qualityManualReviewSha256 = hash(manualPath);
  const rawBundle = validateQualityArtifactBundle({
    plan,
    replayArtifactPath: replayPath,
    manualReviewArtifactPath: manualPath,
    candidateRelease: artifact.candidateRelease
  });
  artifact.qualityGate = rawBundle.qualityGate;
  artifact.manualReview = rawBundle.manualReview;
  artifact.eligible = rawBundle.derivedEligible;
  writeFileSync(join(directory, 'quality-report.json'), JSON.stringify(artifact));
  return { artifact, artifactPath: join(directory, 'quality-report.json') };
}

function registerInput(report, rolloutKey = 'DIRECT_REPLY', expectedRevision = 1) {
  return {
    rolloutKey,
    expectedRevision,
    releaseId: report.summary.candidateRelease.releaseId,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  };
}

function persistEvaluatorJudgments(store, {
  rolloutKey, subjectId, subjectChecksum, code, prefix, baseAt = 1_000
}) {
  const judgmentFindingIds = [];
  for (const [index, evaluatorId] of ['evaluator-a', 'evaluator-b'].entries()) {
    const evalRunId = `${prefix}-eval-${index}`;
    const judgmentId = `${prefix}-judgment-${index}`;
    const findingId = `${prefix}-finding-${index}`;
    judgmentFindingIds.push(findingId);
    store.putQualityEvalRunInternal({
      evalRunId, releaseId: 'release_candidate', baselineReleaseId: 'release_stable',
      suiteVersion: 'quality-v1', sourceType: 'live_shadow', state: 'completed',
      manifestChecksum: 'c'.repeat(64), summary: {}, artifactPath: '', createdAt: baseAt + index,
      completedAt: baseAt + index
    });
    store.putQualityFindingInternal({
      findingId, evalRunId, rolloutKey, sceneId: subjectId, repeatIndex: index,
      code, owner: evaluatorId, severity: 'critical',
      evidence: { subjectId, subjectChecksum, evaluatorId, judgmentId },
      scores: {}, createdAt: baseAt + index
    });
  }
  return {
    findingId: `finding_${contentHash({
      rolloutKey, subjectId, subjectChecksum, code,
      judgmentFindingIds: [...judgmentFindingIds].sort()
    }).slice(0, 24)}`,
    judgmentFindingIds
  };
}

function seedLiveShadowEvidence(store, rolloutKey = 'DIRECT_REPLY', count = 10) {
  const rollout = store.getCognitionRollout(rolloutKey);
  const base = 3_000;
  const span = 72 * 60 * 60 * 1000;
  for (let index = 0; index < count; index += 1) {
    store.putCognitionShadowRunInternal({
      runId: `live-shadow-${rolloutKey}-${index}`,
      subjectType: 'turn',
      subjectId: `live-subject-${index}`,
      turnId: `live-turn-${index}`,
      rolloutKey,
      source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: rollout.evidenceEpoch,
      shadowEpoch: rollout.shadowEpoch,
      rolloutRevision: rollout.revision,
      pipelineChecksum: rollout.pipelineChecksum,
      state: 'completed',
      criticalFindings: [],
      createdAt: base + Math.floor((span * index) / Math.max(1, count - 1)),
      updatedAt: base + Math.floor((span * index) / Math.max(1, count - 1))
    });
  }
}

function setupCanary(store, rolloutKey = 'DIRECT_REPLY') {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  if (rolloutKey === 'LIFE_PLANNING') {
    const stable = store.getCognitionRollout(rolloutKey).stableReleaseId;
    const candidate = store.listPipelineReleases().find(release => release.releaseId !== stable);
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET current_mode = 'active', rollout_phase = 'canary',
          candidate_release_id = ?, candidate_phase = 'canary',
          canary_epoch = 1, canary_started_count = 0,
          canary_completed_count = 0, canary_failure_count = 0,
          canary_started_at = NULL, canary_observe_until = 0
      WHERE rollout_key = ?
    `).run(candidate.releaseId, rolloutKey);
    return controller;
  }
  const report = materializedCandidateReport(store, rolloutKey);
  const registered = controller.registerCandidate(registerInput(report, rolloutKey));
  seedLiveShadowEvidence(store, rolloutKey, rolloutKey === 'DIRECT_REPLY' ? 10 : 30);
  controller.promoteToCanary({
    rolloutKey,
    expectedRevision: registered.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  });
  return controller;
}

function registerShadowCandidate(store, rolloutKey) {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const report = materializedCandidateReport(store, rolloutKey);
  const registered = controller.registerCandidate(registerInput(report, rolloutKey));
  return { controller, report, registered };
}

function seedLifePromotionAttempts(store, controller, {
  invalid = null,
  includeOldEpoch = false,
  now = 2_000_000_000_000
} = {}) {
  const rollout = controller.getStatus('LIFE_PLANNING');
  const attempts = [];
  const base = now - 30 * 10 * 60 * 60 * 1000;
  for (let index = 0; index < 30; index += 1) {
    const createdAt = base + index * 10 * 60 * 60 * 1000;
    const attempt = controller.createLifePlanningAttempt({
      roleId: `promotion-life-role-${index}`,
      planningContext: {
        planWindowStartAt: createdAt,
        targetPlanEndAt: createdAt + 60 * 60 * 1000
      },
      now: createdAt
    });
    attempts.push(attempt);
  }
  for (const [index, attempt] of attempts.entries()) {
    const comparisonState = invalid?.index === index && invalid.kind === 'comparison'
      ? invalid.state
      : 'completed';
    store.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET execution_state = 'completed', comparison_state = ?,
          completed_at = ?, updated_at = ?
      WHERE planning_id = ?
    `).run(comparisonState, base + index * 10 * 60 * 60 * 1000,
      base + index * 10 * 60 * 60 * 1000, attempt.planningId);
    if (comparisonState !== 'completed' || (invalid?.index === index && invalid.kind === 'missing')) {
      continue;
    }
    const runId = `promotion-life-run-${index}`;
    store.putCognitionShadowRunInternal({
      runId,
      subjectType: 'life_planning',
      subjectId: attempt.planningId,
      rolloutKey: 'LIFE_PLANNING',
      source: 'live',
      comparisonDirection: attempt.comparisonDirection,
      evidenceEpoch: attempt.rolloutEvidenceEpoch,
      shadowEpoch: attempt.shadowEpoch,
      rolloutRevision: attempt.rolloutRevision,
      pipelineChecksum: attempt.pipelineChecksum,
      state: 'completed',
      criticalFindings: invalid?.index === index && invalid.kind === 'critical'
        ? [{ code: 'CRITICAL', severity: 'critical' }]
        : [],
      staleForRollout: invalid?.index === index && invalid.kind === 'stale',
      createdAt: base + index * 10 * 60 * 60 * 1000,
      updatedAt: base + index * 10 * 60 * 60 * 1000
    });
    if (invalid?.index === index && invalid.kind === 'duplicate') {
      store.putCognitionShadowRunInternal({
        runId: `${runId}-extra`,
        subjectType: 'life_planning',
        subjectId: attempt.planningId,
        rolloutKey: 'LIFE_PLANNING',
        source: 'live',
        comparisonDirection: 'candidate_authoritative_stable_compare',
        evidenceEpoch: attempt.rolloutEvidenceEpoch,
        shadowEpoch: attempt.shadowEpoch,
        rolloutRevision: attempt.rolloutRevision,
        pipelineChecksum: attempt.pipelineChecksum,
        state: 'completed',
        criticalFindings: [],
        createdAt: base + index * 10 * 60 * 60 * 1000,
        updatedAt: base + index * 10 * 60 * 60 * 1000
      });
    }
  }
  if (includeOldEpoch) {
    const first = attempts[0];
    store.putCognitionShadowRunInternal({
      runId: 'promotion-life-old-epoch',
      subjectType: 'life_planning',
      subjectId: 'promotion-life-old-subject',
      rolloutKey: 'LIFE_PLANNING',
      source: 'live',
      comparisonDirection: first.comparisonDirection,
      evidenceEpoch: Number(first.rolloutEvidenceEpoch) - 1,
      shadowEpoch: Number(first.shadowEpoch) - 1,
      rolloutRevision: Number(first.rolloutRevision) - 1,
      pipelineChecksum: first.pipelineChecksum,
      state: 'completed',
      criticalFindings: [{ code: 'OLD_EPOCH', severity: 'critical' }],
      createdAt: base,
      updatedAt: base
    });
  }
  return attempts;
}

function canonicalDirectInput(store, controller, sequence) {
  const rollout = controller.getStatus('DIRECT_REPLY');
  const pair = controller.resolvePipelinePair(rollout);
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const currentEnvelope = envelope(sequence);
  const message = currentEnvelope.message;
  const rootSourceId = message.messageId;
  const localSequence = Number(lane?.localSequence || 0) + 1;
  currentEnvelope.protocolVersion = 3;
  currentEnvelope.context = {
    currentBatch: {
      batchId: `batch_${message.messageId}`,
      messageIds: [message.messageId],
      startedAt: message.sentAt,
      committedAt: message.sentAt,
      messages: [message]
    },
    visibilityCursor: {
      nativeCompletedTurnId: null,
      nativeCompletedGroupId: null,
      nativeCompletedSequence: 0,
      uiAppliedTurnId: null,
      uiAppliedGroupId: null,
      uiAppliedSequence: 0,
      localSequence,
      clearedThroughSequence: 0,
      clearEpoch: 0,
      clearedAt: 0,
      chatOpen: true,
      quotedMessageId: null
    }
  };
  currentEnvelope.authority = {
    algorithm: 'al-authority-v1',
    roleId: 'yuqi',
    laneKey: 'private_chat',
    rootSourceId,
    lineageKey: deriveAuthorityLineageKey({
      roleId: 'yuqi', laneKey: 'private_chat', rootSourceId
    }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi',
    at: currentEnvelope.message.sentAt
  });
  return {
    envelope: currentEnvelope,
    rolloutKey: 'DIRECT_REPLY',
    laneKey: 'private_chat',
    expectedRolloutRevision: rollout.revision,
    expectedLaneRevision: Number(lane?.revision || 0),
    inputVisibilitySequence: localSequence,
    inputClearEpoch: Number(lane?.clearEpoch || 0),
    inputUserBatchId: `batch_${currentEnvelope.message.messageId}`,
    agencySnapshotChecksum: agencySnapshot.checksum,
    authoritativeReleaseId: pair.visibleReleaseId,
    comparisonReleaseId: pair.comparisonReleaseId,
    comparisonDirection: pair.comparisonDirection,
    annotationSnapshot: {}
  };
}

function commitHardActionTurn(store, controller, sequence) {
  const creationInput = canonicalDirectInput(store, controller, sequence);
  const created = store.createCanonicalVisibleTurnInternal(creationInput);
  const turn = created.turn;
  const comparisonDirection = creationInput.comparisonDirection;
  const envelopeValue = JSON.parse(turn.envelopeJson);
  const visibleGroup = {
    items: [{
      content: `hard action receipt ${sequence}`,
      speakerId: 'yuqi', speakerType: 'character', recipientId: 'user'
    }]
  };
  const actionSet = [];
  const comparisonJob = {
    jobId: `hard-action-compare-${sequence}`,
    jobType: comparisonDirection === 'stable_authoritative_candidate_compare'
      ? 'shadow_cognition' : 'active_canary_compare',
    payload: {
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonDirection,
      rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
      shadowEpoch: turn.shadowEpoch,
      canaryEpoch: turn.canaryEpoch,
      canarySlot: turn.canarySlot,
      annotationSnapshotChecksum: contentHash(turn.annotationSnapshot || {}),
      inputChecksum: contentHash({
        envelope: envelopeValue,
        authoritativeReleaseId: turn.authoritativeReleaseId,
        authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
        comparisonReleaseId: turn.comparisonReleaseId,
        comparisonPipelineChecksum: turn.comparisonPipelineChecksum,
        rolloutRevision: turn.rolloutRevision,
        rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
        shadowEpoch: turn.shadowEpoch,
        canaryEpoch: turn.canaryEpoch,
        canarySlot: turn.canarySlot
      })
    }
  };
  const fingerprint = generationFingerprint({
    roleId: turn.characterId,
    laneKey: turn.laneKey,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    visibleGroup,
    actionSet,
    contextRevision: turn.agencySnapshotChecksum
  });
  const receipt = commitVisibleResult({
    store,
    ...creationInput,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
    expectedCognitiveStateRevision: Number(store.getCognitiveState(turn.characterId)?.revision || 0),
    expectedLatestUserBatchId: turn.inputUserBatchId,
    protocolVersion: turn.protocolVersion,
    turnKind: turn.rolloutKey,
    visibleGroup,
    actionSet,
    statePatch: null,
    memoryJobs: [],
    comparisonJob,
    generationFingerprint: fingerprint,
    now: 20_000
  });
  const committedTurn = store.getTurn(turn.turnId);
  const committedJob = store.comparisonJobsForGroup(receipt.visibleGroupId)[0];
  return { turn: committedTurn, receipt, comparisonJob: committedJob };
}

function recordRealHardComparison(store, { turn, comparisonJob, finding, runId, now }) {
  const workerId = `hard-action-worker-${runId}`;
  const claimed = store.claimDueConsolidationJob({
    workerId,
    jobTypes: [comparisonJob.jobType],
    now: now - 1,
    leaseMs: 60_000
  });
  assert.equal(claimed.jobId, comparisonJob.jobId);
  const payload = claimed.payload;
  const run = {
    runId,
    subjectType: claimed.subjectType,
    subjectId: claimed.subjectId,
    turnId: claimed.turnId,
    rolloutKey: turn.rolloutKey,
    source: 'live',
    comparisonDirection: payload.comparisonDirection,
    evidenceEpoch: payload.rolloutEvidenceEpoch,
    shadowEpoch: payload.shadowEpoch,
    canaryEpoch: payload.canaryEpoch,
    canarySlot: payload.canarySlot,
    rolloutRevision: turn.rolloutRevision,
    pipelineChecksum: turn.comparisonPipelineChecksum,
    authoritativeResultChecksum: payload.authoritativeResultChecksum,
    state: 'completed',
    criticalFindings: [finding],
    createdAt: now,
    updatedAt: now
  };
  store.recordComparisonOutcomeInternal({
    jobId: claimed.jobId,
    workerId,
    run,
    report: { reportId: `${runId}-report`, summary: {} },
    criticalFindings: [finding],
    now
  });
  return run;
}

test('initialization creates ten authoritative legacy rollout rows only once', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  const first = controller.initialize();
  assert.equal(first.initialized, true);
  assert.deepEqual(controller.listStatus().map(row => row.rolloutKey), [...COGNITION_ROLLOUT_KEYS].sort());
  assert.ok(controller.listStatus().every(row =>
    row.currentMode === 'legacy'
    && row.rolloutPhase === 'stable'
    && row.revision === 1
    && row.evidenceEpoch === 1
    && row.shadowEpoch === 0
    && row.canaryEpoch === 0
  ));
  const historyCount = store.listPromotionHistory().length;
  const second = new PromotionController({
    store,
    presetRegistry: registry(),
    bootstrap: { defaultMode: 'active', defaultPhase: 'canary' },
    clock: () => 11_000
  }).initialize();
  assert.equal(second.initialized, false);
  assert.ok(controller.listStatus().every(row => row.currentMode === 'legacy'));
  assert.equal(store.listPromotionHistory().length, historyCount);
}));

test('turns pin rollout state and later transitions never rewrite old turns', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  controller.initialize();
  const legacy = controller.getStatus('DIRECT_REPLY');
  const shadow = controller.transition({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: legacy.revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'collect_live_shadow'
  });
  const turnA = controller.createTurn({ envelope: envelope(1) });
  assert.equal(turnA.resultAuthorityVersion, 0);
  assert.equal(turnA.pipelineMode, 'shadow');
  assert.equal(turnA.comparisonMode, 'cognition_compare');
  assert.equal(turnA.rolloutRevision, shadow.revision);
  assert.equal(controller.getStatus('DIRECT_REPLY').revision, shadow.revision + 1);

  const afterPin = controller.getStatus('DIRECT_REPLY');
  controller.transition({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: afterPin.revision,
    toMode: 'legacy',
    toPhase: 'stable',
    actor: 'manual',
    reasonCode: 'manual_rollback'
  });
  assert.equal(store.getTurn(turnA.turnId).pipelineMode, 'shadow');
  assert.equal(controller.createTurn({ envelope: envelope(2) }).pipelineMode, 'legacy');
}));

test('revision CAS permits only one competing transition', () => withStore(store => {
  const controller = new PromotionController({
    store,
    presetRegistry: registry(),
    clock: () => 10_000
  });
  controller.initialize();
  const revision = controller.getStatus('PROACTIVE_CHAT').revision;
  controller.transition({
    rolloutKey: 'PROACTIVE_CHAT',
    expectedRevision: revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'first'
  });
  assert.throws(() => controller.transition({
    rolloutKey: 'PROACTIVE_CHAT',
    expectedRevision: revision,
    toMode: 'shadow',
    toPhase: 'collecting',
    actor: 'manual',
    reasonCode: 'second'
  }), RolloutRevisionConflictError);
}));

test('evidence changes atomically begin a new epoch without reacting to unrelated files', () => withStore(store => {
  const first = new PromotionController({
    store,
    presetRegistry: registry('a'),
    clock: () => 10_000
  });
  first.initialize();
  assert.deepEqual(first.refreshEvidenceManifest({ now: 11_000 }).changed, []);
  const second = new PromotionController({
    store,
    presetRegistry: registry('b'),
    clock: () => 12_000
  });
  const result = second.initialize();
  assert.equal(result.changed.length, 10);
  assert.ok(second.listStatus().every(row => row.evidenceEpoch === 2));
}));

test('controller delegates fresh selection to the shared release resolver and runtime clock', () =>
  withStore(store => {
    let clock = 20_000;
    const controller = new PromotionController({
      store,
      presetRegistry: registry(),
      clock: () => clock
    });
    controller.initialize();
    const selected = controller.selectPipelinePairForFreshSubject('DIRECT_REPLY', {
      now: clock
    });
    assert.equal(selected.rollout.rolloutKey, 'DIRECT_REPLY');
    assert.equal(selected.pair.visibleReleaseId, selected.rollout.stableReleaseId);
    assert.equal(selected.pair.comparisonReleaseId, null);
    assert.deepEqual(
      controller.resolvePipelinePair(selected.rollout),
      selected.pair
    );
  }));

test('registering a candidate requires an immutable eligible materialized report', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry() });
    controller.initialize();
    assert.throws(() => controller.registerCandidate({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: 1,
      releaseId: 'candidate-r3', reportId: 'bad', reportChecksum: 'wrong'
    }), /eligible materialized quality report/);

    const report = materializedCandidateReport(store);
    const result = controller.registerCandidate(registerInput(report));
    assert.equal(result.candidatePhase, 'shadow');
    assert.deepEqual(
      store.getPipelineRelease(report.summary.candidateRelease.releaseId),
      report.summary.candidateRelease
    );
    const current = controller.getStatus('DIRECT_REPLY');
    assert.throws(() => controller.registerCandidate({
      ...registerInput(report, 'DIRECT_REPLY', current.revision), releaseId: 'candidate-forged'
    }), /candidate release checksum|release executor unavailable|candidate release identity/);
  }));

test('candidate release report uses a closed native definition and can be re-registered after rollback', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry() });
    controller.initialize();
    const forged = materializedCandidateReport(store, 'PROACTIVE_CHAT', {
      ...candidateRelease(), secret: 'caller-data'
    });
    assert.throws(() => controller.registerCandidate(registerInput(forged, 'PROACTIVE_CHAT')), /unknown fields/);

    const report = materializedCandidateReport(store);
    const registered = controller.registerCandidate(registerInput(report));
    const rolledBack = controller.rollbackCandidate({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision, reasonCode: 'TEST_ROLLBACK'
    });
    const next = controller.registerCandidate({
      ...registerInput(report, 'DIRECT_REPLY', rolledBack.revision),
      releaseId: report.summary.candidateRelease.releaseId
    });
    assert.equal(next.candidatePhase, 'shadow');
  }));

test('replay rows never satisfy the live shadow promotion gate', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const report = materializedCandidateReport(store);
  controller.registerCandidate(registerInput(report));
  store.putReplayRun({
    runId: 'replay-only', caseId: 'case-1', rolloutKey: 'DIRECT_REPLY',
    sourceType: 'approved_fixture', inputChecksum: 'input', state: 'completed', attemptCount: 1,
    metrics: {}, criticalFindings: [], createdAt: 3_000, updatedAt: 3_000
  });
  const check = controller.promotionCheck('DIRECT_REPLY');
  assert.equal(check.liveShadowSuccessCount, 0);
  assert.equal(check.replayCount, 1);
}));

test('canary pins comparison for exactly the first ten allocations', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const report = materializedCandidateReport(store);
  const registered = controller.registerCandidate(registerInput(report));
  seedLiveShadowEvidence(store);
  const canary = controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: registered.revision,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  });
  assert.equal(canary.candidatePhase, 'canary');
  for (let slot = 0; slot < 10; slot += 1) {
    const selected = controller.resolvePipelinePair({
      ...controller.getStatus('DIRECT_REPLY'), canaryStartedCount: slot
    });
    assert.equal(selected.comparisonReleaseId, 'release_baseline_78a4b362be0dd02d42ba8ad7');
  }
  assert.equal(controller.resolvePipelinePair({
    ...controller.getStatus('DIRECT_REPLY'), canaryStartedCount: 10
  }).comparisonReleaseId, null);
}));

test('canary backlog rolls back only the affected kind before a fresh subject', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 20_000 });
  controller.initialize();
  const report = materializedCandidateReport(store);
  const registered = controller.registerCandidate(registerInput(report));
  seedLiveShadowEvidence(store);
  controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
    reportId: report.reportId, reportChecksum: report.artifactChecksum
  });
  store.readCanaryOutstandingAuthorityInternal = () => ({ count: 3, oldestAt: null });
  const selected = controller.selectPipelinePairForFreshSubject('DIRECT_REPLY', { now: 20_000 });
  assert.equal(selected.pair.comparisonReleaseId, null);
  assert.equal(selected.rollout.candidatePhase, 'rolled_back');
  assert.equal(controller.getStatus('PROACTIVE_CHAT').candidatePhase, 'none');
}));

test('status and check audit a clone without mutating the source database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-rollout-cli-readonly-'));
  const databasePath = join(dir, 'runtime.sqlite');
  const configPath = join(dir, 'rollout.json');
  const store = new YuqiStore(databasePath);
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  store.close();
  writeFileSync(configPath, JSON.stringify({ databasePath }));
  const before = sha256File(databasePath);
  const source = new DatabaseSync(databasePath, { readOnly: true });
  const beforeVersion = Number(source.prepare('PRAGMA user_version').get().user_version);
  source.close();
  try {
    executeRolloutCommand({ command: 'status', options: { config: configPath }, stdout: silentStdout() });
    executeRolloutCommand({ command: 'check', options: { config: configPath, kind: 'DIRECT_REPLY' }, stdout: silentStdout() });
    assert.equal(sha256File(databasePath), before);
    const reopened = new YuqiStore(databasePath);
    assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, beforeVersion);
    reopened.close();
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('status and check use a consistent active-WAL snapshot without hashing SHM lock bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-rollout-cli-wal-'));
  const databasePath = join(dir, 'runtime.sqlite');
  const configPath = join(dir, 'rollout.json');
  const store = new YuqiStore(databasePath);
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  store.close();
  const writer = new DatabaseSync(databasePath);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    writer.prepare(`
      UPDATE cognition_kind_rollouts SET updated_at = updated_at + 1
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    assert.equal(existsSync(`${databasePath}-wal`), true);
    const before = sha256File(databasePath);
    const beforeWal = readFileSync(`${databasePath}-wal`).toString('base64');
    const source = new DatabaseSync(databasePath, { readOnly: true });
    const beforeVersion = Number(source.prepare('PRAGMA user_version').get().user_version);
    source.close();
    writeFileSync(configPath, JSON.stringify({ databasePath }));

    executeRolloutCommand({ command: 'status', options: { config: configPath }, stdout: silentStdout() });
    executeRolloutCommand({ command: 'check', options: { config: configPath, kind: 'DIRECT_REPLY' }, stdout: silentStdout() });
    assert.equal(sha256File(databasePath), before);
    assert.equal(readFileSync(`${databasePath}-wal`).toString('base64'), beforeWal);
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(Number(reopened.prepare('PRAGMA user_version').get().user_version), beforeVersion);
    reopened.close();
  } finally {
    writer.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('forged CLI reports are fully validated before any report row is written', () => {
  const dir = promotionEvidenceTempDir('cli-report');
  const databasePath = join(dir, 'runtime.sqlite');
  const configPath = join(dir, 'rollout.json');
  const artifactPath = join(dir, 'forged-report.json');
  const store = new YuqiStore(databasePath);
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const status = controller.getStatus('DIRECT_REPLY');
  const stable = store.getPipelineRelease(status.stableReleaseId);
  const candidate = { ...candidateRelease(), secret: 'caller-forged' };
  const artifact = {
    eligible: true,
    reportId: 'forged-report',
    candidateRelease: candidate,
    planChecksum: 'suite-checksum-v1',
    replayProvenance: {
      executionPairs: [{
        stableReleaseId: stable.releaseId,
        stableReleaseChecksum: stable.releaseChecksum
      }]
    },
    qualityGate: { liveShadowSuccessCount: 30, criticalErrors: 0 }
  };
  const resetSourceRunner = installCleanSourceRunner();
  writeTrackedRawBundle(dir, artifact, { sourceHead: currentSourceHead() });
  writeFileSync(artifactPath, JSON.stringify(artifact));
  writeFileSync(configPath, JSON.stringify({ databasePath }));
  store.close();
  try {
    assert.throws(() => executeRolloutCommand({
      command: 'promote',
      options: {
        config: configPath,
        kind: 'DIRECT_REPLY',
        report: artifactPath,
        'expected-revision': '1',
        'candidate-release-id': candidate.releaseId
      },
      stdout: silentStdout()
    }), /unknown fields|candidate release|promotion baseline|eligible materialized quality report|legacy|ineligible/);
    const verify = new YuqiStore(databasePath);
    assert.equal(verify.db.prepare('SELECT COUNT(*) AS n FROM cognition_evaluation_reports').get().n, 0);
    verify.close();
  } finally {
    resetSourceRunner();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('CLI resumes an exact pending v2 report and rejects same-id authority conflicts', () => {
  const dir = promotionEvidenceTempDir('cli-pending');
  const databasePath = join(dir, 'runtime.sqlite');
  const configPath = join(dir, 'rollout.json');
  const artifactPath = join(dir, 'quality-report.json');
  const store = new YuqiStore(databasePath);
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const artifact = qualityReportArtifact(store, 'DIRECT_REPLY', 'cli-pending-report');
  const pendingStable = store.getPipelineRelease(controller.getStatus('DIRECT_REPLY').stableReleaseId);
  const resetSourceRunner = installCleanSourceRunner();
  try {
    const genuine = writeGenuineV2PendingBundle(dir, artifact, pendingStable);
    const rawBundle = loadQualityPromotionRawBundle({ artifactPath: genuine.artifactPath, artifact: genuine.artifact, rootDir: process.cwd() });
    const summary = reportSummaryFromArtifact({ artifact: genuine.artifact, rollout: { stableReleaseId: pendingStable.releaseId }, rootDir: process.cwd(), rawBundle });
    store.putEvaluationReportInternal({ reportId: genuine.artifact.reportId, reportType: 'promotion', rolloutKey: 'DIRECT_REPLY',
      sourceType: 'aggregate_gate', sourceRef: artifactPath, artifactPath, summary, createdAt: 2_100 });
    writeFileSync(configPath, JSON.stringify({ databasePath }));
    store.close();
    executeRolloutCommand({ command: 'promote', options: { config: configPath, kind: 'DIRECT_REPLY', report: artifactPath,
      'expected-revision': '1', 'candidate-release-id': genuine.artifact.candidateRelease.releaseId }, stdout: silentStdout() });
    const recovered = new YuqiStore(databasePath);
    assert.equal(recovered.getEvaluationReport(genuine.artifact.reportId).artifactState, 'materialized');
    assert.equal(recovered.getCognitionRollout('DIRECT_REPLY').candidatePhase, 'shadow');
    const beforeRollout = recovered.getCognitionRollout('DIRECT_REPLY');
    const beforeReport = recovered.getEvaluationReport(genuine.artifact.reportId);
    const beforeProactive = recovered.getCognitionRollout('PROACTIVE_CHAT');
    assert.equal(recovered.listPromotionHistory()
      .filter(event => event.reasonCode === 'candidate_registered').length, 1);
    recovered.close();
    const changed = { ...genuine.artifact, planChecksum: 'changed-plan-checksum' };
    writeFileSync(artifactPath, JSON.stringify(changed));
    assert.throws(() => executeRolloutCommand({ command: 'promote', options: { config: configPath, kind: 'DIRECT_REPLY', report: artifactPath,
      'expected-revision': String(beforeRollout.revision), 'candidate-release-id': changed.candidateRelease.releaseId }, stdout: silentStdout() }), /authority conflict|checksum conflict|raw bundle identity|raw derivation|eligible materialized quality report/);
    const unchanged = new YuqiStore(databasePath);
    assert.deepEqual(unchanged.getCognitionRollout('DIRECT_REPLY'), beforeRollout);
    assert.deepEqual(unchanged.getEvaluationReport(genuine.artifact.reportId), beforeReport);
    unchanged.close();
    const movedArtifactPath = join(dir, 'moved-quality-report.json');
    writeFileSync(movedArtifactPath, JSON.stringify(genuine.artifact));
    assert.throws(() => executeRolloutCommand({ command: 'promote', options: { config: configPath, kind: 'DIRECT_REPLY', report: movedArtifactPath,
      'expected-revision': String(beforeRollout.revision), 'candidate-release-id': genuine.artifact.candidateRelease.releaseId }, stdout: silentStdout() }), /authority conflict|raw bundle|scope/);
    assert.throws(() => executeRolloutCommand({ command: 'promote', options: { config: configPath, kind: 'PROACTIVE_CHAT', report: artifactPath,
      'expected-revision': '1', 'candidate-release-id': genuine.artifact.candidateRelease.releaseId }, stdout: silentStdout() }), /authority conflict|rollout|candidate|raw derivation|eligible materialized quality report/);
    const reopened = new YuqiStore(databasePath);
    assert.deepEqual(reopened.getCognitionRollout('DIRECT_REPLY'), beforeRollout);
    assert.deepEqual(reopened.getEvaluationReport(genuine.artifact.reportId), beforeReport);
    assert.deepEqual(reopened.getCognitionRollout('PROACTIVE_CHAT'), beforeProactive);
    assert.equal(reopened.getCognitionRollout('PROACTIVE_CHAT').revision, 1);
    assert.equal(reopened.listPromotionHistory()
      .filter(event => event.reasonCode === 'candidate_registered').length, 1);
    reopened.close();
  } finally {
    store.close();
    resetSourceRunner();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('promote rejects a self-consistent stale source bundle before opening or writing the runtime DB', () => {
  const dir = promotionEvidenceTempDir('source-stale');
  const databasePath = join(dir, 'runtime.sqlite');
  const configPath = join(dir, 'rollout.json');
  const reportPath = join(dir, 'quality-report.json');
  const store = new YuqiStore(databasePath);
  store.close();
  const before = sha256File(databasePath);
  const staleHead = 'a'.repeat(40);
  for (const [name, bytes] of [
    ['quality-replay-plan.json', '{"sourceHead":"stale"}\n'],
    ['quality-replay.jsonl', '{"runId":"stale"}\n'],
    ['quality-manual-review.jsonl', '{"runId":"stale"}\n']
  ]) writeFileSync(join(dir, name), bytes);
  writeFileSync(reportPath, JSON.stringify({
    sourceHead: staleHead,
    replayProvenance: { sourceHead: staleHead },
    qualityPlanSha256: rawFileHash(join(dir, 'quality-replay-plan.json')),
    qualityReplaySha256: rawFileHash(join(dir, 'quality-replay.jsonl')),
    qualityManualReviewSha256: rawFileHash(join(dir, 'quality-manual-review.jsonl'))
  }));
  writeFileSync(configPath, JSON.stringify({ databasePath }));
  const resetSourceRunner = installCleanSourceRunner({ head: 'b'.repeat(40) });
  try {
    assert.throws(() => executeRolloutCommand({
      command: 'promote',
      options: { config: configPath, report: reportPath, kind: 'DIRECT_REPLY' },
      stdout: silentStdout()
    }), /sourceHead is stale/);
    assert.equal(sha256File(databasePath), before);
  } finally {
    resetSourceRunner();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('source authority preflight allows evidence-only dirt but rejects outside dirt and accepts the current HEAD', () => {
  const dir = promotionEvidenceTempDir('source-scope');
  const reportPath = join(dir, 'quality-report.json');
  const head = currentSourceHead();
  writeFileSync(reportPath, JSON.stringify({
    sourceHead: head,
    replayProvenance: { sourceHead: head }
  }));
  try {
    assert.throws(() => preflightRolloutSourceAuthority({
      rootDir: process.cwd(), reportPath,
      commandRunner: (executable, args) => executable === 'git' && args[0] === 'rev-parse'
        ? { exitCode: 0, stdout: `${head}\n` }
        : { exitCode: 0, stdout: ' M scripts/modified-outside-evidence.mjs\0' }
    }), /dirty outside evidence/);
    assert.deepEqual(preflightRolloutSourceAuthority({
      rootDir: process.cwd(), reportPath,
      commandRunner: (executable, args) => executable === 'git' && args[0] === 'rev-parse'
        ? { exitCode: 0, stdout: `${head}\n` }
        : { exitCode: 0, stdout: `?? artifacts/yuqi-lived-agency-v3/${dir.split('yuqi-lived-agency-v3\\')[1]}\\quality-report.json\0` }
    }).sourceHead, head);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('promote rejects report/raw directories outside the fixed evidence root before runtime DB access', () => {
  const outsideDirectories = [
    mkdtempSync(join(process.cwd(), 'scripts', '.tmp-rollout-scope-')),
    mkdtempSync(join(process.cwd(), '.tmp-rollout-scope-')),
    mkdtempSync(join(process.cwd(), 'tests', '.tmp-rollout-scope-'))
  ];
  const resetSourceRunner = installCleanSourceRunner();
  try {
    for (const directory of outsideDirectories) {
      const reportPath = join(directory, 'quality-report.json');
      writeFileSync(reportPath, '{}');
      assert.throws(() => executeRolloutCommand({
        command: 'promote',
        options: { config: join(directory, 'missing-config.json'), report: reportPath, kind: 'DIRECT_REPLY' },
        stdout: silentStdout()
      }), /evidence directory scope/);
    }
  } finally {
    resetSourceRunner();
    for (const directory of outsideDirectories) {
      try { rmSync(directory, { recursive: true, force: true }); } catch {}
    }
  }
});

test('legacy transition cannot bypass candidate registration and release authority', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const legacy = controller.getStatus('PROACTIVE_CHAT');
  const shadow = controller.transition({
    rolloutKey: 'PROACTIVE_CHAT', expectedRevision: legacy.revision,
    toMode: 'shadow', toPhase: 'collecting', actor: 'manual', reasonCode: 'collect'
  });
  const report = store.putEvaluationReportInternal({
    reportId: 'legacy-bypass-report', reportType: 'promotion', rolloutKey: 'PROACTIVE_CHAT',
    sourceType: 'aggregate_gate', sourceRef: 'legacy-bypass.json', artifactPath: 'legacy-bypass.json',
    summary: { eligible: true, promotionEligible: true, liveShadowSuccessCount: 30, criticalErrors: 0 },
    createdAt: 1
  });
  store.markEvaluationReportMaterialized({
    reportId: report.reportId, expectedChecksum: report.artifactChecksum, now: 2
  });
  assert.throws(() => controller.transition({
    rolloutKey: 'PROACTIVE_CHAT', expectedRevision: shadow.revision,
    toMode: 'active', toPhase: 'canary', actor: 'manual', reasonCode: 'bypass',
    reportId: report.reportId, reportChecksum: report.artifactChecksum
  }), /candidate registration|promotion candidate API|release authority/);
}));

test('legacy transition cannot mutate any registered candidate phase', () => {
  const cases = [
    {
      name: 'shadow to legacy',
      setup(store) {
        const { controller, registered } = registerShadowCandidate(store, 'DIRECT_REPLY');
        return { controller, rollout: registered };
      },
      toMode: 'legacy',
      toPhase: 'stable'
    },
    {
      name: 'shadow to active stable',
      setup(store) {
        const { controller, registered } = registerShadowCandidate(store, 'DIRECT_REPLY');
        return { controller, rollout: registered };
      },
      toMode: 'active',
      toPhase: 'stable'
    },
    {
      name: 'canary to active stable',
      setup(store) {
        const controller = setupCanary(store, 'DIRECT_REPLY');
        store.db.prepare(`
          UPDATE cognition_kind_rollouts
          SET canary_target_count = 0,
              canary_started_count = 0,
              canary_completed_count = 0,
              canary_failure_count = 0,
              canary_observe_until = 0
          WHERE rollout_key = 'DIRECT_REPLY'
        `).run();
        return { controller, rollout: controller.getStatus('DIRECT_REPLY') };
      },
      toMode: 'active',
      toPhase: 'stable'
    },
    {
      name: 'rolled back to active stable',
      setup(store) {
        const { controller, registered } = registerShadowCandidate(store, 'DIRECT_REPLY');
        const rollout = controller.rollbackCandidate({
          rolloutKey: 'DIRECT_REPLY',
          expectedRevision: registered.revision,
          reasonCode: 'test_rollback'
        });
        return { controller, rollout };
      },
      toMode: 'active',
      toPhase: 'stable'
    }
  ];

  for (const scenario of cases) {
    withStore(store => {
      const { controller, rollout } = scenario.setup(store);
      assert.notEqual(rollout.candidatePhase, 'none', scenario.name);
      const before = store.getCognitionRollout('DIRECT_REPLY');
      const historyBefore = store.listPromotionHistory().length;
      const transitionInput = {
        rolloutKey: 'DIRECT_REPLY',
        expectedRevision: before.revision,
        toMode: scenario.toMode,
        toPhase: scenario.toPhase,
        actor: 'legacy_test',
        reasonCode: `legacy_bypass_${scenario.name}`
      };
      assert.throws(() => controller.transition(transitionInput), /candidate|phase|specialized|promotion/i);
      assert.throws(() => store.transitionCognitionRolloutInternal({
        ...transitionInput,
        now: 99_000
      }), /candidate|phase|specialized|promotion/i);
      assert.deepEqual(store.getCognitionRollout('DIRECT_REPLY'), before, scenario.name);
      assert.equal(store.listPromotionHistory().length, historyBefore, scenario.name);

      const reopened = new YuqiStore(store.filename);
      try {
        assert.deepEqual(reopened.getCognitionRollout('DIRECT_REPLY'), before, `${scenario.name} reopen`);
      } finally {
        reopened.close();
      }
    });
  }
});

test('active pipeline failure rolls back a candidate through the rollback API', () =>
  withStore(store => {
    const controller = setupCanary(store, 'DIRECT_REPLY');
    const turn = controller.createTurn({ envelope: envelope(9_501) });
    assert.equal(turn.pipelineMode, 'active');
    const result = controller.recordActivePipelineFailure({
      subjectType: 'turn',
      subjectId: turn.turnId,
      errorCode: 'ACTIVE_PRECOMMIT_CRITICAL',
      failureClass: 'deterministic',
      report: { summary: { source: 'test' } },
      now: 50_000
    });
    assert.equal(result.rolledBack, true);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
    assert.equal(store.listPromotionHistory()
      .filter(event => event.reasonCode === 'ACTIVE_PRECOMMIT_CRITICAL').length, 1);
  }));

test('graduation rejects a materialized report for a different candidate release', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const reportA = materializedCandidateReport(store);
  const registered = controller.registerCandidate(registerInput(reportA));
  seedLiveShadowEvidence(store);
  const canary = controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
    reportId: reportA.reportId, reportChecksum: reportA.artifactChecksum
  });
  const candidateB = candidateRelease();
  candidateB.modelProfile = { cognition: 'candidate-b' };
  candidateB.releaseChecksum = contentHash({
    pipelineVersion: candidateB.pipelineVersion,
    presetVersion: candidateB.presetVersion,
    cognitionSchemaVersion: candidateB.cognitionSchemaVersion,
    expressionSchemaVersion: candidateB.expressionSchemaVersion,
    evaluatorVersion: candidateB.evaluatorVersion,
    modelProfile: candidateB.modelProfile,
    componentManifest: candidateB.componentManifest,
    createdAt: candidateB.createdAt
  });
  candidateB.releaseId = `quality_candidate_${candidateB.releaseChecksum.slice(0, 16)}`;
  const reportBSummary = {
    eligible: true,
    candidateRelease: candidateB,
    stableBaselineReleaseId: canary.stableReleaseId,
    stableBaselineReleaseChecksum: store.getPipelineRelease(canary.stableReleaseId).releaseChecksum,
    evaluatorVersion: candidateB.evaluatorVersion,
    suiteChecksum: 'suite-checksum-v1',
    liveShadowSuccessCount: 30,
    criticalErrors: 0
  };
  const pendingB = store.putEvaluationReportInternal({
    reportId: 'quality-report-DIRECT_REPLY-B', reportType: 'promotion', rolloutKey: 'DIRECT_REPLY',
    sourceType: 'aggregate_gate', sourceRef: 'quality-report-DIRECT_REPLY-B.json',
    artifactPath: 'artifacts/DIRECT_REPLY-B.json', summary: reportBSummary, createdAt: 2_101
  });
  const reportB = store.markEvaluationReportMaterialized({
    reportId: pendingB.reportId, expectedChecksum: pendingB.artifactChecksum, now: 2_201
  });
  store.db.prepare(`UPDATE cognition_kind_rollouts
    SET canary_started_count = 10, canary_completed_count = 10,
    canary_failure_count = 0, canary_observe_until = 1
    WHERE rollout_key = 'DIRECT_REPLY'`).run();
  store.readCanaryOutstandingAuthorityInternal = () => ({ count: 0, oldestAt: null });
  assert.throws(() => controller.graduateCandidate({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: canary.revision,
    reportId: reportB.reportId, reportChecksum: reportB.artifactChecksum
  }), /candidate release identity/);
}));

test('direct turn creation does not allocate slot eleven or ignore an expired comparison', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  const report = materializedCandidateReport(store);
  const registered = controller.registerCandidate(registerInput(report));
  seedLiveShadowEvidence(store);
  const canary = controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
    reportId: report.reportId, reportChecksum: report.artifactChecksum
  });
  store.db.prepare(`UPDATE cognition_kind_rollouts
    SET canary_started_count = 10, canary_completed_count = 10,
        canary_failure_count = 0, canary_observe_until = 0
    WHERE rollout_key = 'DIRECT_REPLY'`).run();
  const turn = controller.createTurn({ envelope: envelope(901) });
  assert.equal(turn.comparisonMode, 'none');
  assert.equal(turn.canarySlot, null);
  assert.equal(controller.getStatus('DIRECT_REPLY').canaryStartedCount, 10);
  store.db.prepare(`UPDATE cognition_kind_rollouts
    SET canary_started_count = 1, canary_completed_count = 0,
        canary_failure_count = 0, canary_started_at = 0
    WHERE rollout_key = 'DIRECT_REPLY'`).run();
  store.readCanaryOutstandingAuthorityInternal = () => ({ count: 1, oldestAt: 0 });
  const recovered = controller.createTurn({ envelope: envelope(902) });
  assert.equal(recovered.comparisonMode, 'none');
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
  void canary;
}));

test('canonical fresh turn uses oldest outstanding age, not canary start age', () =>
  withStore(store => {
    const controller = setupCanary(store);
    const first = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_001)
    );
    const nowAt = Date.now();
    const deadline = controller.getStatus('DIRECT_REPLY').canaryCompareDeadlineMs;
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET canary_started_at = ?
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run(nowAt - deadline - 1_000);
    store.db.prepare('UPDATE turns SET created_at = ? WHERE turn_id = ?')
      .run(nowAt - 100, first.turn.turnId);

    const second = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_002)
    );
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'canary');
    assert.equal(second.turn.canarySlot, 2);
  }));

test('canonical fresh turn rolls back then creates with stable pins when the oldest outstanding comparison expires', () =>
  withStore(store => {
    const controller = setupCanary(store);
    const first = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_101)
    );
    const nowAt = Date.now();
    const deadline = controller.getStatus('DIRECT_REPLY').canaryCompareDeadlineMs;
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET canary_started_at = ?
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run(nowAt - 100);
    store.db.prepare('UPDATE turns SET created_at = ? WHERE turn_id = ?')
      .run(nowAt - deadline - 1_000, first.turn.turnId);

    const before = store.db.prepare(
      "SELECT COUNT(*) AS n FROM turns WHERE rollout_key = 'DIRECT_REPLY'"
    ).get().n;
    const oldPins = store.getTurn(first.turn.turnId);
    const recovered = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_102)
    );
    assert.equal(recovered.status, 'created');
    assert.equal(recovered.turn.comparisonMode, 'none');
    assert.equal(recovered.turn.canarySlot, null);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS n FROM turns WHERE rollout_key = 'DIRECT_REPLY'"
    ).get().n, before + 1);
    assert.deepEqual(store.getTurn(first.turn.turnId), oldPins);
  }));

test('canonical fourth outstanding comparison rolls back then creates a stable turn', () =>
  withStore(store => {
    const controller = setupCanary(store);
    for (let sequence = 9_201; sequence <= 9_203; sequence += 1) {
      const created = store.createCanonicalVisibleTurnInternal(
        canonicalDirectInput(store, controller, sequence)
      );
      store.db.prepare('UPDATE turns SET created_at = ? WHERE turn_id = ?')
        .run(Date.now() - 100, created.turn.turnId);
    }
    assert.equal(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY',
      canaryEpoch: controller.getStatus('DIRECT_REPLY').canaryEpoch
    }).count, 3);
    const before = {
      turns: store.db.prepare(
        "SELECT COUNT(*) AS n FROM turns WHERE rollout_key = 'DIRECT_REPLY'"
      ).get().n,
      pins: store.db.prepare(
        "SELECT turn_id, rollout_revision, comparison_mode, canary_slot FROM turns WHERE rollout_key = 'DIRECT_REPLY' ORDER BY turn_id"
      ).all()
    };
    const recovered = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_204)
    );
    assert.equal(recovered.status, 'created');
    assert.equal(recovered.turn.comparisonMode, 'none');
    assert.equal(recovered.turn.canarySlot, null);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS n FROM turns WHERE rollout_key = 'DIRECT_REPLY'"
    ).get().n, before.turns + 1);
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS n FROM turn_authority_lineages WHERE lane_key = 'private_chat'"
    ).get().n, before.turns + 1);
    assert.deepEqual(store.db.prepare(
      "SELECT turn_id, rollout_revision, comparison_mode, canary_slot FROM turns WHERE rollout_key = 'DIRECT_REPLY' ORDER BY turn_id"
    ).all().slice(0, before.turns), before.pins);
  }));

test('production orchestrator accept creates a stable turn after canary rollback', () =>
  withStore(store => {
    const controller = setupCanary(store);
    for (let sequence = 9_301; sequence <= 9_303; sequence += 1) {
      const created = store.createCanonicalVisibleTurnInternal(
        canonicalDirectInput(store, controller, sequence)
      );
      store.db.prepare('UPDATE turns SET created_at = ? WHERE turn_id = ?')
        .run(Date.now() - 100, created.turn.turnId);
    }
    const oldPins = store.db.prepare(
      "SELECT turn_id, rollout_revision, comparison_mode, canary_slot FROM turns WHERE rollout_key = 'DIRECT_REPLY' ORDER BY turn_id"
    ).all();
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }) },
      codex: {},
      promotionController: controller,
      releaseExecutor: { executeTurn() {}, executeLife() {} }
    });
    const accepted = orchestrator.accept(
      canonicalDirectInput(store, controller, 9_304).envelope
    );
    assert.ok(accepted?.turnId);
    assert.equal(accepted.comparisonMode, 'none');
    assert.equal(accepted.canarySlot, null);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
    assert.deepEqual(store.db.prepare(
      "SELECT turn_id, rollout_revision, comparison_mode, canary_slot FROM turns WHERE rollout_key = 'DIRECT_REPLY' ORDER BY turn_id"
    ).all().slice(0, oldPins.length), oldPins);
  }));

test('life planning fourth outstanding comparison rolls back then creates a stable attempt', () =>
  withStore(store => {
    const controller = setupCanary(store, 'LIFE_PLANNING');
    for (let index = 1; index <= 3; index += 1) {
      controller.createLifePlanningAttempt({
        roleId: `life-role-${index}`,
        planningContext: {
          planWindowStartAt: 10_000 + index * 100_000,
          targetPlanEndAt: 50_000 + index * 100_000
        },
        now: Date.now()
      });
    }
    const before = store.db.prepare(
      "SELECT COUNT(*) AS n FROM cognition_life_planning_attempts WHERE rollout_key = 'LIFE_PLANNING'"
    ).get().n;
    const recovered = controller.createLifePlanningAttempt({
      roleId: 'life-role-4',
      planningContext: { planWindowStartAt: 500_000, targetPlanEndAt: 900_000 },
      now: Date.now()
    });
    assert.ok(recovered?.planningId);
    assert.equal(recovered.comparisonMode, 'none');
    assert.equal(recovered.canarySlot, null);
    assert.equal(controller.getStatus('LIFE_PLANNING').candidatePhase, 'rolled_back');
    assert.equal(store.db.prepare(
      "SELECT COUNT(*) AS n FROM cognition_life_planning_attempts WHERE rollout_key = 'LIFE_PLANNING'"
    ).get().n, before + 1);
  }));

test('promotion rejects a current-epoch queued comparison backlog before writing canary state', () =>
  withStore(store => {
    const { controller, report, registered } = registerShadowCandidate(store, 'DIRECT_REPLY');
    seedLiveShadowEvidence(store, 'DIRECT_REPLY', 10);
    const rollout = controller.getStatus('DIRECT_REPLY');
    store.putCognitionShadowRunInternal({
      runId: 'promotion-backlog-queued',
      subjectType: 'turn',
      subjectId: 'promotion-backlog-subject',
      turnId: 'promotion-backlog-turn',
      rolloutKey: 'DIRECT_REPLY',
      source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: rollout.evidenceEpoch,
      shadowEpoch: rollout.shadowEpoch,
      rolloutRevision: rollout.revision,
      pipelineChecksum: rollout.pipelineChecksum,
      state: 'queued',
      criticalFindings: [],
      createdAt: 9_000,
      updatedAt: 9_000
    });
    store.putCognitionShadowRunInternal({
      runId: 'promotion-backlog-running',
      subjectType: 'turn',
      subjectId: 'promotion-backlog-running-subject',
      turnId: 'promotion-backlog-running-turn',
      rolloutKey: 'DIRECT_REPLY',
      source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: rollout.evidenceEpoch,
      shadowEpoch: rollout.shadowEpoch,
      rolloutRevision: rollout.revision,
      pipelineChecksum: rollout.pipelineChecksum,
      state: 'running',
      criticalFindings: [],
      createdAt: 9_001,
      updatedAt: 9_001
    });
    const check = controller.promotionCheck('DIRECT_REPLY');
    assert.equal(check.outstandingComparisonCount, 2);
    assert.equal(check.oldestOutstandingComparisonAt, 9_000);
    const before = controller.getStatus('DIRECT_REPLY');
    assert.throws(() => controller.promoteToCanary({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
      reportId: report.reportId, reportChecksum: report.artifactChecksum
    }), /outstanding|incomplete/);
    assert.deepEqual(controller.getStatus('DIRECT_REPLY'), before);
    store.db.prepare(`
      UPDATE cognition_shadow_runs SET state = 'completed', updated_at = ?
      WHERE run_id IN ('promotion-backlog-queued', 'promotion-backlog-running')
    `).run(9_100);
    assert.doesNotThrow(() => controller.promoteToCanary({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
      reportId: report.reportId, reportChecksum: report.artifactChecksum
    }));
  }));

test('turn promotion treats failed, cancelled, and malformed terminal comparisons as failures', () =>
  withStore(store => {
    const { controller, report, registered } = registerShadowCandidate(store, 'DIRECT_REPLY');
    seedLiveShadowEvidence(store, 'DIRECT_REPLY', 10);
    const rollout = controller.getStatus('DIRECT_REPLY');
    for (const [index, state] of [[0, 'failed'], [1, 'cancelled']]) {
      store.putCognitionShadowRunInternal({
        runId: `promotion-terminal-${state}`,
        subjectType: 'turn', subjectId: `promotion-terminal-${state}`,
        turnId: `promotion-terminal-turn-${state}`,
        rolloutKey: 'DIRECT_REPLY', source: 'live',
        comparisonDirection: 'stable_authoritative_candidate_compare',
        evidenceEpoch: rollout.evidenceEpoch, shadowEpoch: rollout.shadowEpoch,
        rolloutRevision: rollout.revision, pipelineChecksum: rollout.pipelineChecksum,
        state, criticalFindings: [], createdAt: 4_000 + index, updatedAt: 4_000 + index
      });
    }
    store.putCognitionShadowRunInternal({
      runId: 'promotion-terminal-malformed', subjectType: 'turn', subjectId: 'promotion-terminal-malformed',
      turnId: 'promotion-terminal-turn-malformed', rolloutKey: 'DIRECT_REPLY', source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: rollout.evidenceEpoch, shadowEpoch: rollout.shadowEpoch,
      rolloutRevision: rollout.revision, pipelineChecksum: rollout.pipelineChecksum,
      state: 'completed', criticalFindings: null, createdAt: 4_010, updatedAt: 4_010
    });
    assert.throws(() => controller.promoteToCanary({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
      reportId: report.reportId, reportChecksum: report.artifactChecksum
    }), /incomplete|failure/);
  }));

test('life planning promotion requires one current completed comparison per completed attempt', () => {
  const invalidCases = [
    { name: 'not_ready', kind: 'comparison', state: 'not_ready', index: 0 },
    { name: 'queued', kind: 'comparison', state: 'queued', index: 1 },
    { name: 'running', kind: 'comparison', state: 'running', index: 2 },
    { name: 'failed', kind: 'comparison', state: 'failed', index: 3 },
    { name: 'cancelled', kind: 'comparison', state: 'cancelled', index: 4 },
    { name: 'missing run', kind: 'missing', index: 5 },
    { name: 'duplicate run', kind: 'duplicate', index: 6 },
    { name: 'critical run', kind: 'critical', index: 7 },
    { name: 'stale run', kind: 'stale', index: 8 }
  ];
  for (const invalid of invalidCases) {
    withStore(store => {
      const { controller, report, registered } = registerShadowCandidate(store, 'LIFE_PLANNING');
      seedLifePromotionAttempts(store, controller, { invalid });
      assert.throws(() => controller.promoteToCanary({
        rolloutKey: 'LIFE_PLANNING', expectedRevision: registered.revision,
        reportId: report.reportId, reportChecksum: report.artifactChecksum
      }), /incomplete|failure/,
      `invalid LIFE_PLANNING evidence unexpectedly promoted: ${invalid.name}`);
      assert.equal(controller.getStatus('LIFE_PLANNING').revision, registered.revision);
    });
  }
});

test('life planning promotion ignores old epochs but accepts a complete current closure', () =>
  withStore(store => {
    const { controller, report, registered } = registerShadowCandidate(store, 'LIFE_PLANNING');
    seedLifePromotionAttempts(store, controller, { includeOldEpoch: true });
    const promoted = controller.promoteToCanary({
      rolloutKey: 'LIFE_PLANNING', expectedRevision: registered.revision,
      reportId: report.reportId, reportChecksum: report.artifactChecksum
    });
    assert.equal(promoted.rolloutPhase, 'canary');
    assert.equal(promoted.candidatePhase, 'canary');
  }));

test('two confirmed severe lived failures in fifteen minutes roll back one kind', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry(), clock: () => 30_000 });
  controller.initialize();
  const report = materializedCandidateReport(store);
  const registered = controller.registerCandidate(registerInput(report));
  seedLiveShadowEvidence(store);
  controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
    reportId: report.reportId, reportChecksum: report.artifactChecksum
  });
  for (const [index, subjectId] of ['subject-1', 'subject-2'].entries()) {
    const subjectChecksum = `${index ? 'b' : 'a'}`.repeat(64);
    const persisted = persistEvaluatorJudgments(store, {
      rolloutKey: 'DIRECT_REPLY', subjectId, subjectChecksum,
      code: 'PUBLIC_PRIVACY_VIOLATION', prefix: `severe-${index}`,
      baseAt: 30_000 + index * 14 * 60_000
    });
    controller.recordCriticalFinding({
      rolloutKey: 'DIRECT_REPLY', findingId: persisted.findingId, severity: 'critical',
      code: 'PUBLIC_PRIVACY_VIOLATION', subjectId, subjectChecksum,
      judgmentFindingIds: persisted.judgmentFindingIds,
      occurredAt: 30_001 + index * 14 * 60_000
    });
  }
  assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'rolled_back');
  assert.equal(controller.getStatus('PROACTIVE_CHAT').candidatePhase, 'none');
}));

test('caller booleans and non-independent judgments cannot confirm a severe finding', () => withStore(store => {
  const controller = new PromotionController({ store, presetRegistry: registry() });
  controller.initialize();
  assert.throws(() => controller.recordCriticalFinding({
    rolloutKey: 'DIRECT_REPLY', findingId: 'forged-confirmation', subjectId: 'subject-forged',
    severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION', confirmed: true
  }), /judgment|evaluator|confirmation/);
  assert.throws(() => controller.recordCriticalFinding({
    rolloutKey: 'DIRECT_REPLY', findingId: 'same-evaluator', subjectId: 'subject-forged',
    severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION',
    judgments: [
      { evaluatorId: 'evaluator-a', judgmentId: 'a', subjectId: 'subject-forged', severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION' },
      { evaluatorId: 'evaluator-a', judgmentId: 'b', subjectId: 'subject-forged', severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION' }
    ]
  }), /independent|evaluator|judgment/);
}));

test('caller-provided independent evaluator ids cannot confirm a lived severe finding', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry() });
    controller.initialize();
    assert.throws(() => controller.recordCriticalFinding({
      rolloutKey: 'DIRECT_REPLY', findingId: 'caller-forged-independent',
      subjectId: 'caller-forged-subject', severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION',
      subjectChecksum: 'a'.repeat(64),
      judgments: [
        { evaluatorId: 'a', judgmentId: 'ja', subjectId: 'caller-forged-subject', severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION' },
        { evaluatorId: 'b', judgmentId: 'jb', subjectId: 'caller-forged-subject', severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION' }
      ]
    }), /persisted|evidence|judgment/);
  }));

test('persisted evaluator findings are required for a lived severe confirmation', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry() });
    controller.initialize();
    const rolloutKey = 'DIRECT_REPLY';
    const subjectId = 'persisted-quality-subject';
    const subjectChecksum = 'b'.repeat(64);
    const code = 'PUBLIC_PRIVACY_VIOLATION';
    const judgmentFindingIds = [];
    for (const [index, evaluatorId] of ['evaluator-a', 'evaluator-b'].entries()) {
      const evalRunId = `persisted-eval-run-${index}`;
      const judgmentId = `persisted-judgment-${index}`;
      const findingId = `persisted-judgment-finding-${index}`;
      judgmentFindingIds.push(findingId);
      store.putQualityEvalRunInternal({
        evalRunId, releaseId: 'release_candidate', baselineReleaseId: 'release_stable',
        suiteVersion: 'quality-v1', sourceType: 'live_shadow', state: 'completed',
        manifestChecksum: 'c'.repeat(64), summary: {}, artifactPath: '', createdAt: 1_000 + index,
        completedAt: 1_000 + index
      });
      store.putQualityFindingInternal({
        findingId, evalRunId, rolloutKey, sceneId: subjectId, repeatIndex: index,
        code, owner: evaluatorId, severity: 'critical',
        evidence: { subjectId, subjectChecksum, evaluatorId, judgmentId },
        scores: {}, createdAt: 1_000 + index
      });
    }
    const findingId = `finding_${contentHash({
      rolloutKey, subjectId, subjectChecksum, code,
      judgmentFindingIds: [...judgmentFindingIds].sort()
    }).slice(0, 24)}`;
    assert.doesNotThrow(() => controller.recordCriticalFinding({
      rolloutKey, findingId, subjectId, subjectChecksum, severity: 'critical', code,
      judgmentFindingIds, occurredAt: 1_001
    }));
  }));

test('persisted hard action findings roll back only the affected kind and preserve old pins', () =>
  withStore(store => {
    const { controller } = registerShadowCandidate(store, 'DIRECT_REPLY');
    const { turn, receipt, comparisonJob } = commitHardActionTurn(store, controller, 9_901);
    const finding = {
      findingId: 'persisted-hard-action-1',
      code: 'ACTION_TARGET_MISMATCH',
      severity: 'critical',
      subjectId: turn.authorityLineageKey,
      subjectChecksum: receipt.commitChecksum
    };
    const rollout = controller.getStatus('DIRECT_REPLY');
    const run = {
      runId: 'persisted-hard-action-run',
      subjectType: 'turn', subjectId: turn.authorityLineageKey, turnId: turn.turnId,
      rolloutKey: 'DIRECT_REPLY', source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: turn.rolloutEvidenceEpoch, shadowEpoch: turn.shadowEpoch,
      canaryEpoch: turn.canaryEpoch, canarySlot: turn.canarySlot,
      rolloutRevision: turn.rolloutRevision,
      pipelineChecksum: turn.comparisonPipelineChecksum,
      authoritativeResultChecksum: receipt.commitChecksum,
      state: 'completed', criticalFindings: [finding],
      createdAt: 20_000, updatedAt: 20_000
    };
    const claimed = store.claimDueConsolidationJob({
      workerId: 'hard-action-worker', jobTypes: [comparisonJob.jobType],
      now: 20_001, leaseMs: 60_000
    });
    assert.equal(claimed.jobId, comparisonJob.jobId);
    store.recordComparisonOutcomeInternal({
      jobId: claimed.jobId, workerId: 'hard-action-worker', run,
      report: { reportId: 'persisted-hard-action-report', summary: {} },
      criticalFindings: [finding], now: 20_002
    });
    const oldPin = store.getTurn(turn.turnId).authoritativeReleaseId;
    assert.throws(() => controller.recordHardActionFinding({
      rolloutKey: 'DIRECT_REPLY', comparisonRunId: 'persisted-hard-action-run',
      findingId: 'forged-finding', subjectId: turn.authorityLineageKey,
      subjectChecksum: receipt.commitChecksum,
      findingChecksum: contentHash(finding), now: 20_001
    }), /finding|authority|identity|function/);
    const result = controller.recordHardActionFinding({
      rolloutKey: 'DIRECT_REPLY', comparisonRunId: 'persisted-hard-action-run',
      findingId: finding.findingId, subjectId: finding.subjectId,
      subjectChecksum: finding.subjectChecksum,
      findingChecksum: contentHash(finding), now: 20_002
    });
    assert.equal(result.candidatePhase, 'rolled_back');
    assert.equal(controller.getStatus('PROACTIVE_CHAT').candidatePhase, 'none');
    assert.equal(store.getTurn(turn.turnId).authoritativeReleaseId, oldPin);
    assert.equal(store.getCognitionRollout('DIRECT_REPLY').revision, rollout.revision + 2);
  }));

test('hard action rejects a directly inserted shadow run without comparison proof', () =>
  withStore(store => {
    const controller = setupCanary(store, 'DIRECT_REPLY');
    const turn = store.createCanonicalVisibleTurnInternal(
      canonicalDirectInput(store, controller, 9_900)
    ).turn;
    const finding = {
      findingId: 'unlinked-hard-action', code: 'ACTION_TARGET_MISMATCH', severity: 'critical',
      subjectId: turn.authorityLineageKey, subjectChecksum: turn.envelopeChecksum
    };
    store.putCognitionShadowRunInternal({
      runId: 'unlinked-hard-action-run', subjectType: 'turn',
      subjectId: turn.authorityLineageKey, turnId: turn.turnId,
      rolloutKey: 'DIRECT_REPLY', source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      evidenceEpoch: turn.rolloutEvidenceEpoch, shadowEpoch: turn.shadowEpoch,
      canaryEpoch: turn.canaryEpoch, canarySlot: turn.canarySlot,
      rolloutRevision: turn.rolloutRevision,
      pipelineChecksum: turn.comparisonPipelineChecksum,
      authoritativeResultChecksum: turn.envelopeChecksum,
      state: 'completed', criticalFindings: [finding], createdAt: 19_000, updatedAt: 19_000
    });
    assert.throws(() => controller.recordHardActionFinding({
      rolloutKey: 'DIRECT_REPLY', comparisonRunId: 'unlinked-hard-action-run',
      findingId: finding.findingId, subjectId: finding.subjectId,
      subjectChecksum: finding.subjectChecksum, findingChecksum: contentHash(finding), now: 19_001
    }), /comparison|report|proof|authority/);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'canary');
  }));

test('hard action exact replay is idempotent after rollback and changed proof is rejected', () =>
  withStore(store => {
    const { controller } = registerShadowCandidate(store, 'DIRECT_REPLY');
    const { turn, receipt, comparisonJob } = commitHardActionTurn(store, controller, 9_902);
    const finding = {
      findingId: 'persisted-hard-action-replay',
      code: 'ACTION_TARGET_MISMATCH',
      severity: 'critical',
      subjectId: turn.authorityLineageKey,
      subjectChecksum: receipt.commitChecksum
    };
    const rollout = controller.getStatus('DIRECT_REPLY');
    recordRealHardComparison(store, {
      turn, comparisonJob, finding,
      runId: 'persisted-hard-action-replay-run', now: 21_000
    });
    const input = {
      rolloutKey: 'DIRECT_REPLY', comparisonRunId: 'persisted-hard-action-replay-run',
      findingId: finding.findingId, subjectId: finding.subjectId,
      subjectChecksum: finding.subjectChecksum,
      findingChecksum: contentHash(finding), now: 21_001
    };
    controller.recordHardActionFinding(input);
    const historyCount = () => Number(store.db.prepare(`
      SELECT COUNT(*) AS value FROM cognition_promotion_history
      WHERE rollout_key = 'DIRECT_REPLY'
        AND json_extract(metadata_json, '$.comparisonRunId') = 'persisted-hard-action-replay-run'
    `).get().value);
    assert.equal(historyCount(), 1);
    const replay = controller.recordHardActionFinding(input);
    assert.equal(replay.candidatePhase, 'rolled_back');
    assert.equal(replay.revision, rollout.revision + 2);
    assert.equal(historyCount(), 1);
    assert.throws(() => controller.recordHardActionFinding({
      ...input, findingChecksum: contentHash({ ...finding, target: 'changed' })
    }), /finding|authority|checksum|identity/);
    assert.equal(historyCount(), 1);
  }));

test('hard action finding rejects unknown persisted fields before rollback', () =>
  withStore(store => {
    const { controller } = registerShadowCandidate(store, 'DIRECT_REPLY');
    const { turn, receipt, comparisonJob } = commitHardActionTurn(store, controller, 9_903);
    const finding = {
      findingId: 'persisted-hard-action-extra',
      code: 'ACTION_TARGET_MISMATCH',
      severity: 'critical',
      subjectId: turn.authorityLineageKey,
      subjectChecksum: receipt.commitChecksum,
      secret: 'must-reject'
    };
    recordRealHardComparison(store, {
      turn, comparisonJob, finding,
      runId: 'persisted-hard-action-extra-run', now: 22_000
    });
    assert.throws(() => controller.recordHardActionFinding({
      rolloutKey: 'DIRECT_REPLY', comparisonRunId: 'persisted-hard-action-extra-run',
      findingId: finding.findingId, subjectId: finding.subjectId,
      subjectChecksum: finding.subjectChecksum,
      findingChecksum: contentHash(finding), now: 22_001
    }), /finding|authority|shape/);
    assert.equal(controller.getStatus('DIRECT_REPLY').candidatePhase, 'shadow');
  }));

test('persisted evaluator times, not caller time, define the severe fuse window', () =>
  withStore(store => {
    const controller = new PromotionController({ store, presetRegistry: registry() });
    controller.initialize();
    const old = persistEvaluatorJudgments(store, {
      rolloutKey: 'DIRECT_REPLY', subjectId: 'old-subject', subjectChecksum: 'd'.repeat(64),
      code: 'PUBLIC_PRIVACY_VIOLATION', prefix: 'old-evidence', baseAt: 1_000
    });
    assert.throws(() => controller.recordCriticalFinding({
      rolloutKey: 'DIRECT_REPLY', findingId: old.findingId, subjectId: 'old-subject',
      subjectChecksum: 'd'.repeat(64), severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION',
      judgmentFindingIds: old.judgmentFindingIds, occurredAt: Date.now()
    }), /time|evidence|authorit/);
    assert.equal(Number(store.db.prepare(
      "SELECT COUNT(*) AS value FROM cognition_promotion_history WHERE reason_code = 'CONFIRMED_CRITICAL'"
    ).get().value), 0);

    const future = persistEvaluatorJudgments(store, {
      rolloutKey: 'DIRECT_REPLY', subjectId: 'future-subject', subjectChecksum: 'e'.repeat(64),
      code: 'PUBLIC_PRIVACY_VIOLATION', prefix: 'future-evidence', baseAt: Date.now() + 60_000
    });
    assert.throws(() => controller.recordCriticalFinding({
      rolloutKey: 'DIRECT_REPLY', findingId: future.findingId, subjectId: 'future-subject',
      subjectChecksum: 'e'.repeat(64), severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION',
      judgmentFindingIds: future.judgmentFindingIds
    }), /time|evidence|authorit/);

    const malformed = persistEvaluatorJudgments(store, {
      rolloutKey: 'DIRECT_REPLY', subjectId: 'malformed-time-subject', subjectChecksum: 'f'.repeat(64),
      code: 'PUBLIC_PRIVACY_VIOLATION', prefix: 'malformed-time', baseAt: 2_000
    });
    store.db.prepare(
      "UPDATE quality_eval_runs SET completed_at = 'not-a-time' WHERE eval_run_id LIKE 'malformed-time-eval-%'"
    ).run();
    assert.throws(() => controller.recordCriticalFinding({
      rolloutKey: 'DIRECT_REPLY', findingId: malformed.findingId,
      subjectId: 'malformed-time-subject', subjectChecksum: 'f'.repeat(64),
      severity: 'critical', code: 'PUBLIC_PRIVACY_VIOLATION',
      judgmentFindingIds: malformed.judgmentFindingIds
    }), /time|evidence|authorit/);
  }));
