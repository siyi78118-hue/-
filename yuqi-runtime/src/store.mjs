import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { resolveCurrentUserBatch } from './current-user-batch.mjs';
import {
  TURN_STATES,
  canonicalJson,
  contentHash,
  deliveryItemsForResult,
  validateDeliveryReceipt,
  validateEnvelope
} from './protocol.mjs';

const TURN_PATCH_COLUMNS = new Map([
  ['memoryPacketJson', 'memory_packet_json'],
  ['brainDraftJson', 'brain_draft_json'],
  ['supervisorJson', 'supervisor_json'],
  ['replyJson', 'reply_json'],
  ['errorJson', 'error_json'],
  ['origin', 'origin']
]);

function now() {
  return Date.now();
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function mapTurn(row) {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    characterId: row.character_id,
    deviceId: row.device_id,
    deviceSeq: row.device_seq,
    sourceMessageId: row.source_message_id,
    state: row.state,
    route: row.route || 'deep',
    routeReasons: parseJson(row.route_reasons_json, []),
    pipelineMode: row.pipeline_mode || 'legacy',
    rolloutKey: row.rollout_key || null,
    comparisonMode: row.comparison_mode || 'none',
    rolloutRevision: Number(row.rollout_revision || 0),
    rolloutEvidenceEpoch: Number(row.rollout_evidence_epoch || 0),
    pipelineChecksum: row.pipeline_checksum || '',
    shadowEpoch: row.shadow_epoch ?? null,
    canaryEpoch: row.canary_epoch ?? null,
    canarySlot: row.canary_slot ?? null,
    presetVersion: row.preset_version || '1.9.1',
    annotationSnapshot: parseJson(row.annotation_snapshot_json, {}),
    workerId: row.worker_id || '',
    origin: row.origin,
    memoryPacketJson: row.memory_packet_json,
    brainDraftJson: row.brain_draft_json,
    supervisorJson: row.supervisor_json,
    replyJson: row.reply_json,
    errorJson: row.error_json,
    envelopeJson: row.envelope_json,
    envelopeChecksum: row.envelope_checksum,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCognitionRollout(row) {
  if (!row) return null;
  return {
    rolloutKey: row.rollout_key,
    currentMode: row.current_mode,
    rolloutPhase: row.rollout_phase,
    revision: Number(row.revision),
    presetVersion: row.preset_version,
    pipelineChecksum: row.pipeline_checksum,
    evidenceEpoch: Number(row.evidence_epoch),
    shadowEpoch: Number(row.shadow_epoch),
    liveShadowFirstAt: row.live_shadow_first_at ?? null,
    liveShadowLastAt: row.live_shadow_last_at ?? null,
    liveShadowSuccessCount: Number(row.live_shadow_success_count),
    liveShadowFailureCount: Number(row.live_shadow_failure_count),
    canaryEpoch: Number(row.canary_epoch),
    canaryTargetCount: Number(row.canary_target_count),
    canaryMaxOutstanding: Number(row.canary_max_outstanding),
    canaryCompareDeadlineMs: Number(row.canary_compare_deadline_ms),
    canaryStartedCount: Number(row.canary_started_count),
    canaryCompletedCount: Number(row.canary_completed_count),
    canaryFailureCount: Number(row.canary_failure_count),
    canaryStartedAt: row.canary_started_at ?? null,
    canaryObserveUntil: row.canary_observe_until ?? null,
    activeTransientFailureCount: Number(row.active_transient_failure_count),
    activeTransientWindowStartedAt: row.active_transient_window_started_at ?? null,
    lastReportId: row.last_report_id || null,
    lastReportChecksum: row.last_report_checksum || null,
    activatedAt: row.activated_at ?? null,
    rolledBackAt: row.rolled_back_at ?? null,
    lastReasonCode: row.last_reason_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapEvaluationReport(row) {
  if (!row) return null;
  return {
    reportId: row.report_id,
    reportType: row.report_type,
    rolloutKey: row.rollout_key || null,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    artifactPath: row.artifact_path,
    artifactChecksum: row.artifact_checksum,
    artifactState: row.artifact_state,
    summary: parseJson(row.summary_json, {}),
    createdAt: row.created_at,
    materializedAt: row.materialized_at ?? null,
    lastArtifactErrorCode: row.last_artifact_error_code || null
  };
}

export class RolloutRevisionConflictError extends Error {
  constructor(message = 'rollout revision conflict') {
    super(message);
    this.name = 'RolloutRevisionConflictError';
  }
}

function mapCognitiveState(row) {
  if (!row) return null;
  return {
    roleId: row.role_id,
    schemaVersion: row.schema_version,
    revision: row.revision,
    lastTurnId: row.last_turn_id,
    state: parseJson(row.state_json, {}),
    checksum: row.checksum,
    updatedAt: row.updated_at
  };
}

function mapConsolidationJob(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    turnId: row.turn_id || null,
    roleId: row.role_id,
    jobType: row.job_type,
    state: row.state,
    attemptCount: row.attempt_count,
    dueAt: row.due_at,
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    payload: parseJson(row.payload_json, {}),
    payloadChecksum: row.payload_checksum,
    lastErrorCode: row.last_error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapShadowRun(row) {
  if (!row) return null;
  return {
    runId: row.run_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    turnId: row.turn_id || null,
    rolloutKey: row.rollout_key,
    source: row.source,
    comparisonDirection: row.comparison_direction,
    evidenceEpoch: row.evidence_epoch,
    shadowEpoch: row.shadow_epoch ?? null,
    canaryEpoch: row.canary_epoch ?? null,
    canarySlot: row.canary_slot ?? null,
    rolloutRevision: row.rollout_revision,
    pipelineChecksum: row.pipeline_checksum,
    state: row.state,
    authoritativeResultChecksum: row.authoritative_result_checksum || null,
    comparisonResultChecksum: row.comparison_result_checksum || null,
    metrics: parseJson(row.metrics_json, null),
    criticalFindings: parseJson(row.critical_findings_json, null),
    latencyMs: row.latency_ms ?? null,
    errorCode: row.error_code || null,
    staleForRollout: Boolean(row.stale_for_rollout),
    sourceDeletedAt: row.source_deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export class CognitiveStateConflictError extends Error {
  constructor(message = 'cognitive state revision/checksum conflict') {
    super(message);
    this.name = 'CognitiveStateConflictError';
  }
}

export class ConsolidationJobConflictError extends Error {
  constructor(message = 'consolidation job payload conflict') {
    super(message);
    this.name = 'ConsolidationJobConflictError';
  }
}

function mapMessage(row) {
  if (!row) return null;
  return {
    messageId: row.message_id,
    turnId: row.turn_id,
    characterId: row.character_id,
    speakerId: row.speaker_id,
    speakerType: row.speaker_type,
    recipientId: row.recipient_id,
    content: row.content,
    sentAt: row.sent_at,
    origin: row.origin,
    deviceId: row.device_id || '',
    deviceSeq: row.device_seq ?? null,
    batchId: row.batch_id || '',
    batchSequence: row.batch_sequence ?? null,
    checksum: row.checksum
  };
}

function mapTurnStage(row) {
  if (!row) return null;
  return {
    stage: row.stage,
    ordinal: row.ordinal,
    model: row.model || '',
    effort: row.effort || '',
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    durationMs: row.duration_ms ?? null
  };
}

function mapFact(row) {
  if (!row) return null;
  const stored = parseJson(row.fact_json, null);
  if (stored) return stored;
  return {
    factId: row.fact_id,
    characterId: row.character_id,
    subjectId: row.subject_id,
    predicate: row.predicate,
    object: parseJson(row.object_json, null),
    evidenceMode: row.evidence_mode,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    exactQuotes: parseJson(row.exact_quotes_json, []),
    status: row.status,
    confidence: row.confidence,
    supersedes: row.supersedes || null,
    origin: row.origin,
    createdAt: row.created_at,
    verifiedAt: row.verified_at
  };
}

function mapPresetVersion(row) {
  if (!row) return null;
  return parseJson(row.manifest_json, null);
}

function mapAnnotation(row) {
  if (!row) return null;
  return {
    ...parseJson(row.annotation_json, {}),
    annotationId: row.annotation_id,
    turnId: row.turn_id,
    sourceMessageId: row.source_message_id || null,
    presetVersion: row.preset_version,
    status: row.status,
    createdAt: row.created_at
  };
}

function mapCloudDelivery(row) {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    peerId: row.peer_id,
    recoveryAckSeq: row.recovery_ack_seq,
    state: row.state,
    payloadJson: row.payload_json,
    checksum: row.checksum || '',
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at,
    confirmedAt: row.confirmed_at ?? null
  };
}

function mapLifeEpisode(row) {
  if (!row) return null;
  return {
    episodeId: row.episode_id,
    characterId: row.character_id,
    kind: row.kind,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    payload: parseJson(row.payload_json, {}),
    checksum: row.checksum,
    sourceTurnId: row.source_turn_id || null,
    adjustmentReason: row.adjustment_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCharacterLifeState(row) {
  if (!row) return null;
  return {
    characterId: row.character_id,
    currentEpisodeId: row.current_episode_id || null,
    revision: row.revision,
    lastAdvancedAt: row.last_advanced_at,
    state: parseJson(row.state_json, {})
  };
}

export class YuqiStore {
  constructor(filename) {
    if (!filename) throw new Error('database filename is required');
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.closed = false;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  open() {
    if (this.closed) throw new Error('store is closed');
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
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
        UNIQUE(device_id, device_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_turns_state_created ON turns(state, created_at);

      CREATE TABLE IF NOT EXISTS turn_stages (
        turn_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        model TEXT,
        effort TEXT,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        PRIMARY KEY(turn_id, stage, ordinal),
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_turn_stages_turn_ordinal
        ON turn_stages(turn_id, ordinal);

      CREATE TABLE IF NOT EXISTS messages (
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
      CREATE INDEX IF NOT EXISTS idx_messages_character_time ON messages(character_id, sent_at DESC);

      CREATE TABLE IF NOT EXISTS current_user_batches (
        turn_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        character_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        committed_at INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_current_user_batches_batch
        ON current_user_batches(batch_id);

      CREATE TABLE IF NOT EXISTS current_user_batch_items (
        turn_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        message_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        PRIMARY KEY(turn_id, sequence),
        UNIQUE(turn_id, message_id),
        FOREIGN KEY(turn_id) REFERENCES current_user_batches(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_current_user_batch_items_message
        ON current_user_batch_items(message_id);

      CREATE TABLE IF NOT EXISTS facts (
        fact_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_json TEXT NOT NULL,
        evidence_mode TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        exact_quotes_json TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        supersedes TEXT,
        origin TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        verified_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_facts_character_status ON facts(character_id, status);

      CREATE TABLE IF NOT EXISTS sync_log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_cursors (
        peer_id TEXT PRIMARY KEY,
        ack_seq INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cloud_deliveries (
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
        PRIMARY KEY(turn_id, peer_id),
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_deliveries_state_updated
        ON cloud_deliveries(state, updated_at);

      CREATE TABLE IF NOT EXISTS sessions (
        role TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS preset_versions (
        version TEXT PRIMARY KEY,
        parent_version TEXT,
        manifest_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        published_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS annotations (
        annotation_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        source_message_id TEXT,
        preset_version TEXT NOT NULL,
        annotation_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS diagnostics (
        diagnostic_id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id TEXT,
        stage TEXT NOT NULL,
        level TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS suppressed_messages (
        message_id TEXT PRIMARY KEY,
        authoritative_message_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(message_id) REFERENCES messages(message_id)
      );

      CREATE TABLE IF NOT EXISTS delivery_receipt_items (
        turn_id TEXT NOT NULL,
        item_kind TEXT NOT NULL,
        item_id TEXT NOT NULL,
        checksum TEXT NOT NULL,
        delivered_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(turn_id, item_kind, item_id),
        FOREIGN KEY(turn_id) REFERENCES turns(turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_delivery_receipt_items_turn
        ON delivery_receipt_items(turn_id, delivered_at);

      CREATE TABLE IF NOT EXISTS life_episodes (
        episode_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'planned',
        payload_json TEXT NOT NULL DEFAULT '{}',
        checksum TEXT NOT NULL,
        source_turn_id TEXT,
        adjustment_reason TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_life_episodes_character_time
        ON life_episodes(character_id, start_at, end_at);

      CREATE TABLE IF NOT EXISTS character_life_state (
        character_id TEXT PRIMARY KEY,
        current_episode_id TEXT,
        revision INTEGER NOT NULL DEFAULT 0,
        last_advanced_at INTEGER NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cognitive_states (
        role_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        last_turn_id TEXT NOT NULL,
        state_json TEXT NOT NULL,
        checksum TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS consolidation_jobs (
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
        UNIQUE(subject_type, subject_id, job_type),
        CHECK(subject_type IN ('turn', 'role_history', 'life_planning')),
        CHECK(
          (subject_type = 'turn' AND turn_id IS NOT NULL)
          OR (subject_type <> 'turn' AND turn_id IS NULL)
        )
      );
      CREATE INDEX IF NOT EXISTS idx_consolidation_jobs_due
        ON consolidation_jobs(state, due_at, job_type);

      CREATE TABLE IF NOT EXISTS consolidation_backfill_cursors (
        role_id TEXT PRIMARY KEY,
        last_completed_group_key TEXT,
        last_checksum TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cognition_shadow_runs (
        run_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        turn_id TEXT,
        rollout_key TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source = 'live'),
        comparison_direction TEXT NOT NULL,
        evidence_epoch INTEGER NOT NULL,
        shadow_epoch INTEGER,
        canary_epoch INTEGER,
        canary_slot INTEGER,
        rollout_revision INTEGER NOT NULL,
        pipeline_checksum TEXT NOT NULL,
        state TEXT NOT NULL,
        authoritative_result_checksum TEXT,
        comparison_result_checksum TEXT,
        metrics_json TEXT,
        critical_findings_json TEXT,
        latency_ms INTEGER,
        error_code TEXT,
        stale_for_rollout INTEGER NOT NULL DEFAULT 0,
        source_deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(subject_type, subject_id, comparison_direction),
        CHECK(subject_type IN ('turn', 'life_planning'))
      );

      CREATE TABLE IF NOT EXISTS cognition_kind_rollouts (
        rollout_key TEXT PRIMARY KEY,
        current_mode TEXT NOT NULL,
        rollout_phase TEXT NOT NULL,
        revision INTEGER NOT NULL,
        preset_version TEXT NOT NULL,
        pipeline_checksum TEXT NOT NULL,
        evidence_epoch INTEGER NOT NULL DEFAULT 1,
        shadow_epoch INTEGER NOT NULL DEFAULT 0,
        live_shadow_first_at INTEGER,
        live_shadow_last_at INTEGER,
        live_shadow_success_count INTEGER NOT NULL DEFAULT 0,
        live_shadow_failure_count INTEGER NOT NULL DEFAULT 0,
        canary_epoch INTEGER NOT NULL DEFAULT 0,
        canary_target_count INTEGER NOT NULL DEFAULT 10,
        canary_max_outstanding INTEGER NOT NULL DEFAULT 3,
        canary_compare_deadline_ms INTEGER NOT NULL DEFAULT 900000,
        canary_started_count INTEGER NOT NULL DEFAULT 0,
        canary_completed_count INTEGER NOT NULL DEFAULT 0,
        canary_failure_count INTEGER NOT NULL DEFAULT 0,
        canary_started_at INTEGER,
        canary_observe_until INTEGER,
        active_transient_failure_count INTEGER NOT NULL DEFAULT 0,
        active_transient_window_started_at INTEGER,
        last_report_id TEXT,
        last_report_checksum TEXT,
        activated_at INTEGER,
        rolled_back_at INTEGER,
        last_reason_code TEXT NOT NULL DEFAULT 'bootstrap',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK(current_mode IN ('legacy', 'shadow', 'active')),
        CHECK(rollout_phase IN ('stable', 'collecting', 'canary', 'rolled_back'))
      );

      CREATE TABLE IF NOT EXISTS cognition_promotion_history (
        event_id TEXT PRIMARY KEY,
        rollout_key TEXT NOT NULL,
        from_mode TEXT NOT NULL,
        to_mode TEXT NOT NULL,
        from_phase TEXT NOT NULL,
        to_phase TEXT NOT NULL,
        from_revision INTEGER NOT NULL,
        to_revision INTEGER NOT NULL,
        actor TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        report_id TEXT,
        report_checksum TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE TRIGGER IF NOT EXISTS cognition_promotion_history_no_update
      BEFORE UPDATE ON cognition_promotion_history
      BEGIN
        SELECT RAISE(ABORT, 'promotion history is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS cognition_promotion_history_no_delete
      BEFORE DELETE ON cognition_promotion_history
      BEGIN
        SELECT RAISE(ABORT, 'promotion history is append-only');
      END;

      CREATE TABLE IF NOT EXISTS cognition_evaluation_reports (
        report_id TEXT PRIMARY KEY,
        report_type TEXT NOT NULL,
        rollout_key TEXT,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_checksum TEXT NOT NULL,
        artifact_state TEXT NOT NULL DEFAULT 'pending',
        summary_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        materialized_at INTEGER,
        last_artifact_error_code TEXT,
        CHECK(report_type IN ('replay', 'live_shadow', 'active_canary', 'active_failure', 'promotion')),
        CHECK(source_type IN ('comparison_run', 'active_subject', 'replay_batch', 'aggregate_gate', 'promotion_snapshot')),
        CHECK(artifact_state IN ('pending', 'materialized'))
      );

      CREATE TABLE IF NOT EXISTS cognition_replay_batches (
        run_id TEXT PRIMARY KEY,
        dataset_id TEXT NOT NULL,
        dataset_checksum TEXT NOT NULL,
        preset_version TEXT NOT NULL,
        model_profile_checksum TEXT NOT NULL,
        source_type TEXT NOT NULL,
        state TEXT NOT NULL,
        requested_concurrency INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        completed_at INTEGER,
        artifact_path TEXT,
        artifact_checksum TEXT,
        CHECK(source_type IN ('fixture', 'local_history'))
      );

      CREATE TABLE IF NOT EXISTS cognition_replay_runs (
        run_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        rollout_key TEXT NOT NULL,
        source_type TEXT NOT NULL,
        input_checksum TEXT NOT NULL,
        legacy_result_checksum TEXT,
        cognition_result_checksum TEXT,
        metrics_json TEXT NOT NULL DEFAULT '{}',
        critical_findings_json TEXT NOT NULL DEFAULT '[]',
        state TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        latency_ms INTEGER,
        error_code TEXT,
        source_deleted_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(run_id, case_id),
        CHECK(source_type IN ('approved_fixture', 'annotation_derived', 'synthetic', 'local_history'))
      );
    `);

    const factColumns = new Set(this.db.prepare('PRAGMA table_info(facts)').all().map(row => row.name));
    if (!factColumns.has('fact_json')) this.db.exec('ALTER TABLE facts ADD COLUMN fact_json TEXT;');
    const turnColumns = new Set(this.db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
    if (!turnColumns.has('route')) this.db.exec("ALTER TABLE turns ADD COLUMN route TEXT NOT NULL DEFAULT 'deep';");
    if (!turnColumns.has('route_reasons_json')) this.db.exec("ALTER TABLE turns ADD COLUMN route_reasons_json TEXT NOT NULL DEFAULT '[]';");
    if (!turnColumns.has('pipeline_mode')) this.db.exec("ALTER TABLE turns ADD COLUMN pipeline_mode TEXT NOT NULL DEFAULT 'legacy';");
    if (!turnColumns.has('preset_version')) this.db.exec("ALTER TABLE turns ADD COLUMN preset_version TEXT NOT NULL DEFAULT '1.9.1';");
    if (!turnColumns.has('annotation_snapshot_json')) this.db.exec("ALTER TABLE turns ADD COLUMN annotation_snapshot_json TEXT NOT NULL DEFAULT '{}';");
    if (!turnColumns.has('rollout_key')) this.db.exec('ALTER TABLE turns ADD COLUMN rollout_key TEXT;');
    if (!turnColumns.has('comparison_mode')) this.db.exec("ALTER TABLE turns ADD COLUMN comparison_mode TEXT NOT NULL DEFAULT 'none';");
    if (!turnColumns.has('rollout_revision')) this.db.exec('ALTER TABLE turns ADD COLUMN rollout_revision INTEGER NOT NULL DEFAULT 0;');
    if (!turnColumns.has('rollout_evidence_epoch')) this.db.exec('ALTER TABLE turns ADD COLUMN rollout_evidence_epoch INTEGER NOT NULL DEFAULT 0;');
    if (!turnColumns.has('pipeline_checksum')) this.db.exec("ALTER TABLE turns ADD COLUMN pipeline_checksum TEXT NOT NULL DEFAULT '';");
    if (!turnColumns.has('shadow_epoch')) this.db.exec('ALTER TABLE turns ADD COLUMN shadow_epoch INTEGER;');
    if (!turnColumns.has('canary_epoch')) this.db.exec('ALTER TABLE turns ADD COLUMN canary_epoch INTEGER;');
    if (!turnColumns.has('canary_slot')) this.db.exec('ALTER TABLE turns ADD COLUMN canary_slot INTEGER;');
    const deliveryColumns = new Set(this.db.prepare('PRAGMA table_info(cloud_deliveries)').all().map(row => row.name));
    if (!deliveryColumns.has('confirmed_at')) this.db.exec('ALTER TABLE cloud_deliveries ADD COLUMN confirmed_at INTEGER;');
    const sessionColumns = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name));
    if (!sessionColumns.has('turn_count')) this.db.exec('ALTER TABLE sessions ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;');
    this.db.exec(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed'
      WHERE state = 'delivered' AND confirmed_at IS NULL;

      INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
      SELECT m.message_id, m.message_id, 'pending_phone_receipt', CAST(strftime('%s','now') AS INTEGER) * 1000
      FROM messages m
      JOIN turns t ON t.turn_id = m.turn_id
      JOIN cloud_deliveries d ON d.turn_id = t.turn_id
      WHERE m.speaker_type = 'character'
        AND json_extract(t.envelope_json, '$.kind') IN ('PROACTIVE_CHAT', 'PROACTIVE_MOMENT')
        AND d.state != 'confirmed';

      INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
      SELECT legacy.message_id, canonical.message_id, 'legacy_payment_id_alias', CAST(strftime('%s','now') AS INTEGER) * 1000
      FROM messages legacy
      JOIN messages canonical ON canonical.message_id = 'msg_' || legacy.message_id
      WHERE substr(legacy.message_id, 1, 4) = 'pay_'
        AND legacy.speaker_type = 'user'
        AND canonical.speaker_type = 'user'
        AND legacy.character_id = canonical.character_id
        AND legacy.content = canonical.content
        AND legacy.turn_id = canonical.turn_id;

      CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_rollout_canary_slot
      ON turns(rollout_key, canary_epoch, canary_slot)
      WHERE canary_slot IS NOT NULL;

      UPDATE turns
      SET rollout_key = json_extract(envelope_json, '$.kind')
      WHERE rollout_key IS NULL
        AND json_extract(envelope_json, '$.kind') IN (
          'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
          'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE',
          'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'
        );
    `);
    this.db.exec('PRAGMA user_version = 8;');
  }

  transaction(run) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  appendSync(entityType, entityId, operation, payload) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const result = this.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entityType, entityId, operation, payloadJson, checksum, now());
    return Number(result.lastInsertRowid);
  }

  getCognitionRollout(rolloutKey) {
    return mapCognitionRollout(this.db.prepare(
      'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
    ).get(String(rolloutKey || '')));
  }

  listCognitionRollouts() {
    return this.db.prepare(
      'SELECT * FROM cognition_kind_rollouts ORDER BY rollout_key'
    ).all().map(mapCognitionRollout);
  }

  listPromotionHistory(rolloutKey = null) {
    const rows = rolloutKey
      ? this.db.prepare(
        'SELECT * FROM cognition_promotion_history WHERE rollout_key = ? ORDER BY created_at, event_id'
      ).all(String(rolloutKey))
      : this.db.prepare(
        'SELECT * FROM cognition_promotion_history ORDER BY created_at, event_id'
      ).all();
    return rows.map(row => ({
      eventId: row.event_id,
      rolloutKey: row.rollout_key,
      fromMode: row.from_mode,
      toMode: row.to_mode,
      fromPhase: row.from_phase,
      toPhase: row.to_phase,
      fromRevision: Number(row.from_revision),
      toRevision: Number(row.to_revision),
      actor: row.actor,
      reasonCode: row.reason_code,
      reportId: row.report_id || null,
      reportChecksum: row.report_checksum || null,
      metadata: parseJson(row.metadata_json, {}),
      createdAt: row.created_at
    }));
  }

  initializeCognitionRolloutsInternal({ rows, now: initializedAt = now() }) {
    if (!Array.isArray(rows) || !rows.length) throw new Error('rollout rows are required');
    return this.transaction(() => {
      if (Number(this.db.prepare('SELECT COUNT(*) AS value FROM cognition_kind_rollouts').get().value) > 0) {
        return this.listCognitionRollouts();
      }
      const insert = this.db.prepare(`
        INSERT INTO cognition_kind_rollouts(
          rollout_key, current_mode, rollout_phase, revision, preset_version,
          pipeline_checksum, evidence_epoch, shadow_epoch, canary_epoch,
          last_reason_code, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, 1, 0, 0, 'bootstrap', ?, ?)
      `);
      const history = this.db.prepare(`
        INSERT INTO cognition_promotion_history(
          event_id, rollout_key, from_mode, to_mode, from_phase, to_phase,
          from_revision, to_revision, actor, reason_code, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 1, 'bootstrap', 'bootstrap', '{}', ?)
      `);
      for (const row of rows) {
        insert.run(
          row.rolloutKey,
          row.currentMode || 'legacy',
          row.rolloutPhase || 'stable',
          row.presetVersion || '1.9.1',
          row.pipelineChecksum || '',
          Number(initializedAt),
          Number(initializedAt)
        );
        history.run(
          `promotion_bootstrap_${contentHash(row.rolloutKey).slice(0, 24)}`,
          row.rolloutKey,
          row.currentMode || 'legacy',
          row.currentMode || 'legacy',
          row.rolloutPhase || 'stable',
          row.rolloutPhase || 'stable',
          Number(initializedAt)
        );
      }
      return this.listCognitionRollouts();
    });
  }

  appendPromotionHistoryInternal(event) {
    this.db.prepare(`
      INSERT INTO cognition_promotion_history(
        event_id, rollout_key, from_mode, to_mode, from_phase, to_phase,
        from_revision, to_revision, actor, reason_code, report_id,
        report_checksum, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.eventId,
      event.rolloutKey,
      event.fromMode,
      event.toMode,
      event.fromPhase,
      event.toPhase,
      Number(event.fromRevision),
      Number(event.toRevision),
      event.actor,
      event.reasonCode,
      event.reportId || null,
      event.reportChecksum || null,
      canonicalJson(event.metadata || {}),
      Number(event.createdAt || now())
    );
  }

  transitionCognitionRolloutInternal({
    rolloutKey,
    expectedRevision,
    toMode,
    toPhase,
    actor,
    reasonCode,
    reportId = null,
    reportChecksum = null,
    metadata = {},
    now: transitionedAt = now()
  }) {
    return this.transaction(() => {
      const current = this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
      ).get(String(rolloutKey));
      if (!current || Number(current.revision) !== Number(expectedRevision)) {
        throw new RolloutRevisionConflictError();
      }
      const newShadowWindow = toMode === 'shadow'
        && (current.current_mode !== 'shadow' || toPhase !== current.rollout_phase);
      const newCanary = toMode === 'active' && toPhase === 'canary'
        && !(current.current_mode === 'active' && current.rollout_phase === 'canary');
      const nextRevision = Number(current.revision) + 1;
      const updated = this.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET current_mode = ?, rollout_phase = ?, revision = ?,
            shadow_epoch = shadow_epoch + ?,
            live_shadow_first_at = CASE WHEN ? = 1 THEN NULL ELSE live_shadow_first_at END,
            live_shadow_last_at = CASE WHEN ? = 1 THEN NULL ELSE live_shadow_last_at END,
            live_shadow_success_count = CASE WHEN ? = 1 THEN 0 ELSE live_shadow_success_count END,
            live_shadow_failure_count = CASE WHEN ? = 1 THEN 0 ELSE live_shadow_failure_count END,
            canary_epoch = canary_epoch + ?,
            canary_started_count = CASE WHEN ? = 1 THEN 0 ELSE canary_started_count END,
            canary_completed_count = CASE WHEN ? = 1 THEN 0 ELSE canary_completed_count END,
            canary_failure_count = CASE WHEN ? = 1 THEN 0 ELSE canary_failure_count END,
            canary_started_at = CASE WHEN ? = 1 THEN ? ELSE canary_started_at END,
            canary_observe_until = CASE WHEN ? = 1 THEN ? ELSE canary_observe_until END,
            last_report_id = ?, last_report_checksum = ?,
            activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END,
            rolled_back_at = CASE WHEN ? = 'shadow' AND ? = 'active' THEN ? ELSE rolled_back_at END,
            last_reason_code = ?, updated_at = ?
        WHERE rollout_key = ? AND revision = ?
      `).run(
        toMode, toPhase, nextRevision,
        newShadowWindow ? 1 : 0,
        newShadowWindow ? 1 : 0,
        newShadowWindow ? 1 : 0,
        newShadowWindow ? 1 : 0,
        newShadowWindow ? 1 : 0,
        newCanary ? 1 : 0,
        newCanary ? 1 : 0,
        newCanary ? 1 : 0,
        newCanary ? 1 : 0,
        newCanary ? 1 : 0, Number(transitionedAt),
        newCanary ? 1 : 0, Number(transitionedAt) + 48 * 60 * 60 * 1000,
        reportId, reportChecksum,
        toMode, Number(transitionedAt),
        toMode, current.current_mode, Number(transitionedAt),
        reasonCode, Number(transitionedAt),
        rolloutKey, Number(expectedRevision)
      );
      if (Number(updated.changes) !== 1) throw new RolloutRevisionConflictError();
      this.appendPromotionHistoryInternal({
        eventId: `promotion_${contentHash({
          rolloutKey, expectedRevision, toMode, toPhase, reasonCode, transitionedAt
        }).slice(0, 24)}`,
        rolloutKey,
        fromMode: current.current_mode,
        toMode,
        fromPhase: current.rollout_phase,
        toPhase,
        fromRevision: Number(current.revision),
        toRevision: nextRevision,
        actor,
        reasonCode,
        reportId,
        reportChecksum,
        metadata,
        createdAt: transitionedAt
      });
      return this.getCognitionRollout(rolloutKey);
    });
  }

  putEvaluationReportInternal(report) {
    const summaryJson = canonicalJson(report.summary || {});
    const checksum = contentHash(report.summary || {});
    if (report.artifactChecksum && report.artifactChecksum !== checksum) {
      throw new Error('evaluation report checksum mismatch');
    }
    this.db.prepare(`
      INSERT INTO cognition_evaluation_reports(
        report_id, report_type, rollout_key, source_type, source_ref,
        artifact_path, artifact_checksum, artifact_state, summary_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(report_id) DO NOTHING
    `).run(
      report.reportId, report.reportType, report.rolloutKey || null,
      report.sourceType, report.sourceRef, report.artifactPath || '',
      checksum, report.artifactState || 'pending', summaryJson,
      Number(report.createdAt || now())
    );
    return this.getEvaluationReport(report.reportId);
  }

  getEvaluationReport(reportId) {
    return mapEvaluationReport(this.db.prepare(
      'SELECT * FROM cognition_evaluation_reports WHERE report_id = ?'
    ).get(String(reportId)));
  }

  markEvaluationReportMaterialized({ reportId, expectedChecksum, now: materializedAt = now() }) {
    const result = this.db.prepare(`
      UPDATE cognition_evaluation_reports
      SET artifact_state = 'materialized', materialized_at = ?, last_artifact_error_code = NULL
      WHERE report_id = ? AND artifact_checksum = ?
    `).run(Number(materializedAt), String(reportId), String(expectedChecksum));
    if (Number(result.changes) !== 1) throw new Error('evaluation report checksum conflict');
    return this.getEvaluationReport(reportId);
  }

  createTurnWithRolloutInternal({ envelope, rolloutKey, presetVersion, annotationSnapshot }) {
    return this.submitTurn(envelope, { rolloutKey, presetVersion, annotationSnapshot });
  }

  refreshCognitionEvidenceInternal({ entries, reasonCode, now: refreshedAt = now() }) {
    return this.transaction(() => {
      const currentRows = new Map(this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts ORDER BY rollout_key'
      ).all().map(row => [row.rollout_key, row]));
      if (entries.some(entry => !currentRows.has(entry.rolloutKey))) {
        throw new Error('rollout evidence refresh is incomplete');
      }
      const changed = [];
      for (const entry of entries) {
        const current = currentRows.get(entry.rolloutKey);
        if (current.pipeline_checksum === entry.pipelineChecksum
          && current.preset_version === entry.presetVersion) continue;
        const nextRevision = Number(current.revision) + 1;
        const remainsLegacy = current.current_mode === 'legacy';
        const toMode = remainsLegacy ? 'legacy' : 'shadow';
        const toPhase = remainsLegacy ? 'stable' : 'collecting';
        const update = this.db.prepare(`
          UPDATE cognition_kind_rollouts
          SET current_mode = ?, rollout_phase = ?, revision = ?,
              preset_version = ?, pipeline_checksum = ?,
              evidence_epoch = evidence_epoch + 1,
              shadow_epoch = shadow_epoch + ?,
              live_shadow_first_at = NULL, live_shadow_last_at = NULL,
              live_shadow_success_count = 0, live_shadow_failure_count = 0,
              canary_started_count = 0, canary_completed_count = 0,
              canary_failure_count = 0, canary_started_at = NULL,
              canary_observe_until = NULL, last_reason_code = ?, updated_at = ?
          WHERE rollout_key = ? AND revision = ?
        `).run(
          toMode, toPhase, nextRevision,
          entry.presetVersion, entry.pipelineChecksum,
          remainsLegacy ? 0 : 1,
          reasonCode, Number(refreshedAt), entry.rolloutKey, Number(current.revision)
        );
        if (Number(update.changes) !== 1) throw new RolloutRevisionConflictError();
        this.appendPromotionHistoryInternal({
          eventId: `promotion_${contentHash({
            rolloutKey: entry.rolloutKey,
            revision: nextRevision,
            pipelineChecksum: entry.pipelineChecksum,
            refreshedAt
          }).slice(0, 24)}`,
          rolloutKey: entry.rolloutKey,
          fromMode: current.current_mode,
          toMode,
          fromPhase: current.rollout_phase,
          toPhase,
          fromRevision: Number(current.revision),
          toRevision: nextRevision,
          actor: 'preset_registry',
          reasonCode,
          metadata: { pipelineChecksum: entry.pipelineChecksum },
          createdAt: refreshedAt
        });
        changed.push(entry.rolloutKey);
      }
      return { changed, rollouts: this.listCognitionRollouts() };
    });
  }

  recordActiveTransientFailureInternal({
    rolloutKey,
    expectedRevision,
    subjectId,
    errorCode,
    report = {},
    now: failedAt = now()
  }) {
    return this.transaction(() => {
      const current = this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
      ).get(String(rolloutKey));
      if (!current || Number(current.revision) !== Number(expectedRevision)) {
        throw new RolloutRevisionConflictError();
      }
      const withinWindow = current.active_transient_window_started_at !== null
        && Number(failedAt) - Number(current.active_transient_window_started_at) <= 15 * 60 * 1000;
      const count = withinWindow ? Number(current.active_transient_failure_count) + 1 : 1;
      const windowStartedAt = withinWindow
        ? Number(current.active_transient_window_started_at)
        : Number(failedAt);
      const rollback = count >= 3;
      const nextRevision = Number(current.revision) + 1;
      let reportId = null;
      let reportChecksum = null;
      if (rollback) {
        const summary = {
          rolloutKey,
          subjectId,
          errorCode,
          failureClass: 'transient',
          consecutiveCount: count,
          windowStartedAt,
          ...report.summary
        };
        reportId = report.reportId || `report_active_failure_${contentHash({
          rolloutKey, subjectId, count, failedAt
        }).slice(0, 24)}`;
        const stored = this.putEvaluationReportInternal({
          reportId,
          reportType: 'active_failure',
          rolloutKey,
          sourceType: 'active_subject',
          sourceRef: subjectId,
          artifactPath: report.artifactPath || '',
          summary,
          createdAt: failedAt
        });
        reportChecksum = stored.artifactChecksum;
      }
      const update = this.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET current_mode = CASE WHEN ? = 1 THEN 'shadow' ELSE current_mode END,
            rollout_phase = CASE WHEN ? = 1 THEN 'rolled_back' ELSE rollout_phase END,
            revision = ?,
            shadow_epoch = shadow_epoch + ?,
            active_transient_failure_count = CASE WHEN ? = 1 THEN 0 ELSE ? END,
            active_transient_window_started_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
            last_report_id = COALESCE(?, last_report_id),
            last_report_checksum = COALESCE(?, last_report_checksum),
            rolled_back_at = CASE WHEN ? = 1 THEN ? ELSE rolled_back_at END,
            last_reason_code = ?, updated_at = ?
        WHERE rollout_key = ? AND revision = ?
      `).run(
        rollback ? 1 : 0,
        rollback ? 1 : 0,
        nextRevision,
        rollback ? 1 : 0,
        rollback ? 1 : 0, count,
        rollback ? 1 : 0, windowStartedAt,
        reportId, reportChecksum,
        rollback ? 1 : 0, Number(failedAt),
        rollback ? errorCode : 'active_transient_failure',
        Number(failedAt), rolloutKey, Number(expectedRevision)
      );
      if (Number(update.changes) !== 1) throw new RolloutRevisionConflictError();
      if (rollback) {
        this.appendPromotionHistoryInternal({
          eventId: `promotion_${contentHash({ rolloutKey, subjectId, failedAt }).slice(0, 24)}`,
          rolloutKey,
          fromMode: current.current_mode,
          toMode: 'shadow',
          fromPhase: current.rollout_phase,
          toPhase: 'rolled_back',
          fromRevision: Number(current.revision),
          toRevision: nextRevision,
          actor: 'orchestrator',
          reasonCode: errorCode,
          reportId,
          reportChecksum,
          metadata: { consecutiveCount: count },
          createdAt: failedAt
        });
      }
      return { rolledBack: rollback, rollout: this.getCognitionRollout(rolloutKey) };
    });
  }

  resetActiveTransientFailuresInternal({
    rolloutKey,
    pipelineChecksum,
    evidenceEpoch,
    now: resetAt = now()
  }) {
    return this.transaction(() => {
      const current = this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
      ).get(String(rolloutKey));
      if (!current
        || current.current_mode !== 'active'
        || current.pipeline_checksum !== pipelineChecksum
        || Number(current.evidence_epoch) !== Number(evidenceEpoch)
        || Number(current.active_transient_failure_count) === 0) {
        return { reset: false, rollout: mapCognitionRollout(current) };
      }
      const result = this.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET revision = revision + 1, active_transient_failure_count = 0,
            active_transient_window_started_at = NULL,
            last_reason_code = 'active_pipeline_recovered', updated_at = ?
        WHERE rollout_key = ? AND revision = ?
      `).run(Number(resetAt), rolloutKey, Number(current.revision));
      if (Number(result.changes) !== 1) throw new RolloutRevisionConflictError();
      return { reset: true, rollout: this.getCognitionRollout(rolloutKey) };
    });
  }

  submitTurn(input, pin = {}) {
    const envelope = validateEnvelope(input);
    const envelopeChecksum = contentHash(envelope);
    const sourceMessageId = envelope.message?.messageId || envelope.trigger?.triggerId || '';
    const existing = this.getTurn(envelope.turnId);
    if (existing) {
      if (existing.envelopeChecksum !== envelopeChecksum) throw new Error('turn checksum conflict');
      return existing;
    }

    const sequenceOwner = this.db.prepare(
      'SELECT turn_id, source_message_id FROM turns WHERE device_id = ? AND device_seq = ?'
    ).get(envelope.deviceId, envelope.deviceSeq);
    if (sequenceOwner && sequenceOwner.source_message_id !== sourceMessageId) {
      throw new Error('device sequence conflict');
    }
    const retry = envelope.context?.retry || null;
    let canonicalRetryMessage = null;
    if (retry) {
      if (!envelope.message || retry.canonicalMessageId !== sourceMessageId) {
        throw new Error('retry canonical message mismatch');
      }
      canonicalRetryMessage = this.getMessage(retry.canonicalMessageId);
      if (
        !canonicalRetryMessage
        || canonicalRetryMessage.characterId !== envelope.characterId
        || canonicalRetryMessage.deviceId !== envelope.deviceId
        || canonicalRetryMessage.speakerType !== 'user'
        || canonicalRetryMessage.content !== envelope.message.content
        || Number(canonicalRetryMessage.sentAt) !== Number(envelope.message.sentAt)
      ) {
        throw new Error('retry canonical message conflict');
      }
      const previousTurn = this.getTurn(retry.retryOfTurnId);
      const validExistingTurn = previousTurn
        && previousTurn.characterId === envelope.characterId
        && previousTurn.deviceId === envelope.deviceId
        && previousTurn.sourceMessageId === sourceMessageId;
      const validRecoveredLineage = !previousTurn
        && canonicalRetryMessage.turnId === retry.retryOfTurnId;
      if (!validExistingTurn && !validRecoveredLineage) {
        throw new Error('retry turn lineage mismatch');
      }
      const previousEnvelope = previousTurn ? parseJson(previousTurn.envelopeJson, {}) : {};
      const previousBatch = previousEnvelope.context?.currentBatch;
      if (
        previousBatch
        && contentHash(previousBatch) !== contentHash(envelope.context?.currentBatch || null)
      ) {
        throw new Error('retry current batch conflict');
      }
    }

    return this.transaction(() => {
      let effectivePin = { ...pin };
      let rollout = null;
      if (pin.rolloutKey) {
        rollout = this.db.prepare(
          'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
        ).get(String(pin.rolloutKey));
        if (!rollout) throw new Error(`cognition rollout is unavailable: ${pin.rolloutKey}`);
        effectivePin = {
          ...effectivePin,
          pipelineMode: rollout.current_mode,
          rolloutKey: rollout.rollout_key,
          rolloutRevision: Number(rollout.revision),
          rolloutEvidenceEpoch: Number(rollout.evidence_epoch),
          pipelineChecksum: rollout.pipeline_checksum,
          shadowEpoch: rollout.current_mode === 'shadow' ? Number(rollout.shadow_epoch) : null,
          canaryEpoch: rollout.current_mode === 'active' && rollout.rollout_phase === 'canary'
            ? Number(rollout.canary_epoch)
            : null,
          comparisonMode: rollout.current_mode === 'shadow'
            ? 'cognition_compare'
            : rollout.current_mode === 'active' && rollout.rollout_phase === 'canary'
              ? 'legacy_compare'
              : 'none',
          canarySlot: rollout.current_mode === 'active' && rollout.rollout_phase === 'canary'
            ? Number(rollout.canary_started_count) + 1
            : null,
          presetVersion: rollout.preset_version
        };
      }
      if (envelope.message && !canonicalRetryMessage) {
        const savedMessage = this.putMessageInternal({
          ...envelope.message,
          turnId: envelope.turnId,
          characterId: envelope.characterId,
          origin: 'phone',
          deviceId: envelope.deviceId,
          deviceSeq: envelope.deviceSeq
        });
        if (savedMessage.messageId.startsWith('msg_pay_')) {
          const legacyMessageId = savedMessage.messageId.slice(4);
          const legacy = this.getMessage(legacyMessageId);
          if (
            legacy?.speakerType === 'user'
            && legacy.characterId === savedMessage.characterId
            && legacy.content === savedMessage.content
            && legacy.turnId === savedMessage.turnId
          ) {
            this.db.prepare(`
              INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
              VALUES (?, ?, 'legacy_payment_id_alias', ?)
            `).run(legacyMessageId, savedMessage.messageId, now());
          }
        }
      }

      this.db.prepare(`
        INSERT INTO turns(
          turn_id, character_id, device_id, device_seq, source_message_id,
          state, origin, envelope_json, envelope_checksum, created_at, updated_at,
          pipeline_mode, preset_version, annotation_snapshot_json,
          rollout_key, comparison_mode, rollout_revision, rollout_evidence_epoch,
          pipeline_checksum, shadow_epoch, canary_epoch, canary_slot
        ) VALUES (?, ?, ?, ?, ?, 'queued', 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.turnId,
        envelope.characterId,
        envelope.deviceId,
        envelope.deviceSeq,
        sourceMessageId,
        canonicalJson(envelope),
        envelopeChecksum,
        envelope.createdAt,
        now(),
        ['legacy', 'shadow', 'active'].includes(effectivePin.pipelineMode) ? effectivePin.pipelineMode : 'legacy',
        String(effectivePin.presetVersion || '1.9.1'),
        canonicalJson(effectivePin.annotationSnapshot || {}),
        effectivePin.rolloutKey || null,
        effectivePin.comparisonMode || 'none',
        Number(effectivePin.rolloutRevision || 0),
        Number(effectivePin.rolloutEvidenceEpoch || 0),
        String(effectivePin.pipelineChecksum || ''),
        effectivePin.shadowEpoch ?? null,
        effectivePin.canaryEpoch ?? null,
        effectivePin.canarySlot ?? null
      );
      if (rollout && effectivePin.comparisonMode === 'cognition_compare') {
        const updated = this.db.prepare(`
          UPDATE cognition_kind_rollouts
          SET revision = revision + 1, updated_at = ?
          WHERE rollout_key = ? AND revision = ?
        `).run(now(), rollout.rollout_key, rollout.revision);
        if (Number(updated.changes) !== 1) throw new RolloutRevisionConflictError();
      } else if (rollout && effectivePin.comparisonMode === 'legacy_compare') {
        const updated = this.db.prepare(`
          UPDATE cognition_kind_rollouts
          SET revision = revision + 1, canary_started_count = canary_started_count + 1, updated_at = ?
          WHERE rollout_key = ? AND revision = ?
        `).run(now(), rollout.rollout_key, rollout.revision);
        if (Number(updated.changes) !== 1) throw new RolloutRevisionConflictError();
      }
      if (envelope.message) this.putCurrentUserBatchInternal(envelope);
      const turn = this.getTurn(envelope.turnId);
      this.appendSync('turn', envelope.turnId, 'insert', turn);
      return turn;
    });
  }

  getTurn(turnId) {
    return mapTurn(this.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(turnId));
  }

  putCurrentUserBatchInternal(envelope) {
    const batch = resolveCurrentUserBatch(envelope);
    if (!batch) return null;
    const canonical = {
      batchId: batch.batchId,
      sourceMessageId: batch.sourceMessageId,
      messageIds: batch.messageIds,
      startedAt: batch.startedAt,
      committedAt: batch.committedAt
    };
    this.db.prepare(`
      INSERT INTO current_user_batches(
        turn_id, batch_id, character_id, source_message_id,
        started_at, committed_at, checksum, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      envelope.turnId,
      batch.batchId,
      envelope.characterId,
      batch.sourceMessageId,
      batch.startedAt,
      batch.committedAt,
      contentHash(canonical),
      now()
    );
    const byId = new Map(batch.messages.map(message => [String(message.messageId || ''), message]));
    const insert = this.db.prepare(`
      INSERT INTO current_user_batch_items(
        turn_id, batch_id, message_id, sequence, message_json, checksum
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    batch.messageIds.forEach((messageId, sequence) => {
      const message = byId.get(messageId) || { messageId };
      insert.run(
        envelope.turnId,
        batch.batchId,
        messageId,
        sequence,
        canonicalJson(message),
        contentHash(message)
      );
    });
    return this.getCurrentUserBatch(envelope.turnId);
  }

  getCurrentUserBatch(turnId) {
    const batch = this.db.prepare(
      'SELECT * FROM current_user_batches WHERE turn_id = ?'
    ).get(turnId);
    if (!batch) return null;
    const items = this.db.prepare(`
      SELECT * FROM current_user_batch_items
      WHERE turn_id = ? ORDER BY sequence ASC
    `).all(turnId);
    return {
      turnId: batch.turn_id,
      batchId: batch.batch_id,
      characterId: batch.character_id,
      sourceMessageId: batch.source_message_id,
      messageIds: items.map(item => item.message_id),
      startedAt: batch.started_at,
      committedAt: batch.committed_at,
      messages: items.map(item => parseJson(item.message_json, { messageId: item.message_id })),
      checksum: batch.checksum
    };
  }

  getProactiveChatDeliveryPolicy(characterId, { windowSize = 4, maxSkips = 1 } = {}) {
    const safeWindowSize = Math.max(1, Math.min(20, Number(windowSize) || 4));
    const parsedMaxSkips = Number(maxSkips);
    const safeMaxSkips = Math.max(
      0,
      Math.min(safeWindowSize, Number.isFinite(parsedMaxSkips) ? parsedMaxSkips : 1)
    );
    const rows = this.db.prepare(`
      SELECT turn_id, reply_json
      FROM turns
      WHERE character_id = ?
        AND state IN ('committed', 'delivered', 'completed')
        AND json_extract(envelope_json, '$.kind') = 'PROACTIVE_CHAT'
        AND COALESCE(json_extract(reply_json, '$.skipReason'), '') <> 'structural_silence'
      ORDER BY created_at DESC
      LIMIT ?
    `).all(characterId, safeWindowSize);
    const usedSkips = rows.filter(row => parseJson(row.reply_json, {})?.action === 'skip').length;
    return {
      kind: 'proactive_chat',
      windowSize: safeWindowSize,
      maxSkips: safeMaxSkips,
      usedSkips,
      skipAllowed: usedSkips < safeMaxSkips,
      inspectedTurnIds: rows.map(row => row.turn_id),
      resetAfterTurnId: null
    };
  }

  setTurnRoute(turnId, route, reasons = []) {
    if (!['fast', 'deep', 'fast_to_deep'].includes(route)) throw new Error('invalid turn route');
    const result = this.db.prepare(`
      UPDATE turns SET route = ?, route_reasons_json = ?, updated_at = ? WHERE turn_id = ?
    `).run(route, canonicalJson([...new Set(reasons.map(String))]), now(), turnId);
    if (Number(result.changes) !== 1) throw new Error('turn not found');
    return this.getTurn(turnId);
  }

  beginStage(turnId, stage, model = null, effort = null, startedAt = now()) {
    if (!String(stage || '').trim()) throw new Error('stage is required');
    if (!this.getTurn(turnId)) throw new Error('turn not found');
    const active = this.db.prepare(`
      SELECT * FROM turn_stages
      WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(turnId, stage);
    if (active) return mapTurnStage(active);
    const ordinal = Number(this.db.prepare(
      'SELECT COALESCE(MAX(ordinal), 0) AS value FROM turn_stages WHERE turn_id = ?'
    ).get(turnId)?.value || 0) + 1;
    this.db.prepare(`
      INSERT INTO turn_stages(turn_id, stage, ordinal, model, effort, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(turnId, stage, ordinal, model, effort, Number(startedAt));
    return mapTurnStage(this.db.prepare(
      'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
    ).get(turnId, stage, ordinal));
  }

  finishStage(turnId, stage, finishedAt = now()) {
    const active = this.db.prepare(`
      SELECT * FROM turn_stages
      WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
      ORDER BY ordinal DESC LIMIT 1
    `).get(turnId, stage);
    if (!active) return null;
    const durationMs = Math.max(0, Number(finishedAt) - Number(active.started_at));
    this.db.prepare(`
      UPDATE turn_stages SET finished_at = ?, duration_ms = ?
      WHERE turn_id = ? AND stage = ? AND ordinal = ?
    `).run(Number(finishedAt), durationMs, turnId, stage, active.ordinal);
    return mapTurnStage(this.db.prepare(
      'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
    ).get(turnId, stage, active.ordinal));
  }

  getTurnStages(turnId) {
    return this.db.prepare(`
      SELECT * FROM turn_stages WHERE turn_id = ? ORDER BY ordinal ASC
    `).all(turnId).map(mapTurnStage);
  }

  listRecoverableTurns() {
    return this.db.prepare(`
      SELECT * FROM turns
      WHERE state IN (
        'queued', 'memory_running', 'memory_done', 'brain_running',
        'brain_done', 'supervisor_running', 'approved'
      )
      ORDER BY created_at ASC, turn_id ASC
    `).all().map(mapTurn);
  }

  registerCloudDelivery(turnId, peerId, recoveryAckSeq = 0) {
    if (!this.getTurn(turnId)) throw new Error('turn not found');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(peerId || ''))) throw new Error('invalid cloud peer');
    const ackSeq = Math.max(0, Number(recoveryAckSeq) || 0);
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, 'waiting', 0, ?, ?)
      ON CONFLICT(turn_id, peer_id) DO UPDATE SET
        recovery_ack_seq = MAX(cloud_deliveries.recovery_ack_seq, excluded.recovery_ack_seq),
        updated_at = excluded.updated_at
    `).run(turnId, String(peerId), ackSeq, timestamp, timestamp);
    return mapCloudDelivery(this.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
    ).get(turnId, String(peerId)));
  }

  listCloudDeliveries(turnId) {
    return this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id ASC
    `).all(turnId).map(mapCloudDelivery);
  }

  listPendingCloudDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT * FROM cloud_deliveries
      WHERE state IN ('waiting', 'pending')
      ORDER BY updated_at ASC, turn_id ASC, peer_id ASC LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  recoverFailedDraft(turnId, { peerId, sentAt = null } = {}) {
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state === 'committed' && current.replyJson) {
      return { recovered: false, result: parseJson(current.replyJson, null) };
    }
    if (current.state !== 'failed') throw new Error('turn is not failed');
    const draft = parseJson(current.brainDraftJson, null);
    const content = String(draft?.reply || '').trim();
    if (!content) throw new Error('failed turn has no recoverable brain draft');
    const envelope = parseJson(current.envelopeJson, null);
    if (!envelope) throw new Error('turn envelope is invalid');
    const targetPeer = String(peerId || current.deviceId || '');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(targetPeer)) throw new Error('invalid cloud peer');
    const timestamp = Math.max(1, Number(sentAt) || Number(current.updatedAt) || now());

    return this.transaction(() => {
      const message = this.putMessageInternal({
        messageId: `msg_yuqi_${contentHash(turnId).slice(0, 24)}`,
        turnId,
        characterId: current.characterId,
        speakerId: current.characterId,
        speakerType: 'character',
        recipientId: 'user',
        content,
        sentAt: timestamp,
        origin: 'codex'
      });
      if (['PROACTIVE_CHAT', 'PROACTIVE_MOMENT'].includes(String(envelope.kind || ''))) {
        this.quarantinePendingReply(message.messageId);
      }
      const result = {
        turnId,
        presetVersion: this.getCurrentPresetVersion(),
        reply: message,
        usedFactIds: Array.isArray(draft.usedFactIds) ? draft.usedFactIds.map(String) : []
      };
      const updated = this.db.prepare(`
        UPDATE turns
        SET state = 'committed', reply_json = ?, error_json = NULL, updated_at = ?
        WHERE turn_id = ? AND state = 'failed'
      `).run(JSON.stringify(result), now(), turnId);
      if (Number(updated.changes) !== 1) throw new Error('failed turn recovery conflict');

      const deliveryTimestamp = now();
      this.db.prepare(`
        INSERT INTO cloud_deliveries(
          turn_id, peer_id, recovery_ack_seq, state, attempts, created_at, updated_at
        ) VALUES (?, ?, 0, 'waiting', 0, ?, ?)
        ON CONFLICT(turn_id, peer_id) DO UPDATE SET
          state = 'waiting', payload_json = NULL, checksum = NULL, attempts = 0,
          updated_at = excluded.updated_at, delivered_at = NULL, confirmed_at = NULL
      `).run(turnId, targetPeer, deliveryTimestamp, deliveryTimestamp);
      const savedTurn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', savedTurn);
      this.putDiagnostic({
        turnId,
        stage: 'failed_draft_recovered',
        level: 'info',
        detail: { peerId: targetPeer, messageId: message.messageId }
      });
      return { recovered: true, result };
    });
  }

  requeueTransientFailedTurn(turnId) {
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state !== 'failed') return { requeued: false, turn: current };
    const failure = parseJson(current.errorJson, {});
    const isTransientCodexFailure = String(failure?.name || '') === 'CodexTurnError'
      && /(?:timed out|timeout|selected model is at capacity|model.+capacity|capacity.+model)/i
        .test(String(failure?.message || ''));
    if (!isTransientCodexFailure) return { requeued: false, turn: current };

    const checkpoint = current.brainDraftJson
      ? 'brain_done'
      : current.memoryPacketJson
        ? 'memory_done'
        : 'queued';

    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE turns
        SET state = ?, worker_id = NULL, error_json = NULL,
            brain_draft_json = CASE WHEN ? = 'memory_done' OR ? = 'queued' THEN NULL ELSE brain_draft_json END,
            supervisor_json = NULL, reply_json = NULL, updated_at = ?
        WHERE turn_id = ? AND state = 'failed'
      `).run(checkpoint, checkpoint, checkpoint, now(), turnId);
      if (Number(result.changes) !== 1) {
        return { requeued: false, turn: this.getTurn(turnId) };
      }
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'waiting', payload_json = NULL, checksum = NULL, attempts = 0,
            updated_at = ?, delivered_at = NULL, confirmed_at = NULL
        WHERE turn_id = ?
      `).run(now(), turnId);
      const savedTurn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', savedTurn);
      this.putDiagnostic({
        turnId,
        stage: 'transient_turn_requeued',
        level: 'info',
        detail: { checkpoint, failure }
      });
      return { requeued: true, turn: savedTurn };
    });
  }

  requeueUsageLimitFailedTurn(turnId) {
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state !== 'failed') return { requeued: false, turn: current };
    const failure = parseJson(current.errorJson, {});
    const isUsageLimit = String(failure?.name || '') === 'CodexTurnError'
      && /(?:usage limit|purchase more credits|额度)/i.test(String(failure?.message || ''));
    if (!isUsageLimit) return { requeued: false, turn: current };

    const checkpoint = current.brainDraftJson
      ? 'brain_done'
      : current.memoryPacketJson
        ? 'memory_done'
        : 'queued';

    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE turns
        SET state = ?, worker_id = NULL, error_json = NULL,
            brain_draft_json = CASE WHEN ? = 'memory_done' OR ? = 'queued' THEN NULL ELSE brain_draft_json END,
            supervisor_json = NULL, reply_json = NULL, updated_at = ?
        WHERE turn_id = ? AND state = 'failed'
      `).run(checkpoint, checkpoint, checkpoint, now(), turnId);
      if (Number(result.changes) !== 1) {
        return { requeued: false, turn: this.getTurn(turnId) };
      }
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'waiting', payload_json = NULL, checksum = NULL, attempts = 0,
            updated_at = ?, delivered_at = NULL, confirmed_at = NULL
        WHERE turn_id = ?
      `).run(now(), turnId);
      const savedTurn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', savedTurn);
      this.putDiagnostic({
        turnId,
        stage: 'usage_limit_turn_requeued',
        level: 'info',
        detail: { checkpoint, failure }
      });
      return { requeued: true, turn: savedTurn };
    });
  }

  prepareCloudDelivery(turnId, peerId, payload) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const existing = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId);
    if (!existing) throw new Error('cloud delivery not found');
    if (existing.checksum && existing.checksum !== checksum) throw new Error('cloud delivery checksum conflict');
    if (existing.state !== 'delivered') {
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'pending', payload_json = ?, checksum = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ?
      `).run(payloadJson, checksum, now(), turnId, peerId);
    }
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId));
  }

  markCloudDeliveryAttempt(turnId, peerId) {
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET attempts = attempts + 1, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending'
    `).run(now(), turnId, peerId);
    if (Number(result.changes) !== 1) throw new Error('pending cloud delivery not found');
  }

  markCloudDeliveryDelivered(turnId, peerId, checksum) {
    return this.markCloudDeliveryMailboxed(turnId, peerId, checksum);
  }

  markCloudDeliveryMailboxed(turnId, peerId, checksum) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = ?, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending' AND checksum = ?
    `).run(timestamp, timestamp, turnId, peerId, checksum);
    if (Number(result.changes) !== 1) throw new Error('cloud delivery acknowledgement conflict');
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, peerId));
  }

  getDeliveryState(turnId) {
    const turn = this.getTurn(turnId);
    if (!turn?.replyJson) return null;
    const expectedItems = deliveryItemsForResult(parseJson(turn.replyJson, {}));
    const delivered = this.db.prepare(`
      SELECT item_kind, item_id, checksum, delivered_at
      FROM delivery_receipt_items
      WHERE turn_id = ?
      ORDER BY delivered_at, item_kind, item_id
    `).all(turnId).map(row => ({
      kind: row.item_kind,
      id: row.item_id,
      checksum: row.checksum,
      deliveredAt: row.delivered_at
    }));
    const deliveredKeys = new Set(delivered.map(item => `${item.kind}:${item.id}`));
    return {
      turnId,
      expectedItems,
      deliveredItems: delivered,
      pendingItems: expectedItems.filter(item => !deliveredKeys.has(`${item.kind}:${item.id}`)),
      complete: expectedItems.length > 0 && expectedItems.every(
        item => deliveredKeys.has(`${item.kind}:${item.id}`)
      )
    };
  }

  promoteDeliveredMessageFactsInternal(messageId, deliveredAt = now()) {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE status = 'provisional'
        AND source_message_ids_json LIKE ?
    `).all(`%${String(messageId).replaceAll('%', '\\%').replaceAll('_', '\\_')}%`);
    let promoted = 0;
    for (const row of rows) {
      const fact = mapFact(row);
      if (
        fact?.evidenceSource !== 'fallback_provisional'
        || !(fact.sourceMessageIds || []).includes(String(messageId))
      ) continue;
      const next = {
        ...fact,
        evidenceSource: 'yuqi_delivered_message',
        status: 'verified',
        verifiedAt: Number(deliveredAt)
      };
      this.db.prepare(`
        UPDATE facts
        SET status = 'verified', origin = ?, checksum = ?, verified_at = ?, fact_json = ?
        WHERE fact_id = ? AND status = 'provisional'
      `).run(
        String(next.origin || 'consolidation'),
        contentHash(next),
        Number(deliveredAt),
        canonicalJson(next),
        next.factId
      );
      promoted += 1;
    }
    return promoted;
  }

  recordDeliveryReceipt(receipt) {
    const normalized = validateDeliveryReceipt(receipt);
    const turn = this.getTurn(normalized.turnId);
    if (!turn?.replyJson) throw new Error('delivery receipt turn has no approved result');
    const expected = new Map(
      deliveryItemsForResult(parseJson(turn.replyJson, {}))
        .map(item => [`${item.kind}:${item.id}`, item])
    );
    for (const item of normalized.items) {
      const authoritative = expected.get(`${item.kind}:${item.id}`);
      if (!authoritative) throw new Error('delivery receipt item does not belong to turn result');
      if (authoritative.checksum !== item.checksum) {
        throw new Error('delivery receipt item checksum mismatch');
      }
    }
    return this.transaction(() => {
      for (const item of normalized.items) {
        const existing = this.db.prepare(`
          SELECT checksum FROM delivery_receipt_items
          WHERE turn_id = ? AND item_kind = ? AND item_id = ?
        `).get(normalized.turnId, item.kind, item.id);
        if (existing && existing.checksum !== item.checksum) {
          throw new Error('delivery receipt item conflict');
        }
        this.db.prepare(`
          INSERT OR IGNORE INTO delivery_receipt_items(
            turn_id, item_kind, item_id, checksum, delivered_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          normalized.turnId,
          item.kind,
          item.id,
          item.checksum,
          normalized.deliveredAt,
          now()
        );
        if (item.kind === 'message') {
          this.db.prepare(`
            DELETE FROM suppressed_messages
            WHERE message_id = ? AND reason = 'pending_phone_receipt'
          `).run(item.id);
          this.promoteDeliveredMessageFactsInternal(item.id, normalized.deliveredAt);
        }
      }
      return this.getDeliveryState(normalized.turnId);
    });
  }

  confirmCloudDeliveryItems(turnId, peerId, receipt) {
    const deliveryState = this.recordDeliveryReceipt(receipt);
    const delivery = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, String(peerId));
    if (!delivery) throw new Error('cloud delivery not found');
    if (delivery.state !== 'confirmed') {
      if (!['mailboxed', 'delivered'].includes(delivery.state)) {
        throw new Error('cloud delivery is not awaiting a phone receipt');
      }
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ?
      `).run(Number(receipt.deliveredAt) || now(), now(), turnId, String(peerId));
    }
    return deliveryState;
  }

  confirmCloudDelivery(turnId, peerId, receipt) {
    const message = this.getMessage(String(receipt?.messageId || ''));
    if (!message || message.turnId !== turnId || message.speakerType !== 'character') {
      throw new Error('delivery receipt message mismatch');
    }
    const expectedHash = createHash('sha256').update(message.content, 'utf8').digest('hex');
    if (String(receipt?.contentSha256 || '') !== expectedHash) {
      throw new Error('delivery receipt content checksum mismatch');
    }
    const delivery = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, String(peerId));
    if (!delivery) throw new Error('cloud delivery not found');
    if (delivery.state === 'confirmed') return mapCloudDelivery(delivery);
    if (!['mailboxed', 'delivered'].includes(delivery.state)) {
      throw new Error('cloud delivery is not awaiting a phone receipt');
    }
    const confirmedAt = Math.max(1, Number(receipt?.receivedAt) || now());
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state IN ('mailboxed', 'delivered')
      `).run(confirmedAt, now(), turnId, String(peerId));
      if (Number(result.changes) !== 1) throw new Error('cloud delivery confirmation conflict');
      this.db.prepare(`
        DELETE FROM suppressed_messages
        WHERE message_id = ? AND reason = 'pending_phone_receipt'
      `).run(message.messageId);
      return mapCloudDelivery(this.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
      `).get(turnId, String(peerId)));
    });
  }

  claimTurn(workerId) {
    if (!workerId) throw new Error('workerId is required');
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT turn_id FROM turns WHERE state = 'queued' ORDER BY created_at, turn_id LIMIT 1"
      ).get();
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE turns SET state = 'memory_running', worker_id = ?, updated_at = ?
        WHERE turn_id = ? AND state = 'queued'
      `).run(workerId, now(), row.turn_id);
      if (Number(result.changes) !== 1) return null;
      const turn = this.getTurn(row.turn_id);
      this.appendSync('turn', row.turn_id, 'state', turn);
      return turn;
    });
  }

  claimTurnById(turnId, workerId) {
    if (!workerId) throw new Error('workerId is required');
    const result = this.db.prepare(`
      UPDATE turns SET state = 'memory_running', worker_id = ?, updated_at = ?
      WHERE turn_id = ? AND state = 'queued'
    `).run(workerId, now(), turnId);
    if (Number(result.changes) !== 1) return null;
    const turn = this.getTurn(turnId);
    this.appendSync('turn', turnId, 'state', turn);
    return turn;
  }

  advanceTurn(turnId, expectedState, nextState, patch = {}) {
    if (!TURN_STATES.includes(expectedState) || !TURN_STATES.includes(nextState)) {
      throw new Error('unknown turn state');
    }
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.state !== expectedState) throw new Error('stale turn state');

    const assignments = ['state = ?', 'updated_at = ?'];
    const values = [nextState, now()];
    for (const [key, value] of Object.entries(patch || {})) {
      const column = TURN_PATCH_COLUMNS.get(key);
      if (!column) throw new Error(`unsupported turn patch: ${key}`);
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    values.push(turnId, expectedState);

    const result = this.db.prepare(`
      UPDATE turns SET ${assignments.join(', ')} WHERE turn_id = ? AND state = ?
    `).run(...values);
    if (Number(result.changes) !== 1) throw new Error('stale turn state');
    const saved = this.getTurn(turnId);
    this.appendSync('turn', turnId, 'state', saved);
    return saved;
  }

  putMessageInternal(message) {
    const normalized = {
      messageId: String(message.messageId || ''),
      turnId: String(message.turnId || ''),
      characterId: String(message.characterId || ''),
      speakerId: String(message.speakerId || ''),
      speakerType: String(message.speakerType || ''),
      recipientId: String(message.recipientId || ''),
      content: String(message.content || ''),
      sentAt: Number(message.sentAt),
      origin: String(message.origin || 'codex'),
      deviceId: message.deviceId ? String(message.deviceId) : null,
      deviceSeq: Number.isSafeInteger(message.deviceSeq) ? message.deviceSeq : null
    };
    if (!normalized.messageId || !normalized.turnId || !normalized.characterId) throw new Error('invalid message identity');
    if (!['user', 'character'].includes(normalized.speakerType)) throw new Error('invalid message speaker type');
    if (normalized.speakerType === 'user' && normalized.speakerId !== 'user') throw new Error('speaker mismatch');
    if (normalized.speakerType === 'character' && normalized.speakerId !== normalized.characterId) throw new Error('speaker mismatch');
    if (!normalized.content.trim() || !Number.isSafeInteger(normalized.sentAt)) throw new Error('invalid message content');

    const checksum = contentHash(normalized);
    const existing = this.db.prepare('SELECT checksum FROM messages WHERE message_id = ?').get(normalized.messageId);
    if (existing) {
      if (existing.checksum !== checksum) throw new Error('message checksum conflict');
      return mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(normalized.messageId));
    }
    this.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type, recipient_id,
        content, sent_at, origin, device_id, device_seq, checksum, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.messageId, normalized.turnId, normalized.characterId, normalized.speakerId,
      normalized.speakerType, normalized.recipientId, normalized.content, normalized.sentAt,
      normalized.origin, normalized.deviceId, normalized.deviceSeq, checksum, now()
    );
    const saved = mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(normalized.messageId));
    this.appendSync('message', normalized.messageId, 'insert', saved);
    return saved;
  }

  putMessage(message) {
    return this.transaction(() => this.putMessageInternal(message));
  }

  listMessages(characterId, limit = 200) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 200));
    return this.db.prepare(`
      SELECT recent.*, batch.batch_id, batch.batch_sequence
      FROM (
        SELECT * FROM messages
        WHERE character_id = ?
          AND message_id NOT IN (SELECT message_id FROM suppressed_messages)
        ORDER BY sent_at DESC, message_id DESC LIMIT ?
      ) AS recent
      LEFT JOIN (
        SELECT message_id, MIN(batch_id) AS batch_id, MIN(sequence) AS batch_sequence
        FROM current_user_batch_items
        GROUP BY message_id
      ) AS batch ON batch.message_id = recent.message_id
      ORDER BY recent.sent_at ASC, recent.message_id ASC
    `).all(characterId, safeLimit).map(mapMessage);
  }

  getMessage(messageId) {
    return mapMessage(this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId));
  }

  getMessageContext(messageId, radius = 1) {
    const message = this.getMessage(messageId);
    if (!message) return [];
    const safeRadius = Math.max(0, Math.min(20, Number(radius) || 0));
    const rows = this.db.prepare(`
      SELECT * FROM messages
      WHERE character_id = ?
        AND message_id NOT IN (SELECT message_id FROM suppressed_messages)
      ORDER BY sent_at ASC, message_id ASC
    `).all(message.characterId).map(mapMessage);
    const index = rows.findIndex(item => item.messageId === messageId);
    if (index < 0) return [];
    return rows.slice(Math.max(0, index - safeRadius), index + safeRadius + 1);
  }

  putFact(fact) {
    if (!fact?.factId || !fact.characterId || !fact.subjectId || !fact.predicate) throw new Error('invalid fact');
    const normalized = {
      ...fact,
      status: fact.status || 'provisional',
      confidence: Number(fact.confidence) || 0,
      origin: fact.origin || 'memory',
      sourceMessageIds: [...new Set(fact.sourceMessageIds || [])],
      exactQuotes: fact.exactQuotes || []
    };
    const checksum = contentHash(normalized);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT checksum FROM facts WHERE fact_id = ?').get(normalized.factId);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error('fact checksum conflict');
        return normalized;
      }
      this.db.prepare(`
        INSERT INTO facts(
          fact_id, character_id, subject_id, predicate, object_json, evidence_mode,
          source_message_ids_json, exact_quotes_json, status, confidence, supersedes,
          origin, checksum, created_at, verified_at, fact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.factId, normalized.characterId, normalized.subjectId, normalized.predicate,
        canonicalJson(normalized.object ?? null), normalized.evidenceMode || 'uncertain',
        canonicalJson(normalized.sourceMessageIds), canonicalJson(normalized.exactQuotes),
        normalized.status, normalized.confidence, normalized.supersedes || null,
        normalized.origin, checksum, normalized.createdAt || now(), normalized.verifiedAt || null,
        canonicalJson(normalized)
      );
      this.appendSync('fact', normalized.factId, 'insert', normalized);
      return normalized;
    });
  }


  listFacts(characterId, { status } = {}) {
    const rows = status
      ? this.db.prepare('SELECT * FROM facts WHERE character_id = ? AND status = ? ORDER BY created_at ASC, fact_id ASC').all(characterId, status)
      : this.db.prepare('SELECT * FROM facts WHERE character_id = ? ORDER BY created_at ASC, fact_id ASC').all(characterId);
    return rows.map(mapFact);
  }

  listRetrievableFacts(characterId, options = {}) {
    const suppressed = new Set(this.db.prepare(
      'SELECT message_id FROM suppressed_messages'
    ).all().map(row => row.message_id));
    return this.listFacts(characterId, options).filter(fact =>
      !(fact.sourceMessageIds || []).some(messageId => suppressed.has(messageId))
    );
  }

  getSyncDelta(afterSeq = 0, limit = 500) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 500));
    return this.db.prepare(`
      SELECT seq, entity_type, entity_id, operation, payload_json, checksum, created_at
      FROM sync_log WHERE seq > ? ORDER BY seq ASC LIMIT ?
    `).all(Number(afterSeq) || 0, safeLimit).map(row => ({
      seq: row.seq,
      entityType: row.entity_type,
      entityId: row.entity_id,
      operation: row.operation,
      payload: parseJson(row.payload_json, {}),
      checksum: row.checksum,
      createdAt: row.created_at
    }));
  }

  ackSync(peerId, seq) {
    const normalizedSeq = Math.max(0, Number(seq) || 0);
    this.db.prepare(`
      INSERT INTO sync_cursors(peer_id, ack_seq, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        ack_seq = MAX(sync_cursors.ack_seq, excluded.ack_seq),
        updated_at = excluded.updated_at
    `).run(peerId, normalizedSeq, now());
    return this.getSyncCursor(peerId);
  }

  getSyncCursor(peerId) {
    return Number(this.db.prepare('SELECT ack_seq FROM sync_cursors WHERE peer_id = ?').get(peerId)?.ack_seq || 0);
  }

  suppressCompetingReplies(turnId, authoritativeMessageId) {
    const authoritative = this.getMessage(authoritativeMessageId);
    if (!authoritative || authoritative.turnId !== turnId || authoritative.speakerType !== 'character') {
      throw new Error('authoritative reply not found');
    }
    const candidates = this.db.prepare(`
      SELECT message_id FROM messages
      WHERE turn_id = ? AND speaker_type = 'character' AND message_id != ?
        AND origin != 'fallback'
    `).all(turnId, authoritativeMessageId);
    let suppressed = 0;
    for (const row of candidates) {
      const result = this.db.prepare(`
        INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
        VALUES (?, ?, 'fallback_reply_was_delivered', ?)
      `).run(row.message_id, authoritativeMessageId, now());
      suppressed += Number(result.changes || 0);
    }
    return suppressed;
  }

  isMessageSuppressed(messageId) {
    return !!this.db.prepare('SELECT 1 AS found FROM suppressed_messages WHERE message_id = ?').get(messageId);
  }

  quarantinePendingReply(messageId) {
    const message = this.getMessage(messageId);
    if (!message || message.speakerType !== 'character') throw new Error('pending reply not found');
    this.db.prepare(`
      INSERT OR IGNORE INTO suppressed_messages(message_id, authoritative_message_id, reason, created_at)
      VALUES (?, ?, 'pending_phone_receipt', ?)
    `).run(message.messageId, message.messageId, now());
    return message;
  }

  getLifeEpisode(episodeId) {
    return mapLifeEpisode(this.db.prepare('SELECT * FROM life_episodes WHERE episode_id = ?').get(episodeId));
  }

  listLifeEpisodes(characterId, { from = null, to = null } = {}) {
    const clauses = ['character_id = ?'];
    const values = [String(characterId)];
    if (from !== null) {
      clauses.push('end_at > ?');
      values.push(Number(from));
    }
    if (to !== null) {
      clauses.push('start_at < ?');
      values.push(Number(to));
    }
    return this.db.prepare(`
      SELECT * FROM life_episodes
      WHERE ${clauses.join(' AND ')}
      ORDER BY start_at ASC, episode_id ASC
    `).all(...values).map(mapLifeEpisode);
  }

  putLifePlanInternal(characterId, episodes, { sourceTurnId = null } = {}) {
    const safeCharacterId = String(characterId || '');
    if (!safeCharacterId || !Array.isArray(episodes)) throw new Error('invalid life plan');
    const forbiddenKinds = /(?:accident|illness|hospital|job_loss|identity_change|new_relationship|事故|生病|疾病|住院|失业|辞职|新恋情|身份变化)/i;
    const normalized = episodes.map(item => {
      const episode = {
        episodeId: String(item?.episodeId || ''),
        characterId: safeCharacterId,
        kind: String(item?.kind || ''),
        title: String(item?.title || ''),
        startAt: Number(item?.startAt),
        endAt: Number(item?.endAt),
        payload: item?.payload && typeof item.payload === 'object' && !Array.isArray(item.payload) ? item.payload : {}
      };
      if (!episode.episodeId || !episode.kind || !episode.title || !(episode.endAt > episode.startAt)) {
        throw new Error('invalid life episode');
      }
      if (forbiddenKinds.test(`${episode.kind} ${episode.title}`)) {
        throw new Error('forbidden life episode kind');
      }
      return episode;
    }).sort((left, right) => left.startAt - right.startAt || left.episodeId.localeCompare(right.episodeId));
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index].startAt < normalized[index - 1].endAt) throw new Error('life episode overlap');
    }

    const incomingIds = new Set(normalized.map(item => item.episodeId));
    for (const episode of normalized) {
        const checksum = contentHash(episode);
        const existing = this.getLifeEpisode(episode.episodeId);
        if (existing) {
          if (existing.checksum !== checksum) throw new Error('life episode checksum conflict');
          continue;
        }
        const overlap = this.db.prepare(`
          SELECT episode_id FROM life_episodes
          WHERE character_id = ? AND status != 'cancelled' AND start_at < ? AND end_at > ?
          LIMIT 1
        `).get(safeCharacterId, episode.endAt, episode.startAt);
        if (overlap && !incomingIds.has(overlap.episode_id)) throw new Error('life episode overlap');
        const timestamp = now();
        this.db.prepare(`
          INSERT INTO life_episodes(
            episode_id, character_id, kind, title, start_at, end_at, status,
            payload_json, checksum, source_turn_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)
        `).run(
          episode.episodeId, safeCharacterId, episode.kind, episode.title,
          episode.startAt, episode.endAt, canonicalJson(episode.payload), checksum,
          sourceTurnId, timestamp, timestamp
        );
    }
    return normalized.map(item => this.getLifeEpisode(item.episodeId));
  }

  putLifePlan(characterId, episodes, options = {}) {
    return this.transaction(() => this.putLifePlanInternal(characterId, episodes, options));
  }

  getCharacterLifeState(characterId) {
    return mapCharacterLifeState(
      this.db.prepare('SELECT * FROM character_life_state WHERE character_id = ?').get(characterId)
    );
  }

  advanceLifeState(characterId, at, state = {}) {
    const current = this.getCharacterLifeState(characterId);
    const episode = this.db.prepare(`
      SELECT episode_id FROM life_episodes
      WHERE character_id = ? AND start_at <= ? AND end_at > ?
      ORDER BY start_at DESC LIMIT 1
    `).get(characterId, Number(at), Number(at));
    const revision = Number(current?.revision || 0) + 1;
    this.db.prepare(`
      INSERT INTO character_life_state(
        character_id, current_episode_id, revision, last_advanced_at, state_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(character_id) DO UPDATE SET
        current_episode_id = excluded.current_episode_id,
        revision = excluded.revision,
        last_advanced_at = MAX(character_life_state.last_advanced_at, excluded.last_advanced_at),
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(characterId, episode?.episode_id || null, revision, Number(at), canonicalJson(state), now());
    this.db.prepare(`
      UPDATE life_episodes SET status = CASE
        WHEN end_at <= ? THEN 'completed'
        WHEN start_at <= ? AND end_at > ? THEN 'active'
        ELSE 'planned'
      END, updated_at = ?
      WHERE character_id = ? AND status != 'cancelled'
    `).run(Number(at), Number(at), Number(at), now(), characterId);
    return this.getCharacterLifeState(characterId);
  }

  retireLegacyGeneratedLifeEpisodes(characterId, at = now()) {
    const result = this.db.prepare(`
      UPDATE life_episodes
      SET status = 'cancelled',
          adjustment_reason = 'retired_fixed_template_for_chat_brain_planning',
          updated_at = ?
      WHERE character_id = ?
        AND status != 'cancelled'
        AND end_at > ?
        AND source_turn_id IS NULL
        AND json_extract(payload_json, '$.planVersion') = 'life-v1'
    `).run(Number(at), characterId, Number(at));
    return Number(result.changes || 0);
  }

  applyLifeAdjustment(characterId, adjustment, sourceTurnId, appliedAt = now()) {
    const type = String(adjustment?.type || 'none');
    if (type === 'none') return null;
    const target = this.getLifeEpisode(String(adjustment?.targetEpisodeId || ''));
    if (!target || target.characterId !== characterId) throw new Error('life adjustment target not found');
    if (!['reschedule', 'shorten', 'extend', 'cancel'].includes(type)) throw new Error('invalid life adjustment');
    if (type === 'cancel') {
      this.db.prepare(`
        UPDATE life_episodes SET status = 'cancelled', source_turn_id = ?,
          adjustment_reason = ?, updated_at = ? WHERE episode_id = ?
      `).run(sourceTurnId, String(adjustment.reason || ''), Number(appliedAt), target.episodeId);
      return this.getLifeEpisode(target.episodeId);
    }
    const startAt = type === 'reschedule' ? Number(adjustment.startAt) : target.startAt;
    const endAt = ['reschedule', 'shorten', 'extend'].includes(type)
      ? Number(adjustment.endAt)
      : target.endAt;
    if (!(endAt > startAt)) throw new Error('invalid adjusted life episode');
    const overlap = this.db.prepare(`
      SELECT episode_id FROM life_episodes
      WHERE character_id = ? AND episode_id != ? AND status != 'cancelled'
        AND start_at < ? AND end_at > ?
      LIMIT 1
    `).get(characterId, target.episodeId, endAt, startAt);
    if (overlap) throw new Error('life adjustment overlap');
    const canonical = {
      episodeId: target.episodeId,
      characterId,
      kind: target.kind,
      title: target.title,
      startAt,
      endAt,
      payload: target.payload
    };
    this.db.prepare(`
      UPDATE life_episodes SET start_at = ?, end_at = ?, checksum = ?,
        source_turn_id = ?, adjustment_reason = ?, updated_at = ?
      WHERE episode_id = ?
    `).run(
      startAt, endAt, contentHash(canonical), sourceTurnId,
      String(adjustment.reason || ''), Number(appliedAt), target.episodeId
    );
    return this.getLifeEpisode(target.episodeId);
  }

  setSession(role, threadId) {
    if (!['memory', 'brain', 'supervisor'].includes(role)) throw new Error('invalid session role');
    if (!String(threadId || '').trim()) throw new Error('invalid thread id');
    this.db.prepare(`
      INSERT INTO sessions(role, thread_id, turn_count, updated_at) VALUES (?, ?, 0, ?)
      ON CONFLICT(role) DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_count = 0,
        updated_at = excluded.updated_at
    `).run(role, String(threadId), now());
    return String(threadId);
  }

  getSession(role) {
    return String(this.db.prepare('SELECT thread_id FROM sessions WHERE role = ?').get(role)?.thread_id || '');
  }

  getSessionState(role) {
    const row = this.db.prepare('SELECT thread_id, turn_count FROM sessions WHERE role = ?').get(role);
    if (!row) return null;
    return { threadId: String(row.thread_id), turnCount: Number(row.turn_count || 0) };
  }

  incrementSessionTurnCount(role) {
    const result = this.db.prepare(`
      UPDATE sessions SET turn_count = turn_count + 1, updated_at = ? WHERE role = ?
    `).run(now(), role);
    if (!result.changes) throw new Error('session not found');
    return this.getSessionState(role);
  }

  putPresetVersion(version) {
    if (!version?.version || !version.checksum) throw new Error('invalid preset version');
    const manifestJson = canonicalJson(version);
    const existing = this.db.prepare('SELECT manifest_json FROM preset_versions WHERE version = ?').get(version.version);
    if (existing) {
      if (existing.manifest_json !== manifestJson) throw new Error('preset version conflict');
      return version;
    }
    this.db.prepare(`
      INSERT INTO preset_versions(version, parent_version, manifest_json, checksum, published_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(version.version, version.parentVersion || null, manifestJson, version.checksum, version.publishedAt || now());
    return version;
  }

  getPresetVersion(version) {
    return mapPresetVersion(this.db.prepare('SELECT * FROM preset_versions WHERE version = ?').get(version));
  }

  listPresetVersions() {
    return this.db.prepare('SELECT * FROM preset_versions ORDER BY published_at ASC, version ASC').all().map(mapPresetVersion);
  }

  setCurrentPresetVersion(version) {
    if (!this.getPresetVersion(version)) throw new Error('preset version not found');
    this.db.prepare(`
      INSERT INTO runtime_state(key, value, updated_at) VALUES ('current_preset_version', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(version, now());
    return version;
  }

  getCurrentPresetVersion() {
    return String(this.db.prepare("SELECT value FROM runtime_state WHERE key = 'current_preset_version'").get()?.value || '');
  }

  putAnnotation(annotation) {
    if (!annotation?.annotationId || !annotation.turnId || !annotation.presetVersion) throw new Error('invalid annotation');
    const payload = canonicalJson(annotation);
    const existing = this.db.prepare('SELECT annotation_json FROM annotations WHERE annotation_id = ?').get(annotation.annotationId);
    if (existing) {
      if (existing.annotation_json !== payload) throw new Error('annotation conflict');
      return annotation;
    }
    this.db.prepare(`
      INSERT INTO annotations(
        annotation_id, turn_id, source_message_id, preset_version,
        annotation_json, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      annotation.annotationId, annotation.turnId, annotation.sourceMessageId || null,
      annotation.presetVersion, payload, annotation.status || 'proposed', annotation.createdAt || now()
    );
    return annotation;
  }

  getAnnotation(annotationId) {
    return mapAnnotation(this.db.prepare('SELECT * FROM annotations WHERE annotation_id = ?').get(annotationId));
  }

  updateAnnotationStatus(annotationId, status) {
    const result = this.db.prepare('UPDATE annotations SET status = ? WHERE annotation_id = ?').run(status, annotationId);
    if (Number(result.changes) !== 1) throw new Error('annotation not found');
    return this.getAnnotation(annotationId);
  }

  putDiagnostic({ turnId = null, stage, level = 'info', detail = {} }) {
    if (!stage) throw new Error('diagnostic stage is required');
    const result = this.db.prepare(`
      INSERT INTO diagnostics(turn_id, stage, level, detail_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(turnId, stage, level, canonicalJson(detail), now());
    return Number(result.lastInsertRowid);
  }

  getCognitiveState(roleId) {
    return mapCognitiveState(
      this.db.prepare('SELECT * FROM cognitive_states WHERE role_id = ?').get(roleId)
    );
  }

  putCognitiveStateInternal(state) {
    const roleId = String(state?.roleId || '');
    const revision = Number(state?.revision);
    const schemaVersion = Number(state?.schemaVersion || 1);
    const lastTurnId = String(state?.lastTurnId || '');
    if (!roleId || !lastTurnId || !Number.isInteger(revision) || revision < 1) {
      throw new CognitiveStateConflictError('invalid cognitive state identity');
    }
    const stateJson = canonicalJson(state?.state || {});
    const checksum = contentHash(state?.state || {});
    if (state?.checksum && state.checksum !== checksum) {
      throw new CognitiveStateConflictError('cognitive state checksum mismatch');
    }
    const current = this.getCognitiveState(roleId);
    if (current) {
      if (current.lastTurnId === lastTurnId && current.revision === revision) {
        if (current.checksum !== checksum) throw new CognitiveStateConflictError();
        return current;
      }
      if (revision !== current.revision + 1) throw new CognitiveStateConflictError();
      if (state.expectedChecksum && state.expectedChecksum !== current.checksum) {
        throw new CognitiveStateConflictError();
      }
    } else if (revision !== 1) {
      throw new CognitiveStateConflictError();
    }
    const updatedAt = Number(state?.updatedAt || now());
    this.db.prepare(`
      INSERT INTO cognitive_states(
        role_id, schema_version, revision, last_turn_id, state_json, checksum, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        revision = excluded.revision,
        last_turn_id = excluded.last_turn_id,
        state_json = excluded.state_json,
        checksum = excluded.checksum,
        updated_at = excluded.updated_at
    `).run(roleId, schemaVersion, revision, lastTurnId, stateJson, checksum, updatedAt);
    return this.getCognitiveState(roleId);
  }

  deleteCognitiveStateInternal(roleId) {
    return Number(this.db.prepare('DELETE FROM cognitive_states WHERE role_id = ?').run(roleId).changes);
  }

  createConsolidationJobInternal(job) {
    const subjectType = String(job?.subjectType || '');
    const subjectId = String(job?.subjectId || '');
    const jobType = String(job?.jobType || '');
    const roleId = String(job?.roleId || '');
    const turnId = job?.turnId ? String(job.turnId) : null;
    if (!['turn', 'role_history', 'life_planning'].includes(subjectType)
      || !subjectId || !roleId
      || !['turn_consolidation', 'history_backfill', 'shadow_cognition', 'active_canary_compare'].includes(jobType)
      || (subjectType === 'turn') !== Boolean(turnId)) {
      throw new Error('invalid consolidation job');
    }
    const payloadJson = canonicalJson(job?.payload || {});
    const payloadChecksum = contentHash(job?.payload || {});
    const existing = this.db.prepare(`
      SELECT * FROM consolidation_jobs
      WHERE subject_type = ? AND subject_id = ? AND job_type = ?
    `).get(subjectType, subjectId, jobType);
    if (existing) {
      if (existing.payload_checksum !== payloadChecksum) throw new ConsolidationJobConflictError();
      return mapConsolidationJob(existing);
    }
    const timestamp = Number(job?.createdAt || now());
    this.db.prepare(`
      INSERT INTO consolidation_jobs(
        job_id, subject_type, subject_id, turn_id, role_id, job_type, state,
        attempt_count, due_at, payload_json, payload_checksum, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)
    `).run(
      String(job?.jobId || `job_${contentHash({ subjectType, subjectId, jobType }).slice(0, 24)}`),
      subjectType, subjectId, turnId, roleId, jobType, Number(job?.dueAt || timestamp),
      payloadJson, payloadChecksum, timestamp, timestamp
    );
    return mapConsolidationJob(this.db.prepare(`
      SELECT * FROM consolidation_jobs
      WHERE subject_type = ? AND subject_id = ? AND job_type = ?
    `).get(subjectType, subjectId, jobType));
  }

  claimDueConsolidationJob({ workerId, jobTypes, now: claimAt = now(), leaseMs = 60_000 }) {
    if (!String(workerId || '') || !Array.isArray(jobTypes) || !jobTypes.length) {
      throw new Error('workerId and jobTypes are required');
    }
    return this.transaction(() => {
      const placeholders = jobTypes.map(() => '?').join(',');
      const row = this.db.prepare(`
        SELECT * FROM consolidation_jobs
        WHERE job_type IN (${placeholders})
          AND due_at <= ?
          AND (
            state IN ('queued', 'retry_wait')
            OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
          )
        ORDER BY due_at, created_at, job_id
        LIMIT 1
      `).get(...jobTypes, Number(claimAt), Number(claimAt));
      if (!row) return null;
      if (contentHash(parseJson(row.payload_json, {})) !== row.payload_checksum) {
        this.db.prepare(`
          UPDATE consolidation_jobs
          SET state = 'failed', last_error_code = 'JOB_PAYLOAD_CHECKSUM_MISMATCH',
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE job_id = ?
        `).run(Number(claimAt), row.job_id);
        return null;
      }
      this.db.prepare(`
        UPDATE consolidation_jobs
        SET state = 'running', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE job_id = ?
      `).run(String(workerId), Number(claimAt) + Number(leaseMs), Number(claimAt), row.job_id);
      return mapConsolidationJob(
        this.db.prepare('SELECT * FROM consolidation_jobs WHERE job_id = ?').get(row.job_id)
      );
    });
  }

  getConsolidationJob(jobId) {
    return mapConsolidationJob(this.db.prepare(
      'SELECT * FROM consolidation_jobs WHERE job_id = ?'
    ).get(String(jobId)));
  }

  completeConsolidationJob({ jobId, workerId, now: completedAt = now() }) {
    return this.transaction(() => {
      const result = this.db.prepare(`
        UPDATE consolidation_jobs
        SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      `).run(Number(completedAt), jobId, workerId);
      if (Number(result.changes) !== 1) throw new Error('consolidation job lease mismatch');
      return mapConsolidationJob(
        this.db.prepare('SELECT * FROM consolidation_jobs WHERE job_id = ?').get(jobId)
      );
    });
  }

  failConsolidationJob({ jobId, workerId, now: failedAt = now(), errorCode, nextDueAt }) {
    return this.transaction(() => {
      const retry = Number(nextDueAt) > Number(failedAt);
      const result = this.db.prepare(`
        UPDATE consolidation_jobs
        SET state = ?, due_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      `).run(
        retry ? 'retry_wait' : 'failed',
        retry ? Number(nextDueAt) : Number(failedAt),
        String(errorCode || 'UNKNOWN'),
        Number(failedAt),
        jobId,
        workerId
      );
      if (Number(result.changes) !== 1) throw new Error('consolidation job lease mismatch');
      return mapConsolidationJob(
        this.db.prepare('SELECT * FROM consolidation_jobs WHERE job_id = ?').get(jobId)
      );
    });
  }

  listRecoverableConsolidationJobs({ now: at = now() } = {}) {
    return this.db.prepare(`
      SELECT * FROM consolidation_jobs
      WHERE state IN ('queued', 'retry_wait')
         OR (state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
      ORDER BY due_at, created_at, job_id
    `).all(Number(at)).map(mapConsolidationJob);
  }

  putCognitionShadowRunInternal(run) {
    if (run?.source !== 'live') throw new Error('cognition shadow run source must be live');
    const timestamp = Number(run?.createdAt || now());
    this.db.prepare(`
      INSERT INTO cognition_shadow_runs(
        run_id, subject_type, subject_id, turn_id, rollout_key, source,
        comparison_direction, evidence_epoch, shadow_epoch, canary_epoch, canary_slot,
        rollout_revision, pipeline_checksum, state, authoritative_result_checksum,
        comparison_result_checksum, metrics_json, critical_findings_json, latency_ms,
        error_code, stale_for_rollout, source_deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'live', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        state = excluded.state,
        authoritative_result_checksum = excluded.authoritative_result_checksum,
        comparison_result_checksum = excluded.comparison_result_checksum,
        metrics_json = excluded.metrics_json,
        critical_findings_json = excluded.critical_findings_json,
        latency_ms = excluded.latency_ms,
        error_code = excluded.error_code,
        stale_for_rollout = excluded.stale_for_rollout,
        source_deleted_at = excluded.source_deleted_at,
        updated_at = excluded.updated_at
    `).run(
      run.runId, run.subjectType, run.subjectId, run.turnId || null, run.rolloutKey,
      run.comparisonDirection, Number(run.evidenceEpoch), run.shadowEpoch ?? null,
      run.canaryEpoch ?? null, run.canarySlot ?? null, Number(run.rolloutRevision),
      run.pipelineChecksum, run.state, run.authoritativeResultChecksum || null,
      run.comparisonResultChecksum || null,
      run.metrics == null ? null : canonicalJson(run.metrics),
      run.criticalFindings == null ? null : canonicalJson(run.criticalFindings),
      run.latencyMs ?? null, run.errorCode || null, run.staleForRollout ? 1 : 0,
      run.sourceDeletedAt ?? null, timestamp, Number(run.updatedAt || timestamp)
    );
    return this.getCognitionShadowRun(run.runId);
  }

  getCognitionShadowRun(runId) {
    return mapShadowRun(
      this.db.prepare('SELECT * FROM cognition_shadow_runs WHERE run_id = ?').get(runId)
    );
  }

  recordComparisonOutcomeInternal({
    jobId,
    workerId,
    run,
    report,
    criticalFindings = [],
    now: recordedAt = now()
  }) {
    return this.transaction(() => {
      const job = this.db.prepare(
        'SELECT * FROM consolidation_jobs WHERE job_id = ?'
      ).get(String(jobId));
      if (!job || job.state !== 'running' || job.lease_owner !== workerId) {
        throw new Error('comparison job lease is not held');
      }
      if (contentHash(parseJson(job.payload_json, {})) !== job.payload_checksum) {
        throw new Error('comparison job payload checksum mismatch');
      }
      const payload = parseJson(job.payload_json, {});
      const rollout = this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
      ).get(payload.rolloutKey);
      const shadowDirection = payload.comparisonDirection
        === 'legacy_authoritative_cognition_compare';
      const validEpoch = Boolean(rollout)
        && Number(rollout.evidence_epoch) === Number(payload.rolloutEvidenceEpoch)
        && rollout.pipeline_checksum === payload.pipelineChecksum
        && (
          shadowDirection
            ? rollout.current_mode === 'shadow'
              && Number(rollout.shadow_epoch) === Number(payload.shadowEpoch)
            : rollout.current_mode === 'active'
              && rollout.rollout_phase === 'canary'
              && Number(rollout.canary_epoch) === Number(payload.canaryEpoch)
        );
      const stale = !validEpoch;
      this.putCognitionShadowRunInternal({
        ...run,
        runId: run.runId || `run_${contentHash({ jobId, payload }).slice(0, 24)}`,
        subjectType: payload.subjectType,
        subjectId: payload.subjectId,
        turnId: payload.turnId || null,
        rolloutKey: payload.rolloutKey,
        source: 'live',
        comparisonDirection: payload.comparisonDirection,
        evidenceEpoch: payload.rolloutEvidenceEpoch,
        shadowEpoch: payload.shadowEpoch,
        canaryEpoch: payload.canaryEpoch,
        canarySlot: payload.canarySlot,
        rolloutRevision: payload.rolloutRevision,
        pipelineChecksum: payload.pipelineChecksum,
        authoritativeResultChecksum: payload.authoritativeResultChecksum,
        criticalFindings,
        staleForRollout: stale,
        state: 'completed',
        createdAt: recordedAt,
        updatedAt: recordedAt
      });
      const summary = {
        ...(report.summary || {}),
        rolloutKey: payload.rolloutKey,
        jobId,
        staleForRollout: stale,
        criticalFindings
      };
      const reportId = report.reportId
        || `report_compare_${contentHash({ jobId, summary }).slice(0, 24)}`;
      const storedReport = this.putEvaluationReportInternal({
        reportId,
        reportType: shadowDirection ? 'live_shadow' : 'active_canary',
        rolloutKey: payload.rolloutKey,
        sourceType: 'comparison_run',
        sourceRef: jobId,
        artifactPath: report.artifactPath || '',
        summary,
        createdAt: recordedAt
      });
      if (!stale) {
        const critical = criticalFindings.length > 0;
        const rollback = !shadowDirection && critical;
        const nextMode = rollback ? 'shadow' : rollout.current_mode;
        const nextPhase = rollback ? 'rolled_back' : rollout.rollout_phase;
        const nextRevision = Number(rollout.revision) + 1;
        const update = this.db.prepare(`
          UPDATE cognition_kind_rollouts
          SET current_mode = ?, rollout_phase = ?, revision = ?,
              shadow_epoch = shadow_epoch + ?,
              live_shadow_first_at = CASE
                WHEN ? = 1 AND live_shadow_first_at IS NULL THEN ?
                ELSE live_shadow_first_at
              END,
              live_shadow_last_at = CASE WHEN ? = 1 THEN ? ELSE live_shadow_last_at END,
              live_shadow_success_count = live_shadow_success_count + ?,
              live_shadow_failure_count = live_shadow_failure_count + ?,
              canary_completed_count = canary_completed_count + ?,
              canary_failure_count = canary_failure_count + ?,
              last_report_id = ?, last_report_checksum = ?,
              rolled_back_at = CASE WHEN ? = 1 THEN ? ELSE rolled_back_at END,
              last_reason_code = ?, updated_at = ?
          WHERE rollout_key = ? AND revision = ?
        `).run(
          nextMode, nextPhase, nextRevision,
          rollback ? 1 : 0,
          shadowDirection ? 1 : 0, Number(recordedAt),
          shadowDirection ? 1 : 0, Number(recordedAt),
          shadowDirection && !critical ? 1 : 0,
          shadowDirection && critical ? 1 : 0,
          !shadowDirection && !critical ? 1 : 0,
          !shadowDirection && critical ? 1 : 0,
          reportId, storedReport.artifactChecksum,
          rollback ? 1 : 0, Number(recordedAt),
          rollback ? criticalFindings[0]?.code || 'ACTIVE_PRECOMMIT_CRITICAL' : 'comparison_recorded',
          Number(recordedAt), payload.rolloutKey, Number(rollout.revision)
        );
        if (Number(update.changes) !== 1) throw new RolloutRevisionConflictError();
        if (rollback) {
          this.appendPromotionHistoryInternal({
            eventId: `promotion_${contentHash({ jobId, reportId, recordedAt }).slice(0, 24)}`,
            rolloutKey: payload.rolloutKey,
            fromMode: rollout.current_mode,
            toMode: 'shadow',
            fromPhase: rollout.rollout_phase,
            toPhase: 'rolled_back',
            fromRevision: Number(rollout.revision),
            toRevision: nextRevision,
            actor: 'comparison_evaluator',
            reasonCode: criticalFindings[0]?.code || 'ACTIVE_PRECOMMIT_CRITICAL',
            reportId,
            reportChecksum: storedReport.artifactChecksum,
            metadata: { jobId },
            createdAt: recordedAt
          });
        }
      }
      this.db.prepare(`
        UPDATE consolidation_jobs
        SET state = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ?
      `).run(Number(recordedAt), jobId, workerId);
      return {
        run: this.getCognitionShadowRun(run.runId || `run_${contentHash({ jobId, payload }).slice(0, 24)}`),
        report: this.getEvaluationReport(reportId),
        rollout: this.getCognitionRollout(payload.rolloutKey),
        staleForRollout: stale
      };
    });
  }

  listLiveShadowRuns({ rolloutKey, direction, since = 0 }) {
    return this.db.prepare(`
      SELECT * FROM cognition_shadow_runs
      WHERE rollout_key = ? AND comparison_direction = ? AND created_at >= ?
      ORDER BY created_at, run_id
    `).all(rolloutKey, direction, Number(since)).map(mapShadowRun);
  }

  countOutstandingComparisonSubjects(input, options = {}) {
    const rolloutKey = typeof input === 'string' ? input : input.rolloutKey;
    const direction = typeof input === 'string' ? null : input.direction;
    const evidenceEpoch = typeof input === 'string' ? null : input.evidenceEpoch;
    const shadowEpoch = typeof input === 'string' ? null : input.shadowEpoch ?? null;
    const canaryEpoch = typeof input === 'string'
      ? options.canaryEpoch ?? null
      : input.canaryEpoch ?? null;
    const at = typeof input === 'string' ? now() : input.now ?? now();
    const runs = this.db.prepare(`
      SELECT subject_type, subject_id, state, created_at
      FROM cognition_shadow_runs
      WHERE rollout_key = ?
        AND (? IS NULL OR comparison_direction = ?)
        AND (? IS NULL OR evidence_epoch = ?)
        AND (? IS NULL OR shadow_epoch = ?)
        AND (? IS NULL OR canary_epoch = ?)
        AND stale_for_rollout = 0
    `).all(
      rolloutKey, direction, direction,
      evidenceEpoch, evidenceEpoch,
      shadowEpoch, shadowEpoch, canaryEpoch, canaryEpoch
    );
    const subjects = new Map();
    for (const run of runs.filter(run => !['completed', 'failed', 'cancelled'].includes(run.state))) {
      subjects.set(`${run.subject_type}:${run.subject_id}`, Number(run.created_at));
    }
    const turns = this.db.prepare(`
      SELECT turn_id, created_at FROM turns
      WHERE rollout_key = ? AND comparison_mode != 'none'
        AND (? IS NULL OR canary_epoch = ?)
        AND state NOT IN ('completed', 'fallback', 'failed')
    `).all(rolloutKey, canaryEpoch, canaryEpoch);
    for (const turn of turns) {
      const key = `turn:${turn.turn_id}`;
      if (!subjects.has(key)) subjects.set(key, Number(turn.created_at));
    }
    const jobs = this.db.prepare(`
      SELECT subject_type, subject_id, created_at FROM consolidation_jobs
      WHERE state IN ('queued', 'running', 'retry_wait')
        AND job_type IN ('shadow_cognition', 'active_canary_compare')
        AND (state != 'running' OR COALESCE(lease_expires_at, ?) > ?)
    `).all(Number(at), Number(at));
    for (const job of jobs) {
      const key = `${job.subject_type}:${job.subject_id}`;
      if (!subjects.has(key)) subjects.set(key, Number(job.created_at));
    }
    const values = [...subjects.values()];
    const result = {
      count: subjects.size,
      oldestAt: values.length ? Math.min(...values) : null
    };
    return typeof input === 'string' ? result : result.count;
  }

  createReplayBatch(batch) {
    this.db.prepare(`
      INSERT INTO cognition_replay_batches(
        run_id, dataset_id, dataset_checksum, preset_version,
        model_profile_checksum, source_type, state, requested_concurrency, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO NOTHING
    `).run(
      batch.runId, batch.datasetId, batch.datasetChecksum, batch.presetVersion,
      batch.modelProfileChecksum, batch.sourceType, batch.state || 'running',
      Number(batch.requestedConcurrency || 1), Number(batch.startedAt || now())
    );
    return this.getReplayBatch(batch.runId);
  }

  getReplayBatch(runId) {
    const row = this.db.prepare(
      'SELECT * FROM cognition_replay_batches WHERE run_id = ?'
    ).get(String(runId));
    if (!row) return null;
    return {
      runId: row.run_id,
      datasetId: row.dataset_id,
      datasetChecksum: row.dataset_checksum,
      presetVersion: row.preset_version,
      modelProfileChecksum: row.model_profile_checksum,
      sourceType: row.source_type,
      state: row.state,
      requestedConcurrency: Number(row.requested_concurrency),
      startedAt: row.started_at,
      completedAt: row.completed_at ?? null,
      artifactPath: row.artifact_path || null,
      artifactChecksum: row.artifact_checksum || null
    };
  }

  putReplayRun(run) {
    const timestamp = Number(run.updatedAt || now());
    this.db.prepare(`
      INSERT INTO cognition_replay_runs(
        run_id, case_id, rollout_key, source_type, input_checksum,
        legacy_result_checksum, cognition_result_checksum, metrics_json,
        critical_findings_json, state, attempt_count, latency_ms, error_code,
        source_deleted_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, case_id) DO UPDATE SET
        legacy_result_checksum = excluded.legacy_result_checksum,
        cognition_result_checksum = excluded.cognition_result_checksum,
        metrics_json = excluded.metrics_json,
        critical_findings_json = excluded.critical_findings_json,
        state = excluded.state,
        attempt_count = excluded.attempt_count,
        latency_ms = excluded.latency_ms,
        error_code = excluded.error_code,
        source_deleted_at = excluded.source_deleted_at,
        updated_at = excluded.updated_at
    `).run(
      run.runId, run.caseId, run.rolloutKey, run.sourceType, run.inputChecksum,
      run.legacyResultChecksum || null, run.cognitionResultChecksum || null,
      canonicalJson(run.metrics || {}), canonicalJson(run.criticalFindings || []),
      run.state, Number(run.attemptCount || 0), run.latencyMs ?? null,
      run.errorCode || null, run.sourceDeletedAt ?? null,
      Number(run.createdAt || timestamp), timestamp
    );
    return this.getReplayRun(run.runId, run.caseId);
  }

  getReplayRun(runId, caseId) {
    const row = this.db.prepare(`
      SELECT * FROM cognition_replay_runs WHERE run_id = ? AND case_id = ?
    `).get(String(runId), String(caseId));
    if (!row) return null;
    return {
      runId: row.run_id,
      caseId: row.case_id,
      rolloutKey: row.rollout_key,
      sourceType: row.source_type,
      inputChecksum: row.input_checksum,
      legacyResultChecksum: row.legacy_result_checksum || null,
      cognitionResultChecksum: row.cognition_result_checksum || null,
      metrics: parseJson(row.metrics_json, {}),
      criticalFindings: parseJson(row.critical_findings_json, []),
      state: row.state,
      attemptCount: Number(row.attempt_count),
      latencyMs: row.latency_ms ?? null,
      errorCode: row.error_code || null,
      sourceDeletedAt: row.source_deleted_at ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  listReplayRuns(runId) {
    return this.db.prepare(`
      SELECT case_id FROM cognition_replay_runs WHERE run_id = ? ORDER BY case_id
    `).all(String(runId)).map(row => this.getReplayRun(runId, row.case_id));
  }

  listReplayEligibleTurns({ rolloutKey = 'DIRECT_REPLY', limit = 30, beforeTurnId = null } = {}) {
    const before = beforeTurnId
      ? this.db.prepare('SELECT created_at FROM turns WHERE turn_id = ?').get(String(beforeTurnId))?.created_at
      : null;
    return this.db.prepare(`
      SELECT * FROM turns
      WHERE COALESCE(rollout_key, json_extract(envelope_json, '$.kind')) = ?
        AND state IN ('committed', 'delivered', 'completed')
        AND (? IS NULL OR created_at < ?)
      ORDER BY created_at DESC, turn_id DESC
      LIMIT ?
    `).all(String(rolloutKey), before ?? null, before ?? null, Math.max(1, Number(limit) || 30))
      .map(mapTurn);
  }

  completeReplayBatch({ runId, state = 'completed', artifactPath = null, artifactChecksum = null, now: completedAt = now() }) {
    const result = this.db.prepare(`
      UPDATE cognition_replay_batches
      SET state = ?, completed_at = ?, artifact_path = ?, artifact_checksum = ?
      WHERE run_id = ?
    `).run(state, Number(completedAt), artifactPath, artifactChecksum, String(runId));
    if (Number(result.changes) !== 1) throw new Error('replay batch not found');
    return this.getReplayBatch(runId);
  }

  advanceConsolidationBackfillCursor(cursor) {
    const roleId = String(cursor?.roleId || '');
    if (!roleId) throw new Error('roleId is required');
    this.db.prepare(`
      INSERT INTO consolidation_backfill_cursors(
        role_id, last_completed_group_key, last_checksum, updated_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        last_completed_group_key = excluded.last_completed_group_key,
        last_checksum = excluded.last_checksum,
        updated_at = excluded.updated_at
    `).run(
      roleId,
      cursor.lastCompletedGroupKey || null,
      cursor.lastChecksum || null,
      Number(cursor.updatedAt || now())
    );
    return {
      roleId,
      lastCompletedGroupKey: cursor.lastCompletedGroupKey || null,
      lastChecksum: cursor.lastChecksum || null,
      updatedAt: Number(cursor.updatedAt || now())
    };
  }
}
