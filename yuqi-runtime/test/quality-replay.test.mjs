import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendQualityAttempt,
  assertVerifiedQualityReplayPlan,
  buildQualityReplayPlan,
  qualityFinalKey,
  qualityAttemptKey,
  loadQualityReplayPlanArtifact,
  writeQualityReplayPlanArtifact
} from '../src/quality-replay.mjs';
import {
  createQualityReplayPlan,
  appendQualityReplayArtifact,
  captureCleanSourceHead,
  runQualityReplayPlan as runQualityReplayPlanImpl
} from '../../scripts/run-yuqi-lived-quality-replay.mjs';
import { contentHash } from '../src/protocol.mjs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const SOURCE_ROOT = mkdtempSync(join(tmpdir(), 'yuqi-quality-source-'));
writeFileSync(join(SOURCE_ROOT, 'source-marker.txt'), 'clean source fixture\n');
execFileSync('git', ['init'], { cwd: SOURCE_ROOT, stdio: 'ignore' });
execFileSync('git', ['config', 'user.email', 'quality-fixture@example.invalid'], { cwd: SOURCE_ROOT });
execFileSync('git', ['config', 'user.name', 'quality-fixture'], { cwd: SOURCE_ROOT });
execFileSync('git', ['add', 'source-marker.txt'], { cwd: SOURCE_ROOT });
execFileSync('git', ['commit', '-m', 'quality source fixture'], { cwd: SOURCE_ROOT, stdio: 'ignore' });
test.after(() => rmSync(SOURCE_ROOT, { recursive: true, force: true }));

test('replay source provenance rejects a dirty source tree before execution', () => {
  const dirtyRoot = mkdtempSync(join(tmpdir(), 'yuqi-quality-dirty-source-'));
  try {
    writeFileSync(join(dirtyRoot, 'source-marker.txt'), 'clean source fixture\n');
    execFileSync('git', ['init'], { cwd: dirtyRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'quality-fixture@example.invalid'], { cwd: dirtyRoot });
    execFileSync('git', ['config', 'user.name', 'quality-fixture'], { cwd: dirtyRoot });
    execFileSync('git', ['add', 'source-marker.txt'], { cwd: dirtyRoot });
    execFileSync('git', ['commit', '-m', 'quality source fixture'], { cwd: dirtyRoot, stdio: 'ignore' });
    writeFileSync(join(dirtyRoot, 'dirty.txt'), 'uncommitted\n');
    assert.throws(() => captureCleanSourceHead({ rootDir: dirtyRoot }), /source tree is dirty/);
  } finally {
    rmSync(dirtyRoot, { recursive: true, force: true });
  }
});

function runQualityReplayPlan(args) {
  return runQualityReplayPlanImpl({ ...args, sourceRootDir: SOURCE_ROOT });
}

function scenes(prefix, count) {
  return Array.from({ length: count }, (_, index) => ({ sceneId: `${prefix}-${index}` }));
}

function historyManifest(historyScenes) {
  return {
    schemaVersion: 1,
    sceneIds: historyScenes.map(scene => scene.sceneId),
    scenesChecksum: contentHash(historyScenes)
  };
}

test('quality replay plan has exact 72/144/30 layer repeats and finalized keys', () => {
  const plan = buildQualityReplayPlan({
    sentinelSeeds: scenes('sentinel', 24),
    coverageScenes: scenes('coverage', 72),
    historyScenes: scenes('history', 30)
  });
  assert.equal(plan.length, 246);
  assert.equal(plan.filter(item => item.layer === 'sentinel').length, 72);
  assert.equal(plan.filter(item => item.layer === 'coverage').length, 144);
  assert.equal(plan.filter(item => item.layer === 'history').length, 30);
  assert.equal(new Set(plan.map(item => qualityFinalKey(item))).size, 246);
  assert.ok(plan.every(item => Number.isSafeInteger(item.repeatIndex) && item.repeatIndex >= 0));
});

test('quality attempts append under one final key and reject duplicate identity', () => {
  const attempts = [];
  const first = {
    layer: 'sentinel', sceneId: 'sentinel-0', repeatIndex: 0,
    attemptIndex: 0, evaluatorId: 'evaluator-a', output: { score: 4 }
  };
  const retry = { ...first, attemptIndex: 1, evaluatorId: 'evaluator-b' };
  appendQualityAttempt(attempts, first);
  appendQualityAttempt(attempts, retry);
  assert.deepEqual(attempts.map(item => qualityAttemptKey(item)), [
    'sentinel:sentinel-0:0:0:evaluator-a',
    'sentinel:sentinel-0:0:1:evaluator-b'
  ]);
  assert.throws(() => appendQualityAttempt(attempts, retry), /duplicate attempt/);
});

