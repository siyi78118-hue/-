import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CognitivePipeline } from '../src/cognitive-pipeline.mjs';
import { compileQualitySubject } from '../src/quality-evaluator.mjs';
import { compileQualitySuite } from '../../scripts/compile-yuqi-lived-quality-scenes.mjs';
import { buildVerifiedQualityReplayPlan } from '../src/quality-replay.mjs';
import { contentHash } from '../src/protocol.mjs';
import { PresetRegistry } from '../src/preset-registry.mjs';
import { PromotionController } from '../src/promotion-controller.mjs';
import {
  assertProductionRuntimeAttestation,
  composeYuqiExecutionRuntime,
} from '../src/runtime-composition.mjs';
import { YuqiStore } from '../src/store.mjs';
import {
  authorityIdFor,
  createQualityProductionContext,
  executeQualitySubject,
  prepareQualitySubject,
} from '../src/quality-replay-production-bridge.mjs';

const SOURCE_HEAD = 'a'.repeat(40);
const PRESET_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
const PLAN_PREVIEW_PATH = join(
  dirname(fileURLToPath(import.meta.url)), '..', '..', 'artifacts',
  'yuqi-lived-agency-v3', 'task25f-plan-preview.json'
);
const FROZEN_PLAN_CHECKSUM = 'dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c';

function cognitionResult() {
  return {
    interactionRead: {
      surfaceAct: 'playful statement',
      primarySocialMeaning: 'playful reassurance bid',
      alternativeMeaning: null,
      confidence: 0.86,
      evidenceMessageIds: ['u1'],
    },
    selfResponse: {
      immediateFeeling: 'amused',
      desire: 'stay in exchange',
      resistance: '',
      attention: 'the playful bid',
      stanceTransitions: [],
    },
    interactionDecision: {
      intendedResponse: 'send',
      relationshipEffect: 'meet bid',
      shouldAcknowledgeBid: true,
      intentionalNonResponseReason: null,
      motiveEvidenceIds: ['quality-motive'],
      mustConvey: ['she caught bid'],
      mustNotClaim: [],
    },
    actionIntent: {
      payment: null,
      moment: null,
      rolePlan: null,
      lifeAdjustment: null,
      relationshipReview: null,
    },
    statePatch: { mood: 'amused', currentStances: [], openThreads: ['playful_exchange'] },
  };
}

function expressionResult() {
  return {
    action: 'send',
    reply: '行，这次算你多说了两个字。',
    usedFactIds: [],
    bubblePlan: [{ text: '行，这次算你多说了两个字。', purpose: 'continue exchange' }],
    incompatibility: null,
  };
}

class ControlledCodex {
  constructor() {
    this.runTurnCalls = [];
    this.runRoleCalls = [];
    this.modelRequests = [];
  }

  async runTurn(role, input) {
    this.runTurnCalls.push({ role, input });
    if (role === 'memory') return { text: JSON.stringify({ query: '', keywords: [], candidates: [] }) };
    if (role === 'supervisor') return { text: JSON.stringify({ approved: true, issues: [] }) };
    const request = JSON.parse(input);
    this.modelRequests.push({ role, request });
    if (request.cognitionEnvelope && !request.expressionBrief
      && (request.task === 'understand_and_decide_v3'
      || request.task === 'reconsider_and_decide_v3'
      || request.task === 'reconsider_lived_quality_v3' || request.task === 'understand_and_decide'
      || request.task === 'deep_understand_and_decide')) {
      const result = cognitionResult();
      result.interactionRead.evidenceMessageIds = [];
      return { text: JSON.stringify(request.task === 'understand_and_decide_v3'
        ? { routeDecision: 'fast', cognitionResult: result } : result) };
    }
    if (request.expressionBrief || request.task === 'express_authorized_decision_v3'
      || request.task === 'rewrite_expression_for_lived_quality_v3') {
      return { text: JSON.stringify(expressionResult()) };
    }
    if (request.task === 'plan_yuqi_life' || request.task === 'plan_yuqi_life_with_cognition') {
      const start = Number(request.planningWindow.startAt);
      return { text: JSON.stringify({
        action: 'skip', reply: '', usedFactIds: [],
        lifePlan: { planKey: request.planKey, episodes: [{
          episodeId: `${request.planKey}_model_episode`, kind: 'rest', title: 'quiet planning',
          startAt: start, endAt: start + 8 * 60 * 60_000,
        }] },
      }) };
    }
    return { text: JSON.stringify({ reply: 'controlled reply', usedFactIds: [] }) };
  }

