import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { YuqiStore } from '../src/store.mjs';
import { PresetRegistry } from '../src/preset-registry.mjs';
import { PromotionController } from '../src/promotion-controller.mjs';

import { contentHash } from '../src/protocol.mjs';
import { ROLE_OUTPUT_SCHEMAS } from '../src/role-schemas.mjs';
import {
  createQualityReplayRunAuthority,
  assertQualityReplayRunAuthority,
} from '../../scripts/yuqi-quality-production-execution-config.mjs';
import { exportQualityReplayV2 } from '../../scripts/run-yuqi-lived-quality-replay.mjs';
import {
  executeQualityEvaluatorSide,
  prepareQualityProductionSubject,
  bindQualityProductionPhase,
  executeQualitySubjectSide,
  createQualityProductionExecutionAuthority,
  qualityRunAuthorityProductionConfig,
  readQualityProductionStoreManifest,
  awaitQualityPublishedStoreSidecarsGone,
} from '../src/quality-replay-production-bridge.mjs';
import { openProductionQualityReplayLedger, qualityClientUserMessageId } from '../src/quality-replay-ledger.mjs';

const PRIVATE = 'artifacts/yuqi-lived-agency-v3/private';
const TEMP_FIXTURES = new Set();

function listQualityPreflightTempDirs() {
  return new Set(readdirSync(tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('yuqi-quality-preflight-'))
    .map(entry => join(tmpdir(), entry.name)));
}

function removeNewQualityPreflightTempDirs(before) {
  const removed = [];
  for (const directory of listQualityPreflightTempDirs()) {
    if (before.has(directory)) continue;
    rmSync(directory, { recursive: true, force: true });
    removed.push(directory);
  }
  return removed;
}

afterEach(async () => {
  const failures = [];
  for (const root of TEMP_FIXTURES) {
    try {
      for (let attempt = 0; attempt < 20 && existsSync(root); attempt += 1) {
        rmSync(root, { recursive: true, force: true });
        if (existsSync(root)) await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (existsSync(root)) throw new Error('fixture root remained after deterministic cleanup retries');
    } catch (error) { failures.push(`${root}: ${error?.message || String(error)}`); }
  }
  TEMP_FIXTURES.clear();
  if (failures.length) throw new Error(`quality fixture cleanup failed: ${failures.join('; ')}`);
});

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function releaseFromRow(row) {
  return {
    releaseId: row.release_id, pipelineVersion: row.pipeline_version, presetVersion: row.preset_version,
    cognitionSchemaVersion: row.cognition_schema_version, expressionSchemaVersion: row.expression_schema_version,
    evaluatorVersion: row.evaluator_version, modelProfile: JSON.parse(row.model_profile_json),
    componentManifest: JSON.parse(row.component_manifest_json), releaseChecksum: row.release_checksum,
    createdAt: row.created_at, retiredAt: row.retired_at,
  };
}

function releaseChecksum(row, modelProfile, componentManifest) {
  const field = (snake, camel) => row[snake] ?? row[camel];
  return contentHash({
    pipelineVersion: field('pipeline_version', 'pipelineVersion'),
    presetVersion: field('preset_version', 'presetVersion'),
    cognitionSchemaVersion: field('cognition_schema_version', 'cognitionSchemaVersion'),
    expressionSchemaVersion: field('expression_schema_version', 'expressionSchemaVersion'),
    evaluatorVersion: field('evaluator_version', 'evaluatorVersion'), modelProfile, componentManifest,
    createdAt: field('created_at', 'createdAt'),
  });
}

function fixtureLane(name, root, modelProfile) {
  return {
    version: 1, lane: name, command: process.execPath, args: [], cwd: root,
    sessionStorePath: `${PRIVATE}/sessions/${name}.sqlite`, sessionNamespace: `quality/${name}`,
    env: {}, clientInfo: { protocol: 'codex-app-server-v1' }, requestTimeoutMs: 30_000,
    turnTimeoutMs: 120_000, maxRoleTurns: 8,
    modelProfile: modelProfile || (name === 'evaluator_primary'
      ? 'gpt-5.6-sol/medium' : 'gpt-5.6-terra/high'),
    approvalPolicy: 'never', sandbox: 'read-only',
    schema: { version: 1, kind: name.startsWith('evaluator_') ? 'blind_evaluation' : 'production_execution' },
  };
}

function buildPlan() {
  return JSON.parse(readFileSync(join(process.cwd(), 'artifacts/yuqi-lived-agency-v3/task25f-plan-preview.json'), 'utf8'));
}

function createGitFixture({ dirty = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-quality-production-config-'));
  TEMP_FIXTURES.add(root);
  mkdirSync(join(root, PRIVATE), { recursive: true });
  writeFileSync(join(root, '.gitignore'), `${PRIVATE}/\n`);
  writeFileSync(join(root, 'tracked.txt'), 'clean\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'quality@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Quality Test'], { cwd: root });
  execFileSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root });
  execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
  execFileSync('git', ['checkout', '--detach', '-q', 'HEAD'], { cwd: root });
  const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const plan = buildPlan();
  const planBytes = Buffer.from(JSON.stringify(plan));
  writeFileSync(join(root, PRIVATE, 'quality-replay-plan.json'), planBytes);
  const seedPath = join(root, PRIVATE, 'seed.sqlite');
  const stablePath = join(root, PRIVATE, 'stable.sqlite');
  const candidatePath = join(root, PRIVATE, 'candidate.sqlite');
  const seedStore = new YuqiStore(seedPath);
  const seedPresets = new PresetRegistry({
    presetDir: join(process.cwd(), 'yuqi-runtime', 'presets'),
    store: seedStore,
    clock: () => 1,
  });
  const seedPromotion = new PromotionController({
    store: seedStore, presetRegistry: seedPresets, clock: () => 1,
  });
  const qualityPresetVersion = '2.0.0';
  seedStore.setCurrentPresetVersion(qualityPresetVersion);
  seedPromotion.initialize();
  const rolloutStatus = seedPromotion.getStatus('DIRECT_REPLY');
  const stableBase = seedStore.getPipelineRelease(rolloutStatus.stableReleaseId);
  if (!stableBase) throw new Error('minimal v15 fixture stable release missing');
  const stableProfile = {
    cognitionFast: 'gpt-5.6-sol/medium', cognitionDeep: 'gpt-5.6-sol/high',
    expression: 'gpt-5.6-terra/medium', supervisor: 'gpt-5.6-terra/high',
  };
  const candidateProfile = {
    cognitionFast: 'gpt-5.6-terra/medium', cognitionDeep: 'gpt-5.6-terra/high',
    expression: 'gpt-5.6-sol/medium', supervisor: 'gpt-5.6-sol/high',
  };
  // Build a real v3 stable/candidate pair in the tiny fixture.  The default
  // YuqiStore seed contains legacy bootstrap rows; those are deliberately not
  // reused as the quality release pair because ReleaseExecutor rejects a v1/v2
  // stable row paired with a v3 candidate.
  const stableManifest = seedPresets.pipelineReleaseManifest(
    qualityPresetVersion,
    stableBase.releaseId,
    {
      modelProfile: stableProfile,
      cognitionSchemaVersion: 3,
      expressionSchemaVersion: 3,
      evaluatorVersion: 'quality-fixture-v3',
    }
  );
  const stableBody = {
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: qualityPresetVersion,
    cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'quality-fixture-v3', modelProfile: stableProfile,
    componentManifest: stableManifest.components, createdAt: 2, retiredAt: null,
  };
  const stableReleaseChecksum = releaseChecksum(stableBody, stableProfile, stableManifest.components);
  const insertedStable = seedStore.putPipelineReleaseInternal({
    ...stableBody,
    releaseId: `quality_stable_${stableReleaseChecksum.slice(0, 16)}`,
    releaseChecksum: stableReleaseChecksum,
  });
  const stableReleaseId = insertedStable.releaseId;
  const generatedCandidateManifest = seedPresets.pipelineReleaseManifest(
    qualityPresetVersion,
    stableReleaseId,
    {
      modelProfile: candidateProfile,
      cognitionSchemaVersion: 3,
      expressionSchemaVersion: 3,
      evaluatorVersion: 'quality-fixture-v3',
    }
  );
  const candidateBody = {
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: qualityPresetVersion,
    cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'quality-fixture-v3', modelProfile: candidateProfile,
    componentManifest: generatedCandidateManifest.components, createdAt: 3, retiredAt: null,
  };
  const candidateReleaseChecksum = releaseChecksum(candidateBody, candidateProfile, generatedCandidateManifest.components);
  const insertedCandidate = seedStore.putPipelineReleaseInternal({
    ...candidateBody,
    releaseId: `quality_candidate_${candidateReleaseChecksum.slice(0, 16)}`,
    releaseChecksum: candidateReleaseChecksum,
  });
  const candidateReleaseId = insertedCandidate.releaseId;
  seedPromotion.transition({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: rolloutStatus.revision,
    toMode: 'active', toPhase: 'stable', actor: 'manual',
    reasonCode: 'quality-wire-fixture',
  });
  // PromotionController owns the append-only transition; pin the resulting
  // rollout row to the newly-created v3 pair without manufacturing a second
  // rollout history or candidate report.
  seedStore.db.prepare(`
    UPDATE cognition_kind_rollouts
    SET stable_release_id = ?, candidate_release_id = ?, candidate_phase = 'none',
        pipeline_checksum = ?, preset_version = ?
    WHERE rollout_key = 'DIRECT_REPLY'
  `).run(
    stableReleaseId,
    candidateReleaseId,
    seedPresets.evidenceManifest('DIRECT_REPLY').checksum,
    qualityPresetVersion
  );
  const seedReleases = seedStore.listPipelineReleases();
  seedStore.close();
  copyFileSync(seedPath, stablePath);
  copyFileSync(seedPath, candidatePath);
  for (const path of [seedPath, stablePath, candidatePath]) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try { rmSync(`${path}${suffix}`, { force: true }); } catch {}
    }
  }
  const db = new DatabaseSync(seedPath, { readOnly: true });
  const releases = db.prepare('SELECT * FROM pipeline_releases ORDER BY created_at, release_id').all();
  db.close();
  const stableRelease = releaseFromRow(releases.find(row => row.release_id === stableReleaseId));
  const candidateRelease = releaseFromRow(releases.find(row => row.release_id === candidateReleaseId));
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { rmSync(`${seedPath}${suffix}`, { force: true }); } catch {}
  }
  const adapterIds = {
    turn: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
    life: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
  };
  const lanes = Object.fromEntries([
    ['stable_execution', fixtureLane('stable_execution', root, stableRelease.modelProfile)],
    ['candidate_execution', fixtureLane('candidate_execution', root, candidateRelease.modelProfile)],
    ['evaluator_primary', fixtureLane('evaluator_primary', root)],
    ['evaluator_secondary', fixtureLane('evaluator_secondary', root)],
  ]);
  const materials = {
    version: 1, sourceHead, runtimeConfig: { version: 1, presetDir: join(process.cwd(), 'yuqi-runtime', 'presets'), clock: 'runtime-clock-v1' },
    stableRelease, candidateRelease, lanes,
    stableRuntime: {
      version: 1, attestationVersion: 1, sourceHead, adapterIds,
      stableReleaseId: stableRelease.releaseId, candidateReleaseId: null,
    },
    candidateRuntime: {
      version: 1, attestationVersion: 1, sourceHead, adapterIds,
      stableReleaseId: stableRelease.releaseId, candidateReleaseId: candidateRelease.releaseId,
    },
    seedDatabasePath: `${PRIVATE}/seed.sqlite`,
    stableDatabasePath: `${PRIVATE}/stable.sqlite`,
    candidateDatabasePath: `${PRIVATE}/candidate.sqlite`,
    seedDatabaseSha256: sha256(readFileSync(join(root, PRIVATE, 'seed.sqlite'))),
  };
  const seedSize = readFileSync(join(root, PRIVATE, 'seed.sqlite')).byteLength;
  if (seedSize >= 20 * 1024 * 1024) throw new Error(`minimal quality seed unexpectedly large: ${seedSize}`);
  writeFileSync(join(root, PRIVATE, 'quality-production-config.json'), JSON.stringify(materials));
  if (dirty) writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
  return { root, plan, sourceHead, materials };
}

