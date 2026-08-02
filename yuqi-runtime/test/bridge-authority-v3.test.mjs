import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import {
  isCanonicalAuthorityConflictError,
  projectBridgeResultForWire,
  projectCanonicalFailureForWire
} from '../src/bridge-result-projector.mjs';
import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { canonicalJson, contentHash, validateAuthorityDeliveryReceipt, validateEnvelope } from '../src/protocol.mjs';
import { ResultOutbox } from '../src/result-outbox.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const fixture = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/authority-identity-v1.json', import.meta.url),
  'utf8'
));
const canonicalFailureFixture = JSON.parse(readFileSync(
  new URL('../../tests/fixtures/canonical-failure-status-v1.json', import.meta.url),
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

test('authority delivery receipt is a closed v3 value and permits skip without items', () => {
  const receipt = {
    protocolVersion: 3,
    type: 'AUTHORITY_DELIVERY_RECEIPT',
    peerId: 'phone',
    turnId: 'turn_authority_receipt',
    authorityLineageKey: 'lin_authority_receipt',
    visibleGroupId: 'group_authority_receipt',
    commitChecksum: 'a'.repeat(64),
    terminalDisposition: 'skip',
    deliveredAt: 10_000
  };
  assert.deepEqual(validateAuthorityDeliveryReceipt(receipt), receipt);
  assert.throws(
    () => validateAuthorityDeliveryReceipt({ ...receipt, items: [] }),
    /shape/
  );
  assert.throws(
    () => validateAuthorityDeliveryReceipt({ ...receipt, deliveredAt: '10000' }),
    /time/
  );
  for (const invalidDisposition of [
    ['skip'],
    { value: 'skip' },
    1,
    true,
    null
  ]) {
    assert.throws(
      () => validateAuthorityDeliveryReceipt({ ...receipt, terminalDisposition: invalidDisposition }),
      /disposition/
    );
  }
});

test('canonical authority conflict classification is closed to stable authority failures', () => {
  for (const message of [
    'canonical visible delivery target conflict',
    'canonical visible group manifest authority conflict',
    'canonical failure target set conflict',
    'canonical failure delivery lease conflict',
    'canonical bridge result projection conflict',
    'invalid canonical failure releaseId'
  ]) assert.equal(isCanonicalAuthorityConflictError(new Error(message)), true, message);
  for (const error of [
    new TypeError('canonical visible delivery target conflict'),
    new Error('SQLITE_BUSY: database is locked'),
    new Error('ordinary unexpected failure'),
    new Error('canonical release executor is not attached'),
    new Error('canonical visible group arbitrary fault conflict'),
    new Error('canonical visible result generated nonsense conflict'),
    new Error('canonical bridge join made_up conflict'),
    new Error('canonical failure made_up conflict'),
    new Error('invalid canonical result made_up'),
    new Error('secret canonical visible delivery target conflict'),
    new Error('canonical visible delivery target conflict secret'),
    new Error('canonical visible delivery target conflict\nsecret')
  ]) assert.equal(isCanonicalAuthorityConflictError(error), false, error.message);
});

test('canonical failure status vectors freeze the cross-language v3 wire checksum contract', () => {
  assert.equal(canonicalFailureFixture.version, 1);
  assert.equal(canonicalFailureFixture.canonicalization, 'utf8-canonical-json-v1');
  for (const vector of canonicalFailureFixture.vectors) {
    const { wire, failureInput } = vector;
    const raw = { ...wire };
    delete raw.rawStatusChecksum;
    assert.deepEqual(Object.keys(wire).sort(), [
      'authorityLineageKey', 'errorCode', 'failedAt', 'failureClass', 'generationFingerprint',
      'inputClearEpoch', 'inputVisibilitySequence', 'laneKey', 'laneRevision', 'lineageRevision',
      'rawStatusChecksum', 'releaseId', 'retryAllowed', 'retryOfTurnId', 'roleId', 'state',
      'turnId', 'turnRevision', 'type', 'protocolVersion'
    ].sort(), vector.name);
    assert.equal(wire.protocolVersion, 3, vector.name);
    assert.equal(wire.type, 'BACKLOG_FAILED', vector.name);
    assert.equal(typeof wire.retryAllowed, 'boolean', vector.name);
    assert.ok([
      'YUQI_TRANSIENT_EXECUTION_FAILURE',
      'YUQI_DETERMINISTIC_EXECUTION_FAILURE'
    ].includes(wire.errorCode), vector.name);
    assert.equal(contentHash(raw), wire.rawStatusChecksum, vector.name);
    assert.notEqual(contentHash({ ...raw, failedAt: raw.failedAt + 1 }), wire.rawStatusChecksum, vector.name);
    const authority = {
      turn: {
        resultAuthorityVersion: 1,
        protocolVersion: 3,
        state: 'failed',
        turnId: wire.turnId,
        characterId: wire.roleId,
        authorityLineageKey: wire.authorityLineageKey,
        turnRevision: wire.turnRevision,
        laneKey: wire.laneKey,
        laneRevision: wire.laneRevision,
        retryOfTurnId: wire.retryOfTurnId,
        inputVisibilitySequence: wire.inputVisibilitySequence,
        inputClearEpoch: wire.inputClearEpoch,
        generationFingerprint: wire.generationFingerprint,
        authoritativeReleaseId: wire.releaseId
      },
      lineage: {
        latestTurnId: wire.turnId,
        revision: wire.lineageRevision,
        state: 'open'
      },
      failure: {
        ...failureInput,
        code: wire.errorCode,
        failureClass: wire.failureClass,
        retryAllowed: wire.retryAllowed,
        failedAt: wire.failedAt
      }
    };
    assert.deepEqual(projectCanonicalFailureForWire(authority), wire, vector.name);
    assert.throws(
      () => projectCanonicalFailureForWire({
        ...authority,
        failure: { ...authority.failure, retryAllowed: String(wire.retryAllowed) }
      }), /retry permission/,
      vector.name
    );
    assert.throws(
      () => projectCanonicalFailureForWire({
        ...authority,
        failure: { ...authority.failure, unexpected: true }
      }), /retry permission/,
      vector.name
    );
    const { code, ...missingCodeFailure } = authority.failure;
    assert.throws(
      () => projectCanonicalFailureForWire({ ...authority, failure: missingCodeFailure }),
      /retry permission/,
      vector.name
    );
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

async function withAsyncStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-bridge-v3-async-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    return await run({ store, path });
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
  deviceSeq = 50,
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
    deviceSeq,
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

function canonicalDeliveryRows(store, groupId) {
  return store.db.prepare(`
    SELECT peer_id, state, confirmed_at, authority_commit_checksum
    FROM cloud_deliveries
    WHERE authority_group_id = ?
    ORDER BY peer_id
  `).all(groupId);
}

function insertForeignCanonicalDelivery(store, groupId, peerId = 'foreign_phone') {
  const result = store.db.prepare(`
    INSERT INTO cloud_deliveries(
      turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
      attempts, created_at, updated_at, delivered_at,
      authority_group_id, authority_commit_checksum
    )
    SELECT turn_id, ?, recovery_ack_seq, 'mailboxed', payload_json, checksum,
           attempts, created_at, updated_at, delivered_at,
           authority_group_id, authority_commit_checksum
    FROM cloud_deliveries
    WHERE authority_group_id = ? AND peer_id = 'phone'
  `).run(peerId, groupId);
  assert.equal(Number(result.changes), 1);
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
    failure: {
      failureClass: 'transient',
      retryAllowed: true,
      code: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
      ...failure
    }
  });
}

function spyCanonicalFailureHotPathValidation(store) {
  const counts = { scoped: 0, v11: 0, v13: 0, v14: 0 };
  const originals = {
    scoped: store.assertCanonicalFailureDeliveryInternal.bind(store),
    v11: store.assertVisibleAuthorityV11Invariants.bind(store),
    v13: store.assertVisibleAuthorityV13Invariants.bind(store),
    v14: store.assertReleaseAuthorityV14Invariants.bind(store)
  };
  store.assertCanonicalFailureDeliveryInternal = (...args) => {
    counts.scoped += 1;
    return originals.scoped(...args);
  };
  store.assertVisibleAuthorityV11Invariants = (...args) => {
    counts.v11 += 1;
    return originals.v11(...args);
  };
  store.assertVisibleAuthorityV13Invariants = (...args) => {
    counts.v13 += 1;
    return originals.v13(...args);
  };
  store.assertReleaseAuthorityV14Invariants = (...args) => {
    counts.v14 += 1;
    return originals.v14(...args);
  };
  return {
    counts,
    reset() {
      Object.assign(counts, { scoped: 0, v11: 0, v13: 0, v14: 0 });
    },
    restore() {
      store.assertCanonicalFailureDeliveryInternal = originals.scoped;
      store.assertVisibleAuthorityV11Invariants = originals.v11;
      store.assertVisibleAuthorityV13Invariants = originals.v13;
      store.assertReleaseAuthorityV14Invariants = originals.v14;
    }
  };
}

function failureValidationSnapshot(spy) {
  return { ...spy.counts };
}

function commitBridgeResult(store, turn, {
  items = [
    { content: '第一段', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' },
    { content: '第二段', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }
  ],
  actionDrafts = [{ kind: 'moment_create', payload: { text: '桥接动态' } }]
} = {}) {
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
  const visibleGroup = { items };
  const actionSet = actionDrafts.map(actionDraft => {
    const target = store.resolveCanonicalActionTargetInternal({ turn: current, action: actionDraft });
    return {
      ...actionDraft,
      targetKey: target.targetKey,
      targetRevision: target.targetRevision
    };
  });
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
        const writeFailure = () => store.recordCanonicalTurnFailureInternal({
          turnId: parent.turnId,
          expectedState: parent.state,
          expectedTurnRevision: parent.turnRevision,
          failure: {
            ...scenario.failure,
            code: scenario.failure.code ?? 'YUQI_TRANSIENT_EXECUTION_FAILURE'
          }
        });
        if (typeof scenario.failure.retryAllowed === 'undefined'
          || typeof scenario.failure.retryAllowed !== 'boolean') {
          assertZeroWrites(store, writeFailure, /native boolean/i);
        } else {
          writeFailure();
        }
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

test('canonical v3 failure has one closed PC status and a leased null-group outbox target', () => {
  withStore(({ store }) => {
    const parent = createV3(store).result.turn;
    const failed = failV3Retryably(store, parent, {
      name: 'ProviderTimeout',
      message: 'provider temporarily unavailable'
    });
    const projected = store.loadCanonicalFailureForBridgeInternal(failed.turnId);
    assert.equal(projected.type, 'BACKLOG_FAILED');
    assert.equal(projected.errorCode, 'YUQI_TRANSIENT_EXECUTION_FAILURE');
    assert.equal(projected.retryAllowed, true);
    assert.deepEqual(projected, projectCanonicalFailureForWire({
      turn: failed,
      lineage: store.getTurnAuthorityLineage(failed.authorityLineageKey),
      failure: JSON.parse(failed.errorJson)
    }));
    const targets = store.listPendingCanonicalFailureCloudDeliveries(10, 100_000);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].authorityGroupId, null);
    assert.equal(store.listPendingCloudDeliveries(10).length, 0);
    for (const legacyCall of [
      () => store.registerCloudDelivery(failed.turnId, failed.deviceId),
      () => store.prepareCloudDelivery(failed.turnId, failed.deviceId, { ok: true }),
      () => store.markCloudDeliveryAttempt(failed.turnId, failed.deviceId),
      () => store.markCloudDeliveryMailboxed(failed.turnId, failed.deviceId, 'legacy'),
      () => store.confirmCloudDeliveryItems(failed.turnId, failed.deviceId, { items: [] }),
      () => store.confirmCloudDelivery(failed.turnId, failed.deviceId, {})
    ]) assert.throws(legacyCall, /canonical delivery API required/i);
    const claim = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      timestamp: 100_000
    });
    assert.equal(claim.payload.rawStatusChecksum, projected.rawStatusChecksum);
    assert.equal(store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      timestamp: 100_001
    }), null);
    assert.throws(() => store.markCanonicalFailureCloudDeliveryMailboxedInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      rawStatusChecksum: claim.rawStatusChecksum,
      leaseId: claim.leaseId,
      leaseAttempt: claim.leaseAttempt,
      relayMessageId: 'forged_relay',
      timestamp: 100_002
    }), /relay identity/i);
    const mailboxed = store.markCanonicalFailureCloudDeliveryMailboxedInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      rawStatusChecksum: claim.rawStatusChecksum,
      leaseId: claim.leaseId,
      leaseAttempt: claim.leaseAttempt,
      relayMessageId: claim.relayMessageId,
      timestamp: 100_003
    });
    assert.equal(mailboxed.state, 'mailboxed');
    assert.equal(mailboxed.relayMessageId, claim.relayMessageId);
  });
});

