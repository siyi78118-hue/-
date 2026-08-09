import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { contentHash, validateEnvelope } from '../yuqi-runtime/src/protocol.mjs';
import { deriveAuthorityLineageKey, YuqiStore } from '../yuqi-runtime/src/store.mjs';
import { YuqiOrchestrator } from '../yuqi-runtime/src/orchestrator.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { generationFingerprint } from '../yuqi-runtime/src/interaction-lanes.mjs';
import { canonicalJson } from '../yuqi-runtime/src/protocol.mjs';
import { resolvePipelinePair } from '../yuqi-runtime/src/release-pair.mjs';
import { ResultOutbox } from '../yuqi-runtime/src/result-outbox.mjs';

const NOW = 1784400012000;
const ANDROID_FALLBACK_FIXTURE = JSON.parse(readFileSync(
  new URL('./fixtures/android-fallback-authority-v2.json', import.meta.url), 'utf8'
));

function cursor(localSequence = 1) {
  return {
    nativeCompletedTurnId: null,
    nativeCompletedGroupId: null,
    nativeCompletedSequence: 0,
    uiAppliedTurnId: null,
    uiAppliedGroupId: null,
    uiAppliedSequence: 0,
    localSequence,
    clearedThroughSequence: 0,
    clearEpoch: 0,
    clearedAt: 0,
    chatOpen: true,
    quotedMessageId: null
  };
}

function envelope({ turnId, kind = 'DIRECT_REPLY', deviceSeq = 1, messageId = `msg_${turnId}` }) {
  const message = {
    messageId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `input:${turnId}`,
    sentAt: NOW
  };
  const automatic = kind !== 'DIRECT_REPLY';
  const rootSourceId = automatic ? `trigger_${turnId}` : messageId;
  const authority = {
    algorithm: 'al-authority-v1',
    roleId: 'yuqi',
    laneKey: 'private_chat',
    rootSourceId,
    lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey: 'private_chat', rootSourceId }),
    claimedLineageRevision: 1,
    retryOfTurnId: null
  };
  return {
    protocolVersion: 3,
    turnId,
    characterId: 'yuqi',
    deviceId: 'device_pc_race',
    deviceSeq,
    createdAt: NOW,
    kind,
    ...(automatic ? {
      trigger: {
        triggerId: rootSourceId,
        triggerType: kind === 'PROACTIVE_CHAT' ? 'proactive_chat' : 'automatic',
        scheduledFor: NOW - 1,
        executedAt: NOW,
        context: {}
      }
    } : { message }),
    context: kind === 'DIRECT_REPLY'
      ? {
          currentBatch: {
            batchId: `batch_${turnId}`,
            messageIds: [messageId],
            startedAt: NOW,
            committedAt: NOW,
            messages: [message]
          },
          visibilityCursor: cursor(deviceSeq)
        }
      : { visibilityCursor: cursor(deviceSeq) },
    authority
  };
}

function promotionRegistry() {
  return {
    evidenceManifest(rolloutKey) {
      return { manifest: { rolloutKey, checksum: 'race-evidence' }, checksum: `race-evidence:${rolloutKey}`, presetVersion: '2.0.0' };
    }
  };
}

function candidateRelease() {
  const release = {
    releaseId: 'quality_candidate_race',
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.0.0',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    evaluatorVersion: 'yuqi-lived-quality-v1',
    modelProfile: { cognition: 'candidate-model' },
    componentManifest: { suite: 'quality-suite-v1' },
    createdAt: NOW,
    retiredAt: null
  };
  const releaseChecksum = contentHash({
    pipelineVersion: release.pipelineVersion,
    presetVersion: release.presetVersion,
    cognitionSchemaVersion: release.cognitionSchemaVersion,
    expressionSchemaVersion: release.expressionSchemaVersion,
    evaluatorVersion: release.evaluatorVersion,
    modelProfile: release.modelProfile,
    componentManifest: release.componentManifest,
    createdAt: release.createdAt
  });
  return { ...release, releaseId: `quality_candidate_${releaseChecksum.slice(0, 16)}`, releaseChecksum };
}

