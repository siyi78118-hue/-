import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  deriveAuthorityLineageKey,
  deriveVisibleActionId,
  deriveVisibleGroupId,
  deriveVisibleMessageId
} from '../src/authority-identity.mjs';
import { projectBridgeResultForWire } from '../src/bridge-result-projector.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { contentHash, validateEnvelope } from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/authority-identity-v1.json', import.meta.url),
  'utf8'
));

test('shared authority identity matches every frozen Task 10 vector', () => {
  for (const vector of fixture.vectors) {
    const lineageKey = deriveAuthorityLineageKey(vector);
    assert.equal(lineageKey, vector.lineageKey, vector.name);
    assert.equal(deriveVisibleGroupId(lineageKey), vector.groupId, vector.name);
    assert.equal(deriveVisibleMessageId(vector.groupId, vector.ordinal), vector.messageId, vector.name);
    assert.equal(deriveVisibleActionId(vector.groupId, vector.ordinal), vector.actionId, vector.name);
  }
});

const SHA_A = 'a'.repeat(64);

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-bridge-v3-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    return run({ store, path });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function ensureRollout(store, rolloutKey) {
  if (store.getCognitionRollout(rolloutKey)) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey,
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: SHA_A
    }],
    now: 1
  });
}

function ensureDirectRollout(store) {
  ensureRollout(store, 'DIRECT_REPLY');
}

function v3DirectEnvelope({
  turnId = 'turn_bridge_v3_1',
  deviceSeq = 1,
  rootMessageId = 'msg_bridge_v3_root',
  claimedLineageRevision = 1,
  retryOfTurnId = null,
  localSequence = 1,
  native = null,
  ui = null,
  clearEpoch = 0,
  clearedThroughSequence = 0
} = {}) {
  const rootToken = rootMessageId.replace(/[^A-Za-z0-9_-]/g, '_');
  const messages = [0, 1, 2].map(index => ({
    messageId: index === 2 ? rootMessageId : `msg_bridge_v3_prior_${rootToken}_${index}`,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: index === 2 ? '最后一条' : `前一条${index}`,
    sentAt: 10_000 + index
  }));
  const laneKey = 'private_chat';
  const lineageKey = deriveAuthorityLineageKey({
    roleId: 'yuqi', laneKey, rootSourceId: rootMessageId
  });
  return {
    protocolVersion: 3,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq,
    createdAt: 10_003 + deviceSeq,
    kind: 'DIRECT_REPLY',
    message: messages.at(-1),
    context: {
      currentBatch: {
        batchId: `batch_bridge_v3_${rootToken}`,
        messageIds: messages.map(message => message.messageId),
        startedAt: messages[0].sentAt,
        committedAt: 10_003,
        messages
      },
      ...(retryOfTurnId ? {
        retry: { retryOfTurnId, canonicalMessageId: rootMessageId }
      } : {}),
      visibilityCursor: {
        nativeCompletedTurnId: native?.turnId ?? null,
        nativeCompletedGroupId: native?.groupId ?? null,
        nativeCompletedSequence: native?.sequence ?? 0,
        uiAppliedTurnId: ui?.turnId ?? null,
        uiAppliedGroupId: ui?.groupId ?? null,
        uiAppliedSequence: ui?.sequence ?? 0,
        localSequence,
        clearedThroughSequence,
        clearEpoch,
        clearedAt: clearEpoch ? 9_999 : 0,
        chatOpen: true,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: rootMessageId,
      lineageKey,
      claimedLineageRevision,
      retryOfTurnId
    }
  };
}

function canonicalCreateInput(store, rawEnvelope) {
  ensureDirectRollout(store);
  const envelope = validateEnvelope(rawEnvelope);
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi', at: envelope.message.sentAt
  });
  return {
    envelope,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: envelope.context.currentBatch.batchId,
    inputVisibilitySequence: envelope.protocolVersion === 3
      ? envelope.context.visibilityCursor.localSequence
      : Number(lane?.localSequence || 0),
    inputClearEpoch: envelope.protocolVersion === 3
      ? envelope.context.visibilityCursor.clearEpoch
      : Number(lane?.clearEpoch || 0),
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  };
}

