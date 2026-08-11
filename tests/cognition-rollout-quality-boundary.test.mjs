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
import { expectedFinalKeysProjection, validateQualityReplayV2Rows, writeQualityReplayPlanArtifact } from '../yuqi-runtime/src/quality-replay.mjs';
import { deriveManualV2RequirementsFromValidated, projectV2Provenance,
  validateQualityArtifactBundle } from '../scripts/report-yuqi-lived-quality.mjs';

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

function genuineV2Rows(finalKeys) {
  const runId = '22222222-2222-4222-8222-222222222222';
  const header = { version: 1, sourceHead: SOURCE_HEAD, finalKeys: [...finalKeys],
    stableRelease: { releaseId: 'stable-r2', releaseChecksum: 'a'.repeat(64) },
    candidateRelease: CANDIDATE };
  const run = { schemaVersion: 2, recordType: 'run', runId, header,
    headerChecksum: contentHash(header), state: 'finalized', createdAt: 1, finalizedAt: 1000 };
  const executions = [], phases = [], calls = [], judgments = [], finals = [];
  const dimensions = ['socialUnderstanding', 'agency', 'relationshipParticipation',
    'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'];
  for (const [index, finalKey] of finalKeys.entries()) {
    const subjectType = finalKey.includes('life') ? 'life_planning' : 'turn';
    const subjectChecksum = contentHash({ finalKey, subjectType, index });
    const phaseMap = {};
    for (const [phaseIndex, phase] of ['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'].entries()) {
      const input = { finalKey, phase, index };
      const authorityInputChecksum = contentHash({ finalKey, phase, authority: true });
      const inputChecksum = contentHash({ subjectChecksum, authorityInputChecksum, input });
      const evaluation = phase.startsWith('evaluator_')
        ? { version: 1, scores: Object.fromEntries(dimensions.map(key => [key, 4])),
          preference: 'B', findings: [], unresolved: false }
        : null;
      const output = evaluation ?? { finalKey, phase, ok: true };
      const outputChecksum = contentHash(output);
      phaseMap[phase] = { inputChecksum, outputChecksum };
      phases.push({ schemaVersion: 2, recordType: 'phase', runId, finalKey, phase, state: 'succeeded',
        subjectChecksum, authorityInputChecksum, input, inputChecksum, output, outputChecksum,
        createdAt: 10 + phaseIndex, startingAt: 10 + phaseIndex, runningAt: 10 + phaseIndex, updatedAt: 20 + phaseIndex });
      const blindInput = { version: 1, finalKey, subjectType, subjectChecksum };
      const request = phase.startsWith('evaluator_') ? { input: JSON.stringify(blindInput), phase } : { phase, finalKey };
      const modelOutput = { phase, ok: true };
      calls.push({ schemaVersion: 2, recordType: 'model_call', runId, finalKey, phase, ordinal: 0, state: 'succeeded',
        role: 'brain', callId: `call-${index}-${phase}`, clientUserMessageId: `msg-${index}-${phase}`,
        threadId: `thread-${index}`, turnId: `turn-${index}-${phase}`, baseline: { phase }, baselineChecksum: contentHash({ phase }),
        request, requestChecksum: contentHash(request), model: 'model-v1', effort: 'high', schemaChecksum: contentHash({ schema: 1 }),
        output: modelOutput, outputChecksum: contentHash(modelOutput), runningAt: 10 + phaseIndex,
        createdAt: 10 + phaseIndex, updatedAt: 15 + phaseIndex });
      if (phase.startsWith('evaluator_')) {
        const evaluatorId = phase === 'evaluator_primary' ? 'evaluator-primary' : 'evaluator-secondary';
        const evaluatorVersion = phase === 'evaluator_primary' ? 'eval-v1' : 'eval-v1b';
        const inputChecksumForJudgment = contentHash(blindInput);
        const outputChecksumForJudgment = outputChecksum;
        judgments.push({ schemaVersion: 2, recordType: 'judgment', runId, finalKey, phase, evaluatorId, evaluatorVersion,
          inputChecksum: inputChecksumForJudgment, output: evaluation, outputChecksum: outputChecksumForJudgment,
          judgmentChecksum: contentHash({ finalKey, phase, evaluatorId, evaluatorVersion,
            inputChecksum: inputChecksumForJudgment, output: evaluation, outputChecksum: outputChecksumForJudgment }) });
      }
    }
    const primary = judgments.find(row => row.finalKey === finalKey && row.phase === 'evaluator_primary');
    const secondary = judgments.find(row => row.finalKey === finalKey && row.phase === 'evaluator_secondary');
    const value = { version: 1, finalKey, subjectType, subjectChecksum,
      stablePhase: phaseMap.stable_execution, candidatePhase: phaseMap.candidate_execution,
      blindInputChecksum: primary.inputChecksum,
      primary: { evaluatorId: primary.evaluatorId, evaluatorVersion: primary.evaluatorVersion, inputChecksum: primary.inputChecksum,
        output: primary.output, outputChecksum: primary.outputChecksum },
      secondary: { evaluatorId: secondary.evaluatorId, evaluatorVersion: secondary.evaluatorVersion, inputChecksum: secondary.inputChecksum,
        output: secondary.output, outputChecksum: secondary.outputChecksum },
      comparison: { version: 1, differences: [], manualReview: false, unresolved: false, agreedCriticalFindings: [] } };
    const execution = { schemaVersion: 2, recordType: 'execution', runId, finalKey, subjectType, subjectChecksum,
      stablePhase: phaseMap.stable_execution, candidatePhase: phaseMap.candidate_execution };
    execution.executionChecksum = contentHash({ finalKey, subjectType, subjectChecksum,
      stablePhase: execution.stablePhase, candidatePhase: execution.candidatePhase });
    executions.push(execution);
    finals.push({ schemaVersion: 2, recordType: 'final', runId, finalKey, value,
      valueChecksum: contentHash(value), executionChecksum: execution.executionChecksum, finalizedAt: 100 });
  }
  const body = [run, ...executions, ...phases, ...calls, ...judgments, ...finals];
  const recordCounts = { run: 1, execution: executions.length, phase: phases.length,
    modelCall: calls.length, judgment: judgments.length, final: finals.length };
  return [...body, { schemaVersion: 2, recordType: 'provenance', runId, recordCounts,
    recordsChecksum: contentHash(body), provenanceChecksum: contentHash({ runId,
      headerChecksum: run.headerChecksum, recordCounts, recordsChecksum: contentHash(body) }) }];
}

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