function registerCanary(store, { clock = () => NOW } = {}) {
  const controller = new PromotionController({ store, presetRegistry: promotionRegistry(), clock });
  controller.initialize();
  const candidate = candidateRelease();
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const pair = resolvePipelinePair(rollout);
  const summary = {
    eligible: true,
    candidateRelease: candidate,
    stableBaselineReleaseId: rollout.stableReleaseId,
    stableBaselineReleaseChecksum: store.getPipelineRelease(rollout.stableReleaseId).releaseChecksum,
    evaluatorVersion: candidate.evaluatorVersion,
    suiteChecksum: 'race-suite',
    liveShadowSuccessCount: 30,
    criticalErrors: 0
  };
  const report = store.putEvaluationReportInternal({
    reportId: 'race-quality-report', reportType: 'promotion', rolloutKey: 'DIRECT_REPLY',
    sourceType: 'aggregate_gate', sourceRef: 'race-report.json', artifactPath: 'race-report.json',
    summary, createdAt: NOW
  });
  store.markEvaluationReportMaterialized({
    reportId: report.reportId, expectedChecksum: report.artifactChecksum, now: NOW + 1
  });
  const registered = controller.registerCandidate({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: rollout.revision,
    releaseId: candidate.releaseId, reportId: report.reportId, reportChecksum: report.artifactChecksum
  });
  const current = controller.getStatus('DIRECT_REPLY');
  for (let index = 0; index < 10; index += 1) {
    const at = NOW - (72 * 60 * 60 * 1000) + index * (72 * 60 * 60 * 1000 / 9);
    store.putCognitionShadowRunInternal({
      runId: `race-shadow-${index}`, subjectType: 'turn', subjectId: `race-shadow-subject-${index}`,
      turnId: `race-shadow-turn-${index}`, rolloutKey: 'DIRECT_REPLY', source: 'live',
      comparisonDirection: 'stable_authoritative_candidate_compare', evidenceEpoch: current.evidenceEpoch,
      shadowEpoch: current.shadowEpoch, rolloutRevision: current.revision, pipelineChecksum: current.pipelineChecksum,
      state: 'completed', criticalFindings: [], createdAt: at, updatedAt: at
    });
  }
  const canary = controller.promoteToCanary({
    rolloutKey: 'DIRECT_REPLY', expectedRevision: registered.revision,
    reportId: report.reportId, reportChecksum: report.artifactChecksum
  });
  return { controller, canary, report };
}

function commitExistingTurn(store, turn, draftOverride = null) {
  const current = store.getTurn(turn.turnId);
  const draft = draftOverride || {
    action: 'send', reply: 'race reply', bubblePlan: [{ text: 'race reply', purpose: 'reply' }],
    usedFactIds: [], actionIntent: {}
  };
  const orchestrator = new YuqiOrchestrator({
    store,
    presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
    codex: {}, releaseExecutor: { executeTurn: async () => ({ draft }), executeLife: async () => ({ draft }) },
    clock: () => NOW, lifePlanningEnabled: false
  });
  return orchestrator.run(current.turnId).then(() => store.getTurn(current.turnId));
}

async function openFixture({ turnId = 'turn_race', kind = 'DIRECT_REPLY', commit = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-race-'));
  const path = join(root, 'runtime.sqlite');
  let store = new YuqiStore(path);
  const rolloutRows = [kind, ...(kind === 'DIRECT_REPLY' ? [] : ['DIRECT_REPLY'])].map(rolloutKey => ({
    rolloutKey,
    currentMode: 'legacy',
    rolloutPhase: 'stable',
    presetVersion: '1.9.2',
    pipelineChecksum: 'a'.repeat(64)
  }));
  store.initializeCognitionRolloutsInternal({
    rows: rolloutRows,
    now: 1
  });
  const before = store.getInteractionLane('yuqi', 'private_chat');
  if (!before) {
    store.claimInteractionLaneInternal({
      roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
      localSequence: 0, now: NOW
    });
  }
  if (kind === 'PROACTIVE_CHAT') {
    store.putLifePlan('yuqi', [{
      episodeId: `episode_${turnId}`,
      kind: 'personal',
      title: 'race source',
      status: 'active',
      startAt: NOW - 1_000,
      endAt: NOW + 60_000,
      checksum: 'a'.repeat(64),
      updatedAt: 1,
      payload: { summary: 'race source' }
    }]);
  }
  const currentLane = store.getInteractionLane('yuqi', 'private_chat');
  const input = envelope({ turnId, kind, deviceSeq: Number(currentLane?.localSequence || 0) + 1 });
  validateEnvelope(input);
  const rollout = store.getCognitionRollout(kind);
  const pair = resolvePipelinePair(rollout);
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: NOW });
  const annotationSnapshot = kind === 'PROACTIVE_CHAT'
    ? store.rebuildProactiveMotiveAuthorityInternal({ envelope: input }).annotationSnapshot
    : {};
  const created = store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: kind,
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: pair.visibleReleaseId,
    comparisonReleaseId: pair.comparisonReleaseId,
    comparisonDirection: pair.comparisonDirection,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(currentLane?.revision || 0),
    inputUserBatchId: input.context.currentBatch?.batchId || input.trigger?.triggerId || null,
    inputVisibilitySequence: input.context.visibilityCursor.localSequence,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot
  });
  let turn = created.turn;
  if (commit) {
    const proactiveEvidence = annotationSnapshot.proactiveMotiveAuthority?.candidates?.slice(0, 1)
      .map(candidate => candidate.motiveId) || [];
    const draft = {
      action: 'send',
      reply: 'race reply',
      bubblePlan: [{ text: 'race reply', purpose: 'reply' }],
      usedFactIds: [],
      actionIntent: {},
      proactiveMotiveEvidenceIds: proactiveEvidence,
      interactionDecision: { motiveEvidenceIds: proactiveEvidence }
    };
    const releaseExecutor = {
      executeTurn: async () => ({ draft }),
      executeLife: async () => { throw new Error('life execution is not used'); }
    };
    const orchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor, clock: () => NOW, lifePlanningEnabled: false
    });
    await orchestrator.run(turn.turnId);
    turn = store.getTurn(turn.turnId);
  }
  return {
    root,
    path,
    store,
    input,
    turn,
    close() {
      try { store.close(); } finally { rmSync(root, { recursive: true, force: true }); }
    }
  };
}