function v3AutomaticEnvelope({
  turnId = 'turn_bridge_v3_auto',
  triggerId = 'trigger_bridge_v3_auto',
  claimedLineageRevision = 1,
  localSequence = 1,
  nativeAnchorId = null,
  uiAnchorId = null
} = {}) {
  const laneKey = 'private_chat';
  return {
    protocolVersion: 3,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 50,
    createdAt: 30_000,
    kind: 'PROACTIVE_CHAT',
    trigger: {
      triggerId,
      triggerType: 'proactive_chat',
      scheduledFor: 29_000,
      executedAt: 30_000
    },
    context: {
      visibilityCursor: {
        nativeCompletedTurnId: nativeAnchorId,
        nativeCompletedGroupId: nativeAnchorId,
        nativeCompletedSequence: 0,
        uiAppliedTurnId: uiAnchorId,
        uiAppliedGroupId: uiAnchorId,
        uiAppliedSequence: 0,
        localSequence,
        clearedThroughSequence: 0,
        clearEpoch: 0,
        clearedAt: 0,
        chatOpen: false,
        quotedMessageId: null
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({
        roleId: 'yuqi', laneKey, rootSourceId: triggerId
      }),
      claimedLineageRevision,
      retryOfTurnId: null
    }
  };
}

function canonicalAutomaticInput(store, rawEnvelope) {
  const envelope = validateEnvelope(rawEnvelope);
  ensureRollout(store, envelope.kind);
  const rollout = store.getCognitionRollout(envelope.kind);
  const lane = store.getInteractionLane(envelope.characterId, envelope.authority.laneKey);
  const agency = store.readAgencyAuthoritySnapshotInternal({
    roleId: envelope.characterId, at: envelope.trigger.executedAt
  });
  return {
    envelope,
    rolloutKey: envelope.kind,
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: envelope.authority.laneKey,
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: envelope.trigger.triggerId,
    inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
    inputClearEpoch: envelope.context.visibilityCursor.clearEpoch,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  };
}

function authoritySnapshot(store) {
  const tables = [
    'turns', 'turn_authority_lineages', 'current_user_batches',
    'current_user_batch_items', 'messages', 'interaction_lanes',
    'visible_result_groups', 'visible_commit_receipts', 'sync_log'
  ];
  return Object.fromEntries(tables.map(table => [
    table,
    store.db.prepare(`SELECT * FROM ${table}`).all()
      .map(row => JSON.stringify(row))
      .sort()
  ]));
}

function assertZeroWrites(store, operation, pattern) {
  const before = authoritySnapshot(store);
  assert.throws(operation, pattern);
  assert.deepEqual(authoritySnapshot(store), before);
}

function createV3(store, options = {}) {
  const input = canonicalCreateInput(store, v3DirectEnvelope(options));
  return { input, result: store.createCanonicalVisibleTurnInternal(input) };
}

function failV3Retryably(store, turn, failure = {}) {
  return store.recordCanonicalTurnFailureInternal({
    turnId: turn.turnId,
    expectedState: turn.state,
    expectedTurnRevision: turn.turnRevision,
    failure: { failureClass: 'transient', retryAllowed: true, ...failure }
  });
}

function commitBridgeResult(store, turn) {
  let current = store.setCanonicalTurnRouteInternal({
    turnId: turn.turnId,
    expectedState: turn.state,
    expectedTurnRevision: turn.turnRevision,
    route: 'deep',
    reasons: ['bridge-route']
  });
  current = store.claimCanonicalTurnInternal({
    turnId: current.turnId,
    workerId: 'bridge-worker',
    expectedTurnRevision: current.turnRevision
  });
  let lane = store.getInteractionLane('yuqi', current.laneKey);
  while (lane.revision < 7) {
    lane = store.claimInteractionLaneInternal({
      roleId: 'yuqi',
      laneKey: current.laneKey,
      expectedRevision: lane.revision,
      generatingTurnId: current.turnId,
      latestUserBatchId: current.inputUserBatchId,
      localSequence: current.inputVisibilitySequence,
      now: 19_000 + lane.revision
    });
  }
  const visibleGroup = {
    items: [
      { content: '第一段', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' },
      { content: '第二段', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }
    ]
  };
  const actionDraft = { kind: 'moment_create', payload: { text: '桥接动态' } };
  const target = store.resolveCanonicalActionTargetInternal({ turn: current, action: actionDraft });
  const actionSet = [{
    ...actionDraft,
    targetKey: target.targetKey,
    targetRevision: target.targetRevision
  }];
  const state = store.getCognitiveState('yuqi');
  return commitVisibleResult({
    store,
    turnId: current.turnId,
    authorityLineageKey: current.authorityLineageKey,
    laneKey: current.laneKey,
    expectedTurnRevision: current.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(current.authorityLineageKey).revision,
    expectedLaneRevision: lane.revision,
    expectedCognitiveStateRevision: Number(state?.revision || 0),
    expectedLatestUserBatchId: current.inputUserBatchId,
    inputVisibilitySequence: current.inputVisibilitySequence,
    agencySnapshotChecksum: current.agencySnapshotChecksum,
    authoritativeReleaseId: current.authoritativeReleaseId,
    visibleGroup,
    actionSet,
    statePatch: { mood: 'warm', openThreads: [], currentStances: [] },
    memoryJobs: [],
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: current.characterId,
      laneKey: current.laneKey,
      inputVisibilitySequence: current.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: current.agencySnapshotChecksum
    }),
    now: 20_000
  });
}

