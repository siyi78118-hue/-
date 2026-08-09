import assert from 'node:assert/strict';
import test from 'node:test';

import {
  QUALITY_DIMENSIONS,
  aggregateQualityGate,
  buildBlindEvaluation,
  compileSceneExecutionInput,
  normalizeBlindEvaluation,
  projectBlindEvaluationInput,
  runScenePair,
  validateExactEvidenceSet
} from '../src/quality-evaluator.mjs';
import { contentHash } from '../src/protocol.mjs';
import {
  buildVerifiedQualityReplayPlan,
  expectedFinalKeysProjection
} from '../src/quality-replay.mjs';
import { compileQualitySuite } from '../../scripts/compile-yuqi-lived-quality-scenes.mjs';

const HISTORY_SCENES = Array.from({ length: 30 }, (_, index) => ({ sceneId: `history-${index}` }));
const AUTHORITY_PLAN = buildVerifiedQualityReplayPlan({
  compiledSuite: compileQualitySuite({ rootDir: process.cwd(), checkOnly: true }),
  historyScenes: HISTORY_SCENES,
  historyManifest: {
    schemaVersion: 1,
    sceneIds: HISTORY_SCENES.map(scene => scene.sceneId),
    scenesChecksum: contentHash(HISTORY_SCENES)
  }
});
const AUTHORITY_PROJECTION = expectedFinalKeysProjection(AUTHORITY_PLAN);
const EXPECTED_FINAL_KEYS = AUTHORITY_PROJECTION.finalKeys;

function stableCandidatePair() {
  const output = (text) => ({
    terminalDisposition: 'visible',
    replyParts: [{ ordinal: 0, type: 'text', text }],
    actions: []
  });
  return {
    stable: { releaseId: 'stable-private', releaseChecksum: 'stable-checksum', output: output('稳定侧') },
    candidate: { releaseId: 'candidate-private', releaseChecksum: 'candidate-checksum', output: output('候选侧') }
  };
}

function validEvaluation() {
  return {
    version: 1,
    scores: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, 4])),
    preference: 'candidate',
    findings: [],
    unresolved: false
  };
}

function qualityEvidence(overrides = {}) {
  const make = (layer, score = 4) => AUTHORITY_PLAN.items.filter(item => item.layer === layer).map(item => ({
    layer,
    sceneId: item.sceneId,
    repeatIndex: item.repeatIndex,
    finalized: true,
    scores: Object.fromEntries(QUALITY_DIMENSIONS.map(dimension => [dimension, score])),
    preference: 'candidate',
    regression: false,
    severe: false,
    tie: false,
    unresolved: false,
    attempts: [{
      attemptIndex: 0,
      evaluatorId: `${layer}-evaluator-${item.sceneId}-${item.repeatIndex}`,
      accepted: true,
      unresolved: false
    }],
    structuralRegression: false
  }));
  return {
    sentinelRuns: make('sentinel'),
    coverageRuns: make('coverage'),
    historyRuns: make('history'),
    ...overrides
  };
}

function validScene() {
  return {
    sceneId: 'scene-quality-1',
    rolloutKey: 'DIRECT_REPLY',
    severity: 'high',
    focus: 'answer the current bid naturally',
    turns: [
      { speaker: 'user', batch: [{ messageId: 'u1', type: 'text', text: '你好' }] },
      { speaker: 'assistant', batch: [{ messageId: 'a1', type: 'text', text: '嗯' }] },
      { speaker: 'user', batch: [{ messageId: 'u2', type: 'text', text: '在吗' }] },
      { speaker: 'system', event: 'candidate_response' }
    ],
    sourceAnnotation: { file: 'source.md', heading: 'Scene' },
    requiredActionIntegrity: { responseMustTarget: 'current_user_turn' },
    expectedStateTransitions: { allow: ['maintain'] },
    forbiddenStateTransitions: { hardConstraintFromYuqiPreference: true },
    mustNotice: ['current bid'],
    allowedDecisionRange: ['direct attitude'],
    forbiddenFailurePatterns: ['template'],
    allowedPersonalityVariation: ['warm']
  };
}

test('blind evaluator cannot see release identity or output order', () => {
  const input = buildBlindEvaluation(stableCandidatePair(), { seed: 7 });
  assert.equal(JSON.stringify(input).includes('stable'), false);
  assert.equal(JSON.stringify(input).includes('candidate'), false);
  assert.deepEqual([...input.labels].sort(), ['A', 'B']);
});