function createDirectTurnOnStore(store, turnId) {
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const input = envelope({
    turnId,
    kind: 'DIRECT_REPLY',
    deviceSeq: Number(lane?.localSequence || 0) + 1
  });
  validateEnvelope(input);
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const pair = resolvePipelinePair(rollout);
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: NOW });
  return store.createCanonicalVisibleTurnInternal({
    envelope: input,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: pair.visibleReleaseId,
    comparisonReleaseId: pair.comparisonReleaseId,
    comparisonDirection: pair.comparisonDirection,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: input.context.currentBatch.batchId,
    inputVisibilitySequence: input.context.visibilityCursor.localSequence,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
}

function createRetryOnStore(store, parent, parentInput, turnId, { preserveInputContext = false } = {}) {
  const retryInput = structuredClone(parentInput);
  retryInput.turnId = turnId;
  retryInput.deviceSeq = Number(parentInput.deviceSeq) + 1;
  retryInput.createdAt = NOW + 1;
  retryInput.context.visibilityCursor = cursor(
    preserveInputContext
      ? Number(parentInput.context.visibilityCursor.localSequence)
      : retryInput.deviceSeq
  );
  retryInput.context.retry = {
    retryOfTurnId: parent.turnId,
    canonicalMessageId: parentInput.message.messageId
  };
  retryInput.authority.retryOfTurnId = parent.turnId;
  retryInput.authority.claimedLineageRevision = Number(parent.lineageRevisionAtCreation) + 1;
  retryInput.authority.rootSourceId = parentInput.message.messageId;
  retryInput.authority.lineageKey = parent.authorityLineageKey;
  validateEnvelope(retryInput);
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: NOW });
  return store.createCanonicalVisibleTurnInternal({
    envelope: retryInput,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: parent.authoritativeReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane.revision),
    inputUserBatchId: parent.inputUserBatchId,
    inputVisibilitySequence: retryInput.context.visibilityCursor.localSequence,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
}

async function withFixture(options, fn) {
  const fixture = await openFixture(options);
  try { return await fn(fixture); } finally { fixture.close(); }
}

test('proactive_generating_then_user_batch', async () => {
  await withFixture({ turnId: 'turn_race_proactive_generating', kind: 'PROACTIVE_CHAT' }, ({ path, store, turn }) => {
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    assert.equal(lane.generatingTurnId, turn.turnId);
    assert.ok(['queued', 'open'].includes(store.getTurn(turn.turnId).state));
    const userTurn = createDirectTurnOnStore(store, 'turn_race_proactive_user');
    assert.equal(userTurn.inputUserBatchId, 'batch_turn_race_proactive_user');
    assert.equal(store.getCurrentUserBatch(userTurn.turnId).messageIds.length, 1);
    const superseded = store.getTurn(turn.turnId);
    assert.equal(superseded.state, 'failed');
    assert.deepEqual(JSON.parse(superseded.errorJson), {
      code: 'superseded_by_user_batch', supersededByTurnId: userTurn.turnId
    });
    const lineage = store.getTurnAuthorityLineage(turn.authorityLineageKey);
    assert.equal(lineage.state, 'cancelled');
    assert.equal(lineage.revision, 2);
    assert.equal(lineage.latestTurnId, turn.turnId);
    assert.equal(lineage.committedGroupId, null);
    assert.equal(lineage.redactedAt, null);
    assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 3);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?')
      .get(turn.turnId).value, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NOT NULL')
      .get(turn.turnId).value, 0);
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getTurn(turn.turnId).state, 'failed');
      assert.deepEqual(JSON.parse(reopened.getTurn(turn.turnId).errorJson), {
        code: 'superseded_by_user_batch', supersededByTurnId: userTurn.turnId
      });
      assert.equal(reopened.getTurnAuthorityLineage(turn.authorityLineageKey).state, 'cancelled');
      assert.equal(reopened.getInteractionLane('yuqi', 'private_chat').generatingTurnId, userTurn.turnId);
    } finally { reopened.close(); }
  });
});