test('v3 canonical creation owns revision claims and cursor sequencing transactionally', () =>
  withStore(({ store }) => {
    const firstInput = canonicalCreateInput(store, v3DirectEnvelope());
    const first = store.createCanonicalVisibleTurnInternal(firstInput);
    assert.equal(first.turn.resultAuthorityVersion, 1);
    assert.equal(first.turn.inputVisibilitySequence, 1);
    assert.equal(first.turn.lineageRevisionAtCreation, 1);

    const replay = store.createCanonicalVisibleTurnInternal(firstInput);
    assert.equal(replay.turn.turnId, first.turn.turnId);

    const failed = failV3Retryably(store, first.turn);
    assert.equal(failed.state, 'failed');

    const retryInput = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_1',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: first.turn.turnId,
      localSequence: 2
    }));
    const retry = store.createCanonicalVisibleTurnInternal(retryInput);
    assert.equal(retry.turn.authorityLineageKey, first.turn.authorityLineageKey);
    assert.equal(retry.turn.lineageRevisionAtCreation, 2);
    assert.equal(retry.turn.retryOfTurnId, first.turn.turnId);

    const staleParent = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_stale',
      deviceSeq: 3,
      claimedLineageRevision: 3,
      retryOfTurnId: first.turn.turnId,
      localSequence: 3
    }));
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(staleParent),
      /latest|retry lineage authority conflict/i);
  }));

