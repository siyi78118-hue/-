import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { YuqiOrchestrator } from '../src/orchestrator.mjs';

const SHA_STABLE = '1'.repeat(64);
const SHA_CANDIDATE = '2'.repeat(64);
const SHA_AGENCY = '3'.repeat(64);
const SHA_AGENCY_REFRESHED = '4'.repeat(64);
const JPEG_1X1 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EH//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EH//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EH//2Q==';

function directEnvelope({
  protocolVersion = 2,
  turnId = 'turn_direct_1',
  characterId = 'yuqi',
  deviceSeq = 1,
  messageId = 'msg_direct_1',
  content = '在吗',
  sentAt = 1_000,
  retry = null
} = {}) {
  return {
    protocolVersion,
    turnId,
    characterId,
    deviceId: 'phone',
    deviceSeq,
    createdAt: sentAt,
    kind: 'DIRECT_REPLY',
    message: {
      messageId,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: characterId,
      content,
      sentAt
    },
    ...(retry ? { context: { retry } } : {})
  };
}

function pinnedCanonicalTurn(envelope, overrides = {}) {
  return {
    turnId: envelope.turnId,
    characterId: envelope.characterId,
    state: 'queued',
    route: 'deep',
    routeReasons: ['release-pinned'],
    resultAuthorityVersion: 1,
    authorityLineageKey: 'lineage_direct_1',
    turnRevision: 1,
    lineageRevisionAtCreation: 1,
    rolloutKey: envelope.kind,
    rolloutRevision: 7,
    rolloutEvidenceEpoch: 2,
    pipelineMode: 'shadow',
    comparisonMode: 'cognition_compare',
    pipelineChecksum: SHA_STABLE,
    authoritativeReleaseId: 'stable-r2',
    comparisonReleaseId: 'candidate-r3',
    authoritativePipelineChecksum: SHA_STABLE,
    comparisonPipelineChecksum: SHA_CANDIDATE,
    presetVersion: '2.0.0',
    shadowEpoch: 3,
    canaryEpoch: null,
    canarySlot: null,
    laneKey: `direct:${envelope.characterId}`,
    laneRevision: 5,
    inputVisibilitySequence: 4,
    inputClearEpoch: 0,
    agencySnapshotChecksum: SHA_AGENCY,
    envelopeJson: JSON.stringify(envelope),
    ...overrides
  };
}

function releasePair() {
  return {
    visibleReleaseId: 'stable-r2',
    comparisonReleaseId: 'candidate-r3',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    candidatePhase: 'shadow'
  };
}

