import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { deriveAuthorityLineageKey } from '../src/authority-identity.mjs';
import { PromotionController } from '../src/promotion-controller.mjs';
import { validateEnvelope } from '../src/protocol.mjs';
import { YuqiStore } from '../src/store.mjs';

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-'));
  const path = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(path, { targetVersion: 14 });
  try {
    return run(store, path);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

function snapshotV13(path) {
  const store = new YuqiStore(path, { targetVersion: 13 });
  try {
    const schema = store.db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_autoindex_%'
      ORDER BY type, name
    `).all();
    const counts = Object.fromEntries(store.db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all().map(({ name }) => [
      name,
      Number(store.db.prepare(`SELECT COUNT(*) AS count FROM "${name}"`).get().count)
    ]));
    return { userVersion: store.userVersion(), schema, counts };
  } finally {
    store.close();
  }
}

test('fresh store is v14 with retry-safe canary ownership indexes', () => withStore(store => {
  assert.equal(store.userVersion(), 14);
  const indexes = store.db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'turns' ORDER BY name"
  ).all();
  const byName = new Map(indexes.map(row => [row.name, row.sql || '']));
  assert.equal(byName.has('idx_turns_rollout_canary_slot'), false);
  assert.match(
    byName.get('idx_turns_rollout_canary_root_slot') || '',
    /retry_of_turn_id IS NULL/
  );
  assert.match(
    byName.get('idx_turns_rollout_canary_lineage_slot') || '',
    /authority_lineage_key/
  );
  assert.doesNotThrow(() => store.assertReleaseAuthorityV14Invariants());
}));

test('v14 outstanding authority is scoped to rollout key and counts one lineage or life attempt', () =>
  withStore(store => {
    assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY',
      canaryEpoch: 0
    }), { count: 0, oldestAt: null });
    assert.deepEqual(store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'LIFE_PLANNING',
      canaryEpoch: 0
    }), { count: 0, oldestAt: null });
  }));

test('v14 outstanding authority rejects counters without durable allocation owners', () =>
  withStore(store => {
    const controller = new PromotionController({
      store,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    store.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET canary_started_count = 1, canary_completed_count = 0,
          canary_failure_count = 0
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    assert.throws(() => store.readCanaryOutstandingAuthorityInternal({
      rolloutKey: 'DIRECT_REPLY', canaryEpoch: 0
    }), /CANARY_ACCOUNTING_INVARIANT/);
  }));

test('v14 preflight rejects an invalid life-planning canary slot before any migration DDL', () =>
  withStore(store => {
    const controller = new PromotionController({
      store,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    const attempt = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: 1_000
    });
    store.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET canary_epoch = 0, canary_slot = 11
      WHERE planning_id = ?
    `).run(attempt.planningId);

    assert.throws(
      () => store.assertReleaseAuthorityV14PreflightInternal(),
      /v14 migration life canary slot conflict/
    );
  }));

test('every v14 migration fault restores the exact v13 schema and row counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-faults-'));
  try {
    const source = join(dir, 'source.sqlite');
    const sourceStore = new YuqiStore(source, { targetVersion: 13 });
    sourceStore.close();
    const before = snapshotV13(source);
    for (const step of [
      'before_drop',
      'after_drop',
      'after_root_index_create',
      'after_lineage_index_create',
      'after_invariant_verification',
      'before_version_write'
    ]) {
      const target = join(dir, `${step}.sqlite`);
      copyFileSync(source, target);
      assert.throws(
        () => new YuqiStore(target, {
          expectedSourceVersion: 13,
          v14MigrationFaultStep: step
        }),
        new RegExp(`forced v14 migration fault: ${step}`)
      );
      assert.deepEqual(snapshotV13(target), before, step);
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test('inconsistent populated v13 canary counters refuse v14 migration without writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-accounting-'));
  const path = join(dir, 'source.sqlite');
  try {
    const source = new YuqiStore(path, { targetVersion: 13 });
    const controller = new PromotionController({
      store: source,
      presetRegistry: { evidenceManifest: key => ({ checksum: `checksum:${key}`, presetVersion: '2.0.0' }) },
      clock: () => 1_000
    });
    controller.initialize();
    source.db.prepare(`
      UPDATE cognition_kind_rollouts SET canary_started_count = 1
      WHERE rollout_key = 'DIRECT_REPLY'
    `).run();
    source.close();
    const before = snapshotV13(path);
    assert.throws(
      () => new YuqiStore(path),
      /v14 migration canary accounting conflict/
    );
    assert.deepEqual(snapshotV13(path), before);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function ensureV14DirectRollout(store) {
  if (store.getCognitionRollout('DIRECT_REPLY')) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey: 'DIRECT_REPLY',
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: 'a'.repeat(64)
    }],
    now: 1
  });
}