// A deterministic protocol peer for the production-wire test.  It returns
// parseable role objects (rather than the human-readable reply used by the
// generic fixture server), while still exercising the real CodexAppServer
// process, thread/session persistence, and turn lifecycle.
function writeProductionWireServer(root) {
  const path = join(root, PRIVATE, 'production-wire-server.mjs');
  writeFileSync(path, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const logFile = process.env.FAKE_APP_SERVER_LOG || '';
const stateFile = process.env.FAKE_APP_SERVER_STATE || '';
let threadCounter = 0; let turnCounter = 0;
const threads = new Map();
try {
  if (stateFile) {
    const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
    for (const [id, turns] of Object.entries(saved.threads || {})) threads.set(id, turns);
  }
} catch {}
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
const log = value => { if (logFile) appendFileSync(logFile, JSON.stringify(value) + '\\n', 'utf8'); };
const persist = () => { if (stateFile) writeFileSync(stateFile, JSON.stringify({ threads: Object.fromEntries(threads) })); };
function cognitionResult() {
  return { interactionRead: { surfaceAct: 'statement', primarySocialMeaning: 'conversation', alternativeMeaning: null, confidence: 0.86, evidenceMessageIds: [] }, selfResponse: { immediateFeeling: 'present', desire: 'stay in exchange', resistance: '', attention: 'the current turn', stanceTransitions: [] }, interactionDecision: { intendedResponse: 'send', relationshipEffect: 'continue', shouldAcknowledgeBid: true, intentionalNonResponseReason: null, motiveEvidenceIds: [], mustConvey: ['respond naturally'], mustNotClaim: [] }, actionIntent: { payment: null, moment: null, rolePlan: null, lifeAdjustment: null, relationshipReview: null }, statePatch: { mood: 'present', currentStances: [], openThreads: [] } };
}
function expressionResult() { return { action: 'send', reply: 'wire reply', usedFactIds: [], bubblePlan: [{ text: 'wire reply', purpose: 'continue exchange' }], incompatibility: null }; }
function outputFor(text, model) {
  let request = {}; try { request = JSON.parse(text); } catch {}
  if (request.task === 'understand_and_decide_v3') return { routeDecision: model === 'gpt-5.6-terra' ? 'deep' : 'fast', cognitionResult: cognitionResult() };
  if (request.task === 'reconsider_and_decide_v3' || request.task === 'reconsider_lived_quality_v3') return cognitionResult();
  if (request.expressionBrief || request.task === 'express_authorized_decision_v3' || request.task === 'rewrite_expression_for_lived_quality_v3') return expressionResult();
  if (request.task === 'plan_yuqi_life' || request.task === 'plan_yuqi_life_with_cognition') { const start = Number(request.planningWindow?.startAt || 0); return { action: 'skip', reply: '', usedFactIds: [], lifePlan: { planKey: request.planKey, episodes: [{ episodeId: String(request.planKey || 'wire') + '_episode', kind: 'rest', title: 'quiet', startAt: start, endAt: start + 8 * 60 * 60 * 1000 }] } }; }
  if (request.task === 'quality_supervise') return { decision: 'approve', reviewedIssueIds: [], resolvedIssueIds: [], issues: [] };
  if (request.task === 'review_yuqi_reply') return { decision: 'approve', issues: [] };
  if (request.task === 'reply_as_yuqi' || request.task === 'rewrite_as_yuqi') return expressionResult();
  return { query: 'wire', keywords: [], candidates: [] };
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('close', () => process.exit(0));
input.on('line', line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  log(message); if (message.id === undefined) return;
  if (message.method === 'initialize') { write({ id: message.id, result: { userAgent: 'quality-wire', codexHome: 'fixture', platformFamily: 'windows', platformOs: 'windows' } }); return; }
  if (message.method === 'thread/start') { const id = 'wire_thread_' + (++threadCounter); threads.set(id, []); persist(); write({ id: message.id, result: { thread: { id, status: { type: 'idle' } } } }); write({ method: 'thread/started', params: { thread: { id, status: { type: 'idle' } } } }); return; }
  if (message.method === 'thread/resume') { const id = message.params.threadId; if (!threads.has(id)) threads.set(id, []); persist(); write({ id: message.id, result: { thread: { id, status: { type: 'idle' } } } }); return; }
  if (message.method === 'thread/read') { const id = message.params.threadId; write({ id: message.id, result: { thread: { id, status: { type: 'idle' }, turns: message.params.includeTurns === true ? (threads.get(id) || []) : [] } } }); return; }
  if (message.method === 'turn/start') {
    const turnId = 'wire_turn_' + (++turnCounter); const threadId = message.params.threadId;
    const text = message.params.input?.find(item => item.type === 'text')?.text || '';
    const completed = { id: turnId, status: 'completed', error: null, items: [{ id: 'wire_user_' + turnId, type: 'userMessage', clientId: message.params.clientUserMessageId, content: [{ type: 'text', text }] }, { id: 'wire_item_' + turnId, type: 'agentMessage', text: JSON.stringify(outputFor(text, message.params.model)) }] };
    const turns = threads.get(threadId) || []; turns.push(completed); threads.set(threadId, turns); persist();
    if (process.env.FAKE_APP_SERVER_HOLD_RESPONSE !== '1') {
      write({ id: message.id, result: { turn: { id: turnId, status: 'inProgress', items: [], error: null } } });
    }
    if (process.env.FAKE_APP_SERVER_HOLD_AFTER_START === '1') return;
    write({ method: 'item/completed', params: { threadId, turnId, item: { id: 'wire_item_' + turnId, type: 'agentMessage', text: completed.items[1].text } } });
    write({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [], error: null } } });
    return;
  }
  if (message.method === 'turn/interrupt') { write({ id: message.id, result: {} }); return; }
  write({ id: message.id, error: { code: -32601, message: 'unknown method ' + message.method } });
});
`);
  return path;
}

function inputs(fixture, overrides = {}) {
  return {
    rootDir: fixture.root,
    ledgerPath: `${PRIVATE}/quality-replay-state.sqlite`,
    plan: fixture.plan,
    resumeRun: null,
    artifactPaths: {
      plan: `${PRIVATE}/quality-replay-plan.json`,
      ledger: `${PRIVATE}/quality-replay-state.sqlite`,
      raw: `${PRIVATE}/quality-replay.jsonl`,
    },
    ...overrides,
  };
}

function bridgeMaterialsFromFixture(fixture) {
  const manifest = JSON.parse(readFileSync(join(fixture.root, PRIVATE, 'quality-production-config.json'), 'utf8'));
  const allowedClientKeys = [
    'command', 'args', 'cwd', 'env', 'clientInfo', 'requestTimeoutMs', 'turnTimeoutMs',
    'maxRoleTurns', 'modelProfile', 'sessionNamespace', 'namespace', 'threadNamespace',
    'lane', 'sessionStorePath', 'approvalPolicy', 'sandbox', 'schema',
  ];
  const clientConfigs = Object.fromEntries(Object.entries(manifest.lanes).map(([name, lane]) => {
    const config = Object.fromEntries(allowedClientKeys
      .filter(key => Object.hasOwn(lane, key)).map(key => [key, lane[key]]));
    return [name, config];
  }));
  return {
    runtimeConfig: manifest.runtimeConfig,
    seedDatabasePath: join(fixture.root, manifest.seedDatabasePath),
    stableDatabasePath: join(fixture.root, manifest.stableDatabasePath),
    candidateDatabasePath: join(fixture.root, manifest.candidateDatabasePath),
    clientConfigs,
    clientConfigChecksums: Object.fromEntries(
      Object.entries(clientConfigs).map(([name, config]) => [name, contentHash(config)])
    ),
  };
}

test('production config creates a data-only four-lane run authority', () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture, { resumeRun: null }));
  assert.equal(authority.version, 1);
  assert.match(authority.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(authority.finalKeys.length, 246);
  assert.equal(authority.planChecksum, fixture.plan.planChecksum);
  assert.equal(authority.sourceHead, fixture.sourceHead);
  assert.deepEqual(authority.artifactPaths, {
    plan: `${PRIVATE}/quality-replay-plan.json`,
    ledger: `${PRIVATE}/quality-replay-state.sqlite`,
    raw: `${PRIVATE}/quality-replay.jsonl`,
  });
  assertQualityReplayRunAuthority(authority);
  assert.deepEqual(Object.keys(authority.inputArtifactChecksums).sort(), ['materials', 'plan', 'seedDatabase']);
  assert.throws(() => assertQualityReplayRunAuthority({ ...authority }), /branded|authority/i);
  assert.deepEqual(Object.keys(authority).sort(), [
    'artifactPaths', 'attestation', 'attestationChecksum', 'candidateRelease',
    'createdAt', 'evidenceEligible', 'finalKeys', 'inputArtifactChecksums', 'ledgerPath', 'planChecksum', 'runId',
    'stableRelease', 'sourceHead', 'version'
  ].sort());
  assert.equal(authority.evidenceEligible, true);
  assert.equal(authority.stableRelease.releaseId, fixture.materials.stableRelease.releaseId);
  assert.equal(authority.candidateRelease.releaseId, fixture.materials.candidateRelease.releaseId);
  assert.notEqual(authority.attestation.evaluatorPrimary.evaluatorId,
    authority.attestation.evaluatorSecondary.evaluatorId);
  assert.equal(Object.values(authority).some(value => value && typeof value === 'object' && typeof value.runTurn === 'function'), false);
});

test('bridge authority rejects a self-consistent final-key substitution against the frozen plan', () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const descriptor = {
    ...authority,
    finalKeys: [...authority.finalKeys.slice(0, -1), 'attacker:substituted-final:0'],
  };
  assert.throws(() => createQualityProductionExecutionAuthority({
    descriptor,
    materials: bridgeMaterialsFromFixture(fixture),
    sourceRootDir: fixture.root,
  }), /plan|final|authority|identity/i);
  const originalDescriptor = { ...authority };
  const directMaterials = bridgeMaterialsFromFixture(fixture);
  for (const [label, path] of [
    ['plan', join(fixture.root, PRIVATE, 'quality-replay-plan.json')],
    ['materials', join(fixture.root, PRIVATE, 'quality-production-config.json')],
    ['seed', join(fixture.root, PRIVATE, 'seed.sqlite')],
  ]) {
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from(`\n${label}`)]));
      assert.throws(() => createQualityProductionExecutionAuthority({
        descriptor: originalDescriptor,
        materials: directMaterials,
        sourceRootDir: fixture.root,
      }), /input|plan|materials|seed|authority|checksum/i);
    } finally {
      writeFileSync(path, original);
    }
  }
  assert.equal(existsSync(join(fixture.root, PRIVATE, 'quality-replay-state.sqlite')), false);
});

test('production config rejects injections and dirty source before ledger creation', () => {
  const fixture = createGitFixture({ dirty: true });
  const ledger = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture, {
    runtime: {}, client: {}, store: {}, slot: {}, callback() {},
  })), /option|dirty|source/i);
  assert.equal(existsSync(ledger), false);
});

test('production config rejects artifact escape, duplicate paths, and plan byte drift', () => {
  const fixture = createGitFixture();
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture, {
    artifactPaths: { plan: '../plan.json', ledger: join(PRIVATE, 'state.sqlite'), raw: join(PRIVATE, 'raw.jsonl') }
  })), /artifact|path|private/i);
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture, {
    artifactPaths: { plan: join(PRIVATE, 'same'), ledger: join(PRIVATE, 'same'), raw: join(PRIVATE, 'raw') }
  })), /artifact|distinct|path/i);
  writeFileSync(join(fixture.root, PRIVATE, 'quality-replay-plan.json'), `${JSON.stringify({ ...fixture.plan, planChecksum: 'b'.repeat(64) })}\n`);
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture)), /plan|checksum|artifact/i);
  writeFileSync(join(fixture.root, PRIVATE, 'quality-replay-plan.json'), JSON.stringify(fixture.plan));
  const fixedManifest = join(fixture.root, PRIVATE, 'quality-production-config.json');
  const manifestBytes = readFileSync(fixedManifest);
  unlinkSync(fixedManifest);
  writeFileSync(join(fixture.root, PRIVATE, 'quality-production-materials.json'), manifestBytes);
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture)), /material|manifest/i);
});

test('production new and resume gates reject a private ancestor junction', t => {
  const fixture = createGitFixture();
  const outside = mkdtempSync(join(tmpdir(), 'yuqi-quality-junction-target-'));
  const link = join(fixture.root, PRIVATE, 'ancestor-junction');
  try {
    try { symlinkSync(outside, link, 'junction'); }
    catch (error) { t.skip(`junction creation unavailable: ${error?.code || error?.message || String(error)}`); return; }
    const artifactPaths = {
      plan: `${PRIVATE}/ancestor-junction/quality-replay-plan.json`,
      ledger: `${PRIVATE}/quality-replay-state.sqlite`, raw: `${PRIVATE}/quality-replay.jsonl`,
    };
    assert.throws(() => createQualityReplayRunAuthority(inputs(fixture, { artifactPaths })), /link|symlink|junction|private|path/i);
    const normal = createQualityReplayRunAuthority(inputs(fixture));
    assert.throws(() => createQualityReplayRunAuthority(inputs(fixture, {
      resumeRun: normal.runId, artifactPaths,
    })), /link|symlink|junction|private|path/i);
  } finally {
    rmSync(link, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('production ledger opener rechecks post-attestation bytes and rejects a replaced ancestor', () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  ledger.createOrOpenRun(header);
  ledger.close();
  const beforeLedger = sha256(readFileSync(ledgerPath));
  const driftCases = [
    ['plan', join(fixture.root, PRIVATE, 'quality-replay-plan.json')],
    ['materials', join(fixture.root, PRIVATE, 'quality-production-config.json')],
    ['seed', join(fixture.root, PRIVATE, 'seed.sqlite')],
  ];
  for (const [label, path] of driftCases) {
    const original = readFileSync(path);
    try {
      writeFileSync(path, Buffer.concat([original, Buffer.from(`\npost-attestation-${label}`)]));
      assert.throws(() => openProductionQualityReplayLedger({
        filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
      }), /drift|authority|JSON|database/i);
      assert.equal(sha256(readFileSync(ledgerPath)), beforeLedger);
    } finally {
      writeFileSync(path, original);
    }
  }

  const outside = mkdtempSync(join(tmpdir(), 'yuqi-quality-ledger-junction-target-'));
  const nested = join(fixture.root, PRIVATE, 'ledger-ancestor');
  try {
    const nestedInputs = inputs(fixture, {
      ledgerPath: `${PRIVATE}/ledger-ancestor/quality-replay-state.sqlite`,
      artifactPaths: {
        plan: `${PRIVATE}/quality-replay-plan.json`,
        ledger: `${PRIVATE}/ledger-ancestor/quality-replay-state.sqlite`,
        raw: `${PRIVATE}/quality-replay.jsonl`,
      },
    });
    const nestedAuthority = createQualityReplayRunAuthority(nestedInputs);
    symlinkSync(outside, nested, 'junction');
    assert.throws(() => openProductionQualityReplayLedger({
      filename: `${PRIVATE}/ledger-ancestor/quality-replay-state.sqlite`,
      runAuthority: nestedAuthority, sourceRootDir: fixture.root,
    }), /path|junction|symlink|reparse|authority/i);
  } finally {
    rmSync(nested, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('production ledger close and reopen retains prepared, starting, running, failed, and blocked states', () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const startedAt = Date.now();
  const finalKey = authority.finalKeys[0];
  const base = {
    runId: authority.runId, finalKey, subjectChecksum: '1'.repeat(64),
    authorityInputChecksum: '2'.repeat(64),
    input: { subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64) },
    now: startedAt,
  };
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  let ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  ledger.createOrOpenRun(header);
  ledger.preparePhase({ ...base, phase: 'stable_execution' });
  ledger.startPhase({ ...base, phase: 'stable_execution' }, { now: startedAt + 1 });
  ledger.close();
  ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  ledger.resetStartingPhase({ ...base, phase: 'stable_execution' }, { now: startedAt + 2 });
  ledger.close();
  ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    readOnly: true,
  });
  assert.equal(ledger.getPhase({ ...base, phase: 'stable_execution' }).state, 'prepared');
  ledger.close();

  ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  ledger.startPhase({ ...base, phase: 'stable_execution' }, { now: startedAt + 3 });
  ledger.markPhaseRunning({ ...base, phase: 'stable_execution' }, { now: startedAt + 4 });
  const callScope = {
    runId: authority.runId, finalKey, phase: 'stable_execution', ordinal: 0,
  };
  const requestBasis = {
    input: JSON.stringify({ task: 'production_recovery_probe' }),
    model: 'gpt-5.6-sol', effort: 'high', outputSchema: ROLE_OUTPUT_SCHEMAS.memory,
    localImagePaths: [],
  };
  const call = {
    ...callScope, role: 'memory', threadId: 'thread-production-recovery',
    baseline: { id: 'thread-production-recovery', turns: [] },
    request: { ...requestBasis,
      clientUserMessageId: qualityClientUserMessageId(callScope, requestBasis) },
    now: startedAt + 5,
  };
  assert.equal(ledger.claimModelCallStart(call).claimed, true);
  ledger.close();
  ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  assert.equal(ledger.claimModelCallStart(call).claimed, false);
  ledger.markModelCallRunning(call, { turnId: 'turn-production-recovery', now: startedAt + 6 });
  ledger.failModelCall(call, {
    error: { code: 'PRODUCTION_RECOVERY_FAILURE' }, now: startedAt + 7,
  });
  ledger.finishPhase({ ...base, phase: 'stable_execution' }, {
    state: 'failed', now: startedAt + 8,
    error: { code: 'PRODUCTION_TEST_FAILURE', message: 'production test terminal failure' },
  });
  ledger.preparePhase({ ...base, phase: 'candidate_execution', now: startedAt + 1_000 });
  ledger.startPhase({ ...base, phase: 'candidate_execution', now: startedAt + 1_001 }, { now: startedAt + 1_001 });
  ledger.markPhaseRunning({ ...base, phase: 'candidate_execution' }, { now: startedAt + 1_002 });
  ledger.finishPhase({ ...base, phase: 'candidate_execution' }, {
    state: 'uncertain', now: startedAt + 1_003,
    error: { code: 'PRODUCTION_TEST_UNCERTAIN', message: 'production test uncertain recovery' },
  });
  ledger.close();

  ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    readOnly: true,
  });
  assert.equal(ledger.getPhase({ ...base, phase: 'stable_execution' }).state, 'failed');
  assert.equal(ledger.getPhase({ ...base, phase: 'candidate_execution' }).state, 'uncertain');
  assert.equal(ledger.getRun({ runId: authority.runId }).state, 'blocked');
  ledger.close();
});

test('production materials accept only the fixed manifest filename', () => {
  const fixture = createGitFixture();
  const fixed = join(fixture.root, PRIVATE, 'quality-production-config.json');
  const bytes = readFileSync(fixed);
  unlinkSync(fixed);
  writeFileSync(join(fixture.root, PRIVATE, 'quality-production-materials.json'), bytes);
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture)), /material|manifest/i);
});

test('production context rereads plan/material/seed bytes before opening clone stores', async () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const config = qualityRunAuthorityProductionConfig(authority);
  const seedPath = join(fixture.root, PRIVATE, 'seed.sqlite');
  const planPath = join(fixture.root, PRIVATE, 'quality-replay-plan.json');
  const materialsPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
  const immutableInputs = [planPath, materialsPath, seedPath]
    .map(path => [path, readFileSync(path)]);
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  try {
    for (const [label, path] of [
      ['plan', planPath], ['materials', materialsPath], ['seed', seedPath],
    ]) {
      const original = immutableInputs.find(([candidate]) => candidate === path)[1];
      writeFileSync(path, Buffer.concat([original, Buffer.from(`drift-${label}`)]));
      await assert.rejects(
        () => prepareQualityProductionSubject(config, {
          item: fixture.plan.items[0], finalKey: authority.finalKeys[0], ordinal: 0, ledger,
        }),
        /input artifact drift|authority/i,
      );
      writeFileSync(path, original);
    }
    const stem = `${seedPath}.quality-${contentHash({ runId: authority.runId, finalKey: authority.finalKeys[0] }).slice(0, 24)}`;
    assert.equal(existsSync(`${stem}.stable.sqlite`), false);
  } finally {
    for (const [path, bytes] of immutableInputs) writeFileSync(path, bytes);
    ledger.close();
  }
});

test('an existing ledger cannot be treated as a new run', () => {
  const fixture = createGitFixture();
  writeFileSync(join(fixture.root, PRIVATE, 'quality-replay-state.sqlite'), 'not-a-sqlite-ledger');
  assert.throws(() => createQualityReplayRunAuthority(inputs(fixture)), /resume|ledger|database/i);
});

test('production exporter checks relative and absolute identity before unfinished export', () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  ledger.createOrOpenRun(header);
  ledger.close();
  const artifactPath = join(fixture.root, PRIVATE, 'relative-path-export.jsonl');
  const relativeLedger = `${PRIVATE}/quality-replay-state.sqlite`;
  const invoke = value => {
    try {
      exportQualityReplayV2({
        sourceRootDir: fixture.root, ledgerPath: value, runAuthority: authority,
        runId: authority.runId, artifactPath,
      });
      throw new Error('expected export to reject unfinished run');
    } catch (error) { return error; }
  };
  const relativeError = invoke(relativeLedger);
  assert.doesNotMatch(relativeError.message, /ledger authority conflict/i);
  const absoluteError = invoke(ledgerPath);
  assert.doesNotMatch(absoluteError.message, /ledger authority conflict/i);
  for (const value of [`${PRIVATE}/other.sqlite`, '../outside.sqlite']) {
    assert.throws(() => exportQualityReplayV2({
      sourceRootDir: fixture.root, ledgerPath: value, runAuthority: authority,
      runId: authority.runId, artifactPath,
    }), /ledger authority|path/i);
  }
  assert.equal(existsSync(artifactPath), false);
});

test('production evaluators use independent real brain runTurn wires and persist each request binding', async () => {
  const fixture = createGitFixture();
  const fakeServer = join(process.cwd(), 'yuqi-runtime', 'test', 'fixtures', 'fake-app-server.mjs');
  const logPath = join(fixture.root, PRIVATE, 'evaluator-primary.log');
  const manifestPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
  const materials = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const laneName of ['evaluator_primary', 'evaluator_secondary']) {
    materials.lanes[laneName].command = process.execPath;
    materials.lanes[laneName].args = [fakeServer];
    materials.lanes[laneName].cwd = fixture.root;
    materials.lanes[laneName].env = { FAKE_APP_SERVER_LOG: logPath };
  }
  writeFileSync(manifestPath, JSON.stringify(materials));
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const config = qualityRunAuthorityProductionConfig(authority);
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const evaluatorPrimaryPath = join(fixture.root, PRIVATE, 'evaluator-primary-session.sqlite');
  const evaluatorSecondaryPath = join(fixture.root, PRIVATE, 'evaluator-secondary-session.sqlite');
  copyFileSync(join(fixture.root, PRIVATE, 'seed.sqlite'), evaluatorPrimaryPath);
  copyFileSync(join(fixture.root, PRIVATE, 'seed.sqlite'), evaluatorSecondaryPath);
  const evaluatorPrimaryStore = new YuqiStore(evaluatorPrimaryPath);
  const evaluatorSecondaryStore = new YuqiStore(evaluatorSecondaryPath);
  evaluatorPrimaryStore.setSession('brain', 'thr_evaluator_primary');
  evaluatorSecondaryStore.setSession('brain', 'thr_evaluator_secondary');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  const finalKey = authority.finalKeys[0];
  const phaseInput = {
    runId: authority.runId, finalKey, phase: 'evaluator_primary',
    subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64),
    input: { subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64) },
    now: Date.now(),
  };
  const phaseStart = phaseInput.now;
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  ledger.createOrOpenRun(header);
  ledger.preparePhase(phaseInput);
  ledger.startPhase(phaseInput, { now: phaseStart + 1 });
  ledger.markPhaseRunning(phaseInput, { now: phaseStart + 2 });
  try {
    const result = await executeQualityEvaluatorSide(config, {
      side: 'primary', input: JSON.stringify({ finalKey, side: 'primary' }),
      phaseInput, ledger, evaluatorStore: evaluatorPrimaryStore,
    });
    assert.equal(typeof result?.text, 'string');
    ledger.succeedPhase(phaseInput, { output: result, now: Date.now() + 1000 });
    const primaryWireCount = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
      .map(line => JSON.parse(line)).filter(message => message.method === 'turn/start').length;
    const originalPrimaryCommand = materials.lanes.evaluator_primary.command;
    materials.lanes.evaluator_primary.command = join(fixture.root, PRIVATE, 'missing-client-after-success');
    const replayed = await executeQualityEvaluatorSide(config, {
      side: 'primary', input: JSON.stringify({ finalKey, side: 'primary' }),
      phaseInput, ledger, evaluatorStore: evaluatorPrimaryStore,
    });
    assert.deepEqual(replayed, result);
    const replayWireCount = readFileSync(logPath, 'utf8').trim().split(/\r?\n/)
      .map(line => JSON.parse(line)).filter(message => message.method === 'turn/start').length;
    assert.equal(replayWireCount, primaryWireCount);
    materials.lanes.evaluator_primary.command = originalPrimaryCommand;
    const secondaryPhaseInput = {
      ...phaseInput,
      phase: 'evaluator_secondary',
      now: phaseStart + 3,
    };
    ledger.preparePhase(secondaryPhaseInput);
    ledger.startPhase(secondaryPhaseInput, { now: phaseStart + 4 });
    ledger.markPhaseRunning(secondaryPhaseInput, { now: phaseStart + 5 });
    const secondaryResult = await executeQualityEvaluatorSide(config, {
      side: 'secondary', input: JSON.stringify({ finalKey, side: 'secondary' }),
      phaseInput: secondaryPhaseInput, ledger, evaluatorStore: evaluatorSecondaryStore,
    });
    assert.equal(typeof secondaryResult?.text, 'string');
    const call = ledger.getModelCall({
      runId: authority.runId, finalKey, phase: 'evaluator_primary', ordinal: 0,
    });
    assert.equal(call.role, 'brain');
    assert.equal(call.request.model, 'gpt-5.6-sol');
    assert.equal(call.request.effort, 'medium');
    assert.deepEqual(call.request.outputSchema?.required, [
      'version', 'scores', 'preference', 'findings', 'unresolved',
    ]);
    assert.match(call.schemaChecksum, /^[a-f0-9]{64}$/);
    const secondaryCall = ledger.getModelCall({
      runId: authority.runId, finalKey, phase: 'evaluator_secondary', ordinal: 0,
    });
    assert.equal(secondaryCall.role, 'brain');
    assert.equal(secondaryCall.request.model, 'gpt-5.6-terra');
    assert.equal(secondaryCall.request.effort, 'high');
    assert.notEqual(call.request.model, secondaryCall.request.model);
    assert.notEqual(call.request.effort, secondaryCall.request.effort);
    assert.notEqual(call.clientUserMessageId, secondaryCall.clientUserMessageId);
    assert.notEqual(materials.lanes.evaluator_primary.sessionNamespace,
      materials.lanes.evaluator_secondary.sessionNamespace);
    assert.notEqual(materials.lanes.evaluator_primary.sessionStorePath,
      materials.lanes.evaluator_secondary.sessionStorePath);
    const wire = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const turnStarts = wire.filter(message => message.method === 'turn/start');
    assert.equal(turnStarts.length, 2);
    assert.notEqual(turnStarts[0].params.model, turnStarts[1].params.model);
    assert.notEqual(turnStarts[0].params.effort, turnStarts[1].params.effort);
    assert.notEqual(turnStarts[0].params.threadId, turnStarts[1].params.threadId);
  } finally {
    ledger.close();
    evaluatorPrimaryStore.close();
    evaluatorSecondaryStore.close();
  }
});

test('branded production evaluator recovery reads the persisted remote turn across close and reopen', { timeout: 120_000 }, async () => {
  for (const [mode, finalIndex] of [['starting', 1], ['running', 2]]) {
    const fixture = createGitFixture();
    const fakeServer = writeProductionWireServer(fixture.root);
    const logPath = join(fixture.root, PRIVATE, `recovery-${mode}.log`);
    const statePath = join(fixture.root, PRIVATE, `recovery-${mode}.json`);
    const manifestPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
    const materials = JSON.parse(readFileSync(manifestPath, 'utf8'));
    materials.lanes.evaluator_primary.command = process.execPath;
    materials.lanes.evaluator_primary.args = [fakeServer];
    materials.lanes.evaluator_primary.cwd = fixture.root;
    materials.lanes.evaluator_primary.env = {
      FAKE_APP_SERVER_LOG: logPath,
      FAKE_APP_SERVER_STATE: statePath,
      ...(mode === 'starting' ? { FAKE_APP_SERVER_HOLD_RESPONSE: '1' } : { FAKE_APP_SERVER_HOLD_AFTER_START: '1' }),
    };
    writeFileSync(manifestPath, JSON.stringify(materials));
    const authority = createQualityReplayRunAuthority(inputs(fixture));
    const config = qualityRunAuthorityProductionConfig(authority);
    const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
    const ledger = openProductionQualityReplayLedger({
      filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    });
    const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
    ledger.createOrOpenRun(header);
    const finalKey = authority.finalKeys[finalIndex];
    const phasePath = join(fixture.root, PRIVATE, `recovery-${mode}-phase.json`);
    const childSource = `
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { createQualityReplayRunAuthority } from './scripts/yuqi-quality-production-execution-config.mjs';
      import { qualityRunAuthorityProductionConfig, prepareQualityProductionSubject, executeQualityEvaluatorSide } from './yuqi-runtime/src/quality-replay-production-bridge.mjs';
      import { openProductionQualityReplayLedger } from './yuqi-runtime/src/quality-replay-ledger.mjs';
      const root = process.env.QRP_ROOT;
      const privateRoot = 'artifacts/yuqi-lived-agency-v3/private';
      const plan = JSON.parse(readFileSync(join(root, privateRoot, 'quality-replay-plan.json'), 'utf8'));
      const authority = createQualityReplayRunAuthority({
        rootDir: root, ledgerPath: privateRoot + '/quality-replay-state.sqlite', plan,
        resumeRun: process.env.QRP_RUN_ID,
        artifactPaths: {
          plan: privateRoot + '/quality-replay-plan.json', ledger: privateRoot + '/quality-replay-state.sqlite',
          raw: privateRoot + '/quality-replay.jsonl',
        },
      });
      const config = qualityRunAuthorityProductionConfig(authority);
      const ledger = openProductionQualityReplayLedger({
        filename: join(root, privateRoot, 'quality-replay-state.sqlite'), runAuthority: authority, sourceRootDir: root,
      });
      const context = await prepareQualityProductionSubject(config, {
        item: plan.items[Number(process.env.QRP_FINAL_INDEX)], finalKey: process.env.QRP_FINAL_KEY, ordinal: Number(process.env.QRP_FINAL_INDEX), ledger,
      });
      const subjectChecksum = context.subject.semanticInputChecksum;
      const inputText = JSON.stringify({ task: 'quality_recovery_probe', finalKey: process.env.QRP_FINAL_KEY });
      const phaseInput = {
        runId: authority.runId, finalKey: process.env.QRP_FINAL_KEY, phase: 'evaluator_primary',
        subjectChecksum, authorityInputChecksum: context.prepared.execution.inputChecksum,
        input: { subjectChecksum, authorityInputChecksum: context.prepared.execution.inputChecksum }, now: Date.now(),
      };
      ledger.preparePhase(phaseInput);
      ledger.startPhase(phaseInput, { now: phaseInput.now + 1 });
      ledger.markPhaseRunning(phaseInput, { now: phaseInput.now + 2 });
      writeFileSync(process.env.QRP_PHASE_PATH, JSON.stringify({ phaseInput, inputText }));
      if (process.env.QRP_MODE === 'starting') setTimeout(() => process.exit(98), 5000);
      await executeQualityEvaluatorSide(config, {
        side: 'primary', input: inputText, phaseInput, ledger,
        evaluatorStore: context.evaluatorStores.primary,
        options: { onTurnStarted: async () => process.exit(98) },
      });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env, QRP_ROOT: fixture.root, QRP_RUN_ID: authority.runId,
        QRP_FINAL_KEY: finalKey, QRP_FINAL_INDEX: String(finalIndex), QRP_MODE: mode,
        QRP_PHASE_PATH: phasePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exitCode = await new Promise((resolveCode, reject) => {
      child.once('error', reject);
      child.once('close', resolveCode);
    });
    assert.equal(exitCode, 98, `${mode} recovery child must stop after claim: ${stderr}`);
    ledger.close();

    const persisted = JSON.parse(readFileSync(phasePath, 'utf8'));
    const evaluatorPath = `${join(fixture.root, fixture.materials.seedDatabasePath)}.quality-${contentHash({ runId: authority.runId, finalKey }).slice(0, 24)}.stable.sqlite.evaluator-primary.sqlite`;
    const evaluatorStore = new YuqiStore(evaluatorPath);
    const reopenedLedger = openProductionQualityReplayLedger({
      filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    });
    try {
      const startsBefore = existsSync(logPath)
        ? readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.method === 'turn/start').length
        : 0;
      const recovered = await executeQualityEvaluatorSide(config, {
        side: 'primary', input: persisted.inputText, phaseInput: persisted.phaseInput,
        ledger: reopenedLedger, evaluatorStore,
      });
      const startsAfter = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.method === 'turn/start').length;
      assert.equal(startsBefore, 1);
      assert.equal(startsAfter, startsBefore, `${mode} recovery must not replace the remote turn`);
      assert.equal(recovered.status, 'completed');
      assert.equal(reopenedLedger.getModelCall({
        runId: authority.runId, finalKey, phase: 'evaluator_primary', ordinal: 0,
      }).state, 'succeeded');
      reopenedLedger.succeedPhase(persisted.phaseInput, { output: recovered, now: Date.now() + 2 });
      const replay = await executeQualityEvaluatorSide(config, {
        side: 'primary', input: persisted.inputText, phaseInput: persisted.phaseInput,
        ledger: reopenedLedger, evaluatorStore,
      });
      assert.deepEqual(replay, recovered);
      const startsReplay = readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).filter(row => row.method === 'turn/start').length;
      assert.equal(startsReplay, startsBefore, `${mode} succeeded replay must not construct a replacement turn`);
    } finally {
      evaluatorStore.close();
      reopenedLedger.close();
    }
  }
});

