import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { resolveCurrentUserBatch } from './current-user-batch.mjs';
import { decideLaneAdmission, laneKeyForEnvelope } from './interaction-lanes.mjs';
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

const BASELINE_STABLE_RELEASE = Object.freeze({
  releaseId: 'release_baseline_78a4b362be0dd02d42ba8ad7',
  pipelineVersion: 'stable-visible-baseline-2026-07-30',
  presetVersion: '1.9.2',
  cognitionSchemaVersion: 1,
  expressionSchemaVersion: 1,
  evaluatorVersion: 'legacy-supervisor-v1',
  modelProfile: { source: 'baseline-audit', checksum: '040a2584c1c96c99fae21a791cc303436367f149bf432e7a91450bdb49a047d2' },
  componentManifest: {
    kind: 'synthetic_immutable_visible_baseline',
    auditGitHead: '317302d220fc67984ee8769206d8480a976865d9'
  },
  releaseChecksum: '78a4b362be0dd02d42ba8ad776b040c179d6ebcebdafc6193bf2449ab774e0a0',
  createdAt: 1785406322867,
  retiredAt: null
});

const BASELINE_V2_CANDIDATE_MANIFEST = Object.freeze({
  kind: 'synthetic_existing_cognition_v2_candidate',
  presetVersion: '2.0.0',
  baseReleaseId: BASELINE_STABLE_RELEASE.releaseId,
  schemaVersion: 2
});

const BASELINE_V2_CANDIDATE_CHECKSUM = contentHash(BASELINE_V2_CANDIDATE_MANIFEST);
const BASELINE_V2_CANDIDATE_RELEASE = Object.freeze({
  releaseId: `release_cognition_v2_${BASELINE_V2_CANDIDATE_CHECKSUM.slice(0, 24)}`,
  pipelineVersion: 'cognition-v2-candidate-2026-07-30',
  presetVersion: '2.0.0',
  cognitionSchemaVersion: 2,
  expressionSchemaVersion: 2,
  evaluatorVersion: 'supervisor-v2',
  modelProfile: { source: 'existing-v2-candidate' },
  componentManifest: BASELINE_V2_CANDIDATE_MANIFEST,
  releaseChecksum: BASELINE_V2_CANDIDATE_CHECKSUM,
  createdAt: 1785406322867,
  retiredAt: null
});

function now() {
  return Date.now();
}

function authorityLengthPrefix(value) {
  const text = String(value ?? '');
  return `${Buffer.byteLength(text, 'utf8')}:${text}`;
}

function authorityHash(namespace, values) {
  const hash = createHash('sha256');
  hash.update(`${namespace}\0`, 'utf8');
  for (const value of values) hash.update(authorityLengthPrefix(value), 'utf8');
  return hash.digest('hex');
}

export function deriveAuthorityLineageKey({ roleId, laneKey, rootSourceId }) {
  return `lin_${authorityHash('al-turn-lineage-v1', [roleId, laneKey, rootSourceId])}`;
}

export function deriveVisibleGroupId(lineageKey) {
  return `grp_${authorityHash('al-visible-group-v1', [lineageKey])}`;
}

export function deriveVisibleMessageId(groupId, ordinal) {
  return `msg_${authorityHash('al-visible-message-v1', [groupId, String(ordinal)])}`;
}