function v14FailureEnvelope({ suffix, parent = null }) {
  const parentWire = parent ? JSON.parse(parent.envelopeJson) : null;
  const rootMessageId = parentWire?.authority?.rootSourceId || `msg_v14_failure_${suffix}`;
  const retryOfTurnId = parent?.turnId || null;
  const claimedLineageRevision = parent
    ? Number(parent.lineageRevisionAtCreation) + 1
    : 1;
  const message = parentWire?.message || {
    messageId: rootMessageId,
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: `v14 failure fixture ${suffix}`,
    sentAt: 91_000
  };
  const currentBatch = parentWire?.context?.currentBatch || {
    batchId: `batch_v14_failure_${rootMessageId}`,
    messageIds: [rootMessageId],
    startedAt: message.sentAt,
    committedAt: 91_001,
    messages: [message]
  };
  const localSequence = parentWire
    ? Number(parentWire.context.visibilityCursor.localSequence) + 1
    : 1;
  const laneKey = 'private_chat';
  return {
    protocolVersion: 3,
    turnId: `turn_v14_failure_${suffix}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: 20_000 + claimedLineageRevision,
    createdAt: 91_001 + claimedLineageRevision,
    kind: 'DIRECT_REPLY',
    message,
    context: {
      currentBatch,
      ...(retryOfTurnId ? {
        retry: { retryOfTurnId, canonicalMessageId: rootMessageId }
      } : {}),
      visibilityCursor: {
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
      }
    },
    authority: {
      algorithm: 'al-authority-v1',
      roleId: 'yuqi',
      laneKey,
      rootSourceId: rootMessageId,
      lineageKey: deriveAuthorityLineageKey({ roleId: 'yuqi', laneKey, rootSourceId: rootMessageId }),
      claimedLineageRevision,
      retryOfTurnId
    }
  };
}

function createV14FailureTurn(store, suffix, parent = null) {
  ensureV14DirectRollout(store);
  const envelope = validateEnvelope(v14FailureEnvelope({ suffix, parent }));
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: envelope.message.sentAt });
  return store.createCanonicalVisibleTurnInternal({
    envelope,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: envelope.context.currentBatch.batchId,
    inputVisibilitySequence: envelope.context.visibilityCursor.localSequence,
    inputClearEpoch: envelope.context.visibilityCursor.clearEpoch,
    agencySnapshotChecksum: agency.checksum,
    annotationSnapshot: {}
  }).turn;
}

function failV14FailureTurn(store, turn) {
  return store.recordCanonicalTurnFailureInternal({
    turnId: turn.turnId,
    expectedState: turn.state,
    expectedTurnRevision: turn.turnRevision,
    failure: {
      name: 'TimeoutError',
      code: 'YUQI_TRANSIENT_EXECUTION_FAILURE',
      message: 'canonical failure delivery fixture',
      failureClass: 'transient',
      retryAllowed: true
    }
  });
}

function prepareV14FailureDeliveryState(store, variant) {
  const parent = failV14FailureTurn(store, createV14FailureTurn(store, variant.name));
  const peerId = parent.deviceId;
  let claim = null;
  const claimFailure = () => {
    claim = store.claimCanonicalFailureCloudDeliveryInternal({
      turnId: parent.turnId, peerId, timestamp: 200_000
    });
    assert.ok(claim, `${variant.name} must claim the canonical failure delivery`);
  };
  const mailbox = () => store.markCanonicalFailureCloudDeliveryMailboxedInternal({
    turnId: parent.turnId,
    peerId,
    rawStatusChecksum: claim.rawStatusChecksum,
    leaseId: claim.leaseId,
    leaseAttempt: claim.leaseAttempt,
    relayMessageId: claim.relayMessageId,
    timestamp: 200_100
  });
  const quarantine = () => {
    const target = store.listCloudDeliveries(parent.turnId)[0];
    return store.quarantineCanonicalCloudDeliveryInternal({
      turnId: parent.turnId,
      peerId,
      expected: {
        state: target.state, payloadJson: target.payloadJson, checksum: target.checksum,
        attempts: target.attempts, relayMessageId: target.relayMessageId,
        deliveredAt: target.deliveredAt, updatedAt: target.updatedAt
      },
      reason: 'authority_validation_failed'
    });
  };
  switch (variant.prepare) {
    case 'waiting':
      break;
    case 'pending':
      claimFailure();
      break;
    case 'mailboxed':
      claimFailure();
      mailbox();
      break;
    case 'superseded_empty':
      createV14FailureTurn(store, `${variant.name}_child`, parent);
      break;
    case 'superseded_payload':
      claimFailure();
      createV14FailureTurn(store, `${variant.name}_child`, parent);
      break;
    case 'superseded_mailboxed':
      claimFailure();
      createV14FailureTurn(store, `${variant.name}_child`, parent);
      mailbox();
      break;
    case 'quarantined_waiting':
      quarantine();
      break;
    case 'quarantined_pending':
      claimFailure();
      quarantine();
      break;
    default:
      throw new Error(`unknown canonical failure fixture state: ${variant.prepare}`);
  }
  return { parent, peerId };
}

const V14_CANONICAL_FAILURE_REOPEN_VARIANTS = [
  { name: 'waiting', prepare: 'waiting', state: 'waiting', payload: false, relay: false },
  { name: 'pending', prepare: 'pending', state: 'pending', payload: true, relay: false },
  { name: 'mailboxed', prepare: 'mailboxed', state: 'mailboxed', payload: true, relay: true },
  { name: 'superseded-empty', prepare: 'superseded_empty', state: 'superseded', payload: false, relay: false },
  { name: 'superseded-payload', prepare: 'superseded_payload', state: 'superseded', payload: true, relay: false },
  { name: 'superseded-mailboxed', prepare: 'superseded_mailboxed', state: 'superseded_mailboxed', payload: true, relay: true },
  { name: 'quarantined-from-waiting', prepare: 'quarantined_waiting', state: 'quarantined', payload: false, relay: false },
  { name: 'quarantined-from-pending', prepare: 'quarantined_pending', state: 'quarantined', payload: false, relay: false }
];

for (const variant of V14_CANONICAL_FAILURE_REOPEN_VARIANTS) {
  test(`v14 canonical failure delivery ${variant.name} survives SQLite close and reopen`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-failure-reopen-'));
    const path = join(dir, 'runtime.sqlite');
    let fixture;
    try {
      const store = new YuqiStore(path);
      try {
        fixture = prepareV14FailureDeliveryState(store, variant);
      } finally {
        store.close();
      }
      const reopened = new YuqiStore(path);
      try {
        const delivery = reopened.db.prepare(`
          SELECT state, authority_group_id, payload_json, checksum, relay_message_id, delivered_at
          FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
        `).get(fixture.parent.turnId, fixture.peerId);
        assert.equal(delivery.state, variant.state);
        assert.equal(delivery.authority_group_id, null);
        assert.equal(delivery.payload_json != null, variant.payload);
        assert.equal(delivery.checksum != null, variant.payload);
        assert.equal(delivery.relay_message_id != null, variant.relay);
        assert.equal(delivery.delivered_at != null, variant.relay);
        assert.doesNotThrow(() => reopened.assertVisibleAuthorityV13Invariants());
        assert.doesNotThrow(() => reopened.assertReleaseAuthorityV14Invariants());
      } finally {
        reopened.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
}

function rawV14FailureDelivery(store, fixture) {
  return store.db.prepare(`
    SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
  `).get(fixture.parent.turnId, fixture.peerId);
}

function rawV14FailurePayload(store, fixture, change) {
  const delivery = rawV14FailureDelivery(store, fixture);
  const payload = JSON.parse(delivery.payload_json);
  change(payload, delivery);
  store.db.prepare(`UPDATE cloud_deliveries SET payload_json = ? WHERE turn_id = ? AND peer_id = ?`)
    .run(JSON.stringify(payload), fixture.parent.turnId, fixture.peerId);
}

function appendV14FailureGrandchild(store, fixture) {
  const child = store.getTurn(store.getTurnAuthorityLineage(fixture.parent.authorityLineageKey).latestTurnId);
  const failedChild = failV14FailureTurn(store, child);
  return createV14FailureTurn(store, 'corrupt_multilevel_grandchild', failedChild);
}

function assertV14FailureCorruptionRejected(scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-v14-failure-corruption-'));
  const path = join(dir, 'runtime.sqlite');
  try {
    const store = new YuqiStore(path);
    try {
      const fixture = prepareV14FailureDeliveryState(store, {
        name: `corrupt_${scenario.name}`,
        prepare: scenario.prepare || 'pending'
      });
      scenario.mutate(store, fixture);
    } finally {
      store.close();
    }
    assert.throws(() => {
      const reopened = new YuqiStore(path);
      reopened.close();
    }, /canonical failure|v13 invariant|v11 invariant|authority|retry permission/i, scenario.name);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

const V14_CANONICAL_FAILURE_CORRUPTIONS = [
  {
    name: 'result-authority-version',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET result_authority_version = 0 WHERE turn_id = ?
    `).run(fixture.parent.turnId)
  },
  {
    name: 'authority-group-id',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE cloud_deliveries SET authority_group_id = 'forged_failure_group'
      WHERE turn_id = ? AND peer_id = ?
    `).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'invalid-state',
    mutate: (store, fixture) => {
      store.db.exec('PRAGMA ignore_check_constraints = ON');
      try {
        store.db.prepare(`UPDATE cloud_deliveries SET state = 'delivered'
          WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId);
      } finally {
        store.db.exec('PRAGMA ignore_check_constraints = OFF');
      }
    }
  },
  {
    name: 'foreign-peer',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE cloud_deliveries SET peer_id = 'foreign_phone' WHERE turn_id = ? AND peer_id = ?
    `).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'parent-lineage',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET authority_lineage_key = 'forged_failure_lineage' WHERE turn_id = ?
    `).run(fixture.parent.turnId)
  },
  {
    name: 'direct-retry-parent',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turns SET retry_of_turn_id = 'forged_parent'
      WHERE authority_lineage_key = ? AND retry_of_turn_id = ?
    `).run(fixture.parent.authorityLineageKey, fixture.parent.turnId)
  },
  {
    name: 'lineage-latest',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => store.db.prepare(`
      UPDATE turn_authority_lineages SET latest_turn_id = ? WHERE lineage_key = ?
    `).run(fixture.parent.turnId, fixture.parent.authorityLineageKey)
  },
  {
    name: 'multilevel-retry',
    prepare: 'superseded_empty',
    mutate: (store, fixture) => {
      const grandchild = appendV14FailureGrandchild(store, fixture);
      store.db.prepare(`UPDATE turns SET retry_of_turn_id = ? WHERE turn_id = ?`)
        .run(fixture.parent.turnId, grandchild.turnId);
    }
  },
  {
    name: 'error-extra-field',
    mutate: (store, fixture) => store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
      .run(JSON.stringify({ ...JSON.parse(fixture.parent.errorJson), extra: 'leak' }), fixture.parent.turnId)
  },
  {
    name: 'error-missing-code',
    mutate: (store, fixture) => {
      const error = JSON.parse(fixture.parent.errorJson);
      delete error.code;
      store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
        .run(JSON.stringify(error), fixture.parent.turnId);
    }
  },
  {
    name: 'error-nonboolean-retry',
    mutate: (store, fixture) => store.db.prepare(`UPDATE turns SET error_json = ? WHERE turn_id = ?`)
      .run(JSON.stringify({ ...JSON.parse(fixture.parent.errorJson), retryAllowed: 'true' }), fixture.parent.turnId)
  },
  {
    name: 'payload-extra-field',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => { payload.extra = 'leak'; })
  },
  {
    name: 'payload-missing-failure',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => { delete payload.failure; })
  },
  {
    name: 'payload-value-change',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => {
      payload.failure.message = 'forged failure detail';
    })
  },
  {
    name: 'checksum',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET checksum = ?
      WHERE turn_id = ? AND peer_id = ?`).run('f'.repeat(64), fixture.parent.turnId, fixture.peerId)
  },
  ...['leaseId', 'leaseAttempt', 'leasedAt'].map(key => ({
    name: `lease-missing-${key}`,
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => { delete payload.lease[key]; })
  })),
  {
    name: 'lease-attempt',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => { payload.lease.leaseAttempt += 1; })
  },
  {
    name: 'lease-id',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, payload => { payload.lease.leaseId = 'lease_forged'; })
  },
  {
    name: 'lease-time',
    mutate: (store, fixture) => rawV14FailurePayload(store, fixture, (payload, delivery) => {
      payload.lease.leasedAt = Number(delivery.updated_at) + 1;
    })
  },
  {
    name: 'relay-id',
    prepare: 'mailboxed',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET relay_message_id = 'relay_forged'
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'delivered-at',
    prepare: 'mailboxed',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET delivered_at = NULL
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  },
  {
    name: 'quarantine-duplicate-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => {
      const diagnostic = store.db.prepare(`SELECT detail_json FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`).get(fixture.parent.turnId);
      store.db.prepare(`INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
        VALUES (?, 'canonical_failure_delivery_quarantined', 'error', ?, 1)`)
        .run(fixture.parent.turnId, diagnostic.detail_json);
    }
  },
  {
    name: 'quarantine-extra-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: fixture.peerId, reason: 'bad', extra: true }), fixture.parent.turnId)
  },
  {
    name: 'quarantine-secret-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: fixture.peerId, reason: 'bad', secret: 'leak' }), fixture.parent.turnId)
  },
  {
    name: 'quarantine-wrong-peer-diagnostic',
    prepare: 'quarantined_waiting',
    mutate: (store, fixture) => store.db.prepare(`UPDATE diagnostics SET detail_json = ?
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'`)
      .run(JSON.stringify({ redacted: true, peerId: 'foreign_phone', reason: 'bad' }), fixture.parent.turnId)
  },
  {
    name: 'pending-after-child',
    prepare: 'superseded_payload',
    mutate: (store, fixture) => store.db.prepare(`UPDATE cloud_deliveries SET state = 'pending'
      WHERE turn_id = ? AND peer_id = ?`).run(fixture.parent.turnId, fixture.peerId)
  }
];

for (const scenario of V14_CANONICAL_FAILURE_CORRUPTIONS) {
  test(`v14 reopen rejects canonical failure corruption: ${scenario.name}`, () =>
    assertV14FailureCorruptionRejected(scenario));
}