test('branded production bridge reopens prepared and starting-zero without creating a model request', async () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const config = qualityRunAuthorityProductionConfig(authority);
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  ledger.createOrOpenRun(header);
  const finalKey = authority.finalKeys[0];
  const item = fixture.plan.items[0];
  let context = null;
  let reopenedContext = null;
  try {
    context = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger });
    const phaseInput = {
      runId: authority.runId, finalKey, phase: 'stable_execution',
      subjectChecksum: context.subject.semanticInputChecksum,
      authorityInputChecksum: context.prepared.execution.inputChecksum,
      input: {
        subjectChecksum: context.subject.semanticInputChecksum,
        authorityInputChecksum: context.prepared.execution.inputChecksum,
      }, now: Date.now(),
    };
    ledger.preparePhase(phaseInput);
    ledger.startPhase(phaseInput, { now: phaseInput.now + 1 });
    assert.equal(ledger.getPhase(phaseInput).state, 'starting');
    await context.closeAsync();
    context = null;
    ledger.close();

    const resumed = openProductionQualityReplayLedger({
      filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    });
    try {
      assert.equal(resumed.getPhase(phaseInput).state, 'starting');
      resumed.resetStartingPhase(phaseInput, { now: phaseInput.now + 2 });
      assert.equal(resumed.getPhase(phaseInput).state, 'prepared');
      reopenedContext = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger: resumed });
      await reopenedContext.closeAsync();
      reopenedContext = null;
    } finally {
      resumed.close();
    }
  } finally {
    if (context) await context.closeAsync();
    if (reopenedContext) await reopenedContext.closeAsync();
    try { ledger.close(); } catch {}
  }
});

