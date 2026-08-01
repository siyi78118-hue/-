import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { compileQualitySuite } from '../scripts/compile-yuqi-lived-quality-scenes.mjs';

const rootDir = process.cwd();
const protocolRoot = resolve(rootDir, 'tests/fixtures/yuqi-cognition-protocol-v1');

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