test('v3 invalid claims, cursor jumps, clear epochs and changed retry roots leave zero authority writes', () => {
  for (const scenario of [
    {
      name: 'wrong first revision',
      setup: () => null,
      options: { claimedLineageRevision: 4 },
      error: /authority claim revision conflict/i
    },
    {
      name: 'first sequence jump',
      setup: () => null,
      options: { localSequence: 2 },
      error: /visibility sequence/i
    },
    {
      name: 'clear epoch mismatch',
      setup: () => null,
      options: { clearEpoch: 1 },
      error: /CLEAR_EPOCH_SYNC_REQUIRED/
    }
  ]) {
    withStore(({ store }) => {
      ensureDirectRollout(store);
      const input = canonicalCreateInput(store, v3DirectEnvelope(scenario.options));
      assertZeroWrites(store,
        () => store.createCanonicalVisibleTurnInternal(input),
        scenario.error);
    });
  }

  withStore(({ store }) => {
    const first = createV3(store).result.turn;
    failV3Retryably(store, first);
    const wrongRevision = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_wrong_revision',
      deviceSeq: 2,
      claimedLineageRevision: 4,
      retryOfTurnId: first.turnId,
      localSequence: 2
    }));
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(wrongRevision),
      /authority claim revision conflict/i);

    const jump = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_jump',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: first.turnId,
      localSequence: 3
    }));
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(jump),
      /visibility sequence/i);

    const changedRootEnvelope = v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_changed_root',
      deviceSeq: 2,
      rootMessageId: 'msg_bridge_v3_changed_root',
      claimedLineageRevision: 2,
      retryOfTurnId: first.turnId,
      localSequence: 2
    });
    const changedRoot = canonicalCreateInput(store, changedRootEnvelope);
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(changedRoot),
      /retry parent|canonical batch|immutable authority/i);

    const changedCurrentEnvelope = v3DirectEnvelope({
      turnId: 'turn_bridge_v3_retry_changed_current',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: first.turnId,
      localSequence: 2
    });
    const changedMessage = {
      ...changedCurrentEnvelope.message,
      messageId: 'msg_bridge_v3_changed_current'
    };
    changedCurrentEnvelope.message = changedMessage;
    changedCurrentEnvelope.context.currentBatch.messageIds[
      changedCurrentEnvelope.context.currentBatch.messageIds.length - 1
    ] = changedMessage.messageId;
    changedCurrentEnvelope.context.currentBatch.messages[
      changedCurrentEnvelope.context.currentBatch.messages.length - 1
    ] = changedMessage;
    const changedCurrent = canonicalCreateInput(store, changedCurrentEnvelope);
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(changedCurrent),
      /retry canonical batch conflict/i);
  });
});

test('v3 retries require a terminal persisted retry authorization and reject malformed permissions', () => {
  const cases = [
    {
      name: 'open parent',
      failure: null
    },
    {
      name: 'running parent',
      failure: null,
      makeRunning: true
    },
    {
      name: 'failed parent without permission',
      failure: { failureClass: 'transient' }
    },
    {
      name: 'failed parent with false permission',
      failure: { failureClass: 'transient', retryAllowed: false }
    },
    {
      name: 'failed parent with forged permission type',
      failure: { failureClass: 'transient', retryAllowed: 'true' }
    }
  ];
  for (const scenario of cases) {
    withStore(({ store }) => {
      const parent = createV3(store).result.turn;
      if (scenario.makeRunning) {
        const routed = store.setCanonicalTurnRouteInternal({
          turnId: parent.turnId,
          expectedState: parent.state,
          expectedTurnRevision: parent.turnRevision,
          route: 'fast',
          reasons: ['retry-permission-test']
        });
        store.claimCanonicalTurnInternal({
          turnId: routed.turnId,
          expectedTurnRevision: routed.turnRevision,
          workerId: 'retry-permission-worker'
        });
      }
      if (scenario.failure) {
        store.recordCanonicalTurnFailureInternal({
          turnId: parent.turnId,
          expectedState: parent.state,
          expectedTurnRevision: parent.turnRevision,
          failure: scenario.failure
        });
      }
      const retry = canonicalCreateInput(store, v3DirectEnvelope({
        turnId: `turn_bridge_v3_retry_permission_${scenario.name.replace(/[^a-z]+/gi, '_')}`,
        deviceSeq: 2,
        claimedLineageRevision: 2,
        retryOfTurnId: parent.turnId,
        localSequence: 2
      }));
      assertZeroWrites(store,
        () => store.createCanonicalVisibleTurnInternal(retry),
        /retry.*permission|retry.*parent|retry lineage/i);
    });
  }

  withStore(({ store }) => {
    const parent = createV3(store).result.turn;
    const failed = failV3Retryably(store, parent);
    const child = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store,
      v3DirectEnvelope({
        turnId: 'turn_bridge_v3_retry_native_permission',
        deviceSeq: 2,
        claimedLineageRevision: 2,
        retryOfTurnId: failed.turnId,
        localSequence: 2
      })
    ));
    assert.equal(child.status, 'created');
    assert.equal(child.turn.retryOfTurnId, failed.turnId);
    assert.equal(child.turn.lineageRevisionAtCreation, 2);
  });
});

