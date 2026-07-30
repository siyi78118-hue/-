import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { generationFingerprint } from '../src/interaction-lanes.mjs';
import { YuqiStore } from '../src/store.mjs';
import { commitVisibleResult } from '../src/visible-result-commit.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function withDatabase(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-visible-v11-'));
  const path = join(directory, 'memory.sqlite');
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function tableCounts(database) {
  return Object.fromEntries([
    'turns',
    'messages',
    'cloud_deliveries',
    'cognitive_states',
    'consolidation_jobs',
    'cognition_kind_rollouts',
    'pipeline_releases',
    'interaction_lanes'
  ].map(table => [
    table,
    Number(database.prepare(`SELECT COUNT(*) AS value FROM "${table}"`).get().value)
  ]));
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function createPopulatedV10(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_seq INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        worker_id TEXT,
        origin TEXT NOT NULL DEFAULT 'codex',
        memory_packet_json TEXT,
        brain_draft_json TEXT,
        supervisor_json TEXT,
        reply_json TEXT,
        error_json TEXT,
        envelope_json TEXT NOT NULL,
        envelope_checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        route TEXT NOT NULL DEFAULT 'deep',
        route_reasons_json TEXT NOT NULL DEFAULT '[]',
        pipeline_mode TEXT NOT NULL DEFAULT 'legacy',
        preset_version TEXT NOT NULL DEFAULT '1.9.1',
        annotation_snapshot_json TEXT NOT NULL DEFAULT '{}',
        rollout_key TEXT,
        comparison_mode TEXT NOT NULL DEFAULT 'none',
        rollout_revision INTEGER NOT NULL DEFAULT 0,
        rollout_evidence_epoch INTEGER NOT NULL DEFAULT 0,
        pipeline_checksum TEXT NOT NULL DEFAULT '',
        shadow_epoch INTEGER,
        canary_epoch INTEGER,
        canary_slot INTEGER,
        authoritative_release_id TEXT,
        comparison_release_id TEXT,
        authoritative_pipeline_checksum TEXT,
        comparison_pipeline_checksum TEXT,
        lane_key TEXT,
        lane_revision INTEGER,
        input_visibility_sequence INTEGER,
        generation_fingerprint TEXT,
        UNIQUE(device_id, device_seq)
      );
      CREATE TABLE messages (
        message_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        speaker_id TEXT NOT NULL,
        speaker_type TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        content TEXT NOT NULL,
        sent_at INTEGER NOT NULL,
        origin TEXT NOT NULL DEFAULT 'codex',
        device_id TEXT,
        device_seq INTEGER,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE cloud_deliveries (
        turn_id TEXT NOT NULL,
        peer_id TEXT NOT NULL,
        recovery_ack_seq INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'waiting',
        payload_json TEXT,
        checksum TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        confirmed_at INTEGER,
        PRIMARY KEY(turn_id, peer_id)
      );
      CREATE TABLE cognitive_states (
        role_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        last_turn_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE consolidation_jobs (
        job_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        turn_id TEXT,
        role_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        payload_json TEXT NOT NULL,
        payload_checksum TEXT NOT NULL,
        last_error_code TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(subject_type, subject_id, job_type)
      );
      CREATE TABLE cognition_kind_rollouts (
        rollout_key TEXT PRIMARY KEY,
        current_mode TEXT NOT NULL,
        rollout_phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        preset_version TEXT NOT NULL,
        pipeline_checksum TEXT NOT NULL,
        evidence_epoch INTEGER NOT NULL DEFAULT 1,
        shadow_epoch INTEGER NOT NULL DEFAULT 0,
        canary_epoch INTEGER NOT NULL DEFAULT 0,
        stable_release_id TEXT,
        candidate_release_id TEXT,
        candidate_phase TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE cognition_life_planning_attempts (
        planning_id TEXT PRIMARY KEY,
        authoritative_release_id TEXT,
        comparison_release_id TEXT,
        authoritative_pipeline_checksum TEXT,
        comparison_pipeline_checksum TEXT,
        lane_key TEXT,
        lane_revision INTEGER,
        input_visibility_sequence INTEGER,
        generation_fingerprint TEXT
      );
      CREATE TABLE pipeline_releases (
        release_id TEXT PRIMARY KEY,
        pipeline_version TEXT NOT NULL,
        preset_version TEXT NOT NULL,
        cognition_schema_version INTEGER NOT NULL,
        expression_schema_version INTEGER NOT NULL,
        evaluator_version TEXT NOT NULL,
        model_profile_json TEXT NOT NULL,
        component_manifest_json TEXT NOT NULL,
        release_checksum TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        retired_at INTEGER
      );
      CREATE TABLE constraint_records (
        constraint_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        authority TEXT NOT NULL,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(constraint_id, revision)
      );
      CREATE TABLE stance_records (
        stance_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        position_text TEXT NOT NULL,
        reason_text TEXT NOT NULL,
        strength REAL NOT NULL,
        flexibility REAL NOT NULL,
        source_turn_id TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_confirmed_at INTEGER NOT NULL,
        remaining_relevant_user_batches INTEGER NOT NULL,
        status TEXT NOT NULL,
        PRIMARY KEY(stance_id, revision)
      );
      CREATE TABLE interaction_lanes (
        role_id TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        revision INTEGER NOT NULL,
        generating_turn_id TEXT,
        latest_user_batch_id TEXT,
        latest_authoritative_group_id TEXT,
        native_completed_group_id TEXT,
        native_completed_sequence INTEGER NOT NULL DEFAULT 0,
        ui_applied_group_id TEXT,
        ui_applied_sequence INTEGER NOT NULL DEFAULT 0,
        local_sequence INTEGER NOT NULL DEFAULT 0,
        last_commit_checksum TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(role_id, lane_key)
      );
      CREATE TABLE quality_eval_runs (
        eval_run_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        baseline_release_id TEXT NOT NULL,
        suite_version TEXT NOT NULL,
        source_type TEXT NOT NULL,
        state TEXT NOT NULL,
        manifest_checksum TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE quality_findings (
        finding_id TEXT PRIMARY KEY,
        eval_run_id TEXT NOT NULL,
        rollout_key TEXT NOT NULL,
        scene_id TEXT NOT NULL,
        repeat_index INTEGER NOT NULL,
        code TEXT NOT NULL,
        owner TEXT NOT NULL,
        severity TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        scores_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE state_migration_audit (
        audit_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO pipeline_releases VALUES
        ('stable', 'legacy', '1.9.2', 2, 2, 'eval', '{}', '{}', '${SHA_A}', 1, NULL),
        ('candidate', 'v3', '1.9.2', 3, 3, 'eval', '{}', '{}', '${SHA_B}', 1, NULL);
      INSERT INTO cognition_kind_rollouts(
        rollout_key, current_mode, rollout_phase, revision, preset_version,
        pipeline_checksum, stable_release_id, candidate_release_id, candidate_phase,
        created_at, updated_at
      ) VALUES (
        'DIRECT_REPLY', 'legacy', 'stable', 1, '1.9.2', '${SHA_A}',
        'stable', 'candidate', 'none', 1, 1
      );
      INSERT INTO turns(
        turn_id, character_id, device_id, device_seq, source_message_id, state,
        reply_json, envelope_json, envelope_checksum, created_at, updated_at,
        rollout_key, authoritative_release_id, authoritative_pipeline_checksum,
        lane_key, lane_revision, input_visibility_sequence, generation_fingerprint
      ) VALUES (
        'turn_v2', 'yuqi', 'phone', 1, 'source_v2', 'completed',
        '{"messages":["旧回复"]}', '{"protocolVersion":2,"kind":"DIRECT_REPLY"}',
        '${SHA_A}', 1, 2, 'DIRECT_REPLY', 'stable', '${SHA_A}',
        'private_chat', 0, 1, '${SHA_B}'
      );
      INSERT INTO messages VALUES (
        'message_v2', 'turn_v2', 'yuqi', 'yuqi', 'character', 'user',
        '旧回复', 2, 'codex', NULL, NULL, '${SHA_A}', 2
      );
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, state, payload_json, checksum, created_at, updated_at
      ) VALUES ('turn_v2', 'phone', 'confirmed', '{}', '${SHA_A}', 2, 2);
      INSERT INTO cognitive_states VALUES (
        'yuqi', 2, 1, 'turn_v2', '{}', '${SHA_A}', 2
      );
      INSERT INTO interaction_lanes(
        role_id, lane_key, revision, latest_authoritative_group_id, updated_at
      ) VALUES ('yuqi', 'private_chat', 1, 'legacy_group', 2);
      PRAGMA user_version = 10;
    `);
    return tableCounts(database);
  } finally {
    database.close();
  }
}

function v2Envelope(turnId, deviceSeq, {
  messageId = 'msg_source_original',
  content = '测试消息',
  sentAt = 10_001,
  retry = null
} = {}) {
  return {
    protocolVersion: 2,
    turnId,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq,
    createdAt: 10_000 + deviceSeq,
    kind: 'DIRECT_REPLY',
    message: {
      messageId,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content,
      sentAt
    },
    ...(retry ? { context: { retry } } : {})
  };
}

function canonicalCreateInput(store, envelope, overrides = {}) {
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const lane = store.getInteractionLane('yuqi', 'private_chat');
  const agencySnapshot = store.readAgencyAuthoritySnapshotInternal({
    roleId: 'yuqi',
    at: envelope.message.sentAt
  });
  return {
    envelope,
    rolloutKey: 'DIRECT_REPLY',
    expectedRolloutRevision: rollout.revision,
    authoritativeReleaseId: rollout.candidatePhase === 'canary'
      ? rollout.candidateReleaseId
      : rollout.stableReleaseId,
    comparisonReleaseId: rollout.candidatePhase === 'shadow'
      ? rollout.candidateReleaseId
      : rollout.candidatePhase === 'canary'
        ? rollout.stableReleaseId
      : null,
    comparisonDirection: rollout.candidatePhase === 'shadow'
      ? 'stable_authoritative_candidate_compare'
      : rollout.candidatePhase === 'canary'
        ? 'candidate_authoritative_stable_compare'
      : null,
    laneKey: 'private_chat',
    expectedLaneRevision: Number(lane?.revision || 0),
    inputUserBatchId: envelope.context?.currentBatch?.batchId
      || `batch_${envelope.message.messageId}`,
    inputVisibilitySequence: 0,
    agencySnapshotChecksum: agencySnapshot.checksum,
    annotationSnapshot: {},
    ...overrides
  };
}

function canonicalAuthorityCounts(store) {
  return {
    turns: Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value),
    lineages: Number(store.db.prepare(
      'SELECT COUNT(*) AS value FROM turn_authority_lineages'
    ).get().value),
    lanes: Number(store.db.prepare('SELECT COUNT(*) AS value FROM interaction_lanes').get().value),
    rollout: store.getCognitionRollout('DIRECT_REPLY')
  };
}

function batchedEnvelope(turnId, deviceSeq) {
  const result = v2Envelope(turnId, deviceSeq, {
    messageId: 'msg_batch_last',
    content: '最后一条',
    sentAt: 10_000
  });
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==';
  const first = {
    messageId: 'msg_batch_first',
    speakerId: 'user',
    speakerType: 'user',
    recipientId: 'yuqi',
    content: '第一条',
    sentAt: 9_999,
    attachments: [{
      attachmentId: 'att_batch_first',
      messageId: 'msg_batch_first',
      kind: 'image',
      mime: 'image/png',
      name: 'first.png',
      width: 1,
      height: 1,
      bytes: Buffer.from(png, 'base64').length,
      dataUrl: `data:image/png;base64,${png}`
    }]
  };
  result.context = {
    currentBatch: {
      batchId: 'batch_complete',
      messageIds: [first.messageId, result.message.messageId],
      startedAt: first.sentAt,
      committedAt: result.createdAt,
      messages: [first, result.message]
    }
  };
  return result;
}

function ensureDirectRollout(store) {
  if (store.getCognitionRollout('DIRECT_REPLY')) return;
  store.initializeCognitionRolloutsInternal({
    rows: [{
      rolloutKey: 'DIRECT_REPLY',
      currentMode: 'legacy',
      rolloutPhase: 'stable',
      presetVersion: '1.9.2',
      pipelineChecksum: SHA_A
    }],
    now: 1
  });
}

for (const [index, [name, mutate]] of [
  ['role', input => { input.envelope.characterId = 'other_role'; }],
  ['rollout kind', input => { input.rolloutKey = 'PROACTIVE_CHAT'; }],
  ['lane', input => { input.laneKey = 'public_moment'; }],
  ['user batch', input => { input.inputUserBatchId = 'batch_forged'; }],
  ['v2 visibility sequence', input => { input.inputVisibilitySequence += 1; }]
].entries()) {
  test(`canonical creation rejects caller-spoofed ${name} with zero side effects`, () =>
    withDatabase(path => {
      const store = new YuqiStore(path);
      try {
        ensureDirectRollout(store);
        const input = canonicalCreateInput(store, v2Envelope(`turn_spoof_${index}`, 1));
        const before = canonicalAuthorityCounts(store);
        mutate(input);
        assert.throws(
          () => store.createCanonicalVisibleTurnInternal(input),
          /canonical|authority|rollout|lane|batch|visibility/i
        );
        assert.deepEqual(canonicalAuthorityCounts(store), before);
      } finally {
        store.close();
      }
    }));
}

for (const [index, [name, mutate]] of [
  ['earlier bubble content', envelope => {
    envelope.context.currentBatch.messages[0].content = '被篡改的第一条';
  }],
  ['earlier attachment', envelope => {
    envelope.context.currentBatch.messages[0].attachments[0].name = 'changed.png';
  }],
  ['message ordering', envelope => {
    envelope.context.currentBatch.messages.reverse();
    envelope.context.currentBatch.messageIds.reverse();
  }],
  ['batch id', envelope => {
    envelope.context.currentBatch.batchId = 'batch_forged';
  }]
].entries()) {
  test(`canonical retry rejects changed ${name} before authority mutation`, () =>
    withDatabase(path => {
      const store = new YuqiStore(path);
      try {
        ensureDirectRollout(store);
        const originalEnvelope = batchedEnvelope('turn_batch_original', 1);
        const original = store.createCanonicalVisibleTurnInternal(canonicalCreateInput(
          store,
          originalEnvelope,
          { inputUserBatchId: originalEnvelope.context.currentBatch.batchId }
        )).turn;
        const retryEnvelope = structuredClone(originalEnvelope);
        retryEnvelope.turnId = `turn_batch_retry_${index}`;
        retryEnvelope.deviceSeq = 2;
        retryEnvelope.createdAt += 1;
        retryEnvelope.context.retry = {
          retryOfTurnId: original.turnId,
          canonicalMessageId: originalEnvelope.message.messageId
        };
        mutate(retryEnvelope);
        const laneBefore = structuredClone(store.getInteractionLane('yuqi', 'private_chat'));
        const lineageBefore = structuredClone(
          store.getTurnAuthorityLineage(original.authorityLineageKey)
        );
        const turnCountBefore = canonicalAuthorityCounts(store).turns;
        assert.throws(() => store.createCanonicalVisibleTurnInternal({
          ...canonicalCreateInput(store, retryEnvelope, {
            expectedRolloutRevision: original.rolloutRevision,
            expectedLaneRevision: laneBefore.revision,
            inputUserBatchId: retryEnvelope.context.currentBatch.batchId,
            inputVisibilitySequence: laneBefore.localSequence,
            authoritativeReleaseId: original.authoritativeReleaseId,
            comparisonReleaseId: original.comparisonReleaseId,
            comparisonDirection: original.comparisonMode === 'none'
              ? null
              : original.comparisonMode
          })
        }), /retry.*batch|canonical.*batch|message.*conflict|current batch/i);
        assert.equal(canonicalAuthorityCounts(store).turns, turnCountBefore);
        assert.deepEqual(store.getInteractionLane('yuqi', 'private_chat'), laneBefore);
        assert.deepEqual(
          store.getTurnAuthorityLineage(original.authorityLineageKey),
          lineageBefore
        );
      } finally {
        store.close();
      }
    }));
}

test('canary creation reserves distinct slots atomically and exact replay reserves none', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      store.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET candidate_phase = 'canary', current_mode = 'active',
            rollout_phase = 'canary', canary_max_outstanding = 2,
            canary_started_count = 0, canary_completed_count = 0,
            canary_failure_count = 0
        WHERE rollout_key = 'DIRECT_REPLY'
      `).run();
      const firstInput = canonicalCreateInput(store, v2Envelope('turn_canary_1', 1));
      const first = store.createCanonicalVisibleTurnInternal(firstInput);
      assert.equal(first.turn.canarySlot, 1);
      assert.equal(store.getCognitionRollout('DIRECT_REPLY').canaryStartedCount, 1);
      const replay = store.createCanonicalVisibleTurnInternal(structuredClone(firstInput));
      assert.equal(replay.turn.turnId, first.turn.turnId);
      assert.equal(store.getCognitionRollout('DIRECT_REPLY').canaryStartedCount, 1);

      const lane = store.getInteractionLane('yuqi', 'private_chat');
      const rollout = store.getCognitionRollout('DIRECT_REPLY');
      const secondInput = canonicalCreateInput(store, v2Envelope('turn_canary_2', 2, {
        messageId: 'msg_canary_2',
        content: '第二个 canary',
        sentAt: 10_002
      }), {
        expectedRolloutRevision: rollout.revision,
        expectedLaneRevision: lane.revision,
        inputVisibilitySequence: lane.localSequence
      });
      const second = store.createCanonicalVisibleTurnInternal(secondInput);
      assert.equal(second.turn.canarySlot, 2);
      assert.equal(store.getCognitionRollout('DIRECT_REPLY').canaryStartedCount, 2);

      const before = canonicalAuthorityCounts(store);
      const latestLane = store.getInteractionLane('yuqi', 'private_chat');
      const latestRollout = store.getCognitionRollout('DIRECT_REPLY');
      assert.throws(() => store.createCanonicalVisibleTurnInternal(canonicalCreateInput(
        store,
        v2Envelope('turn_canary_overflow', 3, {
          messageId: 'msg_canary_overflow',
          content: '超过配额',
          sentAt: 10_003
        }),
        {
          expectedRolloutRevision: latestRollout.revision,
          expectedLaneRevision: latestLane.revision,
          inputVisibilitySequence: latestLane.localSequence
        }
      )), /canary.*outstanding/i);
      assert.deepEqual(canonicalAuthorityCounts(store), before);
    } finally {
      store.close();
    }
  }));

function commitCanonicalTurn(store, turn) {
  const visibleGroup = {
    items: [{
      content: '收到。',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user'
    }]
  };
  const actionDraft = {
    kind: 'moment_create',
    payload: { text: '测试动态' }
  };
  const resolvedAction = store.resolveCanonicalActionTargetInternal({
    turn,
    action: actionDraft
  });
  const actionSet = [{
    ...actionDraft,
    targetKey: resolvedAction.targetKey,
    targetRevision: resolvedAction.targetRevision
  }];
  return commitVisibleResult({
    store,
    turnId: turn.turnId,
    authorityLineageKey: turn.authorityLineageKey,
    laneKey: turn.laneKey,
    expectedTurnRevision: turn.turnRevision,
    expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
    expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
    expectedCognitiveStateRevision: 0,
    expectedLatestUserBatchId: turn.inputUserBatchId,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    visibleGroup,
    actionSet,
    statePatch: null,
    memoryJobs: [{
      jobId: `job_${turn.turnId}`,
      jobType: 'turn_consolidation',
      payload: {
        cognitionPacketChecksum: 'c'.repeat(64),
        resultingCognitiveStateChecksum: 'd'.repeat(64)
      }
    }],
    comparisonJob: null,
    generationFingerprint: generationFingerprint({
      roleId: turn.characterId,
      laneKey: turn.laneKey,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      visibleGroup,
      actionSet,
      contextRevision: turn.agencySnapshotChecksum
    }),
    now: 20_000
  });
}

function seedCommittedV11(path) {
  const store = new YuqiStore(path);
  try {
    ensureDirectRollout(store);
    const committed = store.createCanonicalVisibleTurnInternal(
      canonicalCreateInput(store, v2Envelope('turn_committed', 1))
    ).turn;
    commitCanonicalTurn(store, committed);

    const lane = store.getInteractionLane('yuqi', 'private_chat');
    const openEnvelope = v2Envelope('turn_open', 2, {
      messageId: 'msg_source_open',
      content: '第二条测试消息',
      sentAt: 10_002
    });
    store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, openEnvelope, {
      expectedLaneRevision: lane.revision,
      inputVisibilitySequence: lane.localSequence
    }));

    const legacyLane = store.getInteractionLane('yuqi', 'private_chat');
    store.createTurnWithReleasePinInternal({
      envelope: v2Envelope('turn_legacy_v11', 3, {
        messageId: 'msg_source_legacy',
        content: '旧路径消息',
        sentAt: 10_003
      }),
      rolloutKey: 'DIRECT_REPLY',
      laneKey: 'private_chat',
      expectedLaneRevision: legacyLane.revision,
      inputVisibilitySequence: legacyLane.localSequence
    });
  } finally {
    store.close();
  }
}

