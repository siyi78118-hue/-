import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { PresetRegistry } from '../yuqi-runtime/src/preset-registry.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';
import { createQualityReplayPlan } from '../scripts/run-yuqi-lived-quality-replay.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const SCRIPT = join(process.cwd(), 'scripts', 'prepare-yuqi-three-judge-pilot.mjs');
const RUNNER = join(process.cwd(), 'scripts', 'run-yuqi-lived-quality-replay.mjs');
const EXECUTION_CONFIG = join(process.cwd(), 'scripts', 'yuqi-quality-production-execution-config.mjs');

test('three-judge pilot has a dedicated non-model preparer', () => {
  assert.equal(existsSync(SCRIPT), true);
});

test('production plan loader permits a private history layer while pinning every tracked suite commitment', async () => {
  const module = await import(pathToFileURL(RUNNER).href);
  const tracked = createQualityReplayPlan({ rootDir: process.cwd() });
  const custom = structuredClone(tracked);
  const historyItems = custom.items.filter(item => item.layer === 'history');
  historyItems.forEach((item, index) => {
    item.scene.sceneId = `private_real_history_${String(index).padStart(2, '0')}`;
    item.sceneId = item.scene.sceneId;
  });
  custom.finalKeys.historyFinalKeys = historyItems.map(item => `history:${item.sceneId}:0`);
  custom.historyManifest = {
    schemaVersion: 1,
    sceneIds: historyItems.map(item => item.sceneId),
    scenesChecksum: contentHash(historyItems.map(item => item.scene)),
  };
  custom.commitments.historyScenesChecksum = custom.historyManifest.scenesChecksum;
  custom.commitments.itemsChecksum = contentHash(custom.items);
  custom.planChecksum = contentHash({
    version: custom.version,
    planType: custom.planType,
    finalKeys: custom.finalKeys,
    commitments: custom.commitments,
    historyManifest: custom.historyManifest,
  });
  assert.equal(module.assertProductionQualityPlanSourceBoundary({ plan: custom, rootDir: process.cwd() }), true);
  const executionConfig = await import(pathToFileURL(EXECUTION_CONFIG).href);
  assert.equal(executionConfig.assertProductionQualityPlanSourceBoundary(custom), true);

  const forged = structuredClone(custom);
  forged.items.find(item => item.layer === 'sentinel').scene.focus = 'forged tracked suite content';
  forged.commitments.itemsChecksum = contentHash(forged.items);
  forged.planChecksum = contentHash({
    version: forged.version,
    planType: forged.planType,
    finalKeys: forged.finalKeys,
    commitments: forged.commitments,
    historyManifest: forged.historyManifest,
  });
  assert.throws(() => module.assertProductionQualityPlanSourceBoundary({ plan: forged, rootDir: process.cwd() }), /tracked|source|commitment/i);
  assert.throws(() => executionConfig.assertProductionQualityPlanSourceBoundary(forged), /tracked|source|commitment/i);
});

test('stage one freezes two reviewed questions and the approved model profiles', async () => {
  const module = await import(pathToFileURL(SCRIPT).href);
  assert.deepEqual(module.THREE_JUDGE_STAGE_KEYS[1], [
    'sentinel:first_red_packet_as_social_action:0',
    'sentinel:fourth_coquetry_test_or_pressure:0',
  ]);
  assert.deepEqual(module.STABLE_THREE_JUDGE_PROFILE, {
    cognitionFast: 'gpt-5.6-terra/medium',
    cognitionDeep: 'gpt-5.6-sol/medium',
    expression: 'gpt-5.6-sol/medium',
    supervisor: 'gpt-5.6-terra/medium',
  });
  assert.deepEqual(module.CANDIDATE_THREE_JUDGE_PROFILE, {
    cognitionFast: 'gpt-5.6-sol/medium',
    cognitionDeep: 'gpt-5.6-sol/xhigh',
    expression: 'gpt-5.6-sol/medium',
    supervisor: 'gpt-5.6-sol/medium',
  });
});