test('verified replay plan commits nested scene content and survives disk roundtrip validation', () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(),
    historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  assert.throws(() => {
    plan.items[0].scene.turns = [];
  }, /read only|assign|frozen/i);
  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.items[0].scene.sceneId = 'forged-scene';
  assert.throws(() => assertVerifiedQualityReplayPlan(tampered), /checksum|authority|plan/i);
  const nestedTampered = JSON.parse(JSON.stringify(plan));
  nestedTampered.items[0].scene.turns = [{ speaker: 'forged-history' }];
  assert.throws(() => assertVerifiedQualityReplayPlan(nestedTampered), /checksum|authority|plan/i);
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-plan-'));
  try {
    const path = join(directory, 'plan.json');
    writeQualityReplayPlanArtifact(plan, path);
    const historyPath = join(directory, 'history.json');
    const manifestPath = join(directory, 'history-manifest.json');
    writeFileSync(historyPath, JSON.stringify(historyScenes));
    writeFileSync(manifestPath, JSON.stringify(historyManifest(historyScenes)));
    const loaded = loadQualityReplayPlanArtifact({
      artifactPath: path,
      rootDir: process.cwd(),
      historyScenes,
      historyManifest: historyManifest(historyScenes)
    });
    assert.equal(loaded.planChecksum, plan.planChecksum);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).planChecksum, plan.planChecksum);
    const child = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { loadQualityReplayPlanArtifact } from ${JSON.stringify(new URL('../src/quality-replay.mjs', import.meta.url).href)};
      const scenes = JSON.parse(readFileSync(${JSON.stringify(historyPath)}, 'utf8'));
      const manifest = JSON.parse(readFileSync(${JSON.stringify(manifestPath)}, 'utf8'));
      const plan = loadQualityReplayPlanArtifact({ artifactPath: ${JSON.stringify(path)}, rootDir: ${JSON.stringify(process.cwd())}, historyScenes: scenes, historyManifest: manifest });
      process.stdout.write(plan.planChecksum);
    `], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    assert.equal(child, plan.planChecksum);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('replay script consumes the compiled suite through one exact plan', () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(),
    historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  assert.equal(plan.items.length, 246);
  assert.equal(new Set(plan.items.map(qualityFinalKey)).size, 246);
  assert.match(plan.planChecksum, /^[0-9a-f]{64}$/);
});

test('replay execution uses one dry-run executor and appends one finalized result', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(),
    historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  let sideEffects = 0;
  const result = await runQualityReplayPlan({
    plan,
    releasePair: {
      stable: { releaseId: 'stable', releaseChecksum: 'stable-checksum' },
      candidate: { releaseId: 'candidate', releaseChecksum: 'candidate-checksum' }
    },
    executor: {
      async executeTurn(request) {
        assert.equal(request.dryRun, true);
        assert.deepEqual(request.capabilities, { visible: false, actions: false });
        return { draft: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } } };
      }
    },
    maxItems: 1,
    evaluator: async input => {
      assert.deepEqual(Object.keys(input).sort(), ['dimensions', 'outputs', 'sceneAnnotation', 'version']);
      return {
        version: 1,
        scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
          'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
        preference: 'candidate', findings: [], unresolved: false
      };
    },
    onSideEffect: () => { sideEffects += 1; }
  });
  assert.equal(result.finalized.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.finalized[0].attempts[0].accepted, true);
  assert.ok(result.finalized[0].findings.some(finding => finding.code === 'CURRENT_BATCH_OMISSION'));
  assert.equal(result.finalized[0].protocolFailure, true);
  assert.equal(result.replayProvenance.executionPairs.length, 1);
  assert.equal(result.replayProvenance.modelRuns.length, 1);
  assert.match(result.replayProvenance.sourceHead, /^[0-9a-f]{40}$/);
  assert.equal(result.replayProvenance.executionPairs[0].sourceHead, result.replayProvenance.sourceHead);
  assert.equal(result.replayProvenance.provenanceChecksum.length, 64);
  assert.equal(result.replayProvenance.executionPairs[0].dryRun, true);
  assert.equal(result.replayProvenance.modelRuns[0].completed, true);
  assert.equal(sideEffects, 0);
});

test('replay rejects a source HEAD or dirty-tree change detected after execution', async () => {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'yuqi-quality-source-change-'));
  try {
    writeFileSync(join(sourceRoot, 'source-marker.txt'), 'clean source fixture\n');
    execFileSync('git', ['init'], { cwd: sourceRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'quality-fixture@example.invalid'], { cwd: sourceRoot });
    execFileSync('git', ['config', 'user.name', 'quality-fixture'], { cwd: sourceRoot });
    execFileSync('git', ['add', 'source-marker.txt'], { cwd: sourceRoot });
    execFileSync('git', ['commit', '-m', 'quality source fixture'], { cwd: sourceRoot, stdio: 'ignore' });
    const historyScenes = scenes('history', 30);
    const plan = createQualityReplayPlan({
      rootDir: process.cwd(),
      historyScenes,
      historyManifest: historyManifest(historyScenes)
    });
    const evaluation = {
      version: 1,
      scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
        'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
      preference: 'candidate', findings: [], unresolved: false
    };
    await assert.rejects(() => runQualityReplayPlanImpl({
      plan,
      sourceRootDir: sourceRoot,
      releasePair: {
        stable: { releaseId: 'stable', releaseChecksum: 'stable-checksum' },
        candidate: { releaseId: 'candidate', releaseChecksum: 'candidate-checksum' }
      },
      executor: {
        async executeTurn() {
          writeFileSync(join(sourceRoot, 'dirty-during-replay.txt'), 'changed while running\n');
          return { draft: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } } };
        }
      },
      maxItems: 1,
      evaluator: async () => evaluation
    }), /source tree|source HEAD|changed/i);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('severe blind findings require agreement from two independent evaluators', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(),
    historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  const critical = {
    version: 1,
    scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
      'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
    preference: 'candidate',
    findings: [{ code: 'MODEL_CRITICAL', severity: 'critical', owner: 'blind', summary: 'bad', critical: true }],
    unresolved: false
  };
  const benign = { ...critical, findings: [] };
  const result = await runQualityReplayPlan({
    plan,
    releasePair: {
      stable: { releaseId: 'stable', releaseChecksum: 'stable-checksum' },
      candidate: { releaseId: 'candidate', releaseChecksum: 'candidate-checksum' }
    },
    executor: { async executeTurn() {
      return { draft: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } } };
    } },
    maxItems: 1,
    evaluator: async () => critical,
    evaluatorSecondary: async () => benign
  });
  assert.equal(result.replayProvenance.modelRuns.length, 2);
  assert.equal(result.finalized[0].unresolved, true);
  assert.ok(result.finalized[0].findings.some(finding => finding.code === 'BLIND_EVALUATION_DISAGREEMENT'));
  const reverse = await runQualityReplayPlan({
    plan,
    releasePair: {
      stable: { releaseId: 'stable', releaseChecksum: 'stable-checksum' },
      candidate: { releaseId: 'candidate', releaseChecksum: 'candidate-checksum' }
    },
    executor: { async executeTurn() {
      return { draft: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } } };
    } },
    maxItems: 1,
    evaluator: async () => benign,
    evaluatorSecondary: async () => critical
  });
  assert.equal(reverse.finalized[0].unresolved, true);
});

test('replay execution persists append-only attempts, finals, checksums, latency, and provenance', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(),
    historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  const evaluation = {
    version: 1,
    scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
      'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
    preference: 'candidate', findings: [], unresolved: false
  };
  const result = await runQualityReplayPlan({
    plan,
    releasePair: {
      stable: { releaseId: 'stable', releaseChecksum: 'stable-checksum' },
      candidate: { releaseId: 'candidate', releaseChecksum: 'candidate-checksum' }
    },
    executor: { async executeTurn() {
      return { draft: { output: { terminalDisposition: 'visible', replyParts: [], actions: [] } } };
    } },
    maxItems: 1,
    evaluator: async () => evaluation,
    evaluatorSecondary: async () => evaluation,
    evaluatorVersion: 'blind-evaluator-v1',
    secondaryEvaluatorVersion: 'blind-evaluator-v1b',
    now: (() => { let value = 100; return () => (value += 7); })()
  });
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-replay-artifact-'));
  try {
    const artifactPath = join(directory, 'replay.jsonl');
    appendQualityReplayArtifact({ artifactPath, result });
    appendQualityReplayArtifact({ artifactPath, result });
    const rows = readFileSync(artifactPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rows.length, 14);
    assert.match(result.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(result.replayProvenance.runId, result.runId);
    assert.ok(rows.every(row => row.runId === result.runId));
    assert.ok(rows.some(row => row.recordType === 'attempt' && row.executionChecksum));
    assert.ok(rows.some(row => row.recordType === 'final' && row.latencyMs >= 0));
    assert.ok(rows.some(row => row.recordType === 'execution' && row.dryRun === true));
    assert.ok(rows.some(row => row.recordType === 'model' && row.evaluatorId === 'blind-evaluator-v1b'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