function mutateRaw(path, mutate) {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys = OFF;');
    mutate(database);
  } finally {
    database.close();
  }
}

function assertV11ReopenRejected(path) {
  let reopened;
  try {
    reopened = new YuqiStore(path);
  } catch (error) {
    assert.match(String(error?.message || error), /v11 invariant/i);
    return;
  } finally {
    reopened?.close();
  }
  assert.fail('expected v11 invariant rejection');
}

for (const [name, corrupt] of [
  ['authority version outside zero and one', database =>
    database.prepare(`
      UPDATE turns SET result_authority_version = 2
      WHERE turn_id = 'turn_legacy_v11'
    `).run()],
  ['version-1 turn has no lineage row', database =>
    database.prepare('DELETE FROM turn_authority_lineages').run()],
  ['lineage latest turn root/role/lane does not join', database =>
    database.prepare(`
      UPDATE turn_authority_lineages
      SET root_source_id = 'forged_root'
      WHERE state = 'committed'
    `).run()],
  ['committed group does not join receipt turn/release/origin', database =>
    database.prepare(`
      UPDATE visible_result_groups
      SET authoritative_release_id = 'forged_release'
    `).run()],
  ['receipt payload version does not match origin', database =>
    database.prepare(`
      UPDATE visible_commit_receipts
      SET commit_payload_version = 'android-fallback-commit-v1'
      WHERE authority_origin = 'pc'
    `).run()],
  ['committed turn/group fingerprints differ', database =>
    database.prepare(`
      UPDATE visible_result_groups
      SET generation_fingerprint = ?
    `).run('f'.repeat(64))],
  ['uncommitted version-1 turn already has fingerprint', database =>
    database.prepare(`
      UPDATE turns
      SET generation_fingerprint = ?
      WHERE turn_id = 'turn_open'
    `).run('f'.repeat(64))],
  ['turn lineage and lane revision deltas are not exactly one', database =>
    database.prepare(`
      UPDATE visible_commit_receipts
      SET turn_revision_after = turn_revision_before
      WHERE authority_origin = 'pc'
    `).run()],
  ['committed turn revision differs from receipt', database =>
    database.prepare(`
      UPDATE turns SET turn_revision = turn_revision + 1
      WHERE turn_id = 'turn_committed'
    `).run()],
  ['committed lineage revision differs from receipt', database =>
    database.prepare(`
      UPDATE turn_authority_lineages SET revision = revision + 1
      WHERE state = 'committed'
    `).run()],
  ['committed group has no visible item', database =>
    database.prepare('DELETE FROM visible_result_items').run()],
  ['visible item has no matching message projection', database =>
    database.prepare(`
      UPDATE messages SET authority_group_id = NULL
      WHERE authority_group_id IS NOT NULL
    `).run()],
  ['visible item JSON spoofs the canonical speaker', database =>
    database.prepare(`
      UPDATE visible_result_items
      SET item_json = json_set(item_json, '$.speakerId', 'user')
    `).run()],
  ['visible action id is not deterministic', database =>
    database.prepare(`
      UPDATE visible_result_actions SET action_id = 'action_forged'
    `).run()],
  ['canonical memory job points at a missing group', database => {
    database.exec('PRAGMA foreign_keys = OFF;');
    database.prepare(`
      UPDATE consolidation_jobs SET authority_group_id = 'group_missing'
      WHERE authority_group_id IS NOT NULL
    `).run();
  }],
  ['PC receipt has no canonical delivery', database =>
    database.prepare('DELETE FROM cloud_deliveries WHERE authority_group_id IS NOT NULL').run()],
  ['delivery checksum differs from receipt', database =>
    database.prepare(`
      UPDATE cloud_deliveries
      SET authority_commit_checksum = ?
      WHERE authority_group_id IS NOT NULL
    `).run('f'.repeat(64))],
  ['version-0 turn is attached to canonical lineage/group', database =>
    database.prepare(`
      UPDATE turns
      SET authority_lineage_key = (
        SELECT lineage_key FROM turn_authority_lineages WHERE state = 'committed' LIMIT 1
      )
      WHERE turn_id = 'turn_legacy_v11'
    `).run()]
]) {
  test(`v11 reopen rejects ${name}`, () => withDatabase(path => {
    seedCommittedV11(path);
    const healthy = new YuqiStore(path);
    healthy.close();
    mutateRaw(path, corrupt);
    assertV11ReopenRejected(path);
  }));
}