test('six dimensions normalize to integer 1 through 5', () => {
  const result = normalizeBlindEvaluation(validEvaluation());
  assert.deepEqual(Object.keys(result.scores).sort(), [...QUALITY_DIMENSIONS].sort());
  assert.ok(Object.values(result.scores).every(x => Number.isInteger(x) && x >= 1 && x <= 5));
});

test('average cannot hide a severe sentinel failure', () => {
  const report = aggregateQualityGate(qualityEvidence({
    sentinelRuns: qualityEvidence().sentinelRuns.map((row, index) =>
      index === 0 ? {
        ...row,
        severe: true,
        findings: [{
          code: 'SENTINEL_CRITICAL', severity: 'critical', owner: 'comparison-evaluator-v1',
          summary: 'critical evidence', critical: true
        }]
      } : row)
  }), AUTHORITY_PROJECTION);
  assert.equal(report.eligible, false);
  assert.ok(report.failedGates.includes('SENTINEL_SEVERE_FAILURE'));
});

test('approved candidate meets every numerical gate', () => {
  const report = aggregateQualityGate(qualityEvidence(), AUTHORITY_PROJECTION);
  assert.equal(report.sentinelSevereFailureCount, 0);
  assert.ok(report.dimensionAverages.every(item => item.average >= 4));
  assert.equal(report.scoreOneCount, 0);
  assert.ok(report.candidatePreferredRate >= 0.60);
  assert.ok(report.regressionRate <= 0.10);
  assert.equal(report.structuralRegressionCount, 0);
  assert.equal(report.eligible, true);
});

test('aggregate quality gate rejects a caller-built expected key object', () => {
  assert.throws(() => aggregateQualityGate(qualityEvidence(), EXPECTED_FINAL_KEYS), /verified|plan|projection/i);
});

test('aggregate quality gate rejects a caller-forged projection with copied final keys', () => {
  const forgedProjection = {
    version: 1,
    planType: AUTHORITY_PROJECTION.planType,
    planChecksum: AUTHORITY_PLAN.planChecksum,
    sourceGroundingChecksum: AUTHORITY_PROJECTION.sourceGroundingChecksum,
    finalKeys: AUTHORITY_PROJECTION.finalKeys,
    commitments: AUTHORITY_PROJECTION.commitments,
    historyManifest: AUTHORITY_PROJECTION.historyManifest
  };
  assert.throws(() => aggregateQualityGate(qualityEvidence(), forgedProjection), /verified|plan|projection/i);
});

test('missing, duplicate, unresolved, or incomplete evidence can never pass', () => {
  const complete = qualityEvidence();
  const cases = [
    { sentinelRuns: [] },
    { sentinelRuns: complete.sentinelRuns.slice(1) },
    { coverageRuns: complete.coverageRuns.slice(1) },
    { historyRuns: complete.historyRuns.slice(1) },
    { sentinelRuns: [...complete.sentinelRuns, complete.sentinelRuns[0]] },
    { historyRuns: complete.historyRuns.map(row => ({ ...row, unresolved: true })) },
    { sentinelRuns: complete.sentinelRuns.map(row => ({ ...row, scores: { agency: 4 } })) },
    { sentinelRuns: complete.sentinelRuns.map(row => ({ ...row, scores: { ...row.scores, agency: 4.5 } })) }
  ];
  for (const override of cases) {
    const report = aggregateQualityGate({ ...complete, ...override }, AUTHORITY_PROJECTION);
    assert.equal(report.eligible, false);
    assert.ok(report.failedGates.includes('INCOMPLETE_QUALITY_EVIDENCE'));
  }
});

test('blind projection is closed and excludes every release and execution side channel', () => {
  const input = projectBlindEvaluationInput({
    sceneId: 'scene-quality-1',
    repeatIndex: 0,
    evaluationSeed: 17,
    sceneAnnotation: { sceneId: 'scene-quality-1', severity: 'high', focus: 'focus', turns: [] },
    stable: { releaseId: 'stable-private', output: {
      terminalDisposition: 'visible', replyParts: [{ ordinal: 0, type: 'text', text: 'A' }], actions: []
    } },
    candidate: { releaseId: 'candidate-private', output: {
      terminalDisposition: 'visible', replyParts: [{ ordinal: 0, type: 'text', text: 'B' }], actions: []
    } }
  }, { seed: 17 });
  assert.deepEqual(Object.keys(input).sort(), [
    'dimensions', 'outputs', 'sceneAnnotation', 'version'
  ]);
  assert.equal(JSON.stringify(input).includes('releaseId'), false);
  assert.deepEqual(input.outputs.map(output => output.label).sort(), ['A', 'B']);
  assert.throws(() => projectBlindEvaluationInput({
    sceneId: 'scene-quality-1', repeatIndex: 0, evaluationSeed: 17,
    sceneAnnotation: { sceneId: 'scene-quality-1', severity: 'high', focus: 'focus', turns: [] },
    stable: { output: stableCandidatePair().stable.output },
    candidate: { output: { ...stableCandidatePair().candidate.output, unknown: true } }
  }, { seed: 17 }), /blind/);
});