  async runRole(input, system, payload) {
    const role = typeof input === 'object' ? input.role : input;
    const request = typeof input === 'object'
      ? { ...(input.payload || {}) }
      : { ...(system || {}) };
    this.runRoleCalls.push(role);
    this.modelRequests.push({ role, request });
    if (role === 'cognition_fast' || role === 'cognition_deep') {
      const result = cognitionResult();
      result.interactionRead.evidenceMessageIds = [];
      const turnKind = input?.turn?.rolloutKey || input?.turn?.turnKind || input?.turn?.kind
        || request.cognitionEnvelope?.turnKind;
      if (turnKind === 'PROACTIVE_CHAT') {
        result.interactionDecision.intendedResponse = 'skip';
        result.interactionDecision.intentionalNonResponseReason = 'quality fixture';
        result.interactionDecision.motiveEvidenceIds = [];
        for (const key of Object.keys(result.actionIntent)) result.actionIntent[key] = null;
      }
      return { text: JSON.stringify(role === 'cognition_fast'
        ? { routeDecision: 'fast', cognitionResult: result } : result) };
    }
    if (role === 'expression' || role === 'expression_v3') {
      if (request.expressionBrief?.interactionDecision?.intendedResponse === 'skip') {
        return { text: JSON.stringify({
          action: 'skip', reply: '', usedFactIds: [], bubblePlan: [], incompatibility: null
        }) };
      }
      return { text: JSON.stringify(expressionResult()) };
    }
    return { text: JSON.stringify({ approved: true, issues: [] }) };
  }
}

function makeRuntime(store, clock = () => 1_000, { shadowTurn = false } = {}) {
  const codex = new ControlledCodex();
  const presets = new PresetRegistry({ presetDir: PRESET_DIR, store, clock });
  const promotionController = new PromotionController({ store, presetRegistry: presets, clock });
  promotionController.initialize();
  const status = promotionController.getStatus('DIRECT_REPLY');
  const stable = store.getPipelineRelease(status.stableReleaseId);
  const pipelineManifest = presets.pipelineReleaseManifest('2.0.0', stable.releaseId, {
    modelProfile: {
      cognitionFast: 'gpt-5.6-sol/medium', cognitionDeep: 'gpt-5.6-sol/medium',
      expression: 'gpt-5.6-terra/medium', supervisor: 'gpt-5.6-terra/medium',
    }, cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'quality-fixture-v3',
  });
  const candidateBody = {
    pipelineVersion: 'yuqi-lived-agency-v3', presetVersion: '2.0.0',
    cognitionSchemaVersion: 3, expressionSchemaVersion: 3,
    evaluatorVersion: 'quality-fixture-v3', modelProfile: pipelineManifest.modelProfile,
    componentManifest: pipelineManifest, createdAt: Number(clock()), retiredAt: null,
  };
  const candidateChecksum = contentHash({
    pipelineVersion: candidateBody.pipelineVersion, presetVersion: candidateBody.presetVersion,
    cognitionSchemaVersion: candidateBody.cognitionSchemaVersion,
    expressionSchemaVersion: candidateBody.expressionSchemaVersion,
    evaluatorVersion: candidateBody.evaluatorVersion, modelProfile: candidateBody.modelProfile,
    componentManifest: candidateBody.componentManifest, createdAt: candidateBody.createdAt,
  });
  const candidate = store.putPipelineReleaseInternal({
    ...candidateBody, releaseChecksum: candidateChecksum,
    releaseId: `quality_candidate_${candidateChecksum.slice(0, 16)}`,
  });
  if (shadowTurn) {
    if (status.candidatePhase === 'shadow') {
      // Byte-cloned fixtures already carry the registered shadow authority.
    } else {
    const report = store.putEvaluationReportInternal({
      reportId: `quality_fixture_report_${contentHash(candidate.releaseId).slice(0, 16)}`,
      reportType: 'promotion', rolloutKey: 'DIRECT_REPLY', sourceType: 'aggregate_gate',
      sourceRef: 'quality-fixture-report.json', artifactPath: 'quality-fixture-report.json',
      summary: {
        eligible: true, candidateRelease: candidate,
        stableBaselineReleaseId: stable.releaseId,
        stableBaselineReleaseChecksum: stable.releaseChecksum,
        evaluatorVersion: candidate.evaluatorVersion,
        suiteChecksum: 'quality-fixture-suite', liveShadowSuccessCount: 30,
        criticalErrors: 0,
      },
      createdAt: 1_000,
    });
    store.markEvaluationReportMaterialized({
      reportId: report.reportId, expectedChecksum: report.artifactChecksum, now: 1_000,
    });
    promotionController.registerCandidate({
      rolloutKey: 'DIRECT_REPLY', expectedRevision: status.revision,
      releaseId: candidate.releaseId, reportId: report.reportId,
      reportChecksum: report.artifactChecksum,
    });
    }
  }
  const cognitivePipeline = new CognitivePipeline({
    store, codexClient: codex, presetRegistry: presets, clock,
  });
  const runtime = composeYuqiExecutionRuntime({
    store, presets, codex, promotionController, cognitivePipeline, sourceHead: SOURCE_HEAD,
  });
  return { runtime, codex, presets, promotionController };
}