test('populated PC v10 migrates once to v11 without inventing historical authority', () =>
  withDatabase(path => {
    const before = createPopulatedV10(path);
    let store = new YuqiStore(path);
    try {
      assert.equal(store.userVersion(), 11);
      assert.deepEqual(tableCounts(store.db), before);
      const oldTurn = store.getTurn('turn_v2');
      assert.equal(oldTurn.resultAuthorityVersion, 0);
      assert.equal(oldTurn.authorityLineageKey, null);
      assert.equal(store.listTurnAuthorityLineages().length, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_result_groups').get().value, 0);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM visible_commit_receipts').get().value, 0);
      store.close();

      store = new YuqiStore(path);
      assert.equal(store.userVersion(), 11);
      assert.deepEqual(tableCounts(store.db), before);
      assert.equal(store.listTurnAuthorityLineages().length, 0);
    } finally {
      store.close();
    }
  }));

test('migration CLI preserves a raw populated v10 source and produces a restart-stable v11 clone report', () =>
  withDatabase(path => {
    createPopulatedV10(path);
    const directory = join(path, '..');
    const clone = join(directory, 'clone.sqlite');
    const reportPath = join(directory, 'migration-report.json');
    const sourceHash = fileSha256(path);
    const command = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'migrate-yuqi-agency-state.mjs'),
      '--database', path,
      '--dry-run',
      '--clone-out', clone,
      '--out', reportPath
    ], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    assert.equal(command.status, 0, command.stderr || command.stdout);
    assert.equal(fileSha256(path), sourceHash);
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    assert.equal(report.sourceUserVersion, 10);
    assert.equal(report.workingUserVersion, 11);
    assert.equal(report.sourceDatabaseSha256, sourceHash);
    assert.equal(report.sourceDatabaseSha256After, sourceHash);
    assert.match(report.workingDatabaseSha256, /^[a-f0-9]{64}$/);
    assert.equal(report.v11InvariantSummary.userVersion, 11);
    assert.match(report.v11InvariantSummary.checksum, /^[a-f0-9]{64}$/);
    assert.ok(Object.hasOwn(report.sourceTableCounts, 'turns'));
    assert.ok(Object.hasOwn(report.v11InvariantSummary.tableCounts, 'visible_commit_receipts'));

    const applyReportPath = join(directory, 'migration-apply-report.json');
    const applyCommand = spawnSync(process.execPath, [
      join(process.cwd(), 'scripts', 'migrate-yuqi-agency-state.mjs'),
      '--database', path,
      '--apply',
      '--expect-report', reportPath,
      '--out', applyReportPath
    ], {
      cwd: process.cwd(),
      encoding: 'utf8'
    });
    assert.equal(applyCommand.status, 0, applyCommand.stderr || applyCommand.stdout);
    const applied = JSON.parse(readFileSync(applyReportPath, 'utf8'));
    assert.equal(applied.applied, true);
    assert.equal(applied.workingUserVersion, 11);
    assert.equal(
      applied.v11InvariantSummary.checksum,
      report.v11InvariantSummary.checksum
    );

    const first = new YuqiStore(clone);
    const logicalBefore = {
      counts: tableCounts(first.db),
      summary: report.v11InvariantSummary
    };
    first.close();
    const second = new YuqiStore(clone);
    assert.deepEqual(tableCounts(second.db), logicalBefore.counts);
    assert.equal(second.userVersion(), 11);
    second.close();
  }));