test('v3 exact original replay resolves the committed retry receipt without accepting changed input', () =>
  withStore(({ store }) => {
    const original = createV3(store);
    failV3Retryably(store, original.result.turn);
    const retry = createV3(store, {
      turnId: 'turn_bridge_v3_exact_original_retry',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: original.result.turn.turnId,
      localSequence: 2
    }).result.turn;
    const receipt = commitBridgeResult(store, retry);
    const replay = store.createCanonicalVisibleTurnInternal(original.input);
    assert.equal(replay.status, 'already_committed');
    assert.equal(replay.receipt.authoritativeTurnId, retry.turnId);
    assert.equal(replay.receipt.visibleGroupId, receipt.visibleGroupId);

    const changed = structuredClone(original.input);
    changed.envelope.message.content = 'changed original replay';
    changed.envelope.context.currentBatch.messages.at(-1).content = 'changed original replay';
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(changed),
      /canonical turn authority conflict/i);
  }));

test('a delayed v3 retry returns its parent terminal receipt only with its historical claim and immutable input', () =>
  withStore(({ store }) => {
    const parent = createV3(store);
    const delayedChild = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_delayed_child',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: parent.result.turn.turnId,
      localSequence: 2
    }));
    const receipt = commitBridgeResult(store, parent.result.turn);

    const replay = store.createCanonicalVisibleTurnInternal(delayedChild);
    assert.equal(replay.status, 'already_committed');
    assert.equal(replay.receipt.authoritativeTurnId, parent.result.turn.turnId);
    assert.equal(replay.receipt.visibleGroupId, receipt.visibleGroupId);

    const forgedClaim = structuredClone(delayedChild);
    forgedClaim.envelope.authority.claimedLineageRevision = 3;
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(forgedClaim),
      /authority claim revision conflict/i);

    const changed = structuredClone(delayedChild);
    changed.envelope.message.content = 'forged delayed child';
    changed.envelope.context.currentBatch.messages.at(-1).content = 'forged delayed child';
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(changed),
      /retry canonical batch conflict/i);
  }));

function legacyEnvelope({
  turnId = 'turn_bridge_legacy',
  characterId = 'yuqi',
  deviceId = 'phone',
  messageId = 'msg_bridge_legacy',
  deviceSeq = 90
} = {}) {
  return {
    protocolVersion: 2,
    turnId,
    characterId,
    deviceId,
    deviceSeq,
    createdAt: 5_000 + deviceSeq,
    kind: 'DIRECT_REPLY',
    message: {
      messageId,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: characterId,
      content: '旧版消息',
      sentAt: 5_000 + deviceSeq
    }
  };
}

function putLegacyAnchor(store, options = {}, state = 'completed') {
  const turn = store.submitTurn(legacyEnvelope(options));
  store.db.prepare('UPDATE turns SET state = ? WHERE turn_id = ?').run(state, turn.turnId);
  return store.getTurn(turn.turnId);
}