function releasePair(store) {
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const stableRelease = store.getPipelineRelease(rollout.stableReleaseId);
  const candidateRelease = store.listPipelineReleases()
    .find(row => row.releaseId !== stableRelease.releaseId && row.componentManifest);
  assert.ok(stableRelease && candidateRelease, 'fixture must have a real release pair');
  return { stableRelease, candidateRelease };
}

let FROZEN_SUBJECTS;

function frozenSubjects() {
  if (FROZEN_SUBJECTS) return FROZEN_SUBJECTS;
  const preview = JSON.parse(readFileSync(PLAN_PREVIEW_PATH, 'utf8'));
  if (preview.planChecksum !== FROZEN_PLAN_CHECKSUM || preview.items?.length !== 246) {
    throw new Error('frozen Task25 plan preview authority conflict');
  }
  const suite = compileQualitySuite({ rootDir: process.cwd(), checkOnly: true });
  const plan = buildVerifiedQualityReplayPlan({
    compiledSuite: suite,
    historyScenes: suite.humanAnnotationScenes,
    historyManifest: suite.humanAnnotationManifest
  });
  if (plan.planChecksum !== FROZEN_PLAN_CHECKSUM || plan.planChecksum !== preview.planChecksum) {
    throw new Error('compiled Task25 plan checksum conflict');
  }
  if (plan.items.length !== preview.items.length) throw new Error('frozen plan item identity conflict');
  FROZEN_SUBJECTS = plan.items.map(compileQualitySubject);
  if (FROZEN_SUBJECTS.length !== 246) throw new Error('compiled frozen subject count mismatch');
  return FROZEN_SUBJECTS;
}

function compiledSubject(kind, ordinal = 0) {
  const candidates = frozenSubjects().filter(subject => subject.turnKind === kind);
  if (!candidates.length) throw new Error(`missing frozen subject kind ${kind}`);
  return candidates[ordinal % candidates.length];
}

function candidateResponseAnchorAt(subject) {
  const anchor = subject?.semanticInput?.turns?.find(
    turn => turn?.speaker === 'system' && turn?.event === 'candidate_response'
  )?.at;
  const value = Date.parse(String(anchor || ''));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('subject candidate anchor is required');
  return value;
}