test('ordinary protocol-v2 release-pinned creation remains legacy authority on v11', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const turn = store.createTurnWithReleasePinInternal({
        envelope: v2Envelope('turn_legacy', 1),
        rolloutKey: 'DIRECT_REPLY',
        laneKey: 'private_chat',
        expectedLaneRevision: 0,
        inputVisibilitySequence: 0
      });
      assert.equal(turn.resultAuthorityVersion, 0);
      assert.equal(turn.authorityLineageKey, null);
      assert.equal(store.listTurnAuthorityLineages().length, 0);
    } finally {
      store.close();
    }
  }));

test('explicit canonical internal creation accepts protocol v2 and creates one lineage', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const envelope = v2Envelope('turn_original', 1);
      const outcome = store.createCanonicalVisibleTurnInternal(
        canonicalCreateInput(store, envelope)
      );
      assert.equal(outcome.status, 'created');
      assert.equal(outcome.turn.resultAuthorityVersion, 1);
      assert.equal(outcome.turn.turnRevision, 1);
      const lineage = store.getTurnAuthorityLineage(outcome.turn.authorityLineageKey);
      assert.equal(lineage.rootSourceId, envelope.message.messageId);
      assert.equal(lineage.latestTurnId, 'turn_original');
      assert.equal(lineage.revision, 1);
      assert.equal(lineage.state, 'open');
    } finally {
      store.close();
    }
  }));