test('the first v3 turn verifies legacy bootstrap anchors and permanently closes bootstrap', () =>
  withStore(({ store, path }) => {
    const legacy = putLegacyAnchor(store);
    const anchored = v3DirectEnvelope({
      native: { turnId: legacy.turnId, groupId: legacy.turnId, sequence: 0 },
      ui: { turnId: legacy.turnId, groupId: legacy.turnId, sequence: 0 }
    });
    const first = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, anchored));
    assert.equal(first.turn.inputVisibilitySequence, 1);
    const lineageKey = first.turn.authorityLineageKey;
    failV3Retryably(store, first.turn);
    store.close();
    const reopened = new YuqiStore(path);
    try {
      assert.equal(reopened.getTurnAuthorityLineage(lineageKey).revision, 1);
      const retry = canonicalCreateInput(reopened, v3DirectEnvelope({
        turnId: 'turn_bridge_v3_after_bootstrap',
        deviceSeq: 2,
        claimedLineageRevision: 2,
        retryOfTurnId: first.turn.turnId,
        localSequence: 2,
        native: { turnId: legacy.turnId, groupId: legacy.turnId, sequence: 0 },
        ui: { turnId: legacy.turnId, groupId: legacy.turnId, sequence: 0 }
      }));
      assertZeroWrites(reopened,
        () => reopened.createCanonicalVisibleTurnInternal(retry),
        /legacy bootstrap.*disabled|canonical cursor/i);
    } finally {
      reopened.close();
    }
  }));

test('missing, foreign and pending legacy bootstrap anchors are rejected without writes', () => {
  for (const scenario of [
    { name: 'missing', make: () => 'turn_missing_anchor' },
    {
      name: 'foreign',
      make: store => putLegacyAnchor(store, {
        turnId: 'turn_foreign_anchor',
        characterId: 'other',
        messageId: 'msg_foreign_anchor',
        deviceSeq: 91
      }).turnId
    },
    {
      name: 'pending',
      make: store => putLegacyAnchor(store, {
        turnId: 'turn_pending_anchor',
        messageId: 'msg_pending_anchor',
        deviceSeq: 92
      }, 'queued').turnId
    }
  ]) {
    withStore(({ store }) => {
      const anchorId = scenario.make(store);
      ensureDirectRollout(store);
      const input = canonicalCreateInput(store, v3DirectEnvelope({
        native: { turnId: anchorId, groupId: anchorId, sequence: 0 },
        ui: { turnId: anchorId, groupId: anchorId, sequence: 0 }
      }));
      assertZeroWrites(store,
        () => store.createCanonicalVisibleTurnInternal(input),
        /legacy bootstrap authority conflict/i);
    });
  }
});

test('automatic legacy cloud anchors normalize once and are verified by the v3 store claim', () =>
  withStore(({ store }) => {
    const legacy = store.submitTurn({
      protocolVersion: 2,
      turnId: 'cloud_bridge_legacy_auto',
      characterId: 'yuqi',
      deviceId: 'phone',
      deviceSeq: 49,
      createdAt: 29_000,
      kind: 'PROACTIVE_CHAT',
      trigger: {
        triggerId: 'trigger_bridge_legacy_auto',
        triggerType: 'proactive_chat',
        scheduledFor: 28_000,
        executedAt: 29_000
      }
    });
    assert.equal(legacy.turnId, 'turn_cloud_bridge_legacy_auto');
    store.db.prepare('UPDATE turns SET state = ? WHERE turn_id = ?')
      .run('completed', legacy.turnId);

    const input = canonicalAutomaticInput(store, v3AutomaticEnvelope({
      nativeAnchorId: 'cloud_bridge_legacy_auto',
      uiAnchorId: 'cloud_bridge_legacy_auto'
    }));
    assert.equal(
      input.envelope.context.visibilityCursor.nativeCompletedTurnId,
      legacy.turnId
    );
    const created = store.createCanonicalVisibleTurnInternal(input).turn;
    assert.equal(created.resultAuthorityVersion, 1);
    assert.equal(created.inputVisibilitySequence, 1);
  }));

