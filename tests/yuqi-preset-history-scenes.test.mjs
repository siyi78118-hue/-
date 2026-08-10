import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  compilePresetHistoryScenes,
  presetHistoryArtifactPaths
} from '../scripts/compile-yuqi-preset-history-scenes.mjs';
import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { compileSceneExecutionInput } from '../yuqi-runtime/src/quality-evaluator.mjs';
import {
  createQualityReplayPlan,
  loadLocalHistoryManifest,
  loadLocalHistoryScenes
} from '../scripts/run-yuqi-lived-quality-replay.mjs';
import {
  loadQualityHistoryInputs,
  materializeQualityReport
} from '../scripts/report-yuqi-lived-quality.mjs';
import { writeQualityReplayPlanArtifact } from '../yuqi-runtime/src/quality-replay.mjs';

const rootDir = process.cwd();

test('tracked human annotations compile into exactly 30 source-grounded quality scenes', () => {
  const result = compilePresetHistoryScenes({ rootDir });
  assert.equal(result.scenes.length, 30);
  assert.equal(result.manifest.schemaVersion, 1);
  assert.deepEqual(result.manifest.sceneIds, result.scenes.map(scene => scene.sceneId));
  assert.equal(result.manifest.scenesChecksum, contentHash(result.scenes));
  assert.equal(new Set(result.scenes.map(scene => scene.sceneId)).size, 30);
  assert.equal(new Set(result.scenes.map(scene => (
    `${scene.sourceAnnotation.file}\u0000${scene.sourceAnnotation.heading}`
  ))).size, 30);
  assert.deepEqual(
    Object.fromEntries([...new Set(result.scenes.map(scene => scene.sourceAnnotation.file))]
      .sort().map(file => [file, result.scenes.filter(scene => scene.sourceAnnotation.file === file).length])),
    {
      '真人聊天训练批注-第一轮.md': 20,
      '真人聊天训练批注-第二轮.md': 10
    }
  );

  for (const scene of result.scenes) {
    assert.equal(scene.sourceAuthority, 'tracked_human_annotations');
    assert.equal(scene.evidenceClass, 'human_annotation_regression');
    assert.equal(scene.qualityOnly, true);
    assert.equal(scene.realHistoryEvidence, false);
    assert.equal(scene.liveShadowEvidenceEligible, false);
    assert.equal(scene.annotationVersion, 'task25f-annotation-v1');
    assert.match(scene.sourceAnnotation.sourceDocSha256, /^[0-9a-f]{64}$/);
    assert.match(scene.sourceAnnotation.sectionChecksum, /^[0-9a-f]{64}$/);
    assert.match(scene.sourceAnnotation.sceneChecksum, /^[0-9a-f]{64}$/);
    assert.ok(scene.turns.length >= 4 && scene.turns.length <= 12);
    assert.ok(scene.mustNotice.length);
    assert.ok(scene.allowedDecisionRange.length);
    assert.ok(scene.forbiddenFailurePatterns.length);
    assert.ok(scene.allowedPersonalityVariation.length);
    assert.equal(scene.turns.some(turn => turn.speaker === 'assistant'), false, scene.sceneId);
    assert.doesNotMatch(JSON.stringify(scene), /assistantReply|replyTemplate|expectedResponse/);
  }
});

test('annotation evaluation guidance is never exposed to the candidate execution input', () => {
  const result = compilePresetHistoryScenes({ rootDir });
  for (const scene of result.scenes) {
    const execution = compileSceneExecutionInput(scene);
    const wire = JSON.stringify(execution);
    assert.equal(Object.hasOwn(execution.context, 'annotationScenario'), false, scene.sceneId);
    assert.equal(wire.includes(scene.focus), false, scene.sceneId);
    for (const criterion of scene.mustNotice) assert.equal(wire.includes(criterion), false, scene.sceneId);
    for (const failure of scene.forbiddenFailurePatterns) assert.equal(wire.includes(failure), false, scene.sceneId);
    if (scene.rolloutKey === 'PROACTIVE_CHAT') {
      assert.equal(typeof execution.context.currentTrigger, 'string', scene.sceneId);
      assert.ok(execution.context.currentTrigger.length > 0, scene.sceneId);
    } else {
      assert.deepEqual(execution.context, {}, scene.sceneId);
    }
  }
});

test('the 30 annotation scenes do not reuse sentinel or coverage identities or source headings', async () => {
  const { compileQualitySuite } = await import('../scripts/compile-yuqi-lived-quality-scenes.mjs');
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  const result = compilePresetHistoryScenes({ rootDir });
  const occupiedIds = new Set([
    ...suite.sentinelSeeds.map(scene => scene.sceneId),
    ...suite.coverageScenes.map(scene => scene.sceneId)
  ]);
  const occupiedSources = new Set(suite.sentinelSeeds.map(scene => (
    `${scene.sourceAnnotation.file}\u0000${scene.sourceAnnotation.heading}`
  )));
  for (const scene of result.scenes) {
    assert.equal(occupiedIds.has(scene.sceneId), false, scene.sceneId);
    assert.equal(occupiedSources.has(
      `${scene.sourceAnnotation.file}\u0000${scene.sourceAnnotation.heading}`
    ), false, scene.sceneId);
  }
});

test('annotation compilation fails closed when source text or committed source index changes', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yuqi-annotation-source-'));
  cpSync(resolve(rootDir, 'preset-references'), resolve(fixtureRoot, 'preset-references'), { recursive: true });
  cpSync(
    resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1/task25f-history-source-index.json'),
    resolve(fixtureRoot, 'task25f-history-source-index.json')
  );
  const firstRound = resolve(fixtureRoot, 'preset-references/真人聊天训练批注-第一轮.md');
  writeFileSync(firstRound, readFileSync(firstRound, 'utf8').replace('中午没吃饭', '中午忘了吃饭'), 'utf8');
  assert.throws(() => compilePresetHistoryScenes({
    rootDir: fixtureRoot,
    sourceIndexPath: resolve(fixtureRoot, 'task25f-history-source-index.json')
  }), /source document|heading|section.*conflict/i);
});