test('proactive_outbox_then_user_batch', async () => {
  await withFixture({ turnId: 'turn_race_proactive_outbox', kind: 'PROACTIVE_CHAT', commit: true }, async ({ path, store, turn }) => {
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    assert.equal(lane.generatingTurnId, null);
    const outbox = store.outboxForTurn(turn.turnId);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].turnId, turn.turnId);
    const userTurn = createDirectTurnOnStore(store, 'turn_race_proactive_outbox_user');
    assert.equal(store.getCurrentUserBatch(userTurn.turnId).turnId, userTurn.turnId);
    assert.equal(store.getTurn(turn.turnId).state, 'committed');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?')
      .get(turn.turnId).value, 1);
    const sendCalls = [];
    const outboxWorker = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'device_pc_race', deviceToken: 't'.repeat(16),
      encryptionKeyBase64: Buffer.alloc(32).toString('base64'), store,
      fetchImpl: async (...args) => { sendCalls.push(args); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    });
    await outboxWorker.flushOnce();
    await outboxWorker.flushOnce();
    assert.equal(sendCalls.length, 1);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getTurn(turn.turnId).state, 'committed');
      const restartedOutbox = new ResultOutbox({
        relayUrl: 'https://relay.example', deviceId: 'device_pc_race', deviceToken: 't'.repeat(16),
        encryptionKeyBase64: Buffer.alloc(32).toString('base64'), store: reopened,
        fetchImpl: async (...args) => { sendCalls.push(args); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
      });
      await restartedOutbox.flushOnce();
      await restartedOutbox.flushOnce();
      assert.equal(sendCalls.length, 1);
    } finally { reopened.close(); }
  });
});

test('runtime_restart_before_visible_commit', async () => {
  await withFixture({ turnId: 'turn_race_restart_before_commit' }, async ({ path, store, turn }) => {
    store.commitFaultAfterStep = 1;
    await assert.rejects(
      () => commitExistingTurn(store, turn),
      /forced commit fault after step 1/
    );
    store.commitFaultAfterStep = null;
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.ok(['queued', 'open'].includes(reopened.getTurn(turn.turnId).state));
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts WHERE authoritative_turn_id = ?').get(turn.turnId).value, 0);
      await commitExistingTurn(reopened, reopened.getTurn(turn.turnId));
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts WHERE authoritative_turn_id = ?').get(turn.turnId).value, 1);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?').get(turn.turnId).value, 1);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NOT NULL').get(turn.turnId).value, 1);
    } finally { reopened.close(); }
  });
});

test('runtime_restart_after_visible_commit', async () => {
  await withFixture({ turnId: 'turn_race_restart_after_commit', commit: true }, async ({ path, store, turn }) => {
    const before = {
      receipts: store.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts WHERE authoritative_turn_id = ?').get(turn.turnId).value,
      groups: store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?').get(turn.turnId).value,
      jobs: store.db.prepare('SELECT COUNT(*) AS value FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).value,
      deliveries: store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ?').get(turn.turnId).value
    };
    const receipt = store.getVisibleCommitReceipt(turn.authorityLineageKey);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      const result = reopened.loadCanonicalBridgeResultInternal(turn.turnId);
      assert.equal(result.protocolVersion, 3);
      const replay = new YuqiOrchestrator({
        store: reopened,
        presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
        codex: {}, releaseExecutor: { executeTurn: async () => ({ draft: {} }), executeLife: async () => ({ draft: {} }) },
        clock: () => NOW, lifePlanningEnabled: false
      });
      const replayed = await replay.run(turn.turnId);
      assert.equal(replayed.authoritativeTurnId, receipt.authoritativeTurnId);
      assert.equal(replayed.commitChecksum, receipt.commitChecksum);
      assert.deepEqual({
        receipts: reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts WHERE authoritative_turn_id = ?').get(turn.turnId).value,
        groups: reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?').get(turn.turnId).value,
        jobs: reopened.db.prepare('SELECT COUNT(*) AS value FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).value,
        deliveries: reopened.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ?').get(turn.turnId).value
      }, before);
    } finally { reopened.close(); }
  });
});

test('original_retry_and_sibling_retry_compete', async () => {
  await withFixture({ turnId: 'turn_race_retry_parent' }, async ({ path, store, turn, input }) => {
    const failure = {
      name: 'Error', code: 'YUQI_TRANSIENT_EXECUTION_FAILURE', message: 'retry',
      failureClass: 'transient', retryAllowed: true
    };
    const failed = store.recordCanonicalTurnFailureInternal({
      turnId: turn.turnId, expectedState: turn.state,
      expectedTurnRevision: turn.turnRevision, failure
    });
    assert.equal(failed.state, 'failed');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ?').get(turn.turnId).value, 1);
    const sibling = new YuqiStore(path);
    const siblingTwo = new YuqiStore(path);
    try {
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() => createRetryOnStore(sibling, store.getTurn(turn.turnId), input, 'turn_race_retry_child_a')),
        Promise.resolve().then(() => createRetryOnStore(siblingTwo, store.getTurn(turn.turnId), input, 'turn_race_retry_child_b'))
      ]);
      assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
      const rejected = outcomes.find(item => item.status === 'rejected');
      assert.match(String(rejected.reason?.message || ''), /retry|revision|lane|authority/i);
      const children = store.db.prepare(`SELECT turn_id FROM turns WHERE retry_of_turn_id = ? ORDER BY turn_id`).all(turn.turnId);
      assert.equal(children.length, 1);
      assert.equal(store.getTurnAuthorityLineage(turn.authorityLineageKey).latestTurnId, children[0].turn_id);
    } finally {
      sibling.close();
      siblingTwo.close();
    }
  });
});