test('blind projection recursively rejects unknown turn, batch, and action payload keys', () => {
  const base = {
    sceneId: 'scene-quality-1',
    repeatIndex: 0,
    evaluationSeed: 17,
    sceneAnnotation: {
      sceneId: 'scene-quality-1', severity: 'high', focus: 'focus',
      turns: [{ at: '2026-01-01T00:00:00Z', speaker: 'user', batch: [{ type: 'text', text: 'hi' }] }]
    },
    stable: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } },
    candidate: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } }
  };
  const turnUnknown = structuredClone(base);
  turnUnknown.sceneAnnotation.turns[0].privatePath = 'secret';
  assert.throws(() => projectBlindEvaluationInput(turnUnknown, { seed: 17 }), /turn/);
  const batchUnknown = structuredClone(base);
  batchUnknown.sceneAnnotation.turns[0].batch[0].unknown = true;
  assert.throws(() => projectBlindEvaluationInput(batchUnknown, { seed: 17 }), /batch/);
  const actionUnknown = structuredClone(base);
  actionUnknown.candidate.output.actions = [{ ordinal: 0, kind: 'moment', payload: {
    targetKey: 'moment:1', unexpected: 'secret'
  } }];
  assert.throws(() => projectBlindEvaluationInput(actionUnknown, { seed: 17 }), /payload|action/);
});

test('scene annotation is bound to pair identity and validates closed nested records', () => {
  const base = {
    sceneId: 'scene-quality-1', repeatIndex: 0, evaluationSeed: 17,
    sceneAnnotation: {
      sceneId: 'different-scene', severity: 'high', focus: 'focus', turns: [],
      requiredChecks: [{ code: 'CURRENT_BATCH_OMISSION', description: 'check' }],
      allowedVariation: ['warm']
    },
    stable: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } },
    candidate: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } }
  };
  assert.throws(() => projectBlindEvaluationInput(base, { seed: 17 }), /scene id/);
  const unknownCheck = structuredClone(base);
  unknownCheck.sceneAnnotation.sceneId = base.sceneId;
  unknownCheck.sceneAnnotation.requiredChecks[0].secret = true;
  assert.throws(() => projectBlindEvaluationInput(unknownCheck, { seed: 17 }), /check/);
  const nanTurn = structuredClone(base);
  nanTurn.sceneAnnotation.sceneId = base.sceneId;
  nanTurn.sceneAnnotation.turns = [{ at: 'x', speaker: 'user', batch: [{ amount: NaN }] }];
  assert.throws(() => projectBlindEvaluationInput(nanTurn, { seed: 17 }), /amount|finite/);
  for (const bad of [false, null, 0, {}]) {
    const invalidChecks = structuredClone(base);
    invalidChecks.sceneAnnotation.sceneId = base.sceneId;
    invalidChecks.sceneAnnotation.requiredChecks = bad;
    assert.throws(() => projectBlindEvaluationInput(invalidChecks, { seed: 17 }), /required checks/);
  }
});

test('blind findings use a closed native schema and never copy side-channel fields', () => {
  const valid = normalizeBlindEvaluation({
    ...validEvaluation(),
    findings: [{ code: 'CURRENT_BATCH_OMISSION', severity: 'critical', owner: 'protocol', summary: 'missing', critical: true }]
  });
  assert.equal(valid.findings[0].code, 'CURRENT_BATCH_OMISSION');
  const unknown = { ...validEvaluation(), findings: [{ code: 'X', severity: 'warning', owner: 'protocol', summary: 'x', secret: 'path' }] };
  assert.throws(() => normalizeBlindEvaluation(unknown), /finding/);
  const nan = { ...validEvaluation(), findings: [{ code: 'X', severity: 'warning', owner: 'protocol', summary: NaN, critical: false }] };
  assert.throws(() => normalizeBlindEvaluation(nan), /finding/);
});