test('production failed and uncertain evaluator phases replay without constructing a client', async () => {
  for (const terminal of ['failed', 'uncertain']) {
    const fixture = createGitFixture();
    const manifestPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
    const materials = JSON.parse(readFileSync(manifestPath, 'utf8'));
    materials.lanes.evaluator_primary.command = join(fixture.root, PRIVATE, 'client-must-not-start');
    writeFileSync(manifestPath, JSON.stringify(materials));
    const authority = createQualityReplayRunAuthority(inputs(fixture));
    const config = qualityRunAuthorityProductionConfig(authority);
    const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
    const ledger = openProductionQualityReplayLedger({
      filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    });
    const finalKey = authority.finalKeys[0];
    const phaseInput = {
      runId: authority.runId, finalKey, phase: 'evaluator_primary',
      subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64),
      input: { subjectChecksum: '1'.repeat(64), authorityInputChecksum: '2'.repeat(64) },
      now: Date.now(),
    };
    const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
    ledger.createOrOpenRun(header);
    ledger.preparePhase(phaseInput);
    ledger.startPhase(phaseInput, { now: phaseInput.now + 1 });
    ledger.markPhaseRunning(phaseInput, { now: phaseInput.now + 2 });
    if (terminal === 'failed') {
      ledger.failPhase(phaseInput, { error: { code: 'TEST_FAILURE' }, now: phaseInput.now + 3 });
    } else {
      ledger.markPhaseUncertain(phaseInput, { reason: { code: 'TEST_UNCERTAIN' }, now: phaseInput.now + 3 });
    }
    try {
      await assert.rejects(
        () => executeQualityEvaluatorSide(config, {
          side: 'primary', input: JSON.stringify({ finalKey, terminal }), phaseInput, ledger,
        }),
        /terminal|replay/i,
      );
      assert.equal(existsSync(join(fixture.root, PRIVATE, 'client-must-not-start')), false);
    } finally { ledger.close(); }
  }
});