test('populated_v15_migrates_and_restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-race-v14-'));
  const path = join(root, 'runtime.sqlite');
  const clonePath = join(root, 'migration-clone.sqlite');
  try {
    const source = new YuqiStore(path, { targetVersion: 14 });
    source.initializeCognitionRolloutsInternal({ rows: [{
      rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
      presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64)
    }], now: 1 });
    source.claimInteractionLaneInternal({ roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
      localSequence: 0, now: NOW });
    const turn = createDirectTurnOnStore(source, 'turn_race_v14_populated');
    await commitExistingTurn(source, turn);
    assert.equal(source.userVersion(), 14);
    assert.equal(source.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts WHERE authoritative_turn_id = ?').get(turn.turnId).value, 1);
    assert.equal(source.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE authoritative_turn_id = ?').get(turn.turnId).value, 1);
    assert.equal(source.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NOT NULL').get(turn.turnId).value, 1);
    assert.ok(source.getInteractionLane('yuqi', 'private_chat').latestAuthoritativeGroupId);
    source.close();
    const before = readFileSync(path);
    copyFileSync(path, clonePath);
    const migrated = new YuqiStore(clonePath);
    try {
      assert.equal(migrated.userVersion(), 15);
      assert.ok(migrated.getTurn(turn.turnId));
      migrated.close();
      const reopened = new YuqiStore(clonePath);
      try { assert.equal(reopened.userVersion(), 15); assert.ok(reopened.getTurn(turn.turnId)); }
      finally { reopened.close(); }
    } finally {
      try { migrated.close(); } catch {}
    }
    assert.deepEqual(readFileSync(path), before);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('canary_rollback_while_turn_in_flight', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-race-canary-'));
  const path = join(root, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    let clockNow = NOW;
    const { controller, canary } = registerCanary(store, { clock: () => clockNow });
    assert.equal(canary.candidatePhase, 'canary');
    store.claimInteractionLaneInternal({ roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
      localSequence: 0, now: NOW });
    const inFlight = createDirectTurnOnStore(store, 'turn_race_canary_pinned');
    assert.equal(inFlight.comparisonMode, 'legacy_compare');
    const oldPins = store.getTurn(inFlight.turnId);
    const second = createDirectTurnOnStore(store, 'turn_race_canary_outstanding');
    await commitExistingTurn(store, second);
    assert.ok(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY', canaryEpoch: controller.getStatus('DIRECT_REPLY').canaryEpoch
    }).count >= 1);
    clockNow = NOW + Number(controller.getStatus('DIRECT_REPLY').canaryCompareDeadlineMs) + 1;
    const selected = controller.selectPipelinePairForFreshSubject('DIRECT_REPLY', { now: clockNow });
    assert.equal(selected.rollout.candidatePhase, 'rolled_back');
    assert.deepEqual(store.getTurn(inFlight.turnId), oldPins);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('same_fingerprint_adjacent_revisions', async () => {
  await withFixture({ turnId: 'turn_race_fingerprint_parent' }, async ({ path, store, turn, input }) => {
    const parent = store.getTurn(turn.turnId);
    const failed = store.recordCanonicalTurnFailureInternal({
      turnId: parent.turnId, expectedState: parent.state,
      expectedTurnRevision: parent.turnRevision,
      failure: { name: 'Error', code: 'YUQI_TRANSIENT_EXECUTION_FAILURE', message: 'retry',
        failureClass: 'transient', retryAllowed: true }
    });
    const child = createRetryOnStore(store, failed, input, 'turn_race_fingerprint_retry', {
      preserveInputContext: true
    });
    assert.equal(child.inputVisibilitySequence, failed.inputVisibilitySequence);
    assert.equal(child.inputUserBatchId, failed.inputUserBatchId);
    assert.equal(Number(child.lineageRevisionAtCreation), Number(failed.lineageRevisionAtCreation) + 1);
    assert.notEqual(Number(child.laneRevision), Number(failed.laneRevision));
    const parentFingerprint = generationFingerprint({
      roleId: failed.characterId, laneKey: failed.laneKey,
      inputVisibilitySequence: failed.inputVisibilitySequence,
      visibleGroup: { items: [{ content: 'same semantic result' }] }, actionSet: [],
      contextRevision: failed.agencySnapshotChecksum
    });
    const retryFingerprint = generationFingerprint({
      roleId: child.characterId, laneKey: child.laneKey,
      inputVisibilitySequence: child.inputVisibilitySequence,
      visibleGroup: { items: [{ content: 'same semantic result' }] }, actionSet: [],
      contextRevision: child.agencySnapshotChecksum
    });
    assert.equal(parentFingerprint, retryFingerprint);
    assert.notEqual(Number(failed.turnRevision), Number(child.turnRevision));
    assert.equal(child.generationFingerprint, failed.generationFingerprint);
    await commitExistingTurn(store, child, {
      action: 'send', reply: 'same semantic result',
      bubblePlan: [{ text: 'same semantic result', purpose: 'reply' }],
      usedFactIds: [], actionIntent: {}
    });
    const childReceipt = store.getVisibleCommitReceipt(child.authorityLineageKey);
    const childGroup = store.db.prepare(
      'SELECT generation_fingerprint FROM visible_result_groups WHERE group_id = ?'
    ).get(childReceipt.visibleGroupId);
    const committedChild = store.getTurn(child.turnId);
    assert.equal(childGroup.generation_fingerprint, committedChild.generationFingerprint);
    assert.equal(childGroup.generation_fingerprint, retryFingerprint);
    assert.equal(childGroup.generation_fingerprint, parentFingerprint);
    const beforeStaleCommit = {
      groups: store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value,
      receipts: store.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts').get().value,
      deliveries: store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value
    };
    const staleOrchestrator = new YuqiOrchestrator({
      store,
      presets: { current: () => ({ version: '2.0.0' }), compileFor: () => ({}) },
      codex: {}, releaseExecutor: {
        executeTurn: async () => ({ draft: {
          action: 'send', reply: 'same semantic result',
          bubblePlan: [{ text: 'same semantic result', purpose: 'reply' }],
          usedFactIds: [], actionIntent: {}
        } }),
        executeLife: async () => { throw new Error('life execution is not used'); }
      },
      clock: () => NOW, lifePlanningEnabled: false
    });
    let staleResult = null;
    let staleError = null;
    try { staleResult = await staleOrchestrator.run(failed.turnId); } catch (error) { staleError = error; }
    if (staleError) assert.match(String(staleError.message), /revision|state|conflict|immutable|failed/i);
    else assert.equal(staleResult.authoritativeTurnId, childReceipt.authoritativeTurnId);
    assert.deepEqual({
      groups: store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value,
      receipts: store.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts').get().value,
      deliveries: store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value
    }, beforeStaleCommit);
    assert.throws(() => store.recordCanonicalTurnFailureInternal({
      turnId: failed.turnId, expectedState: 'failed', expectedTurnRevision: parent.turnRevision,
      failure: { name: 'Error', code: 'YUQI_TRANSIENT_EXECUTION_FAILURE', message: 'stale',
        failureClass: 'transient', retryAllowed: true }
    }), /revision|conflict|immutable/i);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getVisibleCommitReceipt(child.authorityLineageKey).visibleGroupId, childReceipt.visibleGroupId);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups WHERE group_id = ?')
        .get(childReceipt.visibleGroupId).value, 1);
    } finally { reopened.close(); }
  });
});