function orchestrationFixture({ turns = [], canonicalRouteReasons = ['release-pinned'] } = {}) {
  const calls = {
    agencyReads: [],
    canonicalCreates: [],
    canonicalRoutes: [],
    legacyCreates: [],
    legacyRoutes: [],
    freshSelections: [],
    diagnostics: [],
    releaseExecutions: []
  };
  const turnMap = new Map(turns.map(turn => [turn.turnId, turn]));
  const lineageMap = new Map();
  for (const turn of turns) {
    if (turn.authorityLineageKey && !lineageMap.has(turn.authorityLineageKey)) {
      lineageMap.set(turn.authorityLineageKey, {
        lineageKey: turn.authorityLineageKey,
        state: 'open',
        latestTurnId: turn.turnId,
        revision: turn.lineageRevisionAtCreation || 1,
        committedGroupId: null
      });
    }
  }
  const store = {
    getTurn: turnId => turnMap.get(turnId) || null,
    getTurnAuthorityLineage: lineageKey => lineageMap.get(lineageKey) || null,
    getVisibleCommitReceipt: () => null,
    getCurrentUserBatch: () => null,
    getInteractionLane: characterId => ({
      roleId: characterId,
      laneKey: `direct:${characterId}`,
      revision: 4,
      localSequence: 4,
      clearEpoch: 0,
      clearedThroughSequence: 0
    }),
    readAgencyAuthoritySnapshotInternal(input = {}) {
      calls.agencyReads.push(input);
      return {
        checksum: SHA_AGENCY,
        constraints: [],
        preferenceFacts: [],
        stances: []
      };
    },
    createCanonicalVisibleTurnInternal(input) {
      calls.canonicalCreates.push(input);
      if (input.envelope.protocolVersion === 3) {
        throw new Error('unsupported protocolVersion: 3');
      }
      const turn = pinnedCanonicalTurn(input.envelope, {
        rolloutRevision: input.expectedRolloutRevision,
        authoritativeReleaseId: input.authoritativeReleaseId,
        comparisonReleaseId: input.comparisonReleaseId,
        laneKey: input.laneKey,
        laneRevision: input.expectedLaneRevision + 1,
        inputVisibilitySequence: input.inputVisibilitySequence,
        inputClearEpoch: input.inputClearEpoch,
        agencySnapshotChecksum: input.agencySnapshotChecksum,
        routeReasons: canonicalRouteReasons
      });
      turnMap.set(turn.turnId, turn);
      return { status: 'created', turn, agencySnapshot: this.readAgencyAuthoritySnapshotInternal() };
    },
    listMessages: () => [],
    setTurnRoute(turnId, route, reasons) {
      calls.legacyRoutes.push({ turnId, route, reasons });
      const turn = { ...turnMap.get(turnId), route, routeReasons: reasons };
      turnMap.set(turnId, turn);
      return turn;
    },
    setCanonicalTurnRouteInternal(input) {
      calls.canonicalRoutes.push(input);
      const turn = {
        ...turnMap.get(input.turnId),
        route: input.route,
        routeReasons: input.reasons,
        turnRevision: input.expectedTurnRevision + 1
      };
      turnMap.set(input.turnId, turn);
      return turn;
    },
    putDiagnostic(input) {
      calls.diagnostics.push(input);
    }
  };
  const promotionController = {
    createTurn({ envelope }) {
      calls.legacyCreates.push(envelope);
      const turn = {
        turnId: envelope.turnId,
        characterId: envelope.characterId,
        state: 'queued',
        route: 'deep',
        routeReasons: ['compatibility'],
        resultAuthorityVersion: 0,
        envelopeJson: JSON.stringify(envelope)
      };
      turnMap.set(turn.turnId, turn);
      return turn;
    },
    selectPipelinePairForFreshSubject(rolloutKey, options) {
      calls.freshSelections.push({ rolloutKey, options });
      return {
        rollout: { rolloutKey, revision: 7, evidenceEpoch: 2 },
        pair: releasePair()
      };
    }
  };
  const releaseExecutor = {
    async executeTurn(input) {
      calls.releaseExecutions.push(input);
      return {
        releaseId: input.releaseId,
        releaseChecksum: input.releaseChecksum,
        draft: { action: 'send', reply: '恢复成功' },
        dryRun: false
      };
    },
    async executeLife() {
      throw new Error('life execution is not used by direct recovery tests');
    }
  };
  const orchestrator = new YuqiOrchestrator({
    store,
    presets: {
      current: () => ({ version: '2.0.0' }),
      compileFor: () => ({})
    },
    codex: {},
    promotionController,
    releaseExecutor,
    clock: () => 20_000,
    lifePlanningEnabled: false
  });
  return {
    calls,
    lineageMap,
    orchestrator,
    promotionController,
    releaseExecutor,
    store,
    turnMap
  };
}

test('new Yuqi protocol-v2 entry creates canonical authority independently of wire v3', () => {
  const fixture = orchestrationFixture();
  const envelope = directEnvelope();

  const accepted = fixture.orchestrator.accept(envelope);

  assert.equal(accepted.resultAuthorityVersion, 1);
  assert.equal(fixture.calls.canonicalCreates.length, 1);
  assert.equal(fixture.calls.legacyCreates.length, 0);
  assert.equal(fixture.calls.freshSelections.length, 1);
  assert.equal(fixture.calls.freshSelections[0].rolloutKey, 'DIRECT_REPLY');
  assert.equal(fixture.calls.freshSelections[0].options.now, 20_000);
});