export function deriveVisibleActionId(groupId, ordinal) {
  return `act_${authorityHash('al-visible-action-v1', [groupId, String(ordinal)])}`;
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
    authoritativeReleaseId: row.authoritative_release_id || null,
    comparisonReleaseId: row.comparison_release_id || null,
    authoritativePipelineChecksum: row.authoritative_pipeline_checksum || null,
    comparisonPipelineChecksum: row.comparison_pipeline_checksum || null,
    laneKey: row.lane_key || null,
    laneRevision: row.lane_revision ?? null,
    inputVisibilitySequence: row.input_visibility_sequence ?? null,
    generationFingerprint: row.generation_fingerprint || null,
    resultAuthorityVersion: Number(row.result_authority_version || 0),
    authorityLineageKey: row.authority_lineage_key || null,
    lineageRevisionAtCreation: row.lineage_revision_at_creation ?? null,
    turnRevision: Number(row.turn_revision || 0),
    retryOfTurnId: row.retry_of_turn_id || null,
    inputUserBatchId: row.input_user_batch_id || null,
    agencySnapshotChecksum: row.agency_snapshot_checksum || null,
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
    stableReleaseId: row.stable_release_id || null,
    candidateReleaseId: row.candidate_release_id || null,
    candidatePhase: row.candidate_phase || null,
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

function mapAuthorityLineage(row) {
  if (!row) return null;
  return {
    lineageKey: row.lineage_key,
    roleId: row.role_id,
    laneKey: row.lane_key,
    rootSourceId: row.root_source_id,
    latestTurnId: row.latest_turn_id,
    revision: Number(row.revision),
    state: row.state,
    committedGroupId: row.committed_group_id || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapVisibleCommitReceipt(row) {
  if (!row) return null;
  return {
    authorityLineageKey: row.lineage_key,
    visibleGroupId: row.group_id,
    authoritativeTurnId: row.authoritative_turn_id,
    authorityOrigin: row.authority_origin,
    commitPayloadVersion: row.commit_payload_version,
    turnRevisionBefore: Number(row.turn_revision_before),
    turnRevisionAfter: Number(row.turn_revision_after),
    lineageRevisionBefore: Number(row.lineage_revision_before),
    lineageRevisionAfter: Number(row.lineage_revision_after),
    laneRevisionBefore: row.lane_revision_before ?? null,
    laneRevisionAfter: row.lane_revision_after ?? null,
    cognitiveStateRevisionBefore: row.cognitive_state_revision_before ?? null,
    cognitiveStateRevisionAfter: row.cognitive_state_revision_after ?? null,
    commitChecksum: row.commit_checksum,
    committedAt: Number(row.committed_at)
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
    lastAuthorityGroupId: row.last_authority_group_id || null,
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
    authorityGroupId: row.authority_group_id || null,
    authorityOrdinal: row.authority_ordinal ?? null,
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
    authoritativeReleaseId: row.authoritative_release_id || null,
    comparisonReleaseId: row.comparison_release_id || null,
    authoritativePipelineChecksum: row.authoritative_pipeline_checksum || null,
    comparisonPipelineChecksum: row.comparison_pipeline_checksum || null,
    laneKey: row.lane_key || null,
    laneRevision: row.lane_revision ?? null,
    inputVisibilitySequence: row.input_visibility_sequence ?? null,
    generationFingerprint: row.generation_fingerprint || null,
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
    confirmedAt: row.confirmed_at ?? null,
    authorityGroupId: row.authority_group_id || null,
    authorityCommitChecksum: row.authority_commit_checksum || null
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

function mapLifePlanningAttempt(row) {
  if (!row) return null;
  return {
    planningId: row.planning_id,
    requestBaseKey: row.request_base_key,
    requestKey: row.request_key,
    roleId: row.role_id,
    planningRevision: Number(row.planning_revision),
    planningWindowStartAt: Number(row.planning_window_start_at),
    planningWindowEndAt: Number(row.planning_window_end_at),
    lifeBasisChecksum: row.life_basis_checksum,
    contextChecksum: row.context_checksum,
    rolloutKey: row.rollout_key,
    pipelineMode: row.pipeline_mode,
    comparisonMode: row.comparison_mode,
    authoritativePipeline: row.authoritative_pipeline,
    comparisonDirection: row.comparison_direction || null,
    rolloutRevision: Number(row.rollout_revision),
    rolloutEvidenceEpoch: Number(row.rollout_evidence_epoch),
    pipelineChecksum: row.pipeline_checksum,
    shadowEpoch: row.shadow_epoch ?? null,
    canaryEpoch: row.canary_epoch ?? null,
    canarySlot: row.canary_slot ?? null,
    authoritativeReleaseId: row.authoritative_release_id || null,
    comparisonReleaseId: row.comparison_release_id || null,
    authoritativePipelineChecksum: row.authoritative_pipeline_checksum || null,
    comparisonPipelineChecksum: row.comparison_pipeline_checksum || null,
    laneKey: row.lane_key || null,
    laneRevision: row.lane_revision ?? null,
    inputVisibilitySequence: row.input_visibility_sequence ?? null,
    generationFingerprint: row.generation_fingerprint || null,
    presetVersion: row.preset_version,
    inputSnapshot: parseJson(row.input_snapshot_json, {}),
    inputChecksum: row.input_checksum,
    executionState: row.execution_state,
    comparisonState: row.comparison_state,
    authoritativeResult: parseJson(row.authoritative_result_json, null),
    authoritativeResultChecksum: row.authoritative_result_checksum || null,
    compareJobId: row.compare_job_id || null,
    attemptCount: Number(row.attempt_count),
    dueAt: Number(row.due_at),
    leaseOwner: row.lease_owner || null,
    leaseExpiresAt: row.lease_expires_at ?? null,
    lastErrorCode: row.last_error_code || null,
    resultCommittedAt: row.result_committed_at ?? null,
    completedAt: row.completed_at ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapPipelineRelease(row) {
  if (!row) return null;
  return {
    releaseId: row.release_id,
    pipelineVersion: row.pipeline_version,
    presetVersion: row.preset_version,
    cognitionSchemaVersion: Number(row.cognition_schema_version),
    expressionSchemaVersion: Number(row.expression_schema_version),
    evaluatorVersion: row.evaluator_version,
    modelProfile: parseJson(row.model_profile_json, {}),
    componentManifest: parseJson(row.component_manifest_json, {}),
    releaseChecksum: row.release_checksum,
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at ?? null
  };
}

function mapConstraintRecord(row) {
  if (!row) return null;
  return {
    constraintId: row.constraint_id,
    revision: Number(row.revision),
    roleId: row.role_id,
    authority: row.authority,
    kind: row.kind,
    subject: row.subject,
    scope: parseJson(row.scope_json, {}),
    rule: row.rule_text,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    sourceConfigRef: row.source_config_ref || null,
    releaseCondition: row.release_condition || null,
    status: row.status,
    supersedes: row.supersedes || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function mapStanceRecord(row) {
  if (!row) return null;
  return {
    stanceId: row.stance_id,
    revision: Number(row.revision),
    roleId: row.role_id,
    topic: row.topic,
    position: row.position_text,
    reason: row.reason_text,
    strength: Number(row.strength),
    flexibility: Number(row.flexibility),
    sourceTurnId: row.source_turn_id,
    sourceMessageIds: parseJson(row.source_message_ids_json, []),
    createdAt: Number(row.created_at),
    lastConfirmedAt: Number(row.last_confirmed_at),
    expiresAt: row.expires_at ?? null,
    remainingRelevantUserBatches: Number(row.remaining_relevant_user_batches),
    status: row.status,
    supersedes: row.supersedes || null,
    authorityGroupId: row.authority_group_id || null,
    authorityOrdinal: row.authority_ordinal ?? null
  };
}

function mapInteractionLane(row) {
  if (!row) return null;
  return {
    roleId: row.role_id,
    laneKey: row.lane_key,
    revision: Number(row.revision),
    generatingTurnId: row.generating_turn_id || null,
    latestUserBatchId: row.latest_user_batch_id || null,
    latestAuthoritativeGroupId: row.latest_authoritative_group_id || null,
    nativeCompletedGroupId: row.native_completed_group_id || null,
    nativeCompletedSequence: Number(row.native_completed_sequence),
    uiAppliedGroupId: row.ui_applied_group_id || null,
    uiAppliedSequence: Number(row.ui_applied_sequence),
    localSequence: Number(row.local_sequence),
    lastCommitChecksum: row.last_commit_checksum || null,
    updatedAt: Number(row.updated_at)
  };
}

export class LifePlanningResultConflictError extends Error {
  constructor(message = 'life planning authoritative result conflict') {
    super(message);
    this.name = 'LifePlanningResultConflictError';
  }
}

export class YuqiStore {
  constructor(filename, migrationOptions = null) {
    if (!filename) throw new Error('database filename is required');
    this.filename = filename;
    this.db = new DatabaseSync(filename);
    this.closed = false;
    this.migrationOptions = migrationOptions;
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    try {
      this.migrate();
    } catch (error) {
      this.closed = true;
      try { this.db.close(); } catch {}
      throw error;
    }
  }

  static openForMigration(filename, {
    expectedSourceVersion,
    expectedPostMigrationInvariantChecksum
  } = {}) {
    if (!Number.isInteger(Number(expectedSourceVersion))) {
      throw new Error('migration expected source version is required');
    }
    if (!/^[a-f0-9]{64}$/i.test(String(expectedPostMigrationInvariantChecksum || ''))) {
      throw new Error('migration expected post-migration invariant checksum is required');
    }
    return new YuqiStore(filename, {
      expectedSourceVersion: Number(expectedSourceVersion),
      expectedPostMigrationInvariantChecksum: String(expectedPostMigrationInvariantChecksum)
    });
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
    const initialVersion = this.userVersion();
    if (this.migrationOptions
      && initialVersion !== this.migrationOptions.expectedSourceVersion) {
      throw new Error(
        `migration source version mismatch: expected ${this.migrationOptions.expectedSourceVersion}, got ${initialVersion}`
      );
    }
    if (initialVersion > 12) {
      throw new Error(`unsupported database user_version ${initialVersion}`);
    }
    if (initialVersion === 12) {
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV12Invariants();
      this.assertExpectedPostMigrationInvariantChecksum();
      return;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (initialVersion < 9) {
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

      CREATE TABLE IF NOT EXISTS cognition_life_planning_attempts (
        planning_id TEXT PRIMARY KEY,
        request_base_key TEXT NOT NULL,
        request_key TEXT NOT NULL UNIQUE,
        role_id TEXT NOT NULL,
        planning_revision INTEGER NOT NULL,
        planning_window_start_at INTEGER NOT NULL,
        planning_window_end_at INTEGER NOT NULL,
        life_basis_checksum TEXT NOT NULL,
        context_checksum TEXT NOT NULL,
        rollout_key TEXT NOT NULL DEFAULT 'LIFE_PLANNING',
        pipeline_mode TEXT NOT NULL,
        comparison_mode TEXT NOT NULL,
        authoritative_pipeline TEXT NOT NULL,
        comparison_direction TEXT,
        rollout_revision INTEGER NOT NULL,
        rollout_evidence_epoch INTEGER NOT NULL,
        pipeline_checksum TEXT NOT NULL,
        shadow_epoch INTEGER,
        canary_epoch INTEGER,
        canary_slot INTEGER,
        preset_version TEXT NOT NULL,
        input_snapshot_json TEXT NOT NULL,
        input_checksum TEXT NOT NULL,
        execution_state TEXT NOT NULL,
        comparison_state TEXT NOT NULL,
        authoritative_result_json TEXT,
        authoritative_result_checksum TEXT,
        compare_job_id TEXT UNIQUE,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        due_at INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        last_error_code TEXT,
        result_committed_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(role_id, planning_revision),
        CHECK(pipeline_mode IN ('legacy', 'shadow', 'active')),
        CHECK(comparison_mode IN ('none', 'cognition_compare', 'legacy_compare')),
        CHECK(authoritative_pipeline IN ('legacy', 'cognition')),
        CHECK(execution_state IN (
          'created', 'running', 'retry_wait', 'result_committed', 'completed', 'failed', 'cancelled'
        )),
        CHECK(comparison_state IN (
          'not_ready', 'not_applicable', 'queued', 'running', 'completed', 'failed', 'cancelled'
        ))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_planning_canary_slot
        ON cognition_life_planning_attempts(rollout_key, canary_epoch, canary_slot)
        WHERE canary_slot IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_life_planning_request_base
        ON cognition_life_planning_attempts(request_base_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_life_planning_one_open_per_role
        ON cognition_life_planning_attempts(role_id)
        WHERE execution_state IN ('created', 'running', 'retry_wait', 'result_committed');
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
        this.db.exec('PRAGMA user_version = 9;');
      }
      if (initialVersion < 10) {
        this.migrateAgencyV10Internal();
        this.assertAgencyV10Invariants({ allowVersionNine: true });
        this.db.exec('PRAGMA user_version = 10;');
      }
      if (initialVersion < 11) {
        this.migrateVisibleAuthorityV11Internal();
        this.assertAgencyV10Invariants({ allowPreFinalVersion: true });
        this.assertVisibleAuthorityV11Invariants({ allowVersionTen: true });
        this.db.exec('PRAGMA user_version = 11;');
      }
      if (initialVersion < 12) {
        this.migrateVisibleAuthorityV12Internal();
      }
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV12Invariants();
      this.assertExpectedPostMigrationInvariantChecksum();
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  assertExpectedPostMigrationInvariantChecksum() {
    const expected = this.migrationOptions?.expectedPostMigrationInvariantChecksum;
    if (!expected) return;
    const actual = this.visibleAuthorityV11InvariantSummary().checksum;
    if (actual !== expected) {
      throw new Error(
        `migration post-migration invariant checksum mismatch: expected ${expected}, got ${actual}`
      );
    }
  }

  userVersion() {
    return Number(this.db.prepare('PRAGMA user_version').get()?.user_version || 0);
  }

  addColumnIfMissing(table, column, definition) {
    const columns = new Set(this.db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
    if (!columns.has(column)) {
      this.db.exec(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition};`);
    }
  }

  migrateAgencyV10Internal() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pipeline_releases (
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

      CREATE TABLE IF NOT EXISTS constraint_records (
        constraint_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        role_id TEXT NOT NULL,
        authority TEXT NOT NULL CHECK(authority IN ('system','author','user')),
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        scope_json TEXT NOT NULL,
        rule_text TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        source_config_ref TEXT,
        release_condition TEXT,
        status TEXT NOT NULL CHECK(status IN ('active','released','archived')),
        supersedes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(constraint_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_constraint_records_role_status
        ON constraint_records(role_id, status, constraint_id, revision);

      CREATE TABLE IF NOT EXISTS stance_records (
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
        expires_at INTEGER,
        remaining_relevant_user_batches INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','expired','superseded')),
        supersedes TEXT,
        PRIMARY KEY(stance_id, revision)
      );
      CREATE INDEX IF NOT EXISTS idx_stance_records_role_status
        ON stance_records(role_id, status, stance_id, revision);

      CREATE TABLE IF NOT EXISTS interaction_lanes (
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

      CREATE TABLE IF NOT EXISTS quality_eval_runs (
        eval_run_id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        baseline_release_id TEXT NOT NULL,
        suite_version TEXT NOT NULL,
        source_type TEXT NOT NULL,
        state TEXT NOT NULL,
        manifest_checksum TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        artifact_path TEXT NOT NULL,
        artifact_checksum TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS quality_findings (
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

      CREATE TABLE IF NOT EXISTS state_migration_audit (
        audit_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        classification TEXT NOT NULL,
        target_id TEXT,
        reason_code TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(role_id, source_type, source_id)
      );
    `);

    for (const [column, definition] of Object.entries({
      stable_release_id: 'TEXT',
      candidate_release_id: 'TEXT',
      candidate_phase: 'TEXT'
    })) {
      this.addColumnIfMissing('cognition_kind_rollouts', column, definition);
    }
    const pinColumns = {
      authoritative_release_id: 'TEXT',
      comparison_release_id: 'TEXT',
      authoritative_pipeline_checksum: 'TEXT',
      comparison_pipeline_checksum: 'TEXT',
      lane_key: 'TEXT',
      lane_revision: 'INTEGER',
      input_visibility_sequence: 'INTEGER',
      generation_fingerprint: 'TEXT'
    };
    for (const table of ['turns', 'cognition_life_planning_attempts']) {
      for (const [column, definition] of Object.entries(pinColumns)) {
        this.addColumnIfMissing(table, column, definition);
      }
    }

    this.putPipelineReleaseInternal(BASELINE_STABLE_RELEASE);
    this.putPipelineReleaseInternal(BASELINE_V2_CANDIDATE_RELEASE);
    this.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET stable_release_id = COALESCE(stable_release_id, ?),
          candidate_release_id = COALESCE(candidate_release_id, ?),
          candidate_phase = COALESCE(candidate_phase, 'none')
    `).run(
      BASELINE_STABLE_RELEASE.releaseId,
      BASELINE_V2_CANDIDATE_RELEASE.releaseId
    );
  }

  migrateVisibleAuthorityV11Internal() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turn_authority_lineages (
        lineage_key TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        root_source_id TEXT NOT NULL,
        latest_turn_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision >= 1),
        state TEXT NOT NULL CHECK(state IN ('open','committed','cancelled')),
        committed_group_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(role_id, lane_key, root_source_id),
        CHECK(
          (state = 'committed' AND committed_group_id IS NOT NULL)
          OR (state IN ('open','cancelled') AND committed_group_id IS NULL)
        )
      );

      CREATE TABLE IF NOT EXISTS visible_result_groups (
        group_id TEXT PRIMARY KEY,
        lineage_key TEXT NOT NULL UNIQUE,
        authoritative_turn_id TEXT NOT NULL UNIQUE,
        role_id TEXT NOT NULL,
        lane_key TEXT NOT NULL,
        authority_origin TEXT NOT NULL CHECK(authority_origin IN ('pc','android_fallback')),
        authoritative_release_id TEXT NOT NULL,
        generation_fingerprint TEXT NOT NULL,
        reply_checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        redacted_at INTEGER,
        FOREIGN KEY(lineage_key) REFERENCES turn_authority_lineages(lineage_key),
        FOREIGN KEY(authoritative_turn_id) REFERENCES turns(turn_id)
      );

      CREATE TABLE IF NOT EXISTS visible_result_items (
        group_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        message_id TEXT NOT NULL UNIQUE,
        item_json TEXT NOT NULL,
        item_checksum TEXT NOT NULL,
        PRIMARY KEY(group_id, ordinal),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
      );

      CREATE TABLE IF NOT EXISTS visible_result_actions (
        group_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        action_id TEXT NOT NULL UNIQUE,
        action_kind TEXT NOT NULL,
        target_key TEXT NOT NULL,
        target_revision TEXT,
        action_json TEXT NOT NULL,
        action_checksum TEXT NOT NULL,
        PRIMARY KEY(group_id, ordinal),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
      );

      CREATE TABLE IF NOT EXISTS visible_commit_receipts (
        lineage_key TEXT PRIMARY KEY,
        group_id TEXT NOT NULL UNIQUE,
        authoritative_turn_id TEXT NOT NULL UNIQUE,
        authority_origin TEXT NOT NULL CHECK(authority_origin IN ('pc','android_fallback')),
        commit_payload_version TEXT NOT NULL,
        turn_revision_before INTEGER NOT NULL,
        turn_revision_after INTEGER NOT NULL,
        lineage_revision_before INTEGER NOT NULL,
        lineage_revision_after INTEGER NOT NULL,
        lane_revision_before INTEGER,
        lane_revision_after INTEGER,
        cognitive_state_revision_before INTEGER,
        cognitive_state_revision_after INTEGER,
        commit_checksum TEXT NOT NULL UNIQUE,
        committed_at INTEGER NOT NULL,
        FOREIGN KEY(lineage_key) REFERENCES turn_authority_lineages(lineage_key),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id),
        FOREIGN KEY(authoritative_turn_id) REFERENCES turns(turn_id)
      );
    `);

    const additions = {
      turns: {
        result_authority_version: 'INTEGER NOT NULL DEFAULT 0',
        authority_lineage_key: 'TEXT',
        lineage_revision_at_creation: 'INTEGER',
        turn_revision: 'INTEGER NOT NULL DEFAULT 0',
        retry_of_turn_id: 'TEXT',
        input_user_batch_id: 'TEXT',
        agency_snapshot_checksum: 'TEXT'
      },
      messages: {
        authority_group_id: 'TEXT',
        group_ordinal: 'INTEGER'
      },
      cognitive_states: {
        last_authority_group_id: 'TEXT'
      },
      stance_records: {
        authority_group_id: 'TEXT',
        authority_ordinal: 'INTEGER'
      },
      consolidation_jobs: {
        authority_group_id: 'TEXT',
        authority_ordinal: 'INTEGER'
      },
      cloud_deliveries: {
        authority_group_id: 'TEXT',
        authority_commit_checksum: 'TEXT'
      }
    };
    for (const [table, columns] of Object.entries(additions)) {
      for (const [column, definition] of Object.entries(columns)) {
        this.addColumnIfMissing(table, column, definition);
      }
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_messages_authority_group_ordinal
        ON messages(authority_group_id, group_ordinal)
        WHERE authority_group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_stances_authority_group_ordinal
        ON stance_records(authority_group_id, authority_ordinal)
        WHERE authority_group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_consolidation_authority_group_ordinal
        ON consolidation_jobs(authority_group_id, authority_ordinal)
        WHERE authority_group_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_authority_group_peer
        ON cloud_deliveries(authority_group_id, peer_id)
        WHERE authority_group_id IS NOT NULL;
    `);
  }

  migrateVisibleAuthorityV12Internal() {
    const canonicalRows = Number(this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM visible_result_groups) +
        (SELECT COUNT(*) FROM visible_commit_receipts) AS value
    `).get().value);
    if (canonicalRows !== 0) {
      throw new Error('v12 migration cannot reconstruct canonical manifest');
    }
    const tableExists = this.db.prepare(`
      SELECT 1 AS value FROM sqlite_master
      WHERE type = 'table' AND name = 'visible_result_manifests'
    `).get();
    if (tableExists) throw new Error('v12 migration found unexpected manifest table');
    this.db.exec(`
      CREATE TABLE visible_result_manifests (
        group_id TEXT PRIMARY KEY,
        authority_origin TEXT NOT NULL,
        payload_version TEXT NOT NULL,
        semantic_json TEXT,
        semantic_checksum TEXT NOT NULL UNIQUE,
        redacted_at INTEGER,
        created_at INTEGER NOT NULL,
        CHECK (
          (semantic_json IS NOT NULL AND redacted_at IS NULL)
          OR (semantic_json IS NULL AND redacted_at IS NOT NULL)
        ),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
      );
      PRAGMA user_version = 12;
    `);
  }

  assertVisibleAuthorityV11Invariants({
    allowVersionTen = false,
    allowVersionTwelve = false
  } = {}) {
    const version = this.userVersion();
    const expectedVersion = allowVersionTen ? 10 : allowVersionTwelve ? 12 : 11;
    if (version !== expectedVersion) {
      throw new Error(`v11 invariant user_version mismatch: ${version}`);
    }
    const requiredTables = [
      'turn_authority_lineages',
      'visible_result_groups',
      'visible_result_items',
      'visible_result_actions',
      'visible_commit_receipts'
    ];
    const existing = new Set(this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    const missing = requiredTables.filter(name => !existing.has(name));
    if (missing.length) throw new Error(`v11 invariant missing tables: ${missing.join(',')}`);
    const assertNoInvariantRow = (code, sql) => {
      const row = this.db.prepare(sql).get();
      if (row) throw new Error(`v11 invariant ${code}: ${JSON.stringify(row)}`);
    };

    assertNoInvariantRow('authority_version_domain', `
      SELECT turn_id, result_authority_version
      FROM turns
      WHERE result_authority_version NOT IN (0, 1)
      LIMIT 1
    `);

    assertNoInvariantRow('legacy_authority_leak', `
      SELECT t.turn_id
      FROM turns t
      WHERE t.result_authority_version = 0
        AND (
          t.authority_lineage_key IS NOT NULL
          OR t.lineage_revision_at_creation IS NOT NULL
          OR t.retry_of_turn_id IS NOT NULL
          OR t.input_user_batch_id IS NOT NULL
          OR t.agency_snapshot_checksum IS NOT NULL
          OR EXISTS (
            SELECT 1 FROM visible_result_groups g
            WHERE g.authoritative_turn_id = t.turn_id
          )
          OR EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.authoritative_turn_id = t.turn_id
          )
        )
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_turn_shape', `
      SELECT t.turn_id
      FROM turns t
      WHERE t.result_authority_version = 1
        AND (
          t.authority_lineage_key IS NULL
          OR t.turn_revision < 1
          OR t.lineage_revision_at_creation < 1
          OR t.input_user_batch_id IS NULL
          OR t.authoritative_release_id IS NULL
          OR t.lane_key IS NULL
          OR t.agency_snapshot_checksum IS NULL
        )
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_turn_lineage_join', `
      SELECT t.turn_id, t.authority_lineage_key
      FROM turns t
      LEFT JOIN turn_authority_lineages l
        ON l.lineage_key = t.authority_lineage_key
      WHERE t.result_authority_version = 1
        AND (
          l.lineage_key IS NULL
          OR l.role_id IS NOT t.character_id
          OR l.lane_key IS NOT t.lane_key
          OR l.root_source_id IS NOT t.source_message_id
        )
      LIMIT 1
    `);

    if (existing.has('current_user_batches')) {
      assertNoInvariantRow('canonical_input_batch_join', `
        SELECT t.turn_id, t.input_user_batch_id, b.batch_id
        FROM turns t
        LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
        WHERE t.result_authority_version = 1
          AND json_type(t.envelope_json, '$.message') IS NOT NULL
          AND (b.turn_id IS NULL OR b.batch_id IS NOT t.input_user_batch_id)
        LIMIT 1
      `);
    } else {
      assertNoInvariantRow('canonical_input_batch_table', `
        SELECT turn_id FROM turns WHERE result_authority_version = 1 LIMIT 1
      `);
    }

    assertNoInvariantRow('canonical_release_join', `
      SELECT t.turn_id, t.authoritative_release_id, t.comparison_release_id
      FROM turns t
      LEFT JOIN pipeline_releases a ON a.release_id = t.authoritative_release_id
      LEFT JOIN pipeline_releases c ON c.release_id = t.comparison_release_id
      WHERE t.result_authority_version = 1
        AND (
          a.release_id IS NULL
          OR a.release_checksum IS NOT t.authoritative_pipeline_checksum
          OR (t.comparison_release_id IS NULL AND t.comparison_pipeline_checksum IS NOT NULL)
          OR (t.comparison_release_id IS NOT NULL AND (
            c.release_id IS NULL
            OR c.release_checksum IS NOT t.comparison_pipeline_checksum
          ))
        )
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_retry_parent_join', `
      SELECT t.turn_id, t.retry_of_turn_id
      FROM turns t
      LEFT JOIN turns p ON p.turn_id = t.retry_of_turn_id
      WHERE t.result_authority_version = 1
        AND t.retry_of_turn_id IS NOT NULL
        AND (
          p.turn_id IS NULL
          OR p.result_authority_version != 1
          OR p.authority_lineage_key IS NOT t.authority_lineage_key
        )
      LIMIT 1
    `);

    assertNoInvariantRow('lineage_latest_owner', `
      SELECT l.lineage_key, l.latest_turn_id
      FROM turn_authority_lineages l
      LEFT JOIN turns t ON t.turn_id = l.latest_turn_id
      WHERE t.turn_id IS NULL
        OR t.result_authority_version != 1
        OR t.authority_lineage_key IS NOT l.lineage_key
        OR t.character_id IS NOT l.role_id
        OR t.lane_key IS NOT l.lane_key
        OR t.source_message_id IS NOT l.root_source_id
      LIMIT 1
    `);

    assertNoInvariantRow('noncommitted_has_result', `
      SELECT l.lineage_key, l.state
      FROM turn_authority_lineages l
      WHERE l.state IN ('open', 'cancelled')
        AND (
          l.committed_group_id IS NOT NULL
          OR EXISTS (SELECT 1 FROM visible_result_groups g WHERE g.lineage_key = l.lineage_key)
          OR EXISTS (SELECT 1 FROM visible_commit_receipts r WHERE r.lineage_key = l.lineage_key)
        )
      LIMIT 1
    `);

    assertNoInvariantRow('committed_join', `
      SELECT l.lineage_key, l.committed_group_id
      FROM turn_authority_lineages l
      LEFT JOIN visible_result_groups g
        ON g.lineage_key = l.lineage_key
       AND g.group_id = l.committed_group_id
      LEFT JOIN visible_commit_receipts r
        ON r.lineage_key = l.lineage_key
       AND r.group_id = l.committed_group_id
      LEFT JOIN turns t
        ON t.turn_id = r.authoritative_turn_id
      WHERE l.state = 'committed'
        AND (
          g.group_id IS NULL
          OR r.group_id IS NULL
          OR t.turn_id IS NULL
          OR g.authoritative_turn_id IS NOT r.authoritative_turn_id
          OR g.authoritative_turn_id IS NOT l.latest_turn_id
          OR t.authority_lineage_key IS NOT l.lineage_key
          OR g.role_id IS NOT l.role_id
          OR g.lane_key IS NOT l.lane_key
          OR g.authoritative_release_id IS NOT t.authoritative_release_id
          OR g.authority_origin IS NOT r.authority_origin
        )
      LIMIT 1
    `);

    assertNoInvariantRow('orphan_group_or_receipt', `
      SELECT COALESCE(g.group_id, r.group_id) AS group_id
      FROM visible_result_groups g
      LEFT JOIN visible_commit_receipts r
        ON r.group_id = g.group_id
       AND r.lineage_key = g.lineage_key
       AND r.authoritative_turn_id = g.authoritative_turn_id
      LEFT JOIN turn_authority_lineages l
        ON l.lineage_key = g.lineage_key
      WHERE r.group_id IS NULL OR l.lineage_key IS NULL OR l.state != 'committed'
      UNION ALL
      SELECT r.group_id
      FROM visible_commit_receipts r
      LEFT JOIN visible_result_groups g ON g.group_id = r.group_id
      LEFT JOIN turn_authority_lineages l ON l.lineage_key = r.lineage_key
      WHERE g.group_id IS NULL OR l.lineage_key IS NULL OR l.state != 'committed'
      LIMIT 1
    `);

    assertNoInvariantRow('receipt_payload_origin', `
      SELECT lineage_key, authority_origin, commit_payload_version
      FROM visible_commit_receipts
      WHERE (authority_origin = 'pc' AND commit_payload_version != 'pc-visible-commit-v1')
         OR (authority_origin = 'android_fallback'
             AND commit_payload_version != 'android-fallback-commit-v1')
      LIMIT 1
    `);

    assertNoInvariantRow('fingerprint_authority', `
      SELECT t.turn_id, l.state, t.generation_fingerprint, g.generation_fingerprint AS group_fingerprint
      FROM turns t
      JOIN turn_authority_lineages l ON l.lineage_key = t.authority_lineage_key
      LEFT JOIN visible_result_groups g ON g.authoritative_turn_id = t.turn_id
      WHERE t.result_authority_version = 1
        AND (
          (l.state IN ('open', 'cancelled') AND t.generation_fingerprint IS NOT NULL)
          OR (
            l.state = 'committed'
            AND t.turn_id = l.latest_turn_id
            AND (
              t.generation_fingerprint IS NULL
              OR g.generation_fingerprint IS NULL
              OR t.generation_fingerprint IS NOT g.generation_fingerprint
            )
          )
        )
      LIMIT 1
    `);

    assertNoInvariantRow('receipt_revision_delta', `
      SELECT lineage_key
      FROM visible_commit_receipts
      WHERE turn_revision_after != turn_revision_before + 1
         OR lineage_revision_after != lineage_revision_before + 1
         OR (
           authority_origin = 'pc'
           AND (
             lane_revision_before IS NULL
             OR lane_revision_after != lane_revision_before + 1
             OR cognitive_state_revision_before IS NULL
             OR cognitive_state_revision_after IS NULL
             OR cognitive_state_revision_after NOT IN (
               cognitive_state_revision_before,
               cognitive_state_revision_before + 1
             )
           )
         )
         OR (
           authority_origin = 'android_fallback'
           AND (
             lane_revision_before IS NOT NULL
             OR lane_revision_after IS NOT NULL
             OR cognitive_state_revision_before IS NOT NULL
             OR cognitive_state_revision_after IS NOT NULL
           )
         )
      LIMIT 1
    `);

    assertNoInvariantRow('committed_actual_revision_join', `
      SELECT r.lineage_key, r.authoritative_turn_id,
             t.turn_revision, r.turn_revision_after,
             l.revision AS lineage_revision, r.lineage_revision_after
      FROM visible_commit_receipts r
      JOIN turns t ON t.turn_id = r.authoritative_turn_id
      JOIN turn_authority_lineages l ON l.lineage_key = r.lineage_key
      WHERE t.turn_revision != r.turn_revision_after
         OR l.revision != r.lineage_revision_after
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_group_item_shape', `
      SELECT g.group_id, COUNT(i.ordinal) AS item_count,
             MIN(i.ordinal) AS min_ordinal, MAX(i.ordinal) AS max_ordinal
      FROM visible_result_groups g
      LEFT JOIN visible_result_items i ON i.group_id = g.group_id
      GROUP BY g.group_id
      HAVING item_count < 1 OR min_ordinal != 0 OR max_ordinal != item_count - 1
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_item_message_projection', `
      SELECT i.group_id, i.ordinal, i.message_id
      FROM visible_result_items i
      JOIN visible_result_groups g ON g.group_id = i.group_id
      LEFT JOIN messages m
        ON m.message_id = i.message_id
       AND m.authority_group_id = i.group_id
       AND m.group_ordinal = i.ordinal
       AND m.turn_id = g.authoritative_turn_id
      WHERE m.message_id IS NULL
         OR m.character_id IS NOT g.role_id
         OR m.speaker_id IS NOT g.role_id
         OR m.speaker_type != 'character'
         OR m.recipient_id != 'user'
      LIMIT 1
    `);

    assertNoInvariantRow('orphan_canonical_message_projection', `
      SELECT m.message_id, m.authority_group_id, m.group_ordinal
      FROM messages m
      LEFT JOIN visible_result_items i
        ON i.group_id = m.authority_group_id
       AND i.ordinal = m.group_ordinal
       AND i.message_id = m.message_id
      WHERE m.authority_group_id IS NOT NULL AND i.message_id IS NULL
      LIMIT 1
    `);

    assertNoInvariantRow('orphan_group_authority_reference', `
      SELECT 'stance' AS source, authority_group_id AS group_id
      FROM stance_records s
      LEFT JOIN visible_result_groups g ON g.group_id = s.authority_group_id
      WHERE s.authority_group_id IS NOT NULL AND g.group_id IS NULL
      UNION ALL
      SELECT 'job', authority_group_id
      FROM consolidation_jobs j
      LEFT JOIN visible_result_groups g ON g.group_id = j.authority_group_id
      WHERE j.authority_group_id IS NOT NULL AND g.group_id IS NULL
      UNION ALL
      SELECT 'state', last_authority_group_id
      FROM cognitive_states c
      LEFT JOIN visible_result_groups g ON g.group_id = c.last_authority_group_id
      WHERE c.last_authority_group_id IS NOT NULL AND g.group_id IS NULL
      LIMIT 1
    `);

    assertNoInvariantRow('canonical_delivery_join', `
      SELECT r.lineage_key, r.group_id
      FROM visible_commit_receipts r
      JOIN turns t ON t.turn_id = r.authoritative_turn_id
      LEFT JOIN cloud_deliveries d
        ON d.authority_group_id = r.group_id
       AND d.turn_id = r.authoritative_turn_id
       AND d.peer_id = t.device_id
       AND d.authority_commit_checksum = r.commit_checksum
      WHERE (r.authority_origin = 'pc' AND d.turn_id IS NULL)
         OR (
           r.authority_origin = 'android_fallback'
           AND EXISTS (
             SELECT 1 FROM cloud_deliveries fallback_delivery
             WHERE fallback_delivery.authority_group_id = r.group_id
           )
         )
      LIMIT 1
    `);

    assertNoInvariantRow('orphan_canonical_delivery', `
      SELECT d.turn_id, d.peer_id, d.authority_group_id
      FROM cloud_deliveries d
      LEFT JOIN visible_commit_receipts r
        ON r.group_id = d.authority_group_id
       AND r.commit_checksum = d.authority_commit_checksum
      LEFT JOIN visible_result_groups g
        ON g.group_id = d.authority_group_id
       AND g.authoritative_turn_id = d.turn_id
      WHERE d.authority_group_id IS NOT NULL
        AND (r.group_id IS NULL OR g.group_id IS NULL OR r.authority_origin != 'pc')
      LIMIT 1
    `);

    for (const turn of this.db.prepare(`
      SELECT turn_id, envelope_json, envelope_checksum
      FROM turns WHERE result_authority_version = 1
    `).all()) {
      if (contentHash(parseJson(turn.envelope_json, {})) !== turn.envelope_checksum) {
        throw new Error(`v11 invariant canonical_envelope_checksum: ${turn.turn_id}`);
      }
    }
    for (const item of this.db.prepare(`
      SELECT i.group_id, i.ordinal, i.message_id, i.item_json, i.item_checksum,
             g.role_id, m.content, m.speaker_id, m.speaker_type, m.recipient_id
      FROM visible_result_items i
      JOIN visible_result_groups g ON g.group_id = i.group_id
      JOIN messages m ON m.message_id = i.message_id
    `).all()) {
      if (item.message_id !== deriveVisibleMessageId(item.group_id, Number(item.ordinal))) {
        throw new Error(`v11 invariant deterministic_message_id: ${item.message_id}`);
      }
      const descriptor = parseJson(item.item_json, null);
      if (!descriptor
        || contentHash(descriptor) !== item.item_checksum
        || String(descriptor.content || '').trim() === ''
        || String(descriptor.content) !== String(item.content)
        || String(descriptor.speakerId || '') !== item.role_id
        || String(descriptor.speakerId || '') !== item.speaker_id
        || String(descriptor.speakerType || '') !== 'character'
        || String(descriptor.speakerType || '') !== item.speaker_type
        || String(descriptor.recipientId || '') !== 'user'
        || String(descriptor.recipientId || '') !== item.recipient_id) {
        throw new Error(`v11 invariant canonical_item_identity: ${item.message_id}`);
      }
    }
    for (const action of this.db.prepare(`
      SELECT group_id, ordinal, action_id FROM visible_result_actions
    `).all()) {
      if (action.action_id !== deriveVisibleActionId(action.group_id, Number(action.ordinal))) {
        throw new Error(`v11 invariant deterministic_action_id: ${action.action_id}`);
      }
    }
  }

  getVisibleResultManifest(groupId) {
    const row = this.db.prepare(`
      SELECT * FROM visible_result_manifests WHERE group_id = ?
    `).get(String(groupId || ''));
    if (!row) return null;
    return {
      visibleGroupId: row.group_id,
      authorityOrigin: row.authority_origin,
      payloadVersion: row.payload_version,
      semantic: row.semantic_json == null ? null : parseJson(row.semantic_json, null),
      semanticChecksum: row.semantic_checksum,
      redactedAt: row.redacted_at == null ? null : Number(row.redacted_at),
      createdAt: Number(row.created_at)
    };
  }

  assertVisibleAuthorityV12Invariants() {
    this.assertVisibleAuthorityV11Invariants({ allowVersionTwelve: true });
    const columns = this.db.prepare('PRAGMA table_info(visible_result_manifests)').all();
    const expectedColumns = [
      'group_id', 'authority_origin', 'payload_version', 'semantic_json',
      'semantic_checksum', 'redacted_at', 'created_at'
    ];
    if (canonicalJson(columns.map(row => row.name)) !== canonicalJson(expectedColumns)) {
      throw new Error('v12 invariant manifest schema mismatch');
    }
    const manifestIndexes = this.db.prepare(
      'PRAGMA index_list(visible_result_manifests)'
    ).all();
    const uniqueIndexColumns = manifestIndexes
      .filter(index => Number(index.unique) === 1)
      .map(index => this.db.prepare(`PRAGMA index_info("${index.name}")`).all()
        .map(column => column.name).join(','))
      .sort();
    if (canonicalJson(uniqueIndexColumns) !== canonicalJson(['group_id', 'semantic_checksum'])) {
      throw new Error('v12 invariant manifest index mismatch');
    }
    const manifestForeignKeys = this.db.prepare(
      'PRAGMA foreign_key_list(visible_result_manifests)'
    ).all();
    if (manifestForeignKeys.length !== 1
      || manifestForeignKeys[0].table !== 'visible_result_groups'
      || manifestForeignKeys[0].from !== 'group_id'
      || manifestForeignKeys[0].to !== 'group_id') {
      throw new Error('v12 invariant manifest foreign key mismatch');
    }
    const groups = this.db.prepare(`
      SELECT g.*, r.commit_checksum, r.commit_payload_version,
             r.authority_origin AS receipt_origin, m.semantic_json,
             m.semantic_checksum, m.payload_version, m.authority_origin AS manifest_origin,
             g.redacted_at AS group_redacted_at,
             m.redacted_at AS manifest_redacted_at
      FROM visible_result_groups g
      LEFT JOIN visible_commit_receipts r ON r.group_id = g.group_id
      LEFT JOIN visible_result_manifests m ON m.group_id = g.group_id
    `).all();
    const manifestCount = Number(this.db.prepare(
      'SELECT COUNT(*) AS value FROM visible_result_manifests'
    ).get().value);
    if (manifestCount !== groups.length) {
      throw new Error('v12 invariant manifest group cardinality mismatch');
    }
    for (const turn of this.db.prepare(`
      SELECT * FROM turns WHERE result_authority_version = 1
    `).all()) {
      const envelope = parseJson(turn.envelope_json, {});
      const normalized = resolveCurrentUserBatch(envelope);
      if (envelope.message) {
        const batch = this.db.prepare(
          'SELECT * FROM current_user_batches WHERE turn_id = ?'
        ).get(turn.turn_id);
        const items = this.db.prepare(`
          SELECT * FROM current_user_batch_items
          WHERE turn_id = ? ORDER BY sequence
        `).all(turn.turn_id);
        const header = normalized && {
          batchId: normalized.batchId,
          sourceMessageId: normalized.sourceMessageId,
          messageIds: normalized.messageIds,
          startedAt: normalized.startedAt,
          committedAt: normalized.committedAt
        };
        if (!batch || !normalized
          || batch.batch_id !== normalized.batchId
          || batch.character_id !== turn.character_id
          || batch.source_message_id !== normalized.sourceMessageId
          || Number(batch.started_at) !== Number(normalized.startedAt)
          || Number(batch.committed_at) !== Number(normalized.committedAt)
          || batch.checksum !== contentHash(header)
          || items.length !== normalized.messageIds.length) {
          throw new Error(`v12 invariant canonical input batch: ${turn.turn_id}`);
        }
        items.forEach((item, sequence) => {
          const message = normalized.messages.find(candidate =>
            candidate.messageId === normalized.messageIds[sequence]);
          if (Number(item.sequence) !== sequence
            || item.batch_id !== normalized.batchId
            || item.message_id !== normalized.messageIds[sequence]
            || item.checksum !== contentHash(message)
            || canonicalJson(parseJson(item.message_json, null)) !== canonicalJson(message)) {
            throw new Error(`v12 invariant canonical input item: ${turn.turn_id}`);
          }
        });
      }
      if (turn.retry_of_turn_id) {
        const parent = this.db.prepare('SELECT * FROM turns WHERE turn_id = ?')
          .get(turn.retry_of_turn_id);
        const inherited = [
          'pipeline_mode', 'preset_version', 'rollout_revision', 'rollout_evidence_epoch',
          'pipeline_checksum', 'shadow_epoch', 'canary_epoch', 'canary_slot',
          'comparison_mode', 'authoritative_release_id', 'comparison_release_id',
          'authoritative_pipeline_checksum', 'comparison_pipeline_checksum',
          'input_user_batch_id', 'input_visibility_sequence'
        ];
        if (!parent
          || inherited.some(column => turn[column] !== parent[column])
          || contentHash(parseJson(turn.annotation_snapshot_json, {}))
            !== contentHash(parseJson(parent.annotation_snapshot_json, {}))
          || Number(turn.lineage_revision_at_creation)
            !== Number(parent.lineage_revision_at_creation) + 1) {
          throw new Error(`v12 invariant canonical retry pins: ${turn.turn_id}`);
        }
      }
    }
    for (const group of groups) {
      if (!group.semantic_checksum
        || group.semantic_checksum !== group.commit_checksum
        || group.payload_version !== group.commit_payload_version
        || group.manifest_origin !== group.receipt_origin
        || group.manifest_origin !== group.authority_origin) {
        throw new Error(`v12 invariant manifest receipt join: ${group.group_id}`);
      }
      if (group.group_redacted_at != null || group.manifest_redacted_at != null) {
        const redactedDeliveries = Number(this.db.prepare(`
          SELECT COUNT(*) AS value FROM cloud_deliveries
          WHERE authority_group_id = ? AND state IN ('waiting','pending','retry')
        `).get(group.group_id).value);
        const retainedItems = Number(this.db.prepare(`
          SELECT COUNT(*) AS value FROM visible_result_items WHERE group_id = ?
        `).get(group.group_id).value);
        const retainedActions = Number(this.db.prepare(`
          SELECT COUNT(*) AS value FROM visible_result_actions WHERE group_id = ?
        `).get(group.group_id).value);
        const retainedMessages = Number(this.db.prepare(`
          SELECT COUNT(*) AS value FROM messages
          WHERE authority_group_id = ? AND length(trim(content)) > 0
        `).get(group.group_id).value);
        if (group.group_redacted_at == null
          || group.manifest_redacted_at == null
          || Number(group.group_redacted_at) !== Number(group.manifest_redacted_at)
          || group.semantic_json != null
          || redactedDeliveries !== 0
          || retainedItems !== 0
          || retainedActions !== 0
          || retainedMessages !== 0) {
          throw new Error(`v12 invariant redacted manifest shape: ${group.group_id}`);
        }
        continue;
      }
      const semantic = parseJson(group.semantic_json, null);
      if (!semantic || contentHash(semantic) !== group.semantic_checksum) {
        throw new Error(`v12 invariant manifest checksum: ${group.group_id}`);
      }
      const items = this.visibleItemsForGroup(group.group_id).map(item => item.item);
      const actionRows = this.actionsForGroup(group.group_id);
      const actions = actionRows.map(action => ({
        kind: action.kind,
        targetKey: action.targetKey,
        targetRevision: action.targetRevision,
        payload: action.action
      }));
      if (canonicalJson(items) !== canonicalJson(semantic.visibleItems || [])
        || canonicalJson(actions) !== canonicalJson(semantic.actions || [])) {
        throw new Error(`v12 invariant manifest projection mismatch: ${group.group_id}`);
      }
      actionRows.forEach((action, ordinal) => {
        const descriptor = actions[ordinal];
        if (action.ordinal !== ordinal
          || action.actionChecksum !== contentHash(descriptor)
          || action.actionId !== deriveVisibleActionId(group.group_id, ordinal)) {
          throw new Error(`v12 invariant manifest action authority: ${group.group_id}`);
        }
      });
      const jobs = this.db.prepare(`
        SELECT * FROM consolidation_jobs
        WHERE authority_group_id = ? ORDER BY authority_ordinal
      `).all(group.group_id);
      const expectedJobs = [
        ...(semantic.memoryJobs || []),
        ...(semantic.comparison ? [semantic.comparison] : [])
      ];
      if (jobs.length !== expectedJobs.length) {
        throw new Error(`v12 invariant manifest job cardinality: ${group.group_id}`);
      }
      jobs.forEach((job, ordinal) => {
        const payload = parseJson(job.payload_json, {});
        const expected = expectedJobs[ordinal];
        const semanticJob = ['shadow_cognition', 'active_canary_compare'].includes(job.job_type)
          ? {
              jobType: job.job_type,
              ...Object.fromEntries(Object.entries(payload).filter(([key]) =>
                !['authorityGroupId', 'authoritativeResultChecksum'].includes(key)))
            }
          : payload;
        if (job.role_id !== group.role_id
          || job.turn_id !== group.authoritative_turn_id
          || job.subject_type !== 'turn'
          || job.subject_id !== group.authoritative_turn_id
          || Number(job.authority_ordinal) !== ordinal
          || contentHash(payload) !== job.payload_checksum
          || canonicalJson(semanticJob) !== canonicalJson(expected)) {
          throw new Error(`v12 invariant manifest job authority: ${group.group_id}`);
        }
      });
      const stances = this.db.prepare(`
        SELECT * FROM stance_records
        WHERE authority_group_id = ? ORDER BY authority_ordinal
      `).all(group.group_id);
      const expectedStances = semantic.statePatch?.currentStances || [];
      if (stances.length !== expectedStances.length) {
        throw new Error(`v12 invariant manifest stance cardinality: ${group.group_id}`);
      }
      stances.forEach((stance, ordinal) => {
        const expected = expectedStances[ordinal];
        if (stance.role_id !== group.role_id
          || stance.source_turn_id !== group.authoritative_turn_id
          || Number(stance.authority_ordinal) !== ordinal
          || stance.stance_id !== String(expected.stanceId || '')
          || stance.topic !== String(expected.topic || '')
          || stance.position_text !== String(expected.position || '')
          || stance.reason_text !== String(expected.reason || '')) {
          throw new Error(`v12 invariant manifest stance authority: ${group.group_id}`);
        }
      });
      const cognitiveState = this.db.prepare(`
        SELECT * FROM cognitive_states WHERE last_authority_group_id = ?
      `).get(group.group_id);
      if (semantic.statePatch && !cognitiveState) {
        throw new Error(`v12 invariant manifest cognitive state missing: ${group.group_id}`);
      }
      if (cognitiveState) {
        const state = parseJson(cognitiveState.state_json, {});
        const expectedOpenThreads = (semantic.statePatch?.openThreads || []).map(item =>
          typeof item === 'string' ? item : String(item?.threadId || '')
        ).filter(Boolean);
        if (cognitiveState.role_id !== group.role_id
          || cognitiveState.last_turn_id !== group.authoritative_turn_id
          || cognitiveState.checksum !== contentHash(state)
          || String(state.fastState?.mood || '') !== String(semantic.statePatch?.mood || '')
          || canonicalJson(state.fastState?.openThreadIds || []) !== canonicalJson(expectedOpenThreads)) {
          throw new Error(`v12 invariant manifest cognitive state authority: ${group.group_id}`);
        }
      }
    }
  }

  visibleAuthorityV11InvariantSummary() {
    if (this.userVersion() === 12) this.assertVisibleAuthorityV12Invariants();
    else this.assertVisibleAuthorityV11Invariants();
    const tableNames = [
      'messages',
      'facts',
      'relationship_states',
      'relationship_history',
      'role_plans',
      'life_episodes',
      'turns',
      'result_outbox',
      'turn_authority_lineages',
      'visible_result_groups',
      'visible_result_items',
      'visible_result_actions',
      'visible_result_manifests',
      'visible_commit_receipts',
      'cloud_deliveries'
    ];
    const existing = new Set(this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    const tableCounts = Object.fromEntries(tableNames.map(table => [
      table,
      existing.has(table)
        ? Number(this.db.prepare(`SELECT COUNT(*) AS value FROM "${table}"`).get().value)
        : null
    ]));
    const summary = {
      userVersion: this.userVersion(),
      tableCounts,
      canonicalTurnCount: Number(this.db.prepare(
        'SELECT COUNT(*) AS value FROM turns WHERE result_authority_version = 1'
      ).get().value),
      lineageCount: Number(this.db.prepare(
        'SELECT COUNT(*) AS value FROM turn_authority_lineages'
      ).get().value),
      receiptCount: Number(this.db.prepare(
        'SELECT COUNT(*) AS value FROM visible_commit_receipts'
      ).get().value)
    };
    return { ...summary, checksum: contentHash(summary) };
  }

  assertAgencyV10Invariants({ allowVersionNine = false, allowPreFinalVersion = false } = {}) {
    const version = this.userVersion();
    const versionAllowed = allowVersionNine
      ? version === 9
      : allowPreFinalVersion
        ? version === 10
        : version === 10 || version === 11 || version === 12;
    if (!versionAllowed) {
      throw new Error(`v10 invariant user_version mismatch: ${version}`);
    }
    const requiredTables = [
      'pipeline_releases',
      'constraint_records',
      'stance_records',
      'interaction_lanes',
      'quality_eval_runs',
      'quality_findings',
      'state_migration_audit'
    ];
    const existing = new Set(this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    const missing = requiredTables.filter(name => !existing.has(name));
    if (missing.length) throw new Error(`v10 invariant missing tables: ${missing.join(',')}`);
    const releaseCount = Number(this.db.prepare(
      'SELECT COUNT(*) AS value FROM pipeline_releases'
    ).get().value);
    if (releaseCount < 2) throw new Error('v10 invariant requires stable and candidate releases');
    const invalidRollout = this.db.prepare(`
      SELECT rollout_key FROM cognition_kind_rollouts
      WHERE stable_release_id IS NULL OR candidate_release_id IS NULL OR candidate_phase IS NULL
         OR stable_release_id NOT IN (SELECT release_id FROM pipeline_releases)
         OR candidate_release_id NOT IN (SELECT release_id FROM pipeline_releases)
      LIMIT 1
    `).get();
    if (invalidRollout) {
      throw new Error(`v10 invariant rollout release authority is invalid: ${invalidRollout.rollout_key}`);
    }
  }

  putPipelineReleaseInternal(release) {
    const normalized = {
      releaseId: String(release?.releaseId || ''),
      pipelineVersion: String(release?.pipelineVersion || ''),
      presetVersion: String(release?.presetVersion || ''),
      cognitionSchemaVersion: Number(release?.cognitionSchemaVersion),
      expressionSchemaVersion: Number(release?.expressionSchemaVersion),
      evaluatorVersion: String(release?.evaluatorVersion || ''),
      modelProfile: release?.modelProfile || {},
      componentManifest: release?.componentManifest || {},
      releaseChecksum: String(release?.releaseChecksum || ''),
      createdAt: Number(release?.createdAt || now()),
      retiredAt: release?.retiredAt ?? null
    };
    if (!normalized.releaseId
      || !normalized.pipelineVersion
      || !normalized.presetVersion
      || !normalized.evaluatorVersion
      || !/^[a-f0-9]{64}$/i.test(normalized.releaseChecksum)
      || !Number.isInteger(normalized.cognitionSchemaVersion)
      || !Number.isInteger(normalized.expressionSchemaVersion)) {
      throw new Error('invalid pipeline release');
    }
    const existing = this.getPipelineRelease(normalized.releaseId);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error('pipeline release identity conflict');
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO pipeline_releases(
        release_id, pipeline_version, preset_version, cognition_schema_version,
        expression_schema_version, evaluator_version, model_profile_json,
        component_manifest_json, release_checksum, created_at, retired_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.releaseId,
      normalized.pipelineVersion,
      normalized.presetVersion,
      normalized.cognitionSchemaVersion,
      normalized.expressionSchemaVersion,
      normalized.evaluatorVersion,
      canonicalJson(normalized.modelProfile),
      canonicalJson(normalized.componentManifest),
      normalized.releaseChecksum,
      normalized.createdAt,
      normalized.retiredAt
    );
    return this.getPipelineRelease(normalized.releaseId);
  }

  getPipelineRelease(releaseId) {
    return mapPipelineRelease(this.db.prepare(
      'SELECT * FROM pipeline_releases WHERE release_id = ?'
    ).get(String(releaseId || '')));
  }

  listPipelineReleases() {
    return this.db.prepare(
      'SELECT * FROM pipeline_releases ORDER BY created_at, release_id'
    ).all().map(mapPipelineRelease);
  }

  putConstraintRevisionInternal(record) {
    const normalized = {
      constraintId: String(record?.constraintId || ''),
      revision: Number(record?.revision),
      roleId: String(record?.roleId || ''),
      authority: String(record?.authority || ''),
      kind: String(record?.kind || ''),
      subject: String(record?.subject || ''),
      scope: record?.scope || {},
      rule: String(record?.rule || ''),
      sourceMessageIds: Array.isArray(record?.sourceMessageIds) ? record.sourceMessageIds : [],
      sourceConfigRef: record?.sourceConfigRef ?? null,
      releaseCondition: record?.releaseCondition ?? null,
      status: String(record?.status || ''),
      supersedes: record?.supersedes ?? null,
      createdAt: Number(record?.createdAt || now()),
      updatedAt: Number(record?.updatedAt || record?.createdAt || now())
    };
    if (!normalized.constraintId || !normalized.roleId || !Number.isInteger(normalized.revision)) {
      throw new Error('invalid constraint revision');
    }
    const existing = mapConstraintRecord(this.db.prepare(`
      SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = ?
    `).get(normalized.constraintId, normalized.revision));
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error('constraint revision conflict');
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO constraint_records(
        constraint_id, revision, role_id, authority, kind, subject, scope_json,
        rule_text, source_message_ids_json, source_config_ref, release_condition,
        status, supersedes, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.constraintId,
      normalized.revision,
      normalized.roleId,
      normalized.authority,
      normalized.kind,
      normalized.subject,
      canonicalJson(normalized.scope),
      normalized.rule,
      canonicalJson(normalized.sourceMessageIds),
      normalized.sourceConfigRef,
      normalized.releaseCondition,
      normalized.status,
      normalized.supersedes,
      normalized.createdAt,
      normalized.updatedAt
    );
    return mapConstraintRecord(this.db.prepare(`
      SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = ?
    `).get(normalized.constraintId, normalized.revision));
  }

  listActiveConstraints(roleId) {
    return this.db.prepare(`
      SELECT records.* FROM constraint_records records
      JOIN (
        SELECT constraint_id, MAX(revision) AS revision
        FROM constraint_records WHERE role_id = ? GROUP BY constraint_id
      ) latest
      ON latest.constraint_id = records.constraint_id AND latest.revision = records.revision
      WHERE records.role_id = ? AND records.status = 'active'
      ORDER BY records.updated_at DESC, records.constraint_id
    `).all(String(roleId), String(roleId)).map(mapConstraintRecord);
  }

  putStanceRevisionInternal(record) {
    const normalized = {
      stanceId: String(record?.stanceId || ''),
      revision: Number(record?.revision),
      roleId: String(record?.roleId || ''),
      topic: String(record?.topic || ''),
      position: String(record?.position || ''),
      reason: String(record?.reason || ''),
      strength: Number(record?.strength),
      flexibility: Number(record?.flexibility),
      sourceTurnId: String(record?.sourceTurnId || ''),
      sourceMessageIds: Array.isArray(record?.sourceMessageIds) ? record.sourceMessageIds : [],
      createdAt: Number(record?.createdAt || now()),
      lastConfirmedAt: Number(record?.lastConfirmedAt || record?.createdAt || now()),
      expiresAt: record?.expiresAt ?? null,
      remainingRelevantUserBatches: Number(record?.remainingRelevantUserBatches),
      status: String(record?.status || ''),
      supersedes: record?.supersedes ?? null,
      authorityGroupId: record?.authorityGroupId ?? null,
      authorityOrdinal: record?.authorityOrdinal ?? null
    };
    if (!normalized.stanceId || !normalized.roleId || !Number.isInteger(normalized.revision)) {
      throw new Error('invalid stance revision');
    }
    const existing = mapStanceRecord(this.db.prepare(`
      SELECT * FROM stance_records WHERE stance_id = ? AND revision = ?
    `).get(normalized.stanceId, normalized.revision));
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error('stance revision conflict');
      }
      return existing;
    }
    this.db.prepare(`
      INSERT INTO stance_records(
        stance_id, revision, role_id, topic, position_text, reason_text,
        strength, flexibility, source_turn_id, source_message_ids_json,
        created_at, last_confirmed_at, expires_at, remaining_relevant_user_batches,
        status, supersedes, authority_group_id, authority_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.stanceId,
      normalized.revision,
      normalized.roleId,
      normalized.topic,
      normalized.position,
      normalized.reason,
      normalized.strength,
      normalized.flexibility,
      normalized.sourceTurnId,
      canonicalJson(normalized.sourceMessageIds),
      normalized.createdAt,
      normalized.lastConfirmedAt,
      normalized.expiresAt,
      normalized.remainingRelevantUserBatches,
      normalized.status,
      normalized.supersedes,
      normalized.authorityGroupId,
      normalized.authorityOrdinal
    );
    return mapStanceRecord(this.db.prepare(`
      SELECT * FROM stance_records WHERE stance_id = ? AND revision = ?
    `).get(normalized.stanceId, normalized.revision));
  }

  listActiveStances(roleId, at = now()) {
    return this.db.prepare(`
      SELECT records.* FROM stance_records records
      JOIN (
        SELECT stance_id, MAX(revision) AS revision
        FROM stance_records WHERE role_id = ? GROUP BY stance_id
      ) latest
      ON latest.stance_id = records.stance_id AND latest.revision = records.revision
      WHERE records.role_id = ? AND records.status = 'active'
        AND (records.expires_at IS NULL OR records.expires_at > ?)
        AND records.remaining_relevant_user_batches > 0
      ORDER BY records.last_confirmed_at DESC, records.stance_id
    `).all(String(roleId), String(roleId), Number(at)).map(mapStanceRecord);
  }

  readAgencyAuthoritySnapshotInternal({ roleId, at = now() }) {
    const normalizedRoleId = String(roleId || '').trim();
    if (!normalizedRoleId) throw new Error('agency authority role is required');
    const cognitiveState = this.getCognitiveState(normalizedRoleId);
    const descriptor = {
      version: 'agency-authority-v1',
      roleId: normalizedRoleId,
      constraints: this.listActiveConstraints(normalizedRoleId)
        .map(record => ({
          constraintId: record.constraintId,
          revision: record.revision,
          authority: record.authority,
          kind: record.kind,
          subject: record.subject,
          scope: record.scope,
          rule: record.rule,
          sourceMessageIds: record.sourceMessageIds,
          sourceConfigRef: record.sourceConfigRef ?? null,
          releaseCondition: record.releaseCondition ?? null,
          status: record.status,
          supersedes: record.supersedes ?? null
        }))
        .sort((left, right) => String(left.constraintId).localeCompare(String(right.constraintId))
          || Number(left.revision) - Number(right.revision)),
      preferenceFacts: [],
      stances: this.listActiveStances(normalizedRoleId, Number(at))
        .map(record => ({
          stanceId: record.stanceId,
          revision: record.revision,
          topic: record.topic,
          position: record.position,
          reason: record.reason,
          strength: record.strength,
          flexibility: record.flexibility,
          sourceMessageIds: record.sourceMessageIds,
          lastConfirmedAt: record.lastConfirmedAt,
          expiresAt: record.expiresAt ?? null,
          remainingRelevantUserBatches: record.remainingRelevantUserBatches,
          status: record.status,
          supersedes: record.supersedes ?? null
        }))
        .sort((left, right) => String(left.stanceId).localeCompare(String(right.stanceId))
          || Number(left.revision) - Number(right.revision)),
      cognitiveState: {
        revision: Number(cognitiveState?.revision || 0),
        checksum: cognitiveState?.checksum || null
      }
    };
    const preferenceFactIds = [...new Set(
      cognitiveState?.state?.slowState?.preferenceFactIds || []
    )].map(String).sort();
    const suppressed = new Set(this.db.prepare(
      'SELECT message_id FROM suppressed_messages'
    ).all().map(row => String(row.message_id)));
    descriptor.preferenceFacts = preferenceFactIds.map(factId => {
      const row = this.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(factId);
      const fact = mapFact(row);
      const evidenceExists = Array.isArray(fact?.sourceMessageIds)
        && fact.sourceMessageIds.every(messageId => Boolean(this.getMessage(messageId)));
      if (!row || !fact
        || fact.characterId !== normalizedRoleId
        || fact.type !== 'stable_preference'
        || fact.status !== 'verified'
        || !Array.isArray(fact.sourceMessageIds)
        || fact.sourceMessageIds.length === 0
        || !evidenceExists
        || fact.sourceMessageIds.some(messageId => suppressed.has(String(messageId)))) {
        throw new Error(`agency authority preference fact is invalid: ${factId}`);
      }
      return {
        factId: fact.factId,
        type: fact.type,
        subjectId: fact.subjectId,
        predicate: fact.predicate,
        object: fact.object,
        sourceMessageIds: [...fact.sourceMessageIds].map(String).sort(),
        status: fact.status,
        confidence: fact.confidence,
        supersedes: fact.supersedes ?? null,
        checksum: row.checksum
      };
    });
    return {
      ...descriptor,
      checksum: contentHash(descriptor)
    };
  }

  getInteractionLane(roleId, laneKey) {
    return mapInteractionLane(this.db.prepare(`
      SELECT * FROM interaction_lanes WHERE role_id = ? AND lane_key = ?
    `).get(String(roleId), String(laneKey)));
  }

  claimInteractionLaneInternal(input) {
    const roleId = String(input?.roleId || '');
    const laneKey = String(input?.laneKey || '');
    const expectedRevision = Number(input?.expectedRevision ?? 0);
    if (!roleId || !laneKey || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new Error('invalid interaction lane claim');
    }
    const current = this.getInteractionLane(roleId, laneKey);
    if (!current) {
      if (expectedRevision !== 0) throw new Error('interaction lane revision conflict');
      this.db.prepare(`
        INSERT INTO interaction_lanes(
          role_id, lane_key, revision, generating_turn_id, latest_user_batch_id,
          latest_authoritative_group_id, native_completed_group_id,
          native_completed_sequence, ui_applied_group_id, ui_applied_sequence,
          local_sequence, last_commit_checksum, updated_at
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        roleId,
        laneKey,
        input.generatingTurnId ?? null,
        input.latestUserBatchId ?? null,
        input.latestAuthoritativeGroupId ?? null,
        input.nativeCompletedGroupId ?? null,
        Number(input.nativeCompletedSequence || 0),
        input.uiAppliedGroupId ?? null,
        Number(input.uiAppliedSequence || 0),
        Number(input.localSequence || 0),
        input.lastCommitChecksum ?? null,
        Number(input.now || now())
      );
      return this.getInteractionLane(roleId, laneKey);
    }
    if (current.revision !== expectedRevision) throw new Error('interaction lane revision conflict');
    const next = {
      generatingTurnId: input.generatingTurnId ?? current.generatingTurnId,
      latestUserBatchId: input.latestUserBatchId ?? current.latestUserBatchId,
      latestAuthoritativeGroupId:
        input.latestAuthoritativeGroupId ?? current.latestAuthoritativeGroupId,
      nativeCompletedGroupId: input.nativeCompletedGroupId ?? current.nativeCompletedGroupId,
      nativeCompletedSequence:
        input.nativeCompletedSequence ?? current.nativeCompletedSequence,
      uiAppliedGroupId: input.uiAppliedGroupId ?? current.uiAppliedGroupId,
      uiAppliedSequence: input.uiAppliedSequence ?? current.uiAppliedSequence,
      localSequence: input.localSequence ?? current.localSequence,
      lastCommitChecksum: input.lastCommitChecksum ?? current.lastCommitChecksum,
      updatedAt: Number(input.now || now())
    };
    const result = this.db.prepare(`
      UPDATE interaction_lanes
      SET revision = revision + 1, generating_turn_id = ?, latest_user_batch_id = ?,
          latest_authoritative_group_id = ?, native_completed_group_id = ?,
          native_completed_sequence = ?, ui_applied_group_id = ?, ui_applied_sequence = ?,
          local_sequence = ?, last_commit_checksum = ?, updated_at = ?
      WHERE role_id = ? AND lane_key = ? AND revision = ?
    `).run(
      next.generatingTurnId,
      next.latestUserBatchId,
      next.latestAuthoritativeGroupId,
      next.nativeCompletedGroupId,
      Number(next.nativeCompletedSequence),
      next.uiAppliedGroupId,
      Number(next.uiAppliedSequence),
      Number(next.localSequence),
      next.lastCommitChecksum,
      next.updatedAt,
      roleId,
      laneKey,
      expectedRevision
    );
    if (Number(result.changes) !== 1) throw new Error('interaction lane revision conflict');
    return this.getInteractionLane(roleId, laneKey);
  }

  admitInteractionTurnInternal(input) {
    const roleId = String(input?.roleId || '');
    const laneKey = String(input?.laneKey || '');
    const expectedRevision = Number(input?.expectedRevision ?? 0);
    const incomingTurnId = String(input?.incomingTurnId || '');
    if (!roleId || !laneKey || !incomingTurnId || !Number.isInteger(expectedRevision)) {
      throw new Error('invalid interaction lane admission');
    }
    return this.transaction(() => {
      const lane = this.getInteractionLane(roleId, laneKey);
      const actualRevision = Number(lane?.revision || 0);
      if (actualRevision !== expectedRevision) {
        throw new Error('interaction lane revision conflict');
      }
      const incomingTurn = this.getTurn(incomingTurnId);
      if (!incomingTurn || incomingTurn.characterId !== roleId) {
        throw new Error('incoming interaction turn is unavailable');
      }
      const incomingEnvelope = parseJson(incomingTurn.envelopeJson, {});
      const currentTurn = lane?.generatingTurnId
        ? this.getTurn(lane.generatingTurnId)
        : null;
      const currentEnvelope = currentTurn ? parseJson(currentTurn.envelopeJson, {}) : {};
      const decision = decideLaneAdmission({
        lane: {
          ...lane,
          generatingTurn: currentTurn
            ? {
                turnId: currentTurn.turnId,
                kind: currentEnvelope.kind,
                state: currentTurn.state,
                committed: Boolean(currentTurn.replyJson)
                  || ['committed', 'completed', 'delivered'].includes(currentTurn.state)
              }
            : null
        },
        incoming: {
          turnId: incomingTurn.turnId,
          kind: incomingEnvelope.kind,
          state: incomingTurn.state,
          committed: Boolean(incomingTurn.replyJson)
        },
        now: input.now || now()
      });
      if (!decision.admitted) return { decision, lane };

      if (decision.supersededTurnId) {
        const superseded = this.getTurn(decision.supersededTurnId);
        if (superseded?.resultAuthorityVersion === 1) {
          const lineage = this.getTurnAuthorityLineage(superseded.authorityLineageKey);
          this.cancelCanonicalTurnRowsInternal({
            turnId: superseded.turnId,
            authorityLineageKey: superseded.authorityLineageKey,
            expectedTurnRevision: superseded.turnRevision,
            expectedLineageRevision: lineage?.revision,
            reasonCode: decision.reasonCode,
            supersededByTurnId: incomingTurnId,
            timestamp: Number(input.now || now())
          });
        } else {
          this.db.prepare(`
            UPDATE turns
            SET state = 'failed', worker_id = NULL, error_json = ?, updated_at = ?
            WHERE turn_id = ? AND reply_json IS NULL
          `).run(canonicalJson({
            code: decision.reasonCode,
            supersededByTurnId: incomingTurnId
          }), Number(input.now || now()), decision.supersededTurnId);
        }
      }
      if (decision.requeueTurnId) {
        const requeued = this.getTurn(decision.requeueTurnId);
        if (requeued?.resultAuthorityVersion === 1) {
          throw new Error('canonical turn API required for lane requeue');
        }
        this.db.prepare(`
          UPDATE turns
          SET state = 'queued', worker_id = NULL, error_json = NULL, updated_at = ?
          WHERE turn_id = ? AND reply_json IS NULL
        `).run(Number(input.now || now()), decision.requeueTurnId);
      }
      const updatedLane = this.claimInteractionLaneInternal({
        roleId,
        laneKey,
        expectedRevision,
        generatingTurnId: incomingTurnId,
        latestUserBatchId: input.latestUserBatchId ?? lane?.latestUserBatchId ?? null,
        now: input.now || now()
      });
      this.appendSync('interaction_lane', `${roleId}:${laneKey}`, 'admit', {
        decision,
        lane: updatedLane
      });
      return { decision, lane: updatedLane };
    });
  }

  putQualityEvalRunInternal(run) {
    const normalized = {
      evalRunId: String(run?.evalRunId || ''),
      releaseId: String(run?.releaseId || ''),
      baselineReleaseId: String(run?.baselineReleaseId || ''),
      suiteVersion: String(run?.suiteVersion || ''),
      sourceType: String(run?.sourceType || ''),
      state: String(run?.state || ''),
      manifestChecksum: String(run?.manifestChecksum || ''),
      summary: run?.summary || {},
      artifactPath: String(run?.artifactPath || ''),
      artifactChecksum: run?.artifactChecksum ?? null,
      createdAt: Number(run?.createdAt || now()),
      completedAt: run?.completedAt ?? null
    };
    if (!normalized.evalRunId || !normalized.releaseId || !normalized.baselineReleaseId) {
      throw new Error('invalid quality evaluation run');
    }
    this.db.prepare(`
      INSERT INTO quality_eval_runs(
        eval_run_id, release_id, baseline_release_id, suite_version, source_type,
        state, manifest_checksum, summary_json, artifact_path, artifact_checksum,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.evalRunId,
      normalized.releaseId,
      normalized.baselineReleaseId,
      normalized.suiteVersion,
      normalized.sourceType,
      normalized.state,
      normalized.manifestChecksum,
      canonicalJson(normalized.summary),
      normalized.artifactPath,
      normalized.artifactChecksum,
      normalized.createdAt,
      normalized.completedAt
    );
    return normalized;
  }

  putQualityFindingInternal(finding) {
    const normalized = {
      findingId: String(finding?.findingId || ''),
      evalRunId: String(finding?.evalRunId || ''),
      rolloutKey: String(finding?.rolloutKey || ''),
      sceneId: String(finding?.sceneId || ''),
      repeatIndex: Number(finding?.repeatIndex || 0),
      code: String(finding?.code || ''),
      owner: String(finding?.owner || ''),
      severity: String(finding?.severity || ''),
      evidence: finding?.evidence || {},
      scores: finding?.scores || {},
      createdAt: Number(finding?.createdAt || now())
    };
    if (!normalized.findingId || !normalized.evalRunId) throw new Error('invalid quality finding');
    this.db.prepare(`
      INSERT INTO quality_findings(
        finding_id, eval_run_id, rollout_key, scene_id, repeat_index, code,
        owner, severity, evidence_json, scores_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.findingId,
      normalized.evalRunId,
      normalized.rolloutKey,
      normalized.sceneId,
      normalized.repeatIndex,
      normalized.code,
      normalized.owner,
      normalized.severity,
      canonicalJson(normalized.evidence),
      canonicalJson(normalized.scores),
      normalized.createdAt
    );
    return normalized;
  }

  putStateMigrationAuditInternal(audit) {
    const normalized = {
      auditId: String(audit?.auditId || ''),
      roleId: String(audit?.roleId || ''),
      sourceType: String(audit?.sourceType || ''),
      sourceId: String(audit?.sourceId || ''),
      classification: String(audit?.classification || ''),
      targetId: audit?.targetId ?? null,
      reasonCode: String(audit?.reasonCode || ''),
      evidence: audit?.evidence || {},
      createdAt: Number(audit?.createdAt || now())
    };
    if (!normalized.auditId || !normalized.roleId || !normalized.sourceType
      || !normalized.sourceId || !normalized.classification || !normalized.reasonCode) {
      throw new Error('invalid state migration audit');
    }
    this.db.prepare(`
      INSERT INTO state_migration_audit(
        audit_id, role_id, source_type, source_id, classification, target_id,
        reason_code, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.auditId,
      normalized.roleId,
      normalized.sourceType,
      normalized.sourceId,
      normalized.classification,
      normalized.targetId,
      normalized.reasonCode,
      canonicalJson(normalized.evidence),
      normalized.createdAt
    );
    return normalized;
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

  withImmediateTransaction(run) {
    return this.transaction(run);
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
          last_reason_code, created_at, updated_at, stable_release_id,
          candidate_release_id, candidate_phase
        ) VALUES (?, ?, ?, 1, ?, ?, 1, 0, 0, 'bootstrap', ?, ?, ?, ?, 'none')
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
          Number(initializedAt),
          BASELINE_STABLE_RELEASE.releaseId,
          BASELINE_V2_CANDIDATE_RELEASE.releaseId
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

  createTurnWithReleasePinInternal({
    envelope,
    rolloutKey,
    laneKey,
    expectedLaneRevision,
    inputVisibilitySequence = null,
    generationFingerprint = null,
    presetVersion,
    annotationSnapshot
  }) {
    return this.submitTurn(envelope, {
      rolloutKey,
      laneKey,
      laneRevision: Number(expectedLaneRevision ?? 0),
      inputVisibilitySequence,
      generationFingerprint,
      presetVersion,
      annotationSnapshot
    });
  }

  getTurnAuthorityLineage(lineageKey) {
    return mapAuthorityLineage(this.db.prepare(
      'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
    ).get(String(lineageKey || '')));
  }

  listTurnAuthorityLineages() {
    return this.db.prepare(
      'SELECT * FROM turn_authority_lineages ORDER BY created_at, lineage_key'
    ).all().map(mapAuthorityLineage);
  }

  getVisibleCommitReceipt(lineageKey) {
    return mapVisibleCommitReceipt(this.db.prepare(
      'SELECT * FROM visible_commit_receipts WHERE lineage_key = ?'
    ).get(String(lineageKey || '')));
  }

  createCanonicalVisibleTurnInternal(input = {}) {
    for (const forbidden of [
      'resultAuthorityVersion',
      'authorityContractVersion',
      'authorityLineageKey',
      'lineageRevisionAtCreation',
      'turnRevision'
    ]) {
      if (Object.hasOwn(input, forbidden)) {
        throw new Error(`invalid authority selector input: ${forbidden}`);
      }
    }
    const envelope = validateEnvelope(input.envelope);
    const envelopeChecksum = contentHash(envelope);
    const rolloutKey = String(input.rolloutKey || '');
    const laneKey = String(input.laneKey || '');
    const expectedRolloutRevision = Number(input.expectedRolloutRevision);
    const expectedLaneRevision = Number(input.expectedLaneRevision);
    const inputVisibilitySequence = Number(input.inputVisibilitySequence);
    const inputUserBatchId = String(input.inputUserBatchId || '');
    const agencySnapshotChecksum = String(input.agencySnapshotChecksum || '');
    const retry = envelope.context?.retry || null;
    const rootSourceId = retry?.canonicalMessageId
      || envelope.message?.messageId
      || envelope.trigger?.triggerId
      || '';
    const derivedRolloutKey = String(envelope.kind || '');
    const derivedLaneKey = laneKeyForEnvelope(envelope);
    const derivedInputUserBatchId = String(
      resolveCurrentUserBatch(envelope)?.batchId
      ?? envelope.trigger?.triggerId
      ?? ''
    );
    if (envelope.characterId !== 'yuqi') {
      throw new Error('canonical authority requires role yuqi');
    }
    if (rolloutKey !== derivedRolloutKey) {
      throw new Error('canonical rollout authority conflict');
    }
    if (laneKey !== derivedLaneKey) {
      throw new Error('canonical lane authority conflict');
    }
    if (inputUserBatchId !== derivedInputUserBatchId) {
      throw new Error('canonical user batch authority conflict');
    }
    if (!rolloutKey || !laneKey || !rootSourceId || !inputUserBatchId
      || !Number.isInteger(expectedRolloutRevision) || expectedRolloutRevision < 0
      || !Number.isInteger(expectedLaneRevision) || expectedLaneRevision < 0
      || !Number.isSafeInteger(inputVisibilitySequence) || inputVisibilitySequence < 0
      || !/^[a-f0-9]{64}$/i.test(agencySnapshotChecksum)) {
      throw new Error('invalid canonical authority input');
    }
    const lineageKey = deriveAuthorityLineageKey({
      roleId: envelope.characterId,
      laneKey,
      rootSourceId
    });

    return this.withImmediateTransaction(() => {
      const exactTurn = this.getTurn(envelope.turnId);
      if (exactTurn) {
        if (exactTurn.envelopeChecksum !== envelopeChecksum
          || exactTurn.resultAuthorityVersion !== 1
          || exactTurn.authorityLineageKey !== lineageKey
          || exactTurn.rolloutKey !== rolloutKey
          || exactTurn.laneKey !== laneKey
          || exactTurn.inputUserBatchId !== inputUserBatchId
          || Number(exactTurn.inputVisibilitySequence) !== inputVisibilitySequence
          || Number(exactTurn.laneRevision) !== expectedLaneRevision + 1
          || Number(exactTurn.rolloutRevision) !== expectedRolloutRevision
          || exactTurn.authoritativeReleaseId !== String(input.authoritativeReleaseId || '')
          || String(exactTurn.comparisonReleaseId || '') !== String(input.comparisonReleaseId || '')
          || String(exactTurn.comparisonMode === 'none' ? '' : exactTurn.comparisonMode)
            !== String(input.comparisonDirection || '')
          || exactTurn.agencySnapshotChecksum !== agencySnapshotChecksum
          || contentHash(exactTurn.annotationSnapshot || {})
            !== contentHash(input.annotationSnapshot || {})) {
          throw new Error('canonical turn authority conflict');
        }
        const receipt = this.getVisibleCommitReceipt(lineageKey);
        return receipt
          ? { status: 'already_committed', receipt }
          : { status: 'created', turn: exactTurn };
      }

      let validatedRetry = null;
      if (retry) {
        const parent = this.getTurn(retry.retryOfTurnId);
        if (!parent || parent.resultAuthorityVersion !== 1
          || !parent.authorityLineageKey || parent.authorityLineageKey !== lineageKey) {
          throw new Error('canonical retry parent invariant conflict');
        }
        const parentEnvelope = parseJson(parent.envelopeJson, {});
        const parentMessage = parentEnvelope.message;
        const canonicalBatch = value => value?.context?.currentBatch
          ? value.context.currentBatch
          : value?.message
            ? {
                batchId: value.message.messageId,
                messageIds: [value.message.messageId],
                startedAt: value.message.sentAt,
                committedAt: value.message.sentAt,
                messages: [value.message]
              }
            : null;
        if (!parentMessage
          || parent.sourceMessageId !== retry.canonicalMessageId
          || envelope.message?.messageId !== retry.canonicalMessageId
          || envelope.message?.content !== parentMessage.content
          || Number(envelope.message?.sentAt) !== Number(parentMessage.sentAt)
          || contentHash(canonicalBatch(envelope)) !== contentHash(canonicalBatch(parentEnvelope))) {
          throw new Error('retry canonical batch conflict');
        }
        const inheritedComparisonDirection = parent.comparisonMode === 'none'
          ? null
          : parent.comparisonMode;
        if (Number(input.expectedRolloutRevision) !== parent.rolloutRevision
          || String(input.authoritativeReleaseId || '') !== String(parent.authoritativeReleaseId || '')
          || String(input.comparisonReleaseId || '') !== String(parent.comparisonReleaseId || '')
          || String(input.comparisonDirection || '') !== String(inheritedComparisonDirection || '')
          || inputVisibilitySequence !== Number(parent.inputVisibilitySequence)
          || inputUserBatchId !== parent.inputUserBatchId
          || contentHash(input.annotationSnapshot || {})
            !== contentHash(parent.annotationSnapshot || {})) {
          throw new Error('canonical retry immutable authority conflict');
        }
        const lineage = this.getTurnAuthorityLineage(parent.authorityLineageKey);
        if (!lineage) throw new Error('canonical retry lineage invariant conflict');
        if (lineage.state === 'committed') {
          const receipt = this.getVisibleCommitReceipt(lineage.lineageKey);
          if (!receipt) throw new Error('committed lineage receipt invariant conflict');
          return { status: 'already_committed', receipt };
        }
        validatedRetry = { parent, lineage };
      }

      const lane = this.getInteractionLane(envelope.characterId, laneKey);
      const actualLaneRevision = Number(lane?.revision || 0);
      if (actualLaneRevision !== expectedLaneRevision) {
        throw new Error('interaction lane revision conflict');
      }
      if (envelope.protocolVersion === 2
        && inputVisibilitySequence !== Number(lane?.localSequence || 0)) {
        throw new Error('protocol v2 input visibility sequence authority conflict');
      }
      if (inputVisibilitySequence < Number(lane?.localSequence || 0)) {
        throw new Error('input visibility sequence is behind lane authority');
      }

      let pinned;
      let lineageRevision = 1;
      let retryOfTurnId = null;
      if (retry) {
        const { parent, lineage } = validatedRetry;
        if (lineage.state !== 'open' || lineage.latestTurnId !== parent.turnId) {
          throw new Error('retry lineage authority conflict');
        }
        pinned = {
          pipelineMode: parent.pipelineMode,
          presetVersion: parent.presetVersion,
          rolloutRevision: parent.rolloutRevision,
          rolloutEvidenceEpoch: parent.rolloutEvidenceEpoch,
          pipelineChecksum: parent.pipelineChecksum,
          shadowEpoch: parent.shadowEpoch,
          canaryEpoch: parent.canaryEpoch,
          canarySlot: parent.canarySlot,
          comparisonMode: parent.comparisonMode,
          authoritativeReleaseId: parent.authoritativeReleaseId,
          comparisonReleaseId: parent.comparisonReleaseId,
          authoritativePipelineChecksum: parent.authoritativePipelineChecksum,
          comparisonPipelineChecksum: parent.comparisonPipelineChecksum
        };
        lineageRevision = lineage.revision + 1;
        retryOfTurnId = parent.turnId;
      } else {
        const rolloutRow = this.db.prepare(
          'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
        ).get(rolloutKey);
        if (!rolloutRow || Number(rolloutRow.revision) !== expectedRolloutRevision) {
          throw new RolloutRevisionConflictError();
        }
        const phase = String(rolloutRow.candidate_phase || 'none');
        const visibleReleaseId = phase === 'canary'
          ? rolloutRow.candidate_release_id
          : rolloutRow.stable_release_id;
        const comparisonReleaseId = phase === 'shadow'
          ? rolloutRow.candidate_release_id
          : phase === 'canary'
            ? rolloutRow.stable_release_id
            : null;
        const comparisonDirection = phase === 'shadow'
          ? 'stable_authoritative_candidate_compare'
          : phase === 'canary'
            ? 'candidate_authoritative_stable_compare'
            : null;
        if (String(input.authoritativeReleaseId || '') !== String(visibleReleaseId || '')
          || String(input.comparisonReleaseId || '') !== String(comparisonReleaseId || '')
          || String(input.comparisonDirection || '') !== String(comparisonDirection || '')) {
          throw new RolloutRevisionConflictError('rollout release pair conflict');
        }
        const authoritativeRelease = this.getPipelineRelease(visibleReleaseId);
        const comparisonRelease = comparisonReleaseId
          ? this.getPipelineRelease(comparisonReleaseId)
          : null;
        if (!authoritativeRelease || (comparisonReleaseId && !comparisonRelease)) {
          throw new Error('canonical release authority is unavailable');
        }
        const existingLineage = this.getTurnAuthorityLineage(lineageKey);
        if (existingLineage) {
          if (existingLineage.state === 'committed') {
            const receipt = this.getVisibleCommitReceipt(lineageKey);
            if (!receipt) throw new Error('committed lineage receipt invariant conflict');
            return { status: 'already_committed', receipt };
          }
          throw new Error('canonical lineage already has an open turn');
        }
        pinned = {
          pipelineMode: phase === 'canary' ? 'active' : phase === 'shadow' ? 'shadow' : 'legacy',
          presetVersion: authoritativeRelease.presetVersion,
          rolloutRevision: Number(rolloutRow.revision),
          rolloutEvidenceEpoch: Number(rolloutRow.evidence_epoch),
          pipelineChecksum: authoritativeRelease.releaseChecksum,
          shadowEpoch: phase === 'shadow' ? Number(rolloutRow.shadow_epoch) : null,
          canaryEpoch: phase === 'canary' ? Number(rolloutRow.canary_epoch) : null,
          canarySlot: phase === 'canary' ? Number(rolloutRow.canary_started_count) + 1 : null,
          comparisonMode: comparisonDirection || 'none',
          authoritativeReleaseId: authoritativeRelease.releaseId,
          comparisonReleaseId: comparisonRelease?.releaseId || null,
          authoritativePipelineChecksum: authoritativeRelease.releaseChecksum,
          comparisonPipelineChecksum: comparisonRelease?.releaseChecksum || null
        };
        if (phase === 'canary') {
          const outstanding = Number(rolloutRow.canary_started_count)
            - Number(rolloutRow.canary_completed_count)
            - Number(rolloutRow.canary_failure_count);
          if (outstanding >= Number(rolloutRow.canary_max_outstanding)) {
            throw new Error('canary outstanding authority limit reached');
          }
          const reservation = this.db.prepare(`
            UPDATE cognition_kind_rollouts
            SET revision = revision + 1,
                canary_started_count = canary_started_count + 1,
                canary_started_at = COALESCE(canary_started_at, ?),
                updated_at = ?
            WHERE rollout_key = ? AND revision = ?
              AND (
                canary_started_count - canary_completed_count - canary_failure_count
              ) < canary_max_outstanding
          `).run(now(), now(), rolloutKey, expectedRolloutRevision);
          if (Number(reservation.changes) !== 1) {
            throw new RolloutRevisionConflictError('canary reservation conflict');
          }
        }
      }

      const agencyEffectiveAt = Number(
        envelope.message?.sentAt
        ?? envelope.trigger?.executedAt
        ?? envelope.trigger?.scheduledFor
        ?? envelope.createdAt
      );
      const agencySnapshot = this.readAgencyAuthoritySnapshotInternal({
        roleId: envelope.characterId,
        at: agencyEffectiveAt
      });
      if (agencySnapshot.checksum !== agencySnapshotChecksum) {
        throw new Error('agency snapshot authority conflict');
      }
      const timestamp = now();
      this.db.prepare(`
        INSERT INTO turns(
          turn_id, character_id, device_id, device_seq, source_message_id,
          state, origin, envelope_json, envelope_checksum, created_at, updated_at,
          pipeline_mode, preset_version, annotation_snapshot_json,
          rollout_key, comparison_mode, rollout_revision, rollout_evidence_epoch,
          pipeline_checksum, shadow_epoch, canary_epoch, canary_slot,
          authoritative_release_id, comparison_release_id,
          authoritative_pipeline_checksum, comparison_pipeline_checksum,
          lane_key, lane_revision, input_visibility_sequence, generation_fingerprint,
          result_authority_version, authority_lineage_key,
          lineage_revision_at_creation, turn_revision, retry_of_turn_id,
          input_user_batch_id, agency_snapshot_checksum
        ) VALUES (
          ?, ?, ?, ?, ?, 'queued', 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, 1, ?, ?, ?
        )
      `).run(
        envelope.turnId,
        envelope.characterId,
        envelope.deviceId,
        envelope.deviceSeq,
        rootSourceId,
        canonicalJson(envelope),
        envelopeChecksum,
        envelope.createdAt,
        timestamp,
        pinned.pipelineMode,
        pinned.presetVersion,
        canonicalJson(input.annotationSnapshot || {}),
        rolloutKey,
        pinned.comparisonMode,
        pinned.rolloutRevision,
        pinned.rolloutEvidenceEpoch,
        pinned.pipelineChecksum,
        pinned.shadowEpoch,
        pinned.canaryEpoch,
        pinned.canarySlot,
        pinned.authoritativeReleaseId,
        pinned.comparisonReleaseId,
        pinned.authoritativePipelineChecksum,
        pinned.comparisonPipelineChecksum,
        laneKey,
        expectedLaneRevision + 1,
        inputVisibilitySequence,
        lineageKey,
        lineageRevision,
        retryOfTurnId,
        inputUserBatchId,
        agencySnapshotChecksum
      );

      if (!retry && envelope.message) {
        this.putMessageInternal({
          ...envelope.message,
          turnId: envelope.turnId,
          characterId: envelope.characterId,
          origin: 'phone',
          deviceId: envelope.deviceId,
          deviceSeq: envelope.deviceSeq
        });
      }
      if (envelope.message) this.putCurrentUserBatchInternal(envelope);

      if (retry) {
        const updated = this.db.prepare(`
          UPDATE turn_authority_lineages
          SET latest_turn_id = ?, revision = revision + 1, updated_at = ?
          WHERE lineage_key = ? AND latest_turn_id = ? AND revision = ?
            AND state = 'open'
        `).run(
          envelope.turnId,
          timestamp,
          lineageKey,
          retryOfTurnId,
          lineageRevision - 1
        );
        if (Number(updated.changes) !== 1) throw new Error('retry lineage authority conflict');
      } else {
        this.db.prepare(`
          INSERT INTO turn_authority_lineages(
            lineage_key, role_id, lane_key, root_source_id, latest_turn_id,
            revision, state, committed_group_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 1, 'open', NULL, ?, ?)
        `).run(
          lineageKey,
          envelope.characterId,
          laneKey,
          rootSourceId,
          envelope.turnId,
          timestamp,
          timestamp
        );
      }
      this.claimInteractionLaneInternal({
        roleId: envelope.characterId,
        laneKey,
        expectedRevision: expectedLaneRevision,
        generatingTurnId: envelope.turnId,
        latestUserBatchId: inputUserBatchId,
        localSequence: inputVisibilitySequence,
        now: timestamp
      });
      const turn = this.getTurn(envelope.turnId);
      this.appendSync('turn', envelope.turnId, 'insert', turn);
      return { status: 'created', turn, agencySnapshot };
    });
  }

  readCommitAuthority({ turnId, authorityLineageKey, laneKey }) {
    const turn = this.getTurn(turnId);
    return {
      turn,
      lineage: this.getTurnAuthorityLineage(authorityLineageKey),
      lane: turn ? this.getInteractionLane(turn.characterId, laneKey) : null,
      cognitiveState: turn ? this.getCognitiveState(turn.characterId) : null
    };
  }

  resolveCanonicalTargetRefInternal({ turn, namespace, targetId }) {
    const safeNamespace = String(namespace || '');
    const safeTargetId = String(targetId || '');
    const allowed = new Set([
      'conversation', 'message', 'payment', 'moment', 'comment', 'role_plan',
      'role_occurrence', 'life_episode', 'relationship', 'lineage_create'
    ]);
    if (!allowed.has(safeNamespace)) throw new Error('unknown canonical target namespace');
    if (!safeTargetId) throw new Error('canonical action target not found');
    const envelope = parseJson(turn.envelopeJson, {});
    const context = envelope.context || envelope.featureContext || {};
    const inputSnapshot = (candidate, idKeys) => {
      if (!candidate || typeof candidate !== 'object') return null;
      const candidateId = idKeys.map(key => candidate[key]).find(value => value != null);
      if (String(candidateId || '') !== safeTargetId) return null;
      return structuredClone(candidate);
    };
    const inputResult = snapshot => ({
      targetKey: `${safeNamespace}:${safeTargetId}`,
      targetRevision: `sha256:${contentHash(snapshot)}`,
      authoritySource: 'input_snapshot',
      canonicalTarget: snapshot
    });

    if (safeNamespace === 'lineage_create') {
      const prefix = `${turn.authorityLineageKey}:`;
      if (!safeTargetId.startsWith(prefix) || safeTargetId.length === prefix.length) {
        throw new Error('canonical action target identity conflict');
      }
      const lineage = this.getTurnAuthorityLineage(turn.authorityLineageKey);
      if (!lineage) throw new Error('canonical lineage target not found');
      return {
        targetKey: `lineage_create:${safeTargetId}`,
        targetRevision: String(lineage.revision),
        authoritySource: 'pc_store',
        canonicalTarget: {
          lineageKey: turn.authorityLineageKey,
          actionKind: safeTargetId.slice(prefix.length),
          revision: lineage.revision
        }
      };
    }
    if (safeNamespace === 'conversation') {
      const expectedId = `${turn.characterId}:${turn.deviceId}`;
      if (safeTargetId !== expectedId) throw new Error('canonical action target identity conflict');
      const lane = this.getInteractionLane(turn.characterId, turn.laneKey);
      if (!lane) throw new Error('canonical conversation target not found');
      return {
        targetKey: `conversation:${expectedId}`,
        targetRevision: String(lane.revision),
        authoritySource: 'pc_store',
        canonicalTarget: {
          roleId: turn.characterId,
          peerId: turn.deviceId,
          laneKey: turn.laneKey,
          laneRevision: lane.revision
        }
      };
    }
    if (safeNamespace === 'message') {
      const candidates = [
        envelope.message,
        ...(context.currentBatch?.messages || [])
      ];
      const snapshot = candidates.map(candidate =>
        inputSnapshot(candidate, ['messageId'])).find(Boolean);
      if (!snapshot) throw new Error('canonical action target identity conflict');
      return inputResult(snapshot);
    }
    if (safeNamespace === 'payment') {
      const direct = [context.pendingPayment, context.payment]
        .map(candidate => inputSnapshot(candidate, ['messageId']))
        .find(Boolean);
      const batchPayment = (context.currentBatch?.messages || [])
        .map(message => {
          if (String(message?.messageId || '') !== safeTargetId || !message?.payment) return null;
          return { messageId: message.messageId, payment: message.payment };
        }).find(Boolean);
      const snapshot = direct || batchPayment;
      if (!snapshot) throw new Error('canonical action target identity conflict');
      return inputResult(snapshot);
    }
    if (safeNamespace === 'moment' || safeNamespace === 'comment') {
      const title = safeNamespace[0].toUpperCase() + safeNamespace.slice(1);
      const idKey = `${safeNamespace}Id`;
      const candidates = [
        context[`target${title}`],
        context[safeNamespace],
        context[idKey] == null ? null : { [idKey]: context[idKey] }
      ];
      const snapshot = candidates.map(candidate =>
        inputSnapshot(candidate, [idKey])).find(Boolean);
      if (!snapshot) throw new Error('canonical action target identity conflict');
      return inputResult(snapshot);
    }
    if (safeNamespace === 'life_episode') {
      const episode = this.getLifeEpisode(safeTargetId);
      if (!episode || episode.characterId !== turn.characterId) {
        throw new Error('canonical life episode target not found');
      }
      return {
        targetKey: `life_episode:${safeTargetId}`,
        targetRevision: `sha256:${episode.checksum}`,
        authoritySource: 'pc_store',
        canonicalTarget: episode
      };
    }
    if (safeNamespace === 'relationship') {
      if (safeTargetId !== turn.characterId) {
        throw new Error('canonical action target identity conflict');
      }
      const relationship = context.relationship
        || context.relationshipState
        || context.scene?.relationshipStage
        || envelope.featureContext?.relationship
        || null;
      if (!relationship) throw new Error('canonical relationship target not found');
      return {
        targetKey: `relationship:${turn.characterId}`,
        targetRevision: `sha256:${contentHash(relationship)}`,
        authoritySource: 'input_snapshot',
        canonicalTarget: structuredClone(relationship)
      };
    }
    const table = safeNamespace === 'role_plan' ? 'role_plans' : 'role_occurrences';
    const idName = safeNamespace === 'role_plan' ? 'plan_id' : 'occurrence_id';
    const contextTarget = safeNamespace === 'role_plan'
      ? context.rolePlan
      : context.roleOccurrence;
    const tableExists = this.db.prepare(
      'SELECT 1 AS value FROM sqlite_master WHERE type = ? AND name = ?'
    ).get('table', table);
    const row = tableExists
      ? this.db.prepare(`SELECT * FROM ${table} WHERE ${idName} = ?`).get(safeTargetId)
      : null;
    if (row) {
      const owner = String(row.character_id ?? row.role_id ?? '');
      if (owner && owner !== turn.characterId) throw new Error('canonical target role authority conflict');
      return {
        targetKey: `${safeNamespace}:${safeTargetId}`,
        targetRevision: String(row.revision ?? row.updated_at ?? row.checksum ?? 0),
        authoritySource: 'pc_store',
        canonicalTarget: structuredClone(row)
      };
    }
    const idKeys = safeNamespace === 'role_plan'
      ? ['rolePlanId', 'planId', 'plan_id']
      : ['occurrenceId', 'occurrence_id'];
    const target = inputSnapshot(contextTarget, idKeys);
    if (!target) throw new Error('canonical action target identity conflict');
    const owner = String(target.characterId ?? target.roleId ?? target.character_id ?? target.role_id ?? '');
    if (owner && owner !== turn.characterId) throw new Error('canonical target role authority conflict');
    return inputResult(target);
  }

  resolveCanonicalActionTargetInternal({ turn, action }) {
    const kind = String(action?.kind || '');
    const namespaceByKind = {
      payment_accept: 'payment',
      payment_decline: 'payment',
      moment_create: 'lineage_create',
      moment_like: 'moment',
      moment_comment: 'moment',
      moment_reply: 'comment',
      role_plan_create: 'lineage_create',
      role_plan_update: 'role_plan',
      role_plan_cancel: 'role_plan',
      role_plan_pause: 'role_plan',
      role_plan_resume: 'role_plan',
      role_plan_complete: 'role_plan',
      life_episode_create: 'lineage_create',
      life_episode_update: 'life_episode',
      life_episode_cancel: 'life_episode',
      relationship_transition: 'relationship'
    };
    const namespace = namespaceByKind[kind];
    if (!namespace) throw new Error('unknown canonical action target kind');
    const payload = action.payload || {};
    const targetId = namespace === 'lineage_create'
      ? `${turn.authorityLineageKey}:${kind}`
      : namespace === 'payment'
        ? payload.messageId
        : namespace === 'moment'
          ? payload.momentId
          : namespace === 'comment'
            ? payload.commentId
            : namespace === 'role_plan'
              ? payload.rolePlanId
              : namespace === 'life_episode'
                ? payload.episodeId
                : namespace === 'relationship'
                  ? turn.characterId
                  : null;
    if (!targetId) throw new Error(`canonical ${namespace} target not found`);
    return this.resolveCanonicalTargetRefInternal({
      turn,
      namespace,
      targetId
    });
  }

  visibleGroupsForLineage(lineageKey) {
    return this.db.prepare(
      'SELECT * FROM visible_result_groups WHERE lineage_key = ? ORDER BY created_at'
    ).all(String(lineageKey || '')).map(row => ({
      visibleGroupId: row.group_id,
      authorityLineageKey: row.lineage_key,
      authoritativeTurnId: row.authoritative_turn_id,
      roleId: row.role_id,
      laneKey: row.lane_key,
      authorityOrigin: row.authority_origin,
      authoritativeReleaseId: row.authoritative_release_id,
      generationFingerprint: row.generation_fingerprint,
      replyChecksum: row.reply_checksum,
      createdAt: Number(row.created_at),
      redactedAt: row.redacted_at ?? null
    }));
  }

  visibleItemsForGroup(groupId) {
    return this.db.prepare(
      'SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal'
    ).all(String(groupId || '')).map(row => ({
      visibleGroupId: row.group_id,
      ordinal: Number(row.ordinal),
      messageId: row.message_id,
      item: parseJson(row.item_json, {}),
      itemChecksum: row.item_checksum
    }));
  }

  actionsForGroup(groupId) {
    return this.db.prepare(
      'SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal'
    ).all(String(groupId || '')).map(row => ({
      visibleGroupId: row.group_id,
      ordinal: Number(row.ordinal),
      actionId: row.action_id,
      kind: row.action_kind,
      targetKey: row.target_key,
      targetRevision: row.target_revision,
      action: parseJson(row.action_json, {}),
      actionChecksum: row.action_checksum
    }));
  }

  memoryJobsForGroup(groupId) {
    return this.db.prepare(
      'SELECT * FROM consolidation_jobs WHERE authority_group_id = ? ORDER BY authority_ordinal'
    ).all(String(groupId || '')).map(mapConsolidationJob).filter(job =>
      !['shadow_cognition', 'active_canary_compare'].includes(job.jobType));
  }

  comparisonJobsForGroup(groupId) {
    return this.db.prepare(
      'SELECT * FROM consolidation_jobs WHERE authority_group_id = ? ORDER BY authority_ordinal'
    ).all(String(groupId || '')).map(mapConsolidationJob).filter(job =>
      ['shadow_cognition', 'active_canary_compare'].includes(job.jobType));
  }

  outboxForGroup(groupId) {
    return this.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE authority_group_id = ? ORDER BY peer_id'
    ).all(String(groupId || '')).map(mapCloudDelivery);
  }

  outboxForTurn(turnId) {
    return this.listCloudDeliveries(turnId);
  }

  visibleDeliveryPayload(groupId, peerId) {
    this.assertVisibleAuthorityV12Invariants();
    const authority = this.db.prepare(`
      SELECT
        d.authority_group_id, d.peer_id, d.recovery_ack_seq,
        d.authority_commit_checksum, r.lineage_key, r.authoritative_turn_id,
        r.authority_origin, r.commit_payload_version, r.commit_checksum,
        g.role_id, g.lane_key, g.authoritative_release_id,
        g.generation_fingerprint
      FROM cloud_deliveries d
      JOIN visible_commit_receipts r
        ON r.group_id = d.authority_group_id
       AND r.commit_checksum = d.authority_commit_checksum
      JOIN visible_result_groups g
        ON g.group_id = r.group_id
       AND g.lineage_key = r.lineage_key
       AND g.authoritative_turn_id = r.authoritative_turn_id
      WHERE d.authority_group_id = ? AND d.peer_id = ?
    `).get(String(groupId || ''), String(peerId || ''));
    if (!authority) throw new Error('canonical cloud delivery authority conflict');
    const items = this.visibleItemsForGroup(authority.authority_group_id).map(item => ({
      ...item.item,
      messageId: item.messageId,
      ordinal: item.ordinal
    }));
    const actions = this.actionsForGroup(authority.authority_group_id).map(action => ({
      ...action.action,
      actionId: action.actionId,
      ordinal: action.ordinal,
      kind: action.kind,
      targetKey: action.targetKey,
      targetRevision: action.targetRevision
    }));
    return {
      ok: true,
      terminal: true,
      state: 'committed',
      turnId: authority.authoritative_turn_id,
      authorityLineageKey: authority.lineage_key,
      visibleGroupId: authority.authority_group_id,
      authorityOrigin: authority.authority_origin,
      commitPayloadVersion: authority.commit_payload_version,
      commitChecksum: authority.commit_checksum,
      generationFingerprint: authority.generation_fingerprint,
      authoritativeReleaseId: authority.authoritative_release_id,
      roleId: authority.role_id,
      laneKey: authority.lane_key,
      replyParts: items,
      actions,
      recoveryAckSeq: Number(authority.recovery_ack_seq || 0)
    };
  }

  prepareAuthorityCloudDelivery(groupId, peerId, payload) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const existing = this.db.prepare(`
      SELECT d.*, r.commit_checksum AS receipt_checksum
      FROM cloud_deliveries d
      JOIN visible_commit_receipts r ON r.group_id = d.authority_group_id
      WHERE d.authority_group_id = ? AND d.peer_id = ?
    `).get(String(groupId || ''), String(peerId || ''));
    if (!existing || existing.authority_commit_checksum !== existing.receipt_checksum) {
      throw new Error('canonical cloud delivery authority conflict');
    }
    if (existing.checksum && existing.checksum !== checksum) {
      throw new Error('canonical cloud delivery payload checksum conflict');
    }
    if (!['mailboxed', 'confirmed'].includes(existing.state)) {
      this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'pending', payload_json = ?, checksum = ?, updated_at = ?
        WHERE authority_group_id = ? AND peer_id = ?
          AND authority_commit_checksum = ?
      `).run(
        payloadJson,
        checksum,
        now(),
        String(groupId),
        String(peerId),
        existing.receipt_checksum
      );
    }
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = ?
    `).get(String(groupId), String(peerId)));
  }

  markAuthorityCloudDeliveryAttempt(groupId, peerId) {
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET attempts = attempts + 1, updated_at = ?
      WHERE authority_group_id = ? AND peer_id = ? AND state = 'pending'
    `).run(now(), String(groupId || ''), String(peerId || ''));
    if (Number(result.changes) !== 1) throw new Error('pending canonical cloud delivery not found');
  }

  markAuthorityCloudDeliveryMailboxed(groupId, peerId, checksum) {
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed', delivered_at = ?, updated_at = ?
      WHERE authority_group_id = ? AND peer_id = ?
        AND state = 'pending' AND checksum = ?
    `).run(timestamp, timestamp, String(groupId || ''), String(peerId || ''), String(checksum || ''));
    if (Number(result.changes) !== 1) {
      throw new Error('canonical cloud delivery acknowledgement conflict');
    }
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = ?
    `).get(String(groupId), String(peerId)));
  }

  commitVisibleResultInternal(input) {
    const timestamp = Number(input.now || now());
    const turn = this.getTurn(input.turnId);
    const lineage = this.getTurnAuthorityLineage(input.authorityLineageKey);
    const lane = this.getInteractionLane(turn.characterId, input.laneKey);
    const cognitiveState = this.getCognitiveState(turn.characterId);
    const items = Array.isArray(input.visibleGroup?.items) ? input.visibleGroup.items : [];
    const actions = Array.isArray(input.actionSet) ? input.actionSet : [];
    if (!items.length) throw new Error('visible group items are required');
    if (!input.authorityManifest
      || contentHash(input.authorityManifest) !== input.commitChecksum) {
      throw new Error('canonical manifest checksum authority conflict');
    }
    const failAfter = step => {
      if (Number(this.commitFaultAfterStep) === step) {
        throw new Error(`forced commit fault after step ${step}`);
      }
    };

    this.db.prepare(`
      INSERT INTO visible_result_groups(
        group_id, lineage_key, authoritative_turn_id, role_id, lane_key,
        authority_origin, authoritative_release_id, generation_fingerprint,
        reply_checksum, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.groupId,
      input.authorityLineageKey,
      input.turnId,
      turn.characterId,
      input.laneKey,
      input.authorityOrigin,
      input.authoritativeReleaseId,
      input.generationFingerprint,
      contentHash({ items, actions }),
      timestamp
    );
    failAfter(1);

    const itemInsert = this.db.prepare(`
      INSERT INTO visible_result_items(
        group_id, ordinal, message_id, item_json, item_checksum
      ) VALUES (?, ?, ?, ?, ?)
    `);
    items.forEach((item, ordinal) => {
      itemInsert.run(
        input.groupId,
        ordinal,
        deriveVisibleMessageId(input.groupId, ordinal),
        canonicalJson(item),
        contentHash(item)
      );
    });
    failAfter(2);

    const actionInsert = this.db.prepare(`
      INSERT INTO visible_result_actions(
        group_id, ordinal, action_id, action_kind, target_key,
        target_revision, action_json, action_checksum
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    actions.forEach((action, ordinal) => {
      actionInsert.run(
        input.groupId,
        ordinal,
        deriveVisibleActionId(input.groupId, ordinal),
        String(action.kind || ''),
        String(action.targetKey || ''),
        action.targetRevision == null ? null : String(action.targetRevision),
        canonicalJson(action.payload || action),
        contentHash(action)
      );
    });
    failAfter(3);

    const messageInsert = this.db.prepare(`
      INSERT INTO messages(
        message_id, turn_id, character_id, speaker_id, speaker_type,
        recipient_id, content, sent_at, origin, checksum, created_at,
        authority_group_id, group_ordinal
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'codex', ?, ?, ?, ?)
    `);
    items.forEach((item, ordinal) => {
      const messageId = deriveVisibleMessageId(input.groupId, ordinal);
      const projection = {
        messageId,
        content: String(item.content || ''),
        recipientId: String(item.recipientId || 'user')
      };
      messageInsert.run(
        messageId,
        input.turnId,
        turn.characterId,
        String(item.speakerId || turn.characterId),
        String(item.speakerType || 'character'),
        projection.recipientId,
        projection.content,
        timestamp + ordinal,
        contentHash(projection),
        timestamp,
        input.groupId,
        ordinal
      );
    });
    failAfter(4);

    let stateRevisionAfter = Number(cognitiveState?.revision || 0);
    if (input.statePatch) {
      const stateJson = canonicalJson(input.statePatch.state || {});
      const stateChecksum = contentHash(input.statePatch.state || {});
      if (!cognitiveState) {
        if (Number(input.expectedCognitiveStateRevision) !== 0) {
          throw new Error('cognitive state authority conflict');
        }
        this.db.prepare(`
          INSERT INTO cognitive_states(
            role_id, schema_version, revision, last_turn_id, state_json,
            checksum, updated_at, last_authority_group_id
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          turn.characterId,
          Number(input.statePatch.schemaVersion || 2),
          input.turnId,
          stateJson,
          stateChecksum,
          timestamp,
          input.groupId
        );
      } else {
        const update = this.db.prepare(`
          UPDATE cognitive_states
          SET schema_version = ?, revision = revision + 1, last_turn_id = ?,
              state_json = ?, checksum = ?, updated_at = ?, last_authority_group_id = ?
          WHERE role_id = ? AND revision = ?
        `).run(
          Number(input.statePatch.schemaVersion || cognitiveState.schemaVersion),
          input.turnId,
          stateJson,
          stateChecksum,
          timestamp,
          input.groupId,
          turn.characterId,
          Number(input.expectedCognitiveStateRevision)
        );
        if (Number(update.changes) !== 1) throw new Error('cognitive state authority conflict');
      }
      stateRevisionAfter += 1;
    }
    failAfter(5);

    (input.statePatch?.stanceRevisions || []).forEach((stance, ordinal) => {
      this.putStanceRevisionInternal({
        ...stance,
        roleId: turn.characterId,
        sourceTurnId: input.turnId,
        authorityGroupId: input.groupId,
        authorityOrdinal: ordinal
      });
    });
    failAfter(6);

    const memoryInsert = this.db.prepare(`
      INSERT INTO consolidation_jobs(
        job_id, subject_type, subject_id, turn_id, role_id, job_type, state,
        attempt_count, due_at, payload_json, payload_checksum, created_at, updated_at,
        authority_group_id, authority_ordinal
      ) VALUES (?, 'turn', ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?, ?)
    `);
    (input.memoryJobs || []).forEach((job, ordinal) => {
      const payload = job.payload || {};
      memoryInsert.run(
        String(job.jobId || `job_${contentHash({ group: input.groupId, ordinal }).slice(0, 24)}`),
        input.turnId,
        input.turnId,
        turn.characterId,
        String(job.jobType || 'turn_consolidation'),
        timestamp,
        canonicalJson(payload),
        contentHash(payload),
        timestamp,
        timestamp,
        input.groupId,
        ordinal
      );
    });
    failAfter(7);

    if (input.comparisonJob) {
      const job = input.comparisonJob;
      const payload = {
        ...(job.payload || {}),
        authorityGroupId: input.groupId,
        authoritativeResultChecksum: input.commitChecksum
      };
      memoryInsert.run(
        String(job.jobId),
        input.turnId,
        input.turnId,
        turn.characterId,
        String(job.jobType),
        timestamp,
        canonicalJson(payload),
        contentHash(payload),
        timestamp,
        timestamp,
        input.groupId,
        Number((input.memoryJobs || []).length)
      );
    }
    failAfter(8);

    this.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, attempts,
        created_at, updated_at, authority_group_id, authority_commit_checksum
      ) VALUES (?, ?, 0, 'waiting', 0, ?, ?, ?, ?)
    `).run(
      input.turnId,
      turn.deviceId,
      timestamp,
      timestamp,
      input.groupId,
      input.commitChecksum
    );
    failAfter(9);

    const laneUpdate = this.db.prepare(`
      UPDATE interaction_lanes
      SET revision = revision + 1, generating_turn_id = NULL,
          latest_authoritative_group_id = ?, last_commit_checksum = ?, updated_at = ?
      WHERE role_id = ? AND lane_key = ? AND revision = ?
        AND latest_user_batch_id = ? AND local_sequence = ?
    `).run(
      input.groupId,
      input.commitChecksum,
      timestamp,
      turn.characterId,
      input.laneKey,
      Number(input.expectedLaneRevision),
      input.expectedLatestUserBatchId,
      Number(input.inputVisibilitySequence)
    );
    if (Number(laneUpdate.changes) !== 1) throw new Error('lane authority conflict');
    failAfter(10);

    const lineageUpdate = this.db.prepare(`
      UPDATE turn_authority_lineages
      SET state = 'committed', committed_group_id = ?, revision = revision + 1, updated_at = ?
      WHERE lineage_key = ? AND latest_turn_id = ? AND revision = ? AND state = 'open'
    `).run(
      input.groupId,
      timestamp,
      input.authorityLineageKey,
      input.turnId,
      Number(input.expectedLineageRevision)
    );
    if (Number(lineageUpdate.changes) !== 1) throw new Error('lineage authority conflict');
    failAfter(11);

    const turnUpdate = this.db.prepare(`
      UPDATE turns
      SET state = 'committed', reply_json = ?, generation_fingerprint = ?,
          turn_revision = turn_revision + 1, updated_at = ?
      WHERE turn_id = ? AND turn_revision = ? AND result_authority_version = 1
    `).run(
      canonicalJson({ messages: items }),
      input.generationFingerprint,
      timestamp,
      input.turnId,
      Number(input.expectedTurnRevision)
    );
    if (Number(turnUpdate.changes) !== 1) throw new Error('turn authority conflict');
    failAfter(12);

    this.db.prepare(`
      INSERT INTO visible_result_manifests(
        group_id, authority_origin, payload_version, semantic_json,
        semantic_checksum, redacted_at, created_at
      ) VALUES (?, ?, ?, ?, ?, NULL, ?)
    `).run(
      input.groupId,
      input.authorityOrigin,
      input.commitPayloadVersion,
      canonicalJson(input.authorityManifest),
      input.commitChecksum,
      timestamp
    );
    failAfter(13);

    this.db.prepare(`
      INSERT INTO visible_commit_receipts(
        lineage_key, group_id, authoritative_turn_id, authority_origin,
        commit_payload_version, turn_revision_before, turn_revision_after,
        lineage_revision_before, lineage_revision_after,
        lane_revision_before, lane_revision_after,
        cognitive_state_revision_before, cognitive_state_revision_after,
        commit_checksum, committed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.authorityLineageKey,
      input.groupId,
      input.turnId,
      input.authorityOrigin,
      input.commitPayloadVersion,
      Number(input.expectedTurnRevision),
      Number(input.expectedTurnRevision) + 1,
      Number(input.expectedLineageRevision),
      Number(input.expectedLineageRevision) + 1,
      Number(input.expectedLaneRevision),
      Number(input.expectedLaneRevision) + 1,
      Number(input.expectedCognitiveStateRevision),
      stateRevisionAfter,
      input.commitChecksum,
      timestamp
    );
    failAfter(14);
    return {
      ...this.getVisibleCommitReceipt(input.authorityLineageKey),
      committed: true
    };
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
        const stableRelease = this.getPipelineRelease(rollout.stable_release_id);
        const candidateRelease = this.getPipelineRelease(rollout.candidate_release_id);
        if (!stableRelease || !candidateRelease) {
          throw new Error(`cognition rollout release authority is unavailable: ${pin.rolloutKey}`);
        }
        const candidateIsAuthoritative = rollout.current_mode === 'active';
        const authoritativeRelease = candidateIsAuthoritative ? candidateRelease : stableRelease;
        const comparisonRelease = candidateIsAuthoritative ? stableRelease : candidateRelease;
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
          presetVersion: rollout.preset_version,
          authoritativeReleaseId: authoritativeRelease.releaseId,
          comparisonReleaseId: comparisonRelease.releaseId,
          authoritativePipelineChecksum: authoritativeRelease.releaseChecksum,
          comparisonPipelineChecksum: comparisonRelease.releaseChecksum
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
          pipeline_checksum, shadow_epoch, canary_epoch, canary_slot,
          authoritative_release_id, comparison_release_id,
          authoritative_pipeline_checksum, comparison_pipeline_checksum,
          lane_key, lane_revision, input_visibility_sequence, generation_fingerprint
        ) VALUES (
          ?, ?, ?, ?, ?, 'queued', 'codex', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?
        )
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
        effectivePin.canarySlot ?? null,
        effectivePin.authoritativeReleaseId ?? null,
        effectivePin.comparisonReleaseId ?? null,
        effectivePin.authoritativePipelineChecksum ?? null,
        effectivePin.comparisonPipelineChecksum ?? null,
        effectivePin.laneKey ?? null,
        effectivePin.laneRevision ?? null,
        effectivePin.inputVisibilitySequence ?? null,
        effectivePin.generationFingerprint ?? null
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
    const turn = this.getTurn(turnId);
    if (turn?.resultAuthorityVersion === 1) {
      throw new Error('canonical turn route API required');
    }
    const result = this.db.prepare(`
      UPDATE turns SET route = ?, route_reasons_json = ?, updated_at = ? WHERE turn_id = ?
    `).run(route, canonicalJson([...new Set(reasons.map(String))]), now(), turnId);
    if (Number(result.changes) !== 1) throw new Error('turn not found');
    return this.getTurn(turnId);
  }

  assertCanonicalAttemptMutableInternal({
    turnId,
    expectedState,
    expectedTurnRevision,
    operation = 'mutation'
  }) {
    const row = this.db.prepare(`
      SELECT t.state, t.turn_revision, t.result_authority_version,
             l.state AS lineage_state, l.latest_turn_id, l.committed_group_id,
             r.group_id AS receipt_group_id
      FROM turns t
      LEFT JOIN turn_authority_lineages l
        ON l.lineage_key = t.authority_lineage_key
      LEFT JOIN visible_commit_receipts r
        ON r.lineage_key = t.authority_lineage_key
      WHERE t.turn_id = ?
    `).get(String(turnId));
    if (row && (row.state === 'committed'
      || row.lineage_state === 'committed'
      || row.committed_group_id != null
      || row.receipt_group_id != null)) {
      throw new Error('canonical committed authority is immutable');
    }
    if (!row
      || Number(row.result_authority_version) !== 1
      || row.state !== String(expectedState)
      || Number(row.turn_revision) !== Number(expectedTurnRevision)
      || row.lineage_state !== 'open'
      || row.latest_turn_id !== String(turnId)
      || row.committed_group_id != null
      || row.receipt_group_id != null) {
      throw new Error(`canonical turn authority conflict: ${operation}`);
    }
    return {
      turn: this.getTurn(turnId),
      lineage: this.getTurnAuthorityLineage(this.getTurn(turnId).authorityLineageKey)
    };
  }

  setCanonicalTurnRouteInternal({
    turnId,
    expectedState,
    expectedTurnRevision,
    route,
    reasons = []
  }) {
    if (!['fast', 'deep', 'fast_to_deep'].includes(route)) throw new Error('invalid turn route');
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'route'
      });
      const timestamp = now();
      const result = this.db.prepare(`
        UPDATE turns
        SET route = ?, route_reasons_json = ?, turn_revision = turn_revision + 1,
            updated_at = ?
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = ? AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(
        route,
        canonicalJson([...new Set(reasons.map(String))]),
        timestamp,
        String(turnId),
        String(expectedState),
        Number(expectedTurnRevision)
      );
      if (Number(result.changes) !== 1) throw new Error('canonical turn authority conflict');
      const turn = this.getTurn(turnId);
      this.appendSync('turn', turn.turnId, 'update', turn);
      return turn;
    });
  }

  beginStage(turnId, stage, model = null, effort = null, startedAt = now()) {
    if (!String(stage || '').trim()) throw new Error('stage is required');
    const turn = this.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (turn.resultAuthorityVersion === 1) {
      throw new Error('canonical turn stage API required');
    }
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

  beginCanonicalStageInternal({
    turnId,
    expectedState,
    expectedTurnRevision,
    stage,
    model = null,
    effort = null,
    startedAt = now()
  }) {
    if (!String(stage || '').trim()) throw new Error('stage is required');
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'begin_stage'
      });
      const result = this.db.prepare(`
        UPDATE turns
        SET turn_revision = turn_revision + 1, updated_at = ?
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = ? AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(now(), String(turnId), String(expectedState), Number(expectedTurnRevision));
      if (Number(result.changes) !== 1) throw new Error('canonical turn authority conflict');
      const active = this.db.prepare(`
        SELECT * FROM turn_stages
        WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
        ORDER BY ordinal DESC LIMIT 1
      `).get(turnId, stage);
      if (active) throw new Error('canonical stage is already active');
      const ordinal = Number(this.db.prepare(
        'SELECT COALESCE(MAX(ordinal), 0) AS value FROM turn_stages WHERE turn_id = ?'
      ).get(turnId)?.value || 0) + 1;
      this.db.prepare(`
        INSERT INTO turn_stages(turn_id, stage, ordinal, model, effort, started_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(turnId, stage, ordinal, model, effort, Number(startedAt));
      const turn = this.getTurn(turnId);
      const stageRow = mapTurnStage(this.db.prepare(
        'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
      ).get(turnId, stage, ordinal));
      this.appendSync('turn', turn.turnId, 'update', turn);
      return { turn, stage: stageRow };
    });
  }

  finishStage(turnId, stage, finishedAt = now()) {
    const turn = this.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (turn.resultAuthorityVersion === 1) {
      throw new Error('canonical turn stage API required');
    }
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

  finishCanonicalStageInternal({
    turnId,
    expectedState,
    expectedTurnRevision,
    stage,
    finishedAt = now()
  }) {
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'finish_stage'
      });
      const active = this.db.prepare(`
        SELECT * FROM turn_stages
        WHERE turn_id = ? AND stage = ? AND finished_at IS NULL
        ORDER BY ordinal DESC LIMIT 1
      `).get(turnId, stage);
      if (!active) throw new Error('canonical active stage not found');
      const result = this.db.prepare(`
        UPDATE turns
        SET turn_revision = turn_revision + 1, updated_at = ?
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = ? AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(now(), String(turnId), String(expectedState), Number(expectedTurnRevision));
      if (Number(result.changes) !== 1) throw new Error('canonical turn authority conflict');
      const durationMs = Math.max(0, Number(finishedAt) - Number(active.started_at));
      this.db.prepare(`
        UPDATE turn_stages SET finished_at = ?, duration_ms = ?
        WHERE turn_id = ? AND stage = ? AND ordinal = ?
      `).run(Number(finishedAt), durationMs, turnId, stage, active.ordinal);
      const turn = this.getTurn(turnId);
      const stageRow = mapTurnStage(this.db.prepare(
        'SELECT * FROM turn_stages WHERE turn_id = ? AND stage = ? AND ordinal = ?'
      ).get(turnId, stage, active.ordinal));
      this.appendSync('turn', turn.turnId, 'update', turn);
      return { turn, stage: stageRow };
    });
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
    const turn = this.getTurn(turnId);
    if (!turn) throw new Error('turn not found');
    if (turn.resultAuthorityVersion === 1) {
      throw new Error('canonical delivery API required');
    }
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
        AND authority_group_id IS NULL
      ORDER BY updated_at ASC, turn_id ASC, peer_id ASC LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  listPendingAuthorityCloudDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      JOIN visible_commit_receipts r
        ON r.group_id = d.authority_group_id
       AND r.commit_checksum = d.authority_commit_checksum
       AND r.authoritative_turn_id = d.turn_id
      JOIN visible_result_groups g
        ON g.group_id = r.group_id
       AND g.lineage_key = r.lineage_key
       AND g.authoritative_turn_id = r.authoritative_turn_id
      WHERE d.state IN ('waiting', 'pending')
        AND d.authority_group_id IS NOT NULL
        AND r.authority_origin = 'pc'
      ORDER BY d.updated_at ASC, d.authority_group_id ASC, d.peer_id ASC
      LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  recoverFailedDraft(turnId, { peerId, sentAt = null } = {}) {
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    if (current.resultAuthorityVersion === 1) {
      throw new Error('canonical turn API required for failed draft recovery');
    }
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
    if (current.resultAuthorityVersion === 1) {
      throw new Error('canonical turn API required for transient requeue');
    }
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
    if (current.resultAuthorityVersion === 1) {
      throw new Error('canonical turn API required for usage-limit requeue');
    }
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
    if (existing.authority_group_id != null) throw new Error('canonical delivery API required');
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

  assertLegacyCloudDeliveryInternal(turnId, peerId) {
    const row = this.db.prepare(`
      SELECT authority_group_id FROM cloud_deliveries
      WHERE turn_id = ? AND peer_id = ?
    `).get(String(turnId), String(peerId));
    if (!row) throw new Error('cloud delivery not found');
    if (row.authority_group_id != null) throw new Error('canonical delivery API required');
  }

  markCloudDeliveryAttempt(turnId, peerId) {
    this.assertLegacyCloudDeliveryInternal(turnId, peerId);
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET attempts = attempts + 1, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending'
        AND authority_group_id IS NULL
    `).run(now(), turnId, peerId);
    if (Number(result.changes) !== 1) throw new Error('pending cloud delivery not found');
  }

  markCloudDeliveryDelivered(turnId, peerId, checksum) {
    return this.markCloudDeliveryMailboxed(turnId, peerId, checksum);
  }

  markCloudDeliveryMailboxed(turnId, peerId, checksum) {
    this.assertLegacyCloudDeliveryInternal(turnId, peerId);
    const timestamp = now();
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET state = 'mailboxed', delivered_at = ?, updated_at = ?
      WHERE turn_id = ? AND peer_id = ? AND state = 'pending' AND checksum = ?
        AND authority_group_id IS NULL
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
    if (turn?.resultAuthorityVersion === 1) {
      throw new Error('canonical delivery API required');
    }
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
    const delivery = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, String(peerId));
    if (!delivery) throw new Error('cloud delivery not found');
    if (delivery.authority_group_id != null) throw new Error('canonical delivery API required');
    const deliveryState = this.recordDeliveryReceipt(receipt);
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
    if (delivery.authority_group_id != null) throw new Error('canonical delivery API required');
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
          AND authority_group_id IS NULL
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

  claimCanonicalTurnInternal({ turnId, workerId, expectedTurnRevision }) {
    if (!workerId) throw new Error('workerId is required');
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState: 'queued',
        expectedTurnRevision,
        operation: 'claim'
      });
      const result = this.db.prepare(`
        UPDATE turns
        SET state = 'memory_running', worker_id = ?, updated_at = ?,
            turn_revision = turn_revision + 1
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = 'queued' AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(String(workerId), now(), String(turnId), Number(expectedTurnRevision));
      if (Number(result.changes) !== 1) {
        throw new Error('canonical turn authority conflict');
      }
      const turn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', turn);
      return turn;
    });
  }

  advanceCanonicalTurnInternal({
    turnId,
    expectedState,
    nextState,
    expectedTurnRevision,
    patch = {}
  }) {
    if (!TURN_STATES.includes(expectedState) || !TURN_STATES.includes(nextState)) {
      throw new Error('unknown turn state');
    }
    const canonicalForwardEdges = new Map([
      ['memory_running', 'memory_done'],
      ['memory_done', 'brain_running'],
      ['brain_running', 'brain_done'],
      ['brain_done', 'supervisor_running'],
      ['supervisor_running', 'approved']
    ]);
    const assignments = [
      'state = ?',
      'updated_at = ?',
      'turn_revision = turn_revision + 1'
    ];
    const values = [nextState, now()];
    for (const [key, value] of Object.entries(patch || {})) {
      const column = TURN_PATCH_COLUMNS.get(key);
      if (!column) throw new Error(`unsupported turn patch: ${key}`);
      assignments.push(`${column} = ?`);
      values.push(value);
    }
    values.push(String(turnId), expectedState, Number(expectedTurnRevision));
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'advance'
      });
      if (canonicalForwardEdges.get(expectedState) !== nextState) {
        throw new Error('canonical transition authority conflict');
      }
      const result = this.db.prepare(`
        UPDATE turns SET ${assignments.join(', ')}
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = ? AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(...values);
      if (Number(result.changes) !== 1) {
        throw new Error('canonical turn authority conflict');
      }
      const turn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', turn);
      return turn;
    });
  }

  recordCanonicalTurnFailureInternal({
    turnId,
    expectedState,
    expectedTurnRevision,
    failure
  }) {
    if (!TURN_STATES.includes(expectedState)) throw new Error('unknown turn state');
    const normalizedFailure = {
      ...structuredClone(failure || {}),
      failureClass: String(failure?.failureClass || 'terminal')
    };
    return this.withImmediateTransaction(() => {
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'failure'
      });
      const result = this.db.prepare(`
        UPDATE turns
        SET state = 'failed', worker_id = NULL, error_json = ?, updated_at = ?,
            turn_revision = turn_revision + 1
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = ? AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(
        canonicalJson(normalizedFailure),
        now(),
        String(turnId),
        expectedState,
        Number(expectedTurnRevision)
      );
      if (Number(result.changes) !== 1) {
        throw new Error('canonical turn authority conflict');
      }
      const turn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', turn);
      return turn;
    });
  }

  requeueCanonicalFailedTurnInternal({
    turnId,
    expectedTurnRevision,
    allowedFailureClass
  }) {
    return this.withImmediateTransaction(() => {
      const { turn: current } = this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState: 'failed',
        expectedTurnRevision,
        operation: 'requeue'
      });
      const failure = parseJson(current.errorJson, {});
      if (String(failure.failureClass || '') !== String(allowedFailureClass || '')) {
        throw new Error('canonical turn authority conflict');
      }
      const checkpoint = current.brainDraftJson
        ? 'brain_done'
        : current.memoryPacketJson
          ? 'memory_done'
          : 'queued';
      const result = this.db.prepare(`
        UPDATE turns
        SET state = ?, worker_id = NULL, error_json = NULL,
            brain_draft_json = CASE
              WHEN ? = 'memory_done' OR ? = 'queued' THEN NULL
              ELSE brain_draft_json
            END,
            supervisor_json = NULL, reply_json = NULL, updated_at = ?,
            turn_revision = turn_revision + 1
        WHERE turn_id = ? AND result_authority_version = 1
          AND state = 'failed' AND turn_revision = ?
          AND EXISTS (
            SELECT 1 FROM turn_authority_lineages l
            WHERE l.lineage_key = turns.authority_lineage_key
              AND l.state = 'open' AND l.latest_turn_id = turns.turn_id
              AND l.committed_group_id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM visible_commit_receipts r
            WHERE r.lineage_key = turns.authority_lineage_key
          )
      `).run(
        checkpoint,
        checkpoint,
        checkpoint,
        now(),
        String(turnId),
        Number(expectedTurnRevision)
      );
      if (Number(result.changes) !== 1) {
        throw new Error('canonical turn authority conflict');
      }
      const turn = this.getTurn(turnId);
      this.appendSync('turn', turnId, 'state', turn);
      return turn;
    });
  }

  cancelCanonicalTurnRowsInternal({
    turnId,
    authorityLineageKey,
    expectedTurnRevision,
    expectedLineageRevision,
    reasonCode,
    supersededByTurnId = null,
    timestamp = now()
  }) {
    const turnResult = this.db.prepare(`
      UPDATE turns
      SET state = 'failed', worker_id = NULL, error_json = ?, updated_at = ?,
          turn_revision = turn_revision + 1
      WHERE turn_id = ? AND result_authority_version = 1
        AND authority_lineage_key = ? AND reply_json IS NULL
        AND turn_revision = ?
    `).run(
      canonicalJson({
        code: String(reasonCode || 'CANONICAL_CANCELLED'),
        ...(supersededByTurnId ? { supersededByTurnId: String(supersededByTurnId) } : {})
      }),
      Number(timestamp),
      String(turnId),
      String(authorityLineageKey),
      Number(expectedTurnRevision)
    );
    if (Number(turnResult.changes) !== 1) {
      throw new Error('canonical turn authority conflict');
    }
    const lineageResult = this.db.prepare(`
      UPDATE turn_authority_lineages
      SET state = 'cancelled', revision = revision + 1, updated_at = ?
      WHERE lineage_key = ? AND latest_turn_id = ? AND state = 'open'
        AND revision = ?
    `).run(
      Number(timestamp),
      String(authorityLineageKey),
      String(turnId),
      Number(expectedLineageRevision)
    );
    if (Number(lineageResult.changes) !== 1) {
      throw new Error('canonical turn authority conflict');
    }
    return {
      turn: this.getTurn(turnId),
      lineage: this.getTurnAuthorityLineage(authorityLineageKey)
    };
  }

  cancelCanonicalTurnInternal(input) {
    return this.withImmediateTransaction(() => {
      const result = this.cancelCanonicalTurnRowsInternal(input);
      this.appendSync('turn', result.turn.turnId, 'state', result.turn);
      return result;
    });
  }

  claimTurn(workerId) {
    if (!workerId) throw new Error('workerId is required');
    return this.transaction(() => {
      const row = this.db.prepare(
        `SELECT turn_id FROM turns
         WHERE state = 'queued' AND result_authority_version = 0
         ORDER BY created_at, turn_id LIMIT 1`
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
    const current = this.getTurn(turnId);
    if (current?.resultAuthorityVersion === 1) {
      throw new Error('canonical turn API required for claim');
    }
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
    if (current.resultAuthorityVersion === 1) {
      throw new Error('canonical turn API required for state advance');
    }
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
    const ownerTurn = message?.turnId ? this.getTurn(message.turnId) : null;
    if (ownerTurn?.resultAuthorityVersion === 1
      && String(message?.speakerType || '') === 'character') {
      throw new Error('canonical visible result API required');
    }
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

  getLifeBasisChecksum(roleId, { from = null, to = null } = {}) {
    const episodes = this.listLifeEpisodes(roleId, { from, to })
      .filter(item => item.status !== 'cancelled')
      .map(item => ({ episodeId: item.episodeId, checksum: item.checksum, status: item.status }));
    const state = this.getCharacterLifeState(roleId);
    return contentHash({
      roleId: String(roleId),
      revision: Number(state?.revision || 0),
      episodes
    });
  }

  getLifePlanningAttempt(planningId) {
    return mapLifePlanningAttempt(this.db.prepare(
      'SELECT * FROM cognition_life_planning_attempts WHERE planning_id = ?'
    ).get(String(planningId || '')));
  }

  getOpenLifePlanningAttempt(roleId) {
    return mapLifePlanningAttempt(this.db.prepare(`
      SELECT * FROM cognition_life_planning_attempts
      WHERE role_id = ?
        AND execution_state IN ('created', 'running', 'retry_wait', 'result_committed')
      ORDER BY planning_revision DESC LIMIT 1
    `).get(String(roleId || '')));
  }

  getLifePlanningAttemptByRequestKey(requestKey) {
    return mapLifePlanningAttempt(this.db.prepare(
      'SELECT * FROM cognition_life_planning_attempts WHERE request_key = ?'
    ).get(String(requestKey || '')));
  }

  createLifePlanningAttemptInternal(attempt) {
    const roleId = String(attempt?.roleId || '');
    if (!roleId) throw new Error('life planning role is required');
    const existingOpen = this.getOpenLifePlanningAttempt(roleId);
    if (existingOpen) return existingOpen;
    const exact = this.getLifePlanningAttemptByRequestKey(attempt.requestKey);
    if (exact) return exact;
    const revision = Number(this.db.prepare(`
      SELECT COALESCE(MAX(planning_revision), 0) + 1 AS next_revision
      FROM cognition_life_planning_attempts WHERE role_id = ?
    `).get(roleId)?.next_revision || 1);
    const planningId = `lifeplan:${roleId}:${revision}`;
    const timestamp = Number(attempt.now || now());
    const inputSnapshotJson = canonicalJson(attempt.inputSnapshot || {});
    const inputChecksum = contentHash(attempt.inputSnapshot || {});
    const comparisonMode = String(attempt.comparisonMode || 'none');
    this.db.prepare(`
      INSERT INTO cognition_life_planning_attempts(
        planning_id, request_base_key, request_key, role_id, planning_revision,
        planning_window_start_at, planning_window_end_at, life_basis_checksum,
        context_checksum, rollout_key, pipeline_mode, comparison_mode,
        authoritative_pipeline, comparison_direction, rollout_revision,
        rollout_evidence_epoch, pipeline_checksum, shadow_epoch, canary_epoch,
        canary_slot, preset_version, input_snapshot_json, input_checksum,
        execution_state, comparison_state, attempt_count, due_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIFE_PLANNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'created', ?, 0, ?, ?, ?)
    `).run(
      planningId, attempt.requestBaseKey, attempt.requestKey, roleId, revision,
      Number(attempt.planningWindowStartAt), Number(attempt.planningWindowEndAt),
      attempt.lifeBasisChecksum, attempt.contextChecksum, attempt.pipelineMode,
      comparisonMode, attempt.authoritativePipeline, attempt.comparisonDirection || null,
      Number(attempt.rolloutRevision), Number(attempt.rolloutEvidenceEpoch),
      attempt.pipelineChecksum, attempt.shadowEpoch ?? null, attempt.canaryEpoch ?? null,
      attempt.canarySlot ?? null, attempt.presetVersion, inputSnapshotJson, inputChecksum,
      comparisonMode === 'none' ? 'not_applicable' : 'not_ready',
      Number(attempt.dueAt || timestamp), timestamp, timestamp
    );
    return this.getLifePlanningAttempt(planningId);
  }

  claimDueLifePlanningAttempt({ workerId, now: claimAt = now(), leaseMs = 300_000 }) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM cognition_life_planning_attempts
        WHERE due_at <= ? AND (
          execution_state IN ('created', 'retry_wait')
          OR (execution_state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
        )
        ORDER BY due_at, created_at, planning_id LIMIT 1
      `).get(Number(claimAt), Number(claimAt));
      if (!row) return null;
      const result = this.db.prepare(`
        UPDATE cognition_life_planning_attempts
        SET execution_state = 'running', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE planning_id = ? AND (
          execution_state IN ('created', 'retry_wait')
          OR (execution_state = 'running' AND COALESCE(lease_expires_at, 0) <= ?)
        )
      `).run(
        String(workerId), Number(claimAt) + Number(leaseMs), Number(claimAt),
        row.planning_id, Number(claimAt)
      );
      return Number(result.changes) === 1 ? this.getLifePlanningAttempt(row.planning_id) : null;
    });
  }

  retryLifePlanningAttempt({ planningId, workerId, errorCode, nextDueAt, now: retryAt = now() }) {
    const result = this.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET execution_state = 'retry_wait', due_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = ?, updated_at = ?
      WHERE planning_id = ? AND execution_state = 'running' AND lease_owner = ?
    `).run(Number(nextDueAt), String(errorCode || 'RETRYABLE'), Number(retryAt), planningId, workerId);
    if (Number(result.changes) !== 1) throw new Error('life planning attempt lease mismatch');
    return this.getLifePlanningAttempt(planningId);
  }

  recoverExpiredLifePlanningAttempts({ now: recoveredAt = now() } = {}) {
    const result = this.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET execution_state = 'retry_wait', due_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = 'LEASE_RECOVERED', updated_at = ?
      WHERE execution_state = 'running' AND COALESCE(lease_expires_at, 0) <= ?
    `).run(Number(recoveredAt), Number(recoveredAt), Number(recoveredAt));
    return Number(result.changes || 0);
  }

  commitLifePlanningResultInternal({ planningId, workerId, validatedResult, now: committedAt = now() }) {
    const attempt = this.getLifePlanningAttempt(planningId);
    if (!attempt) throw new Error('life planning attempt not found');
    const result = {
      episodes: (validatedResult?.episodes || []).map((item, index) => ({
        ...item,
        episodeId: `life:${planningId}:${index + 1}`
      }))
    };
    const checksum = contentHash(result);
    if (attempt.authoritativeResultChecksum) {
      if (attempt.authoritativeResultChecksum !== checksum) throw new LifePlanningResultConflictError();
      return attempt;
    }
    if (attempt.executionState !== 'running' || attempt.leaseOwner !== workerId) {
      throw new Error('life planning attempt lease mismatch');
    }
    const currentBasis = this.getLifeBasisChecksum(attempt.roleId, {
      from: attempt.planningWindowStartAt,
      to: attempt.planningWindowEndAt
    });
    if (currentBasis !== attempt.lifeBasisChecksum) {
      this.db.prepare(`
        UPDATE cognition_life_planning_attempts
        SET execution_state = 'cancelled', comparison_state = ?,
            lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'LIFE_BASIS_STALE', completed_at = ?, updated_at = ?
        WHERE planning_id = ?
      `).run(
        attempt.comparisonMode === 'none' ? 'not_applicable' : 'cancelled',
        Number(committedAt), Number(committedAt), planningId
      );
      return this.getLifePlanningAttempt(planningId);
    }
    this.putLifePlanInternal(attempt.roleId, result.episodes, { sourceTurnId: planningId });
    let compareJob = null;
    if (attempt.comparisonMode !== 'none') {
      compareJob = this.createConsolidationJobInternal({
        subjectType: 'life_planning',
        subjectId: planningId,
        roleId: attempt.roleId,
        jobType: attempt.comparisonMode === 'cognition_compare'
          ? 'shadow_cognition'
          : 'active_canary_compare',
        payload: {
          subjectType: 'life_planning',
          subjectId: planningId,
          turnId: null,
          rolloutKey: 'LIFE_PLANNING',
          rolloutRevision: attempt.rolloutRevision,
          rolloutEvidenceEpoch: attempt.rolloutEvidenceEpoch,
          shadowEpoch: attempt.shadowEpoch,
          canaryEpoch: attempt.canaryEpoch,
          canarySlot: attempt.canarySlot,
          comparisonDirection: attempt.comparisonDirection,
          authoritativePipeline: attempt.authoritativePipeline,
          comparisonPipeline: attempt.authoritativePipeline === 'legacy' ? 'cognition' : 'legacy',
          authoritativeResultChecksum: checksum,
          inputChecksum: attempt.inputChecksum,
          pipelineChecksum: attempt.pipelineChecksum,
          presetVersion: attempt.presetVersion
        },
        createdAt: committedAt
      });
    }
    this.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET execution_state = ?, comparison_state = ?,
          authoritative_result_json = ?, authoritative_result_checksum = ?,
          compare_job_id = ?, result_committed_at = ?, completed_at = ?,
          lease_owner = NULL, lease_expires_at = NULL, last_error_code = NULL, updated_at = ?
      WHERE planning_id = ?
    `).run(
      compareJob ? 'result_committed' : 'completed',
      compareJob ? 'queued' : 'not_applicable',
      canonicalJson(result), checksum, compareJob?.jobId || null,
      Number(committedAt), compareJob ? null : Number(committedAt),
      Number(committedAt), planningId
    );
    return this.getLifePlanningAttempt(planningId);
  }

  failLifePlanningAttemptInternal({
    planningId, workerId, errorCode, now: failedAt = now()
  }) {
    const attempt = this.getLifePlanningAttempt(planningId);
    if (!attempt) throw new Error('life planning attempt not found');
    const result = this.db.prepare(`
      UPDATE cognition_life_planning_attempts
      SET execution_state = 'failed', comparison_state = ?, lease_owner = NULL,
          lease_expires_at = NULL, last_error_code = ?, completed_at = ?, updated_at = ?
      WHERE planning_id = ? AND execution_state = 'running' AND lease_owner = ?
        AND authoritative_result_checksum IS NULL AND compare_job_id IS NULL
    `).run(
      attempt.comparisonMode === 'none' ? 'not_applicable' : 'cancelled',
      String(errorCode || 'LIFE_PLANNING_FAILED'), Number(failedAt), Number(failedAt),
      planningId, workerId
    );
    if (Number(result.changes) !== 1) throw new Error('life planning attempt lease mismatch');
    return this.getLifePlanningAttempt(planningId);
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

  putCognitiveStateInternal(roleIdOrState, maybeState = null) {
    const state = typeof roleIdOrState === 'string'
      ? { ...(maybeState || {}), roleId: roleIdOrState }
      : roleIdOrState;
    const roleId = String(state?.roleId || '');
    const revision = Number(state?.revision);
    const schemaVersion = Number(state?.schemaVersion || 1);
    const lastTurnId = String(state?.lastTurnId || '');
    if (!roleId || !lastTurnId || !Number.isInteger(revision) || revision < 1) {
      throw new CognitiveStateConflictError('invalid cognitive state identity');
    }
    if (schemaVersion === 2) {
      const expected = ['fastState', 'mediumState', 'slowState'];
      const keys = Object.keys(state?.state || {}).sort();
      if (canonicalJson(keys) !== canonicalJson(expected)) {
        throw new CognitiveStateConflictError('cognitive state v2 time-scale shape is invalid');
      }
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