test('cloud_waiting_does_not_block_next_local_turn', async () => {
  await withFixture({ turnId: 'turn_race_cloud_waiting' }, async ({ path, store, turn }) => {
    const failure = {
      name: 'Error', code: 'YUQI_TRANSIENT_EXECUTION_FAILURE', message: 'waiting',
      failureClass: 'transient', retryAllowed: true
    };
    const failed = store.recordCanonicalTurnFailureInternal({
      turnId: turn.turnId, expectedState: turn.state,
      expectedTurnRevision: turn.turnRevision, failure
    });
    assert.equal(failed.state, 'failed');
    assert.equal(store.outboxForTurn(turn.turnId).length, 1);
    let releaseNetwork;
    let networkStarted;
    const networkStartedPromise = new Promise(resolve => { networkStarted = resolve; });
    const networkGate = new Promise(resolve => { releaseNetwork = resolve; });
    const sendCalls = [];
    const worker = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'device_pc_race', deviceToken: 't'.repeat(16),
      encryptionKeyBase64: Buffer.alloc(32).toString('base64'), store,
      fetchImpl: async (...args) => {
        sendCalls.push(args);
        networkStarted();
        await networkGate;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    const flushPromise = worker.flushOnce();
    await networkStartedPromise;
    assert.equal(store.db.prepare('SELECT state FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NULL')
      .get(turn.turnId).state, 'pending');
    const next = new YuqiStore(path);
    try {
      const nextTurn = createDirectTurnOnStore(next, 'turn_race_cloud_waiting_next_local');
      assert.ok(nextTurn.turnId);
      assert.equal(next.getCurrentUserBatch(nextTurn.turnId).turnId, nextTurn.turnId);
      assert.ok(['queued', 'open'].includes(next.getTurn(nextTurn.turnId).state));
      assert.equal(store.getTurn(turn.turnId).state, 'failed');
      releaseNetwork();
      await flushPromise;
      assert.equal(sendCalls.length, 1);
      assert.equal(store.outboxForTurn(turn.turnId)[0].state, 'mailboxed');
      next.close();
      const reopened = new YuqiStore(path);
      try { assert.ok(reopened.getTurn(nextTurn.turnId)); }
      finally { reopened.close(); }
    } finally {
      releaseNetwork();
      try { next.close(); } catch {}
    }
  });
});

test('pc_android_receipt_conflict_is_quarantined', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-race-receipt-conflict-'));
  const path = join(root, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    store.initializeCognitionRolloutsInternal({ rows: [{
      rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable',
      presetVersion: '1.9.2', pipelineChecksum: 'a'.repeat(64)
    }], now: 1 });
    store.claimInteractionLaneInternal({ roleId: 'yuqi', laneKey: 'private_chat', expectedRevision: 0,
      localSequence: 0, now: NOW });
    const semantic = ANDROID_FALLBACK_FIXTURE.semantic;
    const message = {
      messageId: semantic.rootSourceId, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
      content: 'PC authority input', sentAt: 1000
    };
    const input = {
      protocolVersion: 3, turnId: semantic.authoritativeTurnId, characterId: 'yuqi',
      deviceId: 'device_pc_race', deviceSeq: 1, createdAt: 1000, kind: 'DIRECT_REPLY', message,
      context: { currentBatch: { batchId: 'batch_pc_android_conflict', messageIds: [message.messageId],
        startedAt: 1000, committedAt: 1000, messages: [message] }, visibilityCursor: cursor(1) },
      authority: { algorithm: 'al-authority-v1', roleId: 'yuqi', laneKey: 'private_chat',
        rootSourceId: semantic.rootSourceId, lineageKey: semantic.authorityLineageKey,
        claimedLineageRevision: 1, retryOfTurnId: null }
    };
    validateEnvelope(input);
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const pair = resolvePipelinePair(rollout);
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1000 });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope: input, rolloutKey: 'DIRECT_REPLY', expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: pair.visibleReleaseId, comparisonReleaseId: pair.comparisonReleaseId,
      comparisonDirection: pair.comparisonDirection, laneKey: 'private_chat', expectedLaneRevision: 1,
      inputUserBatchId: input.context.currentBatch.batchId, inputVisibilitySequence: 1,
      agencySnapshotChecksum: agency.checksum, annotationSnapshot: {}
    }).turn;
    await commitExistingTurn(store, turn);
    const receiptBefore = store.getVisibleCommitReceipt(semantic.authorityLineageKey);
    const groupCountBefore = store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value;
    const deliveryCountBefore = store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value;
    assert.throws(
      () => store.importExternalVisibleReceiptInternal(ANDROID_FALLBACK_FIXTURE),
      /cross-device authority conflict|external authority/i
    );
    assert.equal(store.getVisibleCommitReceipt(semantic.authorityLineageKey).authorityOrigin, 'pc');
    assert.equal(store.getVisibleCommitReceipt(semantic.authorityLineageKey).commitChecksum, receiptBefore.commitChecksum);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value, groupCountBefore);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value, deliveryCountBefore);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage = 'external_authority_conflict'").get().value, 1);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getVisibleCommitReceipt(semantic.authorityLineageKey).authorityOrigin, 'pc');
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value, groupCountBefore);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value, deliveryCountBefore);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage = 'external_authority_conflict'").get().value, 1);
      assert.throws(
        () => reopened.importExternalVisibleReceiptInternal(ANDROID_FALLBACK_FIXTURE),
        /cross-device authority conflict|external authority/i
      );
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value, groupCountBefore);
      assert.equal(reopened.db.prepare('SELECT COUNT(*) AS value FROM cloud_deliveries').get().value, deliveryCountBefore);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage = 'external_authority_conflict'").get().value, 1);
    } finally { reopened.close(); }
  } finally {
    try { store.close(); } catch {}
    rmSync(root, { recursive: true, force: true });
  }
});