test('retry reuses the original lineage and stale sibling retry loses lineage CAS', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const originalEnvelope = v2Envelope('turn_original', 1);
      const original = store.createCanonicalVisibleTurnInternal(
        canonicalCreateInput(store, originalEnvelope)
      ).turn;
      const retryEnvelope = v2Envelope('turn_retry_1', 2, {
        messageId: originalEnvelope.message.messageId,
        content: originalEnvelope.message.content,
        sentAt: originalEnvelope.message.sentAt,
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: originalEnvelope.message.messageId
        }
      });
      const retry1 = store.createCanonicalVisibleTurnInternal({
        ...canonicalCreateInput(store, retryEnvelope),
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        expectedRolloutRevision: original.rolloutRevision
      }).turn;
      assert.equal(retry1.authorityLineageKey, original.authorityLineageKey);
      assert.equal(
        store.getTurnAuthorityLineage(original.authorityLineageKey).latestTurnId,
        retry1.turnId
      );
      const siblingEnvelope = v2Envelope('turn_retry_2', 3, {
        messageId: originalEnvelope.message.messageId,
        content: originalEnvelope.message.content,
        sentAt: originalEnvelope.message.sentAt,
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: originalEnvelope.message.messageId
        }
      });
      assert.throws(() => store.createCanonicalVisibleTurnInternal({
        ...canonicalCreateInput(store, siblingEnvelope),
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        expectedRolloutRevision: original.rolloutRevision
      }), /retry lineage authority conflict/i);
    } finally {
      store.close();
    }
  }));