test('preset history artifact defaults are committed fixture paths, not private database paths', () => {
  const paths = presetHistoryArtifactPaths(rootDir);
  assert.equal(paths.scenesPath, resolve(
    rootDir, 'tests/fixtures/yuqi-lived-quality-v1/preset-history-scenes.jsonl'
  ));
  assert.equal(paths.manifestPath, resolve(
    rootDir, 'tests/fixtures/yuqi-lived-quality-v1/preset-history-scenes.manifest.json'
  ));
  assert.doesNotMatch(`${paths.scenesPath}\n${paths.manifestPath}`, /artifacts[\\/]yuqi-lived-agency-v3[\\/]private/);
});

test('quality replay defaults to committed annotation evidence without a private history export', () => {
  const scenes = loadLocalHistoryScenes({ rootDir });
  const manifest = loadLocalHistoryManifest({ rootDir });
  const reportInputs = loadQualityHistoryInputs({ rootDir });
  const plan = createQualityReplayPlan({ rootDir });
  assert.equal(scenes.length, 30);
  assert.equal(manifest.scenesChecksum, contentHash(scenes));
  assert.equal(reportInputs.historyInputMode, 'preset_default');
  assert.equal(plan.finalKeys.historyFinalKeys.length, 30);
  assert.equal(plan.historyManifest.scenesChecksum, manifest.scenesChecksum);
});

test('only an explicit history pair is classified as an override', () => {
  const paths = presetHistoryArtifactPaths(rootDir);
  const reportInputs = loadQualityHistoryInputs({
    rootDir,
    historyPath: paths.scenesPath,
    historyManifestPath: paths.manifestPath
  });
  assert.equal(reportInputs.historyInputMode, 'explicit_override');
});

test('default annotation artifacts cannot be self-consistently rewritten away from their source sections', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yuqi-annotation-artifact-'));
  cpSync(resolve(rootDir, 'preset-references'), resolve(fixtureRoot, 'preset-references'), { recursive: true });
  cpSync(
    resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1'),
    resolve(fixtureRoot, 'tests/fixtures/yuqi-lived-quality-v1'),
    { recursive: true }
  );
  const paths = presetHistoryArtifactPaths(fixtureRoot);
  const scenes = readFileSync(paths.scenesPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  scenes[0].focus = 'tampered but self-consistent focus';
  writeFileSync(paths.scenesPath, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, 'utf8');
  writeFileSync(paths.manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    sceneIds: scenes.map(scene => scene.sceneId),
    scenesChecksum: contentHash(scenes)
  }, null, 2)}\n`, 'utf8');
  assert.throws(() => loadLocalHistoryScenes({ rootDir: fixtureRoot }), /annotation source commitment/i);
  assert.throws(() => loadLocalHistoryManifest({ rootDir: fixtureRoot }), /annotation source commitment/i);
  assert.throws(() => loadQualityHistoryInputs({ rootDir: fixtureRoot }), /annotation source commitment/i);
});

test('default report materialization rechecks annotation sources after its initial input load', () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'yuqi-annotation-report-'));
  cpSync(resolve(rootDir, 'preset-references'), resolve(fixtureRoot, 'preset-references'), { recursive: true });
  cpSync(
    resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1'),
    resolve(fixtureRoot, 'tests/fixtures/yuqi-lived-quality-v1'),
    { recursive: true }
  );
  const history = loadQualityHistoryInputs({ rootDir: fixtureRoot });
  const planPath = resolve(fixtureRoot, 'quality-plan.json');
  writeQualityReplayPlanArtifact(createQualityReplayPlan({ rootDir: fixtureRoot }), planPath);

  const scenes = readFileSync(history.historyPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  scenes[0].focus = 'self-consistent report bypass attempt';
  writeFileSync(history.historyPath, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, 'utf8');
  writeFileSync(history.historyManifestPath, `${JSON.stringify({
    schemaVersion: 1,
    sceneIds: scenes.map(scene => scene.sceneId),
    scenesChecksum: contentHash(scenes)
  }, null, 2)}\n`, 'utf8');

  const report = materializeQualityReport({
    evidence: {},
    planArtifactPath: planPath,
    rootDir: fixtureRoot,
    ...history,
    replayProvenance: {}
  });
  assert.equal(report.eligible, false);
  assert.deepEqual(report.failedGates, ['QUALITY_REPORT_AUTHORITY_INVALID']);
  assert.match(report.blockingReason, /annotation source commitment/i);
});

test('quality CLI defaults no longer name the missing private history files', () => {
  const replaySource = readFileSync(resolve(rootDir, 'scripts/run-yuqi-lived-quality-replay.mjs'), 'utf8');
  const reportSource = readFileSync(resolve(rootDir, 'scripts/report-yuqi-lived-quality.mjs'), 'utf8');
  assert.doesNotMatch(replaySource, /private\/real-history-scenes/);
  assert.doesNotMatch(reportSource, /private\/real-history-scenes/);
  assert.match(replaySource, /presetHistoryArtifactPaths/);
  assert.match(reportSource, /presetHistoryArtifactPaths/);
  const compilerSource = readFileSync(resolve(rootDir, 'scripts/compile-yuqi-preset-history-scenes.mjs'), 'utf8');
  assert.doesNotMatch(compilerSource, /refresh-index|refreshPresetHistorySourceIndex/);
});