test('conversation_clear_after_outbox_snapshot', async () => {
  await withFixture({ turnId: 'turn_race_clear_snapshot', commit: true }, async ({ path, store, turn }) => {
    const snapshot = store.outboxForTurn(turn.turnId);
    assert.ok(Array.isArray(snapshot));
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].turnId, turn.turnId);
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    const controlBody = {
      protocolVersion: 3, type: 'CONVERSATION_CLEAR', controlVersion: 'conversation_clear_v1',
      roleId: 'yuqi', peerId: 'device_pc_race', clearEpoch: Number(lane.clearEpoch) + 1,
      clearedThroughSequence: Number(lane.localSequence), requestedAt: NOW + 1,
      inputCursorChecksum: 'a'.repeat(64)
    };
    controlBody.controlId = `ctl_${contentHash({ contract: 'android-lifecycle-control-id-v1', controlKind: 'conversation_clear_v1',
      characterId: controlBody.roleId, peerId: controlBody.peerId, clearEpoch: controlBody.clearEpoch,
      clearedThroughSequence: controlBody.clearedThroughSequence, requestedAt: controlBody.requestedAt,
      inputCursorChecksum: controlBody.inputCursorChecksum })}`;
    const control = { ...controlBody, checksum: contentHash(controlBody) };
    const diagnosticsBefore = store.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage LIKE 'canonical_%'").get().value;
    const clearWriter = new YuqiStore(path);
    try {
      assert.doesNotThrow(() => clearWriter.applyConversationClearInternal(control, { appliedAt: NOW + 2 }));
    } finally { clearWriter.close(); }
    assert.equal(store.getTurn(turn.turnId).authorityRedactedAt, NOW + 2);
    const redactedDelivery = store.db.prepare(
      'SELECT state, payload_json, checksum FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NOT NULL'
    ).get(turn.turnId);
    assert.ok(['redaction_pending', 'redacted'].includes(redactedDelivery.state));
    assert.equal(redactedDelivery.payload_json, null);
    assert.equal(redactedDelivery.checksum, null);
    assert.throws(() => store.confirmAuthorityCloudDeliveryInternal({
      protocolVersion: 3, type: 'AUTHORITY_DELIVERY_RECEIPT', peerId: snapshot[0].peerId,
      turnId: turn.turnId, authorityLineageKey: turn.authorityLineageKey,
      visibleGroupId: snapshot[0].authorityGroupId, commitChecksum: snapshot[0].authorityCommitChecksum,
      terminalDisposition: 'visible', deliveredAt: NOW
    }), /redacted|authority|mailbox|conflict/i);
    const sends = [];
    const originalList = store.listPendingAuthorityCloudDeliveries.bind(store);
    let staleReturned = false;
    store.listPendingAuthorityCloudDeliveries = limit => {
      if (!staleReturned) {
        staleReturned = true;
        return snapshot;
      }
      return originalList(limit);
    };
    const worker = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'device_pc_race', deviceToken: 't'.repeat(16),
      encryptionKeyBase64: Buffer.alloc(32).toString('base64'), store,
      fetchImpl: async (...args) => {
        sends.push(args);
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    });
    const flushed = await worker.flushOnce();
    assert.equal(flushed.delivered, 0);
    assert.equal(sends.length, 0);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getTurn(turn.turnId).authorityRedactedAt, NOW + 2);
      assert.equal(reopened.listPendingAuthorityCloudDeliveries(100).length, 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NULL AND state IN ('waiting','pending')").get(turn.turnId).value, 0);
      assert.equal(reopened.listPendingCanonicalFailureCloudDeliveries(100).length, 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage LIKE 'canonical_%'").get().value, diagnosticsBefore);
    }
    finally { reopened.close(); }
  });
});