test('production publisher exposes no process fault seam', async () => {
  const bridge = await import('../src/quality-replay-production-bridge.mjs');
  assert.equal(Object.hasOwn(bridge, 'setQualityProductionPublishFaultForTest'), false);
  const source = readFileSync(resolve('yuqi-runtime/src/quality-replay-production-bridge.mjs'), 'utf8');
  assert.doesNotMatch(source, /setQualityProductionPublishFaultForTest|QUALITY_PUBLISH_FAULT|process\.exit/);
});

test('branded stable and candidate production contexts use real release-profile wire requests', async () => {
  const fixture = createGitFixture();
  const fakeServer = writeProductionWireServer(fixture.root);
  const logPath = join(fixture.root, PRIVATE, 'execution-wires.log');
  const manifestPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
  const materials = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const laneName of ['stable_execution', 'candidate_execution']) {
    materials.lanes[laneName].command = process.execPath;
    materials.lanes[laneName].args = [fakeServer];
    materials.lanes[laneName].cwd = fixture.root;
    materials.lanes[laneName].env = { FAKE_APP_SERVER_LOG: logPath };
  }
  writeFileSync(manifestPath, JSON.stringify(materials));
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const config = qualityRunAuthorityProductionConfig(authority);
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  let context = null;
  const finalKey = authority.finalKeys[0];
  const item = fixture.plan.items[0];
  const phaseStart = Date.now();
  try {
    const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
    ledger.createOrOpenRun(header);
    context = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger });
    const subjectChecksum = context.subject.semanticInputChecksum;
    const phaseInput = {
      runId: authority.runId, finalKey, phase: 'stable_execution',
      subjectChecksum, authorityInputChecksum: context.prepared.execution.inputChecksum,
      input: { subjectChecksum, authorityInputChecksum: context.prepared.execution.inputChecksum },
      now: phaseStart,
    };
    ledger.preparePhase(phaseInput);
    ledger.startPhase(phaseInput, { now: phaseStart + 1 });
    ledger.markPhaseRunning(phaseInput, { now: phaseStart + 2 });
    bindQualityProductionPhase(context, phaseInput);
    const stable = await executeQualitySubjectSide(context, context.subject, {
      side: 'stable', phaseClientSlot: context.config.stablePhaseClientSlot,
    });
    assert.ok(stable);
    const candidatePhaseInput = {
      ...phaseInput,
      phase: 'candidate_execution',
      authorityInputChecksum: context.prepared.candidateExecution.inputChecksum,
      input: { subjectChecksum, authorityInputChecksum: context.prepared.candidateExecution.inputChecksum },
      now: phaseStart + 3,
    };
    ledger.preparePhase(candidatePhaseInput);
    ledger.startPhase(candidatePhaseInput, { now: phaseStart + 4 });
    ledger.markPhaseRunning(candidatePhaseInput, { now: phaseStart + 5 });
    bindQualityProductionPhase(context, candidatePhaseInput);
    await context.config.candidatePhaseClientSlot.runTurn('supervisor', JSON.stringify({ task: 'quality_supervise' }), {
      outputSchema: ROLE_OUTPUT_SCHEMAS.supervisor,
      model: 'gpt-5.6-sol', effort: 'high',
    });
    const candidate = await executeQualitySubjectSide(context, context.subject, {
      side: 'candidate', phaseClientSlot: context.config.candidatePhaseClientSlot,
    });
    assert.ok(candidate);
    const wires = readFileSync(logPath, 'utf8').trim().split(/\r?\n/).map(line => JSON.parse(line));
    const turnStarts = wires.filter(message => message.method === 'turn/start');
    const taskFor = message => JSON.parse(message.params.input.find(item => item.type === 'text').text).task;
    const tasks = turnStarts.map(taskFor);
    assert.equal(turnStarts.length, 6);
    assert.equal(tasks.filter(task => task === 'understand_and_decide_v3').length, 2);
    assert.equal(tasks.filter(task => task === 'reconsider_and_decide_v3').length, 1);
    assert.equal(tasks.filter(task => task === 'express_authorized_decision_v3').length, 2);
    assert.equal(tasks.filter(task => task === 'quality_supervise').length, 1);
    assert.equal(turnStarts.filter(message => message.params.model === 'gpt-5.6-sol').length, 3);
    assert.equal(turnStarts.filter(message => message.params.model === 'gpt-5.6-terra').length, 3);
    assert.equal(turnStarts.filter(message => message.params.effort === 'high').length, 2);
    assert.ok(turnStarts.every(message => message.params.model && message.params.effort));
    const stableCall = ledger.getModelCall({ runId: authority.runId, finalKey, phase: 'stable_execution', ordinal: 0 });
    const candidateCall = ledger.getModelCall({ runId: authority.runId, finalKey, phase: 'candidate_execution', ordinal: 0 });
    assert.ok(turnStarts.some(message => message.params.model === stableCall.request.model));
    assert.ok(turnStarts.some(message => message.params.model === candidateCall.request.model));
    assert.match(stableCall.schemaChecksum, /^[a-f0-9]{64}$/);
    assert.match(candidateCall.schemaChecksum, /^[a-f0-9]{64}$/);
    const candidateCalls = ledger.listModelCalls({ runId: authority.runId, finalKey, phase: 'candidate_execution' });
    assert.equal(candidateCalls.length, 4);
    const supervisorCall = candidateCalls.find(call => JSON.parse(call.request.input).task === 'quality_supervise');
    assert.equal(contentHash(supervisorCall.request.outputSchema), contentHash(ROLE_OUTPUT_SCHEMAS.supervisor));
  } finally {
    try {
      if (context?.closeAsync) await context.closeAsync();
      else context?.close?.();
    } finally { ledger.close(); }
  }
});