test('verified canonical cursor groups are adopted monotonically and mismatches write nothing', () =>
  withStore(({ store }) => {
    const first = createV3(store).result.turn;
    const receipt = commitBridgeResult(store, first);
    const prior = {
      turnId: first.turnId,
      groupId: receipt.visibleGroupId,
      sequence: 1
    };
    const forgedClearWatermark = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_forged_clear_watermark',
      deviceSeq: 20,
      rootMessageId: 'msg_bridge_v3_forged_clear_watermark',
      localSequence: 2,
      native: prior,
      ui: prior,
      clearedThroughSequence: 1
    }));
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(forgedClearWatermark),
      /CLEAR_EPOCH_SYNC_REQUIRED|canonical cursor authority conflict/i);

    const second = createV3(store, {
      turnId: 'turn_bridge_v3_second_root',
      deviceSeq: 2,
      rootMessageId: 'msg_bridge_v3_second_root',
      localSequence: 2,
      native: prior,
      ui: prior
    }).result.turn;
    assert.equal(second.inputVisibilitySequence, 2);
    const lane = store.getInteractionLane('yuqi', 'private_chat');
    assert.equal(lane.nativeCompletedGroupId, receipt.visibleGroupId);
    assert.equal(lane.nativeCompletedSequence, 1);
    assert.equal(lane.uiAppliedGroupId, receipt.visibleGroupId);
    assert.equal(lane.uiAppliedSequence, 1);

    const forgedGroup = deriveVisibleGroupId(deriveAuthorityLineageKey({
      roleId: 'yuqi', laneKey: 'private_chat', rootSourceId: 'msg_missing_group'
    }));
    const mismatch = canonicalCreateInput(store, v3DirectEnvelope({
      turnId: 'turn_bridge_v3_bad_group',
      deviceSeq: 3,
      rootMessageId: 'msg_bridge_v3_bad_group',
      localSequence: 3,
      native: { turnId: first.turnId, groupId: forgedGroup, sequence: 1 },
      ui: { turnId: first.turnId, groupId: forgedGroup, sequence: 1 }
    }));
    assertZeroWrites(store,
      () => store.createCanonicalVisibleTurnInternal(mismatch),
      /canonical cursor authority conflict/i);
  }));

test('the first v3 turn may bootstrap from a scoped canonical v2 result', () =>
  withStore(({ store }) => {
    const v2 = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2',
      rootMessageId: 'msg_bridge_canonical_v2'
    });
    v2.protocolVersion = 2;
    delete v2.authority;
    delete v2.context.visibilityCursor;
    const v2Turn = store.createCanonicalVisibleTurnInternal(
      canonicalCreateInput(store, v2)
    ).turn;
    const receipt = commitBridgeResult(store, v2Turn);
    const prior = {
      turnId: v2Turn.turnId,
      groupId: receipt.visibleGroupId,
      sequence: 1
    };
    const v3 = createV3(store, {
      turnId: 'turn_bridge_after_canonical_v2',
      deviceSeq: 2,
      rootMessageId: 'msg_bridge_after_canonical_v2',
      localSequence: 2,
      native: prior,
      ui: prior
    }).result.turn;
    assert.equal(v3.inputVisibilitySequence, 2);
    assert.equal(v3.resultAuthorityVersion, 1);
  }));