test('redacted_group_stale_outbox_snapshot_does_not_send', async () => {
  await withFixture({ turnId: 'turn_race_redacted_stale', commit: true }, async ({ path, store, turn }) => {
    const snapshot = store.outboxForTurn(turn.turnId);
    assert.equal(snapshot.length, 1);
    assert.equal(snapshot[0].authorityGroupId != null, true);
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    const body = {
      protocolVersion: 3, type: 'CONVERSATION_CLEAR', controlVersion: 'conversation_clear_v1', roleId: 'yuqi',
      peerId: 'device_pc_race', clearEpoch: Number(lane.clearEpoch) + 1,
      clearedThroughSequence: Number(lane.localSequence), requestedAt: NOW + 3, inputCursorChecksum: 'b'.repeat(64)
    };
    body.controlId = `ctl_${contentHash({ contract: 'android-lifecycle-control-id-v1', controlKind: 'conversation_clear_v1',
      characterId: body.roleId, peerId: body.peerId, clearEpoch: body.clearEpoch,
      clearedThroughSequence: body.clearedThroughSequence, requestedAt: body.requestedAt,
      inputCursorChecksum: body.inputCursorChecksum })}`;
    const control = { ...body, checksum: contentHash(body) };
    const diagnosticsBefore = store.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage LIKE 'canonical_%'").get().value;
    store.applyConversationClearInternal(control, { appliedAt: NOW + 4 });
    const originalList = store.listPendingAuthorityCloudDeliveries.bind(store);
    let staleReturned = false;
    store.listPendingAuthorityCloudDeliveries = limit => {
      if (!staleReturned) {
        staleReturned = true;
        return snapshot;
      }
      return originalList(limit);
    };
    const sendAttempts = [];
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example', deviceId: 'device_pc_race', deviceToken: 't'.repeat(16),
      encryptionKeyBase64: Buffer.alloc(32).toString('base64'), store,
      fetchImpl: async (...args) => { sendAttempts.push(args); return { ok: true, status: 200, json: async () => ({ ok: true }) }; }
    });
    const flushed = await outbox.flushOnce();
    assert.equal(flushed.delivered, 0);
    assert.equal(sendAttempts.length, 0);
    const result = store.loadCanonicalBridgeResultInternal(turn.turnId);
    assert.equal(result.status, 'redacted');
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.listPendingAuthorityCloudDeliveries(100).length, 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM cloud_deliveries WHERE turn_id = ? AND authority_group_id IS NULL AND state IN ('waiting','pending')").get(turn.turnId).value, 0);
      assert.equal(reopened.listPendingCanonicalFailureCloudDeliveries(100).length, 0);
      assert.equal(reopened.db.prepare("SELECT COUNT(*) AS value FROM diagnostics WHERE stage LIKE 'canonical_%'").get().value, diagnosticsBefore);
    } finally { reopened.close(); }
  });
});