test('stage one limits reject widened, duplicate, or unknown question sets', async () => {
  const module = await import(pathToFileURL(SCRIPT).href);
  const limits = module.pilotLimitsForStage(1);
  assert.deepEqual(limits, {
    allowedFinalKeys: [
      'sentinel:first_red_packet_as_social_action:0',
      'sentinel:fourth_coquetry_test_or_pressure:0',
    ],
    maxModelCallsPerFinal: 32,
    maxModelCallOrdinalPerPhase: 15,
    maxTotalModelCalls: 64,
    maxWallClockMs: 2_700_000,
    usageStatus: 'unobservable',
  });
  assert.equal(module.assertStageSelection(1, limits.allowedFinalKeys), true);
  for (const invalid of [
    [...limits.allowedFinalKeys, 'sentinel:first_scolded_by_manager:0'],
    [limits.allowedFinalKeys[0], limits.allowedFinalKeys[0]],
    ['sentinel:not_a_real_scene:0'],
  ]) {
    assert.throws(() => module.assertStageSelection(1, invalid), /stage selection conflict/);
  }
});

test('stage three resolves and pins every selected turn kind to one release pair', async () => {
  const module = await import(pathToFileURL(SCRIPT).href);
  const plan = JSON.parse(readFileSync(join(
    process.cwd(),
    'artifacts', 'yuqi-lived-agency-v3', 'private', 'three-judge-pilot',
    'quality-replay-plan.json',
  ), 'utf8'));
  const rolloutKeys = module.rolloutKeysForThreeJudgeStage({ plan, stage: 3 });
  assert.deepEqual(rolloutKeys, [
    'DIRECT_REPLY',
    'PROACTIVE_MOMENT',
    'MOMENT_REPLY',
    'ROLE_PLAN_CHAT',
    'LIFE_PLANNING',
  ]);

  const store = new YuqiStore(':memory:');
  try {
    const presets = new PresetRegistry({
      presetDir: join(process.cwd(), 'yuqi-runtime', 'presets'),
      store,
      clock: () => 1,
    });
    const promotion = new PromotionController({ store, presetRegistry: presets, clock: () => 1 });
    promotion.initialize();
    const releases = store.listPipelineReleases();
    const baseline = releases.find(row => row.pipelineVersion === 'stable-visible-baseline-2026-07-30');
    const cognitionV2 = releases.find(row => row.pipelineVersion === 'cognition-v2-candidate-2026-07-30');
    assert.ok(baseline);
    assert.ok(cognitionV2);
    const unrelatedBefore = promotion.getStatus('MOMENT_INTERACTION');

    module.pinThreeJudgeRolloutReleasePair({
      store,
      promotion,
      presets,
      rolloutKeys,
      stableRelease: cognitionV2,
      candidateRelease: baseline,
    });

    for (const rolloutKey of rolloutKeys) {
      const row = promotion.getStatus(rolloutKey);
      assert.equal(row.stableReleaseId, cognitionV2.releaseId, rolloutKey);
      assert.equal(row.candidateReleaseId, baseline.releaseId, rolloutKey);
      assert.equal(row.currentMode, 'active', rolloutKey);
      assert.equal(row.candidatePhase, 'none', rolloutKey);
      assert.equal(row.presetVersion, baseline.presetVersion, rolloutKey);
      assert.equal(row.pipelineChecksum, presets.evidenceManifest(rolloutKey).checksum, rolloutKey);
    }
    assert.deepEqual(promotion.getStatus('MOMENT_INTERACTION'), unrelatedBefore);
  } finally {
    store.close();
  }
});