test('committed retry returns its receipt before mutable lane checks', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const originalEnvelope = v2Envelope('turn_committed_retry_original', 1);
      const original = store.createCanonicalVisibleTurnInternal(
        canonicalCreateInput(store, originalEnvelope)
      ).turn;
      commitCanonicalTurn(store, original);
      const receipt = store.getVisibleCommitReceipt(original.authorityLineageKey);
      assert.equal(store.getInteractionLane('yuqi', 'private_chat').revision, 2);
      const retryEnvelope = v2Envelope('turn_committed_retry_late', 2, {
        messageId: originalEnvelope.message.messageId,
        content: originalEnvelope.message.content,
        sentAt: originalEnvelope.message.sentAt,
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: originalEnvelope.message.messageId
        }
      });
      const retryInput = {
        ...canonicalCreateInput(store, retryEnvelope, {
          expectedLaneRevision: 1,
          inputVisibilitySequence: original.inputVisibilitySequence
        }),
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode,
        expectedRolloutRevision: original.rolloutRevision,
        agencySnapshotChecksum: original.agencySnapshotChecksum
      };
      assert.deepEqual(
        store.createCanonicalVisibleTurnInternal(retryInput),
        { status: 'already_committed', receipt }
      );
      assert.equal(store.getTurn(retryEnvelope.turnId), null);
    } finally {
      store.close();
    }
  }));