test('canonical wire-v3 failure rejects same-turn requeue without changing authority state', () => {
  withStore(({ store }) => {
    const created = createV3(store).result.turn;
    const failed = failV3Retryably(store, created);
    const before = store.getTurn(failed.turnId);
    assert.throws(
      () => store.requeueCanonicalFailedTurnInternal({
        turnId: failed.turnId,
        expectedTurnRevision: failed.turnRevision,
        allowedFailureClass: 'transient'
      }),
      /authorized child retry/
    );
    assert.deepEqual(store.getTurn(failed.turnId), before);
  });
});

test('canonical failure load, claim, and completion use exactly one scoped validator and no full scan', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const spy = spyCanonicalFailureHotPathValidation(store);
    try {
      store.loadCanonicalFailureForBridgeInternal(failed.turnId);
      const load = failureValidationSnapshot(spy);

      spy.reset();
      const claim = store.claimCanonicalFailureCloudDeliveryInternal({
        turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_000
      });
      assert.ok(claim);
      const claimCounts = failureValidationSnapshot(spy);

      spy.reset();
      assert.equal(store.markCanonicalFailureCloudDeliveryMailboxedInternal({
        turnId: failed.turnId,
        peerId: failed.deviceId,
        rawStatusChecksum: claim.rawStatusChecksum,
        leaseId: claim.leaseId,
        leaseAttempt: claim.leaseAttempt,
        relayMessageId: claim.relayMessageId,
        timestamp: 100_001
      }).state, 'mailboxed');
      const completion = failureValidationSnapshot(spy);
      assert.deepEqual(
        { load: load.scoped, claim: claimCounts.scoped, completion: completion.scoped },
        { load: 1, claim: 1, completion: 1 },
        'each canonical failure hot-path operation must validate exactly its target and lineage once'
      );
      for (const [label, counts] of Object.entries({ load, claim: claimCounts, completion })) {
        assert.deepEqual(
          { v11: counts.v11, v13: counts.v13, v14: counts.v14 },
          { v11: 0, v13: 0, v14: 0 },
          `${label} must not run a full reopen scan`
        );
      }
    } finally {
      spy.restore();
    }
  });
});