test('branded production publication reopens all five stores and rejects per-lane drift', async () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const config = qualityRunAuthorityProductionConfig(authority);
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  ledger.createOrOpenRun(header);
  let context = null;
  const item = fixture.plan.items[0];
  const finalKey = authority.finalKeys[0];
  const replaceManifest = (path, value) => {
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare('DELETE FROM quality_production_store_manifest').run();
      db.prepare('INSERT INTO quality_production_store_manifest(manifest_id,manifest_json,manifest_checksum) VALUES (?,?,?)')
        .run('quality-store-manifest-v1', JSON.stringify(value), contentHash(value));
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally { db.close(); }
  };
  try {
    const seedDatabasePath = join(fixture.root, fixture.materials.seedDatabasePath);
    const stem = `${seedDatabasePath}.quality-${contentHash({
      runId: authority.runId, finalKey,
    }).slice(0, 24)}`;
    const stablePath = `${stem}.stable.sqlite`;
    const deterministicStores = [
      `${stablePath}.seed-working.sqlite`,
      stablePath,
      `${stem}.candidate.sqlite`,
      `${stablePath}.evaluator-primary.sqlite`,
      `${stablePath}.evaluator-secondary.sqlite`,
    ];
    for (const foreignPath of deterministicStores) {
      writeFileSync(foreignPath, Buffer.from('foreign non-sqlite final'));
      const foreignBytes = readFileSync(foreignPath);
      await assert.rejects(
        () => prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger }),
        /database|manifest|authority|SQLite|quality/i,
      );
      assert.deepEqual(readFileSync(foreignPath), foreignBytes);
      rmSync(foreignPath, { force: true });
    }
    context = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger });
    const expected = structuredClone(context.expectedStoreManifests);
    assert.equal(Object.keys(expected).length, 5);
    await context.closeAsync();
    context = null;
    const expectPreparationReject = async (pattern = /manifest|authority|drift|sidecar/i) => {
      let unexpectedContext = null;
      await assert.rejects(async () => {
        unexpectedContext = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger });
      }, pattern);
      if (unexpectedContext) await unexpectedContext.closeAsync();
    };
    for (const [path, manifest] of Object.entries(expected)) {
      assert.deepEqual(readQualityProductionStoreManifest(path), manifest);

      replaceManifest(path, { ...manifest, sourceHead: 'b'.repeat(40) });
      await expectPreparationReject();
      replaceManifest(path, manifest);

      replaceManifest(path, { ...manifest, runId: 'foreign-run' });
      await expectPreparationReject();
      replaceManifest(path, manifest);

      replaceManifest(path, { ...manifest, materialsChecksum: 'c'.repeat(64) });
      await expectPreparationReject();
      replaceManifest(path, manifest);

      const extraDb = new DatabaseSync(path);
      try {
        extraDb.exec('ALTER TABLE quality_production_store_manifest RENAME TO quality_production_store_manifest_original');
        extraDb.exec('CREATE TABLE quality_production_store_manifest (manifest_id TEXT NOT NULL, manifest_json TEXT NOT NULL, manifest_checksum TEXT NOT NULL)');
        extraDb.prepare('INSERT INTO quality_production_store_manifest(manifest_id,manifest_json,manifest_checksum) VALUES (?,?,?)')
          .run('quality-store-manifest-v1', JSON.stringify(manifest), contentHash(manifest));
        extraDb.prepare('INSERT INTO quality_production_store_manifest(manifest_id,manifest_json,manifest_checksum) VALUES (?,?,?)')
          .run('quality-store-manifest-v1', JSON.stringify(manifest), contentHash(manifest));
      } finally { extraDb.close(); }
      await expectPreparationReject();
      const clearExtra = new DatabaseSync(path);
      try {
        clearExtra.exec('DROP TABLE quality_production_store_manifest');
        clearExtra.exec('ALTER TABLE quality_production_store_manifest_original RENAME TO quality_production_store_manifest');
      } finally { clearExtra.close(); }

      const db = new DatabaseSync(path);
      try { db.prepare('DELETE FROM quality_production_store_manifest').run(); }
      finally { db.close(); }
      await expectPreparationReject(/manifest|authority|unavailable|sidecar/i);
      replaceManifest(path, manifest);

      for (const suffix of ['-wal', '-shm', '-journal']) {
        writeFileSync(`${path}${suffix}`, Buffer.from('foreign-sidecar'));
        try { await expectPreparationReject(/sidecar|manifest|authority/i); }
        finally { rmSync(`${path}${suffix}`, { force: true }); }
      }

      const winnerBytes = readFileSync(path);
      for (const stage of ['copy', 'manifest', 'checkpoint', 'link']) {
        const interruptedTemp = `${path}.tmp-999999-deadbeef`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', `
          import { writeFileSync } from 'node:fs';
          writeFileSync(process.env.QUALITY_INTERRUPTED_TARGET, process.env.QUALITY_INTERRUPTED_STAGE);
        `], {
          env: {
            ...process.env,
            QUALITY_INTERRUPTED_TARGET: interruptedTemp,
            QUALITY_INTERRUPTED_STAGE: `interrupted-${stage}`,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        const childError = await new Promise(resolve => {
          let stderr = '';
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.once('error', error => resolve(error));
          child.once('close', code => resolve(code === 0 ? null : new Error(
            `interruption child exited ${code}: ${stderr}`
          )));
        });
        if (childError) throw childError;
        let resumedContext = null;
        try {
          resumedContext = await prepareQualityProductionSubject(config, { item, finalKey, ordinal: 0, ledger });
          await resumedContext.closeAsync();
        } finally {
          if (resumedContext?.phase !== 'closed') await resumedContext?.closeAsync?.();
        }
        assert.equal(existsSync(interruptedTemp), false, `stale ${stage} temp cleaned for ${path}`);
        assert.deepEqual(readFileSync(path), winnerBytes, `winner preserved after ${stage} interruption`);
      }
    }
  } finally {
    try {
      if (context?.closeAsync) await context.closeAsync();
      else context?.close?.();
    } finally { ledger.close(); }
  }
});

test('real publisher fault boundaries recover after a child hard-exit', async () => {
  const stages = ['after-copy', 'after-manifest-close', 'after-checkpoint', 'after-link'];
  const preflightTempsBefore = listQualityPreflightTempDirs();
  try {
    for (const stage of stages) {
    const fixture = createGitFixture();
    const authority = createQualityReplayRunAuthority(inputs(fixture));
    const config = qualityRunAuthorityProductionConfig(authority);
    const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
    const ledger = openProductionQualityReplayLedger({
      filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
    });
    const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
    ledger.createOrOpenRun(header);
    const finalKey = authority.finalKeys[0];
    const item = fixture.plan.items[0];
    const seedPath = join(fixture.root, fixture.materials.seedDatabasePath);
    const stem = `${seedPath}.quality-${contentHash({ runId: authority.runId, finalKey }).slice(0, 24)}`;
      const seedWorkingPath = `${stem}.stable.sqlite.seed-working.sqlite`;
    let resumedContext = null;
    try {
      const childSource = `
        import fs from 'node:fs';
        import { readFileSync, writeFileSync, existsSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        import { DatabaseSync } from 'node:sqlite';
        import { join } from 'node:path';
        import { contentHash } from './yuqi-runtime/src/protocol.mjs';
        const root = process.env.QRP_ROOT;
        const privateRoot = 'artifacts/yuqi-lived-agency-v3/private';
        const plan = JSON.parse(readFileSync(join(root, privateRoot, 'quality-replay-plan.json'), 'utf8'));
        const { createQualityReplayRunAuthority } =
          await import('./scripts/yuqi-quality-production-execution-config.mjs');
        const authority = createQualityReplayRunAuthority({
          rootDir: root, ledgerPath: privateRoot + '/quality-replay-state.sqlite', plan,
          resumeRun: process.env.QRP_RUN_ID,
          artifactPaths: {
            plan: privateRoot + '/quality-replay-plan.json',
            ledger: privateRoot + '/quality-replay-state.sqlite',
            raw: privateRoot + '/quality-replay.jsonl',
          },
        });
        const { qualityRunAuthorityProductionConfig } =
          await import('./yuqi-runtime/src/quality-replay-production-bridge.mjs');
        let config = qualityRunAuthorityProductionConfig(authority);
        const { openProductionQualityReplayLedger } =
          await import('./yuqi-runtime/src/quality-replay-ledger.mjs');
        const ledger = openProductionQualityReplayLedger({
          filename: join(root, privateRoot, 'quality-replay-state.sqlite'),
          runAuthority: authority, sourceRootDir: root,
        });
        const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
        ledger.createOrOpenRun(header);
        const materialManifest = JSON.parse(readFileSync(join(root, privateRoot, 'quality-production-config.json'), 'utf8'));
        const clientKeys = ['command', 'args', 'cwd', 'env', 'clientInfo', 'requestTimeoutMs', 'turnTimeoutMs',
          'maxRoleTurns', 'modelProfile', 'sessionNamespace', 'namespace', 'threadNamespace', 'lane',
          'sessionStorePath', 'approvalPolicy', 'sandbox', 'schema'];
        const clientConfigs = Object.fromEntries(Object.entries(materialManifest.lanes).map(([name, lane]) => {
          const client = Object.fromEntries(clientKeys.filter(key => Object.hasOwn(lane, key)).map(key => [key, lane[key]]));
          return [name, client];
        }));
        const materials = {
          runtimeConfig: materialManifest.runtimeConfig,
          seedDatabasePath: join(root, materialManifest.seedDatabasePath),
          stableDatabasePath: join(root, materialManifest.stableDatabasePath),
          candidateDatabasePath: join(root, materialManifest.candidateDatabasePath),
          clientConfigs,
          clientConfigChecksums: Object.fromEntries(Object.entries(clientConfigs)
            .map(([name, client]) => [name, contentHash(client)])),
        };
        const stage = process.env.QRP_FAULT_STAGE;
        let armed = false;
        const markerPath = process.env.QRP_FAULT_MARKER;
        const expectedTempPrefix = process.env.QRP_EXPECTED_TEMP_PREFIX;
        const expectedDestination = process.env.QRP_EXPECTED_DESTINATION;
        let observedTempPath = null;
        const copyObservations = [];
        const writeMarker = value => writeFileSync(markerPath, JSON.stringify({ stage, ...value }));
        const originalCopyFileSync = fs.copyFileSync;
        const originalLinkSync = fs.linkSync;
        fs.copyFileSync = (...args) => {
          const result = originalCopyFileSync(...args);
          const destination = String(args[1]);
          copyObservations.push({ destination, exists: existsSync(destination) });
          writeMarker({ boundary: 'copy-any', tempPath: destination, tempExists: existsSync(destination), copies: copyObservations });
          if (destination.includes('.seed-working.sqlite.tmp-')) {
            observedTempPath = destination;
            writeMarker({ boundary: 'copy-observed', tempPath: destination, tempExists: existsSync(destination) });
          }
          if (armed && stage === 'after-copy' && destination.includes('.seed-working.sqlite.tmp-') && existsSync(destination)) {
            writeMarker({ boundary: 'copy', tempPath: destination, tempExists: true });
            process.exit(97);
          }
          return result;
        };
        fs.linkSync = (...args) => {
          const result = originalLinkSync(...args);
          const source = String(args[0]);
          const destination = String(args[1]);
          if (armed && stage === 'after-link' && source.startsWith(expectedTempPrefix)
            && destination === expectedDestination && existsSync(source) && existsSync(destination)) {
            writeMarker({ boundary: 'link', tempPath: source, destination, tempExists: true, destinationExists: true });
            process.exit(97);
          }
          return result;
        };
        const manifestDatabases = new WeakSet();
        const manifestValues = new WeakMap();
        const originalPrepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function patchedPrepare(sql, ...args) {
          const statement = originalPrepare.call(this, sql, ...args);
          if (/INSERT\\s+INTO\\s+quality_production_store_manifest/i.test(String(sql))) {
            const originalRun = statement.run.bind(statement);
            statement.run = (...runArgs) => {
              const result = originalRun(...runArgs);
              manifestDatabases.add(this);
              manifestValues.set(this, { manifestId: runArgs[0], manifestJson: runArgs[1], manifestChecksum: runArgs[2] });
              return result;
            };
          }
          return statement;
        };
        const originalExec = DatabaseSync.prototype.exec;
        DatabaseSync.prototype.exec = function patchedExec(sql, ...args) {
          const result = originalExec.call(this, sql, ...args);
          if (armed && stage === 'after-manifest-close' && manifestDatabases.has(this) && /^\\s*COMMIT\\b/i.test(String(sql))) {
            const manifest = manifestValues.get(this);
            if (observedTempPath && observedTempPath.includes('.seed-working.sqlite.tmp-')
              && existsSync(observedTempPath) && manifest?.manifestChecksum) {
              writeMarker({ boundary: 'manifest-close', tempPath: observedTempPath, tempExists: true, manifest });
              process.exit(97);
            }
          }
          if (armed && stage === 'after-checkpoint' && /wal_checkpoint\\s*\\(\\s*TRUNCATE\\s*\\)/i.test(String(sql))) {
            if (observedTempPath && observedTempPath.includes('.seed-working.sqlite.tmp-') && existsSync(observedTempPath)) {
              writeMarker({ boundary: 'checkpoint', tempPath: observedTempPath, tempExists: true });
              process.exit(97);
            }
          }
          return result;
        };
        syncBuiltinESMExports();
        const { createQualityProductionExecutionAuthority: mintPatchedAuthority,
          qualityRunAuthorityProductionConfig: patchedQualityRunAuthorityProductionConfig,
          prepareQualityProductionSubject } =
          await import('./yuqi-runtime/src/quality-replay-production-bridge.mjs?fault-child=' + stage);
        const patchedAuthority = mintPatchedAuthority({
          descriptor: authority, materials, sourceRootDir: root,
        });
        config = patchedQualityRunAuthorityProductionConfig(patchedAuthority);
        armed = true;
        await prepareQualityProductionSubject(config, {
          item: plan.items[0], finalKey: process.env.QRP_FINAL_KEY, ordinal: 0, ledger,
        });
        ledger.close();
        process.exit(0);
      `;
      const markerPath = join(fixture.root, PRIVATE, `.quality-publish-fault-${stage}.json`);
      rmSync(markerPath, { force: true });
      const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          QRP_ROOT: fixture.root,
          QRP_RUN_ID: authority.runId,
          QRP_FINAL_KEY: finalKey,
          QRP_FAULT_STAGE: stage,
          QRP_FAULT_MARKER: markerPath,
          QRP_EXPECTED_TEMP_PREFIX: `${seedWorkingPath}.tmp-`,
          QRP_EXPECTED_DESTINATION: seedWorkingPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      const exitCode = await new Promise((resolveCode, reject) => {
        child.once('error', reject);
        child.once('close', resolveCode);
      });
      const childMarker = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : 'none';
      assert.equal(exitCode, 97, `${stage} child must hard-exit in publisher: ${stderr} marker=${childMarker}`);
      assert.equal(existsSync(markerPath), true, `${stage} child wrote a publication boundary marker`);
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      assert.equal(marker.stage, stage);
      assert.ok(String(marker.tempPath).startsWith(`${seedWorkingPath}.tmp-`),
        `${stage} marker names the publication temp: expected=${seedWorkingPath}.tmp- actual=${JSON.stringify(marker)}`);
      if (stage === 'after-copy') {
        assert.equal(marker.boundary, 'copy');
        assert.equal(marker.tempExists, true);
      } else if (stage === 'after-manifest-close') {
        assert.equal(marker.boundary, 'manifest-close');
        assert.equal(marker.tempExists, true);
        assert.equal(marker.manifest?.manifestId, 'quality-store-manifest-v1');
        assert.match(String(marker.manifest?.manifestChecksum), /^[a-f0-9]{64}$/);
      } else if (stage === 'after-checkpoint') {
        assert.equal(marker.boundary, 'checkpoint');
        assert.equal(marker.tempExists, true);
      } else {
        assert.equal(marker.boundary, 'link');
        assert.equal(marker.destination, seedWorkingPath);
        assert.equal(marker.destinationExists, true);
      }
      rmSync(markerPath, { force: true });

      const beforeWinner = existsSync(seedWorkingPath) ? readFileSync(seedWorkingPath) : null;
      resumedContext = await prepareQualityProductionSubject(config, {
        item, finalKey, ordinal: 0, ledger,
      });
      const publishedPaths = Object.keys(resumedContext.expectedStoreManifests);
      assert.equal(publishedPaths.length, 5);
      for (const path of publishedPaths) {
        assert.equal(existsSync(path), true, `${stage} publishes ${path}`);
      }
      if (beforeWinner) assert.deepEqual(readFileSync(seedWorkingPath), beforeWinner,
        `${stage} never overwrites a linked winner`);
      await resumedContext.closeAsync();
      resumedContext = null;
      for (const path of publishedPaths) {
        for (const suffix of ['-wal', '-shm', '-journal']) assert.equal(existsSync(`${path}${suffix}`), false, `${stage} sidecar ${path}${suffix}`);
        assert.equal(readQualityProductionStoreManifest(path).runId, authority.runId);
      }
      const stale = readdirSync(join(fixture.root, PRIVATE))
        .filter(name => name.includes('.tmp-'));
      assert.deepEqual(stale, [], `${stage} leaves no interrupted temp`);
    } finally {
      if (resumedContext) await resumedContext.closeAsync();
      ledger.close();
    }
    }
  } finally {
    removeNewQualityPreflightTempDirs(preflightTempsBefore);
  }
});

test('two independent production processes converge on one non-overwriting five-store winner', async () => {
  const fixture = createGitFixture();
  const authority = createQualityReplayRunAuthority(inputs(fixture));
  const { evidenceEligible: _evidenceEligible, ledgerPath: _ledgerPath, ...header } = authority;
  const ledgerPath = join(fixture.root, PRIVATE, 'quality-replay-state.sqlite');
  const ledger = openProductionQualityReplayLedger({
    filename: ledgerPath, runAuthority: authority, sourceRootDir: fixture.root,
  });
  ledger.createOrOpenRun(header);
  const childSource = `
    import { readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { createQualityReplayRunAuthority } from './scripts/yuqi-quality-production-execution-config.mjs';
    import { qualityRunAuthorityProductionConfig, prepareQualityProductionSubject } from './yuqi-runtime/src/quality-replay-production-bridge.mjs';
    import { openProductionQualityReplayLedger } from './yuqi-runtime/src/quality-replay-ledger.mjs';
    const root = process.env.QRP_ROOT;
    const privateRoot = 'artifacts/yuqi-lived-agency-v3/private';
    const plan = JSON.parse(readFileSync(join(root, privateRoot, 'quality-replay-plan.json'), 'utf8'));
    const runId = process.env.QRP_RUN_ID;
    const authority = createQualityReplayRunAuthority({
      rootDir: root, ledgerPath: privateRoot + '/quality-replay-state.sqlite', plan,
      resumeRun: runId,
      artifactPaths: {
        plan: privateRoot + '/quality-replay-plan.json',
        ledger: privateRoot + '/quality-replay-state.sqlite',
        raw: privateRoot + '/quality-replay.jsonl'
      }
    });
    const config = qualityRunAuthorityProductionConfig(authority);
    const ledger = openProductionQualityReplayLedger({
      filename: join(root, privateRoot, 'quality-replay-state.sqlite'),
      runAuthority: authority, sourceRootDir: root
    });
    let context = null;
    const failures = [];
    let publicationResults = null;
    try {
      context = await prepareQualityProductionSubject(config, {
        item: plan.items[0], finalKey: authority.finalKeys[0], ordinal: 0, ledger
      });
      publicationResults = Object.fromEntries(context.publicationResults || []);
    } catch (error) {
      failures.push({ message: error?.message || String(error), stage: 'prepare' });
    } finally {
      try { if (context?.closeAsync) await context.closeAsync(); }
      catch (error) { failures.push({ message: error?.message || String(error), stage: 'context-close' }); }
      try { ledger.close(); }
      catch (error) { failures.push({ message: error?.message || String(error), stage: 'ledger-close' }); }
    }
    if (failures.length) {
      console.error(JSON.stringify({ failures }));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ publicationResults }));
    }
  `;
  const launch = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
      cwd: process.cwd(),
      env: { ...process.env, QRP_ROOT: fixture.root, QRP_RUN_ID: authority.runId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) return reject(new Error(`creator exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout.trim())); }
      catch (error) { reject(new Error(`creator output is not JSON: ${error?.message || String(error)} stdout=${stdout} stderr=${stderr}`)); }
    });
  });
  let runError = null;
  let outcomes = [];
  try { outcomes = await Promise.all([launch(), launch()]); }
  catch (error) { runError = error; }
  if (!runError) {
    const stablePath = join(fixture.root, PRIVATE, `seed.sqlite.quality-${contentHash({ runId: authority.runId, finalKey: authority.finalKeys[0] }).slice(0, 24)}.stable.sqlite`);
    await awaitQualityPublishedStoreSidecarsGone([
      `${stablePath}.seed-working.sqlite`, stablePath,
      stablePath.replace('.stable.sqlite', '.candidate.sqlite'),
      `${stablePath}.evaluator-primary.sqlite`, `${stablePath}.evaluator-secondary.sqlite`,
    ]);
  }
  try { ledger.close(); }
  catch (error) { runError ||= error; }
  if (runError) throw runError;
  assert.equal(outcomes.length, 2);
  // The children closed their contexts before returning; verify every winner
  // through the immutable manifest reader, not through a caller summary.
  const materialPath = join(fixture.root, PRIVATE, 'quality-production-config.json');
  assert.ok(existsSync(materialPath));
  const stablePath = join(fixture.root, PRIVATE, `seed.sqlite.quality-${contentHash({ runId: authority.runId, finalKey: authority.finalKeys[0] }).slice(0, 24)}.stable.sqlite`);
  const paths = [
    `${stablePath}.seed-working.sqlite`, stablePath, stablePath.replace('.stable.sqlite', '.candidate.sqlite'),
    `${stablePath}.evaluator-primary.sqlite`, `${stablePath}.evaluator-secondary.sqlite`,
  ];
  for (const path of paths) {
    assert.ok(readQualityProductionStoreManifest(path));
    const values = outcomes.map(outcome => outcome.publicationResults?.[path]);
    assert.deepEqual(values.slice().sort(), [false, true], `publication winner/loser for ${path}`);
  }
  const sidecars = [];
  const visit = root => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.tmp-|-(?:wal|shm|journal)$/.test(entry.name)) sidecars.push(path);
    }
  };
  visit(join(fixture.root, PRIVATE));
  assert.deepEqual(sidecars, []);
});