test('canonical bridge result uses receipt revisions and rejects scoped corruption', () =>
  withStore(({ store }) => {
    const turn = createV3(store).result.turn;
    const receipt = commitBridgeResult(store, turn);
    assert.equal(receipt.turnRevisionAfter, 4);
    assert.equal(receipt.lineageRevisionAfter, 2);
    assert.equal(receipt.laneRevisionAfter, 8);

    let scopedValidations = 0;
    let fullValidations = 0;
    const scoped = store.assertVisibleGroupAuthorityInternal.bind(store);
    const full = store.assertVisibleAuthorityV13Invariants.bind(store);
    store.assertVisibleGroupAuthorityInternal = (...args) => {
      scopedValidations += 1;
      return scoped(...args);
    };
    store.assertVisibleAuthorityV13Invariants = (...args) => {
      fullValidations += 1;
      return full(...args);
    };
    const result = store.loadCanonicalBridgeResultInternal(turn.turnId);
    assert.equal(scopedValidations, 1);
    assert.equal(fullValidations, 0);
    assert.equal(result.protocolVersion, 3);
    assert.equal(result.turnId, receipt.authoritativeTurnId);
    assert.equal(result.visibleGroupId, receipt.visibleGroupId);
    assert.equal(result.lineageRevision, 2);
    assert.equal(result.turnRevision, 4);
    assert.equal(result.laneRevision, 8);
    assert.equal(result.releaseId, turn.authoritativeReleaseId);
    assert.equal(result.replyParts.length, 2);
    assert.equal(result.replyParts[0].ordinal, 0);
    assert.match(result.replyParts[0].itemChecksum, /^[a-f0-9]{64}$/);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].ordinal, 0);
    assert.equal(result.actions[0].kind, 'moment_create');
    assert.match(result.actions[0].actionChecksum, /^[a-f0-9]{64}$/);
    assert.equal(result.actions[0].payload.text, '桥接动态');
    const projected = projectBridgeResultForWire(result, 3);
    assert.deepEqual(projected, result);
    assert.notEqual(projected, result);

    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    store.db.prepare(`
      UPDATE visible_result_groups SET authoritative_release_id = ? WHERE group_id = ?
    `).run(rollout.candidateReleaseId, receipt.visibleGroupId);
    assert.throws(
      () => store.loadCanonicalBridgeResultInternal(turn.turnId),
      /canonical bridge result authority conflict/i
    );
    store.db.prepare(`
      UPDATE visible_result_groups SET authoritative_release_id = ? WHERE group_id = ?
    `).run(turn.authoritativeReleaseId, receipt.visibleGroupId);

    store.db.prepare(`
      UPDATE visible_result_groups SET item_count = item_count + 1 WHERE group_id = ?
    `).run(receipt.visibleGroupId);
    assert.throws(
      () => store.loadCanonicalBridgeResultInternal(turn.turnId),
      /canonical bridge result authority conflict/i
    );
    store.db.prepare(`
      UPDATE visible_result_groups SET item_count = item_count - 1 WHERE group_id = ?
    `).run(receipt.visibleGroupId);

    const itemChecksum = store.db.prepare(`
      SELECT item_checksum FROM visible_result_items WHERE group_id = ? AND ordinal = 0
    `).get(receipt.visibleGroupId).item_checksum;
    store.db.prepare(`
      UPDATE visible_result_items SET item_checksum = ? WHERE group_id = ? AND ordinal = 0
    `).run('b'.repeat(64), receipt.visibleGroupId);
    assert.throws(
      () => store.loadCanonicalBridgeResultInternal(turn.turnId),
      /canonical bridge result authority conflict/i
    );
    store.db.prepare(`
      UPDATE visible_result_items SET item_checksum = ? WHERE group_id = ? AND ordinal = 0
    `).run(itemChecksum, receipt.visibleGroupId);

    store.db.prepare(`
      UPDATE visible_commit_receipts SET turn_revision_after = turn_revision_after + 1
      WHERE lineage_key = ?
    `).run(turn.authorityLineageKey);
    assert.throws(
      () => store.loadCanonicalBridgeResultInternal(turn.turnId),
      /canonical bridge result authority conflict/i
    );
  }));

test('original and retry polling resolve the same authoritative canonical bridge result', () =>
  withStore(({ store }) => {
    const original = createV3(store).result.turn;
    failV3Retryably(store, original);
    const retry = createV3(store, {
      turnId: 'turn_bridge_v3_authoritative_retry',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: original.turnId,
      localSequence: 2
    }).result.turn;
    const receipt = commitBridgeResult(store, retry);

    const fromOriginal = store.loadCanonicalBridgeResultInternal(original.turnId);
    const fromRetry = store.loadCanonicalBridgeResultInternal(retry.turnId);
    assert.deepEqual(fromOriginal, fromRetry);
    assert.equal(fromOriginal.turnId, retry.turnId);
    assert.equal(fromOriginal.visibleGroupId, receipt.visibleGroupId);
  }));