test('canonical creation rejects caller-selected authority version and revision selectors', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const envelope = v2Envelope('turn_injected', 1);
      for (const injected of [
        { resultAuthorityVersion: 1 },
        { authorityContractVersion: 1 },
        { authorityLineageKey: 'lin_forged' },
        { lineageRevisionAtCreation: 99 },
        { turnRevision: 99 }
      ]) {
        assert.throws(() => store.createCanonicalVisibleTurnInternal({
          ...canonicalCreateInput(store, envelope),
          ...injected
        }), /authority selector|authority input/i);
      }
    } finally {
      store.close();
    }
  }));

test('exact open-turn replay is mutation-free and a rollout race has zero side effects', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const input = canonicalCreateInput(store, v2Envelope('turn_replay', 1));
      const first = store.createCanonicalVisibleTurnInternal(input);
      const laneBefore = store.getInteractionLane('yuqi', 'private_chat');
      const lineageBefore = store.getTurnAuthorityLineage(first.turn.authorityLineageKey);
      const replay = store.createCanonicalVisibleTurnInternal(structuredClone(input));
      assert.equal(replay.turn.turnId, first.turn.turnId);
      assert.equal(
        store.getInteractionLane('yuqi', 'private_chat').revision,
        laneBefore.revision
      );
      assert.equal(
        store.getTurnAuthorityLineage(first.turn.authorityLineageKey).revision,
        lineageBefore.revision
      );

      const turnsBefore = Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value);
      const lineagesBefore = store.listTurnAuthorityLineages().length;
      const laneSnapshot = structuredClone(store.getInteractionLane('yuqi', 'private_chat'));
      const raced = canonicalCreateInput(store, v2Envelope('turn_raced', 2), {
        expectedRolloutRevision: 999,
        expectedLaneRevision: laneSnapshot.revision,
        inputVisibilitySequence: laneSnapshot.localSequence
      });
      assert.throws(
        () => store.createCanonicalVisibleTurnInternal(raced),
        /rollout.*conflict/i
      );
      assert.equal(
        Number(store.db.prepare('SELECT COUNT(*) AS value FROM turns').get().value),
        turnsBefore
      );
      assert.equal(store.listTurnAuthorityLineages().length, lineagesBefore);
      assert.deepEqual(store.getInteractionLane('yuqi', 'private_chat'), laneSnapshot);
    } finally {
      store.close();
    }
  }));