test('an extra foreign canonical failure target is exposed only for fail-closed authority quarantine', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    store.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
        attempts, created_at, updated_at, delivered_at, authority_group_id, authority_commit_checksum
      ) VALUES (?, 'zz_foreign', 0, 'waiting', NULL, NULL, 0, 1, 1, NULL, NULL, NULL)
    `).run(failed.turnId);
    const snapshot = () => store.db.prepare(`
      SELECT turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
             attempts, created_at, updated_at, delivered_at, authority_group_id,
             authority_commit_checksum, relay_message_id
      FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id
    `).all(failed.turnId);
    const before = snapshot();
    const spy = spyCanonicalFailureHotPathValidation(store);
    try {
      assert.deepEqual(
        store.listPendingCanonicalFailureCloudDeliveries(10, 100_000).map(target => ({
          turnId: target.turnId, peerId: target.peerId, deliveryType: target.deliveryType
        })),
        [{ turnId: failed.turnId, peerId: failed.deviceId, deliveryType: 'canonical_failure' }],
        'the persisted peer target must remain observable so the outbox can quarantine it before fetch'
      );
      assert.throws(
        () => store.loadCanonicalFailureForBridgeInternal(failed.turnId),
        /canonical failure.*target.*conflict|canonical failure delivery authority conflict/i
      );
      assert.deepEqual(snapshot(), before);
      for (const peerId of ['zz_foreign', failed.deviceId]) {
        assert.throws(
          () => store.claimCanonicalFailureCloudDeliveryInternal({
            turnId: failed.turnId, peerId, timestamp: 100_000
          }),
          /canonical failure.*target.*conflict|canonical failure delivery authority conflict/i,
          peerId
        );
        assert.deepEqual(snapshot(), before, `${peerId} claim must leave both delivery rows unchanged`);
      }
      assert.equal(spy.counts.v11, 0);
      assert.equal(spy.counts.v13, 0);
      assert.equal(spy.counts.v14, 0);
    } finally {
      spy.restore();
    }
  });
});

test('foreign canonical failure completion target rejects before scoped validation without writes', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const status = store.loadCanonicalFailureForBridgeInternal(failed.turnId);
    const before = store.listCloudDeliveries(failed.turnId);
    const spy = spyCanonicalFailureHotPathValidation(store);
    try {
      assert.throws(
        () => store.markCanonicalFailureCloudDeliveryMailboxedInternal({
          turnId: failed.turnId,
          peerId: 'zz_foreign',
          rawStatusChecksum: status.rawStatusChecksum,
          leaseId: 'forged_lease', leaseAttempt: 1, relayMessageId: 'forged_relay', timestamp: 100_000
        }),
        /canonical failure.*target.*conflict|canonical failure delivery authority conflict/i
      );
      assert.deepEqual(store.listCloudDeliveries(failed.turnId), before);
      assert.equal(spy.counts.scoped, 0);
      assert.equal(spy.counts.v11, 0);
      assert.equal(spy.counts.v13, 0);
      assert.equal(spy.counts.v14, 0);
    } finally {
      spy.restore();
    }
  });
});

test('fifty canonical failure outbox sends use one hundred scoped validations and zero full scans', async () => {
  await withAsyncStore(async ({ store }) => {
    for (let index = 1; index <= 50; index += 1) {
      failV3Retryably(store, createV3(store, {
        turnId: `turn_bridge_v3_scoped_failure_${index}`,
        deviceSeq: index,
        rootMessageId: `msg_bridge_v3_scoped_failure_${index}`,
        localSequence: index
      }).result.turn);
    }
    const spy = spyCanonicalFailureHotPathValidation(store);
    let fetches = 0;
    try {
      const result = await new ResultOutbox({
        relayUrl: 'https://relay.example.test',
        deviceId: 'pcbridge01',
        deviceToken: 'token_for_test_123456',
        encryptionKeyBase64: Buffer.alloc(32, 9).toString('base64'),
        store,
        clock: () => 200_000,
        fetchImpl: async () => {
          fetches += 1;
          return new Response('', { status: 202 });
        }
      }).flushOnce();
      assert.deepEqual(result, { delivered: 50, failed: 0, waiting: 0 });
      assert.equal(fetches, 50);
      assert.equal(spy.counts.scoped, 100, 'claim and completion each validate their target and lineage');
      assert.equal(spy.counts.v11, 0);
      assert.equal(spy.counts.v13, 0);
      assert.equal(spy.counts.v14, 0);
    } finally {
      spy.restore();
    }
  });
});

test('an authorized v3 child supersedes a leased parent failure without letting an old lease overwrite it', () => {
  withStore(({ store }) => {
    const parent = failV3Retryably(store, createV3(store).result.turn);
    const claim = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: parent.turnId,
      peerId: parent.deviceId,
      timestamp: 100_000
    });
    const childEnvelope = v3DirectEnvelope({
      turnId: 'turn_bridge_v3_failure_child',
      deviceSeq: 2,
      claimedLineageRevision: 2,
      retryOfTurnId: parent.turnId,
      localSequence: 2
    });
    const child = store.createCanonicalVisibleTurnInternal(
      canonicalCreateInput(store, childEnvelope)
    );
    assert.equal(child.status, 'created');
    assert.equal(store.listCloudDeliveries(parent.turnId)[0].state, 'superseded');
    const completed = store.markCanonicalFailureCloudDeliveryMailboxedInternal({
      turnId: parent.turnId,
      peerId: parent.deviceId,
      rawStatusChecksum: claim.rawStatusChecksum,
      leaseId: claim.leaseId,
      leaseAttempt: claim.leaseAttempt,
      relayMessageId: claim.relayMessageId,
      timestamp: 100_001
    });
    assert.equal(completed.state, 'superseded_mailboxed');
    assert.equal(store.listPendingCanonicalFailureCloudDeliveries(10, 200_000).length, 0);
    const childReceipt = commitBridgeResult(store, child.turn);
    assert.equal(store.listCloudDeliveries(parent.turnId)[0].state, 'superseded_mailboxed');
    assert.equal(store.outboxForGroup(childReceipt.visibleGroupId).length, 1);
    assert.equal(store.outboxForGroup(childReceipt.visibleGroupId)[0].turnId, child.turn.turnId);
  });
});

test('an expired canonical failure lease is reclaimed with the same relay identity and rejects late completion', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const first = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_000
    });
    const second = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId, peerId: failed.deviceId, timestamp: 160_000
    });
    assert.equal(second.relayMessageId, first.relayMessageId);
    assert.equal(second.leaseAttempt, first.leaseAttempt + 1);
    assert.throws(() => store.markCanonicalFailureCloudDeliveryMailboxedInternal({
      turnId: failed.turnId, peerId: failed.deviceId,
      rawStatusChecksum: first.rawStatusChecksum,
      leaseId: first.leaseId, leaseAttempt: first.leaseAttempt,
      relayMessageId: first.relayMessageId, timestamp: 160_001
    }), /lease conflict/i);
    assert.equal(store.markCanonicalFailureCloudDeliveryMailboxedInternal({
      turnId: failed.turnId, peerId: failed.deviceId,
      rawStatusChecksum: second.rawStatusChecksum,
      leaseId: second.leaseId, leaseAttempt: second.leaseAttempt,
      relayMessageId: second.relayMessageId, timestamp: 160_001
    }).state, 'mailboxed');
  });
});

test('two real store connections cannot both claim one unexpired canonical failure lease', () => {
  withStore(({ store, path }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const secondStore = new YuqiStore(path);
    try {
      const first = store.claimCanonicalFailureCloudDeliveryInternal({
        turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_000
      });
      const second = secondStore.claimCanonicalFailureCloudDeliveryInternal({
        turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_001
      });
      assert.ok(first);
      assert.equal(second, null);
    } finally {
      secondStore.close();
    }
  });
});

test('two real result outboxes on two store connections enqueue one unexpired canonical failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-bridge-v3-outbox-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const secondStore = new YuqiStore(path);
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount += 1;
      return new Response('', { status: 202 });
    };
    const options = {
      relayUrl: 'https://relay.example.test',
      deviceId: 'pcbridge01',
      deviceToken: 'token_for_test_123456',
      encryptionKeyBase64: Buffer.alloc(32, 7).toString('base64'),
      fetchImpl,
      clock: () => 100_000
    };
    try {
      const [first, second] = await Promise.all([
        new ResultOutbox({ ...options, store }).flushOnce(),
        new ResultOutbox({ ...options, store: secondStore }).flushOnce()
      ]);
      assert.equal(first.delivered + second.delivered, 1);
      assert.equal(fetchCount, 1);
      const deliveries = store.listCloudDeliveries(failed.turnId);
      assert.equal(deliveries.length, 1);
      assert.equal(deliveries[0].state, 'mailboxed');
    } finally {
      secondStore.close();
    }
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('a crash before failure enqueue reclaims only after lease expiry with one stable relay identity', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-bridge-v3-crash-'));
  const path = join(directory, 'runtime.sqlite');
  const store = new YuqiStore(path);
  try {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const sent = [];
    const options = {
      relayUrl: 'https://relay.example.test',
      deviceId: 'pcbridge01',
      deviceToken: 'token_for_test_123456',
      encryptionKeyBase64: Buffer.alloc(32, 8).toString('base64'),
      store
    };
    const first = new ResultOutbox({
      ...options,
      clock: () => 100_000,
      fetchImpl: async (_url, request) => {
        sent.push(JSON.parse(request.body));
        throw new Error('simulated crash before relay accepted the request');
      }
    });
    assert.deepEqual(await first.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(store.listCloudDeliveries(failed.turnId)[0].state, 'pending');

    const beforeExpiry = new ResultOutbox({
      ...options,
      clock: () => 159_999,
      fetchImpl: async (_url, request) => {
        sent.push(JSON.parse(request.body));
        return new Response('', { status: 202 });
      }
    });
    assert.deepEqual(await beforeExpiry.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(sent.length, 1);

    const afterExpiry = new ResultOutbox({
      ...options,
      clock: () => 160_000,
      fetchImpl: async (_url, request) => {
        sent.push(JSON.parse(request.body));
        return new Response('', { status: 202 });
      }
    });
    assert.deepEqual(await afterExpiry.flushOnce(), { delivered: 1, failed: 0, waiting: 0 });
    assert.equal(sent.length, 2);
    assert.equal(sent[0].messageId, sent[1].messageId);
    assert.equal(sent[0].idempotencyKey, sent[1].idempotencyKey);
    assert.equal(store.listCloudDeliveries(failed.turnId)[0].state, 'mailboxed');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('foreign, closed, and successfully committed canonical lineages never expose a failure target', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    assert.throws(() => store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId, peerId: 'foreign_phone', timestamp: 100_000
    }), /authority conflict/i);
    store.db.prepare(`
      UPDATE turn_authority_lineages
      SET state = 'cancelled', updated_at = ?
      WHERE lineage_key = ?
    `).run(100_001, failed.authorityLineageKey);
    assert.equal(store.listPendingCanonicalFailureCloudDeliveries(10, 100_002).length, 0);
    assert.throws(() => store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_002
    }), /authority conflict/i);

    const successful = createV3(store, {
      turnId: 'turn_bridge_v3_success_without_failure',
      deviceSeq: 2,
      rootMessageId: 'msg_bridge_v3_success_without_failure',
      localSequence: 2
    }).result.turn;
    commitBridgeResult(store, successful);
    assert.equal(store.listPendingCanonicalFailureCloudDeliveries(10, 200_000).length, 0);
  });
});

test('a canonical failure quarantine removes delivery proof and records one closed diagnostic', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const target = store.listCloudDeliveries(failed.turnId)[0];
    const quarantined = store.quarantineCanonicalCloudDeliveryInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      expected: {
        state: target.state, payloadJson: target.payloadJson, checksum: target.checksum,
        attempts: target.attempts, relayMessageId: target.relayMessageId,
        deliveredAt: target.deliveredAt, updatedAt: target.updatedAt
      },
      reason: 'authority_validation_failed'
    });
    assert.equal(quarantined.state, 'quarantined');
    assert.equal(quarantined.payloadJson, null);
    assert.equal(quarantined.checksum, '');
    assert.equal(quarantined.attempts, 0);
    assert.equal(quarantined.relayMessageId, null);
    assert.equal(quarantined.deliveredAt, null);
    store.assertVisibleAuthorityV13Invariants();
    store.db.prepare(`
      DELETE FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
    `).run(failed.turnId);
    assert.throws(() => store.assertVisibleAuthorityV13Invariants(), /quarantine diagnostic conflict/i);
  });
});

test('a corrupt canonical failure target is quarantined without a relay fetch', async () =>
  withAsyncStore(async ({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const target = store.listCloudDeliveries(failed.turnId)[0];
    store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`).run(
      JSON.stringify({ ...JSON.parse(failed.errorJson), secret: 'corrupt' }), failed.turnId
    );
    let fetchCalls = 0;
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example.test',
      deviceId: 'pcbridge01',
      deviceToken: 'token_for_test_123456',
      encryptionKeyBase64: Buffer.alloc(32, 8).toString('base64'),
      store,
      fetchImpl: async () => { fetchCalls += 1; return new Response('', { status: 202 }); }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(fetchCalls, 0);
    const quarantined = store.listCloudDeliveries(failed.turnId)[0];
    assert.deepEqual({
      state: quarantined.state, payloadJson: quarantined.payloadJson, checksum: quarantined.checksum,
      attempts: quarantined.attempts, relayMessageId: quarantined.relayMessageId,
      deliveredAt: quarantined.deliveredAt
    }, {
      state: 'quarantined', payloadJson: null, checksum: '', attempts: 0,
      relayMessageId: null, deliveredAt: null
    });
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
    `).get(failed.turnId).count, 1);
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(fetchCalls, 0);
    assert.equal(target.state, 'waiting');
  }));

test('a canonical failure target set conflict is quarantined before fetch and remains non-selectable', async () =>
  withAsyncStore(async ({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    store.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
        attempts, created_at, updated_at, delivered_at, authority_group_id, authority_commit_checksum
      ) VALUES (?, 'zz_foreign', 0, 'waiting', NULL, NULL, 0, 1, 1, NULL, NULL, NULL)
    `).run(failed.turnId);
    let fetchCalls = 0;
    const outbox = new ResultOutbox({
      relayUrl: 'https://relay.example.test',
      deviceId: 'pcbridge01',
      deviceToken: 'token_for_test_123456',
      encryptionKeyBase64: Buffer.alloc(32, 8).toString('base64'),
      store,
      fetchImpl: async () => { fetchCalls += 1; return new Response('', { status: 202 }); }
    });
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 1, waiting: 0 });
    assert.equal(fetchCalls, 0);
    assert.equal(store.listCloudDeliveries(failed.turnId).find(row => row.peerId === failed.deviceId).state, 'quarantined');
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
    `).get(failed.turnId).count, 1);
    assert.deepEqual(await outbox.flushOnce(), { delivered: 0, failed: 0, waiting: 0 });
    assert.equal(fetchCalls, 0);
  }));

test('cancelling an unsent v3 failure quarantines its target without replacing the closed failure proof', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    const target = store.listCloudDeliveries(failed.turnId)[0];
    const beforeError = failed.errorJson;
    const lineage = store.getTurnAuthorityLineage(failed.authorityLineageKey);
    const cancelled = store.cancelCanonicalTurnInternal({
      turnId: failed.turnId,
      authorityLineageKey: failed.authorityLineageKey,
      expectedTurnRevision: failed.turnRevision,
      expectedLineageRevision: lineage.revision,
      reasonCode: 'USER_CANCELLED',
      timestamp: 200_000
    });
    assert.equal(cancelled.lineage.state, 'cancelled');
    assert.equal(store.getTurn(failed.turnId).errorJson, beforeError);
    assert.deepEqual({
      state: store.listCloudDeliveries(failed.turnId)[0].state,
      payloadJson: store.listCloudDeliveries(failed.turnId)[0].payloadJson,
      checksum: store.listCloudDeliveries(failed.turnId)[0].checksum,
      attempts: store.listCloudDeliveries(failed.turnId)[0].attempts,
      relayMessageId: store.listCloudDeliveries(failed.turnId)[0].relayMessageId,
      deliveredAt: store.listCloudDeliveries(failed.turnId)[0].deliveredAt
    }, {
      state: 'quarantined', payloadJson: null, checksum: '', attempts: 0,
      relayMessageId: null, deliveredAt: null
    });
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
    `).get(failed.turnId).count, 1);
    assert.equal(target.state, 'waiting');
    store.assertVisibleAuthorityV13Invariants();
  });
});

