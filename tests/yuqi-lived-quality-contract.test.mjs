import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
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

test('real-history extraction is candidate-first and labels cannot supply persisted dialogue', () => {
  const source = readFileSync(resolve(rootDir, 'scripts/extract-yuqi-real-history-scenes.mjs'), 'utf8');
  assert.match(source, /--labels/);
  assert.match(source, /candidatesPath/);
  assert.match(source, /persistedContextProjection/);
  assert.doesNotMatch(source, /historyScene/);
  assert.doesNotMatch(source, /annotation_snapshot/);
});

test('quality CLI package scripts are declared without production release registration', () => {
  const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts['cognition:quality:check'], 'node scripts/compile-yuqi-lived-quality-scenes.mjs --check');
  assert.equal(
    packageJson.scripts['cognition:quality:annotations'],
    'node scripts/compile-yuqi-preset-history-scenes.mjs --write'
  );
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

test('Task6 production report and readiness are wired to the shared v2/manual-review contract', () => {
  const reportSource = readFileSync(resolve(rootDir, 'scripts/report-yuqi-lived-quality.mjs'), 'utf8');
  const readinessSource = readFileSync(resolve(rootDir, 'scripts/verify-yuqi-v3-readiness.mjs'), 'utf8');
  assert.match(reportSource, /validateQualityReplayV2Rows/);
  assert.match(readinessSource, /validateQualityReplayV2Rows/);
  for (const field of [
    'manual_metadata', 'manual_provenance', 'primaryJudgmentChecksum',
    'secondaryJudgmentChecksum', 'finalValueChecksum', 'resolvedOutput'
  ]) {
    assert.match(reportSource, new RegExp(field));
  }
  assert.match(reportSource, /legacy_structural/);
  assert.match(reportSource, /evidenceEligible\s*:\s*false/);
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
  assert.equal(suite.manifest.humanAnnotationSceneCount, 30);
  assert.equal(Object.hasOwn(suite.manifest, 'localHistoryTargetCount'), false);
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
      'file', 'heading', 'headingChecksum', 'sceneChecksum', 'sectionChecksum', 'sourceDocSha256'
    ]);
    assert.equal(typeof entry.file, 'string');
    assert.equal(typeof entry.heading, 'string');
    assert.match(entry.headingChecksum, /^[0-9a-f]{64}$/);
    assert.match(entry.sceneChecksum, /^[0-9a-f]{64}$/);
    assert.match(entry.sourceDocSha256, /^[0-9a-f]{64}$/);
    assert.match(entry.sectionChecksum, /^[0-9a-f]{64}$/);
  }
});

test('source grounding commits exact document and markdown section bytes, including shared fourth-round sections', () => {
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  const repeatedFourth = Object.values(index.sentinels).filter(entry => (
    entry.file === '真人聊天训练批注-第四轮-交接.md' && entry.heading === '七、建议的第四轮覆盖范围'
  ));
  assert.equal(repeatedFourth.length, 7);
  assert.equal(new Set(repeatedFourth.map(entry => entry.sectionChecksum)).size, 1);
  for (const entry of Object.values(index.sentinels)) {
    const markdown = readFileSync(resolve(rootDir, 'preset-references', entry.file), 'utf8');
    const normalized = markdown.replaceAll('\r\n', '\n');
    const lines = normalized.split('\n');
    const headingMatch = new RegExp(`^#{2,6}\\s+${entry.heading.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*$`);
    const headingIndex = lines.findIndex(line => {
      const match = line.match(/^(#{2,6})\s+(.+?)\s*$/);
      return match && match[2] === entry.heading;
    });
    assert.notEqual(headingIndex, -1, `${entry.file}#${entry.heading}`);
    const level = lines[headingIndex].match(/^(#{2,6})/)[1].length;
    let end = lines.length;
    for (let i = headingIndex + 1; i < lines.length; i += 1) {
      const match = lines[i].match(/^(#{2,6})\s+(.+?)\s*$/);
      if (match && match[1].length <= level) { end = i; break; }
    }
    const section = lines.slice(headingIndex, end).join('\n').trimEnd();
    assert.equal(entry.sourceDocSha256, createHash('sha256').update(markdown, 'utf8').digest('hex'));
    assert.equal(entry.sectionChecksum, createHash('sha256').update(section, 'utf8').digest('hex'));
  }
});

test('compiled quality suite carries the committed source grounding index', () => {
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  const index = readJson(resolve(qualityRoot, 'source-grounding-index.json'));
  assert.deepEqual(suite.sourceGroundingIndex, index);
});

test('quality compilation fails when any referenced annotation document is absent', () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'yuqi-quality-source-'));
  mkdirSync(resolve(tempRoot, 'tests/fixtures'), { recursive: true });
  mkdirSync(resolve(tempRoot, 'preset-references'), { recursive: true });
  cpSync(qualityRoot, resolve(tempRoot, 'tests/fixtures/yuqi-lived-quality-v1'), { recursive: true });
  for (const file of ['真人聊天训练批注-第一轮.md', '真人聊天训练批注-第二轮.md']) {
    cpSync(resolve(rootDir, 'preset-references', file), resolve(tempRoot, 'preset-references', file));
  }
  assert.throws(() => compileQualitySuite({ rootDir: tempRoot, checkOnly: true }), /source.*not found/i);
});

test('quality compilation rejects a changed section when its heading is retained', () => {
  const tempRoot = mkdtempSync(resolve(tmpdir(), 'yuqi-quality-section-'));
  mkdirSync(resolve(tempRoot, 'tests/fixtures'), { recursive: true });
  mkdirSync(resolve(tempRoot, 'preset-references'), { recursive: true });
  cpSync(qualityRoot, resolve(tempRoot, 'tests/fixtures/yuqi-lived-quality-v1'), { recursive: true });
  for (const file of ['真人聊天训练批注-第一轮.md', '真人聊天训练批注-第二轮.md', '真人聊天训练批注-第四轮-交接.md']) {
    cpSync(resolve(rootDir, 'preset-references', file), resolve(tempRoot, 'preset-references', file));
  }
  const path = resolve(tempRoot, 'preset-references/真人聊天训练批注-第四轮-交接.md');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('七、建议的第四轮覆盖范围', '七、建议的第四轮覆盖范围\nsection tampered for closure'), 'utf8');
  assert.throws(
    () => compileQualitySuite({ rootDir: tempRoot, checkOnly: true }),
    /source document|section|checksum/i
  );
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
