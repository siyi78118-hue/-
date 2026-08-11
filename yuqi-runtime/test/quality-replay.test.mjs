import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendQualityAttempt,
  assertVerifiedQualityReplayPlan,
  buildQualityReplayPlan,
  validateQualityReplayV2Rows,
  canonicalQualityReplayV2Jsonl,
  qualityFinalKey,
  qualityAttemptKey,
  loadQualityReplayPlanArtifact,
  writeQualityReplayPlanArtifact
} from '../src/quality-replay.mjs';

test('v2 replay validator exposes canonical row collections and rejects legacy rows', () => {
  const run = {
    schemaVersion: 2, recordType: 'run', runId: '123e4567-e89b-42d3-a456-426614174111',
    header: { version: 1 }, headerChecksum: 'a'.repeat(64), state: 'finalized',
    createdAt: 1, finalizedAt: 2
  };
  assert.throws(() => validateQualityReplayV2Rows({
    rows: [{ recordType: 'attempt', runId: run.runId }],
    plan: { finalKeys: [] }
  }), /v2|record|schema/i);
  assert.throws(() => canonicalQualityReplayV2Jsonl({ rows: [run] }), /provenance|v2|record/i);
});
import {
  createQualityReplayPlan,
  appendQualityReplayArtifact,
  captureCleanSourceHead,
  runQualityReplayFixture as runQualityReplayPlanImpl,
  runQualityReplayPlanSqlite,
  createQualityRunHeader,
  parseQualityReplayCliArgs,
  assertProductionExecuteCliArgs
} from '../../scripts/run-yuqi-lived-quality-replay.mjs';
import { assertCleanQualitySourceIdentity } from '../src/quality-replay-production-bridge.mjs';
import { contentHash } from '../src/protocol.mjs';
import { QualityReplayLedger, LedgerBackedModelClient } from '../src/quality-replay-ledger.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('clean source gate only ignores private untracked evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-quality-source-gate-'));
  try {
    writeFileSync(join(root, 'tracked.txt'), 'v1\n');
    writeFileSync(join(root, '.gitignore'), 'artifacts/yuqi-lived-agency-v3/private/\n');
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'quality-fixture@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'quality-fixture'], { cwd: root });
    execFileSync('git', ['add', 'tracked.txt', '.gitignore'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'source gate fixture'], { cwd: root, stdio: 'ignore' });
    const head = assertCleanQualitySourceIdentity({ sourceRootDir: root });
    assert.match(head, /^[0-9a-f]{40}$/);
    mkdirSync(join(root, 'artifacts/yuqi-lived-agency-v3/private'), { recursive: true });
    writeFileSync(join(root, 'artifacts/yuqi-lived-agency-v3/private', 'raw.jsonl'), '{}\n');
    assert.equal(assertCleanQualitySourceIdentity({ sourceRootDir: root, expectedHead: head }), head);
    writeFileSync(join(root, 'tracked.txt'), 'changed\n');
    assert.throws(() => assertCleanQualitySourceIdentity({ sourceRootDir: root }), /source tree is dirty/);
    execFileSync('git', ['restore', 'tracked.txt'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, 'other.txt'), 'untracked\n');
    assert.throws(() => assertCleanQualitySourceIdentity({ sourceRootDir: root }), /source tree is dirty/);
    rmSync(join(root, 'other.txt'));
    rmSync(join(root, 'tracked.txt'));
    assert.throws(() => assertCleanQualitySourceIdentity({ sourceRootDir: root }), /source tree is dirty/);
    execFileSync('git', ['restore', 'tracked.txt'], { cwd: root, stdio: 'ignore' });
    assert.throws(() => assertCleanQualitySourceIdentity({ sourceRootDir: root, expectedHead: 'f'.repeat(40) }), /HEAD drift/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function runQualityReplayPlan(args) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-run-test-'));
  try {
    const onlyFinalKey = args.onlyFinalKey || (args.maxItems === 1
      ? `${args.plan.items[0].layer}:${args.plan.items[0].sceneId}:${args.plan.items[0].repeatIndex}`
      : args.onlyFinalKey);
    const { maxItems: _maxItems, ...rest } = args;
    return await runQualityReplayPlanImpl({ ...rest, onlyFinalKey,
      ledger: join(directory, 'quality-replay.sqlite'), sourceRootDir: SOURCE_ROOT });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('quality replay CLI parser rejects unknown duplicate valueless and max-items options', () => {
  assert.deepEqual(parseQualityReplayCliArgs(['--ledger', 'quality.sqlite', '--execute']), {
    ledger: 'quality.sqlite', execute: true,
  });
  assert.throws(() => parseQualityReplayCliArgs(['--unknown']), /unknown/i);
  assert.throws(() => parseQualityReplayCliArgs(['--ledger', 'a', '--ledger', 'b']), /duplicate/i);
  assert.throws(() => parseQualityReplayCliArgs(['--ledger']), /value|required/i);
  assert.throws(() => parseQualityReplayCliArgs(['--max-items', '1']), /max-items|production/i);
  assert.throws(() => parseQualityReplayCliArgs(['--execute']), /ledger/i);
  assert.deepEqual(parseQualityReplayCliArgs([
    '--execute', '--ledger', 'quality.sqlite', '--execution-config', 'authority.mjs'
  ]), {
    execute: true, ledger: 'quality.sqlite', executionConfig: 'authority.mjs'
  });
  assert.throws(() => parseQualityReplayCliArgs(['--run-authority', 'authority.mjs']), /unknown/i);
});

test('production execute rejects legacy input flags before authority preflight', () => {
  const base = { execute: true, plan: 'plan.json', ledger: 'ledger.sqlite', executionConfig: 'authority.mjs' };
  for (const key of ['stableFrom', 'candidatePreset', 'history', 'historyManifest', 'planOut']) {
    assert.throws(() => assertProductionExecuteCliArgs({ ...base, [key]: 'legacy-input' }), /forbids legacy/i);
  }
  assert.equal(assertProductionExecuteCliArgs({ ...base, replayOut: 'raw.jsonl' }), true);
  assert.throws(() => assertProductionExecuteCliArgs({ execute: true, ledger: 'ledger.sqlite' }), /existing.*plan|execution-config/i);
});

test('generic callbacks cannot select a production ledger or leave a ledger behind', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-production-guard-'));
  const ledgerPath = join(directory, 'quality-replay.sqlite');
  try {
    await assert.rejects(() => runQualityReplayPlanSqlite({
      ledgerPath, evidenceClass: 'production',
      subjectFactory: async () => ({}), executeQualitySubjectSide: async () => ({}),
      evaluator: async () => ({}), evaluatorSecondary: async () => ({})
    }), /production ledger authority is private/);
    assert.equal(existsSync(ledgerPath), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('orphan running phase with zero calls becomes uncertain without replaying the model', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({ rootDir: process.cwd(), historyScenes,
    historyManifest: historyManifest(historyScenes) });
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-orphan-running-'));
  const ledgerPath = join(directory, 'quality.sqlite');
  const runId = '123e4567-e89b-42d3-a456-426614174111';
  const sourceHead = 'a'.repeat(40);
  const release = side => ({ releaseId: `release-${side}`, pipelineVersion: 'v3',
    presetVersion: 'p1', cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'eval-v1', modelProfile: { side }, componentManifest: { side },
    releaseChecksum: (side === 's' ? 'a' : 'b').repeat(64), createdAt: 1, retiredAt: null });
  const attestation = { version: 1, sourceHead,
    stableRuntime: { sourceHead }, candidateRuntime: { sourceHead },
    evaluatorPrimary: { evaluatorId: 'primary', evaluatorVersion: 'v1',
      modelProfileChecksum: '1'.repeat(64), clientConfigChecksum: '2'.repeat(64), sessionNamespaceChecksum: '3'.repeat(64) },
    evaluatorSecondary: { evaluatorId: 'secondary', evaluatorVersion: 'v1b',
      modelProfileChecksum: '4'.repeat(64), clientConfigChecksum: '5'.repeat(64), sessionNamespaceChecksum: '6'.repeat(64) } };
  const finalKeys = plan.items.map(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}`);
  const header = createQualityRunHeader({ runId, finalKeys, planChecksum: plan.planChecksum,
    sourceHead, stableRelease: release('s'), candidateRelease: release('c'), attestation,
    artifactPaths: { plan: 'plan.json', ledger: 'quality.sqlite', raw: 'raw.jsonl' }, createdAt: 1 });
  const finalKey = finalKeys[0];
  const seededSubject = { finalKey, semanticInput: { finalKey },
    semanticInputChecksum: contentHash({ finalKey }) };
  const phaseInput = { runId, finalKey, phase: 'stable_execution',
    subjectChecksum: contentHash(seededSubject), authorityInputChecksum: seededSubject.semanticInputChecksum,
    input: { finalKey, subjectChecksum: contentHash(seededSubject),
      authorityInputChecksum: seededSubject.semanticInputChecksum }, now: 2 };
  const seed = new QualityReplayLedger(ledgerPath);
  seed.createOrOpenRun(header);
  seed.preparePhase(phaseInput);
  seed.startPhase(phaseInput, { now: 3 });
  seed.markPhaseRunning(phaseInput, { now: 4 });
  seed.close();
  let modelCalls = 0;
  try {
    await assert.rejects(() => runQualityReplayPlanSqlite({
      plan, ledgerPath, header, resumeRun: runId, onlyFinalKey: finalKey, allowAuthorityFallback: true,
      subjectFactory: async () => seededSubject,
      executeQualitySubjectSide: async () => { modelCalls += 1; return {}; },
      evaluator: async () => ({}), evaluatorSecondary: async () => ({})
    }), /orphan running uncertain/i);
    const reopened = new QualityReplayLedger(ledgerPath);
    try {
      assert.equal(modelCalls, 0);
      assert.equal(reopened.getRun({ runId }).state, 'blocked');
      assert.equal(reopened.getPhase({ runId, finalKey, phase: 'stable_execution' }).state, 'uncertain');
    } finally { reopened.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SQLite replay runs one final through the ordered four-phase ledger', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({
    rootDir: process.cwd(), historyScenes,
    historyManifest: historyManifest(historyScenes)
  });
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-quality-sqlite-run-'));
  const ledgerPath = join(directory, 'quality-replay.sqlite');
  const runId = '123e4567-e89b-42d3-a456-426614174099';
  const sourceHead = 'a'.repeat(40);
  const release = suffix => ({
    releaseId: `release-${suffix}`, pipelineVersion: 'v3', presetVersion: 'p1',
    cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'eval-v1', modelProfile: { id: suffix },
    componentManifest: { id: suffix }, releaseChecksum: suffix.repeat(64),
    createdAt: 1, retiredAt: null
  });
  const attestation = {
    version: 1, sourceHead,
    stableRuntime: { sourceHead }, candidateRuntime: { sourceHead },
    evaluatorPrimary: { evaluatorId: 'a', evaluatorVersion: 'v1',
      modelProfileChecksum: '1'.repeat(64), clientConfigChecksum: '2'.repeat(64),
      sessionNamespaceChecksum: '3'.repeat(64) },
    evaluatorSecondary: { evaluatorId: 'b', evaluatorVersion: 'v1',
      modelProfileChecksum: '4'.repeat(64), clientConfigChecksum: '5'.repeat(64),
      sessionNamespaceChecksum: '6'.repeat(64) }
  };
  const finalKeys = plan.items.map(item => `${item.layer}:${item.sceneId}:${item.repeatIndex}`);
  const header = createQualityRunHeader({ runId, finalKeys, planChecksum: plan.planChecksum,
    sourceHead, stableRelease: release('a'), candidateRelease: release('b'), attestation,
    artifactPaths: { plan: 'plan.json', ledger: 'quality-replay.sqlite', raw: 'replay.jsonl' }, createdAt: 1 });
  const evaluation = { version: 1,
    scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
      'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
    preference: 'tie', findings: [], unresolved: false };
  const result = await runQualityReplayPlanSqlite({
    plan, ledgerPath, header, onlyFinalKey: finalKeys[0],
    subjectFactory: async item => ({ finalKey: finalKeys[0], sceneId: item.sceneId,
      semanticInput: { sceneId: item.sceneId }, semanticInputChecksum: contentHash({ sceneId: item.sceneId }) }),
    executeQualitySubjectSide: async ({ side, phaseClient }) => {
      await phaseClient.runTurn('brain', JSON.stringify({ side }), {
        model: 'quality-controlled-v1', effort: 'high', outputSchema: { type: 'object' }
      });
      return { side, output: { terminalDisposition: 'visible', replyParts: [], actions: [] } };
    },
    evaluator: async ({ phaseClient }) => {
      await phaseClient.runTurn('brain', JSON.stringify({ evaluator: 'primary' }), {
        model: 'quality-controlled-v1', effort: 'high', outputSchema: { type: 'object' }
      });
      return evaluation;
    },
    evaluatorSecondary: async ({ phaseClient }) => {
      await phaseClient.runTurn('brain', JSON.stringify({ evaluator: 'secondary' }), {
        model: 'quality-controlled-v1', effort: 'high', outputSchema: { type: 'object' }
      });
      return evaluation;
    },
    allowAuthorityFallback: true,
    phaseClientFactory: async ({ ledger, runId, phaseInput, now: clock }) => {
      const underlying = {
        turnTimeoutMs: 180_000,
        async ensureThread() { return `fixture-thread-${runId}`; },
        async readThread(threadId) { return { id: threadId, turns: [] }; },
        async runTurn(role, input, options = {}) {
          await options.onTurnStarted?.({ turnId: `fixture-turn-${contentHash({ runId, role, input }).slice(0, 24)}` });
          return { status: 'completed', role, input };
        },
      };
      return new LedgerBackedModelClient({ ledger, underlying, runId, now: clock }).forPhase(phaseInput);
    },
    now: (() => { let value = 1; return () => ++value; })()
  });
  assert.equal(result.results.length, 1);
  const check = new QualityReplayLedger(ledgerPath);
  try {
    assert.equal(check.getRun({ runId }).state, 'open');
    assert.equal(check.getFinal({ runId, finalKey: finalKeys[0] }).state, 'finalized');
    assert.deepEqual(['stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary']
      .map(phase => check.getPhase({ runId, finalKey: finalKeys[0], phase }).state),
      ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
  } finally {
    check.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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
      assert.deepEqual(Object.keys(input).sort(), ['dimensions', 'outputs', 'sceneAnnotation', 'subjectType', 'version']);
      return {
        version: 1,
        scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
          'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
        preference: 'B', findings: [], unresolved: false
      };
    },
    evaluatorSecondary: async () => ({
      version: 1,
      scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
        'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
      preference: 'B', findings: [], unresolved: false
    }),
    onSideEffect: () => { sideEffects += 1; }
  });
  assert.equal(result.finalized.length, 1);
  assert.equal(result.attempts.length, 1);
  assert.equal(result.finalized[0].attempts[0].accepted, true);
  assert.equal(result.finalized[0].attempts.length, 1);
  assert.equal(result.replayProvenance.executionPairs.length, 0);
  assert.equal(result.replayProvenance.modelRuns.length, 2);
  assert.match(result.replayProvenance.sourceHead, /^[0-9a-f]{40}$/);
  assert.equal(result.replayProvenance.provenanceChecksum.length, 64);
  assert.equal(result.replayProvenance.modelRuns[0].completed, true);
  assert.equal(sideEffects, 8);
});

test('JSON ledger state machines are rejected; SQLite ledger owns resume authority', async () => {
  const historyScenes = scenes('history', 30);
  const plan = createQualityReplayPlan({ rootDir: process.cwd(), historyScenes, historyManifest: historyManifest(historyScenes) });
  await assert.rejects(() => runQualityReplayPlanImpl({ plan, ledger: 'run.json',
    evaluator: async () => null, evaluatorSecondary: async () => null }), /SQLite quality ledger/);
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
      preference: 'B', findings: [], unresolved: false
    };
    await assert.rejects(() => runQualityReplayPlanImpl({
      plan,
      sourceRootDir: sourceRoot,
      ledger: join(sourceRoot, 'quality-replay.sqlite'),
      onlyFinalKey: `${plan.items[0].layer}:${plan.items[0].sceneId}:${plan.items[0].repeatIndex}`,
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
      evaluator: async () => evaluation,
      evaluatorSecondary: async () => evaluation
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
    preference: 'B',
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
    preference: 'B', findings: [], unresolved: false
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
    result.evidenceClass = 'production';
    assert.throws(() => appendQualityReplayArtifact({ artifactPath, result }), /fixture|legacy|result/i);
    result.evidenceClass = 'fixture';
    const legacyArtifact = appendQualityReplayArtifact({ artifactPath, result });
    assert.deepEqual(legacyArtifact, {
      artifactPath, evidenceClass: 'legacy_structural', evidenceEligible: false
    });
    appendQualityReplayArtifact({ artifactPath, result });
    const rows = readFileSync(artifactPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rows.length, 6);
    assert.match(result.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(result.replayProvenance.runId, result.runId);
    assert.ok(rows.every(row => row.runId === result.runId));
    assert.ok(rows.some(row => row.recordType === 'attempt' && row.executionChecksum));
    assert.ok(rows.some(row => row.recordType === 'attempt' && row.latencyMs >= 0));
    assert.ok(rows.some(row => row.recordType === 'model' && row.evaluatorId === 'blind-evaluator-v1b'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeV2Rows(finalKeys = ['sentinel:scene-0:0']) {
  const runId = '123e4567-e89b-42d3-a456-426614174111';
  const header = { version: 1, finalKeys: [...finalKeys] };
  const headerChecksum = contentHash(header);
  const run = {
    schemaVersion: 2, recordType: 'run', runId, header, headerChecksum,
    state: 'finalized', createdAt: 1, finalizedAt: 1000
  };
  const executions = [];
  const phases = [];
  const calls = [];
  const judgments = [];
  const finals = [];
  for (const [finalIndex, finalKey] of finalKeys.entries()) {
    const subjectType = 'turn';
    const subjectChecksum = contentHash({ finalKey, subjectType, finalIndex });
    const phaseMap = {};
    for (const [phaseIndex, phase] of [
      'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary'
    ].entries()) {
      const input = { finalKey, phase, finalIndex };
      const authorityInputChecksum = contentHash({ finalKey, phase, authority: true });
      const inputChecksum = contentHash({ subjectChecksum, authorityInputChecksum, input });
      const evaluation = phase.startsWith('evaluator_')
        ? { version: 1,
          scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
            'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
          preference: 'tie', findings: [], unresolved: false }
        : null;
      const output = evaluation ?? { finalKey, phase, ok: true };
      const outputChecksum = contentHash(output);
      phaseMap[phase] = { inputChecksum, outputChecksum };
      phases.push({ schemaVersion: 2, recordType: 'phase', runId, finalKey, phase,
        state: 'succeeded', subjectChecksum, authorityInputChecksum, input, inputChecksum,
        output, outputChecksum, createdAt: 10 + phaseIndex, startingAt: 10 + phaseIndex,
        runningAt: 10 + phaseIndex, updatedAt: 20 + phaseIndex });
      const blindInput = { version: 1, finalKey, subjectType, subjectChecksum };
      const request = phase.startsWith('evaluator_')
        ? { input: JSON.stringify(blindInput), phase }
        : { phase, finalKey };
      const modelOutput = { phase, ok: true };
      calls.push({ schemaVersion: 2, recordType: 'model_call', runId, finalKey, phase,
        ordinal: 0, state: 'succeeded', role: 'brain', callId: `call-${finalIndex}-${phase}`,
        clientUserMessageId: `msg-${finalIndex}-${phase}`, threadId: `thread-${finalIndex}`,
        turnId: `turn-${finalIndex}-${phase}`, baseline: { phase },
        baselineChecksum: contentHash({ phase }), request, requestChecksum: contentHash(request),
        model: 'model-v1', effort: 'high', schemaChecksum: contentHash({ schema: 1 }),
        output: modelOutput, outputChecksum: contentHash(modelOutput), runningAt: 10 + phaseIndex,
        createdAt: 10 + phaseIndex, updatedAt: 15 + phaseIndex });
      if (phase.startsWith('evaluator_')) {
        const evaluatorId = phase === 'evaluator_primary' ? 'evaluator-primary' : 'evaluator-secondary';
        const evaluatorVersion = phase === 'evaluator_primary' ? 'eval-v1' : 'eval-v1b';
        judgments.push({ schemaVersion: 2, recordType: 'judgment', runId, finalKey, phase,
          evaluatorId, evaluatorVersion, inputChecksum: contentHash(blindInput), output,
          outputChecksum, judgmentChecksum: contentHash({
            finalKey, phase, evaluatorId, evaluatorVersion,
            inputChecksum: contentHash(blindInput), output, outputChecksum
          }) });
      }
    }
    const blindInput = { version: 1, finalKey, subjectType, subjectChecksum };
    const blindInputChecksum = contentHash(blindInput);
    const output = { version: 1,
      scores: Object.fromEntries(['socialUnderstanding', 'agency', 'relationshipParticipation',
        'stateContinuityFlexibility', 'livedExpression', 'actionFactIntegrity'].map(key => [key, 4])),
      preference: 'tie', findings: [], unresolved: false };
    const judgment = phase => {
      const row = judgments.find(item => item.finalKey === finalKey && item.phase === phase);
      return { evaluatorId: row.evaluatorId, evaluatorVersion: row.evaluatorVersion,
        inputChecksum: row.inputChecksum, output: row.output, outputChecksum: row.outputChecksum };
    };
    const value = { version: 1, finalKey, subjectType, subjectChecksum,
      stablePhase: { ...phaseMap.stable_execution }, candidatePhase: { ...phaseMap.candidate_execution },
      blindInputChecksum, primary: judgment('evaluator_primary'),
      secondary: judgment('evaluator_secondary'),
      comparison: { version: 1, differences: [], manualReview: false,
        unresolved: false, agreedCriticalFindings: [] } };
    const execution = { schemaVersion: 2, recordType: 'execution', runId, finalKey, subjectType,
      subjectChecksum, stablePhase: phaseMap.stable_execution, candidatePhase: phaseMap.candidate_execution };
    execution.executionChecksum = contentHash({ finalKey, subjectType, subjectChecksum,
      stablePhase: execution.stablePhase, candidatePhase: execution.candidatePhase });
    executions.push(execution);
    finals.push({ schemaVersion: 2, recordType: 'final', runId, finalKey, value,
      valueChecksum: contentHash(value), executionChecksum: execution.executionChecksum, finalizedAt: 100 });
  }
  const rows = [run, ...executions, ...phases, ...calls, ...judgments, ...finals];
  const recordCounts = { run: 1, execution: executions.length, phase: phases.length,
    modelCall: calls.length, judgment: judgments.length, final: finals.length };
  const provenance = { schemaVersion: 2, recordType: 'provenance', runId, recordCounts,
    recordsChecksum: contentHash(rows), provenanceChecksum: contentHash({
      runId, headerChecksum, recordCounts, recordsChecksum: contentHash(rows)
    }) };
  return [...rows, provenance];
}

function rehashV2Rows(rows, { legacyProvenance = false } = {}) {
  const body = rows.filter(row => row.recordType !== 'provenance');
  const provenance = rows.find(row => row.recordType === 'provenance');
  provenance.recordsChecksum = contentHash(body);
  const run = rows.find(row => row.recordType === 'run');
  const basis = legacyProvenance
    ? { runId: provenance.runId, recordCounts: provenance.recordCounts,
      recordsChecksum: provenance.recordsChecksum }
    : { runId: provenance.runId, headerChecksum: run.headerChecksum,
      recordCounts: provenance.recordCounts, recordsChecksum: provenance.recordsChecksum };
  provenance.provenanceChecksum = contentHash(basis);
}

test('v2 provenance binds header checksum and rejects legacy self-consistent header mutation', () => {
  const rows = makeV2Rows();
  const run = rows.find(row => row.recordType === 'run');
  run.header.extra = 'forged';
  run.headerChecksum = contentHash(run.header);
  rehashV2Rows(rows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [run.header.finalKeys[0]] } }), /provenance|header/i);
});

test('v2 judgment checksum binds complete output, not only output checksum', () => {
  const rows = makeV2Rows();
  const judgment = rows.find(row => row.recordType === 'judgment' && row.phase === 'evaluator_primary');
  const final = rows.find(row => row.recordType === 'final');
  judgment.output.scores.agency = 5;
  judgment.outputChecksum = contentHash(judgment.output);
  judgment.judgmentChecksum = contentHash({ finalKey: judgment.finalKey, phase: judgment.phase,
    evaluatorId: judgment.evaluatorId, evaluatorVersion: judgment.evaluatorVersion,
    inputChecksum: judgment.inputChecksum, outputChecksum: judgment.outputChecksum });
  final.value.primary.output = judgment.output;
  final.value.primary.outputChecksum = judgment.outputChecksum;
  final.valueChecksum = contentHash(final.value);
  rehashV2Rows(rows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [final.finalKey] } }), /judgment|checksum|output/i);
});

test('v2 rows enforce plan order and reject orphan phase/call/judgment records', () => {
  const keys = ['sentinel:scene-0:0', 'sentinel:scene-1:0'];
  const rows = makeV2Rows(keys);
  const firstFinal = rows.findIndex(row => row.recordType === 'final');
  const finals = rows.filter(row => row.recordType === 'final').reverse();
  rows.splice(firstFinal, finals.length, ...finals);
  rehashV2Rows(rows);
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: keys } }), /order|final/i);
  const orphanRows = makeV2Rows();
  const orphan = { ...orphanRows.find(row => row.recordType === 'phase'), finalKey: 'orphan:scene:0' };
  orphanRows.splice(orphanRows.findIndex(row => row.recordType === 'provenance'), 0, orphan);
  rehashV2Rows(orphanRows);
  assert.throws(() => validateQualityReplayV2Rows({ rows: orphanRows, plan: { finalKeys: ['sentinel:scene-0:0'] } }), /orphan|owner|phase|join/i);
});

test('v2 execution joins stable and candidate phase authority exactly', () => {
  const rows = makeV2Rows();
  const execution = rows.find(row => row.recordType === 'execution');
  const final = rows.find(row => row.recordType === 'final');
  execution.stablePhase.outputChecksum = 'f'.repeat(64);
  execution.executionChecksum = contentHash({ finalKey: execution.finalKey, subjectType: execution.subjectType,
    subjectChecksum: execution.subjectChecksum, stablePhase: execution.stablePhase,
    candidatePhase: execution.candidatePhase });
  final.executionChecksum = execution.executionChecksum;
  rehashV2Rows(rows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [final.finalKey] } }), /phase|execution|authority|join/i);
});

test('v2 evaluator phase output joins its judgment output exactly', () => {
  const rows = makeV2Rows();
  const phase = rows.find(row => row.recordType === 'phase' && row.phase === 'evaluator_primary');
  phase.output = { ...phase.output, ok: false };
  phase.outputChecksum = contentHash(phase.output);
  rehashV2Rows(rows);
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [phase.finalKey] } }), /phase|judgment|output|join/i);
});

test('v2 evaluator judgment input binds blind input and owned evaluator request', () => {
  const rows = makeV2Rows();
  const final = rows.find(row => row.recordType === 'final');
  const call = rows.find(row => row.recordType === 'model_call' && row.phase === 'evaluator_primary');
  call.request = { ...call.request, input: JSON.stringify({ forged: true }) };
  call.requestChecksum = contentHash(call.request);
  rehashV2Rows(rows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [final.finalKey] } }), /blind|input|request|judgment/i);
});

test('v2 final requires complete non-null Task5 value and exact judgment/comparison join', () => {
  const rows = makeV2Rows();
  const final = rows.find(row => row.recordType === 'final');
  final.value = null;
  final.valueChecksum = contentHash(null);
  rehashV2Rows(rows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows, plan: { finalKeys: [final.finalKey] } }), /final|value|judgment/i);

  const forgedRows = makeV2Rows();
  const forgedFinal = forgedRows.find(row => row.recordType === 'final');
  forgedFinal.value.primary.output.scores.agency = 1;
  forgedFinal.valueChecksum = contentHash(forgedFinal.value);
  rehashV2Rows(forgedRows, { legacyProvenance: true });
  assert.throws(() => validateQualityReplayV2Rows({ rows: forgedRows, plan: { finalKeys: [forgedFinal.finalKey] } }), /final|judgment|output|comparison/i);
});