test('blind A/B placement is derived from scene identity, repeat index, and evaluation seed', () => {
  const make = (sceneId, repeatIndex, evaluationSeed) => projectBlindEvaluationInput({
    sceneId,
    repeatIndex,
    evaluationSeed,
    sceneAnnotation: { sceneId, severity: 'high', focus: 'focus', turns: [] },
    stable: { output: { terminalDisposition: 'visible', replyParts: [{ ordinal: 0, type: 'text', text: 'stable' }], actions: [] } },
    candidate: { output: { terminalDisposition: 'visible', replyParts: [{ ordinal: 0, type: 'text', text: 'candidate' }], actions: [] } }
  }, { seed: evaluationSeed });
  for (const [sceneId, repeatIndex, evaluationSeed] of [['scene-1', 1, 17], ['scene-b', 1, 17]]) {
    const input = make(sceneId, repeatIndex, evaluationSeed);
    const digest = contentHash({ sceneId, repeatIndex, evaluationSeed });
    const expectedSwap = Number.parseInt(digest.slice(-2), 16) % 2 === 0;
    const stableLabel = input.outputs.find(output => output.replyParts[0].text === 'stable').label;
    assert.equal(stableLabel, expectedSwap ? 'B' : 'A', `${sceneId}:${repeatIndex}`);
  }
});

test('final evidence requires exact scene sets and complete append-only attempt identity', () => {
  const complete = qualityEvidence();
  const expected = EXPECTED_FINAL_KEYS;
  assert.equal(validateExactEvidenceSet(complete, expected).ok, true);
  const wrongScene = structuredClone(complete);
  wrongScene.sentinelRuns[0].sceneId = 'not-in-the-sentinel-set';
  assert.equal(validateExactEvidenceSet(wrongScene, expected).ok, false);
  const wrongRepeat = structuredClone(complete);
  wrongRepeat.sentinelRuns[0].repeatIndex = 9;
  assert.equal(validateExactEvidenceSet(wrongRepeat, expected).ok, false);
  const missingEvaluator = structuredClone(complete);
  missingEvaluator.sentinelRuns[0].attempts = [{ attemptIndex: 0, accepted: true, unresolved: false }];
  assert.equal(validateExactEvidenceSet(missingEvaluator, expected).ok, false);
  const twoAccepted = structuredClone(complete);
  twoAccepted.sentinelRuns[0].attempts.push({
    attemptIndex: 1, evaluatorId: 'evaluator-2', accepted: true, unresolved: false
  });
  assert.equal(validateExactEvidenceSet(twoAccepted, expected).ok, false);
  const unknownFinalField = structuredClone(complete);
  unknownFinalField.sentinelRuns[0].privatePath = 'secret';
  assert.equal(validateExactEvidenceSet(unknownFinalField, expected).ok, false);
});

test('final evidence accepts closed comparison findings and rejects finding side channels', () => {
  const complete = qualityEvidence();
  complete.sentinelRuns[0].findings = [{
    code: 'CURRENT_BATCH_OMISSION', severity: 'critical', owner: 'comparison-evaluator-v1',
    summary: 'missing current batch', critical: true
  }];
  assert.equal(validateExactEvidenceSet(complete, EXPECTED_FINAL_KEYS).ok, true);
  const unknown = structuredClone(complete);
  unknown.sentinelRuns[0].findings[0].secret = 'do not persist';
  assert.equal(validateExactEvidenceSet(unknown, EXPECTED_FINAL_KEYS).ok, false);
});

test('one closed adapter executes every scene through the pinned release executor', async () => {
  const execution = compileSceneExecutionInput(validScene());
  const calls = [];
  const pairRecord = await runScenePair(execution, {
    stable: { releaseId: 'stable-v1', releaseChecksum: 'stable-checksum' },
    candidate: { releaseId: 'candidate-v1', releaseChecksum: 'candidate-checksum' },
    executor: {
      async executeTurn(request) {
        calls.push(request);
        return { draft: { reply: { content: request.releaseId } } };
      }
    }
  });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.dryRun === true));
  assert.ok(calls.every(call => call.execution === execution));
  assert.equal(pairRecord.stable.dryRun, true);
  assert.equal(pairRecord.candidate.dryRun, true);
  assert.equal(pairRecord.executionChecksum, pairRecord.stableInputChecksum);
  assert.equal(pairRecord.executionChecksum, pairRecord.candidateInputChecksum);
});