test('protocol v2 canonical creation uses the persisted non-zero lane sequence exactly', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      store.claimInteractionLaneInternal({
        roleId: 'yuqi',
        laneKey: 'private_chat',
        expectedRevision: 0,
        generatingTurnId: 'turn_prior',
        latestUserBatchId: 'msg_prior',
        localSequence: 7,
        now: 1
      });
      const envelope = v2Envelope('turn_sequence', 1);
      const outcome = store.createCanonicalVisibleTurnInternal(
        canonicalCreateInput(store, envelope, {
          expectedLaneRevision: 1,
          inputVisibilitySequence: 7
        })
      );
      assert.equal(outcome.turn.inputVisibilitySequence, 7);
      assert.equal(store.getInteractionLane('yuqi', 'private_chat').localSequence, 7);
    } finally {
      store.close();
    }
  }));

test('canonical retry inherits the parent release pair after rollout changes', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const originalEnvelope = v2Envelope('turn_pin_original', 1);
      const original = store.createCanonicalVisibleTurnInternal(
        canonicalCreateInput(store, originalEnvelope)
      ).turn;
      store.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET revision = revision + 1, candidate_phase = 'shadow',
            rollout_phase = 'collecting', current_mode = 'shadow'
        WHERE rollout_key = 'DIRECT_REPLY'
      `).run();
      const retryEnvelope = v2Envelope('turn_pin_retry', 2, {
        messageId: originalEnvelope.message.messageId,
        content: originalEnvelope.message.content,
        sentAt: originalEnvelope.message.sentAt,
        retry: {
          retryOfTurnId: original.turnId,
          canonicalMessageId: originalEnvelope.message.messageId
        }
      });
      const retry = store.createCanonicalVisibleTurnInternal({
        ...canonicalCreateInput(store, retryEnvelope),
        expectedRolloutRevision: original.rolloutRevision,
        authoritativeReleaseId: original.authoritativeReleaseId,
        comparisonReleaseId: original.comparisonReleaseId,
        comparisonDirection: original.comparisonMode === 'none' ? null : original.comparisonMode
      }).turn;
      assert.equal(retry.rolloutRevision, original.rolloutRevision);
      assert.equal(retry.authoritativeReleaseId, original.authoritativeReleaseId);
      assert.equal(retry.comparisonReleaseId, original.comparisonReleaseId);
    } finally {
      store.close();
    }
  }));

test('a retry of a legacy or missing parent cannot enter canonical creation', () =>
  withDatabase(path => {
    const store = new YuqiStore(path);
    try {
      ensureDirectRollout(store);
      const legacyEnvelope = v2Envelope('turn_legacy_parent', 1);
      store.createTurnWithReleasePinInternal({
        envelope: legacyEnvelope,
        rolloutKey: 'DIRECT_REPLY',
        laneKey: 'private_chat',
        expectedLaneRevision: 0,
        inputVisibilitySequence: 0
      });
      for (const [turnId, parentId, sequence] of [
        ['turn_retry_legacy', legacyEnvelope.turnId, 2],
        ['turn_retry_missing', 'turn_missing', 3]
      ]) {
        const retryEnvelope = v2Envelope(turnId, sequence, {
          messageId: legacyEnvelope.message.messageId,
          content: legacyEnvelope.message.content,
          sentAt: legacyEnvelope.message.sentAt,
          retry: {
            retryOfTurnId: parentId,
            canonicalMessageId: legacyEnvelope.message.messageId
          }
        });
        assert.throws(
          () => store.createCanonicalVisibleTurnInternal(canonicalCreateInput(store, retryEnvelope)),
          /retry parent invariant/i
        );
      }
    } finally {
      store.close();
    }
  }));

test('user versions above v11 stop without rewriting', () => withDatabase(path => {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 12;');
  database.close();
  assert.throws(() => new YuqiStore(path), /unsupported.*12/i);
}));
