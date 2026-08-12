import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const SCRIPT = join(process.cwd(), 'scripts', 'prepare-yuqi-three-judge-pilot.mjs');
const RUNNER = join(process.cwd(), 'scripts', 'run-yuqi-lived-quality-replay.mjs');

test('three-judge pilot has a dedicated non-model preparer', () => {
  assert.equal(existsSync(SCRIPT), true);
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