test('four isolated lanes bind the approved models and cap one final at 32 role calls', async () => {
  const module = await import(pathToFileURL(SCRIPT).href);
  const lanes = module.buildThreeJudgeLaneDefinitions({
    rootDir: 'C:/detached/yuqi',
    codexCommand: 'C:/Codex/codex.exe',
  });
  assert.deepEqual(Object.keys(lanes), [
    'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary',
  ]);
  assert.deepEqual(lanes.stable_execution.modelProfile, module.STABLE_THREE_JUDGE_PROFILE);
  assert.deepEqual(lanes.candidate_execution.modelProfile, module.CANDIDATE_THREE_JUDGE_PROFILE);
  assert.equal(lanes.evaluator_primary.modelProfile, 'gpt-5.6-sol/medium');
  assert.equal(lanes.evaluator_secondary.modelProfile, 'gpt-5.6-terra/high');
  assert.deepEqual(lanes.stable_execution.clientInfo, {
    name: 'yuqi_quality_three_judge',
    title: 'Yuqi Quality Three-Judge Pilot',
    version: '1.0.0',
  });
  assert.deepEqual(
    Object.values(lanes).map(lane => lane.turnTimeoutMs),
    [600_000, 600_000, 600_000, 600_000],
  );
  assert.equal(Object.values(lanes).reduce((sum, lane) => sum + lane.maxRoleTurns, 0), 32);
  assert.equal(new Set(Object.values(lanes).map(lane => lane.sessionStorePath)).size, 4);
  assert.equal(new Set(Object.values(lanes).map(lane => lane.sessionNamespace)).size, 4);
  const stageThree = module.buildThreeJudgeLaneDefinitions({
    rootDir: 'C:/detached/yuqi',
    codexCommand: 'C:/Codex/codex.exe',
    stage: 3,
  });
  assert.equal(
    Object.values(stageThree).every(lane => lane.sessionNamespace.includes('/stage-3/')),
    true,
  );
  assert.equal(
    Object.values(stageThree).some((lane, index) =>
      lane.sessionNamespace === Object.values(lanes)[index].sessionNamespace),
    false,
  );
  assert.equal(
    Object.values(stageThree).some((lane, index) =>
      lane.sessionStorePath === Object.values(lanes)[index].sessionStorePath),
    false,
  );
});

test('pilot material manifest binds one detached source and one isolated database per side', async () => {
  const module = await import(pathToFileURL(SCRIPT).href);
  assert.equal(
    module.THREE_JUDGE_MATERIAL_FILE,
    'artifacts/yuqi-lived-agency-v3/private/quality-production-config.json',
  );
  const stableRelease = { releaseId: 'stable', modelProfile: module.STABLE_THREE_JUDGE_PROFILE };
  const candidateRelease = { releaseId: 'candidate', modelProfile: module.CANDIDATE_THREE_JUDGE_PROFILE };
  const manifest = module.buildPilotMaterialManifest({
    rootDir: 'C:/detached/yuqi',
    codexCommand: 'C:/Codex/codex.exe',
    sourceHead: 'a'.repeat(40),
    stableRelease,
    candidateRelease,
    seedDatabaseSha256: 'b'.repeat(64),
  });
  assert.deepEqual(Object.keys(manifest), [
    'version', 'sourceHead', 'runtimeConfig', 'stableRelease', 'candidateRelease',
    'lanes', 'stableRuntime', 'candidateRuntime', 'seedDatabasePath',
    'stableDatabasePath', 'candidateDatabasePath', 'seedDatabaseSha256',
  ]);
  assert.equal(manifest.stableRuntime.stableReleaseId, 'stable');
  assert.equal(manifest.stableRuntime.candidateReleaseId, null);
  assert.equal(manifest.candidateRuntime.stableReleaseId, 'stable');
  assert.equal(manifest.candidateRuntime.candidateReleaseId, 'candidate');
  assert.equal(new Set([
    manifest.seedDatabasePath, manifest.stableDatabasePath, manifest.candidateDatabasePath,
  ]).size, 3);
});