test('fresh canonical routing uses the revisioned canonical writer', () => {
  const fixture = orchestrationFixture({ canonicalRouteReasons: [] });
  const accepted = fixture.orchestrator.accept(directEnvelope());

  assert.equal(fixture.calls.canonicalRoutes.length, 1);
  assert.equal(fixture.calls.legacyRoutes.length, 0);
  assert.equal(fixture.calls.canonicalRoutes[0].expectedTurnRevision, 1);
  assert.deepEqual(accepted.routeReasons, fixture.calls.canonicalRoutes[0].reasons);
});

test('wire v3 stays dormant while wire v1 and non-Yuqi turns remain version zero', () => {
  const fixture = orchestrationFixture();

  assert.throws(
    () => fixture.orchestrator.accept(directEnvelope({
      protocolVersion: 3,
      turnId: 'turn_wire_v3',
      messageId: 'msg_wire_v3'
    })),
    /unsupported protocolVersion|protocol version/i
  );
  const wireV1 = fixture.orchestrator.accept(directEnvelope({
    protocolVersion: 1,
    turnId: 'turn_wire_v1',
    messageId: 'msg_wire_v1'
  }));
  const nonYuqi = fixture.orchestrator.accept(directEnvelope({
    turnId: 'turn_non_yuqi',
    characterId: 'other',
    messageId: 'msg_non_yuqi'
  }));

  assert.equal(wireV1.resultAuthorityVersion, 0);
  assert.equal(nonYuqi.resultAuthorityVersion, 0);
  assert.equal(fixture.calls.canonicalCreates.length, 0);
  assert.deepEqual(
    fixture.calls.legacyCreates.map(envelope => envelope.turnId),
    ['turn_wire_v1', 'turn_non_yuqi']
  );
});

test('persisted version-one recovery uses its pinned authority and never recreates the turn', async () => {
  const envelope = directEnvelope({ turnId: 'turn_recover_v1', messageId: 'msg_recover_v1' });
  const persisted = pinnedCanonicalTurn(envelope, {
    state: 'memory_done',
    laneRevision: 9,
    authoritativeReleaseId: 'stable-r2',
    comparisonReleaseId: 'candidate-r3'
  });
  const fixture = orchestrationFixture({ turns: [persisted] });
  fixture.store.readCanonicalCommitOutcomeInternal = () => null;

  assert.equal(typeof fixture.orchestrator.recover, 'function');
  const recovered = await fixture.orchestrator.recover(persisted.turnId);

  assert.equal(recovered.recoveryPath, 'canonical');
  assert.equal(recovered.authoritativeReleaseId, persisted.authoritativeReleaseId);
  assert.equal(recovered.comparisonReleaseId, persisted.comparisonReleaseId);
  assert.equal(recovered.laneRevision, persisted.laneRevision);
  assert.equal(fixture.calls.canonicalCreates.length, 0);
  assert.equal(fixture.calls.legacyCreates.length, 0);
  assert.equal(fixture.calls.freshSelections.length, 0);
});

test('missing or inconsistent canonical lineage is quarantined without regeneration', async t => {
  for (const scenario of [
    {
      name: 'missing lineage',
      mutate(fixture, turn) {
        fixture.lineageMap.delete(turn.authorityLineageKey);
      },
      reason: /missing.*lineage|lineage.*missing/i
    },
    {
      name: 'lineage points at a different latest turn',
      mutate(fixture, turn) {
        fixture.lineageMap.set(turn.authorityLineageKey, {
          lineageKey: turn.authorityLineageKey,
          state: 'open',
          latestTurnId: 'turn_other',
          revision: turn.lineageRevisionAtCreation
        });
      },
      reason: /lineage.*invariant|latest.*turn/i
    }
  ]) {
    await t.test(scenario.name, async () => {
      const envelope = directEnvelope({
        turnId: `turn_quarantine_${scenario.name.replaceAll(' ', '_')}`,
        messageId: `msg_quarantine_${scenario.name.replaceAll(' ', '_')}`
      });
      const persisted = pinnedCanonicalTurn(envelope, { state: 'memory_done' });
      const fixture = orchestrationFixture({ turns: [persisted] });
      scenario.mutate(fixture, persisted);

      assert.equal(typeof fixture.orchestrator.recover, 'function');
      const result = await fixture.orchestrator.recover(persisted.turnId);

      assert.equal(result.status, 'quarantined');
      assert.match(result.reasonCode, scenario.reason);
      assert.equal(fixture.calls.canonicalCreates.length, 0);
      assert.equal(fixture.calls.legacyCreates.length, 0);
      assert.equal(fixture.calls.releaseExecutions.length, 0);
    });
  }
});