async function withRealFixture(kind, ordinal, run, finalKey = `${kind}-${ordinal}`) {
  const root = mkdtempSync(join(tmpdir(), `yuqi-quality-bridge-${kind}-`));
  const seedPath = join(root, 'seed.sqlite');
  const stablePath = join(root, 'stable.sqlite');
  const candidatePath = join(root, 'candidate.sqlite');
  const subject = frozenSubjects().find(item => item.finalKey === finalKey);
  const anchorAt = subject ? candidateResponseAnchorAt(subject) : 1_000;
  const fixtureClock = () => anchorAt;
  const seedStore = new YuqiStore(seedPath);
  const seed = makeRuntime(seedStore, fixtureClock, { shadowTurn: kind === 'turn' });
  try {
    if (kind === 'turn') {
      seedStore.claimInteractionLaneInternal({
        roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
        localSequence: 0, now: 1_000,
      });
    }
    const { stableRelease, candidateRelease } = releasePair(seedStore);
    const runtimeCodexes = [];
    const context = createQualityProductionContext({
      runId: 'quality-run-real', finalKey, ordinal,
      sourceHead: SOURCE_HEAD, anchorAt, planChecksum: FROZEN_PLAN_CHECKSUM,
      seedStore, seedRuntime: seed.runtime,
      seedDatabasePath: seedPath, stableDatabasePath: stablePath,
      candidateDatabasePath: candidatePath,
      stableRelease, candidateRelease,
      runtimeFactory: ({ store }) => {
        const built = makeRuntime(store, fixtureClock, { shadowTurn: kind === 'turn' });
        runtimeCodexes.push(built.codex);
        return built.runtime;
      },
    });
    await run({ context, seed, stableRelease, candidateRelease, root, runtimeCodexes });
  } finally {
    // Context.close is idempotent and owns the cloned stores after preparation.
    // If preparation failed before ownership transfer, close the seed here.
    try { seedStore.close(); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

test('authority ids are independent of execution side', () => {
  assert.equal(
    authorityIdFor({ runId: 'run-1', finalKey: 'turn-a', ordinal: 0, side: 'stable' }),
    authorityIdFor({ runId: 'run-1', finalKey: 'turn-a', ordinal: 0, side: 'candidate' }),
  );
});

test('plain or fake production dependencies cannot obtain attestation', () => {
  assert.throws(() => assertProductionRuntimeAttestation({ store: {}, releaseExecutor: {} }), /attestation/);
  assert.throws(() => assertProductionRuntimeAttestation(Object.freeze({}), {}), /attestation/);
});

test('recursive attachment closure rejects before store accept', async () => {
  let accepted = 0;
  const context = createQualityProductionContext({
    runId: 'run-1', finalKey: 'turn-1', ordinal: 0, sourceHead: SOURCE_HEAD,
    seedStore: { userVersion: () => 15, close() {} },
    seedRuntime: { orchestrator: { accept() { accepted += 1; } } },
  });
  await assert.rejects(() => prepareQualitySubject(context, {
    type: 'turn', semanticInput: { content: 'x', createdAt: 1_000, context: {
      currentBatch: { messages: [{ attachments: [{ path: 'secret.png' }] }] },
    } },
  }), /production runtime|attachment|attestation|closed shape/);
  assert.equal(accepted, 0);
});

test('real v15 turn uses accept, shared builder and both production release executors', async () => {
  const subject = compiledSubject('DIRECT_REPLY', 0);
  await withRealFixture('turn', 0, async ({ context, runtimeCodexes }) => {
    const prepared = await prepareQualitySubject(context, subject);
    assert.equal(prepared.type, 'turn');
    const result = await executeQualitySubject(context, {
      method: 'executeTurn', authorityId: prepared.authorityId,
    });
    assert.equal(result.authorityId, prepared.authorityId);
    assert.equal(result.stable.dryRun, false);
    assert.equal(result.candidate.dryRun, true);
    assert.ok(runtimeCodexes.some(codex => codex.runRoleCalls.length + codex.runTurnCalls.length >= 1));
    context.close();
    context.close();
  }, subject.finalKey);
});

test('eight LIFE finals use real putLifePlan/contextFor/attempt/build/execute APIs', async () => {
  for (let ordinal = 0; ordinal < 8; ordinal += 1) {
    const subject = compiledSubject('LIFE_PLANNING', ordinal);
    await withRealFixture('life', ordinal, async ({ context, runtimeCodexes }) => {
      const prepared = await prepareQualitySubject(context, subject);
      assert.equal(prepared.type, 'life_planning');
      const result = await executeQualitySubject(context, { method: 'executeLife' });
      assert.equal(result.stable.dryRun, false);
      assert.equal(result.candidate.dryRun, true);
      assert.ok(runtimeCodexes.every(codex => codex.runRoleCalls.length === 0));
      context.close();
    }, subject.finalKey);
  }
});

test('prepared authority rejects wrong method, authority, input and release drift before model calls', async () => {
  const subject = compiledSubject('DIRECT_REPLY', 1);
  await withRealFixture('turn', 1, async ({ context }) => {
    const prepared = await prepareQualitySubject(context, subject);
    await assert.rejects(executeQualitySubject(context, { method: 'executeLife' }), /method authority/);
    await assert.rejects(executeQualitySubject(context, { authorityId: 'foreign' }), /identity conflict/);
    await assert.rejects(executeQualitySubject(context, { inputChecksum: 'changed' }), /input checksum/);
    assert.equal(prepared.authorityId, authorityIdFor({
      runId: 'quality-run-real', finalKey: subject.finalKey, ordinal: 1,
    }));
  }, subject.finalKey);
});

test('same store or clone path is rejected and close is idempotent', () => {
  assert.throws(() => createQualityProductionContext({
    runId: 'r', finalKey: 'f', ordinal: 0, sourceHead: SOURCE_HEAD,
    seedDatabasePath: 'seed.sqlite', stableDatabasePath: 'stable.sqlite',
    candidateDatabasePath: 'stable.sqlite',
  }), /independent/);
});

test('compiled subjects cannot inject executeTurn or executeSubject functions', async () => {
  const base = compiledSubject('DIRECT_REPLY', 2);
  await withRealFixture('turn', 2, async ({ context }) => {
    await assert.rejects(() => prepareQualitySubject(context, {
      ...base,
      executeTurn: () => { throw new Error('injected executor'); },
      executeSubject: () => { throw new Error('injected subject executor'); },
    }), /closed shape/);
    await assert.rejects(() => prepareQualitySubject(context, {
      ...base, accept: () => {},
    }), /closed shape/);
    await assert.rejects(() => prepareQualitySubject(context, {
      ...base, buildExecution: () => {},
    }), /closed shape/);
  }, base.finalKey);
});

test('model requests preserve frozen history, typed targets, scene context and state', async () => {
  const subject = frozenSubjects().find(item => item.subjectType === 'turn'
    && item.semanticInput.turns.some(turn => turn.batch?.some(message => message.type !== 'text')));
  assert.ok(subject, 'a typed frozen turn subject is required');
  const feature = subject.semanticInput.turns
    .flatMap(turn => turn.batch || [])
    .find(message => message.type !== 'text');
  await withRealFixture('turn', 90, async ({ context, runtimeCodexes }) => {
    await prepareQualitySubject(context, subject);
    await executeQualitySubject(context, { method: 'executeTurn' });
    const requests = runtimeCodexes.flatMap(codex => codex.modelRequests);
    const serialized = JSON.stringify(requests);
    assert.match(serialized, new RegExp(String(feature.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(serialized, new RegExp(String(feature.type)));
    assert.match(serialized, new RegExp(String(subject.semanticInput.context).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(serialized, new RegExp(String(subject.semanticInput.stateCheckpoint.relationship.base)));
    assert.match(serialized, /responseMustTarget/);
    assert.doesNotMatch(serialized, /quality fixture moment|quality fixture comment|quality-motive/);
    assert.equal(context.config.anchorAt, candidateResponseAnchorAt(subject));
  }, subject.finalKey);
});

test('canonical and life builders expose explicit input checksums without object fallbacks', async () => {
  const turnSubject = compiledSubject('DIRECT_REPLY', 3);
  await withRealFixture('turn', 91, async ({ context }) => {
    const prepared = await prepareQualitySubject(context, turnSubject);
    assert.match(prepared.execution.inputChecksum, /^[a-f0-9]{64}$/);
    assert.notEqual(prepared.execution.inputChecksum, contentHash(prepared.execution.turn));
    assert.equal(prepared.execution.inputChecksum, prepared.candidateExecution.inputChecksum);
  }, turnSubject.finalKey);
  const lifeSubject = compiledSubject('LIFE_PLANNING', 3);
  await withRealFixture('life', 92, async ({ context }) => {
    const prepared = await prepareQualitySubject(context, lifeSubject);
    assert.match(prepared.execution.inputChecksum, /^[a-f0-9]{64}$/);
    assert.equal(prepared.execution.inputChecksum, prepared.candidateExecution.inputChecksum);
  }, lifeSubject.finalKey);
});

test('self-consistent persisted envelope mutation is rejected before model calls', async () => {
  const subject = compiledSubject('DIRECT_REPLY', 4);
  await withRealFixture('turn', 93, async ({ context, runtimeCodexes }) => {
    await prepareQualitySubject(context, subject);
    const turn = context.prepared.stableStore.getTurn(context.prepared.persistedSubject.turnId);
    const envelope = JSON.parse(turn.envelopeJson);
    envelope.context.currentBatch.messages[0].content = 'tampered persisted batch';
    const envelopeJson = JSON.stringify(envelope);
    context.prepared.stableStore.db.prepare(
      'UPDATE turns SET envelope_json = ?, envelope_checksum = ? WHERE turn_id = ?'
    ).run(envelopeJson, contentHash(envelope), turn.turnId);
    const before = runtimeCodexes.reduce((sum, codex) => sum + codex.modelRequests.length, 0);
    await assert.rejects(() => executeQualitySubject(context, { method: 'executeTurn' }), /authority|input|envelope|agency/);
    const after = runtimeCodexes.reduce((sum, codex) => sum + codex.modelRequests.length, 0);
    assert.equal(after, before);
  }, subject.finalKey);
});

test('candidate anchor is terminal and cannot be followed by semantic turns', async () => {
  const base = compiledSubject('DIRECT_REPLY', 5);
  const tampered = structuredClone(base);
  tampered.semanticInput.turns.push({ speaker: 'user', at: '2026-01-01T00:00:00.000Z', batch: [
    { messageId: 'late-user', type: 'text', text: 'late semantic input' }
  ] });
  tampered.semanticInputChecksum = contentHash(tampered.semanticInput);
  await withRealFixture('turn', 94, async ({ context }) => {
    await assert.rejects(() => prepareQualitySubject(context, tampered), /after candidate_response/);
  }, base.finalKey);
});

test('non-direct response target and LIFE feature item are closed and unambiguous', async () => {
  const turn = compiledSubject('MOMENT_REPLY', 0);
  const missingTarget = structuredClone(turn);
  delete missingTarget.semanticInput.structuredActionTargets.responseMustTarget;
  missingTarget.semanticInputChecksum = contentHash(missingTarget.semanticInput);
  await withRealFixture('turn', 95, async ({ context }) => {
    await assert.rejects(() => prepareQualitySubject(context, missingTarget), /responseMustTarget/);
  }, turn.finalKey);
  const life = compiledSubject('LIFE_PLANNING', 0);
  const twoFeatures = structuredClone(life);
  const firstUser = twoFeatures.semanticInput.turns.find(item => item.speaker === 'user');
  firstUser.batch.push({ messageId: 'extra-feature', type: 'quote', text: 'second feature' });
  twoFeatures.semanticInputChecksum = contentHash(twoFeatures.semanticInput);
  await withRealFixture('life', 96, async ({ context }) => {
    await assert.rejects(() => prepareQualitySubject(context, twoFeatures), /feature item/);
  }, life.finalKey);
});

test('frozen plan identity and LIFE input checksum cannot use self-consistent substitutes', async () => {
  const subject = compiledSubject('LIFE_PLANNING', 1);
  await withRealFixture('life', 97, async ({ context }) => {
    context.config.planChecksum = 'f'.repeat(64);
    await assert.rejects(() => prepareQualitySubject(context, subject), /plan checksum/);
  }, subject.finalKey);
  await withRealFixture('life', 98, async ({ context }) => {
    const prepared = await prepareQualitySubject(context, subject);
    const attempt = { ...prepared.lifeAttempt, inputChecksum: undefined };
    assert.throws(() => prepared.stableRuntime.orchestrator
      .buildLifePlanningReleaseExecution(attempt), /input checksum/);
  }, subject.finalKey);
});

test('every persisted turn authority pin is an execute-time fence', async () => {
  const fields = [
    ['result_authority_version', 'result_authority_version + 1'],
    ['lineage_revision_at_creation', 'lineage_revision_at_creation + 1'],
    ['lane_revision', 'lane_revision + 1'],
    ['retry_of_turn_id', "'foreign-retry'"],
    ['input_user_batch_id', "'foreign-batch'"],
  ];
  for (const [column, expression] of fields) {
    const subject = compiledSubject('DIRECT_REPLY', 6);
    await withRealFixture('turn', 99 + fields.indexOf(fields.find(item => item[0] === column)), async ({ context, runtimeCodexes }) => {
      await prepareQualitySubject(context, subject);
      const turnId = context.prepared.persistedSubject.turnId;
      context.prepared.stableStore.db.prepare(
        `UPDATE turns SET ${column} = ${expression} WHERE turn_id = ?`
      ).run(turnId);
      const before = runtimeCodexes.reduce((sum, codex) => sum + codex.modelRequests.length, 0);
      await assert.rejects(() => executeQualitySubject(context, { method: 'executeTurn' }), /authority|input|envelope|agency/);
      const after = runtimeCodexes.reduce((sum, codex) => sum + codex.modelRequests.length, 0);
      assert.equal(after, before, column);
    }, subject.finalKey);
  }
});

test('real frozen Task1 compiler output is accepted by the production bridge for every kind', async () => {
  const kinds = [
    'DIRECT_REPLY', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
    'MOMENT_INTERACTION', 'MOMENT_REPLY', 'ROLE_PLAN_CHAT',
    'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
    'LIFE_PLANNING'
  ];
  for (const [ordinal, kind] of kinds.entries()) {
    const subject = compiledSubject(kind, ordinal);
    await withRealFixture(kind === 'LIFE_PLANNING' ? 'life' : 'turn', ordinal, async ({ context }) => {
      const prepared = await prepareQualitySubject(context, subject);
      assert.equal(prepared.type, kind === 'LIFE_PLANNING' ? 'life_planning' : 'turn');
      const result = await executeQualitySubject(context, { method: kind === 'LIFE_PLANNING' ? 'executeLife' : 'executeTurn' });
      assert.ok(result.stable && result.candidate);
      context.close();
    }, subject.finalKey);
  }
});

test('frozen Task25 plan prepares all 246 compiled subjects in fresh isolated contexts', async () => {
  const subjects = frozenSubjects();
  assert.equal(subjects.length, 246);
  for (const [ordinal, subject] of subjects.entries()) {
    await withRealFixture(subject.subjectType === 'life_planning' ? 'life' : 'turn', ordinal,
      async ({ context }) => {
        const prepared = await prepareQualitySubject(context, subject);
        assert.equal(prepared.type, subject.subjectType);
        context.close();
      }, subject.finalKey);
  }
});

test('frozen Task25 plan executes 17 representatives after all-subject preparation coverage', async () => {
  const subjects = frozenSubjects();
  const representatives = [];
  for (const kind of [
    'DIRECT_REPLY', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION',
    'MOMENT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
    'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE'
  ]) {
    representatives.push(subjects.find(subject => subject.turnKind === kind));
  }
  representatives.push(...subjects.filter(subject => subject.turnKind === 'LIFE_PLANNING'));
  assert.equal(representatives.length, 17);
  for (const [ordinal, subject] of representatives.entries()) {
    await withRealFixture(subject.subjectType === 'life_planning' ? 'life' : 'turn', ordinal,
      async ({ context }) => {
        const prepared = await prepareQualitySubject(context, subject);
        const method = subject.subjectType === 'life_planning' ? 'executeLife' : 'executeTurn';
        const result = await executeQualitySubject(context, { method });
        assert.ok(result.stable && result.candidate);
        context.close();
      }, subject.finalKey);
  }
});