test('production CLI preserves the private relative ledger authority path', async () => {
  const runner = await import(pathToFileURL(RUNNER).href);
  const relative = 'artifacts/yuqi-lived-agency-v3/private/three-judge/quality-replay-state.sqlite';
  assert.equal(runner.productionLedgerAuthorityPath(relative), relative);
  for (const invalid of [
    'C:/outside/quality.sqlite',
    '../private/quality.sqlite',
    'artifacts\\private\\quality.sqlite',
  ]) {
    assert.throws(() => runner.productionLedgerAuthorityPath(invalid), /ledger path conflict/);
  }
});

test('production CLI reports its original execute failure instead of crashing in the reporter', () => {
  const result = spawnSync(process.execPath, [
    RUNNER,
    '--execute',
    '--ledger', 'artifacts/yuqi-lived-agency-v3/private/missing.sqlite',
    '--plan', 'artifacts/yuqi-lived-agency-v3/private/missing-plan.json',
    '--execution-config', 'scripts/missing-config.mjs',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stderr, /ReferenceError: execute is not defined/);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.failedGates, ['QUALITY_REPLAY_EXECUTION_UNAVAILABLE']);
  assert.match(report.blockingReason, /ENOENT|not found|unavailable/i);
});

test('completed evaluator transport is normalized from its structured text payload', async () => {
  const runner = await import(pathToFileURL(RUNNER).href);
  const evaluation = {
    version: 1,
    scores: {
      socialUnderstanding: 5,
      agency: 4,
      relationshipParticipation: 5,
      stateContinuityFlexibility: 4,
      livedExpression: 5,
      actionFactIntegrity: 4,
    },
    preference: 'A',
    findings: [],
    unresolved: false,
  };
  assert.deepEqual(runner.normalizeBlindEvaluatorPhaseOutput({
    status: 'completed', error: null, text: JSON.stringify(evaluation),
    threadId: 'thread-evaluator', turnId: 'turn-evaluator',
  }), evaluation);
  assert.throws(() => runner.normalizeBlindEvaluatorPhaseOutput({
    status: 'completed', error: null, text: JSON.stringify(evaluation),
    threadId: 'thread-evaluator', turnId: 'turn-evaluator', extra: true,
  }), /transport shape/);
});

test('production evaluator input exposes anonymous A/B outputs instead of release-side names', async () => {
  const runner = await import(pathToFileURL(RUNNER).href);
  const item = {
    sceneId: 'blind_scene', repeatIndex: 0,
    scene: {
      severity: 'high', focus: 'read the social bid', turns: [],
      mustNotice: ['notice the bid'], allowedPersonalityVariation: ['brief'],
    },
  };
  const input = runner.buildAnonymousBlindEvaluatorInput({
    item,
    subjectType: 'turn',
    phaseOutputs: {
      stable_execution: { stable: { draft: { action: 'send', reply: 'stable text' } } },
      candidate_execution: { candidate: { draft: { action: 'send', reply: 'candidate text' } } },
    },
  });
  assert.deepEqual(Object.keys(input), [
    'version', 'subjectType', 'sceneAnnotation', 'dimensions', 'outputs',
  ]);
  assert.equal(Object.hasOwn(input, 'stable'), false);
  assert.equal(Object.hasOwn(input, 'candidate'), false);
  assert.deepEqual(input.outputs.map(output => output.label), ['A', 'B']);
  assert.deepEqual(
    input.outputs.map(output => output.replyParts[0].text).sort(),
    ['candidate text', 'stable text'],
  );
});

test('production evaluator resolves its private context from the plan item, not blind input', async () => {
  const runner = await import(pathToFileURL(RUNNER).href);
  assert.equal(runner.qualityFinalKeyFromItem({
    layer: 'sentinel', sceneId: 'blind_scene', repeatIndex: 2,
  }), 'sentinel:blind_scene:2');
  assert.throws(() => runner.qualityFinalKeyFromItem({
    layer: 'sentinel', sceneId: 'blind_scene', repeatIndex: '2',
  }), /item identity/);
});
