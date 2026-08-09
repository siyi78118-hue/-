import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { compileQualitySuite } from '../scripts/compile-yuqi-lived-quality-scenes.mjs';

const rootDir = process.cwd();
const protocolRoot = resolve(rootDir, 'tests/fixtures/yuqi-cognition-protocol-v1');
const qualityRoot = resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1');

test('real-history extractor is explicitly readonly and never opens production config/store', () => {
  const source = readFileSync(resolve(rootDir, 'scripts/extract-yuqi-real-history-scenes.mjs'), 'utf8');
  assert.match(source, /DatabaseSync/);
  assert.match(source, /readOnly:\s*true/);
  assert.match(source, /--database/);
  assert.match(source, /manifest/);
  assert.doesNotMatch(source, /YuqiStore/);
  assert.doesNotMatch(source, /config\.json/);
  assert.doesNotMatch(source, /journal_mode\s*=\s*WAL/i);
});

test('quality CLI package scripts are declared without production release registration', () => {
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['cognition:quality:check'], 'node scripts/compile-yuqi-lived-quality-scenes.mjs --check');
  assert.equal(packageJson.scripts['cognition:quality:replay'], 'node scripts/run-yuqi-lived-quality-replay.mjs');
  assert.equal(packageJson.scripts['cognition:quality:report'], 'node scripts/report-yuqi-lived-quality.mjs');
  const replaySource = readFileSync(resolve(rootDir, 'scripts/run-yuqi-lived-quality-replay.mjs'), 'utf8');
  assert.match(replaySource, /--stable-from/);
  assert.match(replaySource, /--candidate-preset/);
  assert.match(replaySource, /--plan/);
  const reportSource = readFileSync(resolve(rootDir, 'scripts/report-yuqi-lived-quality.mjs'), 'utf8');
  for (const option of ['--plan', '--history', '--history-manifest', '--evidence', '--candidate-release', '--manual-review']) {
    assert.match(reportSource, new RegExp(option.replaceAll('-', '\\-')));
  }
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('protocol suite contains 270 cases but makes no human-quality claim', () => {
  const manifest = readJson(resolve(protocolRoot, 'manifest.json'));
  assert.equal(manifest.suitePurpose, 'protocol_regression');
  assert.equal(manifest.caseCount, 270);
  assert.equal(manifest.qualityEvidenceEligible, false);
});

test('human quality suite has exact source-grounded counts and complete annotations', () => {
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  assert.equal(suite.sentinelSeeds.length, 24);
  assert.equal(suite.coverageScenes.length, 72);
  for (const scene of [...suite.sentinelSeeds, ...suite.coverageScenes]) {
    assert.ok(scene.turns.length >= 4 && scene.turns.length <= 12, scene.sceneId);
    assert.ok(scene.mustNotice.length, scene.sceneId);
    assert.ok(scene.allowedDecisionRange.length, scene.sceneId);
    assert.ok(scene.forbiddenFailurePatterns.length, scene.sceneId);
    assert.ok(scene.requiredActionIntegrity, scene.sceneId);
    assert.ok(scene.allowedPersonalityVariation.length, scene.sceneId);
    assert.ok(scene.expectedStateTransitions, scene.sceneId);
    assert.ok(scene.forbiddenStateTransitions, scene.sceneId);
    assert.ok(scene.sourceAnnotation.file, scene.sceneId);
    assert.ok(scene.sourceAnnotation.heading, scene.sceneId);
    assert.ok(['critical', 'high', 'medium'].includes(scene.severity), scene.sceneId);
    assert.doesNotMatch(JSON.stringify(scene), /脱敏测试消息\s*\d+/, scene.sceneId);
  }
});

test('each sentinel has three independently authored structural variants', () => {
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  for (const seed of suite.sentinelSeeds) {
    const variants = suite.coverageScenes.filter(scene => scene.parentSentinelId === seed.sceneId);
    assert.deepEqual(variants.map(scene => scene.variantKind).sort(), [
      'delayed_or_interrupted', 'feature_coupled', 'surface_rewording'
    ]);
    assert.equal(new Set(variants.map(scene => contentHash(scene.turns))).size, 3, seed.sceneId);
  }
});

test('quality source map names all sentinels and only committed annotation headings', () => {
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  assert.equal(Object.keys(suite.sources.sentinels).length, 24);
  for (const scene of suite.sentinelSeeds) {
    const source = suite.sources.sentinels[scene.sceneId];
    assert.equal(source.file, scene.sourceAnnotation.file);
    assert.equal(source.heading, scene.sourceAnnotation.heading);
  }
});

test('source grounding index is a closed, exact 24-sentinel integrity manifest', () => {
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  assert.deepEqual(Object.keys(index).sort(), ['schemaVersion', 'sentinels']);
  assert.equal(index.schemaVersion, 1);
  assert.equal(Object.keys(index.sentinels).length, 24);
  for (const [sceneId, entry] of Object.entries(index.sentinels)) {
    assert.ok(sceneId && typeof sceneId === 'string');
    assert.deepEqual(Object.keys(entry).sort(), [
      'file', 'heading', 'headingChecksum', 'sceneChecksum'
    ]);
    assert.equal(typeof entry.file, 'string');
    assert.equal(typeof entry.heading, 'string');
    assert.match(entry.headingChecksum, /^[0-9a-f]{64}$/);
    assert.match(entry.sceneChecksum, /^[0-9a-f]{64}$/);
  }
});

test('compiled quality suite carries the committed source grounding index', () => {
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  assert.deepEqual(suite.sourceGroundingIndex, index);
});

test('source grounding index rejects a substituted scene checksum', () => {
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  const original = index.sentinels.first_sleep_deprived_still_working.sceneChecksum;
  index.sentinels.first_sleep_deprived_still_working.sceneChecksum = '0'.repeat(64);
  assert.notEqual(index.sentinels.first_sleep_deprived_still_working.sceneChecksum, original);
  assert.throws(
    () => compileQualitySuite({ rootDir, checkOnly: true, sourceGroundingIndex: index }),
    /scene checksum|source grounding/i
  );
});

test('source grounding index rejects missing, extra, and wrong-parent mappings', () => {
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  const missing = structuredClone(index);
  delete missing.sentinels.first_sleep_deprived_still_working;
  assert.throws(() => compileQualitySuite({ rootDir, sourceGroundingIndex: missing }), /sentinel set mismatch/);

  const extra = structuredClone(index);
  extra.sentinels.extra_sentinel = {
    file: '真人聊天训练批注-第一轮.md',
    heading: 'extra',
    headingChecksum: '0'.repeat(64),
    sceneChecksum: '0'.repeat(64)
  };
  assert.throws(() => compileQualitySuite({ rootDir, sourceGroundingIndex: extra }), /sentinel set mismatch/);

  const wrongParent = structuredClone(index);
  wrongParent.sentinels.first_i_miss_you = structuredClone(wrongParent.sentinels.first_sleep_deprived_still_working);
  assert.throws(() => compileQualitySuite({ rootDir, sourceGroundingIndex: wrongParent }), /parent mismatch|checksum mismatch/);
});