test('canonical retry inherits release pins while refreshing lane and agency authority', () => {
  const originalEnvelope = directEnvelope({
    turnId: 'turn_retry_original',
    messageId: 'msg_retry_canonical',
    content: '原消息',
    sentAt: 5_000
  });
  const parent = pinnedCanonicalTurn(originalEnvelope, {
    state: 'failed',
    rolloutRevision: 12,
    rolloutEvidenceEpoch: 5,
    authoritativeReleaseId: 'stable-r2',
    comparisonReleaseId: 'candidate-r3',
    authoritativePipelineChecksum: SHA_STABLE,
    comparisonPipelineChecksum: SHA_CANDIDATE,
    presetVersion: '2.0.0',
    shadowEpoch: 8,
    laneRevision: 5,
    inputVisibilitySequence: 4,
    agencySnapshotChecksum: SHA_AGENCY
  });
  const fixture = orchestrationFixture({ turns: [parent] });
  fixture.store.getInteractionLane = () => ({
    roleId: 'yuqi',
    laneKey: 'direct:yuqi',
    revision: 9,
    localSequence: 9,
    clearEpoch: 0,
    clearedThroughSequence: 0
  });
  fixture.store.readAgencyAuthoritySnapshotInternal = () => ({
    checksum: SHA_AGENCY_REFRESHED,
    constraints: [],
    preferenceFacts: [],
    stances: []
  });
  fixture.promotionController.selectPipelinePairForFreshSubject = () => {
    throw new Error('canonical retry must not resolve the current rollout');
  };
  const retryEnvelope = directEnvelope({
    turnId: 'turn_retry_child',
    deviceSeq: 2,
    messageId: 'msg_retry_canonical',
    content: '原消息',
    sentAt: 5_000,
    retry: {
      retryOfTurnId: parent.turnId,
      canonicalMessageId: 'msg_retry_canonical'
    }
  });

  const retry = fixture.orchestrator.accept(retryEnvelope);

  assert.equal(retry.resultAuthorityVersion, 1);
  assert.equal(fixture.calls.canonicalCreates.length, 1);
  assert.equal(fixture.calls.legacyCreates.length, 0);
  const creation = fixture.calls.canonicalCreates[0];
  assert.equal(creation.expectedRolloutRevision, parent.rolloutRevision);
  assert.equal(creation.authoritativeReleaseId, parent.authoritativeReleaseId);
  assert.equal(creation.comparisonReleaseId, parent.comparisonReleaseId);
  assert.equal(creation.expectedLaneRevision, 9);
  assert.equal(creation.inputVisibilitySequence, 9);
  assert.equal(creation.agencySnapshotChecksum, SHA_AGENCY_REFRESHED);
  assert.equal(retry.authoritativePipelineChecksum, parent.authoritativePipelineChecksum);
  assert.equal(retry.comparisonPipelineChecksum, parent.comparisonPipelineChecksum);
  assert.equal(retry.presetVersion, parent.presetVersion);
  assert.equal(retry.laneRevision, 10);
  assert.equal(retry.agencySnapshotChecksum, SHA_AGENCY_REFRESHED);
});