test('canonical failure invariant rejects closed-error, lease, and diagnostic corruption', () => {
  withStore(({ store }) => {
    const failed = failV3Retryably(store, createV3(store).result.turn);
    store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`).run(
      JSON.stringify({ ...JSON.parse(failed.errorJson), secret: 'forged' }), failed.turnId
    );
    assert.throws(() => store.assertVisibleAuthorityV13Invariants(), /retry permission conflict/i);
    store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`).run(failed.errorJson, failed.turnId);
    const claim = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: failed.turnId, peerId: failed.deviceId, timestamp: 100_000
    });
    const payload = JSON.parse(store.listCloudDeliveries(failed.turnId)[0].payloadJson);
    payload.lease.extra = true;
    store.db.prepare(`UPDATE cloud_deliveries SET payload_json = ? WHERE turn_id = ? AND peer_id = ?`).run(
      JSON.stringify(payload), failed.turnId, failed.deviceId
    );
    assert.throws(() => store.assertVisibleAuthorityV13Invariants(), /lease conflict/i);
    store.db.prepare(`UPDATE cloud_deliveries SET payload_json = ? WHERE turn_id = ? AND peer_id = ?`).run(
      JSON.stringify({ failure: claim.payload, lease: { leaseId: claim.leaseId, leaseAttempt: claim.leaseAttempt, leasedAt: 100_000 } }),
      failed.turnId, failed.deviceId
    );
    const target = store.listCloudDeliveries(failed.turnId)[0];
    store.quarantineCanonicalCloudDeliveryInternal({
      turnId: failed.turnId,
      peerId: failed.deviceId,
      expected: {
        state: target.state, payloadJson: target.payloadJson, checksum: target.checksum,
        attempts: target.attempts, relayMessageId: target.relayMessageId,
        deliveredAt: target.deliveredAt, updatedAt: target.updatedAt
      }
    });
    store.db.prepare(`INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at) VALUES (?, ?, 'error', ?, ?)`)
      .run(failed.turnId, 'canonical_failure_delivery_quarantined', JSON.stringify({ redacted: true, peerId: failed.deviceId, reason: 'extra' }), 100_001);
    assert.throws(() => store.assertVisibleAuthorityV13Invariants(), /quarantine diagnostic conflict/i);
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

test('one canonical result projects exact closed v3 and compatible ordered v2 deliveries', () =>
  withStore(({ store }) => {
    const turn = createV3(store, {
      turnId: 'turn_bridge_v3_projection', rootMessageId: 'msg_bridge_v3_projection'
    }).result.turn;
    commitBridgeResult(store, turn);
    store.db.prepare(`UPDATE turns SET reply_json = ? WHERE turn_id = ?`).run(
      JSON.stringify({ reply: { content: '伪造旧回复' }, action: 'skip' }), turn.turnId
    );

    const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
    const v3 = projectBridgeResultForWire({ ...canonical, ok: true, recoveryAckSeq: 99 }, 3);
    assert.deepEqual(v3, canonical);
    assert.equal('ok' in v3, false);
    assert.equal('recoveryAckSeq' in v3, false);
    assert.equal(v3.replyParts.map(part => part.messageId).length, 2);
    assert.equal(v3.actions[0].actionId, canonical.actions[0].actionId);

    const v2 = projectBridgeResultForWire(canonical, 2);
    assert.equal(v2.terminal, true);
    assert.equal(v2.action, 'send');
    assert.equal(v2.reply.messageId, canonical.replyParts[0].messageId);
    assert.equal(v2.reply.content, '第一段\n第二段');
    assert.deepEqual(v2.replyParts, canonical.replyParts);
    assert.deepEqual(v2.actions, canonical.actions);
    assert.deepEqual(v2.momentAction, canonical.actions[0].payload);
    assert.deepEqual(v2.deliveryItems, [
      ...canonical.replyParts.map(part => ({
        kind: 'message', id: part.messageId, checksum: part.itemChecksum
      })),
      ...canonical.actions.map(action => ({
        kind: 'action', id: action.actionId, checksum: action.actionChecksum
      }))
    ]);
  }));

test('v2 action compatibility map preserves role-plan order and rejects ambiguous or unknown canonical actions', () => {
  const action = ({ ordinal, kind, payload }) => ({
    ordinal,
    actionId: `action_projection_${ordinal}`,
    kind,
    targetKey: `target:${ordinal}`,
    targetRevision: String.fromCharCode(102 - ordinal).repeat(64),
    payload,
    actionChecksum: String.fromCharCode(97 + ordinal).repeat(64)
  });
  const canonical = {
    protocolVersion: 3,
    turnId: 'turn_projection_actions',
    roleId: 'yuqi',
    authorityOrigin: 'pc',
    authorityLineageKey: 'lin_projection_actions',
    visibleGroupId: 'group_projection_actions',
    lineageRevision: 2,
    turnRevision: 4,
    laneKey: 'private_chat',
    laneRevision: 3,
    inputVisibilitySequence: 7,
    inputClearEpoch: 0,
    generationFingerprint: null,
    releaseId: 'release_test',
    commitPayloadVersion: 'pc-visible-commit-v2',
    commitChecksum: 'f'.repeat(64),
    terminalDisposition: 'action_only',
    replyParts: [],
    actions: [
      action({ ordinal: 0, kind: 'role_plan_create', payload: { op: 'create', planId: 'plan_1' } }),
      action({ ordinal: 1, kind: 'role_plan_cancel', payload: { op: 'cancel', planId: 'plan_2' } }),
      action({ ordinal: 2, kind: 'payment_accept', payload: { paymentId: 'pay_1' } })
    ]
  };
  const v2 = projectBridgeResultForWire(canonical, 2);
  assert.equal(v2.action, 'send');
  assert.equal(v2.reply, null);
  assert.deepEqual(v2.rolePlanOperations, [
    { op: 'create', planId: 'plan_1' },
    { op: 'cancel', planId: 'plan_2' }
  ]);
  assert.equal(v2.paymentAction, 'received');
  assert.deepEqual(v2.deliveryItems, canonical.actions.map(value => ({
    kind: 'action', id: value.actionId, checksum: value.actionChecksum
  })));
  assert.throws(() => projectBridgeResultForWire({
    ...canonical,
    actions: [...canonical.actions, action({ ordinal: 3, kind: 'payment_decline', payload: { paymentId: 'pay_2' } })]
  }, 2), /canonical bridge result projection conflict/i);
  assert.throws(() => projectBridgeResultForWire({
    ...canonical,
    actions: [{ ...canonical.actions[0], kind: 'mystery_action' }]
  }, 2), /canonical bridge result projection conflict/i);
});

test('redacted canonical projection carries audit metadata only', () => {
  const redacted = {
    status: 'redacted',
    deliverable: false,
    turnId: 'turn_redacted_projection',
    authorityLineageKey: 'lin_redacted_projection',
    visibleGroupId: 'group_redacted_projection',
    commitChecksum: 'a'.repeat(64),
    replyParts: [{ content: 'must never leave the store' }],
    actions: [{ payload: { secret: 'must never leave the store' } }]
  };
  assert.deepEqual(projectBridgeResultForWire(redacted, 3), {
    status: 'redacted',
    deliverable: false,
    turnId: redacted.turnId,
    authorityLineageKey: redacted.authorityLineageKey,
    visibleGroupId: redacted.visibleGroupId,
    commitChecksum: redacted.commitChecksum
  });
});

test('canonical authority delivery receipt confirms an exact mailbox target once', () =>
  withStore(({ store }) => {
    const turn = createV3(store).result.turn;
    const committed = commitBridgeResult(store, turn);
    const groupId = committed.visibleGroupId;
    const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(groupId);
    const receipt = {
      protocolVersion: 3,
      type: 'AUTHORITY_DELIVERY_RECEIPT',
      peerId: 'phone',
      turnId: canonical.turnId,
      authorityLineageKey: canonical.authorityLineageKey,
      visibleGroupId: canonical.visibleGroupId,
      commitChecksum: canonical.commitChecksum,
      terminalDisposition: canonical.terminalDisposition,
      deliveredAt: 21_000
    };

    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'waiting'
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(groupId);
    assertZeroWrites(store,
      () => store.confirmAuthorityCloudDeliveryInternal(receipt),
      /not mailboxed/i);
    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(groupId);
    for (const changed of [
      { turnId: 'turn_other' },
      { authorityLineageKey: 'lin_other' },
      { visibleGroupId: 'group_other' },
      { commitChecksum: 'f'.repeat(64) },
      { terminalDisposition: 'action_only' }
    ]) {
      assertZeroWrites(store,
        () => store.confirmAuthorityCloudDeliveryInternal({ ...receipt, ...changed }),
        /receipt conflict|target conflict|authority conflict/i);
    }
    const confirmed = store.confirmAuthorityCloudDeliveryInternal(receipt);
    assert.equal(confirmed.state, 'confirmed');
    assert.equal(store.confirmAuthorityCloudDeliveryInternal(receipt).state, 'confirmed');
    assert.throws(
      () => store.confirmAuthorityCloudDeliveryInternal({ ...receipt, deliveredAt: 21_001 }),
      /receipt conflict/
    );
    assert.throws(
      () => store.confirmAuthorityCloudDeliveryInternal({ ...receipt, peerId: 'foreign' }),
      /receipt conflict|target conflict/
    );
  }));

test('canonical group delivery target sets reject foreign peers without mutating either receipt path', () =>
  withStore(({ store }) => {
    const turn = createV3(store, {
      turnId: 'turn_bridge_v3_foreign_target', rootMessageId: 'msg_bridge_v3_foreign_target'
    }).result.turn;
    const committed = commitBridgeResult(store, turn);
    const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(committed.visibleGroupId);
    insertForeignCanonicalDelivery(store, committed.visibleGroupId);
    const before = canonicalDeliveryRows(store, committed.visibleGroupId);
    const phoneReceipt = {
      protocolVersion: 3,
      type: 'AUTHORITY_DELIVERY_RECEIPT',
      peerId: 'phone',
      turnId: canonical.turnId,
      authorityLineageKey: canonical.authorityLineageKey,
      visibleGroupId: canonical.visibleGroupId,
      commitChecksum: canonical.commitChecksum,
      terminalDisposition: canonical.terminalDisposition,
      deliveredAt: 21_000
    };
    for (const receipt of [phoneReceipt, { ...phoneReceipt, peerId: 'foreign_phone' }]) {
      assert.throws(
        () => store.confirmAuthorityCloudDeliveryInternal(receipt),
        /delivery.*authority conflict|target conflict/i
      );
      assert.deepEqual(canonicalDeliveryRows(store, committed.visibleGroupId), before);
    }
    store.db.prepare(`
      DELETE FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = 'foreign_phone'
    `).run(committed.visibleGroupId);
    assert.equal(store.confirmAuthorityCloudDeliveryInternal(phoneReceipt).state, 'confirmed');
    assert.equal(store.confirmAuthorityCloudDeliveryInternal(phoneReceipt).state, 'confirmed');
  }));

test('canonical v3 action-only and skip receipts confirm their closed mailbox groups', () =>
  withStore(({ store }) => {
    const cases = [
      {
        name: 'action_only',
        turnId: 'turn_bridge_v3_action_only_receipt',
        triggerId: 'trigger_bridge_v3_action_only_receipt',
        actionDrafts: [{ kind: 'moment_create', payload: { text: '只有动作' } }]
      },
      {
        name: 'skip',
        turnId: 'turn_bridge_v3_skip_receipt',
        triggerId: 'trigger_bridge_v3_skip_receipt',
        actionDrafts: []
      }
    ];
    for (const [index, scenario] of cases.entries()) {
      const raw = v3AutomaticEnvelope({
        turnId: scenario.turnId,
        triggerId: scenario.triggerId,
        deviceSeq: 50 + index,
        localSequence: index + 1
      });
      const turn = store.createCanonicalVisibleTurnInternal(canonicalAutomaticInput(store, raw)).turn;
      const committed = commitBridgeResult(store, turn, { items: [], actionDrafts: scenario.actionDrafts });
      const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
      assert.equal(canonical.terminalDisposition, scenario.name);
      if (scenario.name === 'skip') {
        assert.deepEqual(canonical.replyParts, []);
        assert.deepEqual(canonical.actions, []);
      }
      store.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'mailboxed', delivered_at = ?
        WHERE authority_group_id = ? AND peer_id = 'phone'
      `).run(20_000 + index, committed.visibleGroupId);
      const receipt = {
        protocolVersion: 3,
        type: 'AUTHORITY_DELIVERY_RECEIPT',
        peerId: 'phone',
        turnId: canonical.turnId,
        authorityLineageKey: canonical.authorityLineageKey,
        visibleGroupId: canonical.visibleGroupId,
        commitChecksum: canonical.commitChecksum,
        terminalDisposition: canonical.terminalDisposition,
        deliveredAt: 21_000 + index
      };
      assert.equal(store.confirmAuthorityCloudDeliveryInternal(receipt).state, 'confirmed');
    }
  }));

test('canonical v2 receipt requires the complete persisted item and action set', () =>
  withStore(({ store }) => {
    const raw = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2_receipt', rootMessageId: 'msg_bridge_canonical_v2_receipt'
    });
    raw.protocolVersion = 2;
    delete raw.authority;
    delete raw.context.visibilityCursor;
    const turn = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, raw)).turn;
    const committed = commitBridgeResult(store, turn);
    const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
    const projection = projectBridgeResultForWire(canonical, 2);
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(committed.visibleGroupId);
    const receipt = {
      protocolVersion: 1,
      turnId: turn.turnId,
      deliveredAt: 21_000,
      items: projection.deliveryItems
    };

    assert.equal(store.confirmCanonicalV2DeliveryInternal(turn.turnId, 'phone', receipt).state, 'confirmed');
    assert.throws(
      () => store.confirmCanonicalV2DeliveryInternal(turn.turnId, 'phone', {
        ...receipt, items: receipt.items.slice(0, -1)
      }),
      /receipt item conflict/
    );
  }));

test('canonical v2 simple receipts only confirm one text item with no actions', () =>
  withStore(({ store }) => {
    const raw = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2_simple_receipt', rootMessageId: 'msg_bridge_canonical_v2_simple_receipt'
    });
    raw.protocolVersion = 2;
    delete raw.authority;
    delete raw.context.visibilityCursor;
    const turn = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, raw)).turn;
    const committed = commitBridgeResult(store, turn, {
      items: [{ content: '只有一条', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }],
      actionDrafts: []
    });
    const canonical = store.loadCanonicalBridgeResultInternal(turn.turnId);
    store.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(committed.visibleGroupId);
    const part = canonical.replyParts[0];
    const receipt = {
      turnId: turn.turnId,
      messageId: part.messageId,
      contentSha256: createHash('sha256').update(part.content, 'utf8').digest('hex'),
      receivedAt: 21_000
    };

    assert.equal(store.confirmCanonicalV2SimpleDeliveryInternal(turn.turnId, 'phone', receipt).state, 'confirmed');
    assert.equal(store.confirmCanonicalV2SimpleDeliveryInternal(turn.turnId, 'phone', receipt).state, 'confirmed');
    assertZeroWrites(store,
      () => store.confirmCanonicalV2SimpleDeliveryInternal(turn.turnId, 'phone', {
        ...receipt, contentSha256: 'f'.repeat(64)
      }),
      /simple delivery receipt conflict/i);
  }));

test('canonical v2 multi-item and action results reject simple receipts', () =>
  withStore(({ store }) => {
    const direct = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2_non_simple', rootMessageId: 'msg_bridge_canonical_v2_non_simple'
    });
    direct.protocolVersion = 2;
    delete direct.authority;
    delete direct.context.visibilityCursor;
    const nonSimple = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, direct)).turn;
    const nonSimpleCommit = commitBridgeResult(store, nonSimple);
    const nonSimpleCanonical = store.loadCanonicalBridgeResultInternal(nonSimple.turnId);
    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(nonSimpleCommit.visibleGroupId);
    assertZeroWrites(store,
      () => store.confirmCanonicalV2SimpleDeliveryInternal(nonSimple.turnId, 'phone', {
        turnId: nonSimple.turnId,
        messageId: nonSimpleCanonical.replyParts[0].messageId,
        contentSha256: createHash('sha256').update(nonSimpleCanonical.replyParts[0].content, 'utf8').digest('hex'),
        receivedAt: 21_000
      }),
      /simple delivery receipt conflict/i);

  }));

test('canonical v2 itemized and simple receipts fail closed when a group has a foreign delivery target', () =>
  withStore(({ store }) => {
    const itemizedRaw = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2_foreign_itemized', rootMessageId: 'msg_bridge_canonical_v2_foreign_itemized'
    });
    itemizedRaw.protocolVersion = 2;
    delete itemizedRaw.authority;
    delete itemizedRaw.context.visibilityCursor;
    const itemizedTurn = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, itemizedRaw)).turn;
    const itemizedCommit = commitBridgeResult(store, itemizedTurn);
    const itemizedCanonical = store.loadCanonicalBridgeResultInternal(itemizedTurn.turnId);
    const itemizedProjection = projectBridgeResultForWire(itemizedCanonical, 2);
    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(itemizedCommit.visibleGroupId);
    insertForeignCanonicalDelivery(store, itemizedCommit.visibleGroupId);
    const itemizedBefore = canonicalDeliveryRows(store, itemizedCommit.visibleGroupId);
    const itemizedReceipt = {
      protocolVersion: 1,
      turnId: itemizedTurn.turnId,
      deliveredAt: 21_000,
      items: itemizedProjection.deliveryItems
    };
    for (const peerId of ['phone', 'foreign_phone']) {
      assert.throws(
        () => store.confirmCanonicalV2DeliveryInternal(itemizedTurn.turnId, peerId, itemizedReceipt),
        /canonical bridge result authority conflict|canonical delivery target conflict/i
      );
      assert.deepEqual(canonicalDeliveryRows(store, itemizedCommit.visibleGroupId), itemizedBefore);
    }

    const simpleRaw = v3DirectEnvelope({
      turnId: 'turn_bridge_canonical_v2_foreign_simple',
      rootMessageId: 'msg_bridge_canonical_v2_foreign_simple',
      deviceSeq: 2
    });
    simpleRaw.protocolVersion = 2;
    delete simpleRaw.authority;
    delete simpleRaw.context.visibilityCursor;
    const simpleTurn = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, simpleRaw)).turn;
    const simpleCommit = commitBridgeResult(store, simpleTurn, {
      items: [{ content: '唯一的回复', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }],
      actionDrafts: []
    });
    const simpleCanonical = store.loadCanonicalBridgeResultInternal(simpleTurn.turnId);
    store.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = 20_000
      WHERE authority_group_id = ? AND peer_id = 'phone'
    `).run(simpleCommit.visibleGroupId);
    insertForeignCanonicalDelivery(store, simpleCommit.visibleGroupId);
    const simpleBefore = canonicalDeliveryRows(store, simpleCommit.visibleGroupId);
    const simplePart = simpleCanonical.replyParts[0];
    const simpleReceipt = {
      turnId: simpleTurn.turnId,
      messageId: simplePart.messageId,
      contentSha256: createHash('sha256').update(simplePart.content, 'utf8').digest('hex'),
      receivedAt: 21_000
    };
    for (const peerId of ['phone', 'foreign_phone']) {
      assert.throws(
        () => store.confirmCanonicalV2SimpleDeliveryInternal(simpleTurn.turnId, peerId, simpleReceipt),
        /canonical bridge result authority conflict|canonical delivery target conflict/i
      );
      assert.deepEqual(canonicalDeliveryRows(store, simpleCommit.visibleGroupId), simpleBefore);
    }

    store.db.prepare(`
      DELETE FROM cloud_deliveries
      WHERE authority_group_id IN (?, ?) AND peer_id = 'foreign_phone'
    `).run(itemizedCommit.visibleGroupId, simpleCommit.visibleGroupId);
    assert.equal(store.confirmCanonicalV2DeliveryInternal(itemizedTurn.turnId, 'phone', itemizedReceipt).state, 'confirmed');
    assert.equal(store.confirmCanonicalV2DeliveryInternal(itemizedTurn.turnId, 'phone', itemizedReceipt).state, 'confirmed');
    assert.equal(store.confirmCanonicalV2SimpleDeliveryInternal(simpleTurn.turnId, 'phone', simpleReceipt).state, 'confirmed');
    assert.equal(store.confirmCanonicalV2SimpleDeliveryInternal(simpleTurn.turnId, 'phone', simpleReceipt).state, 'confirmed');
  }));

test('canonical visible delivery quarantine CAS clears the corrupt payload and records one closed diagnostic', () =>
  withStore(({ store }) => {
    const turn = createV3(store, {
      turnId: 'turn_bridge_v3_group_quarantine', rootMessageId: 'msg_bridge_v3_group_quarantine'
    }).result.turn;
    const committed = commitBridgeResult(store, turn);
    const target = store.listCloudDeliveries(turn.turnId)[0];
    const expected = {
      state: target.state,
      payloadJson: target.payloadJson,
      checksum: target.checksum,
      attempts: target.attempts,
      relayMessageId: target.relayMessageId,
      deliveredAt: target.deliveredAt,
      updatedAt: target.updatedAt
    };
    const quarantined = store.quarantineCanonicalVisibleDeliveryInternal({
      turnId: turn.turnId,
      peerId: target.peerId,
      authorityGroupId: committed.visibleGroupId,
      authorityCommitChecksum: committed.commitChecksum,
      expected,
      reason: 'authority_validation_failed'
    });
    assert.equal(quarantined.state, 'quarantined');
    assert.equal(quarantined.payloadJson, null);
    assert.equal(quarantined.checksum, '');
    assert.equal(quarantined.attempts, 0);
    assert.equal(quarantined.relayMessageId, null);
    assert.equal(quarantined.deliveredAt, null);
    const diagnostics = store.db.prepare(`
      SELECT stage, detail_json FROM diagnostics WHERE turn_id = ?
    `).all(turn.turnId).map(row => ({ ...row }));
    assert.deepEqual(diagnostics, [{
      stage: 'canonical_visible_delivery_quarantined',
      detail_json: canonicalJson({
        redacted: true,
        groupId: committed.visibleGroupId,
        peerId: target.peerId,
        reason: 'authority_validation_failed'
      })
    }]);
    assert.equal(store.quarantineCanonicalVisibleDeliveryInternal({
      turnId: turn.turnId,
      peerId: target.peerId,
      authorityGroupId: committed.visibleGroupId,
      authorityCommitChecksum: committed.commitChecksum,
      expected,
      reason: 'authority_validation_failed'
    }).state, 'quarantined');
    assert.equal(store.db.prepare(`
      SELECT COUNT(*) AS count FROM diagnostics WHERE turn_id = ?
    `).get(turn.turnId).count, 1);
    store.assertVisibleAuthorityV13Invariants();
    store.db.prepare(`
      UPDATE cloud_deliveries SET checksum = ? WHERE turn_id = ? AND peer_id = ?
    `).run('a'.repeat(64), turn.turnId, target.peerId);
    assert.throws(() => store.assertVisibleAuthorityV13Invariants(), /quarantine state conflict/i);
  }));
