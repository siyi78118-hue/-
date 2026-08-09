import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  canonicalJson,
  contentHash,
  validateConversationClearApplied,
  validateConversationClearControl
} from '../yuqi-runtime/src/protocol.mjs';
import { generationFingerprint, laneKeyForEnvelope } from '../yuqi-runtime/src/interaction-lanes.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';
import { commitVisibleResult } from '../yuqi-runtime/src/visible-result-commit.mjs';

const EXTRACTOR = join(process.cwd(), 'scripts', 'extract-yuqi-real-history-scenes.mjs');
const SHA_A = 'a'.repeat(64);
const STRUCTURES = [
  'social_bid', 'temporary_stance', 'stage_leak', 'proactive_collision', 'payment',
  'repair', 'time_gap', 'multi_bubble', 'media_or_quote'
];

function sha256File(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function privateDir(root) { return join(root, 'artifacts', 'yuqi-lived-agency-v3', 'private'); }
function runExtractor(database, root, extra = []) {
  return execFileSync(process.execPath, [EXTRACTOR, '--database', database, '--root', root, '--limit', '30', ...extra], {
    cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
}
function canonicalEnvelope(index, at) {
  return {
    protocolVersion: 2, turnId: `turn_v15_${index}`, characterId: 'yuqi', deviceId: 'device-1',
    deviceSeq: index + 1, createdAt: at, kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_v15_source_${index}`, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
      content: `source ${index}`, sentAt: at - 1_000
    }
  };
}

function createRealV15Fixture(path, { windows = 30, turnsPerWindow = 4, mutate = null, includeAutomatic = false, includeRedacted = false } = {}) {
  const store = new YuqiStore(path);
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [
        { rolloutKey: 'DIRECT_REPLY', currentMode: 'legacy', rolloutPhase: 'stable', presetVersion: '1.9.2', pipelineChecksum: SHA_A },
        ...(includeAutomatic ? [{ rolloutKey: 'PROACTIVE_CHAT', currentMode: 'legacy', rolloutPhase: 'stable', presetVersion: '1.9.2', pipelineChecksum: SHA_A }] : [])
      ],
      now: 1
    });
    let index = 0;
    const base = 1_700_000_000_000;
    for (let window = 0; window < windows; window += 1) {
      for (let offset = 0; offset < turnsPerWindow; offset += 1) {
        const at = base + (window * 20 * 60_000) + (offset * 60_000);
        const envelope = canonicalEnvelope(index, at);
        const rollout = store.getCognitionRollout('DIRECT_REPLY');
        const laneKey = laneKeyForEnvelope(envelope);
        const lane = store.getInteractionLane('yuqi', laneKey);
        const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at });
        const turn = store.createCanonicalVisibleTurnInternal({
          envelope, rolloutKey: 'DIRECT_REPLY', expectedRolloutRevision: rollout.revision,
          authoritativeReleaseId: rollout.stableReleaseId, comparisonReleaseId: null, comparisonDirection: null,
          laneKey, expectedLaneRevision: Number(lane?.revision || 0), inputUserBatchId: `batch_${envelope.message.messageId}`,
          inputVisibilitySequence: Number(lane?.localSequence || 0), inputClearEpoch: Number(lane?.clearEpoch || 0),
          agencySnapshotChecksum: agency.checksum, annotationSnapshot: {}
        }).turn;
        const currentLane = store.getInteractionLane('yuqi', turn.laneKey);
        const state = store.getCognitiveState('yuqi');
        const visibleGroup = { items: [{ content: `reply ${index}`, speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }] };
        commitVisibleResult({
          store, turnId: turn.turnId, authorityLineageKey: turn.authorityLineageKey, laneKey: turn.laneKey,
          expectedTurnRevision: turn.turnRevision, expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
          expectedLaneRevision: Number(currentLane.revision), expectedCognitiveStateRevision: Number(state?.revision || 0),
          expectedLatestUserBatchId: turn.inputUserBatchId, inputVisibilitySequence: turn.inputVisibilitySequence,
          inputClearEpoch: turn.inputClearEpoch, protocolVersion: turn.protocolVersion, turnKind: turn.rolloutKey,
          agencySnapshotChecksum: turn.agencySnapshotChecksum, authoritativeReleaseId: turn.authoritativeReleaseId,
          visibleGroup, actionSet: [], proactiveMotiveEvidenceIds: [], statePatch: { mood: 'warm', openThreads: [] },
          memoryJobs: [], comparisonJob: null,
          generationFingerprint: generationFingerprint({ roleId: turn.characterId, laneKey: turn.laneKey,
            inputVisibilitySequence: turn.inputVisibilitySequence, visibleGroup, actionSet: [], contextRevision: turn.agencySnapshotChecksum }),
          now: at + 2_000
        });
        index += 1;
      }
    }
    if (includeRedacted) {
      const redactedTurn = store.db.prepare("SELECT authority_lineage_key FROM turns WHERE turn_id = 'turn_v15_0'").get();
      store.redactCanonicalConversationLineageInternal({
        lineage: store.db.prepare('SELECT * FROM turn_authority_lineages WHERE lineage_key = ?').get(redactedTurn.authority_lineage_key), redactedAt: base + 500, fault: () => {}
      });
    }
    if (includeAutomatic) {
      const at = base + (windows * 20 * 60_000) + 10_000;
      const envelope = { protocolVersion: 2, turnId: 'turn_v15_auto', characterId: 'yuqi', deviceId: 'device-1', deviceSeq: index + 1, createdAt: at, kind: 'PROACTIVE_CHAT', trigger: { triggerId: 'trigger_auto', triggerType: 'proactive_chat', scheduledFor: at, executedAt: at } };
      const rollout = store.getCognitionRollout('PROACTIVE_CHAT');
      const laneKey = laneKeyForEnvelope(envelope);
      const lane = store.getInteractionLane('yuqi', laneKey);
      const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at });
      const turn = store.createCanonicalVisibleTurnInternal({
        envelope, rolloutKey: 'PROACTIVE_CHAT', expectedRolloutRevision: rollout.revision,
        authoritativeReleaseId: rollout.stableReleaseId, comparisonReleaseId: null, comparisonDirection: null,
        laneKey, expectedLaneRevision: Number(lane?.revision || 0), inputUserBatchId: 'trigger_auto',
        inputVisibilitySequence: Number(lane?.localSequence || 0), inputClearEpoch: Number(lane?.clearEpoch || 0),
        agencySnapshotChecksum: agency.checksum, annotationSnapshot: {}
      }).turn;
      const currentLane = store.getInteractionLane('yuqi', turn.laneKey);
      const state = store.getCognitiveState('yuqi');
      commitVisibleResult({
        store, turnId: turn.turnId, authorityLineageKey: turn.authorityLineageKey, laneKey: turn.laneKey,
        expectedTurnRevision: turn.turnRevision, expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
        expectedLaneRevision: Number(currentLane.revision), expectedCognitiveStateRevision: Number(state?.revision || 0),
        expectedLatestUserBatchId: turn.inputUserBatchId, inputVisibilitySequence: turn.inputVisibilitySequence,
        inputClearEpoch: turn.inputClearEpoch, protocolVersion: turn.protocolVersion, turnKind: turn.rolloutKey,
        agencySnapshotChecksum: turn.agencySnapshotChecksum, authoritativeReleaseId: turn.authoritativeReleaseId,
        visibleGroup: { items: [{ content: 'automatic reply', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }] }, actionSet: [], proactiveMotiveEvidenceIds: [], statePatch: { mood: 'warm', openThreads: [] }, memoryJobs: [], comparisonJob: null,
        generationFingerprint: generationFingerprint({ roleId: turn.characterId, laneKey: turn.laneKey, inputVisibilitySequence: turn.inputVisibilitySequence, visibleGroup: { items: [{ content: 'automatic reply', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }] }, actionSet: [], contextRevision: turn.agencySnapshotChecksum }), now: at + 2_000
      });
    }
    if (mutate) mutate(store);
  } finally { store.close(); }
}

function legacyRa0Envelope(index, at, { multiBubble = false } = {}) {
  const turnId = `turn_ra0_quality_${index}`;
  const messageId = `msg_ra0_quality_${index}`;
  const batchId = `batch_ra0_quality_${index}`;
  const message = {
    messageId, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: `synthetic user ${index}`, sentAt: at
  };
  const messages = multiBubble ? [0, 1, 2].map(bubble => ({
    messageId: `${messageId}_${bubble}`, speakerId: 'user', speakerType: 'user', recipientId: 'yuqi',
    content: `synthetic user ${index} bubble ${bubble}`, sentAt: at + bubble
  })) : [message];
  const source = messages.at(-1);
  return {
    protocolVersion: 2, turnId, characterId: 'yuqi', deviceId: 'device-ra0',
    deviceSeq: index + 1, createdAt: at, kind: 'DIRECT_REPLY', message: source,
    context: {
      currentBatch: {
        batchId, messageIds: messages.map(item => item.messageId), startedAt: at, committedAt: at + (multiBubble ? 3 : 1),
        messages
      }
    }
  };
}

function rawSha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function legacyMessageRowChecksum(row) {
  return contentHash({
    messageId: row.message_id, turnId: row.turn_id, characterId: row.character_id,
    speakerId: row.speaker_id, speakerType: row.speaker_type, recipientId: row.recipient_id,
    content: row.content, sentAt: row.sent_at, origin: row.origin,
    deviceId: row.device_id, deviceSeq: row.device_seq
  });
}

function recomputeLegacyBatchCommitments(store, turnId) {
  const batch = store.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').get(turnId);
  const items = store.db.prepare('SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence').all(turnId);
  const tombstoneCommitment = contentHash({
    version: 'current-user-batch-tombstone-v1', turnId: batch.turn_id, batchId: batch.batch_id,
    itemCount: items.length, items: items.map(item => ({ sequence: item.sequence, messageId: item.message_id, checksum: item.checksum }))
  });
  store.db.prepare('UPDATE current_user_batches SET checksum = ?, item_count = ?, tombstone_commitment = ? WHERE turn_id = ?')
    .run(contentHash({ batchId: batch.batch_id, sourceMessageId: batch.source_message_id, messageIds: items.map(item => item.message_id), startedAt: batch.started_at, committedAt: batch.committed_at }), items.length, tombstoneCommitment, turnId);
}

function createLegacyRa0Fixture(path, { windows = 30, turnsPerWindow = 2, mutate = null, multiBubbleFirst = false } = {}) {
  const store = new YuqiStore(path);
  const base = Date.now();
  try {
    let index = 0;
    for (let window = 0; window < windows; window += 1) {
      for (let offset = 0; offset < turnsPerWindow; offset += 1) {
        const at = base + (window * 20 * 60_000) + (offset * 60_000);
        const envelope = legacyRa0Envelope(index, at, { multiBubble: multiBubbleFirst && index === 0 });
        const turn = store.submitTurn(envelope);
        store.db.prepare('UPDATE turns SET state = ? WHERE turn_id = ?').run('completed', turn.turnId);
        const reply = {
          messageId: `msg_ra0_reply_${index}`, turnId: turn.turnId, characterId: 'yuqi',
          speakerId: 'yuqi', speakerType: 'character', recipientId: 'user',
          content: `synthetic assistant ${index}`, sentAt: at + 5_000, origin: 'legacy',
          deviceId: 'device-ra0', deviceSeq: index + 1
        };
        store.putMessage(reply);
        const payload = {
          turnId: turn.turnId, messageId: reply.messageId, speakerId: reply.speakerId,
          speakerType: reply.speakerType, recipientId: reply.recipientId, content: reply.content,
          contentSha256: rawSha256(reply.content)
        };
        store.registerCloudDelivery(turn.turnId, 'device-ra0', 0);
        const prepared = store.prepareCloudDelivery(turn.turnId, 'device-ra0', payload);
        store.markCloudDeliveryAttempt(turn.turnId, 'device-ra0');
        store.markCloudDeliveryMailboxed(turn.turnId, 'device-ra0', prepared.checksum);
        store.confirmCloudDelivery(turn.turnId, 'device-ra0', {
          messageId: reply.messageId, contentSha256: rawSha256(reply.content), receivedAt: at + 7_000
        });
        store.db.prepare('UPDATE cloud_deliveries SET delivered_at = ?, confirmed_at = ?, updated_at = ? WHERE turn_id = ?')
          .run(at + 6_000, at + 7_000, at + 7_000, turn.turnId);
        index += 1;
      }
    }
    if (mutate) mutate(store);
  } finally {
    store.close();
  }
}

function insertClearControls(store, { includeV0 = true, includeV1 = true } = {}) {
  if (includeV0) {
    store.db.prepare(`
      INSERT INTO conversation_clear_controls(
        control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
        requested_at, applied_at, input_cursor_checksum, checksum,
        applied_checksum, authority_version, semantic_json
      ) VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, ?, NULL, 0, NULL)
    `).run('legacy_clear_1', 'yuqi', 1, 0, 1_700_000_000_000, 1_700_000_000_001, 'legacy-checksum');
  }
  if (includeV1) {
    const inputCursorChecksum = SHA_A;
    const body = {
      protocolVersion: 3,
      type: 'CONVERSATION_CLEAR',
      controlVersion: 'conversation_clear_v1',
      controlId: `ctl_${contentHash({
        contract: 'android-lifecycle-control-id-v1', controlKind: 'conversation_clear_v1',
        characterId: 'yuqi', peerId: 'device-1', clearEpoch: 2,
        clearedThroughSequence: 0, requestedAt: 1_700_000_000_100, inputCursorChecksum
      })}`,
      roleId: 'yuqi', peerId: 'device-1', clearEpoch: 2, clearedThroughSequence: 0,
      requestedAt: 1_700_000_000_100, inputCursorChecksum
    };
    const control = validateConversationClearControl({ ...body, checksum: contentHash(body) });
    const appliedBody = {
      protocolVersion: 3, type: 'CONVERSATION_CLEAR_APPLIED', controlId: control.controlId,
      controlChecksum: control.checksum, roleId: control.roleId, peerId: control.peerId,
      clearEpoch: control.clearEpoch, clearedThroughSequence: control.clearedThroughSequence,
      appliedAt: 1_700_000_000_200
    };
    const applied = validateConversationClearApplied({ ...appliedBody, checksum: contentHash(appliedBody) });
    store.db.prepare(`
      INSERT INTO conversation_clear_controls(
        control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
        requested_at, applied_at, input_cursor_checksum, checksum,
        applied_checksum, authority_version, semantic_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      control.controlId, control.roleId, control.peerId, control.clearEpoch,
      control.clearedThroughSequence, control.requestedAt, applied.appliedAt,
      control.inputCursorChecksum, control.checksum, applied.checksum, canonicalJson(control)
    );
  }
}

function makeLabel(candidate, index) {
  return {
    windowId: candidate.windowId, sourceWindowChecksum: candidate.sourceWindowChecksum, annotatorVersion: 'human-v1',
    initialState: { relationship: { base: 'steady', phase: 'familiar' }, lifeSignals: [], currentStances: [], verifiedFacts: [] },
    mustNotice: [`notice-${index}`], allowedDecisionRange: ['direct'], forbiddenFailurePatterns: ['invented_fact'],
    requiredActionIntegrity: { required: false, allowedKinds: ['none'] }, allowedPersonalityVariation: ['warm'],
    expectedStateTransitions: { allow: ['maintain'] }, forbiddenStateTransitions: { hardConstraintFromYuqiPreference: true },
    severity: 'medium', structure: STRUCTURES[index % STRUCTURES.length]
  };
}

function writeLabels(root, labels) {
  const path = join(root, 'labels.jsonl');
  writeFileSync(path, `${labels.map(label => JSON.stringify(label)).join('\n')}\n`, 'utf8');
  return path;
}

test('legacy_ra0_confirmed explicit source authority accepts synthetic confirmed legacy windows', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-red-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database);
    const result = JSON.parse(runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']));
    const candidates = readFileSync(result.candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(result.count, 30);
    assert.equal(candidates.length, 30);
    for (const candidate of candidates) {
      assert.deepEqual({
        sourceAuthority: candidate.sourceAuthority,
        qualityOnly: candidate.qualityOnly,
        authorityEvidenceEligible: candidate.authorityEvidenceEligible,
        promotionEvidenceEligible: candidate.promotionEvidenceEligible
      }, {
        sourceAuthority: 'legacy_ra0_confirmed', qualityOnly: true,
        authorityEvidenceEligible: false, promotionEvidenceEligible: false
      });
      assert.equal(Object.hasOwn(candidate, 'shadow'), false);
      assert.equal(Object.hasOwn(candidate, 'rollout'), false);
      assert.equal(Object.hasOwn(candidate, 'promotion'), false);
      assert.equal(candidate.turns.length, 4);
    }
    const labels = writeLabels(root, candidates.map((candidate, index) => makeLabel(candidate, index)));
    const labeled = JSON.parse(runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed', '--labels', labels]));
    const manifest = JSON.parse(readFileSync(labeled.manifest, 'utf8'));
    assert.deepEqual({
      sourceAuthority: manifest.sourceAuthority,
      qualityOnly: manifest.qualityOnly,
      authorityEvidenceEligible: manifest.authorityEvidenceEligible,
      promotionEvidenceEligible: manifest.promotionEvidenceEligible
    }, {
      sourceAuthority: 'legacy_ra0_confirmed', qualityOnly: true,
      authorityEvidenceEligible: false, promotionEvidenceEligible: false
    });
    const scenes = readFileSync(labeled.output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(scenes.every(scene => scene.sourceAuthority === 'legacy_ra0_confirmed' && scene.qualityOnly === true), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy_ra0_confirmed rejects malformed delivery/message/batch provenance before publication', () => {
  const cases = [
    ['mailboxed delivery', store => store.db.prepare("UPDATE cloud_deliveries SET state = 'mailboxed', confirmed_at = NULL").run(), /delivery|state|window|eligible/i],
    ['foreign delivery peer', store => store.db.prepare("UPDATE cloud_deliveries SET peer_id = 'foreign-peer'").run(), /delivery|peer|target/i],
    ['reversed delivery time', store => store.db.prepare('UPDATE cloud_deliveries SET confirmed_at = delivered_at - 1').run(), /delivery|time/i],
    ['missing confirmed time', store => store.db.prepare('UPDATE cloud_deliveries SET confirmed_at = NULL').run(), /delivery|time|confirmed/i],
    ['payload checksum drift', store => store.db.prepare("UPDATE cloud_deliveries SET payload_json = replace(payload_json, 'synthetic assistant 0', 'forged'), checksum = checksum").run(), /delivery|checksum|payload/i],
    ['self-consistent payload semantic drift', store => {
      const row = store.db.prepare("SELECT * FROM cloud_deliveries WHERE turn_id = 'turn_ra0_quality_0'").get();
      const payload = JSON.parse(row.payload_json);
      payload.content = 'forged but rehashed';
      payload.contentSha256 = rawSha256(payload.content);
      store.db.prepare('UPDATE cloud_deliveries SET payload_json = ?, checksum = ? WHERE turn_id = ?')
        .run(JSON.stringify(payload), contentHash(payload), row.turn_id);
    }, /delivery|payload|message/i],
    ['self-consistent envelope semantic drift', store => {
      const row = store.db.prepare("SELECT * FROM turns WHERE turn_id = 'turn_ra0_quality_0'").get();
      const envelope = JSON.parse(row.envelope_json);
      envelope.message.content = 'forged envelope';
      store.db.prepare('UPDATE turns SET envelope_json = ?, envelope_checksum = ? WHERE turn_id = ?')
        .run(JSON.stringify(envelope), contentHash(envelope), row.turn_id);
    }, /envelope|source|message/i],
    ['source owner drift', store => store.db.prepare("UPDATE messages SET device_id = 'foreign-device' WHERE speaker_type = 'user'").run(), /source|message|owner|authority/i],
    ['character output identity drift', store => store.db.prepare("UPDATE messages SET speaker_id = 'foreign-character' WHERE speaker_type = 'character'").run(), /character|message|authority/i],
    ['multiple character outputs', store => store.putMessage({
      messageId: 'msg_ra0_extra_character', turnId: 'turn_ra0_quality_0', characterId: 'yuqi', speakerId: 'yuqi',
      speakerType: 'character', recipientId: 'user', content: 'extra output', sentAt: Date.now(), origin: 'legacy',
      deviceId: 'device-ra0', deviceSeq: 999
    }), /character|message|count/i],
    ['extra delivery target', store => store.registerCloudDelivery('turn_ra0_quality_0', 'foreign-peer', 0), /delivery|target|peer/i],
    ['native timestamp coercion', store => store.db.prepare("UPDATE cloud_deliveries SET delivered_at = 'not-a-number'").run(), /delivery|time|native/i],
    ['missing batch', store => { store.db.prepare('DELETE FROM current_user_batch_items').run(); store.db.prepare('DELETE FROM current_user_batches').run(); }, /batch|authority/i],
    ['reused source message', store => store.db.prepare("UPDATE turns SET source_message_id = 'msg_ra0_quality_0' WHERE turn_id = 'turn_ra0_quality_1'").run(), /source|message|closure/i]
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-reject-'));
    const database = join(root, 'history.sqlite');
    try {
      createLegacyRa0Fixture(database, { mutate });
      assert.throws(() => runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']), new RegExp(`${pattern.source}|window|eligible`, pattern.flags), name);
      assert.equal(existsSync(privateDir(root)) ? readdirSync(privateDir(root)).length : 0, 0, `${name} must not publish candidates`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('legacy_ra0_confirmed requires thirty complete windows and preserves the source bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-count-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database, { windows: 29 });
    const before = sha256File(database);
    assert.throws(() => runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']), /30|window/i);
    assert.equal(sha256File(database), before);
    const validRoot = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-valid-'));
    const validDatabase = join(validRoot, 'history.sqlite');
    try {
      createLegacyRa0Fixture(validDatabase);
      const validBefore = sha256File(validDatabase);
      const result = JSON.parse(runExtractor(validDatabase, validRoot, ['--source-authority', 'legacy_ra0_confirmed']));
      assert.equal(result.count, 30);
      assert.equal(sha256File(validDatabase), validBefore);
    } finally {
      rmSync(validRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed legacy row terminates a window without bridging valid exchanges across it', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-boundary-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database, {
      windows: 31,
      mutate: store => store.db.prepare("UPDATE turns SET state = 'failed' WHERE turn_id = 'turn_ra0_quality_30'").run()
    });
    const result = JSON.parse(runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']));
    assert.equal(result.count, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy multi-bubble batch uses item JSON for early bubbles and only source row needs messages authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-bubbles-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database, { multiBubbleFirst: true });
    const result = JSON.parse(runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']));
    assert.equal(result.count, 30);
    const candidates = readFileSync(result.candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(candidates[0].turns[0].batch.length, 3);
    assert.match(candidates[0].turns[0].batch[0].text, /bubble 0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy source authority refuses a database that also contains canonical RA1 authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-mix-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database, { mutate: store => store.db.prepare(
      "UPDATE turns SET result_authority_version = 1 WHERE turn_id = 'turn_ra0_quality_0'"
    ).run() });
    assert.throws(() => runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']), /mix|RA1|canonical|authority/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy RA0 time, recipient, source-position, and ordering boundaries fail closed per row', () => {
  const cases = [
    ['createdAt mismatch', store => store.db.prepare("UPDATE turns SET created_at = created_at + 1 WHERE turn_id = 'turn_ra0_quality_0'").run(), /created|envelope|window|eligible/i],
    ['source recipient mismatch', store => store.db.prepare("UPDATE messages SET recipient_id = 'other-role' WHERE message_id = 'msg_ra0_quality_0'").run(), /source|recipient|message|window|eligible/i],
    ['character before batch', store => {
      const message = store.db.prepare("SELECT * FROM messages WHERE message_id = 'msg_ra0_reply_0'").get();
      const batch = store.db.prepare("SELECT committed_at FROM current_user_batches WHERE turn_id = 'turn_ra0_quality_0'").get();
      message.sent_at = batch.committed_at - 1;
      store.db.prepare('UPDATE messages SET sent_at = ?, checksum = ? WHERE message_id = ?')
        .run(message.sent_at, legacyMessageRowChecksum(message), message.message_id);
    }, /character|time|window|eligible/i],
    ['delivery before character', store => store.db.prepare("UPDATE cloud_deliveries SET delivered_at = delivered_at - 100000 WHERE turn_id = 'turn_ra0_quality_0'").run(), /delivery|time|window|eligible/i]
  ];
  for (const [name, mutate, pattern] of cases) {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-order-'));
    const database = join(root, 'history.sqlite');
    try {
      createLegacyRa0Fixture(database, { mutate });
      assert.throws(() => runExtractor(database, root, ['--source-authority', 'legacy_ra0_confirmed']), pattern, name);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const multiRoot = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-order-multi-'));
  const multiDatabase = join(multiRoot, 'history.sqlite');
  try {
    createLegacyRa0Fixture(multiDatabase, { multiBubbleFirst: true, mutate: store => {
      const batch = store.db.prepare("SELECT * FROM current_user_batches WHERE turn_id = 'turn_ra0_quality_0'").get();
      const items = store.db.prepare("SELECT * FROM current_user_batch_items WHERE turn_id = 'turn_ra0_quality_0' ORDER BY sequence").all();
      const first = JSON.parse(items[0].message_json);
      first.recipientId = 'other-role';
      store.db.prepare('UPDATE current_user_batch_items SET message_json = ?, checksum = ? WHERE turn_id = ? AND sequence = 0')
        .run(JSON.stringify(first), contentHash(first), batch.turn_id);
      recomputeLegacyBatchCommitments(store, batch.turn_id);
      store.db.prepare("UPDATE current_user_batches SET source_message_id = ? WHERE turn_id = 'turn_ra0_quality_0'")
        .run(items[0].message_id);
    } });
    assert.throws(() => runExtractor(multiDatabase, multiRoot, ['--source-authority', 'legacy_ra0_confirmed']), /recipient|source|batch|window|eligible/i);
  } finally {
    rmSync(multiRoot, { recursive: true, force: true });
  }
});

test('legacy_ra0_confirmed rejects non-authority source selection and canonical default remains RA1-only', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-legacy-ra0-provenance-'));
  const database = join(root, 'history.sqlite');
  try {
    createLegacyRa0Fixture(database);
    assert.throws(() => runExtractor(database, root, ['--source-authority', 'made_up']), /source authority|unsupported/i);
    assert.throws(() => runExtractor(database, root), /eligible|authority|candidate|window/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('v15 authority snapshot yields candidates only until a private labels sidecar is supplied', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-candidates-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database);
    const before = sha256File(database);
    const result = JSON.parse(runExtractor(database, root));
    assert.equal(result.labeled, false);
    assert.equal(result.count, 30);
    assert.equal(existsSync(result.candidatesPath), true);
    assert.equal(existsSync(join(privateDir(root), 'real-history-scenes.jsonl')), false);
    const candidates = readFileSync(result.candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(candidates.length, 30);
    assert.ok(candidates.every(candidate => candidate.turns.length >= 8 && candidate.turns.length <= 24));
    assert.doesNotMatch(readFileSync(result.candidatesPath, 'utf8'), /turn_v15_|msg_v15_source_|batch_msg_v15/);
    assert.equal(sha256File(database), before);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('candidate exchange windows are bounded to four through twelve persisted turns', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-window-bound-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, { windows: 60, turnsPerWindow: 8 });
    const result = JSON.parse(runExtractor(database, root));
    const candidates = readFileSync(result.candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(candidates.every(candidate => candidate.turns.length >= 4 && candidate.turns.length <= 12));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('independent labels bind exact candidate checksums and produce all-nine final scenes atomically', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-labels-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database);
    const candidateResult = JSON.parse(runExtractor(database, root));
    const candidates = readFileSync(candidateResult.candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const labels = writeLabels(root, candidates.map(makeLabel));
    const result = JSON.parse(runExtractor(database, root, ['--labels', labels]));
    assert.equal(result.labeled, true);
    const scenes = readFileSync(result.output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const manifest = JSON.parse(readFileSync(result.manifest, 'utf8'));
    assert.equal(scenes.length, 30);
    assert.deepEqual(Object.keys(manifest).sort(), ['sceneIds', 'scenesChecksum', 'schemaVersion']);
    assert.equal(new Set(scenes.map(scene => scene.sourceAnnotation.heading)).size, 9);
    assert.deepEqual(manifest.sceneIds, scenes.map(scene => scene.sceneId));
    assert.equal(manifest.scenesChecksum, contentHash(scenes));
    assert.ok(scenes.every(scene => scene.sourceAnnotation.file === 'private_history_labels'));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('labels cannot be stale, duplicated, incomplete, unknown, or override persisted turns/actions', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-label-errors-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database);
    const candidates = readFileSync(JSON.parse(runExtractor(database, root)).candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const cases = [
      labels => labels.slice(0, 29),
      labels => [...labels.slice(0, 29), { ...labels[29], sourceWindowChecksum: '0'.repeat(64) }],
      labels => [...labels.slice(0, 29), { ...labels[29], turns: [] }],
      labels => [...labels.slice(0, 29), { ...labels[29], secret: true }],
      labels => [...labels.slice(0, 29), { ...labels[29], initialState: { ...labels[29].initialState, secret: 'leak' } }],
      labels => [...labels.slice(0, 29), labels[0]]
    ];
    for (const [index, transform] of cases.entries()) {
      const labels = transform(candidates.map(makeLabel));
      const path = writeLabels(root, labels);
      assert.throws(() => runExtractor(database, root, ['--labels', path, '--out', `scene-${index}.jsonl`, '--manifest', `scene-${index}.manifest.json`]), /label|window|override|unknown|duplicate|exactly/i);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('labels reject a nested unknown initial-state field', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-label-nested-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database);
    const candidates = readFileSync(JSON.parse(runExtractor(database, root)).candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const labels = candidates.map(makeLabel);
    labels[0].initialState.secret = 'leak';
    const path = writeLabels(root, labels);
    assert.throws(() => runExtractor(database, root, ['--labels', path]), /initialState|unknown|closed/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('authority projection changes invalidate labels even when source rows remain structurally readable', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-stale-authority-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database);
    const candidates = readFileSync(JSON.parse(runExtractor(database, root)).candidatesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const labels = writeLabels(root, candidates.map(makeLabel));
    const db = new DatabaseSync(database);
    const groupId = db.prepare("SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0'").get().committed_group_id;
    db.prepare('UPDATE visible_result_groups SET generation_fingerprint = ? WHERE group_id = ?').run('b'.repeat(64), groupId);
    db.close();
    assert.throws(() => runExtractor(database, root, ['--labels', labels]), /stale|checksum|authority/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('pair publication rolls back both files on a manifest boundary fault', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-pair-'));
  try {
    const extractor = await import('../scripts/extract-yuqi-real-history-scenes.mjs');
    const output = join(root, 'scenes.jsonl');
    const manifest = join(root, 'scenes.manifest.json');
    const scenes = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${index}` }));
    const manifestValue = { schemaVersion: 1, sceneIds: scenes.map(scene => scene.sceneId), scenesChecksum: contentHash(scenes) };
    extractor.atomicWritePair(output, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(manifestValue)}\n`);
    const beforeOutput = readFileSync(output, 'utf8');
    const beforeManifest = readFileSync(manifest, 'utf8');
    const nextScenes = scenes.map(scene => ({ ...scene, generation: 2 }));
    const nextManifest = { schemaVersion: 1, sceneIds: nextScenes.map(scene => scene.sceneId), scenesChecksum: contentHash(nextScenes) };
    assert.throws(() => extractor.atomicWritePair(output, `${nextScenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(nextManifest)}\n`, { faultAt: 'before_manifest_rename' }), /publication fault/i);
    assert.equal(readFileSync(output, 'utf8'), beforeOutput);
    assert.equal(readFileSync(manifest, 'utf8'), beforeManifest);
    const restoredScenes = beforeOutput.trim().split('\n').map(line => JSON.parse(line));
    const restoredManifest = JSON.parse(beforeManifest);
    assert.equal(restoredManifest.scenesChecksum, contentHash(restoredScenes));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('invalid staged pair preserves an already published pair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-pair-invalid-'));
  try {
    const extractor = await import('../scripts/extract-yuqi-real-history-scenes.mjs');
    const output = join(root, 'scenes.jsonl');
    const manifest = join(root, 'scenes.manifest.json');
    const scenes = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${index}` }));
    const manifestValue = { schemaVersion: 1, sceneIds: scenes.map(scene => scene.sceneId), scenesChecksum: contentHash(scenes) };
    extractor.atomicWritePair(output, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(manifestValue)}\n`);
    const beforeOutput = readFileSync(output, 'utf8');
    const beforeManifest = readFileSync(manifest, 'utf8');
    const invalidScenes = scenes.slice(0, 29);
    const invalidManifest = { schemaVersion: 1, sceneIds: invalidScenes.map(scene => scene.sceneId), scenesChecksum: contentHash(invalidScenes) };
    assert.throws(() => extractor.atomicWritePair(output, `${invalidScenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(invalidManifest)}\n`), /staged history generation/i);
    assert.equal(readFileSync(output, 'utf8'), beforeOutput);
    assert.equal(readFileSync(manifest, 'utf8'), beforeManifest);
    assert.equal(JSON.parse(beforeManifest).scenesChecksum, contentHash(beforeOutput.trim().split('\n').map(line => JSON.parse(line))));
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('backup cleanup fault preserves the newly published pair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-pair-cleanup-'));
  try {
    const extractor = await import('../scripts/extract-yuqi-real-history-scenes.mjs');
    const scenes = Array.from({ length: 30 }, (_, index) => ({ sceneId: `scene_${index}` }));
    const nextScenes = scenes.map(scene => ({ ...scene, generation: 2 }));
    const nextManifest = { schemaVersion: 1, sceneIds: nextScenes.map(scene => scene.sceneId), scenesChecksum: contentHash(nextScenes) };
    for (const faultAt of ['after_output_backup_cleanup', 'before_manifest_backup_cleanup']) {
      const caseRoot = mkdtempSync(join(root, `${faultAt}-`));
      const output = join(caseRoot, 'scenes.jsonl');
      const manifest = join(caseRoot, 'scenes.manifest.json');
      const oldManifest = { schemaVersion: 1, sceneIds: scenes.map(scene => scene.sceneId), scenesChecksum: contentHash(scenes) };
      extractor.atomicWritePair(output, `${scenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(oldManifest)}\n`);
      assert.throws(() => extractor.atomicWritePair(output, `${nextScenes.map(scene => JSON.stringify(scene)).join('\n')}\n`, manifest, `${JSON.stringify(nextManifest)}\n`, { faultAt }), /pair cleanup fault/i);
      const publishedScenes = readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const publishedManifest = JSON.parse(readFileSync(manifest, 'utf8'));
      assert.equal(publishedManifest.scenesChecksum, contentHash(publishedScenes));
      assert.deepEqual(publishedManifest, nextManifest);
      const backups = readdirSync(caseRoot).filter(name => name.includes('.bak-'));
      assert.ok(backups.length <= 1);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v0/v10/v13/v14 snapshots fail closed before output or migration', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-versions-'));
  try {
    for (const version of [0, 10, 13, 14]) {
      const database = join(root, `v${version}.sqlite`);
      const db = new DatabaseSync(database);
      db.exec(`PRAGMA user_version = ${version}; CREATE TABLE turns(turn_id TEXT);`);
      db.close();
      const before = sha256File(database);
      assert.throws(() => runExtractor(database, root), /v15|authority snapshot|version/i);
      assert.equal(sha256File(database), before);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v15 clear-control authority requires the exact schema and validates v0/v1 rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-clear-controls-'));
  try {
    const valid = join(root, 'valid.sqlite');
    createRealV15Fixture(valid, { mutate: store => insertClearControls(store) });
    assert.equal(JSON.parse(runExtractor(valid, root)).count, 30);

    const fakeV14 = join(root, 'fake-v14.sqlite');
    createRealV15Fixture(fakeV14, {
      mutate: store => {
        store.db.exec('ALTER TABLE conversation_clear_controls RENAME TO conversation_clear_controls_v14; CREATE TABLE conversation_clear_controls (control_id TEXT PRIMARY KEY, role_id TEXT NOT NULL, clear_epoch INTEGER NOT NULL, cleared_through_sequence INTEGER NOT NULL, requested_at INTEGER NOT NULL, applied_at INTEGER NOT NULL, checksum TEXT NOT NULL);');
      }
    });
    assert.throws(() => runExtractor(fakeV14, root), /clear|schema|column|authority/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v15 clear-control v1 semantic, checksum, and authority-version tampering fails closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-clear-corruption-'));
  try {
    for (const [name, mutate] of [
      ['semantic', store => {
        insertClearControls(store, { includeV0: false });
        store.db.prepare('UPDATE conversation_clear_controls SET semantic_json = ?').run('{"forged":true}');
      }],
      ['checksum', store => {
        insertClearControls(store, { includeV0: false });
        store.db.prepare('UPDATE conversation_clear_controls SET checksum = ?').run('f'.repeat(64));
      }],
      ['authority-version', store => {
        insertClearControls(store, { includeV0: false });
        store.db.exec('PRAGMA ignore_check_constraints = ON; UPDATE conversation_clear_controls SET authority_version = 0; PRAGMA ignore_check_constraints = OFF;');
      }]
    ]) {
      const database = join(root, `${name}.sqlite`);
      createRealV15Fixture(database, { mutate });
      assert.throws(() => runExtractor(database, root), /clear|semantic|checksum|authority/i, name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v15 envelope validation rejects a self-consistent unknown field', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-envelope-closed-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, {
      mutate: store => {
        const row = store.db.prepare("SELECT turn_id, envelope_json FROM turns WHERE turn_id = 'turn_v15_0'").get();
        const envelope = JSON.parse(row.envelope_json);
        envelope.unknownSecret = 'should-not-be-normalized';
        store.db.prepare('UPDATE turns SET envelope_json = ?, envelope_checksum = ? WHERE turn_id = ?')
          .run(canonicalJson(envelope), contentHash(envelope), row.turn_id);
      }
    });
    assert.throws(() => runExtractor(database, root), /envelope|protocol|authority|unknown/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v15 schema gate requires target revision, recovery ack, and clear watermark columns', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-schema-columns-'));
  try {
    for (const [name, table, column] of [
      ['action-target-revision', 'visible_result_actions', 'target_revision'],
      ['delivery-recovery-ack', 'cloud_deliveries', 'recovery_ack_seq'],
      ['lane-clear-epoch', 'interaction_lanes', 'clear_epoch'],
      ['lane-cleared-through', 'interaction_lanes', 'cleared_through_sequence']
    ]) {
      const database = join(root, `${name}.sqlite`);
      createRealV15Fixture(database, { mutate: store => {
        if (table === 'visible_result_actions') {
          store.db.exec(`
            PRAGMA foreign_keys = OFF;
            ALTER TABLE visible_result_actions RENAME TO visible_result_actions_probe_old;
            CREATE TABLE visible_result_actions (
              group_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
              action_id TEXT NOT NULL UNIQUE, action_kind TEXT, target_key TEXT,
              action_json TEXT, action_checksum TEXT NOT NULL, redacted_at INTEGER,
              PRIMARY KEY(group_id, ordinal), FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
            );
            INSERT INTO visible_result_actions(group_id, ordinal, action_id, action_kind, target_key, action_json, action_checksum, redacted_at)
              SELECT group_id, ordinal, action_id, action_kind, target_key, action_json, action_checksum, redacted_at
              FROM visible_result_actions_probe_old;
            DROP TABLE visible_result_actions_probe_old;
            PRAGMA foreign_keys = ON;
          `);
        } else {
          store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        }
      } });
      assert.throws(() => runExtractor(database, root), /schema|column|authority/i, name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('v15 authority corruption and redaction are rejected without candidate output', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-corruption-'));
  try {
    for (const [name, mutate] of [
      ['batch', store => store.db.prepare('UPDATE current_user_batches SET checksum = ? WHERE turn_id = ?').run('0'.repeat(64), 'turn_v15_0')],
      ['result', store => {
        const groupId = store.db.prepare("SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0'").get().committed_group_id;
        store.db.prepare('UPDATE visible_result_items SET item_checksum = ? WHERE group_id = ?').run('0'.repeat(64), groupId);
      }],
      ['redacted', store => store.db.prepare("UPDATE turns SET authority_redacted_at = 1 WHERE turn_id = 'turn_v15_0'").run()],
      ['lane', store => store.db.prepare("UPDATE turns SET lane_key = 'foreign_lane' WHERE turn_id = 'turn_v15_0'").run()],
      ['latest', store => store.db.prepare("UPDATE turn_authority_lineages SET latest_turn_id = 'turn_v15_1' WHERE lineage_key = (SELECT authority_lineage_key FROM turns WHERE turn_id = 'turn_v15_0')").run()],
      ['retry-cycle', store => store.db.prepare("UPDATE turns SET retry_of_turn_id = turn_id WHERE turn_id = 'turn_v15_0'").run()],
      ['retry-foreign-parent', store => store.db.prepare("UPDATE turns SET retry_of_turn_id = 'turn_v15_1' WHERE turn_id = 'turn_v15_0'").run()],
      ['foreign-result-message', store => store.db.prepare("UPDATE messages SET authority_group_id = 'foreign_group' WHERE message_id = (SELECT message_id FROM visible_result_items LIMIT 1)").run()]
      ,['manifest-payload-version', store => store.db.prepare("UPDATE visible_result_manifests SET payload_version = 'forged-v99' WHERE group_id = (SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0')").run()]
      ,['manifest-semantic-checksum', store => store.db.prepare("UPDATE visible_result_manifests SET semantic_checksum = ? WHERE group_id = (SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0')").run('0'.repeat(64))]
      ,['receipt-commit-checksum', store => store.db.prepare("UPDATE visible_commit_receipts SET commit_checksum = ? WHERE group_id = (SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0')").run('f'.repeat(64))]
    ]) {
      const database = join(root, `${name}.sqlite`);
      createRealV15Fixture(database, { mutate });
      assert.throws(() => runExtractor(database, root), /authority|checksum|closure|redact|release/i, name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('active WAL read-only extraction ignores -shm lock noise and preserves source', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-wal-'));
  const database = join(root, 'snapshot.sqlite');
  let writer;
  try {
    createRealV15Fixture(database);
    writer = new DatabaseSync(database);
    writer.exec('PRAGMA journal_mode=WAL');
    const result = JSON.parse(runExtractor(database, root));
    assert.equal(result.count, 30);
  } finally { writer?.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('mixed v15 authority accepts automatic canonical turns without fabricated batches', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-automatic-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, { includeAutomatic: true });
    const result = JSON.parse(runExtractor(database, root));
    assert.equal(result.count, 30);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('valid v15 redacted committed history remains closed and is skipped from live candidates', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-redacted-valid-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, { windows: 31, includeRedacted: true });
    const result = JSON.parse(runExtractor(database, root));
    assert.equal(result.count, 30);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('authority closure requires a durable non-null release pin', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-release-pin-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, {
      mutate: store => store.db.prepare("UPDATE turns SET authoritative_pipeline_checksum = NULL WHERE turn_id = 'turn_v15_0'").run()
    });
    assert.throws(() => runExtractor(database, root), /release pin|release/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('authority closure requires persisted batch tombstone commitment and receipt lineage join', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-parent-commitments-'));
  try {
    for (const [name, mutate] of [
      ['missing-batch-tombstone', store => store.db.prepare("UPDATE current_user_batches SET tombstone_commitment = ? WHERE turn_id = 'turn_v15_0'").run('0'.repeat(64))],
      ['receipt-lineage', store => store.db.prepare("UPDATE visible_commit_receipts SET authority_origin = 'android_fallback' WHERE group_id = (SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0')").run()]
    ]) {
      const database = join(root, `${name}.sqlite`);
      createRealV15Fixture(database, { mutate });
      assert.throws(() => runExtractor(database, root), /commitment|receipt|lineage|authority/i, name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('manifest checksum must equal the receipt commit checksum', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-manifest-receipt-'));
  const database = join(root, 'snapshot.sqlite');
  try {
    createRealV15Fixture(database, {
      mutate: store => {
        const groupId = store.db.prepare("SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0'").get().committed_group_id;
        const manifest = store.db.prepare('SELECT semantic_json FROM visible_result_manifests WHERE group_id = ?').get(groupId);
        const semantic = JSON.parse(manifest.semantic_json);
        semantic.items = [...(semantic.items || []), { content: 'forged-but-self-consistent' }];
        store.db.prepare('UPDATE visible_result_manifests SET semantic_json = ?, semantic_checksum = ? WHERE group_id = ?')
          .run(JSON.stringify(semantic), contentHash(semantic), groupId);
      }
    });
    assert.throws(() => runExtractor(database, root), /manifest|receipt|checksum|authority/i);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('android fallback groups require zero cloud delivery rows while PC groups require one', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-delivery-origin-'));
  try {
    const rejected = join(root, 'android-extra.sqlite');
    createRealV15Fixture(rejected, {
      mutate: store => {
        const groupId = store.db.prepare("SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0'").get().committed_group_id;
        store.db.prepare('UPDATE visible_result_groups SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
        store.db.prepare('UPDATE visible_commit_receipts SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
        store.db.prepare('UPDATE visible_result_manifests SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
      }
    });
    assert.throws(() => runExtractor(rejected, root), /delivery|origin|authority/i);

    const accepted = join(root, 'android-zero.sqlite');
    createRealV15Fixture(accepted, {
      mutate: store => {
        const groupId = store.db.prepare("SELECT committed_group_id FROM turn_authority_lineages WHERE latest_turn_id = 'turn_v15_0'").get().committed_group_id;
        store.db.prepare('UPDATE visible_result_groups SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
        store.db.prepare('UPDATE visible_commit_receipts SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
        store.db.prepare('UPDATE visible_result_manifests SET authority_origin = ? WHERE group_id = ?').run('android_fallback', groupId);
        store.db.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id = ?').run(groupId);
      }
    });
    assert.equal(JSON.parse(runExtractor(accepted, root)).count, 30);
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('redacted delivery commitment is recomputed from relay and recovery identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-history-redacted-delivery-'));
  try {
    for (const [name, mutate] of [
      ['relay', store => {
        const groupId = store.db.prepare('SELECT group_id FROM visible_result_groups WHERE redacted_at IS NOT NULL LIMIT 1').get().group_id;
        store.db.prepare("UPDATE cloud_deliveries SET relay_message_id = 'relay_forged' WHERE authority_group_id = ?").run(groupId);
      }],
      ['recovery-ack', store => {
        const groupId = store.db.prepare('SELECT group_id FROM visible_result_groups WHERE redacted_at IS NOT NULL LIMIT 1').get().group_id;
        store.db.prepare('UPDATE cloud_deliveries SET recovery_ack_seq = recovery_ack_seq + 1 WHERE authority_group_id = ?').run(groupId);
      }],
      ['commitment', store => {
        const groupId = store.db.prepare('SELECT group_id FROM visible_result_groups WHERE redacted_at IS NOT NULL LIMIT 1').get().group_id;
        store.db.prepare("UPDATE visible_result_groups SET redaction_delivery_commitment = ? WHERE group_id = ?").run('f'.repeat(64), groupId);
      }]
    ]) {
      const database = join(root, `${name}.sqlite`);
      createRealV15Fixture(database, { windows: 31, includeRedacted: true, mutate });
      assert.throws(() => runExtractor(database, root), /delivery|commitment|redaction|authority/i, name);
    }
  } finally { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('closed action kinds and nested semantic identifiers are explicit and recursive', async () => {
  const extractor = await import('../scripts/extract-yuqi-real-history-scenes.mjs');
  assert.deepEqual([...extractor.CLOSED_ACTION_KINDS].sort(), [
    'life_episode_cancel', 'life_episode_create', 'life_episode_update',
    'moment_comment', 'moment_create', 'moment_like', 'moment_reply',
    'payment_accept', 'payment_decline', 'relationship_transition',
    'role_plan_cancel', 'role_plan_complete', 'role_plan_create', 'role_plan_pause',
    'role_plan_resume', 'role_plan_update'
  ]);
  assert.deepEqual(extractor.anonymizeSemanticIdentifiers({
    recipientId: 'user-1', nested: [{ roleId: 'role-1', payload: { paymentId: 'pay-1', plain: 'keep this text' } }]
  }, new Map()), {
    recipientId: 'id_1', nested: [{ roleId: 'id_2', payload: { paymentId: 'id_3', plain: 'keep this text' } }]
  });
  const root = { turn_id: 'root', retry_of_turn_id: null };
  const retry1 = { turn_id: 'retry1', retry_of_turn_id: 'root' };
  const retry2 = { turn_id: 'retry2', retry_of_turn_id: 'retry1' };
  assert.equal(extractor.rootAttempt(retry2, new Map([['root', root], ['retry1', retry1], ['retry2', retry2]])).turn_id, 'root');
  assert.throws(() => extractor.rootAttempt(retry1, new Map([['root', { turn_id: 'root', retry_of_turn_id: 'retry1' }], ['retry1', retry1]])), /cycle/i);
});