test('committed and redacted canonical create replays are terminal before execution', async t => {
  for (const scenario of [
    {
      name: 'already committed',
      creation: {
        status: 'already_committed',
        receipt: {
          authoritativeTurnId: 'turn_committed_authority',
          authorityLineageKey: 'lineage_committed_authority',
          visibleGroupId: 'group_committed_authority',
          commitChecksum: 'a'.repeat(64)
        }
      },
      expected: {
        status: 'already_committed',
        terminal: true,
        turnId: 'turn_committed_authority'
      }
    },
    {
      name: 'redacted without receipt',
      creation: {
        status: 'redacted',
        receipt: null,
        lineage: {
          lineageKey: 'lineage_redacted_authority',
          latestTurnId: 'turn_redacted_authority'
        }
      },
      expected: {
        status: 'redacted',
        terminal: true,
        turnId: 'turn_redacted_authority',
        visible: false
      }
    }
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = orchestrationFixture();
      fixture.store.createCanonicalVisibleTurnInternal = input => {
        fixture.calls.canonicalCreates.push(input);
        return structuredClone(scenario.creation);
      };

      const result = await fixture.orchestrator.process(directEnvelope());

      assert.equal(result.status, scenario.expected.status);
      assert.equal(result.terminal, scenario.expected.terminal);
      assert.equal(result.turnId, scenario.expected.turnId);
      if (Object.hasOwn(scenario.expected, 'visible')) {
        assert.equal(result.visible, scenario.expected.visible);
      }
      assert.equal(fixture.calls.releaseExecutions.length, 0);
    });
  }
});

test('canonical creation and recovery use the same persisted interaction time order', async () => {
  const trigger = {
    protocolVersion: 2,
    turnId: 'turn_trigger_interaction_time',
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 81,
    createdAt: 81_000,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId: 'trigger_interaction_time',
      triggerType: 'proactive_chat',
      scheduledFor: 79_000,
      executedAt: 80_000,
      dueAt: 78_000,
      context: {}
    }
  };
  const fresh = orchestrationFixture();
  fresh.orchestrator.accept(trigger);
  assert.equal(fresh.calls.agencyReads.find(read => read.at != null).at, 80_000);

  const persisted = pinnedCanonicalTurn(trigger, {
    state: 'memory_done',
    agencySnapshotChecksum: SHA_AGENCY
  });
  const recovery = orchestrationFixture({ turns: [persisted] });
  recovery.store.readCanonicalCommitOutcomeInternal = () => null;
  recovery.store.readAgencyAuthoritySnapshotInternal = input => {
    recovery.calls.agencyReads.push(input);
    return {
      checksum: SHA_AGENCY_REFRESHED,
      constraints: [],
      preferenceFacts: [],
      stances: []
    };
  };

  await assert.rejects(
    () => recovery.orchestrator.run(persisted.turnId),
    /agency authority is stale/
  );
  assert.equal(recovery.calls.agencyReads.at(-1).at, 80_000);
});

test('canonical image execution strips data urls, forwards local paths, and always cleans them', async () => {
  const envelope = directEnvelope({
    turnId: 'turn_canonical_image',
    messageId: 'msg_canonical_image',
    content: '[图片]'
  });
  envelope.message.attachments = [{
    attachmentId: 'att_canonical_image',
    messageId: envelope.message.messageId,
    kind: 'image',
    mime: 'image/jpeg',
    name: 'canonical.jpg',
    width: 1,
    height: 1,
    bytes: Buffer.from(JPEG_1X1, 'base64').length,
    dataUrl: `data:image/jpeg;base64,${JPEG_1X1}`
  }];
  const persisted = pinnedCanonicalTurn(envelope, { state: 'memory_done' });
  const fixture = orchestrationFixture({ turns: [persisted] });
  fixture.store.readCanonicalCommitOutcomeInternal = () => null;
  fixture.releaseExecutor.executeTurn = async input => {
    fixture.calls.releaseExecutions.push(input);
    throw new Error('image provider stop');
  };

  await assert.rejects(
    () => fixture.orchestrator.run(persisted.turnId),
    /image provider stop/
  );

  const execution = fixture.calls.releaseExecutions[0].execution;
  assert.equal(execution.localImagePaths.length, 1);
  assert.equal(existsSync(execution.localImagePaths[0]), false);
  assert.doesNotMatch(JSON.stringify(execution.envelope), /base64,/);
  assert.doesNotMatch(JSON.stringify(execution.currentBatch), /base64,/);
});