function writeGenuineV2RawBundle(root) {
  const rows = genuineV2Rows(TRACKED_FINAL_KEYS);
  const validated = validateQualityReplayV2Rows({ rows, plan: TRACKED_PLAN });
  const requirements = deriveManualV2RequirementsFromValidated(validated, TRACKED_PLAN);
  const requirementRows = requirements.map(requirement => {
    const judgments = validated.judgments.filter(row => row.finalKey === requirement.finalKey);
    return { finalKey: requirement.finalKey,
      primaryJudgmentChecksum: judgments.find(row => row.phase === 'evaluator_primary').judgmentChecksum,
      secondaryJudgmentChecksum: judgments.find(row => row.phase === 'evaluator_secondary').judgmentChecksum,
      executionChecksum: requirement.executionChecksum, finalValueChecksum: requirement.finalValueChecksum,
      evidenceFindingIds: requirement.evidenceFindingIds };
  });
  const metadata = { schemaVersion: 2, recordType: 'manual_metadata', runId: validated.run.runId,
    sourceHead: SOURCE_HEAD, candidateReleaseId: CANDIDATE.releaseId, candidateReleaseChecksum: CANDIDATE.releaseChecksum,
    planChecksum: TRACKED_PLAN.planChecksum, replayProvenanceChecksum: validated.provenance.provenanceChecksum,
    requirementsChecksum: contentHash(requirementRows) };
  const reviews = requirementRows.map((requirement, index) => {
    const final = validated.finals.find(row => row.finalKey === requirement.finalKey);
    const output = final.value.primary.output;
    return { schemaVersion: 2, recordType: 'review', runId: validated.run.runId,
      reviewId: `qreview_${contentHash({ runId: validated.run.runId, finalKey: requirement.finalKey,
        primaryJudgmentChecksum: requirement.primaryJudgmentChecksum, secondaryJudgmentChecksum: requirement.secondaryJudgmentChecksum,
        executionChecksum: requirement.executionChecksum, finalValueChecksum: requirement.finalValueChecksum }).slice(0, 48)}`,
      finalKey: requirement.finalKey, primaryJudgmentChecksum: requirement.primaryJudgmentChecksum,
      secondaryJudgmentChecksum: requirement.secondaryJudgmentChecksum, executionChecksum: requirement.executionChecksum,
      finalValueChecksum: requirement.finalValueChecksum, evidenceFindingIds: requirement.evidenceFindingIds,
      decision: 'accept_primary', resolvedOutput: output, reason: 'fixture', reviewer: 'central_window', createdAt: index };
  });
  const body = [metadata, ...reviews];
  const manualProvenance = { schemaVersion: 2, recordType: 'manual_provenance', runId: validated.run.runId,
    recordCounts: { manualMetadata: 1, review: reviews.length }, recordsChecksum: contentHash(body),
    manualProvenanceChecksum: contentHash({ runId: validated.run.runId, requirementsChecksum: metadata.requirementsChecksum,
      recordCounts: { manualMetadata: 1, review: reviews.length }, recordsChecksum: contentHash(body) }) };
  const planPath = join(root, 'quality-replay-plan.json');
  const replayPath = join(root, 'quality-replay.jsonl');
  const manualPath = join(root, 'quality-manual-review.jsonl');
  writeQualityReplayPlanArtifact(TRACKED_PLAN, planPath);
  writeFileSync(replayPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  writeFileSync(manualPath, `${[...body, manualProvenance].map(row => JSON.stringify(row)).join('\n')}\n`);
  const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
  const artifact = report();
  artifact.planChecksum = TRACKED_PLAN.planChecksum;
  artifact.sourceHead = SOURCE_HEAD;
  artifact.replayRunId = validated.run.runId;
  artifact.replayProvenance = projectV2Provenance(validated);
  artifact.evidenceBoundaryChecksum = evidenceBoundaryChecksum({ evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum, sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum });
  artifact.qualityPlanSha256 = hash(planPath);
  artifact.qualityReplaySha256 = hash(replayPath);
  artifact.qualityManualReviewSha256 = hash(manualPath);
  const rawBundle = validateQualityArtifactBundle({
    plan: TRACKED_PLAN,
    replayArtifactPath: replayPath,
    manualReviewArtifactPath: manualPath,
    candidateRelease: CANDIDATE
  });
  artifact.qualityGate = rawBundle.qualityGate;
  artifact.manualReview = rawBundle.manualReview;
  artifact.eligible = rawBundle.derivedEligible;
  writeFileSync(join(root, 'quality-report.json'), JSON.stringify(artifact));
  return { artifact, artifactPath: join(root, 'quality-report.json') };
}

test('production rollout accepts genuine v2 tracked-annotation evidence and rejects legacy bundles', () => {
  assert.throws(() => reportSummaryFromArtifact({ artifact: report(), rollout: { stableReleaseId: 'stable-r2' } }), /validated quality raw bundle/i);
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-valid-'));
  const { artifact, artifactPath } = writeGenuineV2RawBundle(root);
  const bundle = loadQualityPromotionRawBundle({ artifactPath, artifact, rootDir: process.cwd() });
  assert.equal(bundle.evidenceClass, 'quality_replay_v2');
  assert.equal(bundle.evidenceEligible, true);
  assert.notEqual(bundle.provenance.executionPairs[0].stableInputChecksum,
    bundle.provenance.executionPairs[0].executionChecksum);
  assert.notEqual(bundle.provenance.executionPairs[0].candidateInputChecksum,
    bundle.provenance.executionPairs[0].executionChecksum);
  assert.equal(reportSummaryFromArtifact({ artifact, rollout: { stableReleaseId: 'stable-r2' }, rawBundle: bundle }).eligible, true);
  const legacyRoot = mkdtempSync(join(tmpdir(), 'yuqi-promotion-legacy-'));
  const legacy = writeValidRawBundle(legacyRoot);
  assert.throws(() => loadQualityPromotionRawBundle({ artifactPath: legacy.artifactPath, artifact: legacy.artifact, rootDir: process.cwd() }), /legacy|ineligible|quality report/i);
  rmSync(legacyRoot, { recursive: true, force: true });
  assert.throws(() => reportSummaryFromArtifact({
    artifact: report('explicit_override'),
    rollout: { stableReleaseId: 'stable-r2' }
  }), /validated quality raw bundle/i);
  rmSync(root, { recursive: true, force: true });
});

test('v2 quality report is rejected when caller summary disagrees with raw comparison totals', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-comparison-drift-'));
  try {
    const valid = writeGenuineV2RawBundle(root);
    const tampered = {
      ...valid.artifact,
      qualityGate: { ...valid.artifact.qualityGate,
        differenceCount: valid.artifact.qualityGate.differenceCount + 1 }
    };
    assert.throws(() => loadQualityPromotionRawBundle({
      artifactPath: valid.artifactPath, artifact: tampered, rootDir: process.cwd()
    }), /raw derivation|quality report/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('raw low-score evidence cannot be hidden by a caller-good quality report', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-promotion-score-drift-'));
  try {
    const valid = writeGenuineV2RawBundle(root);
    const replayPath = join(root, 'quality-replay.jsonl');
    const rows = readFileSync(replayPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    const manualRows = readFileSync(join(root, 'quality-manual-review.jsonl'), 'utf8')
      .trim().split(/\r?\n/).map(JSON.parse);
    const reviewed = new Set(manualRows.filter(row => row.recordType === 'review').map(row => row.finalKey));
    const target = rows.find(row => row.recordType === 'final' && !reviewed.has(row.finalKey));
    assert.ok(target, 'fixture must contain an unreviewed final for score drift');
    const judgments = rows.filter(row => row.recordType === 'judgment' && row.finalKey === target.finalKey);
    const changedOutput = {
      ...judgments[0].output,
      scores: Object.fromEntries(Object.keys(judgments[0].output.scores).map(key => [key, 2]))
    };
    for (const judgment of judgments) {
      judgment.output = changedOutput;
      judgment.outputChecksum = contentHash(changedOutput);
      judgment.judgmentChecksum = contentHash({ finalKey: judgment.finalKey, phase: judgment.phase,
        evaluatorId: judgment.evaluatorId, evaluatorVersion: judgment.evaluatorVersion,
        inputChecksum: judgment.inputChecksum, output: judgment.output,
        outputChecksum: judgment.outputChecksum });
      const phase = rows.find(row => row.recordType === 'phase'
        && row.finalKey === judgment.finalKey && row.phase === judgment.phase);
      phase.output = changedOutput;
      phase.outputChecksum = judgment.outputChecksum;
    }
    target.value.primary.output = changedOutput;
    target.value.primary.outputChecksum = contentHash(changedOutput);
    target.value.secondary.output = changedOutput;
    target.value.secondary.outputChecksum = contentHash(changedOutput);
    target.valueChecksum = contentHash(target.value);
    const provenance = rows.at(-1);
    const body = rows.slice(0, -1);
    provenance.recordsChecksum = contentHash(body);
    provenance.provenanceChecksum = contentHash({ runId: provenance.runId,
      headerChecksum: rows.find(row => row.recordType === 'run').headerChecksum,
      recordCounts: provenance.recordCounts, recordsChecksum: provenance.recordsChecksum });
    writeFileSync(replayPath, `${[...body, provenance].map(row => JSON.stringify(row)).join('\n')}\n`);
    const manualProvenance = manualRows.at(-1);
    manualRows[0].replayProvenanceChecksum = provenance.provenanceChecksum;
    const manualBody = manualRows.slice(0, -1);
    manualProvenance.recordsChecksum = contentHash(manualBody);
    manualProvenance.manualProvenanceChecksum = contentHash({
      runId: manualProvenance.runId,
      requirementsChecksum: manualRows[0].requirementsChecksum,
      recordCounts: manualProvenance.recordCounts,
      recordsChecksum: manualProvenance.recordsChecksum
    });
    writeFileSync(join(root, 'quality-manual-review.jsonl'),
      `${[...manualBody, manualProvenance].map(row => JSON.stringify(row)).join('\n')}\n`);
    valid.artifact.qualityManualReviewSha256 = createHash('sha256')
      .update(readFileSync(join(root, 'quality-manual-review.jsonl'))).digest('hex');
    valid.artifact.qualityReplaySha256 = createHash('sha256')
      .update(readFileSync(replayPath)).digest('hex');
    assert.throws(() => loadQualityPromotionRawBundle({
      artifactPath: valid.artifactPath, artifact: valid.artifact, rootDir: process.cwd()
    }), /raw derivation|quality report|score|eligible/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.throws(() => loadQualityPromotionRawBundle({ artifactPath: valid.artifactPath, artifact, rootDir: process.cwd() }), /legacy|ineligible|quality report/i);
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
