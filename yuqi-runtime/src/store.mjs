import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  deriveAuthorityLineageKey,
  deriveVisibleActionId,
  deriveVisibleGroupId,
  deriveVisibleMessageId
} from './authority-identity.mjs';
import { resolveCurrentUserBatch } from './current-user-batch.mjs';
import { stableId } from './cloud-relay-pump.mjs';
import { decideLaneAdmission, generationFingerprint, laneKeyForEnvelope } from './interaction-lanes.mjs';
import { resolvePipelinePair } from './release-pair.mjs';
import {
  comparisonContractForDirection,
  comparisonContractForMode
} from './comparison-contract.mjs';
import {
  projectCanonicalFailureForWire,
  projectCanonicalFailureSnapshotForWire,
  projectBridgeResultForWire
} from './bridge-result-projector.mjs';
import {
  buildProactiveMotiveAuthority,
  motiveIdForSource,
  proactiveMotiveSourceContext
} from './life-simulation.mjs';
import {
  currentBatchEvidenceAuthorityProjection,
  validateConsolidationCandidate
} from './evidence-memory.mjs';
import {
  TURN_STATES,
  canonicalJson,
  contentHash,
  deliveryItemsForResult,
  authorityLaneKeyForEnvelope,
  validateAuthorityDeliveryReceipt,
  validateDeliveryReceipt,
  validateConversationClearApplied,
  validateEnvelope,
  validateConversationClearControl
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
const FAILURE_DELIVERY_LEASE_MS = 60_000;
const TRUSTED_LIFE_RESULT_WRITER = Symbol('trusted-life-result-writer');

const MEMORY_SOURCE_ORIGINS = new Set(['consolidation', 'legacy', 'memory']);
const MEMORY_CONFIG_ORIGINS = new Set(['author', 'system', 'preset', 'global']);

function classifyMemoryFactAuthority(fact) {
  const origin = typeof fact?.origin === 'string' ? fact.origin.trim() : '';
  if (MEMORY_SOURCE_ORIGINS.has(origin)) return { kind: 'source', origin };
  if (!MEMORY_CONFIG_ORIGINS.has(origin)) throw new Error('memory fact origin authority conflict');
  const keys = ['authority', 'evidenceMode', 'sourceConfigRef', 'sourceMessageIds', 'sourceActionIds'];
  if (fact?.authority !== origin || fact?.evidenceMode !== 'config'
    || typeof fact?.sourceConfigRef !== 'string' || !fact.sourceConfigRef.trim()
    || !Array.isArray(fact?.sourceMessageIds) || fact.sourceMessageIds.length !== 0
    || !Array.isArray(fact?.sourceActionIds || []) || (fact.sourceActionIds || []).length !== 0) {
    throw new Error('memory fact closed config authority conflict');
  }
  const exactConfigRef = fact.sourceConfigRef.trim();
  if (exactConfigRef !== fact.sourceConfigRef || exactConfigRef.length > 256) {
    throw new Error('memory fact config source authority conflict');
  }
  return { kind: 'config', origin };
}

function factRedactionSetCommitment({ controlId, roleId, entries }) {
  return contentHash({
    auditVersion: 'fact-redaction-set-v1',
    controlId: String(controlId),
    roleId: String(roleId),
    facts: [...entries].map(entry => ({
      factId: entry.factId,
      oldChecksum: entry.oldChecksum,
      newChecksum: entry.newChecksum,
      replacementFactId: entry.replacementFactId ?? null
    })).sort((left, right) => left.factId.localeCompare(right.factId))
  });
}

function validateTrustedPublicMomentCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort())
      !== canonicalJson(['summary', 'version', 'visibility'])
    || value.version !== 'public-moment-candidate-v1'
    || value.visibility !== 'public'
    || typeof value.summary !== 'string'
    || value.summary.trim() !== value.summary
    || value.summary.length < 1 || value.summary.length > 280) {
    throw new Error('public moment candidate authority conflict');
  }
  return value;
}

function lifePlanningContextChecksum(inputSnapshot) {
  return contentHash({
    cognitiveState: inputSnapshot?.cognitiveState || {},
    allowedActions: inputSnapshot?.allowedActions || []
  });
}

function assertLifePlanningValidatedResultShape(validatedResult) {
  if (!validatedResult || typeof validatedResult !== 'object' || Array.isArray(validatedResult)
    || canonicalJson(Object.keys(validatedResult).sort()) !== canonicalJson(['episodes'])
    || !Array.isArray(validatedResult.episodes)) {
    throw new Error('life planning result authority conflict');
  }
  return validatedResult;
}

function assertLifePlanningInputSnapshotBinding(attempt) {
  const snapshot = attempt?.inputSnapshot;
  const planningWindow = snapshot?.planningWindow;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.roleId !== attempt.roleId
    || !planningWindow || typeof planningWindow !== 'object' || Array.isArray(planningWindow)
    || canonicalJson(Object.keys(planningWindow).sort())
      !== canonicalJson(['startAt', 'targetEndAt'])
    || planningWindow.startAt !== attempt.planningWindowStartAt
    || planningWindow.targetEndAt !== attempt.planningWindowEndAt
    || !Number.isSafeInteger(snapshot.planningAnchorAt)
    || snapshot.planningAnchorAt < 0
    || snapshot.planningAnchorAt !== planningWindow.startAt) {
    throw new Error('life planning evidence authority conflict');
  }
  if (!Object.hasOwn(snapshot, 'current')) {
    throw new Error('life planning input authority conflict: current');
  }
  const validateReferenceShape = (reference, name) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || typeof reference.episodeId !== 'string' || !reference.episodeId.trim()
      || typeof reference.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(reference.checksum)) {
      throw new Error(`life planning input authority conflict: ${name}`);
    }
  };
  if (snapshot.current !== null) validateReferenceShape(snapshot.current, 'current');
  for (const name of ['recent', 'upcoming']) {
    if (!Array.isArray(snapshot[name])) {
      throw new Error(`life planning input authority conflict: ${name}`);
    }
    snapshot[name].forEach((reference, index) => validateReferenceShape(reference, `${name}[${index}]`));
  }
}

function assertLifePlanningInputAuthority(attempt, store) {
  assertLifePlanningInputSnapshotBinding(attempt);
  const snapshot = attempt.inputSnapshot;
  const seenEpisodeIds = new Set();
  const anchor = snapshot.planningAnchorAt;
  const validateReference = (reference, name, group) => {
    if (reference === null) return;
    const persisted = store.getLifeEpisode(reference.episodeId);
    if (!persisted || persisted.characterId !== attempt.roleId
      || persisted.status === 'cancelled'
      || persisted.checksum !== reference.checksum
      || canonicalJson(Object.keys(reference).sort())
        !== canonicalJson(Object.keys(persisted).sort())
      || canonicalJson(reference) !== canonicalJson(persisted)) {
      throw new Error(`life planning input authority conflict: ${name}`);
    }
    if ((group === 'current' && !(persisted.startAt <= anchor && anchor < persisted.endAt))
      || (group === 'recent' && persisted.endAt > anchor)
      || (group === 'upcoming' && persisted.startAt <= anchor)) {
      throw new Error(`life planning input authority conflict: ${name}`);
    }
    if (seenEpisodeIds.has(reference.episodeId)) {
      throw new Error(`life planning input authority conflict: duplicate ${reference.episodeId}`);
    }
    seenEpisodeIds.add(reference.episodeId);
  };
  validateReference(snapshot.current, 'current', 'current');
  for (const name of ['recent', 'upcoming']) {
    snapshot[name].forEach((reference, index) => validateReference(
      reference, `${name}[${index}]`, name
    ));
  }
}

const LIFE_PLANNING_REUSE_FIELDS = [
  'roleId',
  'requestBaseKey',
  'requestKey',
  'planningWindowStartAt',
  'planningWindowEndAt',
  'lifeBasisChecksum',
  'contextChecksum',
  'rolloutKey',
  'pipelineMode',
  'comparisonMode',
  'authoritativePipeline',
  'comparisonDirection',
  'rolloutRevision',
  'rolloutEvidenceEpoch',
  'pipelineChecksum',
  'shadowEpoch',
  'canaryEpoch',
  'authoritativeReleaseId',
  'comparisonReleaseId',
  'authoritativePipelineChecksum',
  'comparisonPipelineChecksum',
  'presetVersion'
];

function assertLifePlanningAttemptReuseIdentity(stored, incoming) {
  if (!stored || !incoming) throw new Error('life planning attempt authority conflict');
  assertLifePlanningAttemptEvidence(stored);
  const incomingInputChecksum = incoming.inputChecksum
    || contentHash(incoming.inputSnapshot || {});
  for (const field of LIFE_PLANNING_REUSE_FIELDS) {
    if (canonicalJson(stored[field] ?? null) !== canonicalJson(incoming[field] ?? null)) {
      throw new Error(`life planning attempt authority conflict: ${field}`);
    }
  }
  if (stored.inputChecksum !== incomingInputChecksum
    || canonicalJson(stored.inputSnapshot || {})
      !== canonicalJson(incoming.inputSnapshot || {})) {
    throw new Error('life planning attempt authority conflict: input snapshot');
  }
}

function assertLifePlanningAttemptEvidence(attempt) {
  assertLifePlanningInputSnapshotBinding(attempt);
  const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  if (!checksum(attempt?.lifeBasisChecksum)
    || !checksum(attempt?.contextChecksum)
    || !checksum(attempt?.inputChecksum)
    || contentHash(attempt.inputSnapshot || {}) !== attempt.inputChecksum
    || lifePlanningContextChecksum(attempt.inputSnapshot || {}) !== attempt.contextChecksum) {
    throw new Error('life planning evidence authority conflict');
  }
  const expectedRequestBaseKey = contentHash({
    roleId: attempt.roleId,
    startAt: attempt.planningWindowStartAt,
    endAt: attempt.planningWindowEndAt,
    lifeBasisChecksum: attempt.lifeBasisChecksum,
    contextChecksum: attempt.contextChecksum
  });
  if (expectedRequestBaseKey !== attempt.requestBaseKey) {
    throw new Error('life planning basis authority conflict');
  }
}

const LIFE_EPISODE_PROJECTION_KEYS = Object.freeze([
  'episodeId', 'characterId', 'kind', 'title', 'startAt', 'endAt',
  'status', 'payload', 'checksum', 'sourceTurnId', 'adjustmentReason',
  'createdAt', 'updatedAt'
]);

function assertLifePlanningSnapshotEpisodeProjection(reference, roleId, name) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || canonicalJson(Object.keys(reference).sort())
      !== canonicalJson([...LIFE_EPISODE_PROJECTION_KEYS].sort())
    || reference.characterId !== roleId
    || typeof reference.episodeId !== 'string' || !reference.episodeId
    || typeof reference.kind !== 'string' || !reference.kind
    || typeof reference.title !== 'string' || !reference.title
    || !Number.isSafeInteger(reference.startAt) || reference.startAt < 0
    || !Number.isSafeInteger(reference.endAt) || reference.endAt <= reference.startAt
    || !['planned', 'active', 'completed', 'cancelled'].includes(reference.status)
    || !reference.payload || typeof reference.payload !== 'object'
      || Array.isArray(reference.payload)
    || typeof reference.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(reference.checksum)
    || !(reference.sourceTurnId === null
      || (typeof reference.sourceTurnId === 'string' && reference.sourceTurnId.length > 0))
    || typeof reference.adjustmentReason !== 'string'
    || !Number.isSafeInteger(reference.createdAt) || reference.createdAt < 0
    || !Number.isSafeInteger(reference.updatedAt) || reference.updatedAt < 0
    || contentHash({
      episodeId: reference.episodeId,
      characterId: reference.characterId,
      kind: reference.kind,
      title: reference.title,
      startAt: reference.startAt,
      endAt: reference.endAt,
      payload: reference.payload
    }) !== reference.checksum) {
    throw new Error(`life planning attempt authority conflict: ${name}`);
  }
}

function assertLifePlanningSnapshotAuthority(attempt) {
  assertLifePlanningAttemptEvidence(attempt);
  const snapshot = attempt.inputSnapshot;
  const seenEpisodeIds = new Set();
  const validateReference = (reference, name) => {
    if (reference === null) return;
    assertLifePlanningSnapshotEpisodeProjection(reference, attempt.roleId, name);
    if (seenEpisodeIds.has(reference.episodeId)) {
      throw new Error(`life planning attempt authority conflict: duplicate ${reference.episodeId}`);
    }
    seenEpisodeIds.add(reference.episodeId);
  };
  validateReference(snapshot.current, 'current');
  for (const name of ['recent', 'upcoming']) {
    snapshot[name].forEach((reference, index) => validateReference(reference, `${name}[${index}]`));
  }
}

function assertLifePlanningAttemptPins(attempt, store) {
  assertLifePlanningSnapshotAuthority(attempt);
  const checksum = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const safeNullable = value => value === null
    || (Number.isSafeInteger(value) && value >= 0);
  if (attempt.rolloutKey !== 'LIFE_PLANNING'
    || !['legacy', 'shadow', 'active'].includes(attempt.pipelineMode)
    || !['none', 'cognition_compare', 'legacy_compare'].includes(attempt.comparisonMode)
    || !['legacy', 'cognition'].includes(attempt.authoritativePipeline)
    || (attempt.pipelineMode === 'active' && attempt.authoritativePipeline !== 'cognition')
    || (attempt.pipelineMode !== 'active' && attempt.authoritativePipeline !== 'legacy')
    || !Number.isSafeInteger(attempt.rolloutRevision) || attempt.rolloutRevision < 0
    || !Number.isSafeInteger(attempt.rolloutEvidenceEpoch) || attempt.rolloutEvidenceEpoch < 0
    || !safeNullable(attempt.shadowEpoch) || !safeNullable(attempt.canaryEpoch)
    || !safeNullable(attempt.canarySlot)
    || !checksum(attempt.pipelineChecksum)
    || !checksum(attempt.authoritativePipelineChecksum)
    || !checksum(attempt.requestBaseKey)
    || !checksum(attempt.requestKey)
    || !checksum(attempt.lifeBasisChecksum)
    || !checksum(attempt.contextChecksum)
    || typeof attempt.presetVersion !== 'string' || !attempt.presetVersion) {
    throw new Error('life planning attempt authority conflict: pins');
  }
  const authoritativeRelease = store.getPipelineRelease(attempt.authoritativeReleaseId);
  if (!authoritativeRelease
    || authoritativeRelease.releaseChecksum !== attempt.authoritativePipelineChecksum
    || attempt.pipelineChecksum !== authoritativeRelease.releaseChecksum
    || attempt.presetVersion !== authoritativeRelease.presetVersion) {
    throw new Error('life planning attempt authority conflict: authoritative release');
  }
  if (attempt.comparisonMode === 'none') {
    if (attempt.comparisonDirection !== null
      || attempt.comparisonReleaseId !== null
      || attempt.comparisonPipelineChecksum !== null
      || attempt.comparisonState !== 'not_applicable') {
      throw new Error('life planning attempt authority conflict: comparison pins');
    }
    return;
  }
  let comparison;
  try {
    comparison = comparisonContractForMode(attempt.comparisonMode);
  } catch {
    throw new Error('life planning attempt authority conflict: comparison contract');
  }
  const comparisonRelease = store.getPipelineRelease(attempt.comparisonReleaseId);
  if (!comparisonRelease
    || attempt.comparisonDirection !== comparison.comparisonDirection
    || comparisonRelease.releaseChecksum !== attempt.comparisonPipelineChecksum
    || !['not_ready', 'queued', 'running', 'completed', 'failed', 'cancelled']
      .includes(attempt.comparisonState)) {
    throw new Error('life planning attempt authority conflict: comparison pins');
  }
}

function canonicalEffectiveAtFromEnvelope(envelope) {
  const value = Number(
    envelope?.message?.sentAt
    ?? envelope?.trigger?.executedAt
    ?? envelope?.trigger?.scheduledFor
    ?? envelope?.createdAt
  );
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function assertCognitiveStateOpenThreadProjection({
  state,
  semanticPatch,
  protocolVersion,
  authoritativeTurnId,
  envelope,
  errorMessage = 'cognitive state authority conflict'
}) {
  if (!semanticPatch) throw new Error(errorMessage);
  const rawIds = Array.isArray(semanticPatch.openThreads) ? semanticPatch.openThreads : [];
  const expectedIds = rawIds.map(item =>
    typeof item === 'string' ? item.trim() : String(item?.threadId || '').trim()
  );
  if (expectedIds.some(id => !id) || new Set(expectedIds).size !== expectedIds.length) {
    throw new Error(errorMessage);
  }
  const fastState = state && typeof state.fastState === 'object' && !Array.isArray(state.fastState)
    ? state.fastState
    : {};
  if (canonicalJson(fastState.openThreadIds || []) !== canonicalJson(expectedIds)) {
    throw new Error(errorMessage);
  }
  if (Number(protocolVersion) !== 3) {
    if (Object.hasOwn(fastState, 'openThreads')) throw new Error(errorMessage);
    return;
  }
  const effectiveAt = canonicalEffectiveAtFromEnvelope(envelope);
  const rich = fastState.openThreads;
  const keys = ['lastTouchedAt', 'sourceTurnId', 'summary', 'threadId'];
  if (!Number.isSafeInteger(effectiveAt) || !Array.isArray(rich)
    || rich.length !== expectedIds.length) throw new Error(errorMessage);
  rich.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || canonicalJson(Object.keys(item).sort()) !== canonicalJson(keys)
      || item.threadId !== expectedIds[index]
      || item.summary !== expectedIds[index]
      || item.sourceTurnId !== authoritativeTurnId
      || typeof item.lastTouchedAt !== 'number'
      || !Number.isSafeInteger(item.lastTouchedAt)
      || item.lastTouchedAt !== effectiveAt) {
      throw new Error(errorMessage);
    }
  });
}

export class InteractionLaneBusyError extends Error {
  constructor(message = 'interaction lane is busy') {
    super(message);
    this.name = 'InteractionLaneBusyError';
    this.code = 'INTERACTION_LANE_BUSY';
    this.retryable = true;
  }
}

function stableFailureId(prefix, value) {
  return `${prefix}_${createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)}`;
}
const CANONICAL_RESULT_TURN_KINDS = new Set([
  'DIRECT_REPLY',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);
const PUBLIC_MOMENT_LANE_KINDS = new Set([
  'PROACTIVE_MOMENT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_MOMENT_PRIVATE'
]);

function expectedCanonicalCharacterRecipient({ protocolVersion, turnKind, payloadVersion }) {
  if (Number(protocolVersion) !== 3 || !PUBLIC_MOMENT_LANE_KINDS.has(turnKind)) return 'user';
  if (turnKind === 'PROACTIVE_MOMENT' && payloadVersion !== 'pc-visible-commit-v4') {
    return 'user';
  }
  return 'public_moments';
}
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

export {
  deriveAuthorityLineageKey,
  deriveVisibleActionId,
  deriveVisibleGroupId,
  deriveVisibleMessageId
} from './authority-identity.mjs';

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function assertOrdinalCommitmentRows(rows, field, label, start = 0) {
  const ordered = [...rows].sort((left, right) => Number(left[field]) - Number(right[field]));
  ordered.forEach((row, index) => {
    if (Number(row[field]) !== index + start) {
      throw new Error(`${label} commitment sequence conflict`);
    }
  });
  return ordered;
}

function requireCommitmentField(row, field, label) {
  if (!row || !Object.hasOwn(row, field)) {
    throw new Error(`${label} commitment conflict: missing ${field}`);
  }
  return row[field];
}

function requireCommitmentText(value, label) {
  const text = typeof value === 'string' ? value : '';
  if (!text) throw new Error(`${label} commitment conflict: identity`);
  return text;
}

function requireCommitmentChecksum(value, label) {
  const checksum = typeof value === 'string' ? value : '';
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error(`${label} commitment conflict: checksum`);
  }
  return checksum;
}

function visibleResultTombstoneCommitment({ groupId, itemRows, actionRows }) {
  const items = assertOrdinalCommitmentRows(itemRows, 'ordinal', 'visible item').map(row => ({
    ordinal: Number(requireCommitmentField(row, 'ordinal', 'visible item')),
    messageId: requireCommitmentText(
      requireCommitmentField(row, 'message_id', 'visible item'), 'visible item'
    ),
    itemChecksum: requireCommitmentChecksum(
      requireCommitmentField(row, 'item_checksum', 'visible item'), 'visible item'
    )
  }));
  const actions = assertOrdinalCommitmentRows(actionRows, 'ordinal', 'visible action').map(row => ({
    ordinal: Number(requireCommitmentField(row, 'ordinal', 'visible action')),
    actionId: requireCommitmentText(
      requireCommitmentField(row, 'action_id', 'visible action'), 'visible action'
    ),
    actionChecksum: requireCommitmentChecksum(
      requireCommitmentField(row, 'action_checksum', 'visible action'), 'visible action'
    )
  }));
  if (new Set(items.map(item => item.messageId)).size !== items.length
    || new Set(actions.map(action => action.actionId)).size !== actions.length) {
    throw new Error('visible result commitment conflict: duplicate identity');
  }
  return {
    itemCount: items.length,
    actionCount: actions.length,
    commitment: contentHash({
    version: 'visible-result-tombstone-v1', groupId: requireCommitmentText(groupId, 'visible result'),
    itemCount: items.length, actionCount: actions.length, items, actions
    })
  };
}

function currentUserBatchTombstoneCommitment({ turnId, batchId, itemRows }) {
  const items = assertOrdinalCommitmentRows(itemRows, 'sequence', 'current user batch').map(row => ({
    sequence: Number(requireCommitmentField(row, 'sequence', 'current user batch')),
    messageId: requireCommitmentText(
      requireCommitmentField(row, 'message_id', 'current user batch'), 'current user batch'
    ),
    checksum: requireCommitmentChecksum(
      requireCommitmentField(row, 'checksum', 'current user batch'), 'current user batch'
    )
  }));
  if (new Set(items.map(item => item.messageId)).size !== items.length) {
    throw new Error('current user batch commitment conflict: duplicate identity');
  }
  return {
    itemCount: items.length,
    commitment: contentHash({
    version: 'current-user-batch-tombstone-v1',
    turnId: requireCommitmentText(turnId, 'current user batch'),
    batchId: requireCommitmentText(batchId, 'current user batch'),
    itemCount: items.length, items
    })
  };
}

function authorityRedactionDeliveriesCommitment({ groupId, deliveryRows }) {
  const rows = [...deliveryRows]
    .map(row => {
      if (!Object.hasOwn(row, 'relay_message_id')
        || !Object.hasOwn(row, 'recovery_ack_seq')
        || !Object.hasOwn(row, 'authority_commit_checksum')
        || !Object.hasOwn(row, 'peer_id')) {
        throw new Error('redaction delivery commitment relay message id is required');
      }
      const relayMessageId = row.relay_message_id == null ? null : String(row.relay_message_id);
      const authorityCommitChecksum = String(row.authority_commit_checksum || '');
      const recoveryAckSeq = Number(row.recovery_ack_seq);
      if (!/^[a-f0-9]{64}$/.test(authorityCommitChecksum)
        || !Number.isSafeInteger(recoveryAckSeq) || recoveryAckSeq < 0) {
        throw new Error('redaction delivery commitment checksum conflict');
      }
      return {
        peerId: requireCommitmentText(row.peer_id, 'redaction delivery'),
        relayMessageId,
        recoveryAckSeq,
        authorityCommitChecksum
      };
    })
    .sort((left, right) => left.peerId.localeCompare(right.peerId));
  if (new Set(rows.map(row => row.peerId)).size !== rows.length) {
    throw new Error('redaction delivery commitment duplicate peer conflict');
  }
  return {
    deliveryCount: rows.length,
    commitment: contentHash({
    version: 'authority-redaction-deliveries-v1',
    groupId: requireCommitmentText(groupId, 'redaction delivery'),
    deliveryCount: rows.length, deliveries: rows
    })
  };
}

function authorityLineageAttemptsCommitment({ lineageKey, attemptRows }) {
  const attempts = assertOrdinalCommitmentRows(
    attemptRows, 'lineage_revision_at_creation', 'lineage attempt', 1
  )
    .map(row => ({
      lineageRevisionAtCreation: Number(
        requireCommitmentField(row, 'lineage_revision_at_creation', 'lineage attempt')
      ),
      turnId: requireCommitmentText(
        requireCommitmentField(row, 'turn_id', 'lineage attempt'), 'lineage attempt'
      ),
      turnKind: requireCommitmentText(
        requireCommitmentField(row, 'turn_kind', 'lineage attempt'), 'lineage attempt'
      ),
      retryOfTurnId: requireCommitmentField(row, 'retry_of_turn_id', 'lineage attempt') == null
        ? null : String(row.retry_of_turn_id),
      inputUserBatchId: requireCommitmentField(row, 'input_user_batch_id', 'lineage attempt') == null
        ? null : String(row.input_user_batch_id),
      envelopeChecksum: requireCommitmentChecksum(
        requireCommitmentField(row, 'envelope_checksum', 'lineage attempt'), 'lineage attempt'
      ),
      batchTombstoneCommitment:
        requireCommitmentField(row, 'batch_tombstone_commitment', 'lineage attempt') == null
          ? null : requireCommitmentChecksum(
            row.batch_tombstone_commitment, 'lineage attempt'
          )
    }));
  return {
    attemptCount: attempts.length,
    commitment: contentHash({
    version: 'authority-lineage-attempts-v1',
    lineageKey: requireCommitmentText(lineageKey, 'lineage attempt'),
    attemptCount: attempts.length, attempts
    })
  };
}

function deriveTerminalDisposition(turnKind, itemCount, actionCount) {
  const kind = String(turnKind || '');
  if (kind === 'DIRECT_REPLY') {
    if (itemCount < 1) throw new Error('DIRECT_REPLY requires visible result items');
    return 'visible';
  }
  if (!CANONICAL_RESULT_TURN_KINDS.has(kind)) {
    throw new Error('canonical terminal turn kind conflict');
  }
  if (itemCount > 0) return 'visible';
  if (actionCount > 0) return 'action_only';
  return 'skip';
}

const ANDROID_FALLBACK_CONTRACT = 'cognition-v3-fallback-v1';
const ANDROID_FALLBACK_COMMIT_PAYLOAD_VERSION = 'android-fallback-commit-v2';
const ANDROID_FALLBACK_RECEIPT_VERSION = 2;
const ANDROID_FALLBACK_DISPOSITIONS = new Set(['visible', 'action_only', 'skip']);

function externalObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`external authority ${label} conflict`);
  }
  return value;
}

function externalText(value, label) {
  if (typeof value !== 'string' || !value) throw new Error(`external authority ${label} conflict`);
  return value;
}

function externalNullableText(value, label) {
  if (value === null) return null;
  return externalText(value, label);
}

function externalChecksum(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`external authority ${label} checksum conflict`);
  }
  return value;
}

function externalInteger(value, label, { min = 0 } = {}) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`external authority ${label} conflict`);
  }
  return value;
}

const EXTERNAL_DIRECT_INPUT_KEYS = new Set([
  'kind', 'batch', 'visibilitySequence', 'clearEpoch', 'checksum'
]);
const EXTERNAL_DIRECT_INPUT_WITH_ACTION_KEYS = new Set([
  ...EXTERNAL_DIRECT_INPUT_KEYS, 'pinnedActionContext'
]);
const EXTERNAL_AUTOMATIC_INPUT_KEYS = new Set([
  'kind', 'trigger', 'visibilitySequence', 'clearEpoch', 'checksum'
]);
const EXTERNAL_PINNED_ACTION_CONTEXT_KEYS = new Set([
  'version', 'payment', 'scene', 'input', 'checksum'
]);
const EXTERNAL_PINNED_ACTION_INPUT_KEYS = new Set([
  'targetMoment', 'targetComment', 'rolePlan'
]);
const EXTERNAL_PINNED_MOMENT_KEYS = new Set([
  'momentId', 'authorId', 'ownerId', 'content', 'createdAt', 'revision'
]);
const EXTERNAL_PINNED_COMMENT_KEYS = new Set([
  'commentId', 'momentId', 'authorId', 'ownerId', 'content', 'createdAt',
  'revision', 'replyToCommentId'
]);
const EXTERNAL_PINNED_ROLE_PLAN_KEYS = new Set([
  'planId', 'characterId', 'roleId', 'type', 'source', 'title', 'intent',
  'schedule', 'timeConfidence', 'durationMs', 'origin', 'sourceQuote',
  'evidenceMessageIds', 'status', 'nextRunAt', 'revision', 'updatedAt'
]);

function hasExactExternalKeys(value, expected) {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
}

function normalizeExternalPinnedActionContext(value) {
  const context = externalObject(value, 'pinned action context');
  if (!hasExactExternalKeys(context, EXTERNAL_PINNED_ACTION_CONTEXT_KEYS)
    || context.version !== 1) {
    throw new Error('external authority pinned action context conflict');
  }
  const input = externalObject(context.input, 'pinned action input');
  if (!hasExactExternalKeys(input, EXTERNAL_PINNED_ACTION_INPUT_KEYS)) {
    throw new Error('external authority pinned action input conflict');
  }
  const nullableObject = (entry, label) => {
    if (entry === null) return null;
    return structuredClone(externalObject(entry, label));
  };
  const payment = nullableObject(context.payment, 'pinned payment');
  if (payment !== null) {
    const paymentKeys = new Set(['kind', 'amount', 'note', 'messageId', 'status']);
    if (!hasExactExternalKeys(payment, paymentKeys)
      || !['redpacket', 'transfer'].includes(payment.kind)
      || typeof payment.amount !== 'number' || !Number.isFinite(payment.amount) || payment.amount <= 0
      || typeof payment.note !== 'string'
      || typeof payment.messageId !== 'string' || !payment.messageId
      || payment.status !== 'pending') {
      throw new Error('external authority pinned payment conflict');
    }
  }
  const scene = nullableObject(context.scene, 'pinned relationship scene');
  if (scene !== null) {
    const relationshipStageKeys = new Set([
      'id', 'label', 'content', 'since', 'reason', 'confidence', 'base', 'phase'
    ]);
    const relationshipPartKeys = new Set([
      'id', 'label', 'content', 'since', 'reason', 'confidence'
    ]);
    const assertRelationshipPart = (part, allowed, label) => {
      if (!part || typeof part !== 'object' || Array.isArray(part)
        || Object.keys(part).length === 0
        || Object.keys(part).some(key => !allowed.has(key))) {
        throw new Error(`external authority ${label} conflict`);
      }
      for (const key of ['id', 'label', 'content', 'reason']) {
        if (!Object.hasOwn(part, key)) continue;
        if (typeof part[key] !== 'string'
          || ((key === 'id' || key === 'label') && !part[key])) {
          throw new Error(`external authority ${label} conflict`);
        }
      }
      if (Object.hasOwn(part, 'since')
        && (!Number.isSafeInteger(part.since) || part.since < 0)) {
        throw new Error(`external authority ${label} conflict`);
      }
      if (Object.hasOwn(part, 'confidence')
        && (typeof part.confidence !== 'number' || !Number.isFinite(part.confidence)
          || part.confidence < 0 || part.confidence > 1)) {
        throw new Error(`external authority ${label} conflict`);
      }
    };
    if (!hasExactExternalKeys(scene, new Set(['relationshipStage', 'stagePersonaRevision']))
      || !Number.isSafeInteger(scene.stagePersonaRevision) || scene.stagePersonaRevision < 0) {
      throw new Error('external authority pinned relationship scene conflict');
    }
    assertRelationshipPart(
      scene.relationshipStage, relationshipStageKeys, 'pinned relationship stage');
    for (const key of ['base', 'phase']) {
      if (!Object.hasOwn(scene.relationshipStage, key)) continue;
      const part = scene.relationshipStage[key];
      if (typeof part === 'string') {
        if (!part) throw new Error('external authority pinned relationship stage conflict');
      } else {
        assertRelationshipPart(part, relationshipPartKeys, 'pinned relationship stage part');
      }
    }
  }
  const assertAllowedTarget = (target, allowed, required, label) => {
    if (target === null) return null;
    const keys = Object.keys(target);
    if (keys.some(key => !allowed.has(key)) || required.some(key => !Object.hasOwn(target, key))) {
      throw new Error(`external authority ${label} conflict`);
    }
    const textFields = ['momentId', 'commentId', 'authorId', 'ownerId', 'content',
      'replyToCommentId', 'planId', 'characterId', 'roleId', 'type', 'source', 'title',
      'intent', 'timeConfidence', 'origin', 'sourceQuote', 'status'];
    for (const key of textFields) {
      if (!Object.hasOwn(target, key) || (key === 'replyToCommentId' && target[key] === null)) continue;
      if (typeof target[key] !== 'string'
        || ((key !== 'content' && key !== 'sourceQuote') && !target[key])) {
        throw new Error(`external authority ${label} conflict`);
      }
    }
    for (const key of ['createdAt', 'revision', 'durationMs', 'nextRunAt', 'updatedAt']) {
      if (!Object.hasOwn(target, key) || (key === 'nextRunAt' && target[key] === null)) continue;
      if (!Number.isSafeInteger(target[key]) || target[key] < 0) {
        throw new Error(`external authority ${label} conflict`);
      }
    }
    if (Object.hasOwn(target, 'evidenceMessageIds')
      && (!Array.isArray(target.evidenceMessageIds)
        || target.evidenceMessageIds.length > 12
        || new Set(target.evidenceMessageIds).size !== target.evidenceMessageIds.length
        || target.evidenceMessageIds.some(id => typeof id !== 'string' || !id || id.length > 96))) {
      throw new Error(`external authority ${label} conflict`);
    }
    if (Object.hasOwn(target, 'durationMs') && target.durationMs < 1) {
      throw new Error(`external authority ${label} conflict`);
    }
    const enums = {
      type: new Set(['private_message', 'moment_post', 'role_schedule']),
      source: new Set(['spoken', 'accepted_request', 'private_decision', 'user_created']),
      timeConfidence: new Set(['explicit', 'inferred']),
      origin: new Set(['ai', 'user'])
    };
    for (const [key, allowedValues] of Object.entries(enums)) {
      if (Object.hasOwn(target, key) && !allowedValues.has(target[key])) {
        throw new Error(`external authority ${label} conflict`);
      }
    }
    if (Object.hasOwn(target, 'schedule')) {
      const schedule = target.schedule;
      if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)
        || typeof schedule.kind !== 'string') {
        throw new Error(`external authority ${label} conflict`);
      }
      const requiredByKind = {
        once: ['kind', 'at'], interval: ['kind', 'startsAt', 'intervalMs'],
        daily: ['kind', 'time'], weekly: ['kind', 'weekdays', 'time'],
        monthly: ['kind', 'day', 'time']
      };
      const requiredKeys = requiredByKind[schedule.kind];
      if (!requiredKeys) throw new Error(`external authority ${label} conflict`);
      const scheduleKeys = Object.keys(schedule);
      const allowedScheduleKeys = new Set([...requiredKeys, 'endsAt']);
      if (scheduleKeys.some(key => !allowedScheduleKeys.has(key))
        || requiredKeys.some(key => !Object.hasOwn(schedule, key))) {
        throw new Error(`external authority ${label} conflict`);
      }
      for (const key of ['at', 'startsAt', 'time', 'endsAt']) {
        if (Object.hasOwn(schedule, key) && (typeof schedule[key] !== 'string' || !schedule[key])) {
          throw new Error(`external authority ${label} conflict`);
        }
      }
      if (Object.hasOwn(schedule, 'intervalMs')
        && (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 300000)) {
        throw new Error(`external authority ${label} conflict`);
      }
      if (Object.hasOwn(schedule, 'day')
        && (!Number.isSafeInteger(schedule.day) || schedule.day < 1 || schedule.day > 31)) {
        throw new Error(`external authority ${label} conflict`);
      }
      if (Object.hasOwn(schedule, 'weekdays')
        && (!Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1
          || schedule.weekdays.length > 7 || new Set(schedule.weekdays).size !== schedule.weekdays.length
          || schedule.weekdays.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6))) {
        throw new Error(`external authority ${label} conflict`);
      }
    }
    return target;
  };
  const targetMoment = nullableObject(input.targetMoment, 'pinned target moment');
  const targetComment = nullableObject(input.targetComment, 'pinned target comment');
  const rolePlan = nullableObject(input.rolePlan, 'pinned role plan');
  const normalizedInput = {
    targetMoment: assertAllowedTarget(
      targetMoment, EXTERNAL_PINNED_MOMENT_KEYS, ['momentId'], 'pinned target moment'),
    targetComment: assertAllowedTarget(
      targetComment, EXTERNAL_PINNED_COMMENT_KEYS, ['commentId'], 'pinned target comment'),
    rolePlan: assertAllowedTarget(
      rolePlan, EXTERNAL_PINNED_ROLE_PLAN_KEYS, ['planId'], 'pinned role plan')
  };
  const basis = { version: 1, payment, scene, input: normalizedInput };
  if (externalChecksum(context.checksum, 'pinned action context') !== contentHash(basis)) {
    throw new Error('external authority pinned action context checksum conflict');
  }
  return { ...basis, checksum: context.checksum };
}

function normalizeExternalVisibleReceipt(receipt) {
  const source = externalObject(receipt, 'receipt');
  if (source.receiptVersion !== ANDROID_FALLBACK_RECEIPT_VERSION) {
    throw new Error('external authority receipt version conflict');
  }
  const semantic = externalObject(source.semantic, 'semantic');
  const manifest = externalObject(source.manifest, 'manifest');
  if (canonicalJson(manifest.semantic) !== canonicalJson(semantic)) {
    throw new Error('external authority manifest semantic conflict');
  }
  const commitChecksum = externalChecksum(source.commitChecksum, 'commit');
  if (manifest.payloadVersion !== ANDROID_FALLBACK_COMMIT_PAYLOAD_VERSION
    || manifest.authorityOrigin !== 'android_fallback'
    || externalChecksum(manifest.commitChecksum, 'manifest commit') !== commitChecksum
    || contentHash(semantic) !== commitChecksum) {
    throw new Error('external authority commit checksum conflict');
  }
  if (semantic.protocolVersion !== 2
    || semantic.contract !== 'android-fallback-authority-v2'
    || semantic.authorityOrigin !== 'android_fallback') {
    throw new Error('external authority contract conflict');
  }
  const roleId = externalText(semantic.roleId, 'role');
  const laneKey = externalText(semantic.laneKey, 'lane');
  const rootSourceId = externalText(semantic.rootSourceId, 'root');
  const lineageKey = externalText(semantic.authorityLineageKey, 'lineage');
  if (deriveAuthorityLineageKey({ roleId, laneKey, rootSourceId }) !== lineageKey) {
    throw new Error('external authority lineage identity conflict');
  }
  const turnId = externalText(semantic.authoritativeTurnId, 'turn');
  if (!Object.hasOwn(semantic, 'retryOfTurnId')) {
    throw new Error('external authority retryOfTurnId conflict');
  }
  const retryOfTurnId = externalNullableText(semantic.retryOfTurnId, 'retryOfTurnId');
  externalInteger(semantic.lineageRevisionAtCreation, 'lineage revision', { min: 1 });
  externalInteger(semantic.turnRevision, 'turn revision', { min: 1 });
  const groupId = externalText(semantic.visibleGroupId, 'group');
  if (deriveVisibleGroupId(lineageKey) !== groupId) {
    throw new Error('external authority group identity conflict');
  }
  const deviceId = externalText(semantic.deviceId, 'device');
  const turnKind = externalText(semantic.turnKind, 'kind');
  if (semantic.terminalDisposition === 'redacted' || semantic.terminalDisposition === 'cancelled') {
    throw new Error('external authority redacted/cancelled conflict');
  }
  if (!CANONICAL_RESULT_TURN_KINDS.has(turnKind)
    || !ANDROID_FALLBACK_DISPOSITIONS.has(semantic.terminalDisposition)) {
    throw new Error('external authority terminal disposition conflict');
  }
  if (turnKind === 'DIRECT_REPLY' && semantic.terminalDisposition === 'skip') {
    throw new Error('external authority direct skip conflict');
  }

  const input = externalObject(semantic.input, 'input');
  const inputKind = input.kind;
  if (!['direct', 'automatic'].includes(inputKind)) {
    throw new Error('external authority input kind conflict');
  }
  if (typeof input.visibilitySequence !== 'number' || !Number.isSafeInteger(input.visibilitySequence)
    || input.visibilitySequence < 0
    || typeof input.clearEpoch !== 'number' || !Number.isSafeInteger(input.clearEpoch)
    || input.clearEpoch < 0
    || !externalChecksum(input.checksum, 'input')) {
    throw new Error('external authority input cursor conflict');
  }
  let inputUserBatchId;
  let pinnedActionContext = null;
  if (inputKind === 'direct') {
    const inputKeys = new Set(Object.keys(input));
    if (!(hasExactExternalKeys(input, EXTERNAL_DIRECT_INPUT_KEYS)
      || hasExactExternalKeys(input, EXTERNAL_DIRECT_INPUT_WITH_ACTION_KEYS))) {
      throw new Error('external authority direct input keys conflict');
    }
    if (inputKeys.has('pinnedActionContext')) {
      pinnedActionContext = normalizeExternalPinnedActionContext(input.pinnedActionContext);
    }
    const batch = externalObject(input.batch, 'batch');
    const batchKeys = ['batchId', 'characterId', 'sourceMessageId', 'startedAt', 'committedAt', 'checksum', 'items'];
    if (Object.keys(batch).some(key => !batchKeys.includes(key))
      || !batchKeys.every(key => Object.hasOwn(batch, key))
      || batch.characterId !== roleId
      || !Array.isArray(batch.items)
      || !batch.items.length
      || typeof batch.startedAt !== 'number' || !Number.isSafeInteger(batch.startedAt)
      || typeof batch.committedAt !== 'number' || !Number.isSafeInteger(batch.committedAt)
      || !externalChecksum(batch.checksum, 'batch')) {
      throw new Error('external authority direct batch conflict');
    }
    const items = batch.items.map((entry, ordinal) => {
      const item = externalObject(entry, 'batch item');
      if (item.sequence !== ordinal || externalText(item.messageId, 'batch item id') !== item.messageId
        || !externalChecksum(item.checksum, 'batch item')) {
        throw new Error('external authority direct batch item conflict');
      }
      const message = externalObject(item.message, 'batch message');
      if (message.messageId !== item.messageId || typeof message.sentAt !== 'number'
        || !Number.isSafeInteger(message.sentAt) || contentHash(message) !== item.checksum) {
        throw new Error('external authority direct batch message checksum conflict');
      }
      return { sequence: ordinal, messageId: item.messageId, message, checksum: item.checksum };
    });
    const batchHeader = {
      batchId: batch.batchId,
      characterId: batch.characterId,
      sourceMessageId: batch.sourceMessageId,
      startedAt: batch.startedAt,
      committedAt: batch.committedAt,
      messageIds: items.map(item => item.messageId)
    };
    const canonicalBatchHeader = {
      batchId: batchHeader.batchId,
      sourceMessageId: batchHeader.sourceMessageId,
      messageIds: batchHeader.messageIds,
      startedAt: batchHeader.startedAt,
      committedAt: batchHeader.committedAt
    };
    if (contentHash(canonicalBatchHeader) !== batch.checksum
      || contentHash(canonicalBatchHeader) !== input.checksum) {
      throw new Error('external authority direct batch commitment conflict');
    }
    inputUserBatchId = externalText(batch.batchId, 'batch id');
  } else {
    if (!hasExactExternalKeys(input, EXTERNAL_AUTOMATIC_INPUT_KEYS)) {
      throw new Error('external authority automatic input keys conflict');
    }
    const trigger = externalObject(input.trigger, 'trigger');
    if (!externalText(trigger.triggerId, 'trigger id')
      || !externalText(trigger.triggerType, 'trigger type')
      || typeof trigger.scheduledFor !== 'number'
      || !Number.isSafeInteger(trigger.scheduledFor)
      || typeof trigger.executedAt !== 'number'
      || !Number.isSafeInteger(trigger.executedAt)
      || canonicalJson(Object.keys(trigger).sort()) !== canonicalJson([
        'context', 'executedAt', 'scheduledFor', 'triggerId', 'triggerType'
      ])) {
      throw new Error('external authority automatic trigger conflict');
    }
    const triggerCore = {
      kind: 'automatic', trigger: structuredClone(trigger),
      visibilitySequence: input.visibilitySequence, clearEpoch: input.clearEpoch
    };
    if (contentHash(triggerCore) !== input.checksum) {
      throw new Error('external authority automatic trigger checksum conflict');
    }
    inputUserBatchId = trigger.triggerId;
  }

  const snapshot = externalObject(semantic.compactSemanticSnapshot, 'semantic snapshot');
  if (externalChecksum(semantic.agencySnapshotChecksum, 'agency snapshot')
    !== contentHash(snapshot)) {
    throw new Error('external authority agency snapshot checksum conflict');
  }
  const replyItems = Array.isArray(semantic.replyItems) ? semantic.replyItems : [];
  const actions = Array.isArray(semantic.actions) ? semantic.actions : [];
  if (semantic.terminalDisposition === 'visible' && replyItems.length < 1) {
    throw new Error('external authority visible result conflict');
  }
  if (semantic.terminalDisposition === 'action_only' && (replyItems.length || !actions.length)) {
    throw new Error('external authority action-only result conflict');
  }
  if (semantic.terminalDisposition === 'skip' && (replyItems.length || actions.length)) {
    throw new Error('external authority skip result conflict');
  }
  const normalizedItems = replyItems.map((entry, ordinal) => {
    const item = externalObject(entry, 'reply item');
    if (item.ordinal !== ordinal || item.messageId !== deriveVisibleMessageId(groupId, ordinal)
      || !externalChecksum(item.checksum, 'reply item')) {
      throw new Error('external authority reply item identity conflict');
    }
    const message = externalObject(item.message, 'reply message');
    if (message.messageId !== item.messageId || message.speakerId !== roleId
      || message.speakerType !== 'character' || message.recipientId !== 'user'
      || contentHash(message) !== item.checksum) {
      throw new Error('external authority reply message conflict');
    }
    return { ordinal, messageId: item.messageId, message, checksum: item.checksum };
  });
  if (!Array.isArray(semantic.visibleItems)
    || canonicalJson(semantic.visibleItems)
      !== canonicalJson(normalizedItems.map(item => item.message))) {
    throw new Error('external authority visible item projection conflict');
  }
  const normalizedActions = actions.map((entry, ordinal) => {
    const action = externalObject(entry, 'action');
    const keys = ['actionId', 'ordinal', 'kind', 'targetKey', 'targetRevision', 'payload', 'checksum'];
    if (canonicalJson(Object.keys(action).sort()) !== canonicalJson(keys.sort())
      || action.ordinal !== ordinal
      || action.actionId !== deriveVisibleActionId(groupId, ordinal)
      || typeof action.kind !== 'string' || !action.kind
      || typeof action.targetKey !== 'string' || !action.targetKey
      || typeof action.targetRevision !== 'string' || !action.targetRevision
      || !action.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)
      || !externalChecksum(action.checksum, 'action')) {
      throw new Error('external authority action identity conflict');
    }
    const canonicalAction = {
      kind: action.kind, targetKey: action.targetKey,
      targetRevision: action.targetRevision, payload: action.payload
    };
    if (contentHash(canonicalAction) !== action.checksum) {
      throw new Error('external authority action checksum conflict');
    }
    assertExternalCanonicalAction({ action, roleId, lineageKey });
    assertExternalActionPinnedInput({ action, semantic, input });
    return { ...canonicalAction, actionId: action.actionId, ordinal, checksum: action.checksum };
  });
  const singleActionNamespaces = new Set();
  for (const action of normalizedActions) {
    const namespace = action.kind.startsWith('payment_') ? 'payment'
      : action.kind.startsWith('moment_') ? 'moment'
        : action.kind === 'relationship_transition' ? 'relationship'
          : action.kind.startsWith('life_episode_') ? 'life' : null;
    if (namespace && singleActionNamespaces.has(namespace)) {
      throw new Error('external authority action compatibility conflict');
    }
    if (namespace) singleActionNamespaces.add(namespace);
  }
  if (inputKind === 'direct') {
    if ((normalizedActions.length > 0) !== (pinnedActionContext !== null)) {
      throw new Error('external authority pinned action context presence conflict');
    }
    if (pinnedActionContext !== null) {
      const kinds = new Set(normalizedActions.map(action => action.kind));
      const used = {
        payment: kinds.has('payment_accept') || kinds.has('payment_decline'),
        scene: kinds.has('relationship_transition'),
        targetMoment: kinds.has('moment_like') || kinds.has('moment_comment'),
        targetComment: kinds.has('moment_reply'),
        rolePlan: [...kinds].some(kind => kind.startsWith('role_plan_')
          && kind !== 'role_plan_create')
      };
      if ((pinnedActionContext.payment !== null) !== used.payment
        || (pinnedActionContext.scene !== null) !== used.scene
        || (pinnedActionContext.input.targetMoment !== null) !== used.targetMoment
        || (pinnedActionContext.input.targetComment !== null) !== used.targetComment
        || (pinnedActionContext.input.rolePlan !== null) !== used.rolePlan) {
        throw new Error('external authority pinned action context coverage conflict');
      }
    }
  }
  const release = externalObject(semantic.release, 'release');
  const contractChecksum = contentHash({ contract: ANDROID_FALLBACK_CONTRACT, codecVersion: 1 });
  const releaseChecksum = contentHash({
    origin: 'android_fallback', contract: ANDROID_FALLBACK_CONTRACT,
    contractChecksum, codecVersion: 1
  });
  if (release.contract !== ANDROID_FALLBACK_CONTRACT
    || release.codecVersion !== 1
    || release.contractChecksum !== contractChecksum
    || release.releaseId !== `android_fallback:${contractChecksum}`
    || release.releaseChecksum !== releaseChecksum) {
    throw new Error('external authority release conflict');
  }
  if (typeof semantic.journalSyncSeq !== 'number'
    || !Number.isSafeInteger(semantic.journalSyncSeq) || semantic.journalSyncSeq <= 0) {
    throw new Error('external authority journal sequence conflict');
  }
  return {
    semantic,
    commitChecksum,
    roleId,
    laneKey,
    rootSourceId,
    lineageKey,
    turnId,
    retryOfTurnId,
    groupId,
    deviceId,
    turnKind,
    input,
    inputKind,
    inputUserBatchId,
    snapshot,
    replyItems: normalizedItems,
    actions: normalizedActions,
    release,
    journalSyncSeq: Number(semantic.journalSyncSeq)
  };
}

function mapTurn(row) {
  if (!row) return null;
  return {
    turnId: row.turn_id,
    characterId: row.character_id,
    deviceId: row.device_id,
    deviceSeq: row.device_seq,
    sourceMessageId: row.source_message_id,
    protocolVersion: Number(parseJson(row.envelope_json, {})?.protocolVersion || 0),
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
    inputClearEpoch: Number(row.input_clear_epoch || 0),
    authorityRedactedAt: row.authority_redacted_at ?? null,
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
    protocolVersion: Number(parseJson(row.envelope_json, {}).protocolVersion || 0),
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
    redactedAt: row.redacted_at == null ? null : Number(row.redacted_at),
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
    authorityCommitChecksum: row.authority_commit_checksum || null,
    relayMessageId: row.relay_message_id || null
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
    clearEpoch: Number(row.clear_epoch || 0),
    clearedThroughSequence: Number(row.cleared_through_sequence || 0),
    lastCommitChecksum: row.last_commit_checksum || null,
    updatedAt: Number(row.updated_at)
  };
}

function assertExactCanonicalKeys(value, expectedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields conflict`);
  }
}

function assertCanonicalMomentActionPayload(kind, payload) {
  assertExactCanonicalKeys(
    payload,
    ['momentId', 'like', 'comment', 'replyToCommentId'],
    'canonical moment action payload'
  );
  if (typeof payload.momentId !== 'string' || !payload.momentId
    || typeof payload.like !== 'boolean'
    || typeof payload.comment !== 'string'
    || !(payload.replyToCommentId === null
      || (typeof payload.replyToCommentId === 'string' && payload.replyToCommentId.length > 0))) {
    throw new Error('canonical moment action payload type conflict');
  }
  if (kind === 'moment_like'
    && !(payload.like === true && payload.comment === '' && payload.replyToCommentId === null)) {
    throw new Error('canonical moment like payload conflict');
  }
  if (kind === 'moment_comment'
    && !(payload.comment.trim().length > 0 && payload.replyToCommentId === null)) {
    throw new Error('canonical moment comment payload conflict');
  }
  if (kind === 'moment_reply'
    && !(payload.like === false
      && payload.comment.trim().length > 0
      && typeof payload.replyToCommentId === 'string')) {
    throw new Error('canonical moment reply payload conflict');
  }
}

function assertCanonicalRelationshipActionPart(value, part) {
  if (value === null) return;
  const booleanKey = part === 'base' ? 'explicitMutualChange' : 'explicitAcknowledgedChange';
  assertExactCanonicalKeys(value, [
    'from', 'to', 'label', 'reason', 'confidence', 'evidenceMessageIds', booleanKey, 'changedAt'
  ], `canonical relationship ${part} action`);
  if (!['from', 'to', 'label', 'reason'].every(key =>
    typeof value[key] === 'string' && value[key].trim().length > 0)
    || typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
    || !Array.isArray(value.evidenceMessageIds)
    || value.evidenceMessageIds.some(id => typeof id !== 'string' || !id)
    || typeof value[booleanKey] !== 'boolean'
    || !Number.isSafeInteger(value.changedAt)
    || value.changedAt < 0) {
    throw new Error(`canonical relationship ${part} action type conflict`);
  }
}

function assertCanonicalRelationshipActionPayload(payload) {
  assertExactCanonicalKeys(payload, [
    'baseAction', 'phaseAction', 'expectedSceneRevision', 'label', 'changedAt'
  ], 'canonical relationship action payload');
  assertCanonicalRelationshipActionPart(payload.baseAction, 'base');
  assertCanonicalRelationshipActionPart(payload.phaseAction, 'phase');
  if (payload.baseAction === null && payload.phaseAction === null) {
    throw new Error('canonical relationship action payload is empty');
  }
  if (!Number.isSafeInteger(payload.expectedSceneRevision) || payload.expectedSceneRevision < 0
    || typeof payload.label !== 'string' || !payload.label.trim()
    || !Number.isSafeInteger(payload.changedAt) || payload.changedAt < 0
    || [payload.baseAction, payload.phaseAction]
      .some(part => part !== null && part.changedAt !== payload.changedAt)) {
    throw new Error('canonical relationship action payload type conflict');
  }
}

const EXTERNAL_CANONICAL_ACTION_KINDS = new Set([
  'payment_accept', 'payment_decline',
  'moment_like', 'moment_comment', 'moment_reply',
  'role_plan_create', 'role_plan_update', 'role_plan_cancel', 'role_plan_pause',
  'role_plan_resume', 'role_plan_complete',
  'relationship_transition'
]);

function assertOneOfExactCanonicalKeys(value, keySets, label) {
  const actual = Object.keys(value).sort().join(',');
  if (!keySets.some(keys => [...keys].sort().join(',') === actual)) {
    throw new Error(`${label} fields conflict`);
  }
}

function assertCanonicalPaymentActionPayload(kind, payload, targetKey) {
  assertExactCanonicalKeys(payload, ['messageId'], 'canonical payment action payload');
  if (typeof payload.messageId !== 'string' || !payload.messageId
    || targetKey !== `payment:${payload.messageId}`
    || !['payment_accept', 'payment_decline'].includes(kind)) {
    throw new Error('canonical payment action target conflict');
  }
}

function assertCanonicalShaTargetRevision(targetRevision, label) {
  if (typeof targetRevision !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(targetRevision)) {
    throw new Error(`canonical ${label} target revision conflict`);
  }
}

function assertCanonicalPositiveDecimalTargetRevision(targetRevision, label) {
  if (typeof targetRevision !== 'string' || !/^[1-9][0-9]{0,15}$/.test(targetRevision)
    || !Number.isSafeInteger(Number(targetRevision)) || Number(targetRevision) < 1) {
    throw new Error(`canonical ${label} target revision conflict`);
  }
}

function assertCanonicalRolePlanSchedule(schedule) {
  externalObject(schedule, 'role plan schedule');
  if (schedule.kind === 'once') {
    assertOneOfExactCanonicalKeys(schedule, [['kind', 'at'], ['kind', 'at', 'endsAt']], 'canonical role plan schedule');
    if (typeof schedule.at !== 'string' || !schedule.at
      || (Object.hasOwn(schedule, 'endsAt')
        && (typeof schedule.endsAt !== 'string' || !schedule.endsAt))) {
      throw new Error('canonical role plan schedule type conflict');
    }
    return;
  }
  if (schedule.kind === 'interval') {
    assertOneOfExactCanonicalKeys(
      schedule,
      [['kind', 'startsAt', 'intervalMs'], ['kind', 'startsAt', 'intervalMs', 'endsAt']],
      'canonical role plan schedule'
    );
    if (typeof schedule.startsAt !== 'string' || !schedule.startsAt
      || typeof schedule.intervalMs !== 'number' || !Number.isFinite(schedule.intervalMs)
      || !Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 300_000
      || (Object.hasOwn(schedule, 'endsAt')
        && (typeof schedule.endsAt !== 'string' || !schedule.endsAt))) {
      throw new Error('canonical role plan schedule type conflict');
    }
    return;
  }
  if (schedule.kind === 'daily') {
    assertOneOfExactCanonicalKeys(schedule, [['kind', 'time'], ['kind', 'time', 'endsAt']], 'canonical role plan schedule');
    if (typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)
      || (Object.hasOwn(schedule, 'endsAt')
        && (typeof schedule.endsAt !== 'string' || !schedule.endsAt))) {
      throw new Error('canonical role plan schedule type conflict');
    }
    return;
  }
  if (schedule.kind === 'weekly') {
    assertOneOfExactCanonicalKeys(
      schedule,
      [['kind', 'weekdays', 'time'], ['kind', 'weekdays', 'time', 'endsAt']],
      'canonical role plan schedule'
    );
    if (!Array.isArray(schedule.weekdays) || schedule.weekdays.length < 1 || schedule.weekdays.length > 7
      || new Set(schedule.weekdays).size !== schedule.weekdays.length
      || schedule.weekdays.some(day => !Number.isSafeInteger(day) || day < 0 || day > 6)
      || typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)
      || (Object.hasOwn(schedule, 'endsAt')
        && (typeof schedule.endsAt !== 'string' || !schedule.endsAt))) {
      throw new Error('canonical role plan schedule type conflict');
    }
    return;
  }
  if (schedule.kind === 'monthly') {
    assertOneOfExactCanonicalKeys(
      schedule,
      [['kind', 'day', 'time'], ['kind', 'day', 'time', 'endsAt']],
      'canonical role plan schedule'
    );
    if (!Number.isSafeInteger(schedule.day) || schedule.day < 1 || schedule.day > 31
      || typeof schedule.time !== 'string' || !/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(schedule.time)
      || (Object.hasOwn(schedule, 'endsAt')
        && (typeof schedule.endsAt !== 'string' || !schedule.endsAt))) {
      throw new Error('canonical role plan schedule type conflict');
    }
    return;
  }
  throw new Error('canonical role plan schedule kind conflict');
}

function assertCanonicalRolePlanEvidence(value) {
  if (!Array.isArray(value) || value.length > 12
    || value.some(id => typeof id !== 'string' || !id || id.length > 96)) {
    throw new Error('canonical role plan evidence conflict');
  }
}

function assertCanonicalRolePlanText(value, label, maxLength, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length > maxLength || (!nullable && !value)) {
    throw new Error(`canonical role plan ${label} conflict`);
  }
}

function assertCanonicalRolePlanSemanticFields(value, { create = false } = {}) {
  if (Object.hasOwn(value, 'type')
    && !['private_message', 'moment_post', 'role_schedule'].includes(value.type)) {
    throw new Error('canonical role plan type conflict');
  }
  if (Object.hasOwn(value, 'source')
    && !['spoken', 'accepted_request', 'private_decision', 'user_created'].includes(value.source)) {
    throw new Error('canonical role plan source conflict');
  }
  if (Object.hasOwn(value, 'timeConfidence')
    && !['explicit', 'inferred'].includes(value.timeConfidence)) {
    throw new Error('canonical role plan time confidence conflict');
  }
  if (Object.hasOwn(value, 'origin') && !['ai', 'user'].includes(value.origin)) {
    throw new Error('canonical role plan origin conflict');
  }
  if (Object.hasOwn(value, 'planId')) assertCanonicalRolePlanText(value.planId, 'plan id', 96);
  if (Object.hasOwn(value, 'title')) assertCanonicalRolePlanText(value.title, 'title', 80);
  if (Object.hasOwn(value, 'intent')) assertCanonicalRolePlanText(value.intent, 'intent', 600);
  if (Object.hasOwn(value, 'sourceQuote')) assertCanonicalRolePlanText(value.sourceQuote, 'source quote', 240);
  if (Object.hasOwn(value, 'durationMs')) {
    externalInteger(value.durationMs, 'role plan duration', { min: 1 });
  }
  if (Object.hasOwn(value, 'evidenceMessageIds')) assertCanonicalRolePlanEvidence(value.evidenceMessageIds);
  if (Object.hasOwn(value, 'schedule')) assertCanonicalRolePlanSchedule(value.schedule);
  if (create && (!Object.hasOwn(value, 'type') || !Object.hasOwn(value, 'source')
    || !Object.hasOwn(value, 'title') || !Object.hasOwn(value, 'intent')
    || !Object.hasOwn(value, 'schedule') || !Object.hasOwn(value, 'timeConfidence'))) {
    throw new Error('canonical role plan create fields conflict');
  }
}

function assertAllowedAndRequiredCanonicalKeys(value, allowedKeys, requiredKeys, label) {
  const actual = new Set(Object.keys(value));
  if ([...actual].some(key => !allowedKeys.has(key))
    || [...requiredKeys].some(key => !actual.has(key))) {
    throw new Error(`${label} fields conflict`);
  }
}

function assertCanonicalRolePlanActionPayload(kind, payload, targetKey, targetRevision, lineageKey) {
  const op = kind.slice('role_plan_'.length);
  if (!['create', 'update', 'cancel', 'pause', 'resume', 'complete'].includes(op)
    || payload.op !== op) {
    throw new Error('canonical role plan action kind conflict');
  }
  if (op === 'create') {
    assertAllowedAndRequiredCanonicalKeys(
      payload,
      new Set(['op', 'planId', 'type', 'source', 'title', 'intent', 'schedule',
        'timeConfidence', 'durationMs', 'origin', 'sourceQuote', 'evidenceMessageIds']),
      new Set(['op', 'type', 'source', 'title', 'intent', 'schedule', 'timeConfidence']),
      'canonical role plan create action payload'
    );
    assertCanonicalRolePlanSemanticFields(payload, { create: true });
    if (targetKey !== `lineage_create:${lineageKey}:role_plan_create`) {
      throw new Error('canonical role plan create target conflict');
    }
    assertCanonicalPositiveDecimalTargetRevision(targetRevision, 'role plan create');
    return;
  }

  const allowed = op === 'update'
    ? new Set(['op', 'planId', 'patch', 'reason'])
    : new Set(['op', 'planId', 'reason']);
  const required = op === 'update'
    ? new Set(['op', 'planId', 'patch'])
    : new Set(['op', 'planId']);
  assertAllowedAndRequiredCanonicalKeys(payload, allowed, required, 'canonical role plan action payload');
  if (typeof payload.planId !== 'string' || !payload.planId
    || targetKey !== `role_plan:${payload.planId}`
    || !/^sha256:[a-f0-9]{64}$/.test(targetRevision)) {
    throw new Error('canonical role plan target conflict');
  }
  if (Object.hasOwn(payload, 'patch')) {
    externalObject(payload.patch, 'role plan patch');
    const allowedPatch = new Set([
      'type', 'source', 'title', 'intent', 'schedule', 'timeConfidence',
      'durationMs', 'origin', 'sourceQuote', 'evidenceMessageIds'
    ]);
    const patchKeys = Object.keys(payload.patch);
    if (!patchKeys.length || patchKeys.some(key => !allowedPatch.has(key))) {
      throw new Error('canonical role plan nested target conflict');
    }
    assertCanonicalRolePlanSemanticFields(payload.patch);
  }
  if (Object.hasOwn(payload, 'reason')) {
    assertCanonicalRolePlanText(payload.reason, 'reason', 240);
  }
}

function assertExternalCanonicalAction({ action, roleId, lineageKey }) {
  const { kind, targetKey, targetRevision, payload } = action;
  if (!EXTERNAL_CANONICAL_ACTION_KINDS.has(kind)) {
    throw new Error('external authority action kind conflict');
  }
  if (kind === 'payment_accept' || kind === 'payment_decline') {
    assertCanonicalShaTargetRevision(targetRevision, 'payment action');
    assertCanonicalPaymentActionPayload(kind, payload, targetKey);
    return;
  }
  if (['moment_like', 'moment_comment', 'moment_reply'].includes(kind)) {
    assertCanonicalShaTargetRevision(targetRevision, 'moment action');
    assertCanonicalMomentActionPayload(kind, payload);
    const expected = kind === 'moment_reply'
      ? `comment:${payload.replyToCommentId}`
      : `moment:${payload.momentId}`;
    if (targetKey !== expected) throw new Error('canonical moment action target conflict');
    return;
  }
  if (kind === 'relationship_transition') {
    assertCanonicalShaTargetRevision(targetRevision, 'relationship action');
    assertCanonicalRelationshipActionPayload(payload);
    if (targetKey !== `relationship:${roleId}`) {
      throw new Error('canonical relationship action target conflict');
    }
    return;
  }
  if (kind.startsWith('role_plan_')) {
    assertCanonicalRolePlanActionPayload(kind, payload, targetKey, action.targetRevision, lineageKey);
    return;
  }
  // Life actions are still projected by the existing canonical projector. Keep
  // their kind closed here, while their domain-specific payload remains owned
  // by that projector until its Android fallback contract is versioned.
}

function externalActionContext(input) {
  const pinned = input?.pinnedActionContext;
  if (pinned && typeof pinned === 'object' && !Array.isArray(pinned)) {
    return {
      payment: pinned.payment,
      scene: pinned.scene,
      input: pinned.input
    };
  }
  const triggerContext = input?.trigger?.context;
  return triggerContext && typeof triggerContext === 'object' && !Array.isArray(triggerContext)
    ? triggerContext
    : null;
}

function assertExternalActionPinnedInput({ action, semantic, input }) {
  const { kind, targetRevision, payload } = action;
  const context = externalActionContext(input);
  if (kind === 'role_plan_create') {
    if (targetRevision !== String(semantic.lineageRevisionAtCreation)) {
      throw new Error('external authority role plan create target revision conflict');
    }
    return;
  }
  if (!context) throw new Error('external authority action input context conflict');
  if (kind === 'payment_accept' || kind === 'payment_decline') {
    const payment = context.payment;
    if (!payment || typeof payment !== 'object' || Array.isArray(payment)
      || payload.messageId !== payment.messageId
      || targetRevision !== `sha256:${contentHash(payment)}`) {
      throw new Error('external authority payment target revision conflict');
    }
    return;
  }
  if (kind === 'moment_like' || kind === 'moment_comment' || kind === 'moment_reply') {
    const actionInput = context.input;
    const target = actionInput?.[
      kind === 'moment_reply' ? 'targetComment' : 'targetMoment'
    ];
    const targetId = kind === 'moment_reply' ? payload.replyToCommentId : payload.momentId;
    const targetField = kind === 'moment_reply' ? 'commentId' : 'momentId';
    const namespace = kind === 'moment_reply' ? 'comment' : 'moment';
    if (!target || typeof target !== 'object' || Array.isArray(target)
      || target[targetField] !== targetId
      || action.targetKey !== `${namespace}:${targetId}`
      || targetRevision !== `sha256:${contentHash(target)}`) {
      throw new Error('external authority moment target revision conflict');
    }
    return;
  }
  if (kind === 'relationship_transition') {
    const scene = context.scene;
    const revision = scene?.stagePersonaRevision;
    const relationshipStage = scene?.relationshipStage;
    const target = {
      relationshipStage: structuredClone(relationshipStage),
      stagePersonaRevision: revision
    };
    if (!scene || !relationshipStage || typeof relationshipStage !== 'object'
      || Array.isArray(relationshipStage) || !Number.isSafeInteger(revision)
      || payload.expectedSceneRevision !== revision
      || targetRevision !== `sha256:${contentHash(target)}`) {
      throw new Error('external authority relationship target revision conflict');
    }
    return;
  }
  if (kind.startsWith('role_plan_')) {
    const rolePlan = context.input?.rolePlan;
    if (!rolePlan || typeof rolePlan !== 'object' || Array.isArray(rolePlan)
      || payload.planId !== rolePlan.planId
      || targetRevision !== `sha256:${contentHash(rolePlan)}`) {
      throw new Error('external authority role plan target revision conflict');
    }
  }
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
    if (this.migrationOptions?.expectedSourceVersion != null
      && initialVersion !== this.migrationOptions.expectedSourceVersion) {
      throw new Error(
        `migration source version mismatch: expected ${this.migrationOptions.expectedSourceVersion}, got ${initialVersion}`
      );
    }
    const targetVersion = Number(this.migrationOptions?.targetVersion || 15);
    if (![12, 13, 14, 15].includes(targetVersion)) {
      throw new Error(`unsupported migration target version ${targetVersion}`);
    }
    if (initialVersion > 15) {
      throw new Error(`unsupported database user_version ${initialVersion}`);
    }
    if (initialVersion === 15) {
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV13Invariants();
      this.assertReleaseAuthorityV14Invariants();
      this.assertConversationClearAuthorityV15Invariants();
      this.assertExpectedPostMigrationInvariantChecksum();
      return;
    }
    if (initialVersion === 14 && targetVersion === 14) {
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV13Invariants();
      this.assertReleaseAuthorityV14Invariants();
      this.assertExpectedPostMigrationInvariantChecksum();
      return;
    }
    if (initialVersion === 13 && targetVersion === 13) {
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV13Invariants();
      this.assertExpectedPostMigrationInvariantChecksum();
      return;
    }
    if (initialVersion === 12 && targetVersion === 12) {
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
      if (targetVersion === 12) {
        this.assertAgencyV10Invariants();
        this.assertVisibleAuthorityV12Invariants();
        this.assertExpectedPostMigrationInvariantChecksum();
        this.db.exec('COMMIT');
        return;
      }
      if (initialVersion < 13) {
        this.migrateVisibleAuthorityV13Internal();
      }
      if (targetVersion === 13) {
        this.assertAgencyV10Invariants();
        this.assertVisibleAuthorityV13Invariants();
        this.assertExpectedPostMigrationInvariantChecksum();
        this.db.exec('COMMIT');
        return;
      }
      if (initialVersion < 14) {
        this.migrateReleaseAuthorityV14Internal();
      }
      if (targetVersion === 14) {
        this.assertAgencyV10Invariants();
        this.assertVisibleAuthorityV13Invariants();
        this.assertReleaseAuthorityV14Invariants();
        this.assertExpectedPostMigrationInvariantChecksum();
        this.db.exec('COMMIT');
        return;
      }
      if (initialVersion < 15) {
        this.migrateConversationClearAuthorityV15Internal();
      }
      this.assertAgencyV10Invariants();
      this.assertVisibleAuthorityV13Invariants();
      this.assertReleaseAuthorityV14Invariants();
      this.assertConversationClearAuthorityV15Invariants();
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
    const actual = this.userVersion() >= 14
      ? this.releaseAuthorityV14InvariantSummary().checksum
      : this.userVersion() >= 13
        ? this.visibleAuthorityV13InvariantSummary().checksum
        : this.visibleAuthorityV11InvariantSummary().checksum;
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
      candidate_phase: 'TEXT',
      live_shadow_first_at: 'INTEGER',
      live_shadow_last_at: 'INTEGER',
      live_shadow_success_count: 'INTEGER NOT NULL DEFAULT 0',
      live_shadow_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_target_count: 'INTEGER NOT NULL DEFAULT 10',
      canary_max_outstanding: 'INTEGER NOT NULL DEFAULT 3',
      canary_compare_deadline_ms: 'INTEGER NOT NULL DEFAULT 900000',
      canary_started_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_completed_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_started_at: 'INTEGER',
      canary_observe_until: 'INTEGER',
      active_transient_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      active_transient_window_started_at: 'INTEGER',
      last_report_id: 'TEXT',
      last_report_checksum: 'TEXT',
      activated_at: 'INTEGER',
      rolled_back_at: 'INTEGER',
      last_reason_code: "TEXT NOT NULL DEFAULT 'bootstrap'"
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
    for (const [column, definition] of Object.entries({
      live_shadow_first_at: 'INTEGER',
      live_shadow_last_at: 'INTEGER',
      live_shadow_success_count: 'INTEGER NOT NULL DEFAULT 0',
      live_shadow_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_target_count: 'INTEGER NOT NULL DEFAULT 10',
      canary_max_outstanding: 'INTEGER NOT NULL DEFAULT 3',
      canary_compare_deadline_ms: 'INTEGER NOT NULL DEFAULT 900000',
      canary_started_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_completed_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      canary_started_at: 'INTEGER',
      canary_observe_until: 'INTEGER',
      active_transient_failure_count: 'INTEGER NOT NULL DEFAULT 0',
      active_transient_window_started_at: 'INTEGER',
      last_report_id: 'TEXT',
      last_report_checksum: 'TEXT',
      activated_at: 'INTEGER',
      rolled_back_at: 'INTEGER',
      last_reason_code: "TEXT NOT NULL DEFAULT 'bootstrap'"
    })) {
      this.addColumnIfMissing('cognition_kind_rollouts', column, definition);
    }
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
      -- Some populated v10 databases predate user-batch persistence entirely.
      -- These are empty compatibility projections, not reconstructed authority.
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

  maybeFailV13Migration(step) {
    if (this.migrationOptions?.v13MigrationFaultStep === step) {
      throw new Error(`forced v13 migration fault: ${step}`);
    }
  }

  maybeFailV14Migration(step) {
    if (this.migrationOptions?.v14MigrationFaultStep === step) {
      throw new Error(`forced v14 migration fault: ${step}`);
    }
  }

  assertV12ToV13SourceInvariantsInternal() {
    if (this.userVersion() !== 12) {
      throw new Error(`v13 migration source version mismatch: ${this.userVersion()}`);
    }
    const redacted = this.db.prepare(`
      SELECT g.group_id
      FROM visible_result_groups g
      LEFT JOIN visible_result_manifests m ON m.group_id = g.group_id
      WHERE g.redacted_at IS NOT NULL
         OR m.redacted_at IS NOT NULL
         OR m.semantic_json IS NULL
      LIMIT 1
    `).get();
    if (redacted) {
      throw new Error(`v13 migration rejects v12 redacted source: ${redacted.group_id}`);
    }
    const exactColumns = (table, expected) => {
      const actual = this.db.prepare(`PRAGMA table_info("${table}")`).all()
        .map(row => row.name);
      if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`v13 migration v12 schema mismatch: ${table}`);
      }
    };
    exactColumns('current_user_batch_items', [
      'turn_id', 'batch_id', 'message_id', 'sequence', 'message_json', 'checksum'
    ]);
    exactColumns('visible_result_items', [
      'group_id', 'ordinal', 'message_id', 'item_json', 'item_checksum'
    ]);
    exactColumns('visible_result_actions', [
      'group_id', 'ordinal', 'action_id', 'action_kind', 'target_key',
      'target_revision', 'action_json', 'action_checksum'
    ]);
    const exactForeignKeys = (table, expected) => {
      const actual = this.db.prepare(`PRAGMA foreign_key_list("${table}")`).all()
        .map(row => ({ table: row.table, from: row.from, to: row.to }))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
      const normalizedExpected = [...expected]
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
      if (canonicalJson(actual) !== canonicalJson(normalizedExpected)) {
        throw new Error(`v13 migration v12 foreign key mismatch: ${table}`);
      }
    };
    exactForeignKeys('current_user_batch_items', [{
      table: 'current_user_batches', from: 'turn_id', to: 'turn_id'
    }]);
    exactForeignKeys('visible_result_items', [{
      table: 'visible_result_groups', from: 'group_id', to: 'group_id'
    }]);
    exactForeignKeys('visible_result_actions', [{
      table: 'visible_result_groups', from: 'group_id', to: 'group_id'
    }]);
    const explicitIndexes = table => this.db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
      ORDER BY name
    `).all(table).map(row => String(row.sql).replace(/\s+/g, ' ').trim().toLowerCase());
    const expectedIndexes = {
      current_user_batch_items: [
        'create index idx_current_user_batch_items_message on current_user_batch_items(message_id)'
      ],
      visible_result_items: [],
      visible_result_actions: []
    };
    for (const [table, expected] of Object.entries(expectedIndexes)) {
      if (canonicalJson(explicitIndexes(table)) !== canonicalJson(expected)) {
        throw new Error(`v13 migration v12 index mismatch: ${table}`);
      }
    }
    for (const turn of this.db.prepare(`
      SELECT turn_id, rollout_key, envelope_json
      FROM turns WHERE result_authority_version = 1 ORDER BY turn_id
    `).all()) {
      const kind = String(parseJson(turn.envelope_json, {})?.kind || '');
      if (!CANONICAL_RESULT_TURN_KINDS.has(String(turn.rollout_key || ''))
        || String(turn.rollout_key || '') !== kind) {
        throw new Error(`v13 migration canonical turn kind anchor conflict: ${turn.turn_id}`);
      }
    }
    this.assertVisibleAuthorityV12Invariants({ allowHistoricalStatePatch: true });
  }

  migrateVisibleAuthorityV13Internal() {
    this.assertV12ToV13SourceInvariantsInternal();
    const sourceRows = Object.fromEntries([
      'current_user_batch_items',
      'visible_result_items',
      'visible_result_actions'
    ].map(table => [
      table,
      this.db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()
    ]));
    this.db.exec(`
      CREATE TABLE current_user_batch_items_v13 (
        turn_id TEXT NOT NULL,
        batch_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        message_json TEXT,
        checksum TEXT NOT NULL,
        redacted_at INTEGER,
        PRIMARY KEY(turn_id, sequence),
        UNIQUE(turn_id, message_id),
        CHECK (
          (message_json IS NOT NULL AND redacted_at IS NULL)
          OR (message_json IS NULL AND redacted_at IS NOT NULL)
        ),
        FOREIGN KEY(turn_id) REFERENCES current_user_batches(turn_id)
      );
      CREATE TABLE visible_result_items_v13 (
        group_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        message_id TEXT NOT NULL UNIQUE,
        item_json TEXT,
        item_checksum TEXT NOT NULL,
        redacted_at INTEGER,
        PRIMARY KEY(group_id, ordinal),
        CHECK (
          (item_json IS NOT NULL AND redacted_at IS NULL)
          OR (item_json IS NULL AND redacted_at IS NOT NULL)
        ),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
      );
      CREATE TABLE visible_result_actions_v13 (
        group_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        action_id TEXT NOT NULL UNIQUE,
        action_kind TEXT,
        target_key TEXT,
        target_revision TEXT,
        action_json TEXT,
        action_checksum TEXT NOT NULL,
        redacted_at INTEGER,
        PRIMARY KEY(group_id, ordinal),
        CHECK (
          (
            action_kind IS NOT NULL
            AND target_key IS NOT NULL
            AND action_json IS NOT NULL
            AND redacted_at IS NULL
          )
          OR (
            action_kind IS NULL
            AND target_key IS NULL
            AND target_revision IS NULL
            AND action_json IS NULL
            AND redacted_at IS NOT NULL
          )
        ),
        FOREIGN KEY(group_id) REFERENCES visible_result_groups(group_id)
      );
    `);
    // This checkpoint is intentionally after the new tables exist, but before
    // any existing production table is altered.  Keep it separate from the
    // next checkpoint: the migration fault matrix relies on each label naming
    // a real durable mutation boundary inside the enclosing transaction.
    this.maybeFailV13Migration('after_schema_create');
    this.addColumnIfMissing('turns', 'authority_redacted_at', 'INTEGER');
    this.addColumnIfMissing('turns', 'input_clear_epoch', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing('turn_authority_lineages', 'redacted_at', 'INTEGER');
    this.addColumnIfMissing(
      'turn_authority_lineages', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0)'
    );
    this.addColumnIfMissing('turn_authority_lineages', 'attempt_commitment', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing(
      'current_user_batches', 'item_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0)'
    );
    this.addColumnIfMissing('current_user_batches', 'tombstone_commitment', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing(
      'visible_result_groups', 'item_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(item_count >= 0)'
    );
    this.addColumnIfMissing(
      'visible_result_groups', 'action_count', 'INTEGER NOT NULL DEFAULT 0 CHECK(action_count >= 0)'
    );
    this.addColumnIfMissing('visible_result_groups', 'tombstone_commitment', "TEXT NOT NULL DEFAULT ''");
    this.addColumnIfMissing(
      'visible_result_groups', 'redaction_delivery_count', 'INTEGER CHECK(redaction_delivery_count >= 0)'
    );
    this.addColumnIfMissing('visible_result_groups', 'redaction_delivery_commitment', 'TEXT');
    this.addColumnIfMissing('cloud_deliveries', 'relay_message_id', 'TEXT');
    this.addColumnIfMissing('cloud_deliveries', 'redaction_requested_at', 'INTEGER');
    this.addColumnIfMissing('cloud_deliveries', 'redaction_acknowledged_at', 'INTEGER');
    this.addColumnIfMissing('interaction_lanes', 'clear_epoch', 'INTEGER NOT NULL DEFAULT 0');
    this.addColumnIfMissing(
      'interaction_lanes',
      'cleared_through_sequence',
      'INTEGER NOT NULL DEFAULT 0'
    );
    this.db.exec(`
      CREATE TABLE conversation_clear_controls (
        control_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        clear_epoch INTEGER NOT NULL CHECK(clear_epoch > 0),
        cleared_through_sequence INTEGER NOT NULL CHECK(cleared_through_sequence >= 0),
        requested_at INTEGER NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        UNIQUE(role_id, clear_epoch)
      );
    `);
    this.maybeFailV13Migration('after_schema_alter');

    this.db.exec(`
      INSERT INTO current_user_batch_items_v13(
        turn_id, batch_id, message_id, sequence, message_json, checksum, redacted_at
      )
      SELECT turn_id, batch_id, message_id, sequence, message_json, checksum, NULL
      FROM current_user_batch_items;
    `);
    this.maybeFailV13Migration('after_current_batch_copy');
    this.db.exec(`
      INSERT INTO visible_result_items_v13(
        group_id, ordinal, message_id, item_json, item_checksum, redacted_at
      )
      SELECT group_id, ordinal, message_id, item_json, item_checksum, NULL
      FROM visible_result_items;
    `);
    this.maybeFailV13Migration('after_visible_item_copy');
    this.db.exec(`
      INSERT INTO visible_result_actions_v13(
        group_id, ordinal, action_id, action_kind, target_key, target_revision,
        action_json, action_checksum, redacted_at
      )
      SELECT group_id, ordinal, action_id, action_kind, target_key, target_revision,
             action_json, action_checksum, NULL
      FROM visible_result_actions;
    `);
    this.maybeFailV13Migration('after_visible_action_copy');

    const copiedRows = {
      current_user_batch_items: this.db.prepare(`
        SELECT turn_id, batch_id, message_id, sequence, message_json, checksum
        FROM current_user_batch_items_v13 ORDER BY rowid
      `).all(),
      visible_result_items: this.db.prepare(`
        SELECT group_id, ordinal, message_id, item_json, item_checksum
        FROM visible_result_items_v13 ORDER BY rowid
      `).all(),
      visible_result_actions: this.db.prepare(`
        SELECT group_id, ordinal, action_id, action_kind, target_key, target_revision,
               action_json, action_checksum
        FROM visible_result_actions_v13 ORDER BY rowid
      `).all()
    };
    for (const table of Object.keys(sourceRows)) {
      if (canonicalJson(sourceRows[table]) !== canonicalJson(copiedRows[table])) {
        throw new Error(`v13 migration copy checksum mismatch: ${table}`);
      }
    }
    this.maybeFailV13Migration('after_copy_verification');

    this.db.exec(`
      ALTER TABLE current_user_batch_items RENAME TO current_user_batch_items_v12;
      ALTER TABLE visible_result_items RENAME TO visible_result_items_v12;
      ALTER TABLE visible_result_actions RENAME TO visible_result_actions_v12;
    `);
    this.maybeFailV13Migration('after_old_table_rename');
    this.db.exec(`
      ALTER TABLE current_user_batch_items_v13 RENAME TO current_user_batch_items;
      ALTER TABLE visible_result_items_v13 RENAME TO visible_result_items;
      ALTER TABLE visible_result_actions_v13 RENAME TO visible_result_actions;
    `);
    this.maybeFailV13Migration('after_new_table_rename');
    this.db.exec(`
      DROP TABLE current_user_batch_items_v12;
      DROP TABLE visible_result_items_v12;
      DROP TABLE visible_result_actions_v12;
    `);
    this.maybeFailV13Migration('after_old_table_drop');
    this.db.exec(`
      CREATE INDEX idx_current_user_batch_items_message
        ON current_user_batch_items(message_id);
    `);
    this.maybeFailV13Migration('after_index_create');
    for (const batch of this.db.prepare(
      'SELECT turn_id, batch_id FROM current_user_batches ORDER BY turn_id'
    ).all()) {
      const items = this.db.prepare(
        'SELECT sequence, message_id, checksum FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
      ).all(batch.turn_id);
      const commitment = currentUserBatchTombstoneCommitment({
        turnId: batch.turn_id, batchId: batch.batch_id, itemRows: items
      });
      this.db.prepare(
        'UPDATE current_user_batches SET item_count = ?, tombstone_commitment = ? WHERE turn_id = ?'
      ).run(commitment.itemCount, commitment.commitment, batch.turn_id);
    }
    this.maybeFailV13Migration('after_batch_parent_backfill');
    for (const group of this.db.prepare(
      'SELECT group_id FROM visible_result_groups ORDER BY group_id'
    ).all()) {
      const itemRows = this.db.prepare(
        'SELECT ordinal, message_id, item_checksum FROM visible_result_items WHERE group_id = ? ORDER BY ordinal'
      ).all(group.group_id);
      const actionRows = this.db.prepare(
        'SELECT ordinal, action_id, action_checksum FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal'
      ).all(group.group_id);
      const commitment = visibleResultTombstoneCommitment({
        groupId: group.group_id, itemRows, actionRows
      });
      this.db.prepare(
        'UPDATE visible_result_groups SET item_count = ?, action_count = ?, tombstone_commitment = ? WHERE group_id = ?'
      ).run(
        commitment.itemCount, commitment.actionCount, commitment.commitment, group.group_id
      );
    }
    this.maybeFailV13Migration('after_group_parent_backfill');
    for (const lineage of this.db.prepare(
      'SELECT lineage_key FROM turn_authority_lineages ORDER BY lineage_key'
    ).all()) {
      const attempts = this.db.prepare(
        `SELECT t.lineage_revision_at_creation, t.turn_id,
                t.rollout_key AS turn_kind,
                t.retry_of_turn_id, t.input_user_batch_id, t.envelope_checksum,
                b.tombstone_commitment AS batch_tombstone_commitment
         FROM turns t LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
         WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
         ORDER BY t.lineage_revision_at_creation`
      ).all(lineage.lineage_key);
      const commitment = authorityLineageAttemptsCommitment({
        lineageKey: lineage.lineage_key, attemptRows: attempts
      });
      this.db.prepare(
        'UPDATE turn_authority_lineages SET attempt_count = ?, attempt_commitment = ? WHERE lineage_key = ?'
      ).run(commitment.attemptCount, commitment.commitment, lineage.lineage_key);
    }
    this.maybeFailV13Migration('after_lineage_parent_backfill');

    // Verify the v13 parent commitments before any legacy tables are renamed
    // away.  This is deliberately independent of the write loops above so a
    // future change cannot silently persist a mismatched count/checksum pair.
    for (const batch of this.db.prepare(
      'SELECT turn_id, batch_id, item_count, tombstone_commitment FROM current_user_batches'
    ).all()) {
      const items = this.db.prepare(
        'SELECT sequence, message_id, checksum FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
      ).all(batch.turn_id);
      if (Number(batch.item_count) !== items.length
        || currentUserBatchTombstoneCommitment({
          turnId: batch.turn_id, batchId: batch.batch_id, itemRows: items
        }).commitment !== batch.tombstone_commitment) {
        throw new Error(`v13 migration batch parent verification conflict: ${batch.turn_id}`);
      }
    }
    for (const group of this.db.prepare(
      'SELECT group_id, item_count, action_count, tombstone_commitment FROM visible_result_groups'
    ).all()) {
      const itemRows = this.db.prepare(
        'SELECT ordinal, message_id, item_checksum FROM visible_result_items WHERE group_id = ? ORDER BY ordinal'
      ).all(group.group_id);
      const actionRows = this.db.prepare(
        'SELECT ordinal, action_id, action_checksum FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal'
      ).all(group.group_id);
      if (Number(group.item_count) !== itemRows.length
        || Number(group.action_count) !== actionRows.length
        || visibleResultTombstoneCommitment({
          groupId: group.group_id, itemRows, actionRows
        }).commitment !== group.tombstone_commitment) {
        throw new Error(`v13 migration group parent verification conflict: ${group.group_id}`);
      }
    }
    for (const lineage of this.db.prepare(
      'SELECT lineage_key, attempt_count, attempt_commitment FROM turn_authority_lineages'
    ).all()) {
      const attempts = this.db.prepare(`
        SELECT t.lineage_revision_at_creation, t.turn_id,
               t.rollout_key AS turn_kind, t.retry_of_turn_id,
               t.input_user_batch_id, t.envelope_checksum,
               b.tombstone_commitment AS batch_tombstone_commitment
        FROM turns t LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
        WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
        ORDER BY t.lineage_revision_at_creation
      `).all(lineage.lineage_key);
      if (Number(lineage.attempt_count) !== attempts.length
        || authorityLineageAttemptsCommitment({
          lineageKey: lineage.lineage_key, attemptRows: attempts
        }).commitment !== lineage.attempt_commitment) {
        throw new Error(`v13 migration lineage parent verification conflict: ${lineage.lineage_key}`);
      }
    }
    this.maybeFailV13Migration('after_parent_backfill_verification');
    this.db.exec('PRAGMA user_version = 13;');
    this.maybeFailV13Migration('after_version_write');
  }

  migrateReleaseAuthorityV14Internal() {
    if (this.userVersion() !== 13) {
      throw new Error(`v14 migration source version mismatch: ${this.userVersion()}`);
    }
    this.assertAgencyV10Invariants();
    this.assertVisibleAuthorityV13Invariants();
    this.assertReleaseAuthorityV14PreflightInternal();
    this.maybeFailV14Migration('before_drop');
    this.db.exec('DROP INDEX IF EXISTS idx_turns_rollout_canary_slot;');
    this.maybeFailV14Migration('after_drop');
    this.db.exec(`
      CREATE UNIQUE INDEX idx_turns_rollout_canary_root_slot
      ON turns(rollout_key, canary_epoch, canary_slot)
      WHERE canary_slot IS NOT NULL AND retry_of_turn_id IS NULL;
    `);
    this.maybeFailV14Migration('after_root_index_create');
    this.db.exec(`
      CREATE INDEX idx_turns_rollout_canary_lineage_slot
      ON turns(rollout_key, canary_epoch, canary_slot, authority_lineage_key)
      WHERE canary_slot IS NOT NULL;
    `);
    this.maybeFailV14Migration('after_lineage_index_create');
    this.assertReleaseAuthorityV14IndexShapeInternal({ allowVersionThirteen: true });
    this.maybeFailV14Migration('after_invariant_verification');
    this.maybeFailV14Migration('before_version_write');
    this.db.exec('PRAGMA user_version = 14;');
  }

  maybeFailV15Migration(step) {
    if (this.migrationOptions?.v15MigrationFaultStep === step) {
      throw new Error(`forced v15 migration fault: ${step}`);
    }
  }

  migrateConversationClearAuthorityV15Internal() {
    if (this.userVersion() !== 14) {
      throw new Error(`v15 migration source version mismatch: ${this.userVersion()}`);
    }
    const sourceColumns = this.db.prepare(
      'PRAGMA table_info(conversation_clear_controls)'
    ).all().map(row => row.name);
    const legacyColumns = [
      'control_id', 'role_id', 'clear_epoch', 'cleared_through_sequence',
      'requested_at', 'applied_at', 'checksum'
    ];
    if (canonicalJson(sourceColumns) !== canonicalJson(legacyColumns)) {
      throw new Error('v15 migration source schema conflict');
    }
    this.db.exec(`
      CREATE TABLE conversation_clear_controls_v15 (
        control_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        peer_id TEXT,
        clear_epoch INTEGER NOT NULL CHECK(clear_epoch > 0),
        cleared_through_sequence INTEGER NOT NULL CHECK(cleared_through_sequence >= 0),
        requested_at INTEGER NOT NULL,
        applied_at INTEGER NOT NULL,
        input_cursor_checksum TEXT,
        checksum TEXT NOT NULL,
        applied_checksum TEXT,
        authority_version INTEGER NOT NULL CHECK(authority_version IN (0, 1)),
        semantic_json TEXT,
        UNIQUE(role_id, clear_epoch),
        CHECK(
          (authority_version = 0
            AND peer_id IS NULL
            AND input_cursor_checksum IS NULL
            AND applied_checksum IS NULL
            AND semantic_json IS NULL)
          OR
          (authority_version = 1
            AND peer_id IS NOT NULL
            AND input_cursor_checksum IS NOT NULL
            AND applied_checksum IS NOT NULL
            AND semantic_json IS NOT NULL)
        )
      );
    `);
    this.maybeFailV15Migration('after_new_table');
    this.db.exec(`
      INSERT INTO conversation_clear_controls_v15(
        control_id, role_id, clear_epoch, cleared_through_sequence,
        requested_at, applied_at, checksum,
        peer_id, input_cursor_checksum, applied_checksum, authority_version, semantic_json
      )
      SELECT control_id, role_id, clear_epoch, cleared_through_sequence,
             requested_at, applied_at, checksum,
             NULL, NULL, NULL, 0, NULL
      FROM conversation_clear_controls;
    `);
    this.maybeFailV15Migration('after_row_copy');
    const sourceCount = Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls'
    ).get().count);
    const copiedCount = Number(this.db.prepare(
      'SELECT COUNT(*) AS count FROM conversation_clear_controls_v15'
    ).get().count);
    if (sourceCount !== copiedCount) throw new Error('v15 migration row copy conflict');
    this.maybeFailV15Migration('after_projection_verification');
    this.db.exec(`
      ALTER TABLE conversation_clear_controls RENAME TO conversation_clear_controls_v14;
      ALTER TABLE conversation_clear_controls_v15 RENAME TO conversation_clear_controls;
    `);
    this.maybeFailV15Migration('after_table_swap');
    this.db.exec(`
      CREATE UNIQUE INDEX ux_conversation_clear_controls_role_epoch_v15
      ON conversation_clear_controls(role_id, clear_epoch);
    `);
    this.maybeFailV15Migration('after_index_recreation');
    this.db.exec('DROP TABLE conversation_clear_controls_v14;');
    this.db.exec('PRAGMA user_version = 15;');
    this.maybeFailV15Migration('after_version_write');
  }

  assertConversationClearAuthorityV15SchemaInternal() {
    if (this.userVersion() !== 15) {
      throw new Error(`v15 authority schema user_version mismatch: ${this.userVersion()}`);
    }
    const expected = [
      'control_id', 'role_id', 'peer_id', 'clear_epoch', 'cleared_through_sequence',
      'requested_at', 'applied_at', 'input_cursor_checksum', 'checksum', 'applied_checksum',
      'authority_version', 'semantic_json'
    ];
    const actual = this.db.prepare(
      'PRAGMA table_info(conversation_clear_controls)'
    ).all().map(row => row.name);
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error('v15 authority schema column conflict');
    }
  }

  assertConversationClearAuthorityV15Invariants() {
    this.assertConversationClearAuthorityV15SchemaInternal();
    const rows = this.db.prepare(
      'SELECT * FROM conversation_clear_controls ORDER BY control_id'
    ).all();
    const seenRoleEpoch = new Set();
    for (const row of rows) {
      if (!Number.isInteger(row.authority_version)
        || ![0, 1].includes(row.authority_version)
        || !Number.isSafeInteger(row.clear_epoch) || row.clear_epoch <= 0
        || !Number.isSafeInteger(row.cleared_through_sequence)
        || row.cleared_through_sequence < 0
        || !Number.isSafeInteger(row.requested_at)
        || !Number.isSafeInteger(row.applied_at)
        || typeof row.control_id !== 'string' || !row.control_id
        || typeof row.role_id !== 'string' || !row.role_id) {
        throw new Error(`v15 authority row shape conflict: ${row.control_id}`);
      }
      const roleEpoch = `${row.role_id}\u0000${row.clear_epoch}`;
      if (seenRoleEpoch.has(roleEpoch)) {
        throw new Error(`v15 authority duplicate role epoch: ${row.role_id}`);
      }
      seenRoleEpoch.add(roleEpoch);
      if (row.authority_version === 0) {
        if (row.peer_id !== null || row.input_cursor_checksum !== null
          || row.applied_checksum !== null || row.semantic_json !== null) {
          throw new Error(`v15 authority-v0 projection conflict: ${row.control_id}`);
        }
        continue;
      }
      if (typeof row.peer_id !== 'string' || !row.peer_id
        || typeof row.input_cursor_checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.input_cursor_checksum)
        || typeof row.checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.checksum)
        || typeof row.applied_checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(row.applied_checksum)
        || typeof row.semantic_json !== 'string') {
        throw new Error(`v15 authority-v1 projection conflict: ${row.control_id}`);
      }
      if (row.requested_at <= 0 || row.applied_at <= 0) {
        throw new Error(`v15 authority-v1 timestamp conflict: ${row.control_id}`);
      }
      const wire = parseJson(row.semantic_json, null);
      let validated;
      try {
        validated = validateConversationClearControl(wire);
      } catch {
        throw new Error(`v15 authority semantic conflict: ${row.control_id}`);
      }
      if (canonicalJson(validated) !== row.semantic_json
        || validated.controlId !== row.control_id
        || validated.roleId !== row.role_id
        || validated.peerId !== row.peer_id
        || validated.clearEpoch !== row.clear_epoch
        || validated.clearedThroughSequence !== row.cleared_through_sequence
        || validated.requestedAt !== row.requested_at
        || validated.inputCursorChecksum !== row.input_cursor_checksum
        || validated.checksum !== row.checksum) {
        throw new Error(`v15 authority semantic projection conflict: ${row.control_id}`);
      }
      const appliedBody = {
        protocolVersion: 3,
        type: 'CONVERSATION_CLEAR_APPLIED',
        controlId: row.control_id,
        controlChecksum: row.checksum,
        roleId: row.role_id,
        peerId: row.peer_id,
        clearEpoch: row.clear_epoch,
        clearedThroughSequence: row.cleared_through_sequence,
        appliedAt: row.applied_at
      };
      const appliedWire = validateConversationClearApplied({
        ...appliedBody,
        checksum: contentHash(appliedBody)
      });
      if (appliedWire.checksum !== row.applied_checksum) {
        throw new Error(`v15 authority applied proof conflict: ${row.control_id}`);
      }
    }
    const agencyAudits = this.db.prepare(`
      SELECT s.entity_id, s.created_at, c.role_id
      FROM sync_log s
      JOIN conversation_clear_controls c ON c.control_id = s.entity_id
      WHERE s.entity_type = 'agency_redaction' AND s.operation = 'redact'
      ORDER BY s.seq
    `).all();
    const latestAgencyByRole = new Map();
    for (const audit of agencyAudits) latestAgencyByRole.set(audit.role_id, audit.entity_id);
    for (const audit of agencyAudits) {
      const control = this.db.prepare(
        'SELECT role_id, applied_at FROM conversation_clear_controls WHERE control_id = ?'
      ).get(audit.entity_id);
      if (!control) throw new Error(`agency redaction control conflict: ${audit.entity_id}`);
      this.assertAgencyPruneClosureInternal({
        roleId: control.role_id,
        controlId: audit.entity_id,
        redactedAt: Number(audit.created_at),
        validateCurrentCognitive: latestAgencyByRole.get(control.role_id) === audit.entity_id
      });
    }
  }

  assertReleaseAuthorityV14PreflightInternal() {
    const invalidSlot = this.db.prepare(`
      SELECT turn_id, canary_slot
      FROM turns
      WHERE canary_slot IS NOT NULL
        AND (typeof(canary_slot) != 'integer' OR canary_slot < 1 OR canary_slot > 10)
      LIMIT 1
    `).get();
    if (invalidSlot) {
      throw new Error(`v14 migration canary slot conflict: ${invalidSlot.turn_id}`);
    }
    const lifePlanningColumns = new Set(this.db.prepare(
      'PRAGMA table_info(cognition_life_planning_attempts)'
    ).all().map(row => row.name));
    const invalidLifeSlot = lifePlanningColumns.has('canary_slot')
      ? this.db.prepare(`
          SELECT planning_id, canary_slot
          FROM cognition_life_planning_attempts
          WHERE canary_slot IS NOT NULL
            AND (typeof(canary_slot) != 'integer' OR canary_slot < 1 OR canary_slot > 10)
          LIMIT 1
        `).get()
      : null;
    if (invalidLifeSlot) {
      throw new Error(`v14 migration life canary slot conflict: ${invalidLifeSlot.planning_id}`);
    }
    const duplicateRoot = this.db.prepare(`
      SELECT rollout_key, canary_epoch, canary_slot, COUNT(*) AS count
      FROM turns
      WHERE canary_slot IS NOT NULL AND retry_of_turn_id IS NULL
      GROUP BY rollout_key, canary_epoch, canary_slot
      HAVING COUNT(*) != 1
      LIMIT 1
    `).get();
    if (duplicateRoot) throw new Error('v14 migration root canary slot conflict');
    const retryMismatch = this.db.prepare(`
      SELECT retry.turn_id
      FROM turns retry
      JOIN turns root
        ON root.authority_lineage_key = retry.authority_lineage_key
       AND root.retry_of_turn_id IS NULL
      WHERE retry.retry_of_turn_id IS NOT NULL
        AND (
          retry.rollout_key IS NOT root.rollout_key
          OR retry.canary_epoch IS NOT root.canary_epoch
          OR retry.canary_slot IS NOT root.canary_slot
          OR retry.authoritative_release_id IS NOT root.authoritative_release_id
          OR retry.comparison_release_id IS NOT root.comparison_release_id
          OR retry.authoritative_pipeline_checksum IS NOT root.authoritative_pipeline_checksum
          OR retry.comparison_pipeline_checksum IS NOT root.comparison_pipeline_checksum
        )
      LIMIT 1
    `).get();
    if (retryMismatch) {
      throw new Error(`v14 migration retry canary authority conflict: ${retryMismatch.turn_id}`);
    }
    for (const rollout of this.listCognitionRollouts()) {
      try {
        this.readCanaryOutstandingAuthorityInternal({
          rolloutKey: rollout.rolloutKey,
          canaryEpoch: rollout.canaryEpoch
        });
      } catch (error) {
        if (/CANARY_ACCOUNTING_INVARIANT/.test(String(error?.message || ''))) {
          throw new Error(`v14 migration canary accounting conflict: ${rollout.rolloutKey}`);
        }
        throw error;
      }
    }
  }

  assertReleaseAuthorityV14IndexShapeInternal({ allowVersionThirteen = false } = {}) {
    const version = this.userVersion();
    if (version !== 14 && version !== 15 && !(allowVersionThirteen && version === 13)) {
      throw new Error(`v14 invariant user_version mismatch: ${version}`);
    }
    const indexes = new Map(this.db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'turns'
    `).all().map(row => [row.name, String(row.sql || '')]));
    if (indexes.has('idx_turns_rollout_canary_slot')
      || !/UNIQUE INDEX idx_turns_rollout_canary_root_slot/i.test(
        indexes.get('idx_turns_rollout_canary_root_slot') || ''
      )
      || !/retry_of_turn_id IS NULL/i.test(
        indexes.get('idx_turns_rollout_canary_root_slot') || ''
      )
      || !/authority_lineage_key/i.test(
        indexes.get('idx_turns_rollout_canary_lineage_slot') || ''
      )) {
      throw new Error('v14 invariant canary slot index mismatch');
    }
  }

  assertReleaseAuthorityV14Invariants() {
    this.assertReleaseAuthorityV14IndexShapeInternal();
    this.assertReleaseAuthorityV14PreflightInternal();
    for (const rollout of this.listCognitionRollouts()) {
      const authority = this.readCanaryOutstandingAuthorityInternal({
        rolloutKey: rollout.rolloutKey,
        canaryEpoch: rollout.canaryEpoch
      });
      const expected = rollout.canaryStartedCount
        - rollout.canaryCompletedCount
        - rollout.canaryFailureCount;
      if (expected < 0 || authority.count !== expected) {
        throw new Error(
          `CANARY_ACCOUNTING_INVARIANT: ${rollout.rolloutKey} expected=${expected} actual=${authority.count}`
        );
      }
    }
  }

  assertVisibleAuthorityV11Invariants({
    allowVersionTen = false,
    allowVersionTwelve = false,
    allowVersionThirteen = false,
    allowVersionFourteen = false,
    allowVersionFifteen = false
  } = {}) {
    const version = this.userVersion();
    const allowV13Semantics = allowVersionThirteen || allowVersionFourteen || allowVersionFifteen;
    const expectedVersion = allowVersionFifteen
      ? 15
      : allowVersionFourteen
        ? 14
      : allowVersionThirteen
        ? 13
        : allowVersionTwelve
          ? 12
          : allowVersionTen
            ? 10
            : 11;
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
    const hasVisibleResultManifests = existing.has('visible_result_manifests');
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

    // The lineage commitment deliberately has a small, stable seven-field
    // shape.  Model/release/comparison pins are still immutable live retry
    // inputs, but are validated here rather than being smuggled into that
    // commitment namespace.  Redaction intentionally clears annotations, so
    // its audit shell is exempt from this live-input comparison.
    if (allowV13Semantics) {
      const retryPins = this.db.prepare(`
        SELECT t.*, p.rollout_key AS parent_rollout_key,
               p.rollout_revision AS parent_rollout_revision,
               p.rollout_evidence_epoch AS parent_rollout_evidence_epoch,
               p.authoritative_release_id AS parent_authoritative_release_id,
               p.authoritative_pipeline_checksum AS parent_authoritative_pipeline_checksum,
               p.comparison_release_id AS parent_comparison_release_id,
               p.comparison_pipeline_checksum AS parent_comparison_pipeline_checksum,
               p.comparison_mode AS parent_comparison_mode,
               p.annotation_snapshot_json AS parent_annotation_snapshot_json
        FROM turns t
        JOIN turns p ON p.turn_id = t.retry_of_turn_id
        JOIN turn_authority_lineages l ON l.lineage_key = t.authority_lineage_key
        WHERE t.result_authority_version = 1
          AND t.retry_of_turn_id IS NOT NULL
          AND l.redacted_at IS NULL
      `).all();
      for (const retry of retryPins) {
        const mismatch = retry.rollout_key !== retry.parent_rollout_key
          || Number(retry.rollout_revision) !== Number(retry.parent_rollout_revision)
          || Number(retry.rollout_evidence_epoch) !== Number(retry.parent_rollout_evidence_epoch)
          || retry.authoritative_release_id !== retry.parent_authoritative_release_id
          || retry.authoritative_pipeline_checksum !== retry.parent_authoritative_pipeline_checksum
          || retry.comparison_release_id !== retry.parent_comparison_release_id
          || retry.comparison_pipeline_checksum !== retry.parent_comparison_pipeline_checksum
          || retry.comparison_mode !== retry.parent_comparison_mode
          || canonicalJson(parseJson(retry.annotation_snapshot_json, null))
            !== canonicalJson(parseJson(retry.parent_annotation_snapshot_json, null));
        if (mismatch) {
          throw new Error(`v13 invariant canonical retry pin conflict: ${retry.turn_id}`);
        }
      }
    }

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

    assertNoInvariantRow(
      'receipt_payload_origin',
      allowV13Semantics ? `
      SELECT lineage_key, authority_origin, commit_payload_version
      FROM visible_commit_receipts
      WHERE (authority_origin = 'pc'
             AND commit_payload_version NOT IN (
               'pc-visible-commit-v1', 'pc-visible-commit-v2', 'pc-visible-commit-v3',
               'pc-visible-commit-v4'
             ))
         OR (authority_origin = 'android_fallback'
             AND commit_payload_version NOT IN (
               'android-fallback-commit-v1', 'android-fallback-commit-v2'
             ))
         OR authority_origin NOT IN ('pc', 'android_fallback')
      LIMIT 1
    ` : `
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

    if (!allowV13Semantics) {
      assertNoInvariantRow('canonical_group_item_shape', `
      SELECT g.group_id, COUNT(i.ordinal) AS item_count,
             MIN(i.ordinal) AS min_ordinal, MAX(i.ordinal) AS max_ordinal
      FROM visible_result_groups g
      LEFT JOIN visible_result_items i ON i.group_id = g.group_id
      GROUP BY g.group_id
      HAVING COUNT(i.ordinal) < 1
         OR min_ordinal != 0
         OR max_ordinal != COUNT(i.ordinal) - 1
      LIMIT 1
      `);

    }

    assertNoInvariantRow('canonical_item_message_projection', `
      SELECT i.group_id, i.ordinal, i.message_id
      FROM visible_result_items i
      JOIN visible_result_groups g ON g.group_id = i.group_id
      ${hasVisibleResultManifests ? 'JOIN visible_result_manifests vm ON vm.group_id = g.group_id' : ''}
      JOIN turns t ON t.turn_id = g.authoritative_turn_id
      LEFT JOIN messages msg
        ON msg.message_id = i.message_id
       AND msg.authority_group_id = i.group_id
       AND msg.group_ordinal = i.ordinal
       AND msg.turn_id = g.authoritative_turn_id
      WHERE msg.message_id IS NULL
         OR msg.character_id IS NOT g.role_id
         OR msg.speaker_id IS NOT g.role_id
         OR msg.speaker_type != 'character'
         OR msg.recipient_id != CASE
              WHEN (
                json_extract(t.envelope_json, '$.protocolVersion') = 3
                AND ${hasVisibleResultManifests
                  ? "((json_extract(t.envelope_json, '$.kind') = 'PROACTIVE_MOMENT' AND vm.payload_version = 'pc-visible-commit-v4') OR json_extract(t.envelope_json, '$.kind') IN ('ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'))"
                  : '0'}
              ) OR (
                json_extract(t.envelope_json, '$.redacted') = 1
                AND ${hasVisibleResultManifests
                  ? "((t.rollout_key = 'PROACTIVE_MOMENT' AND vm.payload_version = 'pc-visible-commit-v4') OR t.rollout_key IN ('ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'))"
                  : '0'}
              )
              THEN 'public_moments' ELSE 'user' END
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

    if (!allowV13Semantics) for (const turn of this.db.prepare(`
      SELECT turn_id, envelope_json, envelope_checksum
      FROM turns WHERE result_authority_version = 1
    `).all()) {
      if (contentHash(parseJson(turn.envelope_json, {})) !== turn.envelope_checksum) {
        throw new Error(`v11 invariant canonical_envelope_checksum: ${turn.turn_id}`);
      }
    }
    if (!allowV13Semantics) for (const item of this.db.prepare(`
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

  assertVisibleAuthorityV12Invariants({
    allowVersionThirteen = false,
    allowHistoricalStatePatch = false
  } = {}) {
    this.assertVisibleAuthorityV11Invariants({
      allowVersionTwelve: !allowVersionThirteen,
      allowVersionThirteen
    });
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
             m.redacted_at AS manifest_redacted_at,
             t.envelope_json AS group_envelope_json
      FROM visible_result_groups g
      LEFT JOIN visible_commit_receipts r ON r.group_id = g.group_id
      LEFT JOIN visible_result_manifests m ON m.group_id = g.group_id
      LEFT JOIN turns t ON t.turn_id = g.authoritative_turn_id
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
      const manifestActions = (semantic.actions || []).map(action =>
        group.authority_origin === 'android_fallback' && action && typeof action === 'object'
          && Object.hasOwn(action, 'actionId')
          ? {
              kind: action.kind,
              targetKey: action.targetKey,
              targetRevision: action.targetRevision,
              payload: action.payload
            }
          : action
      );
      if (canonicalJson(items) !== canonicalJson(semantic.visibleItems || [])
        || canonicalJson(actions) !== canonicalJson(manifestActions)) {
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
      if (semantic.statePatch && !cognitiveState && !allowHistoricalStatePatch) {
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
        const groupEnvelope = parseJson(group.group_envelope_json, {});
        assertCognitiveStateOpenThreadProjection({
          state,
          semanticPatch: semantic.statePatch,
          protocolVersion: groupEnvelope.protocolVersion,
          authoritativeTurnId: group.authoritative_turn_id,
          envelope: groupEnvelope,
          errorMessage: `v12 invariant manifest cognitive state authority: ${group.group_id}`
        });
      }
    }
    if (allowHistoricalStatePatch) {
      for (const cognitiveState of this.db.prepare(`
        SELECT c.*, g.role_id AS group_role_id,
               g.authoritative_turn_id, m.semantic_json,
               t.envelope_json AS group_envelope_json
        FROM cognitive_states c
        LEFT JOIN visible_result_groups g
          ON g.group_id = c.last_authority_group_id
        LEFT JOIN visible_result_manifests m
          ON m.group_id = c.last_authority_group_id
        LEFT JOIN turns t
          ON t.turn_id = g.authoritative_turn_id
        WHERE c.last_authority_group_id IS NOT NULL
      `).all()) {
        const semantic = parseJson(cognitiveState.semantic_json, null);
        const state = parseJson(cognitiveState.state_json, {});
        const expectedOpenThreads = (semantic?.statePatch?.openThreads || []).map(item =>
          typeof item === 'string' ? item : String(item?.threadId || '')
        ).filter(Boolean);
        if (!semantic?.statePatch
          || cognitiveState.group_role_id !== cognitiveState.role_id
          || cognitiveState.authoritative_turn_id !== cognitiveState.last_turn_id
          || cognitiveState.checksum !== contentHash(state)
          || String(state.fastState?.mood || '') !== String(semantic.statePatch.mood || '')
          || canonicalJson(state.fastState?.openThreadIds || [])
            !== canonicalJson(expectedOpenThreads)) {
          throw new Error(
            `v12 invariant current cognitive state authority: ${cognitiveState.role_id}`
          );
        }
        const groupEnvelope = parseJson(cognitiveState.group_envelope_json, {});
        assertCognitiveStateOpenThreadProjection({
          state,
          semanticPatch: semantic.statePatch,
          protocolVersion: groupEnvelope.protocolVersion,
          authoritativeTurnId: cognitiveState.authoritative_turn_id,
          envelope: groupEnvelope,
          errorMessage: `v12 invariant current cognitive state authority: ${cognitiveState.role_id}`
        });
      }
    }
  }

  assertVisibleAuthorityV13SharedSchemaInternal() {
    const exactColumns = (table, expected) => {
      const actual = this.db.prepare(`PRAGMA table_info("${table}")`).all()
        .map(row => row.name);
      if (canonicalJson(actual) !== canonicalJson(expected)) {
        throw new Error(`v13 invariant schema mismatch: ${table}`);
      }
    };
    exactColumns('current_user_batch_items', [
      'turn_id', 'batch_id', 'message_id', 'sequence',
      'message_json', 'checksum', 'redacted_at'
    ]);
    exactColumns('visible_result_items', [
      'group_id', 'ordinal', 'message_id', 'item_json', 'item_checksum', 'redacted_at'
    ]);
    exactColumns('visible_result_actions', [
      'group_id', 'ordinal', 'action_id', 'action_kind', 'target_key',
      'target_revision', 'action_json', 'action_checksum', 'redacted_at'
    ]);
    for (const [table, columns] of Object.entries({
      turns: ['authority_redacted_at', 'input_clear_epoch'],
      turn_authority_lineages: ['redacted_at', 'attempt_count', 'attempt_commitment'],
      current_user_batches: ['item_count', 'tombstone_commitment'],
      visible_result_groups: [
        'item_count', 'action_count', 'tombstone_commitment',
        'redaction_delivery_count', 'redaction_delivery_commitment'
      ],
      cloud_deliveries: [
        'relay_message_id', 'redaction_requested_at', 'redaction_acknowledged_at'
      ],
      interaction_lanes: ['clear_epoch', 'cleared_through_sequence']
    })) {
      const actual = new Set(this.db.prepare(`PRAGMA table_info("${table}")`).all()
        .map(row => row.name));
      const missing = columns.filter(column => !actual.has(column));
      if (missing.length) {
        throw new Error(`v13 invariant schema missing ${table}: ${missing.join(',')}`);
      }
    }
  }

  assertVisibleAuthorityV13SchemaInternal() {
    if (![13, 14].includes(this.userVersion())) {
      throw new Error(`v13 invariant user_version mismatch: ${this.userVersion()}`);
    }
    this.assertVisibleAuthorityV13SharedSchemaInternal();
    const actual = this.db.prepare(
      'PRAGMA table_info(conversation_clear_controls)'
    ).all().map(row => row.name);
    const expected = [
      'control_id', 'role_id', 'clear_epoch', 'cleared_through_sequence',
      'requested_at', 'applied_at', 'checksum'
    ];
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      throw new Error('v13 invariant schema mismatch: conversation_clear_controls');
    }
  }

  assertVisibleAuthorityV15LayerSchemaInternal() {
    if (this.userVersion() !== 15) {
      throw new Error(`v15 invariant user_version mismatch: ${this.userVersion()}`);
    }
    this.assertVisibleAuthorityV13SharedSchemaInternal();
  }

  assertCanonicalTurnInputAuthorityInternal({
    storedTurn: turn, incomingEnvelope: envelope, mode = 'live_reopen'
  }) {
    if (!['live_reopen', 'redacted_replay'].includes(mode)) {
      throw new Error('v13 invariant canonical turn input authority mode conflict');
    }
    const requireEnvelopeChecksum = mode === 'live_reopen';
    if (requireEnvelopeChecksum
      && (contentHash(envelope) !== turn.envelopeChecksum
        || String(envelope.kind || '') !== String(turn.rolloutKey || ''))) {
      throw new Error('v13 invariant canonical turn input authority conflict');
    }
    const normalized = resolveCurrentUserBatch(envelope);
    const batch = this.db.prepare(
      'SELECT * FROM current_user_batches WHERE turn_id = ?'
    ).get(turn.turnId);
    const items = this.db.prepare(`
      SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence
    `).all(turn.turnId);
    if (!normalized) {
      if (batch || items.length) throw new Error('retry canonical batch conflict');
      return;
    }
    if (!normalized.complete
      || normalized.missingMessageIds.length !== 0
      || normalized.messageIds.length !== normalized.messages.length
      || normalized.messageIds.some((messageId, sequence) =>
        String(normalized.messages[sequence]?.messageId || '') !== String(messageId))) {
      throw new Error('v13 invariant canonical turn input authority conflict');
    }
    const canonicalHeader = {
      batchId: normalized.batchId,
      sourceMessageId: normalized.sourceMessageId,
      messageIds: normalized.messageIds,
      startedAt: normalized.startedAt,
      committedAt: normalized.committedAt
    };
    if (!batch
      || batch.batch_id !== turn.inputUserBatchId
      || batch.batch_id !== normalized.batchId
      || batch.character_id !== turn.characterId
      || batch.source_message_id !== normalized.sourceMessageId
      || Number(batch.started_at) !== Number(normalized.startedAt)
      || Number(batch.committed_at) !== Number(normalized.committedAt)
      || batch.checksum !== contentHash(canonicalHeader)
      || Number(batch.item_count) !== items.length
      || items.length !== normalized.messages.length) {
      throw new Error('v13 invariant canonical turn input authority conflict');
    }
    for (let sequence = 0; sequence < items.length; sequence += 1) {
      const item = items[sequence];
      const message = normalized.messages[sequence];
      const liveItemConflict = mode === 'live_reopen'
        && (item.message_json === null || item.redacted_at !== null
          || canonicalJson(parseJson(item.message_json, null)) !== canonicalJson(message));
      const redactedItemConflict = mode === 'redacted_replay'
        && (item.message_json !== null
          || !Number.isSafeInteger(Number(turn.authorityRedactedAt))
          || Number(item.redacted_at) !== Number(turn.authorityRedactedAt));
      if (!message || Number(item.sequence) !== sequence
        || item.batch_id !== batch.batch_id
        || item.message_id !== message.messageId
        || item.checksum !== contentHash(message)
        || liveItemConflict || redactedItemConflict) {
        throw new Error('v13 invariant canonical turn input authority conflict');
      }
    }
  }

  assertCanonicalLineageMessageAuthorityInternal({
    lineageKey, mode, groupId = null
  }) {
    if (!['live', 'redacted'].includes(mode)) {
      throw new Error('canonical lineage message authority mode conflict');
    }
    const conflictPrefix = mode === 'redacted'
      ? 'redacted authority canonical lineage'
      : 'canonical lineage';
    const attempts = this.db.prepare(`
      SELECT * FROM turns WHERE authority_lineage_key = ?
      ORDER BY lineage_revision_at_creation, turn_id
    `).all(String(lineageKey || ''));
    const roots = attempts.filter(turn => turn.retry_of_turn_id == null);
    if (!attempts.length || roots.length !== 1) {
      throw new Error(`${conflictPrefix} message root authority conflict`);
    }
    const root = roots[0];
    const turnIds = attempts.map(turn => turn.turn_id);
    const turnMarks = turnIds.map(() => '?').join(',');
    const batchItems = this.db.prepare(`
      SELECT * FROM current_user_batch_items
      WHERE turn_id IN (${turnMarks})
      ORDER BY turn_id, sequence
    `).all(...turnIds);
    const expectedUserIds = [...new Set(batchItems.map(item => item.message_id))];
    const messages = this.db.prepare(`
      SELECT * FROM messages
      WHERE turn_id IN (${turnMarks})
        ${groupId == null ? '' : 'OR authority_group_id = ?'}
    `).all(...turnIds, ...(groupId == null ? [] : [String(groupId)]));
    const messageById = new Map(messages.map(message => [message.message_id, message]));
    const expectedUserById = new Map();
    if (expectedUserIds.length && mode === 'live') {
      const rootEnvelope = parseJson(root.envelope_json, {});
      const rootBatch = resolveCurrentUserBatch(rootEnvelope);
      if (!rootBatch || !rootBatch.complete || rootBatch.missingMessageIds.length) {
        throw new Error(`${conflictPrefix} user message authority conflict`);
      }
      for (const message of rootBatch.messages) {
        expectedUserById.set(message.messageId, {
          messageId: message.messageId,
          turnId: root.turn_id,
          characterId: root.character_id,
          speakerId: message.speakerId,
          speakerType: message.speakerType,
          recipientId: message.recipientId,
          content: message.content,
          sentAt: message.sentAt,
          origin: 'phone',
          deviceId: root.device_id,
          deviceSeq: message.messageId === rootEnvelope.message?.messageId
            ? root.device_seq : null
        });
      }
    } else {
      expectedUserIds.forEach(messageId => expectedUserById.set(messageId, { messageId }));
    }
    if (expectedUserById.size !== expectedUserIds.length
      || expectedUserIds.some(messageId => !expectedUserById.has(messageId))) {
      throw new Error(`${conflictPrefix} user message authority conflict`);
    }
    for (const messageId of expectedUserIds) {
      const row = messageById.get(messageId);
      const expected = expectedUserById.get(messageId);
      if (!row || row.turn_id !== root.turn_id
        || row.character_id !== root.character_id
        || row.speaker_id !== 'user' || row.speaker_type !== 'user'
        || row.recipient_id !== root.character_id
        || row.authority_group_id !== null || row.group_ordinal !== null
        || (mode === 'live' && (
          row.content !== expected.content
          || Number(row.sent_at) !== Number(expected.sentAt)
          || row.origin !== expected.origin
          || row.device_id !== expected.deviceId
          || Number(row.device_seq ?? -1) !== Number(expected.deviceSeq ?? -1)
          || row.checksum !== contentHash(expected)
        ))
        || (mode === 'redacted' && row.content !== '')) {
        throw new Error(`${conflictPrefix} user message authority conflict`);
      }
    }

    const itemRows = groupId == null ? [] : this.db.prepare(`
      SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal
    `).all(String(groupId));
    const group = groupId == null ? null : this.db.prepare(`
      SELECT * FROM visible_result_groups WHERE group_id = ?
    `).get(String(groupId));
    const groupManifest = groupId == null ? null : this.db.prepare(`
      SELECT payload_version FROM visible_result_manifests WHERE group_id = ?
    `).get(String(groupId));
    const groupTurn = groupId == null ? null : this.db.prepare(`
      SELECT envelope_json, rollout_key, result_authority_version
      FROM turns WHERE turn_id = ?
    `).get(group.authoritative_turn_id);
    const groupEnvelope = parseJson(groupTurn?.envelope_json, null);
    const recipientProtocolVersion = mode === 'redacted'
      ? (groupManifest?.payload_version === 'pc-visible-commit-v4'
        || ['ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'].includes(groupTurn?.rollout_key)
        ? 3 : 2)
      : groupEnvelope?.protocolVersion;
    const expectedCharacterRecipient = expectedCanonicalCharacterRecipient({
      protocolVersion: recipientProtocolVersion,
      turnKind: mode === 'redacted' ? groupTurn?.rollout_key : groupEnvelope?.kind,
      payloadVersion: groupManifest?.payload_version
    });
    const expectedCharacterIds = new Set(itemRows.map(item => item.message_id));
    if ((groupId == null && itemRows.length)
      || (groupId != null && (!group
        || itemRows.length !== Number(group.item_count)))) {
      throw new Error(`${conflictPrefix} character message authority conflict`);
    }
    for (const item of itemRows) {
      const row = messageById.get(item.message_id);
      const semantic = mode === 'live' ? parseJson(item.item_json, null) : null;
      const projection = semantic && {
        messageId: item.message_id,
        content: String(semantic.content || ''),
        recipientId: String(semantic.recipientId || 'user')
      };
      if (!row || Number(item.ordinal) !== Number(row.group_ordinal)
        || row.turn_id !== group.authoritative_turn_id
        || row.character_id !== group.role_id
        || row.speaker_id !== group.role_id || row.speaker_type !== 'character'
        || row.recipient_id !== expectedCharacterRecipient || row.authority_group_id !== group.group_id
        || (mode === 'live' && (!semantic
          || row.content !== projection.content
          || row.checksum !== contentHash(projection)))
        || (mode === 'redacted' && row.content !== '')) {
        throw new Error(`${conflictPrefix} character message authority conflict`);
      }
    }
    const allowedIds = new Set([...expectedUserIds, ...expectedCharacterIds]);
    if (messages.length !== allowedIds.size
      || messages.some(message => !allowedIds.has(message.message_id))) {
      throw new Error(`${conflictPrefix} message set authority conflict`);
    }
    return { attempts, root, messages, batchItems, itemRows };
  }

  assertRedactedDeliveryLifecycleInternal(delivery, redactedAt, commitChecksum) {
    const at = Number(redactedAt);
    if (!Number.isSafeInteger(at) || at <= 0
      || delivery.payload_json !== null || delivery.checksum !== null
      || delivery.authority_commit_checksum !== commitChecksum) {
      throw new Error('redacted authority delivery lifecycle conflict');
    }
    const request = delivery.redaction_requested_at == null
      ? null : Number(delivery.redaction_requested_at);
    const acknowledged = delivery.redaction_acknowledged_at == null
      ? null : Number(delivery.redaction_acknowledged_at);
    if (delivery.state === 'redaction_pending') {
      if (!delivery.relay_message_id || request !== at || acknowledged !== null) {
        throw new Error('redacted authority delivery lifecycle conflict');
      }
      return;
    }
    if (delivery.state === 'quarantined') {
      if (typeof delivery.relay_message_id !== 'string' || !delivery.relay_message_id
        || request !== at || acknowledged !== null
        || typeof delivery.attempts !== 'number' || delivery.attempts !== 0) {
        throw new Error('redacted authority delivery quarantine conflict');
      }
      const turn = this.getTurn(delivery.turn_id);
      const stage = Number(turn?.resultAuthorityVersion) === 0
        ? 'legacy_redaction_delivery_quarantined'
        : 'canonical_redaction_delivery_quarantined';
      this.assertRedactionQuarantineDiagnosticsForTurnsInternal([delivery.turn_id], stage);
      return;
    }
    if (delivery.state !== 'redacted') {
      throw new Error('redacted authority delivery lifecycle conflict');
    }
    if (delivery.relay_message_id) {
      if (request !== at || !Number.isSafeInteger(acknowledged)
        || acknowledged < request) {
        throw new Error('redacted authority delivery lifecycle conflict');
      }
      return;
    }
    if (request !== null || acknowledged !== at) {
      throw new Error('redacted authority delivery lifecycle conflict');
    }
  }

  assertRedactionQuarantineDiagnosticsForTurnsInternal(turnIds, stage) {
    const ids = [...new Set((turnIds || []).filter(value => typeof value === 'string' && value))];
    const marks = ids.map(() => '?').join(',') || "''";
    const diagnostics = this.db.prepare(`
      SELECT turn_id, detail_json FROM diagnostics
      WHERE turn_id IN (${marks}) AND stage = ?
      ORDER BY turn_id, diagnostic_id
    `).all(...ids, stage);
    const quarantined = this.db.prepare(`
      SELECT turn_id, peer_id, relay_message_id FROM cloud_deliveries
      WHERE turn_id IN (${marks}) AND state = 'quarantined'
      ORDER BY turn_id, peer_id
    `).all(...ids);
    const allDiagnostics = this.db.prepare(`
      SELECT turn_id, stage FROM diagnostics
      WHERE turn_id IN (${marks})
    `).all(...ids);
    if (allDiagnostics.length !== diagnostics.length || diagnostics.length !== quarantined.length) {
      throw new Error('redacted authority quarantine diagnostic closure conflict');
    }
    const expectedKeys = 'peerId,reasonCode,redacted,relayMessageId';
    for (const row of quarantined) {
      const matches = diagnostics.filter(entry => entry.turn_id === row.turn_id)
        .map(entry => parseJson(entry.detail_json, null))
        .filter(detail => detail
          && Object.keys(detail).sort().join(',') === expectedKeys
          && detail.redacted === true
          && detail.peerId === row.peer_id
          && detail.relayMessageId === row.relay_message_id
          && ['authority_conflict', 'target_set_conflict'].includes(detail.reasonCode));
      if (matches.length !== 1) {
        throw new Error('redacted authority quarantine diagnostic closure conflict');
      }
    }
    return true;
  }

  assertAuthorityRedactionAuditInternal({
    lineageKey, groupId = null, redactedAt, turnIds, messageIds
  }) {
    if (!this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_log'
    `).get()) return;
    const targetId = groupId == null ? lineageKey : groupId;
    const linkedIds = [...new Set([
      lineageKey,
      ...(groupId == null ? [] : [groupId]),
      ...turnIds,
      ...messageIds
    ])];
    const placeholders = linkedIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT * FROM sync_log WHERE entity_id IN (${placeholders})
    `).all(...linkedIds);
    const targetAudits = rows.filter(row =>
      row.entity_type === 'authority_redaction' && row.entity_id === targetId
    );
    if (targetAudits.length > 1) {
      throw new Error('redacted authority sync audit conflict');
    }
    for (const row of rows) {
      if (row.entity_type !== 'authority_redaction' || row.entity_id !== targetId) {
        throw new Error('redacted authority sync audit conflict');
      }
      this.assertAuthorityRedactionAuditRowInternal(row, {
        targetId, groupId, redactedAt
      });
    }
  }

  assertAuthorityRedactionAuditRowInternal(row, {
    targetId, groupId = null, redactedAt
  }) {
    const payload = parseJson(row?.payload_json, null);
    const expectedGroupId = groupId == null ? null : groupId;
    if (!Number.isSafeInteger(redactedAt) || redactedAt <= 0
      || row?.entity_type !== 'authority_redaction'
      || row.entity_id !== targetId
      || row.operation !== 'redact'
      || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || canonicalJson(Object.keys(payload).sort())
        !== canonicalJson(['groupId', 'reasonCode', 'redactedAt'])
      || payload.groupId !== expectedGroupId
      || !Number.isSafeInteger(payload.redactedAt)
      || payload.redactedAt <= 0
      || payload.redactedAt !== redactedAt
      || typeof payload.reasonCode !== 'string'
      || !/^[a-z0-9][a-z0-9_:-]{0,63}$/.test(payload.reasonCode)
      || !Number.isSafeInteger(row.created_at)
      || row.created_at !== redactedAt
      || canonicalJson(payload) !== row.payload_json
      || contentHash(payload) !== row.checksum) {
      throw new Error('redacted authority sync audit conflict');
    }
  }

  assertNoAuthorityRedactionAuditForLiveTargetInternal({
    lineageKey, groupId = null, turnIds, messageIds
  }) {
    if (!this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_log'
    `).get()) return;
    const linkedIds = [
      lineageKey,
      ...(groupId == null ? [] : [groupId]),
      ...turnIds,
      ...messageIds
    ];
    const placeholders = linkedIds.map(() => '?').join(',') || "''";
    const retainedAudit = this.db.prepare(`
      SELECT 1 FROM sync_log
      WHERE entity_type = 'authority_redaction'
        AND entity_id IN (${placeholders})
      LIMIT 1
    `).get(...linkedIds);
    if (retainedAudit) {
      throw new Error('live authority redaction sync audit conflict');
    }
  }

  assertAuthorityRedactionAuditClosureInternal() {
    if (!this.db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_log'
    `).get()) return;
    const rows = this.db.prepare(`
      SELECT * FROM sync_log
      WHERE entity_type = 'authority_redaction'
      ORDER BY entity_id, created_at
    `).all();
    const counts = new Map();
    for (const row of rows) {
      counts.set(row.entity_id, (counts.get(row.entity_id) || 0) + 1);
      if (counts.get(row.entity_id) > 1) {
        throw new Error('redacted authority sync audit conflict');
      }
      const group = this.db.prepare(`
        SELECT g.group_id, g.lineage_key, g.redacted_at AS group_redacted_at,
               m.redacted_at AS manifest_redacted_at,
               l.state AS lineage_state, l.committed_group_id,
               l.redacted_at AS lineage_redacted_at
        FROM visible_result_groups g
        JOIN visible_result_manifests m ON m.group_id = g.group_id
        JOIN turn_authority_lineages l ON l.lineage_key = g.lineage_key
        WHERE g.group_id = ?
      `).get(row.entity_id);
      if (group) {
        const redactedAt = Number(group.group_redacted_at);
        const attempts = this.db.prepare(`
          SELECT state, authority_redacted_at FROM turns
          WHERE authority_lineage_key = ?
        `).all(group.lineage_key);
        if (!Number.isSafeInteger(redactedAt) || redactedAt <= 0
          || Number(group.manifest_redacted_at) !== redactedAt
          || group.lineage_state !== 'committed'
          || group.committed_group_id !== group.group_id
          || Number(group.lineage_redacted_at) !== redactedAt
          || !attempts.length
          || attempts.some(attempt =>
            Number(attempt.authority_redacted_at) !== redactedAt)) {
          throw new Error('redacted authority sync audit target conflict');
        }
        this.assertAuthorityRedactionAuditRowInternal(row, {
          targetId: group.group_id,
          groupId: group.group_id,
          redactedAt
        });
        continue;
      }
      const lineage = this.db.prepare(`
        SELECT lineage_key, state, committed_group_id, redacted_at
        FROM turn_authority_lineages WHERE lineage_key = ?
      `).get(row.entity_id);
      const attempts = lineage ? this.db.prepare(`
        SELECT state, authority_redacted_at FROM turns
        WHERE authority_lineage_key = ?
      `).all(lineage.lineage_key) : [];
      const redactedAt = Number(lineage?.redacted_at);
      if (!lineage
        || lineage.state !== 'cancelled'
        || lineage.committed_group_id !== null
        || !Number.isSafeInteger(redactedAt) || redactedAt <= 0
        || !attempts.length
        || attempts.some(attempt =>
          attempt.state !== 'cancelled'
          || Number(attempt.authority_redacted_at) !== redactedAt)
        || this.db.prepare(`
          SELECT 1 FROM visible_result_groups WHERE lineage_key = ? LIMIT 1
        `).get(lineage.lineage_key)) {
        throw new Error('redacted authority sync audit target conflict');
      }
      this.assertAuthorityRedactionAuditRowInternal(row, {
        targetId: lineage.lineage_key,
        groupId: null,
        redactedAt
      });
    }
  }

  assertRedactedLineageAuthorityInternal(lineageKey, {
    groupId = null, purpose = 'reopen'
  } = {}) {
    const lineage = this.db.prepare(`
      SELECT * FROM turn_authority_lineages WHERE lineage_key = ?
    `).get(String(lineageKey));
    if (!lineage || lineage.redacted_at == null) {
      throw new Error('redacted authority lineage conflict');
    }
    const redactedAt = Number(lineage.redacted_at);
    const attempts = this.db.prepare(`
      SELECT * FROM turns WHERE authority_lineage_key = ?
      ORDER BY lineage_revision_at_creation, turn_id
    `).all(lineage.lineage_key);
    const commitmentRows = this.db.prepare(`
      SELECT t.lineage_revision_at_creation, t.turn_id,
             t.rollout_key AS turn_kind, t.retry_of_turn_id,
             t.input_user_batch_id, t.envelope_checksum,
             b.tombstone_commitment AS batch_tombstone_commitment
      FROM turns t LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
      WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
      ORDER BY t.lineage_revision_at_creation, t.turn_id
    `).all(lineage.lineage_key);
    if (!attempts.length || attempts.length !== Number(lineage.attempt_count)
      || authorityLineageAttemptsCommitment({
        lineageKey: lineage.lineage_key, attemptRows: commitmentRows
      }).commitment !== lineage.attempt_commitment) {
      throw new Error('redacted authority lineage attempt commitment conflict');
    }
    const cancelled = groupId == null;
    if ((cancelled && (lineage.state !== 'cancelled' || lineage.committed_group_id !== null))
      || (!cancelled && (lineage.state !== 'committed' || lineage.committed_group_id !== groupId))) {
      throw new Error('redacted authority lineage terminal state conflict');
    }
    if (attempts.some(turn =>
      Number(turn.authority_redacted_at) !== redactedAt
      || (cancelled && turn.state !== 'cancelled')
      || !CANONICAL_RESULT_TURN_KINDS.has(String(turn.rollout_key || ''))
      || !/^[a-f0-9]{64}$/.test(String(turn.envelope_checksum || ''))
      || canonicalJson(parseJson(turn.envelope_json, null)) !== '{"redacted":true}'
      || turn.memory_packet_json !== null || turn.brain_draft_json !== null
      || turn.supervisor_json !== null || turn.reply_json !== null || turn.error_json !== null
      || canonicalJson(parseJson(turn.route_reasons_json, null)) !== '[]'
      || canonicalJson(parseJson(turn.annotation_snapshot_json, null)) !== '{}')) {
      throw new Error('redacted authority lineage turn shell conflict');
    }
    const turnIds = attempts.map(turn => turn.turn_id);
    const turnMarks = turnIds.map(() => '?').join(',');
    const batchItems = this.db.prepare(`
      SELECT * FROM current_user_batch_items WHERE turn_id IN (${turnMarks})
      ORDER BY turn_id, sequence
    `).all(...turnIds);
    for (const turn of attempts) {
      const batch = this.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?')
        .get(turn.turn_id);
      const items = batchItems.filter(item => item.turn_id === turn.turn_id);
      if (!batch) {
        if (items.length) {
          throw new Error('redacted authority lineage batch conflict');
        }
        continue;
      }
      if (batch.batch_id !== turn.input_user_batch_id
        || Number(batch.item_count) !== items.length
        || currentUserBatchTombstoneCommitment({
          turnId: turn.turn_id, batchId: batch.batch_id, itemRows: items
        }).commitment !== batch.tombstone_commitment) {
        throw new Error('redacted authority lineage batch conflict');
      }
      items.forEach((item, sequence) => {
        if (Number(item.sequence) !== sequence || item.batch_id !== batch.batch_id
          || item.message_json !== null || Number(item.redacted_at) !== redactedAt) {
          throw new Error('redacted authority lineage batch item conflict');
        }
      });
    }
    const messageClosure = this.assertCanonicalLineageMessageAuthorityInternal({
      lineageKey: lineage.lineage_key,
      mode: 'redacted',
      groupId
    });
    const messages = messageClosure.messages;
    const messageIds = messages.map(message => message.message_id);
    const messageMarks = messageIds.map(() => '?').join(',') || "''";
    this.assertRedactionQuarantineDiagnosticsForTurnsInternal(
      turnIds, 'canonical_redaction_delivery_quarantined'
    );
    const retainedContext = [
      Number(this.db.prepare(`SELECT COUNT(*) AS value FROM annotations
        WHERE turn_id IN (${turnMarks}) OR source_message_id IN (${messageMarks})`)
        .get(...turnIds, ...messageIds).value),
      Number(this.db.prepare(`SELECT COUNT(*) AS value FROM sessions
        WHERE role IN (${[...new Set(attempts.map(turn => turn.character_id))]
          .map(() => '?').join(',') || "''"})`)
        .get(...new Set(attempts.map(turn => turn.character_id))).value)
    ].some(Boolean);
    const executable = Number(this.db.prepare(`
      SELECT COUNT(*) AS value FROM consolidation_jobs
        WHERE turn_id IN (${turnMarks}) AND state IN ('queued','retry_wait','running')
      UNION ALL SELECT COUNT(*) AS value FROM stance_records
        WHERE source_turn_id IN (${turnMarks}) AND status = 'active'
          AND revision = (SELECT MAX(latest.revision) FROM stance_records latest
            WHERE latest.stance_id = stance_records.stance_id)
      UNION ALL SELECT COUNT(*) AS value FROM cognitive_states WHERE last_turn_id IN (${turnMarks})
      UNION ALL SELECT COUNT(*) AS value FROM interaction_lanes WHERE generating_turn_id IN (${turnMarks})
    `).all(...turnIds, ...turnIds, ...turnIds, ...turnIds)
      .reduce((sum, row) => sum + Number(row.value), 0)) > 0;
    if (retainedContext || executable) {
      throw new Error('redacted authority lineage retained context conflict');
    }
    this.assertAuthorityRedactionAuditInternal({
      lineageKey: lineage.lineage_key,
      groupId,
      redactedAt,
      turnIds,
      messageIds
    });
    if (cancelled) {
      const retainedResult = this.db.prepare(`
        SELECT 1 FROM visible_result_groups WHERE lineage_key = ?
        UNION ALL SELECT 1 FROM visible_commit_receipts WHERE lineage_key = ?
        UNION ALL SELECT 1 FROM cloud_deliveries
          WHERE turn_id IN (${turnMarks}) OR authority_group_id IS NOT NULL
            AND turn_id IN (${turnMarks})
        LIMIT 1
      `).get(lineage.lineage_key, lineage.lineage_key, ...turnIds, ...turnIds);
      if (retainedResult) throw new Error('redacted cancelled lineage authority conflict');
    }
    return { lineage, attempts, messages, redactedAt, purpose };
  }

  assertVisibleGroupAuthorityInternal(groupId, {
    purpose = 'reopen',
    expectedLineageKey = null,
    expectedTurnId = null,
    expectedOrigin = null,
    expectedPayloadVersion = null,
    expectedCommitChecksum = null
  } = {}) {
    const groupKey = String(groupId || '');
    const authority = this.db.prepare(`
      SELECT
        g.*, l.state AS lineage_state, l.latest_turn_id, l.committed_group_id,
        l.revision AS lineage_revision, l.redacted_at AS lineage_redacted_at,
        l.attempt_count, l.attempt_commitment,
        t.character_id, t.device_id, t.result_authority_version, t.rollout_key AS turn_kind,
        t.turn_revision, t.input_user_batch_id, t.input_visibility_sequence,
        t.input_clear_epoch, t.authoritative_release_id AS turn_release_id,
        t.agency_snapshot_checksum AS turn_agency_snapshot_checksum,
        t.envelope_json AS turn_envelope_json,
        t.annotation_snapshot_json AS turn_annotation_snapshot_json,
        t.authority_redacted_at AS turn_redacted_at,
        r.authority_origin AS receipt_origin,
        r.commit_payload_version, r.commit_checksum,
        r.turn_revision_after, r.lineage_revision_after,
        m.authority_origin AS manifest_origin, m.payload_version,
        m.semantic_json, m.semantic_checksum,
        m.redacted_at AS manifest_redacted_at
      FROM visible_result_groups g
      JOIN turn_authority_lineages l ON l.lineage_key = g.lineage_key
      JOIN turns t ON t.turn_id = g.authoritative_turn_id
      JOIN visible_commit_receipts r
        ON r.lineage_key = g.lineage_key
       AND r.group_id = g.group_id
       AND r.authoritative_turn_id = g.authoritative_turn_id
      JOIN visible_result_manifests m ON m.group_id = g.group_id
      WHERE g.group_id = ?
    `).get(groupKey);
    if (!authority) throw new Error('canonical visible group authority conflict');
    const expectedFields = [
      [expectedLineageKey, authority.lineage_key],
      [expectedTurnId, authority.authoritative_turn_id],
      [expectedOrigin, authority.receipt_origin],
      [expectedPayloadVersion, authority.commit_payload_version],
      [expectedCommitChecksum, authority.commit_checksum]
    ];
    if (expectedFields.some(([expected, actual]) =>
      expected != null && String(expected) !== String(actual))) {
      throw new Error('canonical visible group authority conflict');
    }
    if (authority.lineage_state !== 'committed'
      || authority.committed_group_id !== groupKey
      || authority.latest_turn_id !== authority.authoritative_turn_id
      || Number(authority.result_authority_version) !== 1
      || Number(authority.turn_revision) !== Number(authority.turn_revision_after)
      || Number(authority.lineage_revision) !== Number(authority.lineage_revision_after)
      || authority.role_id !== authority.character_id
      || authority.authoritative_release_id !== authority.turn_release_id
      || authority.authority_origin !== authority.receipt_origin
      || authority.manifest_origin !== authority.receipt_origin
      || authority.payload_version !== authority.commit_payload_version
      || authority.semantic_checksum !== authority.commit_checksum) {
      throw new Error('canonical visible group authority conflict');
    }
    const receiptMatrixKey = `${authority.receipt_origin}:${authority.commit_payload_version}`;
    const historicalPayload = new Set([
      'pc:pc-visible-commit-v1',
      'android_fallback:android-fallback-commit-v1'
    ]).has(receiptMatrixKey);
    const currentPayload = new Set([
      'pc:pc-visible-commit-v2',
      'pc:pc-visible-commit-v3',
      'pc:pc-visible-commit-v4',
      'android_fallback:android-fallback-commit-v2'
    ]).has(receiptMatrixKey);
    if ((!historicalPayload && !currentPayload)
      || (historicalPayload && Number(authority.input_clear_epoch) !== 0)) {
      throw new Error('canonical visible group receipt authority conflict');
    }
    const lineageAttempts = this.db.prepare(`
      SELECT t.lineage_revision_at_creation, t.turn_id,
             t.rollout_key AS turn_kind,
             t.retry_of_turn_id, t.input_user_batch_id, t.envelope_checksum, t.envelope_json,
             b.tombstone_commitment AS batch_tombstone_commitment
      FROM turns t
      LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
      WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
      ORDER BY t.lineage_revision_at_creation
    `).all(authority.lineage_key);
    if (lineageAttempts.length !== Number(authority.attempt_count)
      || authorityLineageAttemptsCommitment({
        lineageKey: authority.lineage_key,
        attemptRows: lineageAttempts
      }).commitment !== authority.attempt_commitment) {
      throw new Error('canonical visible group lineage attempt commitment conflict');
    }
    const redactedAuthority = authority.redacted_at != null
      || authority.manifest_redacted_at != null || authority.lineage_redacted_at != null;
    if (lineageAttempts.some(attempt => !CANONICAL_RESULT_TURN_KINDS.has(attempt.turn_kind)
      || (!redactedAuthority && String(parseJson(attempt.envelope_json, {})?.kind || '') !== attempt.turn_kind))) {
      throw new Error('canonical visible group turn kind anchor conflict');
    }
    if (redactedAuthority) {
      if (purpose === 'delivery') {
        throw new Error('canonical visible result is redacted');
      }
      const closure = this.assertRedactedLineageAuthorityInternal(authority.lineage_key, {
        groupId: groupKey, purpose
      });
      const redactedAt = closure.redactedAt;
      if (!Number.isSafeInteger(redactedAt) || redactedAt <= 0
        || Number(authority.manifest_redacted_at) !== redactedAt
        || Number(authority.lineage_redacted_at) !== redactedAt
        || authority.semantic_json !== null) {
        throw new Error('redacted authority group shell conflict');
      }
      const sha256Pattern = /^[a-f0-9]{64}$/i;
      const itemRows = this.db.prepare(`
        SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal
      `).all(groupKey);
      if (itemRows.length !== Number(authority.item_count)
        || itemRows.some((item, ordinal) =>
          Number(item.ordinal) !== ordinal
          || item.message_id !== deriveVisibleMessageId(groupKey, ordinal)
          || item.item_json !== null
          || Number(item.redacted_at) !== redactedAt
          || !sha256Pattern.test(String(item.item_checksum || '')))) {
        throw new Error('redacted authority item shell conflict');
      }
      const actionRows = this.db.prepare(`
        SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal
      `).all(groupKey);
      if (actionRows.length !== Number(authority.action_count)
        || actionRows.some((action, ordinal) =>
          Number(action.ordinal) !== ordinal
          || action.action_id !== deriveVisibleActionId(groupKey, ordinal)
          || action.action_kind !== null
          || action.target_key !== null
          || action.target_revision !== null
          || action.action_json !== null
          || Number(action.redacted_at) !== redactedAt
          || !sha256Pattern.test(String(action.action_checksum || '')))) {
        throw new Error('redacted authority action shell conflict');
      }
      if (visibleResultTombstoneCommitment({
        groupId: groupKey,
        itemRows,
        actionRows
      }).commitment !== authority.tombstone_commitment) {
        throw new Error('redacted authority result tombstone commitment conflict');
      }
      const deliveries = this.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE authority_group_id = ?
      `).all(groupKey);
      if (Number(authority.redaction_delivery_count) !== deliveries.length
        || authorityRedactionDeliveriesCommitment({
          groupId: groupKey,
          deliveryRows: deliveries
        }).commitment !== authority.redaction_delivery_commitment) {
        throw new Error('redacted authority delivery commitment conflict');
      }
      for (const delivery of deliveries) {
        this.assertRedactedDeliveryLifecycleInternal(
          delivery, redactedAt, authority.commit_checksum
        );
      }
      const retainedJobs = Number(this.db.prepare(`
        SELECT COUNT(*) AS value FROM consolidation_jobs
        WHERE authority_group_id = ? AND state IN ('queued','retry_wait','running')
      `).get(groupKey).value);
      const retainedStances = Number(this.db.prepare(`
        SELECT COUNT(*) AS value FROM stance_records
        WHERE authority_group_id = ?
          AND revision = (SELECT MAX(latest.revision) FROM stance_records latest
            WHERE latest.stance_id = stance_records.stance_id)
      `).get(groupKey).value);
      const retainedState = Number(this.db.prepare(`
        SELECT COUNT(*) AS value FROM cognitive_states WHERE last_authority_group_id = ?
      `).get(groupKey).value);
      const retainedLane = Number(this.db.prepare(`
        SELECT COUNT(*) AS value FROM interaction_lanes
        WHERE latest_authoritative_group_id = ?
           OR native_completed_group_id = ?
           OR ui_applied_group_id = ?
      `).get(groupKey, groupKey, groupKey).value);
      if (retainedJobs || retainedStances || retainedState || retainedLane) {
        throw new Error('redacted authority executable projection conflict');
      }
      const terminalDisposition = deriveTerminalDisposition(
        authority.turn_kind, Number(authority.item_count), Number(authority.action_count)
      );
      return {
        status: 'redacted',
        terminalDisposition,
        group: {
          visibleGroupId: groupKey,
          authorityLineageKey: authority.lineage_key,
          authoritativeTurnId: authority.authoritative_turn_id,
          itemCount: Number(authority.item_count),
          actionCount: Number(authority.action_count)
        },
        receipt: this.getVisibleCommitReceipt(authority.lineage_key),
        manifest: this.getVisibleResultManifest(groupKey)
      };
    }
    const semantic = parseJson(authority.semantic_json, null);
    if (!semantic || contentHash(semantic) !== authority.semantic_checksum) {
      throw new Error('canonical visible group manifest authority conflict');
    }
    this.assertCanonicalProactiveAuthorityInternal({
      authority,
      semantic,
      groupId: groupKey
    });
    this.assertCanonicalMomentAuthorityInternal({
      authority,
      semantic,
      groupId: groupKey
    });

    const itemRows = this.db.prepare(`
      SELECT i.*, m.content, m.turn_id AS message_turn_id,
             m.character_id AS message_character_id, m.speaker_id,
             m.speaker_type, m.recipient_id,
             m.authority_group_id, m.group_ordinal
      FROM visible_result_items i
      LEFT JOIN messages m ON m.message_id = i.message_id
      WHERE i.group_id = ?
      ORDER BY i.ordinal
    `).all(groupKey);
    if (itemRows.length !== Number(authority.item_count)
      || itemRows.length !== (semantic.visibleItems || []).length) {
      throw new Error('canonical visible group item authority conflict');
    }
    const expectedGroupRecipient = expectedCanonicalCharacterRecipient({
      protocolVersion: parseJson(authority.turn_envelope_json, null)?.protocolVersion,
      turnKind: authority.turn_kind,
      payloadVersion: authority.payload_version
    });
    itemRows.forEach((item, ordinal) => {
      const expected = semantic.visibleItems[ordinal];
      if (Number(item.ordinal) !== ordinal
        || item.message_id !== deriveVisibleMessageId(groupKey, ordinal)
        || item.item_checksum !== contentHash(expected)
        || canonicalJson(parseJson(item.item_json, null)) !== canonicalJson(expected)
        || item.message_turn_id !== authority.authoritative_turn_id
        || item.authority_group_id !== groupKey
        || Number(item.group_ordinal) !== ordinal
        || item.message_character_id !== authority.role_id
        || item.speaker_id !== authority.role_id
        || item.speaker_type !== 'character'
        || item.recipient_id !== expectedGroupRecipient
        || String(item.content) !== String(expected.content)) {
        throw new Error('canonical visible group item authority conflict');
      }
    });

    const actionRows = this.db.prepare(`
      SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal
    `).all(groupKey);
    if (actionRows.length !== Number(authority.action_count)
      || actionRows.length !== (semantic.actions || []).length) {
      throw new Error('canonical visible group action authority conflict');
    }
    if (visibleResultTombstoneCommitment({
      groupId: groupKey,
      itemRows,
      actionRows
    }).commitment !== authority.tombstone_commitment) {
      throw new Error('canonical visible group tombstone commitment conflict');
    }
    const terminalDisposition = deriveTerminalDisposition(
      authority.turn_kind,
      itemRows.length,
      actionRows.length
    );
    actionRows.forEach((action, ordinal) => {
      const rawExpected = semantic.actions[ordinal];
      const expected = authority.authority_origin === 'android_fallback'
        && rawExpected && typeof rawExpected === 'object'
        && Object.hasOwn(rawExpected, 'actionId')
        ? {
            kind: rawExpected.kind,
            targetKey: rawExpected.targetKey,
            targetRevision: rawExpected.targetRevision,
            payload: rawExpected.payload
          }
        : rawExpected;
      const descriptor = {
        kind: action.action_kind,
        targetKey: action.target_key,
        targetRevision: action.target_revision,
        payload: parseJson(action.action_json, null)
      };
      if (Number(action.ordinal) !== ordinal
        || action.action_id !== deriveVisibleActionId(groupKey, ordinal)
        || action.action_checksum !== contentHash(descriptor)
        || canonicalJson(descriptor) !== canonicalJson(expected)) {
        throw new Error('canonical visible group action authority conflict');
      }
    });

    const jobs = this.db.prepare(`
      SELECT * FROM consolidation_jobs
      WHERE authority_group_id = ? ORDER BY authority_ordinal
    `).all(groupKey);
    const expectedJobs = [
      ...(semantic.memoryJobs || []),
      ...(semantic.comparison ? [semantic.comparison] : [])
    ];
    if (jobs.length !== expectedJobs.length) {
      throw new Error('canonical visible group job authority conflict');
    }
    if (terminalDisposition === 'skip' && jobs.some(job =>
      job.job_type === 'turn_consolidation')) {
      throw new Error('canonical skip result retained evidence memory');
    }
    jobs.forEach((job, ordinal) => {
      const payload = parseJson(job.payload_json, {});
      const comparisonJob = ['shadow_cognition', 'active_canary_compare'].includes(job.job_type);
      const semanticJob = comparisonJob
        ? {
            jobType: job.job_type,
            ...Object.fromEntries(Object.entries(payload).filter(([key]) =>
              !['authorityGroupId', 'authoritativeResultChecksum'].includes(key)))
          }
        : payload;
      if (job.role_id !== authority.role_id
        || job.turn_id !== authority.authoritative_turn_id
        || job.subject_type !== 'turn'
        || job.subject_id !== (comparisonJob
          ? authority.lineage_key
          : authority.authoritative_turn_id)
        || Number(job.authority_ordinal) !== ordinal
        || contentHash(payload) !== job.payload_checksum
        || canonicalJson(semanticJob) !== canonicalJson(expectedJobs[ordinal])) {
        throw new Error('canonical visible group job authority conflict');
      }
    });

    const stances = this.db.prepare(`
      SELECT * FROM stance_records
      WHERE authority_group_id = ? ORDER BY authority_ordinal
    `).all(groupKey);
    const expectedStances = semantic.statePatch?.currentStances || [];
    if (stances.length !== expectedStances.length) {
      throw new Error('canonical visible group stance authority conflict');
    }
    stances.forEach((stance, ordinal) => {
      const expected = expectedStances[ordinal];
      if (stance.role_id !== authority.role_id
        || stance.source_turn_id !== authority.authoritative_turn_id
        || Number(stance.authority_ordinal) !== ordinal
        || stance.stance_id !== String(expected.stanceId || '')
        || stance.topic !== String(expected.topic || '')
        || stance.position_text !== String(expected.position || '')
        || stance.reason_text !== String(expected.reason || '')) {
        throw new Error('canonical visible group stance authority conflict');
      }
    });

    const currentState = this.db.prepare(`
      SELECT * FROM cognitive_states WHERE last_authority_group_id = ?
    `).get(groupKey);
    if (currentState) {
      const state = parseJson(currentState.state_json, {});
      if (!semantic.statePatch
        || currentState.role_id !== authority.role_id
        || currentState.last_turn_id !== authority.authoritative_turn_id
        || currentState.checksum !== contentHash(state)
        || String(state.fastState?.mood || '') !== String(semantic.statePatch.mood || '')) {
        throw new Error('canonical visible group cognitive state authority conflict');
      }
      assertCognitiveStateOpenThreadProjection({
        state,
        semanticPatch: semantic.statePatch,
        protocolVersion: parseJson(authority.turn_envelope_json, {}).protocolVersion,
        authoritativeTurnId: authority.authoritative_turn_id,
        envelope: parseJson(authority.turn_envelope_json, {}),
        errorMessage: 'canonical visible group cognitive state authority conflict'
      });
    }

    const attempts = this.db.prepare(`
      SELECT * FROM turns
      WHERE authority_lineage_key = ?
      ORDER BY lineage_revision_at_creation, turn_id
    `).all(authority.lineage_key);
    for (const turn of attempts) {
      const storedTurn = mapTurn(turn);
      this.assertCanonicalTurnInputAuthorityInternal({
        storedTurn,
        incomingEnvelope: parseJson(storedTurn.envelopeJson, {}),
        mode: 'live_reopen'
      });
    }
    const liveMessageClosure = this.assertCanonicalLineageMessageAuthorityInternal({
      lineageKey: authority.lineage_key,
      mode: 'live',
      groupId: groupKey
    });
    this.assertNoAuthorityRedactionAuditForLiveTargetInternal({
      lineageKey: authority.lineage_key,
      groupId: groupKey,
      turnIds: attempts.map(turn => turn.turn_id),
      messageIds: liveMessageClosure.messages.map(message => message.message_id)
    });

    const deliveries = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE authority_group_id = ?
    `).all(groupKey);
    if (authority.receipt_origin === 'pc') {
      if (deliveries.length !== 1
        || deliveries[0].turn_id !== authority.authoritative_turn_id
        || deliveries[0].peer_id !== authority.device_id
        || deliveries[0].authority_commit_checksum !== authority.commit_checksum) {
        throw new Error('canonical visible group delivery authority conflict');
      }
    } else if (deliveries.length) {
      throw new Error('canonical visible group delivery authority conflict');
    }
    if (deliveries.some(delivery =>
      delivery.turn_id !== authority.authoritative_turn_id
      || delivery.authority_commit_checksum !== authority.commit_checksum)) {
      throw new Error('canonical visible group delivery authority conflict');
    }
    const quarantinedDelivery = deliveries.find(delivery => delivery.state === 'quarantined');
    if (quarantinedDelivery) {
      if (quarantinedDelivery.payload_json != null || quarantinedDelivery.checksum != null
        || Number(quarantinedDelivery.attempts) !== 0
        || quarantinedDelivery.relay_message_id != null || quarantinedDelivery.delivered_at != null
        || quarantinedDelivery.confirmed_at != null) {
        throw new Error('canonical visible delivery quarantine state conflict');
      }
      const diagnostics = this.db.prepare(`
        SELECT detail_json FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_visible_delivery_quarantined'
      `).all(authority.authoritative_turn_id).map(entry => parseJson(entry.detail_json, null));
      const validReasons = new Set([
        'authority_validation_failed', 'source_cancelled', 'source_redacted'
      ]);
      if (diagnostics.length !== 1 || !diagnostics.every(detail => detail
        && Object.keys(detail).sort().join(',') === 'groupId,peerId,reason,redacted'
        && detail.redacted === true
        && detail.groupId === groupKey
        && detail.peerId === authority.device_id
        && validReasons.has(detail.reason))) {
        throw new Error('canonical visible delivery quarantine diagnostic conflict');
      }
    } else if (this.db.prepare(`
      SELECT 1 AS value FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_visible_delivery_quarantined'
      LIMIT 1
    `).get(authority.authoritative_turn_id)) {
      throw new Error('canonical visible delivery quarantine diagnostic conflict');
    }
    return {
      status: 'live',
      terminalDisposition,
      group: {
        visibleGroupId: groupKey,
        authorityLineageKey: authority.lineage_key,
        authoritativeTurnId: authority.authoritative_turn_id
      },
      receipt: this.getVisibleCommitReceipt(authority.lineage_key),
      manifest: this.getVisibleResultManifest(groupKey)
    };
  }

  assertCanonicalVisibleDeliveryTargetSetInternal({
    groupId,
    expectedLineageKey = null
  }) {
    const closure = this.assertVisibleGroupAuthorityInternal(groupId, {
      purpose: 'canonical_delivery_target',
      expectedLineageKey
    });
    if (closure.status === 'redacted' || !closure.receipt) {
      throw new Error('canonical visible delivery target conflict');
    }
    const target = this.db.prepare(`
      SELECT g.lineage_key, g.authoritative_turn_id, r.commit_checksum,
             t.device_id, d.*
      FROM visible_result_groups g
      JOIN visible_commit_receipts r ON r.group_id = g.group_id
      JOIN turns t ON t.turn_id = g.authoritative_turn_id
      JOIN cloud_deliveries d ON d.authority_group_id = g.group_id
      WHERE g.group_id = ?
    `).all(String(groupId || ''));
    if (target.length !== 1) throw new Error('canonical visible delivery target conflict');
    const row = target[0];
    if (row.turn_id !== row.authoritative_turn_id
      || row.peer_id !== row.device_id
      || row.authority_commit_checksum !== row.commit_checksum) {
      throw new Error('canonical visible delivery target conflict');
    }
    return {
      closure,
      authorityLineageKey: row.lineage_key,
      turnId: row.authoritative_turn_id,
      peerId: row.device_id,
      commitChecksum: row.commit_checksum,
      delivery: row
    };
  }

  assertVisibleAuthorityV13Invariants() {
    if (this.userVersion() === 15) this.assertVisibleAuthorityV15LayerSchemaInternal();
    else this.assertVisibleAuthorityV13SchemaInternal();
    this.assertVisibleAuthorityV11Invariants(
      this.userVersion() === 15
        ? { allowVersionFifteen: true }
        : this.userVersion() === 14
          ? { allowVersionFourteen: true }
          : { allowVersionThirteen: true }
    );
    for (const lineage of this.db.prepare(`
      SELECT lineage_key, state, committed_group_id, redacted_at,
             latest_turn_id, revision, attempt_count, attempt_commitment
      FROM turn_authority_lineages ORDER BY lineage_key
    `).all()) {
      const attempts = this.db.prepare(`
        SELECT t.lineage_revision_at_creation, t.turn_id,
               t.rollout_key AS turn_kind,
               t.retry_of_turn_id, t.input_user_batch_id, t.envelope_checksum,
               b.tombstone_commitment AS batch_tombstone_commitment
        FROM turns t
        LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
        WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
        ORDER BY t.lineage_revision_at_creation
      `).all(lineage.lineage_key);
      if (attempts.length !== Number(lineage.attempt_count)
        || authorityLineageAttemptsCommitment({
          lineageKey: lineage.lineage_key,
          attemptRows: attempts
        }).commitment !== lineage.attempt_commitment) {
        throw new Error('v13 invariant lineage attempt commitment conflict');
      }
      const latestAttempt = attempts.at(-1);
      const expectedLineageRevision = lineage.state === 'open'
        ? Number(latestAttempt?.lineage_revision_at_creation)
        : Number(latestAttempt?.lineage_revision_at_creation) + 1;
      if (!latestAttempt
        || lineage.latest_turn_id !== latestAttempt.turn_id
        || Number(lineage.revision) !== expectedLineageRevision) {
        throw new Error('v13 invariant lineage latest attempt conflict');
      }
      for (const attempt of attempts) {
        if (lineage.redacted_at == null) {
          const storedTurn = this.getTurn(attempt.turn_id);
          this.assertCanonicalTurnInputAuthorityInternal({
            storedTurn,
            incomingEnvelope: parseJson(storedTurn.envelopeJson, {}),
            mode: 'live_reopen'
          });
        }
        const batch = this.db.prepare(
          'SELECT * FROM current_user_batches WHERE turn_id = ?'
        ).get(attempt.turn_id);
        const batchItems = this.db.prepare(`
          SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence
        `).all(attempt.turn_id);
        if (!batch) {
          if (batchItems.length || attempt.batch_tombstone_commitment != null) {
            throw new Error('v13 invariant canonical batch parent conflict');
          }
        } else {
          let commitment;
          try {
            commitment = currentUserBatchTombstoneCommitment({
              turnId: attempt.turn_id,
              batchId: batch.batch_id,
              itemRows: batchItems
            });
          } catch {
            throw new Error('v13 invariant canonical batch parent conflict');
          }
          if (batch.batch_id !== attempt.input_user_batch_id
            || Number(batch.item_count) !== batchItems.length
            || commitment.itemCount !== batchItems.length
            || commitment.commitment !== batch.tombstone_commitment
            || attempt.batch_tombstone_commitment !== batch.tombstone_commitment) {
            throw new Error(lineage.redacted_at != null
              ? 'redacted authority input batch shell conflict'
              : 'v13 invariant canonical batch parent conflict');
          }
        }
      }
      if (lineage.redacted_at == null) {
        this.assertCanonicalLineageMessageAuthorityInternal({
          lineageKey: lineage.lineage_key,
          mode: 'live',
          groupId: lineage.state === 'committed' ? lineage.committed_group_id : null
        });
      }
      if (lineage.state === 'cancelled' && lineage.redacted_at != null) {
        this.assertRedactedLineageAuthorityInternal(lineage.lineage_key, {
          groupId: null, purpose: 'reopen'
        });
      }
    }
    for (const row of this.db.prepare(`
      SELECT group_id FROM visible_result_groups ORDER BY group_id
    `).all()) {
      this.assertVisibleGroupAuthorityInternal(row.group_id, { purpose: 'reopen' });
    }
    for (const delivery of this.db.prepare(`
      SELECT d.* FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      WHERE t.result_authority_version = 1 AND d.authority_group_id IS NULL
      ORDER BY d.turn_id, d.peer_id
    `).all()) {
      this.assertCanonicalFailureDeliveryInternal(mapCloudDelivery(delivery));
    }
    for (const state of this.db.prepare(`
      SELECT c.role_id, c.last_turn_id, c.last_authority_group_id,
             g.role_id AS group_role_id, g.authoritative_turn_id
      FROM cognitive_states c
      LEFT JOIN visible_result_groups g ON g.group_id = c.last_authority_group_id
      WHERE c.last_authority_group_id IS NOT NULL
    `).all()) {
      if (state.group_role_id !== state.role_id
        || state.authoritative_turn_id !== state.last_turn_id) {
        throw new Error(`v13 invariant current cognitive state authority: ${state.role_id}`);
      }
    }
    this.assertAuthorityRedactionAuditClosureInternal();
    this.assertLegacyRedactionAuditClosureInternal();
  }

  visibleAuthorityV13InvariantSummary() {
    this.assertVisibleAuthorityV13Invariants();
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
      'cloud_deliveries',
      'conversation_clear_controls'
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

  releaseAuthorityV14InvariantSummary() {
    this.assertReleaseAuthorityV14Invariants();
    const semantic = this.visibleAuthorityV13InvariantSummary();
    const rolloutCanary = this.listCognitionRollouts().map(rollout => ({
      rolloutKey: rollout.rolloutKey,
      canaryEpoch: rollout.canaryEpoch,
      started: rollout.canaryStartedCount,
      completed: rollout.canaryCompletedCount,
      failure: rollout.canaryFailureCount,
      outstanding: this.readCanaryOutstandingAuthorityInternal({
        rolloutKey: rollout.rolloutKey,
        canaryEpoch: rollout.canaryEpoch
      })
    }));
    const indexes = this.db.prepare(`
      SELECT name, sql
      FROM sqlite_master
      WHERE type = 'index'
        AND name IN (
          'idx_turns_rollout_canary_root_slot',
          'idx_turns_rollout_canary_lineage_slot'
        )
      ORDER BY name
    `).all().map(row => ({ name: row.name, sql: row.sql }));
    const summary = {
      userVersion: this.userVersion(),
      semantic,
      indexes,
      rolloutCanary
    };
    return { ...summary, checksum: contentHash(summary) };
  }

  visibleAuthorityV11InvariantSummary() {
    if (this.userVersion() >= 13) this.assertVisibleAuthorityV13Invariants();
    else if (this.userVersion() === 12) this.assertVisibleAuthorityV12Invariants();
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
        : version === 10 || version === 11 || version === 12
          || version === 13 || version === 14 || version === 15;
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
    const authorities = new Set(['system', 'author', 'user']);
    const kinds = new Set(['capability', 'consent', 'privacy', 'action', 'commitment', 'relationship_fact']);
    const statuses = new Set(['active', 'released', 'archived']);
    const isText = value => typeof value === 'string' && value.trim() === value && value.length > 0;
    const isSafeTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !isText(record.constraintId) || !isText(record.roleId)
      || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
      || record.revision < 1 || !authorities.has(record.authority)
      || !kinds.has(record.kind) || !statuses.has(record.status)
      || !isText(record.subject) || !isText(record.rule)
      || !record.scope || typeof record.scope !== 'object' || Array.isArray(record.scope)
      || !Array.isArray(record.sourceMessageIds)
      || record.sourceMessageIds.some(id => !isText(id))
      || new Set(record.sourceMessageIds).size !== record.sourceMessageIds.length
      || (record.authority === 'user' && record.status === 'active'
        && record.sourceMessageIds.length === 0)
      || (record.sourceConfigRef != null && !isText(record.sourceConfigRef))
      || (record.releaseCondition != null && !isText(record.releaseCondition))
      || (record.supersedes != null && !isText(record.supersedes))
      || !isSafeTime(record.createdAt) || !isSafeTime(record.updatedAt)) {
      throw new Error('invalid constraint revision');
    }
    const normalized = {
      constraintId: record.constraintId,
      revision: record.revision,
      roleId: record.roleId,
      authority: record.authority,
      kind: record.kind,
      subject: record.subject,
      scope: structuredClone(record.scope),
      rule: record.rule,
      sourceMessageIds: [...record.sourceMessageIds],
      sourceConfigRef: record.sourceConfigRef ?? null,
      releaseCondition: record.releaseCondition ?? null,
      status: record.status,
      supersedes: record.supersedes ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt
    };
    const existing = mapConstraintRecord(this.db.prepare(`
      SELECT * FROM constraint_records WHERE constraint_id = ? AND revision = ?
    `).get(normalized.constraintId, normalized.revision));
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error('constraint revision conflict');
      }
      return existing;
    }
    const latest = this.db.prepare(`
      SELECT revision FROM constraint_records
      WHERE constraint_id = ? ORDER BY revision DESC LIMIT 1
    `).get(normalized.constraintId);
    if (latest) {
      if (normalized.revision !== Number(latest.revision) + 1
        || normalized.supersedes !== `${normalized.constraintId}@${latest.revision}`) {
        throw new Error('constraint revision supersedes conflict');
      }
    } else if (normalized.revision !== 1 || normalized.supersedes !== null) {
      throw new Error('constraint revision supersedes conflict');
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
    const statuses = new Set(['active', 'expired', 'superseded']);
    const isText = value => typeof value === 'string' && value.trim() === value && value.length > 0;
    const isSafeTime = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
    const isSafeCount = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || !isText(record.stanceId) || !isText(record.roleId)
      || typeof record.revision !== 'number' || !Number.isSafeInteger(record.revision)
      || record.revision < 1 || !isText(record.topic) || !isText(record.position)
      || typeof record.reason !== 'string' || record.reason.trim() !== record.reason
      || typeof record.strength !== 'number' || !Number.isFinite(record.strength)
      || record.strength < 0 || record.strength > 1
      || typeof record.flexibility !== 'number' || !Number.isFinite(record.flexibility)
      || record.flexibility < 0 || record.flexibility > 1
      || !isText(record.sourceTurnId) || !Array.isArray(record.sourceMessageIds)
      || record.sourceMessageIds.some(id => !isText(id))
      || new Set(record.sourceMessageIds).size !== record.sourceMessageIds.length
      || !isSafeTime(record.createdAt) || !isSafeTime(record.lastConfirmedAt)
      || (record.expiresAt != null && !isSafeTime(record.expiresAt))
      || !isSafeCount(record.remainingRelevantUserBatches)
      || !statuses.has(record.status)
      || (record.supersedes != null && !isText(record.supersedes))
      || (record.authorityGroupId != null && !isText(record.authorityGroupId))
      || (record.authorityOrdinal != null
        && (typeof record.authorityOrdinal !== 'number'
          || !Number.isSafeInteger(record.authorityOrdinal) || record.authorityOrdinal < 0))) {
      throw new Error('invalid stance revision');
    }
    const normalized = {
      stanceId: record.stanceId,
      revision: record.revision,
      roleId: record.roleId,
      topic: record.topic,
      position: record.position,
      reason: record.reason,
      strength: record.strength,
      flexibility: record.flexibility,
      sourceTurnId: record.sourceTurnId,
      sourceMessageIds: [...record.sourceMessageIds],
      createdAt: record.createdAt,
      lastConfirmedAt: record.lastConfirmedAt,
      expiresAt: record.expiresAt ?? null,
      remainingRelevantUserBatches: record.remainingRelevantUserBatches,
      status: record.status,
      supersedes: record.supersedes ?? null,
      authorityGroupId: record.authorityGroupId ?? null,
      authorityOrdinal: record.authorityOrdinal ?? null
    };
    const existing = mapStanceRecord(this.db.prepare(`
      SELECT * FROM stance_records WHERE stance_id = ? AND revision = ?
    `).get(normalized.stanceId, normalized.revision));
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(normalized)) {
        throw new Error('stance revision conflict');
      }
      return existing;
    }
    const latest = this.db.prepare(`
      SELECT revision FROM stance_records
      WHERE stance_id = ? ORDER BY revision DESC LIMIT 1
    `).get(normalized.stanceId);
    if (latest) {
      if (normalized.revision !== Number(latest.revision) + 1
        || normalized.supersedes !== `${normalized.stanceId}@${latest.revision}`) {
        throw new Error('stance revision supersedes conflict');
      }
    } else if (normalized.revision !== 1 || normalized.supersedes !== null) {
      throw new Error('stance revision supersedes conflict');
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
      const commonValues = [
        roleId,
        laneKey,
        input.generatingTurnId ?? null,
        input.latestUserBatchId ?? null,
        input.latestAuthoritativeGroupId ?? null,
        input.nativeCompletedGroupId ?? null,
        Number(input.nativeCompletedSequence || 0),
        input.uiAppliedGroupId ?? null,
        Number(input.uiAppliedSequence || 0),
        Number(input.localSequence || 0)
      ];
      if (this.userVersion() >= 13) {
        this.db.prepare(`
          INSERT INTO interaction_lanes(
            role_id, lane_key, revision, generating_turn_id, latest_user_batch_id,
            latest_authoritative_group_id, native_completed_group_id,
            native_completed_sequence, ui_applied_group_id, ui_applied_sequence,
            local_sequence, clear_epoch, cleared_through_sequence,
            last_commit_checksum, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...commonValues,
          Number(input.clearEpoch || 0),
          Number(input.clearedThroughSequence || 0),
          input.lastCommitChecksum ?? null,
          Number(input.now || now())
        );
      } else {
        this.db.prepare(`
          INSERT INTO interaction_lanes(
            role_id, lane_key, revision, generating_turn_id, latest_user_batch_id,
            latest_authoritative_group_id, native_completed_group_id,
            native_completed_sequence, ui_applied_group_id, ui_applied_sequence,
            local_sequence, last_commit_checksum, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          ...commonValues,
          input.lastCommitChecksum ?? null,
          Number(input.now || now())
        );
      }
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
      clearEpoch: input.clearEpoch ?? current.clearEpoch,
      clearedThroughSequence:
        input.clearedThroughSequence ?? current.clearedThroughSequence,
      lastCommitChecksum: input.lastCommitChecksum ?? current.lastCommitChecksum,
      updatedAt: Number(input.now || now())
    };
    const commonValues = [
      next.generatingTurnId,
      next.latestUserBatchId,
      next.latestAuthoritativeGroupId,
      next.nativeCompletedGroupId,
      Number(next.nativeCompletedSequence),
      next.uiAppliedGroupId,
      Number(next.uiAppliedSequence),
      Number(next.localSequence)
    ];
    const result = this.userVersion() >= 13
      ? this.db.prepare(`
        UPDATE interaction_lanes
        SET revision = revision + 1, generating_turn_id = ?, latest_user_batch_id = ?,
            latest_authoritative_group_id = ?, native_completed_group_id = ?,
            native_completed_sequence = ?, ui_applied_group_id = ?, ui_applied_sequence = ?,
            local_sequence = ?, clear_epoch = ?, cleared_through_sequence = ?,
            last_commit_checksum = ?, updated_at = ?
        WHERE role_id = ? AND lane_key = ? AND revision = ?
      `).run(
        ...commonValues,
        Number(next.clearEpoch),
        Number(next.clearedThroughSequence),
        next.lastCommitChecksum,
        next.updatedAt,
        roleId,
        laneKey,
        expectedRevision
      )
      : this.db.prepare(`
        UPDATE interaction_lanes
        SET revision = revision + 1, generating_turn_id = ?, latest_user_batch_id = ?,
            latest_authoritative_group_id = ?, native_completed_group_id = ?,
            native_completed_sequence = ?, ui_applied_group_id = ?, ui_applied_sequence = ?,
            local_sequence = ?, last_commit_checksum = ?, updated_at = ?
        WHERE role_id = ? AND lane_key = ? AND revision = ?
      `).run(
        ...commonValues,
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

  assertCanonicalConversationClearAffectedSetInternal({ roleId, clearEpoch, boundary }) {
    if (typeof roleId !== 'string' || !roleId
      || !Number.isSafeInteger(clearEpoch) || clearEpoch <= 0
      || !Number.isSafeInteger(boundary) || boundary < 0) {
      throw new Error('canonical conversation clear boundary conflict');
    }
    const rows = this.db.prepare(`
      SELECT t.*
      FROM turns t
      WHERE t.character_id = ? AND t.result_authority_version = 1
      ORDER BY t.authority_lineage_key, t.lineage_revision_at_creation, t.turn_id
    `).all(roleId);
    const canonical = [];
    const checkedRedactedLineages = new Set();
    for (const row of rows) {
      if (!row.authority_lineage_key) {
        throw new Error(`canonical conversation clear missing lineage authority: ${row.turn_id}`);
      }
      const lineage = this.db.prepare(
        'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
      ).get(row.authority_lineage_key);
      if (!lineage) throw new Error(`canonical conversation clear lineage conflict: ${row.authority_lineage_key}`);
      if (lineage.role_id !== row.character_id
        || lineage.lane_key !== row.lane_key) {
        throw new Error(`canonical conversation clear lineage lane conflict: ${row.turn_id}`);
      }
      if (row.authority_redacted_at != null) {
        if (!checkedRedactedLineages.has(row.authority_lineage_key)) {
          if (lineage.state === 'committed' && lineage.committed_group_id) {
            this.assertVisibleGroupAuthorityInternal(lineage.committed_group_id, { purpose: 'reopen' });
          } else if (lineage.state === 'cancelled') {
            this.assertRedactedLineageAuthorityInternal(row.authority_lineage_key, { purpose: 'reopen' });
          } else {
            throw new Error(`canonical conversation clear redacted lineage conflict: ${row.authority_lineage_key}`);
          }
          checkedRedactedLineages.add(row.authority_lineage_key);
        }
        continue;
      }
      let wire;
      try {
        wire = validateEnvelope(parseJson(row.envelope_json, null));
      } catch (error) {
        throw new Error(`canonical conversation clear envelope conflict: ${row.turn_id}`, { cause: error });
      }
      if (typeof wire.protocolVersion !== 'number'
        || !Number.isSafeInteger(wire.protocolVersion)
        || ![2, 3].includes(wire.protocolVersion)) {
        throw new Error(`canonical conversation clear protocol conflict: ${row.turn_id}`);
      }
      if (contentHash(wire) !== row.envelope_checksum) {
        throw new Error(`canonical conversation clear envelope checksum conflict: ${row.turn_id}`);
      }
      const derivedLane = authorityLaneKeyForEnvelope(wire);
      if (row.lane_key !== derivedLane) {
        throw new Error(`canonical conversation clear lane conflict: ${row.turn_id}`);
      }
      // Conversation clear is private-chat only. Public moment/thread lanes
      // remain byte-identical, while both canonical wire-v2 and wire-v3
      // private turns participate in the affected-set calculation.
      if (derivedLane === 'private_chat') canonical.push({
        ...row, protocolVersion: wire.protocolVersion
      });
    }
    for (const row of canonical) {
      if (row.input_visibility_sequence == null
        || !Number.isSafeInteger(Number(row.input_visibility_sequence))
        || Number(row.input_visibility_sequence) < 0
        || row.input_clear_epoch == null
        || !Number.isSafeInteger(Number(row.input_clear_epoch))
        || Number(row.input_clear_epoch) < 0) {
        throw new Error(`canonical conversation clear sequence conflict: ${row.turn_id}`);
      }
    }
    const affected = canonical.filter(row =>
      Number(row.input_clear_epoch) < clearEpoch
      || (Number(row.input_clear_epoch) === clearEpoch
        && Number(row.input_visibility_sequence) <= boundary)
    );
    const lineageKeys = [...new Set(affected.map(row => row.authority_lineage_key).filter(Boolean))];
    const closures = [];
    for (const lineageKey of lineageKeys) {
      const lineage = this.db.prepare(
        'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
      ).get(lineageKey);
      if (!lineage || !['open', 'committed', 'cancelled'].includes(lineage.state)) {
        throw new Error(`canonical conversation clear lineage conflict: ${lineageKey}`);
      }
      if (lineage.redacted_at != null) {
        if (lineage.state === 'committed' && lineage.committed_group_id) {
          this.assertVisibleGroupAuthorityInternal(lineage.committed_group_id, { purpose: 'reopen' });
        } else if (lineage.state === 'cancelled') {
          this.assertRedactedLineageAuthorityInternal(lineage.lineage_key, { purpose: 'reopen' });
        } else {
          throw new Error(`canonical conversation clear redacted lineage conflict: ${lineageKey}`);
        }
        closures.push({ lineage, alreadyRedacted: true });
        continue;
      }
      if (lineage.state === 'committed') {
        if (!lineage.committed_group_id) throw new Error('canonical conversation clear committed group conflict');
        this.assertVisibleGroupAuthorityInternal(lineage.committed_group_id, { purpose: 'reopen' });
      } else if (lineage.state === 'open') {
        const attemptRows = this.db.prepare(`
          SELECT t.lineage_revision_at_creation, t.turn_id,
                 t.rollout_key AS turn_kind, t.retry_of_turn_id,
                 t.input_user_batch_id, t.envelope_checksum,
                 b.tombstone_commitment AS batch_tombstone_commitment
          FROM turns t LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
          WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
          ORDER BY t.lineage_revision_at_creation, t.turn_id
        `).all(lineageKey);
        const attemptCommitment = authorityLineageAttemptsCommitment({
          lineageKey, attemptRows
        });
        if (attemptCommitment.attemptCount !== Number(lineage.attempt_count)
          || attemptCommitment.commitment !== lineage.attempt_commitment) {
          throw new Error(`canonical conversation clear attempt commitment conflict: ${lineageKey}`);
        }
        this.assertCanonicalLineageMessageAuthorityInternal({ lineageKey, mode: 'live' });
        const retainedGroup = this.db.prepare(`
          SELECT 1 FROM visible_result_groups WHERE lineage_key = ?
          UNION ALL SELECT 1 FROM visible_commit_receipts WHERE lineage_key = ?
          UNION ALL SELECT 1 FROM cloud_deliveries
            WHERE turn_id IN (SELECT turn_id FROM turns WHERE authority_lineage_key = ?)
              AND authority_group_id IS NOT NULL
          LIMIT 1
        `).get(lineageKey, lineageKey, lineageKey);
        if (retainedGroup) throw new Error(`canonical conversation clear open group conflict: ${lineageKey}`);
      } else {
        throw new Error(`canonical conversation clear lineage terminal conflict: ${lineageKey}`);
      }
      closures.push({ lineage, alreadyRedacted: false });
    }
    return { rows, canonical, affected, closures };
  }

  assertLegacyConversationClearDeliveryInternal(delivery) {
    const state = String(delivery?.state || '');
    const allowed = new Set(['waiting', 'pending', 'mailboxed', 'confirmed', 'delivered']);
    if (!delivery || !allowed.has(state)
      || typeof delivery.peer_id !== 'string' || !delivery.peer_id.trim()
      || typeof delivery.attempts !== 'number' || !Number.isSafeInteger(delivery.attempts)
      || delivery.attempts < 0
      || typeof delivery.recovery_ack_seq !== 'number'
      || !Number.isSafeInteger(delivery.recovery_ack_seq)
      || delivery.recovery_ack_seq < 0) {
      throw new Error('legacy conversation clear delivery authority conflict');
    }
    if (state === 'waiting' && delivery.attempts !== 0) {
      throw new Error('legacy conversation clear waiting attempts conflict');
    }
    const payload = parseJson(delivery.payload_json, null);
    const hasPayload = ['pending', 'mailboxed', 'confirmed', 'delivered'].includes(state);
    if (typeof delivery.created_at !== 'number' || !Number.isSafeInteger(delivery.created_at)
      || delivery.created_at <= 0
      || typeof delivery.updated_at !== 'number' || !Number.isSafeInteger(delivery.updated_at)
      || delivery.updated_at <= 0) {
      throw new Error('legacy conversation clear delivery timestamp conflict');
    }
    if (state === 'waiting') {
      if (delivery.payload_json !== null || delivery.checksum !== null
        || delivery.relay_message_id !== null || delivery.delivered_at !== null
        || delivery.confirmed_at !== null) {
        throw new Error('legacy conversation clear waiting delivery conflict');
      }
      return delivery;
    }
    if (!hasPayload || !payload || typeof payload !== 'object' || Array.isArray(payload)
      || !delivery.checksum || !/^[a-f0-9]{64}$/.test(delivery.checksum)
      || delivery.checksum !== contentHash(payload)
      || delivery.payload_json !== canonicalJson(payload)) {
      throw new Error('legacy conversation clear delivery payload conflict');
    }
    const expectedRelay = stableId(
      'relay_pc', `${delivery.turn_id}:${delivery.peer_id}:${delivery.checksum}`
    );
    if (state === 'pending') {
      if (delivery.relay_message_id !== null && delivery.relay_message_id !== expectedRelay) {
        throw new Error('legacy conversation clear pending relay conflict');
      }
      if (delivery.delivered_at !== null
        || delivery.confirmed_at !== null) {
        throw new Error('legacy conversation clear pending delivery conflict');
      }
    } else {
      if (delivery.relay_message_id !== expectedRelay
        || typeof delivery.delivered_at !== 'number'
        || !Number.isSafeInteger(delivery.delivered_at)
        || delivery.delivered_at <= 0) {
        throw new Error('legacy conversation clear relay identity conflict');
      }
      if (state === 'mailboxed' && delivery.confirmed_at !== null) {
        throw new Error('legacy conversation clear mailbox receipt conflict');
      }
      if (state === 'confirmed'
        && (typeof delivery.confirmed_at !== 'number'
          || !Number.isSafeInteger(delivery.confirmed_at)
          || delivery.confirmed_at < delivery.delivered_at)) {
        throw new Error('legacy conversation clear confirmed receipt conflict');
      }
      if (state === 'delivered' && delivery.confirmed_at !== null
        && (typeof delivery.confirmed_at !== 'number'
          || !Number.isSafeInteger(delivery.confirmed_at)
          || delivery.confirmed_at < delivery.delivered_at)) {
        throw new Error('legacy conversation clear delivered receipt conflict');
      }
    }
    return delivery;
  }

  assertLegacyConversationClearInputBatchInternal({ row, envelope }) {
    const protocolVersion = Number(envelope?.protocolVersion);
    if (envelope?.turnId !== row.turn_id
      || envelope?.characterId !== row.character_id
      || envelope?.deviceId !== row.device_id
      || !Number.isSafeInteger(envelope?.deviceSeq)
      || envelope.deviceSeq !== row.device_seq) {
      throw new Error(`legacy conversation clear envelope identity conflict: ${row.turn_id}`);
    }
    const batches = this.db.prepare(
      'SELECT * FROM current_user_batches WHERE turn_id = ? ORDER BY batch_id'
    ).all(row.turn_id);
    const items = this.db.prepare(
      'SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
    ).all(row.turn_id);
    const source = envelope.message;
    if (!source || typeof source.messageId !== 'string' || !source.messageId
      || typeof source.content !== 'string' || !source.content.trim()
      || !Number.isSafeInteger(source.sentAt)
      || source.speakerId !== 'user'
      || source.speakerType !== 'user'
      || source.recipientId !== row.character_id) {
      throw new Error(`legacy conversation clear outer source conflict: ${row.turn_id}`);
    }
    const persistedSource = this.db.prepare(
      'SELECT * FROM messages WHERE message_id = ?'
    ).get(source.messageId);
    const expectedSource = {
      messageId: source.messageId,
      turnId: row.turn_id,
      characterId: row.character_id,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: row.character_id,
      content: source.content,
      sentAt: source.sentAt,
      origin: 'phone',
      deviceId: row.device_id,
      deviceSeq: row.device_seq
    };
    if (!persistedSource
      || persistedSource.turn_id !== expectedSource.turnId
      || persistedSource.character_id !== expectedSource.characterId
      || persistedSource.speaker_id !== expectedSource.speakerId
      || persistedSource.speaker_type !== expectedSource.speakerType
      || persistedSource.recipient_id !== expectedSource.recipientId
      || persistedSource.content !== expectedSource.content
      || persistedSource.sent_at !== expectedSource.sentAt
      || persistedSource.origin !== expectedSource.origin
      || persistedSource.device_id !== expectedSource.deviceId
      || persistedSource.device_seq !== expectedSource.deviceSeq
      || persistedSource.checksum !== contentHash(expectedSource)) {
      throw new Error(`legacy conversation clear outer source closure conflict: ${row.turn_id}`);
    }
    if (protocolVersion === 1) {
      if (batches.length !== 0 || items.length !== 0) {
        throw new Error(`legacy conversation clear v1 batch conflict: ${row.turn_id}`);
      }
      return null;
    }
    if (protocolVersion !== 2) throw new Error(`legacy conversation clear batch protocol conflict: ${row.turn_id}`);
    let normalized;
    try {
      normalized = resolveCurrentUserBatch(envelope);
    } catch (error) {
      throw new Error(`legacy conversation clear input batch conflict: ${row.turn_id}`, { cause: error });
    }
    if (!normalized || normalized.complete !== true || normalized.missingMessageIds.length
      || !Array.isArray(normalized.messageIds) || normalized.messageIds.length === 0
      || new Set(normalized.messageIds).size !== normalized.messageIds.length
      || batches.length !== 1 || items.length !== normalized.messageIds.length) {
      throw new Error(`legacy conversation clear input batch conflict: ${row.turn_id}`);
    }
    const supplied = envelope.context?.currentBatch;
    if (supplied) {
      if (!Array.isArray(supplied.messageIds)
        || supplied.messageIds.length !== normalized.messageIds.length
        || new Set(supplied.messageIds).size !== supplied.messageIds.length
        || canonicalJson(supplied.messageIds) !== canonicalJson(normalized.messageIds)
        || !Array.isArray(supplied.messages)
        || supplied.messages.length !== normalized.messages.length
        || supplied.messages.some((message, index) =>
          canonicalJson(message) !== canonicalJson(normalized.messages[index]))) {
        throw new Error(`legacy conversation clear input batch projection conflict: ${row.turn_id}`);
      }
      const last = normalized.messages[normalized.messages.length - 1];
      if (!envelope.message || canonicalJson(envelope.message) !== canonicalJson(last)) {
        throw new Error(`legacy conversation clear input batch source conflict: ${row.turn_id}`);
      }
    }
    const batch = batches[0];
    const expectedBatch = {
      batchId: normalized.batchId,
      sourceMessageId: normalized.sourceMessageId,
      messageIds: normalized.messageIds,
      startedAt: normalized.startedAt,
      committedAt: normalized.committedAt
    };
    if (batch.batch_id !== expectedBatch.batchId
      || batch.character_id !== row.character_id
      || batch.source_message_id !== expectedBatch.sourceMessageId
      || Number(batch.started_at) !== expectedBatch.startedAt
      || Number(batch.committed_at) !== expectedBatch.committedAt
      || batch.checksum !== contentHash(expectedBatch)) {
      throw new Error(`legacy conversation clear input batch parent conflict: ${row.turn_id}`);
    }
    const byId = new Map(normalized.messages.map(message => [String(message.messageId || ''), message]));
    for (let sequence = 0; sequence < items.length; sequence += 1) {
      const item = items[sequence];
      const message = byId.get(item.message_id);
      if (!message || item.batch_id !== batch.batch_id
        || Number(item.sequence) !== sequence
        || item.message_id !== normalized.messageIds[sequence]
        || item.message_json !== canonicalJson(message)
        || item.checksum !== contentHash(message)) {
        throw new Error(`legacy conversation clear input batch item conflict: ${row.turn_id}`);
      }
    }
    if (this.userVersion() >= 13) {
      const tombstone = currentUserBatchTombstoneCommitment({
        turnId: row.turn_id,
        batchId: batch.batch_id,
        itemRows: items
      });
      if (Number(batch.item_count) !== tombstone.itemCount
        || batch.tombstone_commitment !== tombstone.commitment) {
        throw new Error(`legacy conversation clear input batch tombstone conflict: ${row.turn_id}`);
      }
    }
    return { batch, items, normalized };
  }

  freezeConversationClearAffectedAuthorityInternal({ roleId, clearEpoch, boundary }) {
    const authority = this.assertCanonicalConversationClearAffectedSetInternal({
      roleId, clearEpoch, boundary
    });
    const legacy = [];
    const legacyRows = this.db.prepare(`
      SELECT * FROM turns
      WHERE character_id = ? AND result_authority_version = 0
      ORDER BY turn_id
    `).all(roleId);
    for (const row of legacyRows) {
      let envelope;
      try {
        envelope = validateEnvelope(parseJson(row.envelope_json, null));
      } catch (error) {
        throw new Error(`legacy conversation clear envelope conflict: ${row.turn_id}`, { cause: error });
      }
      if (contentHash(envelope) !== row.envelope_checksum) {
        throw new Error(`legacy conversation clear envelope checksum conflict: ${row.turn_id}`);
      }
      if (row.authority_lineage_key != null
        || row.lineage_revision_at_creation != null
        || row.retry_of_turn_id != null
        || row.input_user_batch_id != null
        || row.agency_snapshot_checksum != null
        || row.generation_fingerprint != null) {
        throw new Error(`legacy conversation clear canonical reference conflict: ${row.turn_id}`);
      }
      const canonicalRefs = this.db.prepare(`
        SELECT 1 FROM visible_result_groups WHERE authoritative_turn_id = ?
        UNION ALL SELECT 1 FROM visible_commit_receipts WHERE authoritative_turn_id = ?
        UNION ALL SELECT 1 FROM cloud_deliveries
          WHERE turn_id = ? AND (authority_group_id IS NOT NULL OR authority_commit_checksum IS NOT NULL)
        LIMIT 1
      `).get(row.turn_id, row.turn_id, row.turn_id);
      if (canonicalRefs) {
        throw new Error(`legacy conversation clear canonical projection conflict: ${row.turn_id}`);
      }
      if (![1, 2].includes(Number(envelope.protocolVersion))) {
        throw new Error(`legacy conversation clear protocol conflict: ${row.turn_id}`);
      }
      const derivedLane = Number(envelope.protocolVersion) === 1
        ? 'private_chat' : laneKeyForEnvelope(envelope);
      if (row.lane_key != null && row.lane_key !== derivedLane) {
        throw new Error(`legacy conversation clear lane conflict: ${row.turn_id}`);
      }
      if (derivedLane !== 'private_chat') continue;
      this.assertLegacyConversationClearInputBatchInternal({ row, envelope });
      const sequence = row.input_visibility_sequence == null
        ? 0 : Number(row.input_visibility_sequence);
      const epoch = row.input_clear_epoch == null ? 0 : Number(row.input_clear_epoch);
      if (!Number.isSafeInteger(sequence) || sequence < 0
        || !Number.isSafeInteger(epoch) || epoch < 0) {
        throw new Error(`legacy conversation clear sequence conflict: ${row.turn_id}`);
      }
      if (!(epoch < clearEpoch || (epoch === clearEpoch && sequence <= boundary))) continue;
      const deliveries = this.db.prepare(
        'SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id'
      ).all(row.turn_id);
      for (const delivery of deliveries) this.assertLegacyConversationClearDeliveryInternal(delivery);
      legacy.push({ row, envelope, deliveries });
    }

    const turnIds = [...new Set([
      ...authority.affected.map(row => row.turn_id),
      ...legacy.map(entry => entry.row.turn_id)
    ])].sort();
    const lineageKeys = [...new Set(authority.closures.map(entry => entry.lineage.lineage_key))].sort();
    const groupIds = [...new Set(authority.closures
      .map(entry => entry.lineage.committed_group_id)
      .filter(Boolean))].sort();
    const messageIds = turnIds.length
      ? this.db.prepare(`SELECT message_id FROM messages
          WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY message_id`)
        .all(...turnIds).map(row => row.message_id)
      : [];
    const actionIds = groupIds.length
      ? this.db.prepare(`SELECT action_id FROM visible_result_actions
          WHERE group_id IN (${groupIds.map(() => '?').join(',')}) ORDER BY action_id`)
        .all(...groupIds).map(row => row.action_id)
      : [];
    return {
      authority,
      legacy,
      frozen: Object.freeze({
        turnIds: Object.freeze(turnIds),
        lineageKeys: Object.freeze(lineageKeys),
        groupIds: Object.freeze(groupIds),
        messageIds: Object.freeze([...new Set(messageIds)].sort()),
        actionIds: Object.freeze([...new Set(actionIds)].sort())
      })
    };
  }

  freezeAgencyPruneAuthorityInternal({ roleId, frozen, controlId, redactedAt }) {
    const safeRoleId = String(roleId || '');
    const affectedTurnIds = new Set((frozen?.turnIds || []).map(String));
    const affectedMessageIds = new Set((frozen?.messageIds || []).map(String));
    const affectedGroupIds = new Set((frozen?.groupIds || []).map(String));
    const affectedActionIds = new Set((frozen?.actionIds || []).map(String));
    if (!safeRoleId || !frozen || !String(controlId || '')
      || !Number.isSafeInteger(Number(redactedAt)) || Number(redactedAt) <= 0) {
      throw new Error('agency prune authority input conflict');
    }
    const sourceMessage = id => this.db.prepare(
      'SELECT * FROM messages WHERE message_id = ?'
    ).get(String(id));
    const validateSourceMessages = (ids, label) => {
      const evidence = ids.map(sourceMessage);
      if (evidence.some(item => !item || item.character_id !== safeRoleId
        || typeof item.checksum !== 'string' || item.checksum !== contentHash({
          messageId: item.message_id, turnId: item.turn_id, characterId: item.character_id,
          speakerId: item.speaker_id, speakerType: item.speaker_type,
          recipientId: item.recipient_id, content: item.content, sentAt: item.sent_at,
          origin: item.origin, deviceId: item.device_id ?? null,
          deviceSeq: item.device_seq == null ? null : Number(item.device_seq)
        }))) {
        throw new Error(`agency prune ${label} evidence conflict`);
      }
      return evidence;
    };
    const parseIds = (json, label) => {
      const ids = parseJson(json, null);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())
        || new Set(ids).size !== ids.length) {
        throw new Error(`agency prune ${label} source conflict`);
      }
      return ids.map(id => id.trim());
    };
    const allConstraints = this.db.prepare(
      'SELECT * FROM constraint_records WHERE role_id = ? ORDER BY constraint_id, revision'
    ).all(safeRoleId);
    const latestConstraintRevision = new Map();
    for (const row of allConstraints) {
      const ids = parseIds(row.source_message_ids_json, 'constraint');
      if (!['system', 'author', 'user'].includes(row.authority)
        || !['capability', 'consent', 'privacy', 'action', 'commitment', 'relationship_fact'].includes(row.kind)
        || !['active', 'released', 'archived'].includes(row.status)
        || typeof row.constraint_id !== 'string' || !row.constraint_id.trim()
        || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
        || (row.authority === 'user' && row.status === 'active' && ids.length === 0)) {
        throw new Error('agency prune constraint authority conflict');
      }
      const prior = latestConstraintRevision.get(row.constraint_id);
      if (prior != null && (Number(row.revision) !== prior + 1
        || row.supersedes !== `${row.constraint_id}@${prior}`)) {
        throw new Error('agency prune constraint revision conflict');
      }
      if (prior == null && (Number(row.revision) !== 1 || row.supersedes !== null)) {
        throw new Error('agency prune constraint revision conflict');
      }
      latestConstraintRevision.set(row.constraint_id, Number(row.revision));
    }
    const constraints = [];
    for (const row of allConstraints.filter(row =>
      row.authority === 'user' && row.status === 'active'
      && Number(row.revision) === latestConstraintRevision.get(row.constraint_id))) {
      const ids = parseIds(row.source_message_ids_json, 'constraint');
      if (!ids.length) throw new Error('agency prune user constraint source conflict');
      const evidence = ids.map(sourceMessage);
      if (evidence.some(item => !item || item.character_id !== safeRoleId
        || typeof item.checksum !== 'string' || item.checksum !== contentHash({
          messageId: item.message_id, turnId: item.turn_id, characterId: item.character_id,
          speakerId: item.speaker_id, speakerType: item.speaker_type,
          recipientId: item.recipient_id, content: item.content, sentAt: item.sent_at,
          origin: item.origin, deviceId: item.device_id ?? null,
          deviceSeq: item.device_seq == null ? null : Number(item.device_seq)
        }))) {
        throw new Error('agency prune user constraint evidence conflict');
      }
      const hit = ids.filter(id => affectedMessageIds.has(id));
      if (!hit.length) continue;
      constraints.push({
        row,
        sourceMessageIds: ids,
        survivingMessageIds: ids.filter(id => !affectedMessageIds.has(id))
      });
    }
    for (const row of allConstraints.filter(row =>
      row.authority !== 'user' && row.status === 'active'
      && Number(row.revision) === latestConstraintRevision.get(row.constraint_id))) {
      const ids = parseIds(row.source_message_ids_json, 'constraint');
      if (ids.some(id => affectedMessageIds.has(id))) {
        throw new Error('agency prune non-user constraint source conflict');
      }
      validateSourceMessages(ids, 'constraint');
    }
    const stances = [];
    for (const row of this.db.prepare(
      'SELECT * FROM stance_records WHERE role_id = ? ORDER BY stance_id, revision'
    ).all(safeRoleId)) {
      const ids = parseIds(row.source_message_ids_json, 'stance');
      const sourceTurnId = row.source_turn_id == null ? null : String(row.source_turn_id);
      const evidence = ids.map(sourceMessage);
      if (evidence.some(item => !item || item.character_id !== safeRoleId)) {
        throw new Error('agency prune stance evidence conflict');
      }
      const affectedIds = ids.filter(id => affectedMessageIds.has(id));
      const affected = (sourceTurnId && affectedTurnIds.has(sourceTurnId)) || affectedIds.length > 0;
      if (!affected) continue;
      const survivingIds = ids.filter(id => !affectedMessageIds.has(id));
      stances.push({ row, sourceMessageIds: ids, survivingMessageIds: survivingIds, sourceTurnId });
    }
    const jobs = [];
    for (const row of this.db.prepare(
      `SELECT * FROM consolidation_jobs WHERE role_id = ?
       AND state IN ('queued','retry_wait','running') ORDER BY job_id`
    ).all(safeRoleId)) {
      const payload = parseJson(row.payload_json, null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('agency prune job payload conflict');
      }
      const refs = [];
      const collect = (value, key = '') => {
        if (Array.isArray(value)) {
          for (const item of value) collect(item, key);
          return;
        }
        if (value && typeof value === 'object') {
          for (const [nestedKey, nestedValue] of Object.entries(value)) {
            collect(nestedValue, nestedKey);
          }
          return;
        }
        if (typeof value === 'string' && [
          'turnId', 'sourceTurnId', 'messageId', 'sourceMessageId',
          'actionId', 'sourceActionId', 'authorityGroupId', 'groupId',
          'lineageKey', 'sourceLineageKey'
        ].includes(key)) {
          refs.push({ key, value });
        }
      };
      collect(payload);
      for (const ref of refs) {
        if (['turnId', 'sourceTurnId'].includes(ref.key)) {
          const source = this.db.prepare(
            'SELECT character_id FROM turns WHERE turn_id = ?'
          ).get(ref.value);
          if (!source || source.character_id !== safeRoleId) {
            throw new Error('agency prune job turn source conflict');
          }
        } else if (['messageId', 'sourceMessageId'].includes(ref.key)) {
          const source = this.db.prepare(
            'SELECT character_id FROM messages WHERE message_id = ?'
          ).get(ref.value);
          if (!source || source.character_id !== safeRoleId) {
            throw new Error('agency prune job message source conflict');
          }
        } else if (['lineageKey', 'sourceLineageKey'].includes(ref.key)) {
          const source = this.db.prepare(
            'SELECT role_id FROM turn_authority_lineages WHERE lineage_key = ?'
          ).get(ref.value);
          if (!source || source.role_id !== safeRoleId) {
            throw new Error('agency prune job lineage source conflict');
          }
        } else if (['authorityGroupId', 'groupId'].includes(ref.key)) {
          const source = this.db.prepare(`
            SELECT t.character_id FROM visible_result_groups g
            JOIN turns t ON t.turn_id = g.authoritative_turn_id
            WHERE g.group_id = ?
          `).get(ref.value);
          if (!source || source.character_id !== safeRoleId) {
            throw new Error('agency prune job group source conflict');
          }
        } else if (['actionId', 'sourceActionId'].includes(ref.key)) {
          const source = this.db.prepare(`
            SELECT t.character_id FROM visible_result_actions a
            JOIN visible_result_groups g ON g.group_id = a.group_id
            JOIN turns t ON t.turn_id = g.authoritative_turn_id
            WHERE a.action_id = ?
          `).get(ref.value);
          if (!source || source.character_id !== safeRoleId) {
            throw new Error('agency prune job action source conflict');
          }
        }
      }
      const hit = (row.turn_id && affectedTurnIds.has(String(row.turn_id)))
        || (row.authority_group_id && affectedGroupIds.has(String(row.authority_group_id)))
        || (row.subject_type === 'turn' && affectedTurnIds.has(String(row.subject_id)))
        || refs.some(ref => affectedTurnIds.has(ref.value) || affectedGroupIds.has(ref.value)
          || affectedMessageIds.has(ref.value) || affectedActionIds.has(ref.value)
          || (frozen.lineageKeys || []).includes(ref.value));
      if (hit) jobs.push({ row, payload });
    }
    const cognitive = this.db.prepare(
      'SELECT * FROM cognitive_states WHERE role_id = ?'
    ).get(safeRoleId);
    return Object.freeze({
      roleId: safeRoleId,
      controlId: String(controlId),
      redactedAt: Number(redactedAt),
      turnIds: Object.freeze([...affectedTurnIds].sort()),
      messageIds: Object.freeze([...affectedMessageIds].sort()),
      groupIds: Object.freeze([...affectedGroupIds].sort()),
      actionIds: Object.freeze([...affectedActionIds].sort()),
      lineageKeys: Object.freeze([...(frozen.lineageKeys || [])].map(String).sort()),
      constraints: Object.freeze(constraints),
      stances: Object.freeze(stances),
      jobs: Object.freeze(jobs),
      cognitive: cognitive ? Object.freeze({ ...cognitive }) : null
    });
  }

  applyAgencyPrunePlanInternal(plan, { roleId, controlId, redactedAt }) {
    const safeRoleId = String(roleId || plan?.roleId || '');
    const at = Number(redactedAt || plan?.redactedAt);
    for (const entry of plan?.constraints || []) {
      const row = entry.row;
      const nextRevision = Number(row.revision) + 1;
      this.putConstraintRevisionInternal({
        constraintId: row.constraint_id,
        revision: nextRevision,
        roleId: safeRoleId,
        authority: 'user',
        kind: row.kind,
        subject: row.subject,
        scope: parseJson(row.scope_json, {}),
        rule: row.rule_text,
        sourceMessageIds: entry.survivingMessageIds || [],
        sourceConfigRef: row.source_config_ref,
        releaseCondition: row.release_condition,
        status: (entry.survivingMessageIds || []).length ? 'active' : 'archived',
        supersedes: `${row.constraint_id}@${row.revision}`,
        createdAt: Number(row.created_at),
        updatedAt: at
      });
    }
    for (const entry of plan?.stances || []) {
      const row = entry.row;
      const survivingIds = entry.survivingMessageIds || [];
      const nextRevision = Number(row.revision) + 1;
      const survivingSourceTurnId = survivingIds.length
        ? this.db.prepare(`
          SELECT turn_id FROM messages
          WHERE message_id IN (${survivingIds.map(() => '?').join(',')})
          ORDER BY sent_at ASC, message_id ASC LIMIT 1
        `).get(...survivingIds)?.turn_id
        : null;
      this.putStanceRevisionInternal({
        stanceId: row.stance_id,
        revision: nextRevision,
        roleId: safeRoleId,
        topic: row.topic,
        position: row.position_text,
        reason: row.reason_text,
        strength: Number(row.strength),
        flexibility: Number(row.flexibility),
        // An active mixed-source revision must not retain a redacted source
        // turn.  Derive its source turn from the surviving message authority;
        // sole-source redaction remains an expired historical revision.
        sourceTurnId: survivingSourceTurnId || row.source_turn_id || '',
        sourceMessageIds: survivingIds,
        createdAt: Number(row.created_at),
        lastConfirmedAt: at,
        expiresAt: survivingIds.length ? row.expires_at : at,
        remainingRelevantUserBatches: survivingIds.length
          ? Number(row.remaining_relevant_user_batches) : 0,
        status: survivingIds.length ? 'active' : 'expired',
        supersedes: `${row.stance_id}@${row.revision}`,
        authorityGroupId: null,
        authorityOrdinal: null
      });
    }
    for (const entry of plan?.jobs || []) {
      const row = entry.row;
      this.db.prepare(`UPDATE consolidation_jobs
        SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = 'SOURCE_REDACTED', updated_at = ?
        WHERE job_id = ? AND state IN ('queued','retry_wait','running')`)
        .run(at, row.job_id);
    }
    const current = this.db.prepare('SELECT * FROM cognitive_states WHERE role_id = ?').get(safeRoleId);
    const redactedTurns = new Set((this.db.prepare(`
      SELECT turn_id FROM turns WHERE character_id = ? AND authority_redacted_at IS NOT NULL
    `).all(safeRoleId)).map(row => String(row.turn_id)));
    const currentIsAffected = !current || (redactedTurns.has(String(current.last_turn_id))
      || (current.last_authority_group_id && (plan?.groupIds || []).includes(current.last_authority_group_id)));
    if (!currentIsAffected) return;
    const survivorCandidates = this.db.prepare(`
      SELECT t.turn_id, t.updated_at, t.authority_lineage_key,
             l.role_id AS lineage_role_id, l.lane_key AS lineage_lane_key,
             l.redacted_at AS lineage_redacted_at, l.state AS lineage_state,
             l.committed_group_id
      FROM turns t
      JOIN turn_authority_lineages l ON l.lineage_key = t.authority_lineage_key
      WHERE t.character_id = ? AND t.result_authority_version = 1
        AND t.lane_key = 'private_chat' AND t.authority_redacted_at IS NULL
        AND l.role_id = ? AND l.lane_key = 'private_chat'
        AND l.redacted_at IS NULL
        AND l.state = 'committed'
        AND t.state IN ('committed','completed','delivered')
      ORDER BY t.updated_at DESC, t.turn_id DESC
    `).all(safeRoleId, safeRoleId);
    let survivor = null;
    for (const candidate of survivorCandidates) {
      if (candidate.lineage_role_id !== safeRoleId
        || candidate.lineage_lane_key !== 'private_chat'
        || candidate.lineage_redacted_at != null
        || candidate.lineage_state !== 'committed') continue;
      if (candidate.committed_group_id == null) {
        survivor = candidate;
        break;
      }
      const group = this.db.prepare(`
        SELECT group_id, role_id, lane_key, authoritative_turn_id,
               lineage_key, redacted_at
        FROM visible_result_groups WHERE group_id = ?
      `).get(candidate.committed_group_id);
      if (!group || group.role_id !== safeRoleId || group.lane_key !== 'private_chat'
        || group.authoritative_turn_id !== candidate.turn_id
        || group.lineage_key !== candidate.authority_lineage_key
        || group.redacted_at != null) continue;
      try {
        this.assertVisibleGroupAuthorityInternal(candidate.committed_group_id, {
          purpose: 'reopen'
        });
      } catch {
        continue;
      }
      survivor = candidate;
      break;
    }
    const emptyState = {
      fastState: { mood: '', openThreadIds: [], openThreads: [] },
      mediumState: {},
      slowState: { preferenceFactIds: [] }
    };
    // The old row may contain mood, medium-scale boundaries, or preferences
    // learned from the cleared authority.  There is no per-turn immutable
    // cognitive projection to prove those fields came from the survivor, so
    // rebuilding from that row would reintroduce deleted semantics.  The
    // deterministic post-clear tuple therefore starts from the closed empty
    // schema-v2 state; only the independently verified survivor identity
    // below is retained.
    const nextState = emptyState;
    const lastTurnId = survivor?.turn_id || stableId('cognitive_clear_anchor', `${safeRoleId}:${controlId}`);
    const lastGroupId = survivor?.committed_group_id || null;
    const nextRevision = Math.max(1, Number(current?.revision || 0) + 1);
    const checksum = contentHash(nextState);
    this.db.prepare(`
      INSERT INTO cognitive_states(
        role_id, schema_version, revision, last_turn_id, state_json, checksum, updated_at,
        last_authority_group_id
      ) VALUES (?, 2, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(role_id) DO UPDATE SET
        schema_version = excluded.schema_version, revision = excluded.revision,
        last_turn_id = excluded.last_turn_id, state_json = excluded.state_json,
        checksum = excluded.checksum, updated_at = excluded.updated_at,
        last_authority_group_id = excluded.last_authority_group_id
    `).run(safeRoleId, nextRevision, lastTurnId, canonicalJson(nextState), checksum, at, lastGroupId);
  }

  writeAgencyPruneAuditInternal(plan, { roleId, controlId, redactedAt }) {
    const state = this.db.prepare(
      'SELECT revision, last_turn_id, last_authority_group_id, checksum, updated_at FROM cognitive_states WHERE role_id = ?'
    ).get(String(roleId));
    if (!state || !Number.isSafeInteger(Number(state.revision)) || Number(state.revision) < 1
      || typeof state.last_turn_id !== 'string' || !state.last_turn_id
      || (state.last_authority_group_id != null && typeof state.last_authority_group_id !== 'string')
      || typeof state.checksum !== 'string'
      || !Number.isSafeInteger(Number(state.updated_at)) || Number(state.updated_at) <= 0) {
      throw new Error('agency prune cognitive audit authority conflict');
    }
    const payload = {
      auditVersion: 'agency_prune_v1',
      controlId: String(controlId),
      roleId: String(roleId),
      redactedAt: Number(redactedAt),
      cognitiveRevision: Number(state.revision),
      cognitiveLastTurnId: state.last_turn_id,
      cognitiveLastAuthorityGroupId: state.last_authority_group_id ?? null,
      cognitiveChecksum: state.checksum,
      cognitiveUpdatedAt: Number(state.updated_at),
      affectedTurnIds: [...new Set((plan?.turnIds || []).map(String))].sort(),
      affectedLineageKeys: [...new Set((plan?.lineageKeys || []).map(String))].sort(),
      affectedGroupIds: [...new Set((plan?.groupIds || []).map(String))].sort(),
      affectedMessageIds: [...new Set((plan?.messageIds || []).map(String))].sort(),
      actionIds: [...new Set((plan?.actionIds || []).map(String))].sort(),
      jobIds: [...new Set((plan?.jobs || []).map(entry => String(entry.row.job_id)))].sort()
    };
    this.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES ('agency_redaction', ?, 'redact', ?, ?, ?)
    `).run(String(controlId), canonicalJson(payload), contentHash(payload), Number(redactedAt));
    return payload;
  }

  assertAgencyPruneClosureInternal({
    roleId, controlId, redactedAt, validateCurrentCognitive = true
  }) {
    const safeRoleId = String(roleId || '');
    const at = Number(redactedAt);
    const anchorId = stableId('cognitive_clear_anchor', `${safeRoleId}:${controlId}`);
    const agencyAuditRows = this.db.prepare(`
      SELECT * FROM sync_log
      WHERE entity_type = 'agency_redaction' AND entity_id = ?
      ORDER BY seq
    `).all(String(controlId));
    if (agencyAuditRows.length !== 1) {
      throw new Error('agency prune audit closure conflict');
    }
    const agencyAudit = parseJson(agencyAuditRows[0].payload_json, null);
    const expectedAuditKeys = [
      'actionIds', 'affectedGroupIds', 'affectedLineageKeys', 'affectedMessageIds',
      'affectedTurnIds', 'auditVersion', 'cognitiveChecksum',
      'cognitiveLastAuthorityGroupId', 'cognitiveLastTurnId',
      'cognitiveRevision', 'cognitiveUpdatedAt', 'controlId',
      'jobIds', 'redactedAt', 'roleId'
    ];
    if (!agencyAudit || typeof agencyAudit !== 'object' || Array.isArray(agencyAudit)
      || canonicalJson(Object.keys(agencyAudit).sort()) !== canonicalJson(expectedAuditKeys)
      || agencyAudit.auditVersion !== 'agency_prune_v1'
      || agencyAudit.controlId !== String(controlId)
      || agencyAudit.roleId !== safeRoleId
      || !Number.isSafeInteger(agencyAudit.redactedAt) || agencyAudit.redactedAt !== at
      || !Number.isSafeInteger(agencyAudit.cognitiveRevision) || agencyAudit.cognitiveRevision < 1
      || typeof agencyAudit.cognitiveLastTurnId !== 'string' || !agencyAudit.cognitiveLastTurnId
      || (agencyAudit.cognitiveLastAuthorityGroupId != null
        && (typeof agencyAudit.cognitiveLastAuthorityGroupId !== 'string'
          || !agencyAudit.cognitiveLastAuthorityGroupId))
      || !Number.isSafeInteger(agencyAudit.cognitiveUpdatedAt)
      || typeof agencyAudit.cognitiveChecksum !== 'string'
      || !Array.isArray(agencyAudit.affectedTurnIds)
      || !Array.isArray(agencyAudit.affectedLineageKeys)
      || !Array.isArray(agencyAudit.affectedGroupIds)
      || !Array.isArray(agencyAudit.affectedMessageIds)
      || !Array.isArray(agencyAudit.actionIds)
      || agencyAudit.actionIds.some(id => typeof id !== 'string' || !id)
      || canonicalJson([...agencyAudit.actionIds].sort()) !== canonicalJson(agencyAudit.actionIds)
      || new Set(agencyAudit.actionIds).size !== agencyAudit.actionIds.length
      || !Array.isArray(agencyAudit.jobIds)
      || agencyAudit.jobIds.some(id => typeof id !== 'string' || !id)
      || canonicalJson([...agencyAudit.jobIds].sort()) !== canonicalJson(agencyAudit.jobIds)
      || new Set(agencyAudit.jobIds).size !== agencyAudit.jobIds.length
      || [agencyAudit.affectedTurnIds, agencyAudit.affectedLineageKeys,
        agencyAudit.affectedGroupIds, agencyAudit.affectedMessageIds].some(ids =>
        ids.some(id => typeof id !== 'string' || !id)
          || canonicalJson([...ids].sort()) !== canonicalJson(ids)
          || new Set(ids).size !== ids.length)
      || agencyAuditRows[0].operation !== 'redact'
      || Number(agencyAuditRows[0].created_at) !== at
      || agencyAuditRows[0].payload_json !== canonicalJson(agencyAudit)
      || agencyAuditRows[0].checksum !== contentHash(agencyAudit)) {
      throw new Error('agency prune audit closure conflict');
    }
    const controlRow = this.db.prepare(`
      SELECT control_id, role_id, applied_at, authority_version
      FROM conversation_clear_controls WHERE control_id = ?
    `).get(String(controlId));
    if (!controlRow || controlRow.role_id !== safeRoleId
      || Number(controlRow.applied_at) !== at
      || Number(controlRow.authority_version) !== 1) {
      throw new Error('agency prune control closure conflict');
    }
    const state = this.db.prepare('SELECT * FROM cognitive_states WHERE role_id = ?').get(safeRoleId);
    if (validateCurrentCognitive && (!state
      || Number(state.revision) !== agencyAudit.cognitiveRevision
      || state.last_turn_id !== agencyAudit.cognitiveLastTurnId
      || (state.last_authority_group_id ?? null) !== agencyAudit.cognitiveLastAuthorityGroupId
      || Number(state.updated_at) !== agencyAudit.cognitiveUpdatedAt
      || state.checksum !== agencyAudit.cognitiveChecksum)) {
      throw new Error('agency prune cognitive tuple conflict');
    }
    if (validateCurrentCognitive && state && state.last_turn_id === anchorId
      && (Number(state.updated_at) !== at || Number(state.schema_version) !== 2
        || contentHash(parseJson(state.state_json, null)) !== state.checksum)) {
      throw new Error('agency prune cognitive anchor conflict');
    }
    if (validateCurrentCognitive && state && Number(state.updated_at) === at) {
      const rebuiltState = parseJson(state.state_json, null);
      if (!rebuiltState || typeof rebuiltState !== 'object' || Array.isArray(rebuiltState)
        || contentHash(rebuiltState) !== state.checksum
        || !rebuiltState.fastState || typeof rebuiltState.fastState !== 'object'
        || !rebuiltState.slowState || typeof rebuiltState.slowState !== 'object'
        || canonicalJson(rebuiltState.fastState.openThreadIds || []) !== '[]'
        || canonicalJson(rebuiltState.fastState.openThreads || []) !== '[]'
        || canonicalJson(rebuiltState.slowState.preferenceFactIds || []) !== '[]') {
        throw new Error('agency prune cognitive rebuilt state conflict');
      }
    }
    const redactedTurns = new Set(agencyAudit.affectedTurnIds);
    const redactedMessages = new Set(agencyAudit.affectedMessageIds);
    const assertLiveSourceMessages = (ids, label) => {
      for (const id of ids) {
        const message = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(id);
        if (!message || message.character_id !== safeRoleId
          || typeof message.checksum !== 'string'
          || message.checksum !== contentHash({
            messageId: message.message_id, turnId: message.turn_id,
            characterId: message.character_id, speakerId: message.speaker_id,
            speakerType: message.speaker_type, recipientId: message.recipient_id,
            content: message.content, sentAt: message.sent_at, origin: message.origin,
            deviceId: message.device_id ?? null,
            deviceSeq: message.device_seq == null ? null : Number(message.device_seq)
          })) {
          throw new Error(`agency prune ${label} evidence closure conflict`);
        }
      }
    };
    const redactedGroups = new Set(agencyAudit.affectedGroupIds);
    const redactedActions = new Set(redactedGroups.size
      ? this.db.prepare(`
        SELECT action_id FROM visible_result_actions
        WHERE group_id IN (${[...redactedGroups].map(() => '?').join(',')})
      `).all(...redactedGroups).map(row => String(row.action_id))
      : []);
    const scopedTurns = agencyAudit.affectedTurnIds.length
      ? this.db.prepare(`SELECT turn_id, character_id, lane_key, result_authority_version,
          authority_redacted_at, envelope_json
          FROM turns WHERE turn_id IN (${agencyAudit.affectedTurnIds.map(() => '?').join(',')})`)
        .all(...agencyAudit.affectedTurnIds)
      : [];
    if (scopedTurns.length !== agencyAudit.affectedTurnIds.length
      || scopedTurns.some(row => row.character_id !== safeRoleId
        || (Number(row.result_authority_version) === 1 && row.lane_key !== 'private_chat')
        || (Number(row.result_authority_version) === 1
          ? Number(row.authority_redacted_at) !== at
          : !(Number(row.result_authority_version) === 0
            && row.envelope_json === canonicalJson({ redacted: true })))) ) {
      throw new Error('agency prune turn scope closure conflict');
    }
    const scopedLineages = agencyAudit.affectedLineageKeys.length
      ? this.db.prepare(`SELECT lineage_key, role_id, lane_key, redacted_at
          FROM turn_authority_lineages
          WHERE lineage_key IN (${agencyAudit.affectedLineageKeys.map(() => '?').join(',')})`)
        .all(...agencyAudit.affectedLineageKeys)
      : [];
    if (scopedLineages.length !== agencyAudit.affectedLineageKeys.length
      || scopedLineages.some(row => row.role_id !== safeRoleId
        || row.lane_key !== 'private_chat' || Number(row.redacted_at) !== at)) {
      throw new Error('agency prune lineage scope closure conflict');
    }
    const scopedGroups = agencyAudit.affectedGroupIds.length
      ? this.db.prepare(`SELECT group_id, role_id, lane_key, redacted_at
          FROM visible_result_groups
          WHERE group_id IN (${agencyAudit.affectedGroupIds.map(() => '?').join(',')})`)
        .all(...agencyAudit.affectedGroupIds)
      : [];
    if (scopedGroups.length !== agencyAudit.affectedGroupIds.length
      || scopedGroups.some(row => row.role_id !== safeRoleId
        || row.lane_key !== 'private_chat' || Number(row.redacted_at) !== at)) {
      throw new Error('agency prune group scope closure conflict');
    }
    const scopedMessages = agencyAudit.affectedMessageIds.length
      ? this.db.prepare(`SELECT m.message_id, t.character_id, t.lane_key
          FROM messages m JOIN turns t ON t.turn_id = m.turn_id
          WHERE m.message_id IN (${agencyAudit.affectedMessageIds.map(() => '?').join(',')})`)
        .all(...agencyAudit.affectedMessageIds)
      : [];
    if (scopedMessages.length !== agencyAudit.affectedMessageIds.length
      || scopedMessages.some(row => row.character_id !== safeRoleId
        || (row.lane_key != null && row.lane_key !== 'private_chat'))) {
      throw new Error('agency prune message scope closure conflict');
    }
    const redactedLineages = new Set(agencyAudit.affectedLineageKeys);
    const expectedActionIds = redactedGroups.size
      ? this.db.prepare(`
        SELECT action_id FROM visible_result_actions
        WHERE group_id IN (${[...redactedGroups].map(() => '?').join(',')})
        ORDER BY action_id
      `).all(...redactedGroups).map(row => String(row.action_id))
      : [];
    if (canonicalJson(expectedActionIds) !== canonicalJson(agencyAudit.actionIds)) {
      throw new Error('agency prune action audit closure conflict');
    }
    if (validateCurrentCognitive && state && (redactedTurns.has(String(state.last_turn_id))
      || (state.last_authority_group_id != null
        && redactedGroups.has(String(state.last_authority_group_id))))) {
      throw new Error('agency prune cognitive source closure conflict');
    }
    const constraintRows = this.db.prepare(
      'SELECT * FROM constraint_records WHERE role_id = ? ORDER BY constraint_id, revision'
    ).all(safeRoleId);
    const latestConstraints = new Map();
    const latestConstraintRows = new Map();
    for (const row of constraintRows) {
      const ids = parseJson(row.source_message_ids_json, null);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())
        || new Set(ids).size !== ids.length || !['system', 'author', 'user'].includes(row.authority)
        || !['capability', 'consent', 'privacy', 'action', 'commitment', 'relationship_fact'].includes(row.kind)
        || !['active', 'released', 'archived'].includes(row.status)
        || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) {
        throw new Error('agency prune constraint closure conflict');
      }
      const previous = latestConstraints.get(row.constraint_id);
      if (previous != null && (Number(row.revision) !== previous + 1
        || row.supersedes !== `${row.constraint_id}@${previous}`)) {
        throw new Error('agency prune constraint revision closure conflict');
      }
      if (previous == null && (Number(row.revision) !== 1 || row.supersedes !== null)) {
        throw new Error('agency prune constraint revision closure conflict');
      }
      latestConstraints.set(row.constraint_id, Number(row.revision));
      latestConstraintRows.set(row.constraint_id, { row, ids });
    }
    for (const { ids } of latestConstraintRows.values()) {
      assertLiveSourceMessages(ids, 'constraint');
      if (ids.some(id => redactedMessages.has(id))) {
        throw new Error('agency prune constraint source closure conflict');
      }
    }
    const stanceRows = this.db.prepare(
      'SELECT * FROM stance_records WHERE role_id = ? ORDER BY stance_id, revision'
    ).all(safeRoleId);
    const latestStances = new Map();
    const latestStanceRows = new Map();
    for (const row of stanceRows) {
      const ids = parseJson(row.source_message_ids_json, null);
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())
        || new Set(ids).size !== ids.length || !['active', 'expired', 'superseded'].includes(row.status)
        || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1) {
        throw new Error('agency prune stance closure conflict');
      }
      const previous = latestStances.get(row.stance_id);
      if (previous != null && (Number(row.revision) !== previous + 1
        || row.supersedes !== `${row.stance_id}@${previous}`)) {
        throw new Error('agency prune stance revision closure conflict');
      }
      if (previous == null && (Number(row.revision) !== 1 || row.supersedes !== null)) {
        throw new Error('agency prune stance revision closure conflict');
      }
      latestStances.set(row.stance_id, Number(row.revision));
      latestStanceRows.set(row.stance_id, { row, ids });
    }
    for (const { row, ids } of latestStanceRows.values()) {
      assertLiveSourceMessages(ids, 'stance');
      if (row.status === 'expired' && ids.length !== 0) {
        throw new Error('agency prune stance source closure conflict');
      }
      if (row.status !== 'expired'
        && (ids.some(id => redactedMessages.has(id)) || redactedTurns.has(String(row.source_turn_id)))) {
        throw new Error('agency prune stance source closure conflict');
      }
    }
    const collectJobRefs = (value, key = '', refs = []) => {
      if (Array.isArray(value)) {
        value.forEach(item => collectJobRefs(item, key, refs));
      } else if (value && typeof value === 'object') {
        for (const [nestedKey, nestedValue] of Object.entries(value)) {
          collectJobRefs(nestedValue, nestedKey, refs);
        }
      } else if (typeof value === 'string' && [
        'turnId', 'sourceTurnId', 'messageId', 'sourceMessageId',
        'actionId', 'sourceActionId', 'authorityGroupId', 'groupId',
        'lineageKey', 'sourceLineageKey'
      ].includes(key)) {
        refs.push({ key, value });
      }
      return refs;
    };
    for (const row of this.db.prepare(`
      SELECT * FROM consolidation_jobs
      WHERE role_id = ? AND state IN ('queued','retry_wait','running')
    `).all(safeRoleId)) {
      const payload = parseJson(row.payload_json, null);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('agency prune job payload closure conflict');
      }
      const refs = collectJobRefs(payload);
      const affected = (row.turn_id && redactedTurns.has(String(row.turn_id)))
        || (row.authority_group_id && redactedGroups.has(String(row.authority_group_id)))
        || (row.subject_type === 'turn' && redactedTurns.has(String(row.subject_id)))
        || refs.some(ref => {
          if (['turnId', 'sourceTurnId'].includes(ref.key)) {
            return redactedTurns.has(ref.value);
          }
          if (['messageId', 'sourceMessageId'].includes(ref.key)) {
            return redactedMessages.has(ref.value);
          }
          if (['authorityGroupId', 'groupId'].includes(ref.key)) {
            return redactedGroups.has(ref.value);
          }
          if (['actionId', 'sourceActionId'].includes(ref.key)) {
            return redactedActions.has(ref.value);
          }
          if (['lineageKey', 'sourceLineageKey'].includes(ref.key)) {
            return redactedLineages.has(ref.value);
          }
          return false;
        });
      if (affected) throw new Error('agency prune executable job source closure conflict');
    }
    const auditedJobRows = agencyAudit.jobIds.length
      ? this.db.prepare(`
        SELECT job_id, state, lease_owner, lease_expires_at, last_error_code
        FROM consolidation_jobs
        WHERE role_id = ? AND job_id IN (${agencyAudit.jobIds.map(() => '?').join(',')})
      `).all(safeRoleId, ...agencyAudit.jobIds)
      : [];
    if (auditedJobRows.length !== agencyAudit.jobIds.length
      || auditedJobRows.some(row => row.state !== 'cancelled'
        || row.lease_owner !== null || row.lease_expires_at !== null
        || row.last_error_code !== 'SOURCE_REDACTED')) {
      throw new Error('agency prune job audit closure conflict');
    }
    const executable = redactedTurns.size || redactedGroups.size
      ? this.db.prepare(`
        SELECT COUNT(*) AS value FROM consolidation_jobs
        WHERE role_id = ? AND state IN ('queued','retry_wait','running')
          AND (turn_id IN (${[...redactedTurns].map(() => '?').join(',') || "''"})
            OR authority_group_id IN (${[...redactedGroups].map(() => '?').join(',') || "''"}))
      `).get(safeRoleId, ...redactedTurns, ...redactedGroups).value
      : 0;
    if (Number(executable) !== 0) throw new Error('agency prune executable job closure conflict');
    return true;
  }

  redactLegacyConversationTurnInternal({ entry, redactedAt, control, fault }) {
    const { row, envelope, deliveries } = entry;
    const turnId = row.turn_id;
    const messages = this.db.prepare('SELECT * FROM messages WHERE turn_id = ?').all(turnId);
    const batches = this.db.prepare('SELECT * FROM current_user_batches WHERE turn_id = ?').all(turnId);
    const batchItems = this.db.prepare(
      'SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY sequence'
    ).all(turnId);
    const protocolVersion = Number(envelope.protocolVersion);
    const batchItemByMessage = new Map(batchItems.map(item => [item.message_id, item]));
    const messageTuples = messages.map(message => ({
      messageId: message.message_id,
      turnId: message.turn_id,
      batchId: batchItemByMessage.get(message.message_id)?.batch_id ?? null,
      batchSequence: batchItemByMessage.has(message.message_id)
        ? Number(batchItemByMessage.get(message.message_id).sequence) : null,
      characterId: message.character_id,
      speakerId: message.speaker_id,
      speakerType: message.speaker_type,
      recipientId: message.recipient_id,
      sentAt: Number(message.sent_at),
      origin: message.origin,
      deviceId: message.device_id ?? null,
      deviceSeq: message.device_seq == null ? null : Number(message.device_seq),
      checksum: message.checksum
    })).sort((a, b) => a.messageId.localeCompare(b.messageId));
    const messageTombstoneCommitment = contentHash({
      auditVersion: 'legacy-turn-messages-v1', turnId, messages: messageTuples
    });
    const batchTuples = protocolVersion === 1 ? [] : batches.map(batch => {
      const items = batchItems.filter(item => item.turn_id === batch.turn_id)
        .map(item => ({
          sequence: Number(item.sequence), messageId: item.message_id, checksum: item.checksum
        }));
      const itemCommitment = contentHash({
        auditVersion: 'legacy-turn-batch-items-v1',
        turnId: batch.turn_id,
        batchId: batch.batch_id,
        items
      });
      return {
        turnId: batch.turn_id,
        batchId: batch.batch_id,
        characterId: batch.character_id,
        sourceMessageId: batch.source_message_id,
        startedAt: Number(batch.started_at),
        committedAt: Number(batch.committed_at),
        checksum: batch.checksum,
        itemCount: items.length,
        itemCommitment
      };
    });
    const batchTombstoneCommitment = contentHash({
      auditVersion: 'legacy-turn-batches-v1', turnId, batches: batchTuples
    });
    const linkedIds = [...new Set([
      turnId,
      ...messages.map(message => message.message_id),
      ...batches.map(batch => batch.batch_id)
    ])];
    const linkedMarks = linkedIds.map(() => '?').join(',') || "''";
    this.db.prepare(`DELETE FROM annotations
      WHERE turn_id = ? OR source_message_id IN (${messages.map(() => '?').join(',') || "''"})`)
      .run(turnId, ...messages.map(message => message.message_id));
    this.db.prepare('DELETE FROM diagnostics WHERE turn_id = ?').run(turnId);
    this.db.prepare(`UPDATE consolidation_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = 'SOURCE_REDACTED', updated_at = ?
      WHERE (turn_id = ? OR (subject_type = 'turn' AND subject_id = ?))
        AND state IN ('queued','retry_wait','running')`)
      .run(redactedAt, turnId, turnId);
    // Stances and cognitive state are append-only/derived agency authority.
    // Their clear-time revisions are written by applyAgencyPrunePlanInternal
    // from the pre-scrub frozen source projection.
    this.db.prepare(`UPDATE interaction_lanes SET generating_turn_id = NULL,
      latest_user_batch_id = CASE WHEN latest_user_batch_id IN (${batches.map(() => '?').join(',') || "''"})
        THEN NULL ELSE latest_user_batch_id END
      WHERE generating_turn_id = ?${batches.length ? ` OR latest_user_batch_id IN (${batches.map(() => '?').join(',')})` : ''}`)
      .run(...batches.map(batch => batch.batch_id), turnId, ...batches.map(batch => batch.batch_id));
    this.db.prepare('DELETE FROM sessions WHERE role = ?').run(row.character_id);
    this.db.prepare(`DELETE FROM sync_log WHERE entity_id IN (${linkedMarks})`).run(...linkedIds);
    if (protocolVersion === 1) {
      this.db.prepare('DELETE FROM current_user_batch_items WHERE turn_id = ?').run(turnId);
      this.db.prepare('DELETE FROM current_user_batches WHERE turn_id = ?').run(turnId);
    } else {
      for (const batch of batches) {
        this.db.prepare(`UPDATE current_user_batch_items
          SET message_json = NULL, redacted_at = ? WHERE turn_id = ?`)
          .run(redactedAt, batch.turn_id);
        const items = batchItems.filter(item => item.turn_id === batch.turn_id);
        const itemCommitment = contentHash({
          auditVersion: 'legacy-turn-batch-items-v1',
          turnId: batch.turn_id,
          batchId: batch.batch_id,
          items: items.map(item => ({
            sequence: Number(item.sequence), messageId: item.message_id, checksum: item.checksum
          }))
        });
        this.db.prepare(`UPDATE current_user_batches
          SET item_count = ?, tombstone_commitment = ? WHERE turn_id = ?`)
          .run(items.length, itemCommitment, batch.turn_id);
      }
    }
    this.db.prepare(`DELETE FROM turn_stages WHERE turn_id = ?`).run(turnId);
    for (const message of messages) {
      this.db.prepare('UPDATE messages SET content = ? WHERE message_id = ?')
        .run('', message.message_id);
    }
    fault('after_legacy_scrub');

    const originalDeliveries = deliveries.map(delivery => ({
      peerId: delivery.peer_id,
      originalState: delivery.state,
      relayMessageId: delivery.relay_message_id || (
        delivery.checksum
          ? stableId('relay_pc', `${delivery.turn_id}:${delivery.peer_id}:${delivery.checksum}`)
          : null
      ),
      deliveredAt: delivery.delivered_at == null ? null : Number(delivery.delivered_at),
      confirmedAt: delivery.confirmed_at == null ? null : Number(delivery.confirmed_at),
      recoveryAckSeq: Number(delivery.recovery_ack_seq),
      originalChecksum: delivery.checksum
    }));
    for (const delivery of deliveries) {
      const nextState = delivery.state === 'waiting' ? 'redacted' : 'redaction_pending';
      const relayMessageId = delivery.relay_message_id || (
        delivery.checksum
          ? stableId('relay_pc', `${delivery.turn_id}:${delivery.peer_id}:${delivery.checksum}`)
          : null
      );
      const updated = this.db.prepare(`UPDATE cloud_deliveries
        SET state = ?, payload_json = NULL, checksum = NULL, relay_message_id = ?,
            attempts = 0, redaction_requested_at = ?, redaction_acknowledged_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state = ?
          AND payload_json IS ? AND checksum IS ? AND relay_message_id IS ?
          AND delivered_at IS ? AND confirmed_at IS ?`)
        .run(nextState, relayMessageId,
          nextState === 'redaction_pending' ? redactedAt : null,
          nextState === 'redacted' ? redactedAt : null,
          redactedAt, delivery.turn_id, delivery.peer_id, delivery.state,
          delivery.payload_json, delivery.checksum, delivery.relay_message_id,
          delivery.delivered_at, delivery.confirmed_at);
      if (Number(updated.changes) !== 1) throw new Error('legacy conversation clear delivery CAS conflict');
    }
    const auditPayload = {
      auditVersion: 'legacy_turn_redaction_v1',
      controlId: control.controlId,
      deliveryCommitment: contentHash({
        auditVersion: 'legacy-turn-deliveries-v1', turnId, deliveries: originalDeliveries
      }),
      deliveryCount: originalDeliveries.length,
      deliveries: originalDeliveries,
      messageTombstoneCommitment,
      messageTombstoneCount: messageTuples.length,
      batchTombstoneCommitment,
      batchTombstoneCount: batchTuples.length,
      protocolVersion: Number(envelope.protocolVersion),
      redactedAt,
      roleId: row.character_id,
      turnId
    };
    this.db.prepare(`INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES ('legacy_turn_redaction', ?, 'redact', ?, ?, ?)`)
      .run(turnId, canonicalJson(auditPayload), contentHash(auditPayload), redactedAt);
    this.db.prepare(`UPDATE turns SET state = 'cancelled', worker_id = NULL,
      memory_packet_json = NULL, brain_draft_json = NULL, supervisor_json = NULL,
      reply_json = NULL, error_json = NULL, envelope_json = ?, route_reasons_json = '[]',
      annotation_snapshot_json = '{}', authority_redacted_at = ?, updated_at = ?
      WHERE turn_id = ? AND result_authority_version = 0`)
      .run(canonicalJson({ redacted: true }), redactedAt, redactedAt, turnId);
    fault('after_legacy_audit');
  }

  loadValidatedLegacyTurnRedactionInternal(turnId) {
    const turn = this.db.prepare('SELECT * FROM turns WHERE turn_id = ?').get(String(turnId));
    if (!turn || Number(turn.result_authority_version) !== 0
      || turn.state !== 'cancelled'
      || canonicalJson(parseJson(turn.envelope_json, null)) !== canonicalJson({ redacted: true })
      || turn.authority_redacted_at == null
      || turn.memory_packet_json !== null || turn.brain_draft_json !== null
      || turn.supervisor_json !== null || turn.reply_json !== null
      || turn.error_json !== null || turn.route_reasons_json !== '[]'
      || turn.annotation_snapshot_json !== '{}'
      || turn.authority_lineage_key != null
      || turn.lineage_revision_at_creation != null
      || turn.retry_of_turn_id != null
      || turn.input_user_batch_id != null
      || turn.agency_snapshot_checksum != null) {
      throw new Error('legacy redaction authority conflict');
    }
    const audits = this.db.prepare(`
      SELECT * FROM sync_log
      WHERE entity_type = 'legacy_turn_redaction' AND entity_id = ?
      ORDER BY seq
    `).all(String(turnId));
    if (audits.length !== 1) throw new Error('legacy redaction audit conflict');
    const audit = audits[0];
    const payload = parseJson(audit.payload_json, null);
    const expectedKeys = [
      'auditVersion', 'controlId', 'deliveryCommitment', 'deliveryCount',
      'deliveries', 'messageTombstoneCommitment', 'messageTombstoneCount',
      'batchTombstoneCommitment', 'batchTombstoneCount', 'protocolVersion',
      'redactedAt', 'roleId', 'turnId'
    ];
    if (!payload || canonicalJson(Object.keys(payload).sort()) !== canonicalJson([...expectedKeys].sort())
      || audit.operation !== 'redact' || audit.checksum !== contentHash(payload)
      || payload.auditVersion !== 'legacy_turn_redaction_v1'
      || payload.turnId !== turn.turn_id || payload.roleId !== turn.character_id
      || payload.redactedAt !== Number(turn.authority_redacted_at)
      || ![1, 2].includes(Number(payload.protocolVersion))
      || !Number.isSafeInteger(payload.redactedAt) || payload.redactedAt <= 0
      || !Array.isArray(payload.deliveries)
      || payload.deliveryCount !== payload.deliveries.length
      || !Number.isSafeInteger(payload.messageTombstoneCount)
      || !Number.isSafeInteger(payload.batchTombstoneCount)) {
      throw new Error('legacy redaction audit payload conflict');
    }
    const controlRow = this.db.prepare(
      'SELECT * FROM conversation_clear_controls WHERE control_id = ?'
    ).get(payload.controlId);
    if (!controlRow || Number(controlRow.authority_version) !== 1
      || controlRow.role_id !== turn.character_id
      || Number(controlRow.applied_at) !== Number(payload.redactedAt)) {
      throw new Error('legacy redaction control conflict');
    }
    validateConversationClearControl(parseJson(controlRow.semantic_json, null));
    const messages = this.db.prepare(
      'SELECT * FROM messages WHERE turn_id = ? ORDER BY message_id'
    ).all(turn.turn_id);
    const batchItems = this.db.prepare(
      'SELECT * FROM current_user_batch_items WHERE turn_id = ? ORDER BY batch_id, sequence'
    ).all(turn.turn_id);
    const batchItemByMessage = new Map(batchItems.map(item => [item.message_id, item]));
    const messageTuples = messages.map(message => ({
      messageId: message.message_id,
      turnId: message.turn_id,
      batchId: batchItemByMessage.get(message.message_id)?.batch_id ?? null,
      batchSequence: batchItemByMessage.has(message.message_id)
        ? Number(batchItemByMessage.get(message.message_id).sequence) : null,
      characterId: message.character_id,
      speakerId: message.speaker_id,
      speakerType: message.speaker_type,
      recipientId: message.recipient_id,
      sentAt: Number(message.sent_at),
      origin: message.origin,
      deviceId: message.device_id ?? null,
      deviceSeq: message.device_seq == null ? null : Number(message.device_seq),
      checksum: message.checksum
    })).sort((a, b) => a.messageId.localeCompare(b.messageId));
    if (messageTuples.length !== payload.messageTombstoneCount
      || messages.some(message => message.content !== '')
      || payload.messageTombstoneCommitment !== contentHash({
        auditVersion: 'legacy-turn-messages-v1', turnId: turn.turn_id, messages: messageTuples
      })) {
      throw new Error('legacy redaction message closure conflict');
    }
    const batches = this.db.prepare(
      'SELECT * FROM current_user_batches WHERE turn_id = ? ORDER BY batch_id'
    ).all(turn.turn_id);
    if (Number(payload.protocolVersion) === 1
      ? batches.length !== 0 || batchItems.length !== 0 || payload.batchTombstoneCount !== 0
      : payload.batchTombstoneCount !== batches.length) {
      throw new Error('legacy redaction batch closure conflict');
    }
    const batchTuples = batches.map(batch => {
      const items = batchItems.filter(item => item.turn_id === batch.turn_id);
      if (items.some(item => item.message_json !== null
        || Number(item.redacted_at) !== Number(payload.redactedAt))) {
        throw new Error('legacy redaction batch item closure conflict');
      }
      const itemCommitment = contentHash({
        auditVersion: 'legacy-turn-batch-items-v1',
        turnId: batch.turn_id,
        batchId: batch.batch_id,
        items: items.map(item => ({
          sequence: Number(item.sequence), messageId: item.message_id, checksum: item.checksum
        }))
      });
      if (Number(batch.item_count) !== items.length
        || batch.tombstone_commitment !== itemCommitment) {
        throw new Error('legacy redaction batch parent closure conflict');
      }
      return {
        turnId: batch.turn_id,
        batchId: batch.batch_id,
        characterId: batch.character_id,
        sourceMessageId: batch.source_message_id,
        startedAt: Number(batch.started_at),
        committedAt: Number(batch.committed_at),
        checksum: batch.checksum,
        itemCount: items.length,
        itemCommitment
      };
    });
    if (payload.batchTombstoneCommitment !== contentHash({
      auditVersion: 'legacy-turn-batches-v1', turnId: turn.turn_id, batches: batchTuples
    })) {
      throw new Error('legacy redaction batch commitment conflict');
    }
    const linkedIds = [
      turn.turn_id,
      ...messages.map(message => message.message_id),
      ...batches.map(batch => batch.batch_id)
    ];
    const linkedMarks = linkedIds.map(() => '?').join(',') || "''";
    if (Number(this.db.prepare(`
      SELECT COUNT(*) AS value FROM sync_log
      WHERE entity_id IN (${linkedMarks}) AND entity_type <> 'legacy_turn_redaction'
    `).get(...linkedIds).value) !== 0) {
      throw new Error('legacy redaction linked sync closure conflict');
    }
    const messageIdSet = new Set(messages.map(message => message.message_id));
    const messageMarksForAnnotations = [...messageIdSet].map(() => '?').join(',') || "''";
    if (Number(this.db.prepare(`
      SELECT COUNT(*) AS value FROM annotations
      WHERE turn_id = ? OR source_message_id IN (${messageMarksForAnnotations})
    `).get(turn.turn_id, ...messageIdSet).value) !== 0) {
      throw new Error('legacy redaction annotation closure conflict');
    }
    const session = this.db.prepare(
      'SELECT updated_at FROM sessions WHERE role = ?'
    ).get(turn.character_id);
    if (session && (typeof session.updated_at !== 'number'
      || !Number.isSafeInteger(session.updated_at)
      || session.updated_at <= Number(payload.redactedAt))) {
      throw new Error('legacy redaction session closure conflict');
    }
    if (Number(this.db.prepare(`
      SELECT COUNT(*) AS value FROM interaction_lanes
      WHERE generating_turn_id = ? OR latest_user_batch_id IN (
        SELECT batch_id FROM current_user_batches WHERE turn_id = ?
      )
    `).get(turn.turn_id, turn.turn_id).value) !== 0) {
      throw new Error('legacy redaction interaction lane closure conflict');
    }
    if (this.db.prepare(`
      SELECT 1 FROM visible_result_groups WHERE authoritative_turn_id = ?
      UNION ALL SELECT 1 FROM visible_commit_receipts WHERE authoritative_turn_id = ?
      LIMIT 1
    `).get(turn.turn_id, turn.turn_id)) {
      throw new Error('legacy redaction canonical result closure conflict');
    }
    const directLinkedCounts = [
      ['turn_stages', 'SELECT COUNT(*) AS value FROM turn_stages WHERE turn_id = ?'],
      ['annotations', 'SELECT COUNT(*) AS value FROM annotations WHERE turn_id = ?'],
      ['consolidation_jobs', `SELECT COUNT(*) AS value FROM consolidation_jobs
        WHERE turn_id = ? AND state IN ('queued','retry_wait','running')`],
      ['stance_records', `SELECT COUNT(*) AS value FROM stance_records
        WHERE source_turn_id = ? AND status = 'active'
          AND revision = (SELECT MAX(latest.revision) FROM stance_records latest
            WHERE latest.stance_id = stance_records.stance_id)`],
      ['cognitive_states', 'SELECT COUNT(*) AS value FROM cognitive_states WHERE last_turn_id = ?']
    ];
    for (const [table, sql] of directLinkedCounts) {
      if (Number(this.db.prepare(sql).get(turn.turn_id).value) !== 0) {
        throw new Error(`legacy redaction ${table} closure conflict`);
      }
    }
    if (Number(this.db.prepare(`
      SELECT COUNT(*) AS value FROM consolidation_jobs
      WHERE subject_type = 'turn' AND subject_id = ?
        AND state IN ('queued','retry_wait','running')
    `).get(turn.turn_id).value) !== 0) {
      throw new Error('legacy redaction consolidation job closure conflict');
    }
    const deliveries = this.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE turn_id = ? ORDER BY peer_id'
    ).all(turn.turn_id);
    this.assertRedactionQuarantineDiagnosticsForTurnsInternal(
      [turn.turn_id], 'legacy_redaction_delivery_quarantined'
    );
    if (deliveries.length !== payload.deliveries.length) {
      throw new Error('legacy redaction delivery count conflict');
    }
    const seen = new Set();
    for (const original of payload.deliveries) {
      const keys = [
        'confirmedAt', 'deliveredAt', 'originalChecksum', 'originalState',
        'peerId', 'recoveryAckSeq', 'relayMessageId'
      ];
      if (!original || canonicalJson(Object.keys(original).sort()) !== canonicalJson(keys)
        || typeof original.peerId !== 'string' || !original.peerId.trim()
        || seen.has(original.peerId)
        || !['waiting', 'pending', 'mailboxed', 'confirmed', 'delivered'].includes(original.originalState)
        || !Number.isSafeInteger(original.recoveryAckSeq) || original.recoveryAckSeq < 0
        || (original.originalChecksum !== null
          && (typeof original.originalChecksum !== 'string'
            || !/^[a-f0-9]{64}$/.test(original.originalChecksum)))
        || (original.relayMessageId !== null
          && (typeof original.relayMessageId !== 'string' || !original.relayMessageId.trim()))) {
        throw new Error('legacy redaction delivery audit conflict');
      }
      if (original.originalState === 'waiting'
        && (original.originalChecksum !== null || original.relayMessageId !== null)) {
        throw new Error('legacy redaction waiting audit conflict');
      }
      if (original.originalState !== 'waiting' && original.originalChecksum === null) {
        throw new Error('legacy redaction original checksum conflict');
      }
      const nativeTime = (value, name, { positive = false } = {}) => {
        if (value !== null && (typeof value !== 'number'
          || !Number.isSafeInteger(value)
          || (positive && value <= 0))) {
          throw new Error(`legacy redaction ${name} timestamp conflict`);
        }
        return value;
      };
      const deliveredAt = nativeTime(original.deliveredAt, 'deliveredAt', {
        positive: original.originalState !== 'waiting' && original.originalState !== 'pending'
      });
      const confirmedAt = nativeTime(original.confirmedAt, 'confirmedAt', {
        positive: original.originalState === 'confirmed'
          || (original.originalState === 'delivered' && original.confirmedAt !== null)
      });
      if (['waiting', 'pending'].includes(original.originalState)
        && (deliveredAt !== null || confirmedAt !== null)) {
        throw new Error('legacy redaction delivery time state conflict');
      }
      if (original.originalState === 'mailboxed'
        && (deliveredAt === null || confirmedAt !== null)) {
        throw new Error('legacy redaction mailbox time conflict');
      }
      if (original.originalState === 'confirmed'
        && (deliveredAt === null || confirmedAt === null || confirmedAt < deliveredAt)) {
        throw new Error('legacy redaction confirmed time conflict');
      }
      if (original.originalState === 'delivered'
        && deliveredAt === null) {
        throw new Error('legacy redaction delivered time conflict');
      }
      seen.add(original.peerId);
      const current = deliveries.find(row => row.peer_id === original.peerId);
      if (!current || current.payload_json !== null || current.checksum !== null
        || current.authority_group_id !== null || current.authority_commit_checksum !== null
        || current.attempts !== 0
        || typeof current.attempts !== 'number'
        || Number(current.recovery_ack_seq) !== original.recoveryAckSeq) {
        throw new Error('legacy redaction delivery closure conflict');
      }
      if (original.originalState === 'waiting') {
        if (current.state !== 'redacted' || current.relay_message_id !== null
          || Number(current.redaction_acknowledged_at) !== Number(payload.redactedAt)
          || current.redaction_requested_at !== null
          || current.delivered_at !== null || current.confirmed_at !== null) {
          throw new Error('legacy redaction waiting closure conflict');
        }
      } else {
        const expectedRelay = original.originalChecksum
          ? stableId('relay_pc', `${turn.turn_id}:${original.peerId}:${original.originalChecksum}`)
          : null;
        if (!['redaction_pending', 'quarantined'].includes(current.state)
          || !current.relay_message_id
          || current.relay_message_id !== expectedRelay
          || original.relayMessageId !== expectedRelay
          || Number(current.redaction_requested_at) !== Number(payload.redactedAt)
          || current.redaction_acknowledged_at !== null
          || (current.delivered_at == null ? deliveredAt !== null
            : (typeof current.delivered_at !== 'number'
              || !Number.isSafeInteger(current.delivered_at)
              || current.delivered_at !== deliveredAt))
          || (current.confirmed_at == null ? confirmedAt !== null
            : (typeof current.confirmed_at !== 'number'
              || !Number.isSafeInteger(current.confirmed_at)
              || current.confirmed_at !== confirmedAt))) {
          throw new Error('legacy redaction pending closure conflict');
        }
      }
    }
    if (seen.size !== deliveries.length
      || payload.deliveryCommitment !== contentHash({
        auditVersion: 'legacy-turn-deliveries-v1',
        turnId: turn.turn_id,
        deliveries: payload.deliveries
      })) {
      throw new Error('legacy redaction delivery commitment conflict');
    }
    return Object.freeze({
      kind: 'legacy_turn_redaction_v1',
      turnId: turn.turn_id,
      auditChecksum: audit.checksum
    });
  }

  publicLegacyRedactedTurnStatusInternal(turnId) {
    const id = String(turnId || '');
    const turn = this.db.prepare(`
      SELECT authority_redacted_at, envelope_json FROM turns WHERE turn_id = ?
    `).get(id);
    const audit = this.db.prepare(`
      SELECT 1 FROM sync_log
      WHERE entity_type = 'legacy_turn_redaction' AND entity_id = ?
      LIMIT 1
    `).get(id);
    const marked = Boolean(audit)
      || Boolean(turn && (turn.authority_redacted_at != null
        || canonicalJson(parseJson(turn.envelope_json, null)) === '{"redacted":true}'));
    if (!marked) return null;
    this.loadValidatedLegacyTurnRedactionInternal(turnId);
    return Object.freeze({ status: 'redacted', deliverable: false, terminal: true });
  }

  hasLegacyRedactionMarkerInternal(turnId) {
    const turn = this.db.prepare(`
      SELECT authority_redacted_at, envelope_json FROM turns WHERE turn_id = ?
    `).get(String(turnId || ''));
    if (!turn) return false;
    if (turn.authority_redacted_at != null
      || canonicalJson(parseJson(turn.envelope_json, null)) === '{"redacted":true}') return true;
    return Boolean(this.db.prepare(`
      SELECT 1 FROM sync_log
      WHERE entity_type = 'legacy_turn_redaction' AND entity_id = ?
      LIMIT 1
    `).get(String(turnId || '')));
  }

  assertLegacyRedactionAuditClosureInternal() {
    const rows = this.db.prepare(`
      SELECT entity_id FROM sync_log
      WHERE entity_type = 'legacy_turn_redaction'
      ORDER BY entity_id
    `).all();
    for (const row of rows) this.loadValidatedLegacyTurnRedactionInternal(row.entity_id);
    const redactedTurns = this.db.prepare(`
      SELECT turn_id FROM turns
      WHERE result_authority_version = 0
        AND envelope_json = ?
      ORDER BY turn_id
    `).all(canonicalJson({ redacted: true }));
    for (const row of redactedTurns) this.loadValidatedLegacyTurnRedactionInternal(row.turn_id);
  }

  redactCanonicalConversationLineageInternal({ lineage, redactedAt, fault, faultAfterStep = null }) {
    const attempts = this.db.prepare(`
      SELECT * FROM turns WHERE authority_lineage_key = ?
      ORDER BY lineage_revision_at_creation, turn_id
    `).all(lineage.lineage_key);
    if (!attempts.length) throw new Error('canonical conversation clear attempt conflict');
    const turnIds = attempts.map(row => row.turn_id);
    const turnMarks = turnIds.map(() => '?').join(',');
    const groupId = lineage.state === 'committed' ? lineage.committed_group_id : null;
    const group = groupId == null ? null : this.db.prepare(
      'SELECT * FROM visible_result_groups WHERE group_id = ?'
    ).get(groupId);
    if (groupId != null && !group) throw new Error('canonical conversation clear group conflict');
    const messages = this.db.prepare(`
      SELECT * FROM messages WHERE turn_id IN (${turnMarks})
        ${groupId == null ? '' : 'OR authority_group_id = ?'}
    `).all(...turnIds, ...(groupId == null ? [] : [groupId]));
    const messageIds = messages.map(row => row.message_id);
    const messageMarks = messageIds.map(() => '?').join(',') || "''";
    const batchRows = this.db.prepare(`
      SELECT * FROM current_user_batches WHERE turn_id IN (${turnMarks})
    `).all(...turnIds);
    const batchItems = this.db.prepare(`
      SELECT * FROM current_user_batch_items WHERE turn_id IN (${turnMarks})
      ORDER BY turn_id, sequence
    `).all(...turnIds);
    const itemRows = groupId == null ? [] : this.db.prepare(`
      SELECT * FROM visible_result_items WHERE group_id = ? ORDER BY ordinal
    `).all(groupId);
    const actionRows = groupId == null ? [] : this.db.prepare(`
      SELECT * FROM visible_result_actions WHERE group_id = ? ORDER BY ordinal
    `).all(groupId);
    const deliveries = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id IN (${turnMarks})
    `).all(...turnIds);
    if (deliveries.some(delivery =>
      delivery.authority_group_id != null && delivery.authority_group_id !== groupId)) {
      throw new Error('canonical conversation clear delivery lineage conflict');
    }
    for (const delivery of deliveries.filter(row => row.authority_group_id == null)) {
      this.assertCanonicalFailureDeliveryInternal(delivery);
    }
    const shell = canonicalJson({ redacted: true });

    // Clear every directly linked semantic/executable projection before the
    // authority shell is written. These rows are all in the enclosing clear
    // transaction and therefore cannot outlive a failed boundary.
    this.db.prepare(`DELETE FROM annotations
      WHERE turn_id IN (${turnMarks}) OR source_message_id IN (${messageMarks})`)
      .run(...turnIds, ...messageIds);
    this.db.prepare(`DELETE FROM diagnostics WHERE turn_id IN (${turnMarks})`).run(...turnIds);
    this.db.prepare(`UPDATE consolidation_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          last_error_code = 'SOURCE_REDACTED', updated_at = ?
      WHERE (turn_id IN (${turnMarks})${groupId == null ? '' : ' OR authority_group_id = ?'})
        AND state IN ('queued','retry_wait','running')`)
      .run(redactedAt, ...turnIds, ...(groupId == null ? [] : [groupId]));
    // Agency state is intentionally not deleted with the lineage shell. The
    // frozen clear plan appends stance revisions and deterministically rebuilds
    // the cognitive row after semantic redaction.
    this.db.prepare(`UPDATE interaction_lanes SET generating_turn_id = NULL
      WHERE generating_turn_id IN (${turnMarks})`).run(...turnIds);
    const batchIds = batchRows.map(row => row.batch_id);
    if (batchIds.length) {
      const batchMarks = batchIds.map(() => '?').join(',');
      this.db.prepare(`UPDATE interaction_lanes SET latest_user_batch_id = NULL
        WHERE latest_user_batch_id IN (${batchMarks})`).run(...batchIds);
    }
    if (groupId != null) {
      this.db.prepare(`UPDATE interaction_lanes
        SET latest_authoritative_group_id = CASE WHEN latest_authoritative_group_id = ? THEN NULL ELSE latest_authoritative_group_id END,
            native_completed_group_id = CASE WHEN native_completed_group_id = ? THEN NULL ELSE native_completed_group_id END,
            ui_applied_group_id = CASE WHEN ui_applied_group_id = ? THEN NULL ELSE ui_applied_group_id END
        WHERE latest_authoritative_group_id = ? OR native_completed_group_id = ? OR ui_applied_group_id = ?`)
        .run(groupId, groupId, groupId, groupId, groupId, groupId);
    }
    const roles = [...new Set(attempts.map(row => row.character_id))];
    const roleMarks = roles.map(() => '?').join(',') || "''";
    this.db.prepare(`DELETE FROM sessions WHERE role IN (${roleMarks})`).run(...roles);
    const linkedIds = [...new Set([
      lineage.lineage_key, ...(groupId == null ? [] : [groupId]), ...turnIds,
      ...messageIds, ...batchRows.map(row => row.batch_id)
    ])];
    const linkedMarks = linkedIds.map(() => '?').join(',') || "''";
    this.db.prepare(`DELETE FROM sync_log WHERE entity_id IN (${linkedMarks})`).run(...linkedIds);
    fault('after_direct_refs');

    for (const batch of batchRows) {
      const items = batchItems.filter(row => row.turn_id === batch.turn_id);
      this.db.prepare(`UPDATE current_user_batch_items
        SET message_json = NULL, redacted_at = ? WHERE turn_id = ?`).run(redactedAt, batch.turn_id);
      const commitment = currentUserBatchTombstoneCommitment({
        turnId: batch.turn_id, batchId: batch.batch_id, itemRows: items
      });
      this.db.prepare(`UPDATE current_user_batches
        SET item_count = ?, tombstone_commitment = ? WHERE turn_id = ?`)
        .run(commitment.itemCount, commitment.commitment, batch.turn_id);
    }
    fault('after_batches');

    for (const message of messages) {
      this.db.prepare('UPDATE messages SET content = ? WHERE message_id = ?')
        .run('', message.message_id);
    }
    this.db.prepare(`UPDATE turns
      SET state = CASE WHEN turn_id = ? AND ? IS NOT NULL THEN 'committed' ELSE 'cancelled' END,
          worker_id = NULL, memory_packet_json = NULL, brain_draft_json = NULL,
          supervisor_json = NULL, reply_json = NULL, error_json = NULL,
          envelope_json = ?, envelope_checksum = envelope_checksum,
          route_reasons_json = '[]', annotation_snapshot_json = '{}',
          authority_redacted_at = ?,
          updated_at = ?
      WHERE authority_lineage_key = ?`).run(
      lineage.latest_turn_id, groupId, shell, redactedAt,
      redactedAt, lineage.lineage_key
    );
    fault('after_messages');

    if (groupId == null) {
      for (const delivery of deliveries) {
        const removed = this.db.prepare(`DELETE FROM cloud_deliveries
          WHERE turn_id = ? AND peer_id = ? AND state = ?
            AND payload_json IS ? AND checksum IS ? AND relay_message_id IS ?
            AND authority_group_id IS ? AND authority_commit_checksum IS ?`)
          .run(delivery.turn_id, delivery.peer_id, delivery.state,
            delivery.payload_json, delivery.checksum, delivery.relay_message_id,
            delivery.authority_group_id, delivery.authority_commit_checksum);
        if (Number(removed.changes) !== 1) throw new Error('canonical conversation clear delivery CAS conflict');
      }
      this.db.prepare(`UPDATE turn_authority_lineages
        SET state = 'cancelled', committed_group_id = NULL, revision = revision + 1,
            redacted_at = ?, updated_at = ?
        WHERE lineage_key = ?`).run(redactedAt, redactedAt, lineage.lineage_key);
      fault('after_group');
      const payload = { groupId: null, reasonCode: 'conversation_clear', redactedAt };
      this.db.prepare(`INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
        VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)`)
        .run(lineage.lineage_key, canonicalJson(payload), contentHash(payload), redactedAt);
      if (faultAfterStep === 'after_audit_invalid_shell') {
        this.db.prepare('UPDATE turns SET envelope_json = ? WHERE authority_lineage_key = ?')
          .run('{"redacted":false}', lineage.lineage_key);
      }
      fault('after_audit');
      return;
    }

    // A failed/retry attempt may still have a legacy canonical-failure
    // delivery row. It is directly linked to this lineage, but has no result
    // group authority; remove it rather than leaving a redacted envelope that
    // the failure-delivery validator could interpret as recoverable.
    for (const delivery of deliveries.filter(row => row.authority_group_id == null)) {
      const removed = this.db.prepare(`DELETE FROM cloud_deliveries
        WHERE turn_id = ? AND peer_id = ? AND state = ?
          AND payload_json IS ? AND checksum IS ? AND relay_message_id IS ?
          AND authority_group_id IS ? AND authority_commit_checksum IS ?`)
        .run(delivery.turn_id, delivery.peer_id, delivery.state,
          delivery.payload_json, delivery.checksum, delivery.relay_message_id,
          delivery.authority_group_id, delivery.authority_commit_checksum);
      if (Number(removed.changes) !== 1) throw new Error('canonical conversation clear delivery CAS conflict');
    }

    this.db.prepare(`UPDATE visible_result_items
      SET item_json = NULL, redacted_at = ? WHERE group_id = ?`).run(redactedAt, groupId);
    this.db.prepare(`UPDATE visible_result_actions
      SET action_kind = NULL, target_key = NULL, target_revision = NULL,
          action_json = NULL, redacted_at = ? WHERE group_id = ?`).run(redactedAt, groupId);
    this.db.prepare(`UPDATE visible_result_manifests
      SET semantic_json = NULL, redacted_at = ? WHERE group_id = ?`).run(redactedAt, groupId);
    const tombstone = visibleResultTombstoneCommitment({
      groupId, itemRows: this.db.prepare('SELECT * FROM visible_result_items WHERE group_id = ?').all(groupId),
      actionRows: this.db.prepare('SELECT * FROM visible_result_actions WHERE group_id = ?').all(groupId)
    });
    fault('after_group');

    for (const delivery of deliveries.filter(row => row.authority_group_id === groupId)) {
      const hasRelay = delivery.relay_message_id != null;
      const updatedDelivery = this.db.prepare(`UPDATE cloud_deliveries
        SET state = ?, payload_json = NULL, checksum = NULL,
            redaction_requested_at = ?, redaction_acknowledged_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state = ?
          AND payload_json IS ? AND checksum IS ? AND relay_message_id IS ?
          AND authority_group_id IS ? AND authority_commit_checksum IS ?`)
        .run(hasRelay ? 'redaction_pending' : 'redacted', hasRelay ? redactedAt : null,
          hasRelay ? null : redactedAt, redactedAt, delivery.turn_id, delivery.peer_id,
          delivery.state, delivery.payload_json, delivery.checksum, delivery.relay_message_id,
          delivery.authority_group_id, delivery.authority_commit_checksum);
      if (Number(updatedDelivery.changes) !== 1) {
        throw new Error('canonical conversation clear delivery CAS conflict');
      }
    }
    const finalDeliveries = this.db.prepare(
      'SELECT * FROM cloud_deliveries WHERE authority_group_id = ?'
    ).all(groupId);
    const deliveryCommitment = authorityRedactionDeliveriesCommitment({
      groupId, deliveryRows: finalDeliveries
    });
    this.db.prepare(`UPDATE visible_result_groups
      SET redacted_at = ?, tombstone_commitment = ?,
          redaction_delivery_count = ?, redaction_delivery_commitment = ?
      WHERE group_id = ?`).run(
      redactedAt, tombstone.commitment, deliveryCommitment.deliveryCount,
      deliveryCommitment.commitment, groupId
    );
    this.db.prepare(`UPDATE turn_authority_lineages
      SET redacted_at = ?, updated_at = ? WHERE lineage_key = ?`)
      .run(redactedAt, redactedAt, lineage.lineage_key);
    fault('after_delivery');
    const payload = { groupId, reasonCode: 'conversation_clear', redactedAt };
    this.db.prepare(`INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES ('authority_redaction', ?, 'redact', ?, ?, ?)`)
      .run(groupId, canonicalJson(payload), contentHash(payload), redactedAt);
    if (faultAfterStep === 'after_audit_invalid_shell') {
      this.db.prepare('UPDATE visible_result_manifests SET semantic_json = ? WHERE group_id = ?')
        .run('{"corrupt":true}', groupId);
    }
    fault('after_audit');
  }

  applyConversationClearInternal(control, { appliedAt, faultAfterStep = null } = {}) {
    const normalizedControl = validateConversationClearControl(control);
    if (typeof appliedAt !== 'number' || !Number.isSafeInteger(appliedAt) || appliedAt <= 0) {
      throw new Error('conversation clear appliedAt conflict');
    }
    const fault = step => {
      if (faultAfterStep === step) throw new Error(`forced conversation clear fault: ${step}`);
    };
    const laneKey = 'private_chat';
    const mapAppliedProof = row => {
      const body = {
        protocolVersion: 3,
        type: 'CONVERSATION_CLEAR_APPLIED',
        controlId: row.control_id,
        controlChecksum: row.checksum,
        roleId: row.role_id,
        peerId: row.peer_id,
        clearEpoch: Number(row.clear_epoch),
        clearedThroughSequence: Number(row.cleared_through_sequence),
        appliedAt: Number(row.applied_at)
      };
      const proof = validateConversationClearApplied({ ...body, checksum: contentHash(body) });
      if (row.applied_checksum !== proof.checksum) {
        throw new Error(`conversation clear applied proof conflict: ${row.control_id}`);
      }
      return proof;
    };
    const assertPersistedRow = row => {
      if (!row || Number(row.authority_version) !== 1) {
        throw new Error('conversation clear persisted authority conflict');
      }
      const persisted = validateConversationClearControl(parseJson(row.semantic_json, null));
      if (canonicalJson(persisted) !== row.semantic_json
        || persisted.controlId !== row.control_id
        || persisted.roleId !== row.role_id
        || persisted.peerId !== row.peer_id
        || persisted.clearEpoch !== Number(row.clear_epoch)
        || persisted.clearedThroughSequence !== Number(row.cleared_through_sequence)
        || persisted.requestedAt !== Number(row.requested_at)
        || persisted.inputCursorChecksum !== row.input_cursor_checksum
        || persisted.checksum !== row.checksum) {
        throw new Error(`conversation clear persisted semantic conflict: ${row.control_id}`);
      }
      return mapAppliedProof(row);
    };
    return this.withImmediateTransaction(() => {
      // Revalidate the closed wire while the write lock is held. The cursor
      // checksum is retained as command identity; PC has no source-of-truth
      // cursor projection from which to recompute it.
      const currentControl = validateConversationClearControl(control);
      if (canonicalJson(currentControl) !== canonicalJson(normalizedControl)) {
        throw new Error('conversation clear control changed during transaction');
      }
      const byId = this.db.prepare(
        'SELECT * FROM conversation_clear_controls WHERE control_id = ?'
      ).get(currentControl.controlId);
      if (byId) {
        const proof = assertPersistedRow(byId);
        this.assertMemoryPruneClosureInternal({
          controlId: currentControl.controlId,
          roleId: currentControl.roleId,
          redactedAt: Number(byId.applied_at)
        });
        this.assertAgencyPruneClosureInternal({
          roleId: currentControl.roleId,
          controlId: currentControl.controlId,
          redactedAt: Number(byId.applied_at)
        });
        if (canonicalJson(parseJson(byId.semantic_json, null)) !== canonicalJson(currentControl)) {
          throw new Error('conversation clear control replay conflict');
        }
        const replayAudits = this.db.prepare(`
          SELECT entity_id, payload_json FROM sync_log
          WHERE entity_type = 'legacy_turn_redaction'
          ORDER BY entity_id
        `).all();
        for (const audit of replayAudits) {
          const payload = parseJson(audit.payload_json, null);
          if (payload?.controlId === currentControl.controlId) {
            this.loadValidatedLegacyTurnRedactionInternal(audit.entity_id);
          }
        }
        const replayAudit = this.db.prepare(`
          SELECT payload_json FROM sync_log
          WHERE entity_type = 'agency_redaction' AND entity_id = ?
        `).get(currentControl.controlId);
        const replayPayload = parseJson(replayAudit?.payload_json, null);
        const replayLineages = (replayPayload?.affectedLineageKeys || [])
          .map(lineageKey => ({ authority_lineage_key: lineageKey }));
        for (const row of replayLineages) {
          const lineage = this.db.prepare(
            'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
          ).get(row.authority_lineage_key);
          if (!lineage) throw new Error('conversation clear replay lineage conflict');
          if (lineage.committed_group_id) {
            this.assertVisibleGroupAuthorityInternal(lineage.committed_group_id, { purpose: 'reopen' });
          } else {
            this.assertRedactedLineageAuthorityInternal(lineage.lineage_key, { purpose: 'reopen' });
          }
        }
        return proof;
      }
      const byRoleEpoch = this.db.prepare(
        `SELECT * FROM conversation_clear_controls
         WHERE role_id = ? AND clear_epoch = ?`
      ).get(currentControl.roleId, currentControl.clearEpoch);
      if (byRoleEpoch) {
        throw new Error('conversation clear role epoch collision');
      }

      const lane = this.getInteractionLane(currentControl.roleId, laneKey);
      if (!lane || lane.roleId !== currentControl.roleId || lane.laneKey !== laneKey) {
        throw new Error('conversation clear role lane conflict');
      }
      for (const field of [
        'revision', 'clearEpoch', 'clearedThroughSequence',
        'nativeCompletedSequence', 'uiAppliedSequence'
      ]) {
        if (!Number.isSafeInteger(lane[field]) || lane[field] < 0) {
          throw new Error(`conversation clear lane ${field} conflict`);
        }
      }
      const expectedEpoch = Number(lane.clearEpoch) + 1;
      if (currentControl.clearEpoch !== expectedEpoch) {
        throw new Error('conversation clear epoch conflict');
      }
      const currentBoundary = Math.max(
        Number(lane.clearedThroughSequence),
        Number(lane.nativeCompletedSequence),
        Number(lane.uiAppliedSequence)
      );
      if (currentControl.clearedThroughSequence < currentBoundary) {
        throw new Error('conversation clear boundary conflict');
      }

      const frozenAuthority = this.freezeConversationClearAffectedAuthorityInternal({
        roleId: currentControl.roleId,
        clearEpoch: currentControl.clearEpoch,
        boundary: currentControl.clearedThroughSequence
      });
      // Freeze and validate every memory source projection before the first
      // authority/control mutation.  The resulting plan is reused after the
      // turn/lineage scrub; it is never recomputed from partially redacted
      // rows.
      const memoryPrunePlan = this.prepareMemoryPruneInternal({
        roleId: currentControl.roleId,
        frozen: frozenAuthority.frozen,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      const agencyPrunePlan = this.freezeAgencyPruneAuthorityInternal({
        roleId: currentControl.roleId,
        frozen: frozenAuthority.frozen,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      const semanticJson = canonicalJson(currentControl);
      const appliedBody = {
        protocolVersion: 3,
        type: 'CONVERSATION_CLEAR_APPLIED',
        controlId: currentControl.controlId,
        controlChecksum: currentControl.checksum,
        roleId: currentControl.roleId,
        peerId: currentControl.peerId,
        clearEpoch: currentControl.clearEpoch,
        clearedThroughSequence: currentControl.clearedThroughSequence,
        appliedAt
      };
      const applied = validateConversationClearApplied({
        ...appliedBody,
        checksum: contentHash(appliedBody)
      });
      this.db.prepare(`
        INSERT INTO conversation_clear_controls(
          control_id, role_id, peer_id, clear_epoch, cleared_through_sequence,
          requested_at, applied_at, input_cursor_checksum, checksum,
          applied_checksum, authority_version, semantic_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).run(
        currentControl.controlId,
        currentControl.roleId,
        currentControl.peerId,
        currentControl.clearEpoch,
        currentControl.clearedThroughSequence,
        currentControl.requestedAt,
        appliedAt,
        currentControl.inputCursorChecksum,
        currentControl.checksum,
        applied.checksum,
        semanticJson
      );
      fault('after_control_insert');
      for (const closure of frozenAuthority.authority.closures) {
        if (!closure.alreadyRedacted) {
          this.redactCanonicalConversationLineageInternal({
            lineage: closure.lineage,
            redactedAt: appliedAt,
            fault,
            faultAfterStep
          });
        }
      }
      for (const entry of frozenAuthority.legacy) {
        this.redactLegacyConversationTurnInternal({
          entry,
          redactedAt: appliedAt,
          control: currentControl,
          fault
        });
      }
      this.applyMemoryPrunePlanInternal(memoryPrunePlan, {
        roleId: currentControl.roleId,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      this.applyAgencyPrunePlanInternal(agencyPrunePlan, {
        roleId: currentControl.roleId,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      this.writeAgencyPruneAuditInternal(agencyPrunePlan, {
        roleId: currentControl.roleId,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      this.assertAgencyPruneClosureInternal({
        roleId: currentControl.roleId,
        controlId: currentControl.controlId,
        redactedAt: appliedAt
      });
      this.assertMemoryPruneClosureInternal({
        controlId: currentControl.controlId,
        roleId: currentControl.roleId,
        redactedAt: appliedAt
      });
      fault('after_memory_prune');
      fault('after_agency_prune');

      const updatedLane = this.db.prepare(`
        UPDATE interaction_lanes
        SET revision = revision + 1,
            clear_epoch = ?,
            cleared_through_sequence = ?,
            updated_at = ?
        WHERE role_id = ? AND lane_key = ? AND revision = ?
      `).run(
        currentControl.clearEpoch,
        currentControl.clearedThroughSequence,
        appliedAt,
        currentControl.roleId,
        laneKey,
        Number(lane.revision)
      );
      if (Number(updatedLane.changes) !== 1) throw new Error('conversation clear lane CAS conflict');
      fault('after_lane_update');

      const persisted = this.db.prepare(
        'SELECT * FROM conversation_clear_controls WHERE control_id = ?'
      ).get(currentControl.controlId);
      if (!persisted) throw new Error('conversation clear persisted row missing');
      for (const entry of frozenAuthority.legacy) {
        this.loadValidatedLegacyTurnRedactionInternal(entry.row.turn_id);
      }
      for (const closure of frozenAuthority.authority.closures) {
        if (closure.lineage.committed_group_id) {
          this.assertVisibleGroupAuthorityInternal(closure.lineage.committed_group_id, { purpose: 'reopen' });
        } else {
          this.assertRedactedLineageAuthorityInternal(closure.lineage.lineage_key, { purpose: 'reopen' });
        }
      }
      fault('after_post_write_validation');
      fault('after_applied_projection');
      return assertPersistedRow(persisted);
    });
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
      const candidatePhase = toMode === 'shadow'
        ? 'shadow'
        : toMode === 'active' && toPhase === 'canary'
          ? 'canary'
          : current.current_mode !== 'legacy' && toMode === 'legacy'
            ? 'rolled_back'
            : current.candidate_phase;
      this.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET candidate_phase = ?
        WHERE rollout_key = ? AND revision = ?
      `).run(candidatePhase, rolloutKey, nextRevision);
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

  hasCanonicalV3LanePinInternal(roleId, laneKey) {
    return Boolean(this.db.prepare(`
      SELECT 1 AS value
      FROM turns
      WHERE character_id = ? AND lane_key = ? AND result_authority_version = 1
        AND (
          json_extract(envelope_json, '$.protocolVersion') = 3
          OR authority_redacted_at IS NOT NULL
        )
      LIMIT 1
    `).get(String(roleId), String(laneKey)));
  }

  assertLegacyV3CursorAnchorInternal({ envelope, laneKey, turnId }) {
    const anchor = this.getTurn(turnId);
    const terminalStates = new Set(['committed', 'delivered', 'completed', 'fallback']);
    if (!anchor
      || Number(anchor.resultAuthorityVersion || 0) !== 0
      || anchor.characterId !== envelope.characterId
      || anchor.deviceId !== envelope.deviceId
      || !terminalStates.has(anchor.state)) {
      throw new Error('legacy bootstrap authority conflict');
    }
    const anchorEnvelope = validateEnvelope(parseJson(anchor.envelopeJson, null));
    const anchorLaneKey = authorityLaneKeyForEnvelope(anchorEnvelope);
    if (anchorLaneKey !== laneKey) throw new Error('legacy bootstrap authority conflict');
    if (anchorEnvelope.message) {
      const message = this.getMessage(anchorEnvelope.message.messageId);
      if (!message
        || message.turnId !== anchor.turnId
        || message.characterId !== envelope.characterId
        || message.speakerType !== 'user') {
        throw new Error('legacy bootstrap authority conflict');
      }
    }
    return anchor;
  }

  assertCanonicalV3CursorGroupInternal({
    envelope, laneKey, prefix, turnId, groupId, sequence, requireSequencePin
  }) {
    let closure;
    try {
      closure = this.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'v3_cursor' });
    } catch (error) {
      throw new Error('canonical cursor authority conflict', { cause: error });
    }
    const receipt = closure.receipt;
    const authoritativeTurn = receipt
      ? this.getTurn(receipt.authoritativeTurnId)
      : null;
    if (!receipt || !authoritativeTurn
      || turnId !== receipt.authoritativeTurnId
      || authoritativeTurn.characterId !== envelope.characterId
      || authoritativeTurn.deviceId !== envelope.deviceId
      || authoritativeTurn.laneKey !== laneKey
      || (requireSequencePin
        && Number(authoritativeTurn.inputVisibilitySequence) !== Number(sequence))) {
      throw new Error(`${prefix} canonical cursor authority conflict`);
    }
    return { closure, authoritativeTurn };
  }

  assertCanonicalV3CursorAuthorityInternal({ envelope, lane }) {
    const cursor = envelope.context.visibilityCursor;
    const laneKey = envelope.authority.laneKey;
    const established = this.hasCanonicalV3LanePinInternal(envelope.characterId, laneKey);
    const verify = prefix => {
      const turnId = cursor[`${prefix}TurnId`];
      const groupId = cursor[`${prefix}GroupId`];
      const sequence = Number(cursor[`${prefix}Sequence`]);
      if (sequence === 0) {
        if (turnId === null && groupId === null) return;
        if (established) throw new Error('canonical cursor legacy bootstrap disabled');
        this.assertLegacyV3CursorAnchorInternal({ envelope, laneKey, turnId });
        return;
      }
      this.assertCanonicalV3CursorGroupInternal({
        envelope, laneKey, prefix, turnId, groupId, sequence,
        requireSequencePin: established
      });
    };
    verify('nativeCompleted');
    verify('uiApplied');

    const laneNativeSequence = Number(lane?.nativeCompletedSequence || 0);
    const laneUiSequence = Number(lane?.uiAppliedSequence || 0);
    if (cursor.nativeCompletedSequence < laneNativeSequence
      || cursor.uiAppliedSequence < laneUiSequence
      || cursor.clearedThroughSequence < Number(lane?.clearedThroughSequence || 0)
      || (cursor.nativeCompletedSequence === laneNativeSequence
        && laneNativeSequence > 0
        && cursor.nativeCompletedGroupId !== lane.nativeCompletedGroupId)
      || (cursor.uiAppliedSequence === laneUiSequence
        && laneUiSequence > 0
        && cursor.uiAppliedGroupId !== lane.uiAppliedGroupId)) {
      throw new Error('canonical cursor authority conflict');
    }
    const priorWatermark = Math.max(
      Number(lane?.localSequence || 0),
      Number(cursor.nativeCompletedSequence),
      Number(cursor.uiAppliedSequence),
      Number(cursor.clearedThroughSequence)
    );
    if (Number(cursor.localSequence) !== priorWatermark + 1) {
      throw new Error('input visibility sequence authority conflict');
    }
    if (
      Number(cursor.clearEpoch) !== Number(lane?.clearEpoch || 0)
      || Number(cursor.clearedThroughSequence) !== Number(lane?.clearedThroughSequence || 0)
    ) {
      const error = new Error('CLEAR_EPOCH_SYNC_REQUIRED');
      error.code = 'CLEAR_EPOCH_SYNC_REQUIRED';
      throw error;
    }
    return { cursor, established };
  }

  readCanonicalCommitOutcomeInternal({
    lineageKey,
    expectedTurnId = null,
    expectedOrigin = null,
    expectedPayloadVersion = null,
    expectedCommitChecksum = null
  } = {}) {
    const lineage = this.getTurnAuthorityLineage(lineageKey);
    if (!lineage) return null;
    if (lineage.state === 'cancelled' && lineage.redactedAt != null) {
      this.assertRedactedLineageAuthorityInternal(lineage.lineageKey, {
        groupId: null, purpose: 'receipt_replay'
      });
      return { status: 'redacted', receipt: null, lineage };
    }
    if (lineage.state !== 'committed') return null;
    if (!lineage.committedGroupId) {
      throw new Error('canonical commit authority conflict');
    }
    try {
      const closure = this.assertVisibleGroupAuthorityInternal(lineage.committedGroupId, {
        purpose: 'receipt_replay',
        expectedLineageKey: lineage.lineageKey,
        expectedTurnId,
        expectedOrigin,
        expectedPayloadVersion,
        expectedCommitChecksum
      });
      return closure.status === 'redacted'
        ? { status: 'redacted', receipt: closure.receipt }
        : { status: 'already_committed', receipt: closure.receipt };
    } catch (error) {
      throw new Error('canonical commit authority conflict', { cause: error });
    }
  }

  rebuildProactiveMotiveAuthorityInternal({ envelope, effectiveAt, excludeGroupId = null }) {
    const at = canonicalEffectiveAtFromEnvelope(envelope);
    if (at === null || (effectiveAt !== undefined && Number(effectiveAt) !== at)) {
      throw new Error('proactive motive authority consideredAt conflict');
    }
    const agencySnapshot = this.readAgencyAuthoritySnapshotInternal({
      roleId: envelope.characterId,
      at
    });
    const lifeContext = proactiveMotiveSourceContext(this, envelope.characterId, at);
    const authority = buildProactiveMotiveAuthority({
      consideredAt: at,
      lifeContext,
      cognitiveState: this.getCognitiveState(envelope.characterId),
      consumedMotiveIds: this.listConsumedProactiveMotiveIdsInternal({
        roleId: envelope.characterId,
        excludeGroupId
      }),
      hardConstraints: agencySnapshot.constraints
    });
    return {
      annotationSnapshot: { proactiveMotiveAuthority: authority },
      agencySnapshot,
      effectiveAt: at
    };
  }

  rebuildPublicMomentAuthorityInternal({ envelope } = {}) {
    const consideredAt = canonicalEffectiveAtFromEnvelope(envelope);
    if (consideredAt === null) throw new Error('public moment authority consideredAt conflict');
    const episodes = this.listLifeEpisodes(envelope.characterId)
      .filter(episode => episode?.status === 'completed');
    const consumedEvidenceIds = new Set(
      this.listConsumedPublicMomentEvidenceIdsInternal({ roleId: envelope.characterId })
    );
    const candidates = [];
    for (const episode of episodes) {
      const marker = episode.payload?.publicMomentCandidate;
      if (!marker || typeof marker !== 'object' || Array.isArray(marker)
        || canonicalJson(Object.keys(marker).sort())
          !== canonicalJson(['summary', 'version', 'visibility'])
        || marker.version !== 'public-moment-candidate-v1'
        || marker.visibility !== 'public'
        || typeof marker.summary !== 'string'
        || marker.summary.trim() !== marker.summary
        || marker.summary.length < 1 || marker.summary.length > 280) {
        continue;
      }
      const occurredAt = episode.endAt;
      const expiresAt = occurredAt + 12 * 60 * 60_000;
      if (!Number.isSafeInteger(occurredAt) || !Number.isSafeInteger(expiresAt)
        || occurredAt > consideredAt || consideredAt >= expiresAt) continue;
      const evidenceId = `public_event_${contentHash({
        sourceEpisodeId: episode.episodeId,
        sourceChecksum: episode.checksum
      }).slice(0, 24)}`;
      if (consumedEvidenceIds.has(evidenceId)) continue;
      candidates.push({
        evidenceId,
        sourceEpisodeId: episode.episodeId,
        sourceChecksum: episode.checksum,
        occurredAt,
        expiresAt,
        summary: marker.summary
      });
    }
    candidates.sort((left, right) => right.occurredAt - left.occurredAt
      || left.evidenceId.localeCompare(right.evidenceId));
    candidates.splice(3);
    const agency = this.readAgencyAuthoritySnapshotInternal({
      roleId: envelope.characterId,
      at: consideredAt
    });
    const refs = [];
    for (const constraint of agency.constraints || []) {
      const channel = constraint?.scope?.channel;
      if (constraint?.status === 'active'
        && (channel === 'public_moment' || channel === 'all')
        && (constraint.kind === 'action' || constraint.kind === 'consent')
        && (constraint.rule === 'deny_public_moment' || constraint.rule === 'deny_all_public_actions')
        && typeof constraint.constraintId === 'string' && constraint.constraintId.trim()
        && Number.isSafeInteger(constraint.revision) && constraint.revision >= 0) {
        refs.push({ constraintId: constraint.constraintId.trim(), revision: constraint.revision });
      }
    }
    refs.sort((left, right) => left.constraintId.localeCompare(right.constraintId)
      || left.revision - right.revision);
    const authority = {
      version: 'public-moment-authority-v1',
      consideredAt,
      candidates,
      structuralSilence: refs.length
        ? { reasonCode: 'ACTIVE_PUBLIC_MOMENT_CONSTRAINT', constraintRefs: refs }
        : null
    };
    return { ...authority, checksum: contentHash(authority) };
  }

  rebuildMomentTargetAuthorityInternal({ envelope } = {}) {
    if (!envelope || envelope.protocolVersion !== 3
      || !['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(envelope.kind)) {
      throw new Error('moment target authority conflict');
    }
    const targetMoment = envelope.trigger?.context?.targetMoment;
    const targetComment = envelope.trigger?.context?.targetComment ?? null;
    if (!targetMoment || typeof targetMoment !== 'object' || Array.isArray(targetMoment)) {
      throw new Error('moment target authority conflict');
    }
    const authority = {
      version: 'moment-target-authority-v1',
      targetMoment,
      targetComment
    };
    return { ...authority, checksum: contentHash(authority) };
  }

  assertCanonicalProactiveAuthorityInternal({ authority, semantic, groupId = null }) {
    const envelope = parseJson(authority.turn_envelope_json, null);
    const proactive = authority.turn_kind === 'PROACTIVE_CHAT';
    const evidenceKey = Object.hasOwn(semantic || {}, 'proactiveMotiveEvidenceIds');
    if (!proactive) {
      if (evidenceKey || authority.payload_version === 'pc-visible-commit-v3') {
        throw new Error('canonical proactive motive authority conflict');
      }
      return null;
    }
    if (Number(envelope?.protocolVersion) !== 3) {
      if (evidenceKey || authority.payload_version === 'pc-visible-commit-v3'
        || !['pc-visible-commit-v1', 'pc-visible-commit-v2',
          'android-fallback-commit-v1', 'android-fallback-commit-v2']
          .includes(authority.payload_version)) {
        throw new Error('canonical proactive motive authority conflict');
      }
      return null;
    }
    if (Number(authority.result_authority_version) !== 1
      || authority.payload_version !== 'pc-visible-commit-v3'
      || !evidenceKey) {
      throw new Error('canonical proactive motive authority conflict');
    }
    const storedAnnotation = parseJson(authority.turn_annotation_snapshot_json, null);
    const motiveAuthority = storedAnnotation?.proactiveMotiveAuthority;
    if (!motiveAuthority || typeof motiveAuthority !== 'object' || Array.isArray(motiveAuthority)
      || Object.keys(motiveAuthority).sort().join(',')
        !== 'candidates,checksum,consideredAt,structuralSilence,version'
      || motiveAuthority.version !== 'proactive-motive-v1'
      || typeof motiveAuthority.checksum !== 'string'
      || !/^[a-f0-9]{64}$/.test(motiveAuthority.checksum)
      || !Number.isSafeInteger(motiveAuthority.consideredAt)
      || motiveAuthority.consideredAt < 0
      || motiveAuthority.consideredAt !== canonicalEffectiveAtFromEnvelope(envelope)
      || contentHash({
        version: motiveAuthority.version,
        consideredAt: motiveAuthority.consideredAt,
        candidates: motiveAuthority.candidates,
        structuralSilence: motiveAuthority.structuralSilence
      }) !== motiveAuthority.checksum) {
      throw new Error('canonical proactive motive authority conflict');
    }
    const evidence = semantic.proactiveMotiveEvidenceIds;
    if (!Array.isArray(evidence)
      || new Set(evidence).size !== evidence.length
      || evidence.some(id => typeof id !== 'string' || !id.trim())) {
      throw new Error('canonical proactive motive evidence authority conflict');
    }
    const candidates = motiveAuthority.candidates;
    if (!Array.isArray(candidates) || candidates.length > 6) {
      throw new Error('canonical proactive motive authority conflict');
    }
    const candidateKeySet = new Set([
      'expiresAt', 'motiveId', 'occurredAt', 'sourceChecksum', 'sourceId',
      'sourceRevision', 'sourceType', 'summary'
    ]);
    const sourceTypes = new Set([
      'current_life_episode', 'recent_life_episode', 'open_thread'
    ]);
    for (const candidate of candidates) {
      const candidateKeys = Object.keys(candidate || {});
      if (!candidate || candidateKeys.length !== candidateKeySet.size
        || candidateKeys.some(key => !candidateKeySet.has(key))
        || typeof candidate.motiveId !== 'string' || !candidate.motiveId.trim()
        || candidate.motiveId !== candidate.motiveId.trim()
        || typeof candidate.sourceId !== 'string' || !candidate.sourceId.trim()
        || candidate.sourceId !== candidate.sourceId.trim()
        || !sourceTypes.has(candidate.sourceType)
        || ((candidate.sourceType === 'current_life_episode' || candidate.sourceType === 'recent_life_episode')
          && candidate.sourceRevision !== null)
        || (candidate.sourceType === 'open_thread' &&
          (!Number.isSafeInteger(candidate.sourceRevision) || candidate.sourceRevision < 0))
        || typeof candidate.sourceChecksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(candidate.sourceChecksum)
        || !Number.isSafeInteger(candidate.occurredAt) || candidate.occurredAt < 0
        || !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt <= candidate.occurredAt
        || candidate.occurredAt > motiveAuthority.consideredAt
        || motiveAuthority.consideredAt >= candidate.expiresAt
        || typeof candidate.summary !== 'string' || !candidate.summary.trim()
        || candidate.summary !== candidate.summary.trim()
        || candidate.summary.length > 2048
        || motiveIdForSource(candidate) !== candidate.motiveId) {
        throw new Error('canonical proactive motive authority conflict');
      }
    }
    const sortedCandidates = [...candidates].sort(
      (left, right) => right.occurredAt - left.occurredAt
        || left.motiveId.localeCompare(right.motiveId)
    );
    if (canonicalJson(sortedCandidates) !== canonicalJson(candidates)
      || new Set(candidates.map(candidate => candidate.motiveId)).size !== candidates.length) {
      throw new Error('canonical proactive motive authority conflict');
    }
    const structuralSilence = motiveAuthority.structuralSilence;
    if (structuralSilence !== null && (!structuralSilence
      || typeof structuralSilence !== 'object'
      || Object.keys(structuralSilence).sort().join(',') !== 'constraintRefs,reasonCode'
      || structuralSilence.reasonCode !== 'ACTIVE_PRIVATE_CHAT_CONSTRAINT'
      || !Array.isArray(structuralSilence.constraintRefs)
      || structuralSilence.constraintRefs.length === 0
      || structuralSilence.constraintRefs.some(ref => !ref
        || Object.keys(ref).sort().join(',') !== 'constraintId,revision'
        || typeof ref.constraintId !== 'string' || !ref.constraintId.trim()
        || !Number.isSafeInteger(ref.revision) || ref.revision < 0))) {
      throw new Error('canonical proactive motive authority conflict');
    }
    if (structuralSilence) {
      const sortedRefs = [...structuralSilence.constraintRefs].sort(
        (left, right) => left.constraintId.localeCompare(right.constraintId)
          || left.revision - right.revision
      );
      if (new Set(structuralSilence.constraintRefs.map(ref => `${ref.constraintId}:${ref.revision}`)).size
          !== structuralSilence.constraintRefs.length
        || canonicalJson(sortedRefs) !== canonicalJson(structuralSilence.constraintRefs)) {
        throw new Error('canonical proactive motive authority conflict');
      }
    }
    const candidateIds = candidates.map(candidate => candidate.motiveId);
    const candidateSet = new Set(candidateIds);
    if (evidence.some(id => !candidateSet.has(id))) {
      throw new Error('canonical proactive motive evidence authority conflict');
    }
    const hasCanonicalOutput = (semantic.visibleItems || []).length > 0
      || (semantic.actions || []).length > 0;
    if (hasCanonicalOutput
      ? (evidence.length < 1 || evidence.length > 3)
      : evidence.length !== 0) {
      throw new Error('canonical proactive motive evidence disposition conflict');
    }
    if (evidence.some(id => !candidateSet.has(id))) {
      throw new Error('canonical proactive motive evidence order conflict');
    }
    const contextRevision = contentHash({
      agencySnapshotChecksum: authority.turn_agency_snapshot_checksum,
      proactiveMotiveAuthorityChecksum: motiveAuthority.checksum
    });
    const expectedFingerprint = generationFingerprint({
      roleId: authority.role_id,
      laneKey: authority.lane_key,
      inputVisibilitySequence: authority.input_visibility_sequence,
      visibleGroup: { items: semantic.visibleItems || [] },
      actionSet: semantic.actions || [],
      contextRevision
    });
    if (authority.generation_fingerprint !== expectedFingerprint
      || semantic.generationFingerprint !== expectedFingerprint) {
      throw new Error('canonical proactive motive generation fingerprint conflict');
    }
    return motiveAuthority;
  }

  assertCanonicalMomentAuthorityInternal({ authority, semantic } = {}) {
    const envelope = parseJson(authority?.turn_envelope_json, null);
    const kind = authority?.turn_kind;
    const isMoment = ['PROACTIVE_MOMENT', 'MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(kind);
    const hasV4Field = Object.hasOwn(semantic || {}, 'publicMomentEvidenceIds')
      || Object.hasOwn(semantic || {}, 'momentTargetAuthorityChecksum');
    if (!isMoment) {
      if (hasV4Field || authority?.payload_version === 'pc-visible-commit-v4') {
        throw new Error('canonical moment authority conflict');
      }
      return null;
    }
    if (Number(envelope?.protocolVersion) !== 3) {
      if (hasV4Field || authority?.payload_version === 'pc-visible-commit-v4') {
        throw new Error('canonical moment authority conflict');
      }
      return null;
    }
    if (authority?.payload_version !== 'pc-visible-commit-v4') {
      throw new Error('canonical moment authority conflict');
    }
    const annotation = parseJson(authority.turn_annotation_snapshot_json, null);
    if (kind === 'PROACTIVE_MOMENT') {
      const publicAuthority = annotation?.publicMomentAuthority;
      const ids = semantic.publicMomentEvidenceIds;
      if (Object.hasOwn(semantic, 'momentTargetAuthorityChecksum')
        || !publicAuthority || typeof publicAuthority !== 'object'
        || Array.isArray(publicAuthority)
        || Object.keys(publicAuthority).sort().join(',')
          !== 'candidates,checksum,consideredAt,structuralSilence,version'
        || publicAuthority.version !== 'public-moment-authority-v1'
        || typeof publicAuthority.checksum !== 'string'
        || !/^[a-f0-9]{64}$/.test(publicAuthority.checksum)
        || !Number.isSafeInteger(publicAuthority.consideredAt)
        || contentHash({
          version: publicAuthority.version,
          consideredAt: publicAuthority.consideredAt,
          candidates: publicAuthority.candidates,
          structuralSilence: publicAuthority.structuralSilence
        }) !== publicAuthority.checksum) {
        throw new Error('public moment authority conflict');
      }
      const pinned = new Set((publicAuthority?.candidates || []).map(candidate => candidate?.evidenceId));
      if (!publicAuthority || !Array.isArray(ids)
        || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !pinned.has(id))
        || ids.length > 3
        || ((semantic.visibleItems?.length || semantic.actions?.length) > 0
          ? ids.length < 1 || ids.length > 3
          : ids.length !== 0)) {
        throw new Error('public moment evidence authority conflict');
      }
      const contextRevision = contentHash({
        agencySnapshotChecksum: authority.turn_agency_snapshot_checksum,
        momentTargetAuthorityChecksum: publicAuthority.checksum
      });
      const expectedFingerprint = generationFingerprint({
        roleId: authority.role_id,
        laneKey: authority.lane_key,
        inputVisibilitySequence: authority.input_visibility_sequence,
        visibleGroup: { items: semantic.visibleItems || [] },
        actionSet: semantic.actions || [],
        contextRevision
      });
      if (authority.generation_fingerprint !== expectedFingerprint
        || semantic.generationFingerprint !== expectedFingerprint) {
        throw new Error('canonical moment generation fingerprint conflict');
      }
      return publicAuthority;
    }
    const targetAuthority = annotation?.momentTargetAuthority;
    if (Object.hasOwn(semantic, 'publicMomentEvidenceIds')
      || !targetAuthority || typeof targetAuthority !== 'object'
      || Array.isArray(targetAuthority)
      || Object.keys(targetAuthority).sort().join(',')
        !== 'checksum,targetComment,targetMoment,version') {
      throw new Error('moment target authority conflict');
    }
    if (typeof semantic.momentTargetAuthorityChecksum !== 'string'
      || semantic.momentTargetAuthorityChecksum !== targetAuthority.checksum
      || contentHash({
        version: targetAuthority.version,
        targetMoment: targetAuthority.targetMoment,
        targetComment: targetAuthority.targetComment
      }) !== targetAuthority.checksum) {
      throw new Error('moment target authority conflict');
    }
    const contextRevision = contentHash({
      agencySnapshotChecksum: authority.turn_agency_snapshot_checksum,
      momentTargetAuthorityChecksum: targetAuthority.checksum
    });
    const expectedFingerprint = generationFingerprint({
      roleId: authority.role_id,
      laneKey: authority.lane_key,
      inputVisibilitySequence: authority.input_visibility_sequence,
      visibleGroup: { items: semantic.visibleItems || [] },
      actionSet: semantic.actions || [],
      contextRevision
    });
    if (authority.generation_fingerprint !== expectedFingerprint
      || semantic.generationFingerprint !== expectedFingerprint) {
      throw new Error('canonical moment generation fingerprint conflict');
    }
    return targetAuthority;
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
    const inputClearEpoch = Number(input.inputClearEpoch ?? 0);
    const inputUserBatchId = String(input.inputUserBatchId || '');
    const agencySnapshotChecksum = String(input.agencySnapshotChecksum || '');
    const retry = envelope.context?.retry || null;
    const rootSourceId = retry?.canonicalMessageId
      || envelope.message?.messageId
      || envelope.trigger?.triggerId
      || '';
    const derivedRolloutKey = String(envelope.kind || '');
    const derivedLaneKey = envelope.protocolVersion === 3
      ? authorityLaneKeyForEnvelope(envelope)
      : laneKeyForEnvelope(envelope);
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
    if (envelope.protocolVersion === 3
      && (inputVisibilitySequence !== envelope.context.visibilityCursor.localSequence
        || inputClearEpoch !== envelope.context.visibilityCursor.clearEpoch)) {
      throw new Error('canonical cursor input authority conflict');
    }
    if (!CANONICAL_RESULT_TURN_KINDS.has(rolloutKey)
      || !laneKey || !rootSourceId || !inputUserBatchId
      || !Number.isInteger(expectedRolloutRevision) || expectedRolloutRevision < 0
      || !Number.isInteger(expectedLaneRevision) || expectedLaneRevision < 0
      || !Number.isSafeInteger(inputVisibilitySequence) || inputVisibilitySequence < 0
      || !Number.isSafeInteger(inputClearEpoch) || inputClearEpoch < 0
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
          || Number(exactTurn.inputClearEpoch) !== inputClearEpoch
          || (envelope.protocolVersion !== 3
            && Number(exactTurn.laneRevision) !== expectedLaneRevision + 1)
          || Number(exactTurn.rolloutRevision) !== expectedRolloutRevision
          || exactTurn.authoritativeReleaseId !== String(input.authoritativeReleaseId || '')
          || String(exactTurn.comparisonReleaseId || '') !== String(input.comparisonReleaseId || '')
          || exactTurn.comparisonMode
            !== comparisonContractForDirection(input.comparisonDirection).comparisonMode
          || exactTurn.agencySnapshotChecksum !== agencySnapshotChecksum
          || contentHash(exactTurn.annotationSnapshot || {})
            !== contentHash(input.annotationSnapshot || {})) {
          throw new Error('canonical turn authority conflict');
        }
        const outcome = this.readCanonicalCommitOutcomeInternal({
          lineageKey
        });
        return outcome || { status: 'created', turn: exactTurn };
      }

      let validatedRetry = null;
      let freshProactiveAgencySnapshot = null;
      if (!retry && envelope.protocolVersion === 3 && envelope.kind === 'PROACTIVE_MOMENT') {
        const expectedAuthority = this.rebuildPublicMomentAuthorityInternal({ envelope });
        if (canonicalJson(input.annotationSnapshot?.publicMomentAuthority || null)
          !== canonicalJson(expectedAuthority)) {
          throw new Error('public moment authority conflict');
        }
      }
      if (!retry && envelope.protocolVersion === 3
        && ['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(envelope.kind)) {
        const expectedTargetAuthority = this.rebuildMomentTargetAuthorityInternal({ envelope });
        if (canonicalJson(input.annotationSnapshot?.momentTargetAuthority || null)
          !== canonicalJson(expectedTargetAuthority)) {
          throw new Error('moment target authority conflict');
        }
      }
      if (!retry && envelope.protocolVersion === 3 && envelope.kind === 'PROACTIVE_CHAT') {
        const rebuilt = this.rebuildProactiveMotiveAuthorityInternal({ envelope });
        if (canonicalJson(input.annotationSnapshot?.proactiveMotiveAuthority || null)
          !== canonicalJson(rebuilt.annotationSnapshot.proactiveMotiveAuthority)) {
          throw new Error('proactive motive authority conflict');
        }
        freshProactiveAgencySnapshot = rebuilt.agencySnapshot;
      }
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
        const parentRedacted = parent.authorityRedactedAt != null;
        if (parentRedacted) {
          this.assertCanonicalTurnInputAuthorityInternal({
            storedTurn: parent, incomingEnvelope: envelope, mode: 'redacted_replay'
          });
        } else if (!parentMessage
          || parent.sourceMessageId !== retry.canonicalMessageId
          || envelope.message?.messageId !== retry.canonicalMessageId
          || envelope.message?.content !== parentMessage.content
          || Number(envelope.message?.sentAt) !== Number(parentMessage.sentAt)
          || contentHash(canonicalBatch(envelope)) !== contentHash(canonicalBatch(parentEnvelope))) {
          throw new Error('retry canonical batch conflict');
        }
        const inheritedComparisonDirection = comparisonContractForMode(
          parent.comparisonMode
        ).comparisonDirection;
        if (Number(input.expectedRolloutRevision) !== parent.rolloutRevision
          || parent.rolloutKey !== rolloutKey
          || String(input.authoritativeReleaseId || '') !== String(parent.authoritativeReleaseId || '')
          || String(input.comparisonReleaseId || '') !== String(parent.comparisonReleaseId || '')
          || String(input.comparisonDirection || '') !== String(inheritedComparisonDirection || '')
          || inputUserBatchId !== parent.inputUserBatchId
          || contentHash(input.annotationSnapshot || {})
            !== contentHash(parent.annotationSnapshot || {})) {
          throw new Error('canonical retry immutable authority conflict');
        }
        const lineage = this.getTurnAuthorityLineage(parent.authorityLineageKey);
        if (!lineage) throw new Error('canonical retry lineage invariant conflict');
        const expectedHistoricalRetryClaim = Number(parent.lineageRevisionAtCreation) + 1;
        const terminalOutcome = lineage.state === 'committed'
          || (lineage.state === 'cancelled' && lineage.redactedAt != null);
        if (terminalOutcome) {
          if (envelope.protocolVersion === 3
            && Number(envelope.authority.claimedLineageRevision) !== expectedHistoricalRetryClaim) {
            throw new Error('authority claim revision conflict');
          }
          return this.readCanonicalCommitOutcomeInternal({ lineageKey: lineage.lineageKey });
        }
        if (envelope.protocolVersion === 3
          && Number(envelope.authority.claimedLineageRevision) !== Number(lineage.revision) + 1) {
          throw new Error('authority claim revision conflict');
        }
        if (envelope.protocolVersion === 3) {
          const failure = parseJson(parent.errorJson, {});
          if (parent.state !== 'failed' || failure.retryAllowed !== true) {
            throw new Error('canonical retry permission conflict');
          }
        }
        validatedRetry = { parent, lineage };
      } else if (envelope.protocolVersion === 3
        && Number(envelope.authority.claimedLineageRevision) !== 1) {
        throw new Error('authority claim revision conflict');
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
      const currentTurn = lane?.generatingTurnId ? this.getTurn(lane.generatingTurnId) : null;
      const currentEnvelope = currentTurn ? parseJson(currentTurn.envelopeJson, {}) : null;
      const currentCommitted = Boolean(currentTurn)
        && (Boolean(currentTurn.replyJson)
          || ['committed', 'completed', 'delivered'].includes(currentTurn.state));
      const currentIsTask17V3 = Boolean(currentTurn)
        && Number(currentTurn.protocolVersion) === 3
        && Number(currentTurn.resultAuthorityVersion) === 1;
      const task17LanePair = currentIsTask17V3 && Boolean(currentEnvelope?.kind) && (
        (envelope.kind === 'PROACTIVE_CHAT'
          && ['DIRECT_REPLY', 'PROACTIVE_CHAT'].includes(currentEnvelope.kind))
        || (envelope.kind === 'DIRECT_REPLY' && currentEnvelope.kind === 'PROACTIVE_CHAT')
      ) && !currentCommitted;
      const task17LaneAdmission = !retry
        && Number(envelope.protocolVersion) === 3
        && ['DIRECT_REPLY', 'PROACTIVE_CHAT'].includes(envelope.kind)
        && task17LanePair;
      if (task17LaneAdmission) {
        const laneDecision = decideLaneAdmission({
        lane: {
          ...lane,
          generatingTurn: currentTurn ? {
            turnId: currentTurn.turnId,
            kind: currentEnvelope?.kind,
            state: currentTurn.state,
            committed: Boolean(currentTurn.replyJson)
              || ['committed', 'completed', 'delivered'].includes(currentTurn.state)
          } : null
        },
        incoming: {
          turnId: envelope.turnId,
          kind: envelope.kind,
          state: 'queued',
          committed: false
        },
        now: now()
        });
        if (!laneDecision.admitted) {
          if (envelope.kind === 'PROACTIVE_CHAT') throw new InteractionLaneBusyError();
          throw new Error(`interaction lane busy: ${laneDecision.reasonCode}`);
        }
        if (laneDecision.requeueTurnId) {
          const requeue = this.getTurn(laneDecision.requeueTurnId);
          if (requeue?.resultAuthorityVersion === 1) {
            throw new Error('canonical turn API required for lane requeue');
          }
        }
        if (laneDecision.supersededTurnId) {
          const superseded = this.getTurn(laneDecision.supersededTurnId);
          if (!superseded || superseded.resultAuthorityVersion !== 1) {
            throw new Error('canonical lane supersede authority conflict');
          }
          const supersededLineage = this.getTurnAuthorityLineage(superseded.authorityLineageKey);
          const cancelled = this.cancelCanonicalTurnRowsInternal({
            turnId: superseded.turnId,
            authorityLineageKey: superseded.authorityLineageKey,
            expectedTurnRevision: superseded.turnRevision,
            expectedLineageRevision: supersededLineage?.revision,
            reasonCode: laneDecision.reasonCode,
            supersededByTurnId: envelope.turnId,
            timestamp: now()
          });
          this.settleCanaryFailureInternal({
            rolloutKey: cancelled.turn.rolloutKey,
            canaryEpoch: cancelled.turn.canaryEpoch,
            canarySlot: cancelled.turn.canarySlot,
            reasonCode: 'CANARY_SOURCE_SUPERSEDED',
            now: now()
          });
        }
      }
      const v3CursorAuthority = envelope.protocolVersion === 3
        ? this.assertCanonicalV3CursorAuthorityInternal({ envelope, lane })
        : null;
      if (envelope.protocolVersion !== 3
        && inputClearEpoch !== Number(lane?.clearEpoch || 0)) {
        throw new Error('clear epoch authority conflict');
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
        const rollout = mapCognitionRollout(rolloutRow);
        const pair = resolvePipelinePair(rollout);
        const projectionIsValid = pair.candidatePhase === 'shadow'
          ? rollout.currentMode === 'shadow'
          : pair.candidatePhase === 'canary'
            ? rollout.currentMode === 'active' && rollout.rolloutPhase === 'canary'
            : pair.candidatePhase === 'rolled_back'
              ? rollout.currentMode !== 'active'
              : rollout.currentMode !== 'shadow'
                && !(rollout.currentMode === 'active' && rollout.rolloutPhase === 'canary');
        if (!projectionIsValid) {
          throw new RolloutRevisionConflictError('rollout phase projection conflict');
        }
        if (String(input.authoritativeReleaseId || '') !== pair.visibleReleaseId
          || String(input.comparisonReleaseId || '') !== String(pair.comparisonReleaseId || '')
          || String(input.comparisonDirection || '') !== String(pair.comparisonDirection || '')) {
          throw new RolloutRevisionConflictError('rollout release pair conflict');
        }
        const authoritativeRelease = this.getPipelineRelease(pair.visibleReleaseId);
        const comparisonRelease = pair.comparisonReleaseId
          ? this.getPipelineRelease(pair.comparisonReleaseId)
          : null;
        if (!authoritativeRelease || (pair.comparisonReleaseId && !comparisonRelease)) {
          throw new Error('canonical release authority is unavailable');
        }
        const existingLineage = this.getTurnAuthorityLineage(lineageKey);
        if (existingLineage) {
          if (envelope.protocolVersion === 3) {
            throw new Error('authority claim revision conflict');
          }
          if (existingLineage.state === 'committed') {
            return this.readCanonicalCommitOutcomeInternal({
              lineageKey,
              expectedTurnId: existingLineage.latestTurnId
            });
          }
          throw new Error('canonical lineage already has an open turn');
        }
        const reservesCanaryComparison = pair.candidatePhase === 'canary'
          && pair.comparisonReleaseId !== null;
        const comparisonMode = comparisonContractForDirection(
          pair.comparisonDirection
        ).comparisonMode;
        pinned = {
          pipelineMode: rollout.currentMode,
          presetVersion: authoritativeRelease.presetVersion,
          rolloutRevision: Number(rolloutRow.revision),
          rolloutEvidenceEpoch: Number(rolloutRow.evidence_epoch),
          pipelineChecksum: authoritativeRelease.releaseChecksum,
          shadowEpoch: pair.candidatePhase === 'shadow' ? Number(rolloutRow.shadow_epoch) : null,
          canaryEpoch: pair.candidatePhase === 'canary' ? Number(rolloutRow.canary_epoch) : null,
          canarySlot: reservesCanaryComparison
            ? Number(rolloutRow.canary_started_count) + 1
            : null,
          comparisonMode,
          authoritativeReleaseId: authoritativeRelease.releaseId,
          comparisonReleaseId: comparisonRelease?.releaseId || null,
          authoritativePipelineChecksum: authoritativeRelease.releaseChecksum,
          comparisonPipelineChecksum: comparisonRelease?.releaseChecksum || null
        };
        if (reservesCanaryComparison) {
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
      const agencySnapshot = freshProactiveAgencySnapshot
        || this.readAgencyAuthoritySnapshotInternal({
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
      if (this.userVersion() >= 13) {
        this.db.prepare(
          'UPDATE turns SET input_clear_epoch = ? WHERE turn_id = ?'
        ).run(inputClearEpoch, envelope.turnId);
      }

      if (!retry && envelope.message) {
        const initialBatch = resolveCurrentUserBatch(envelope);
        for (const message of initialBatch?.messages || [envelope.message]) {
          this.putMessageInternal({
            ...message,
            turnId: envelope.turnId,
            characterId: envelope.characterId,
            origin: 'phone',
            deviceId: envelope.deviceId,
            deviceSeq: message.messageId === envelope.message.messageId
              ? envelope.deviceSeq : null
          });
        }
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
        if (envelope.protocolVersion === 3) {
          this.db.prepare(`
            UPDATE cloud_deliveries
            SET state = 'superseded',
                updated_at = ?
            WHERE turn_id = ? AND authority_group_id IS NULL
              AND state IN ('waiting', 'pending')
              AND EXISTS (
                SELECT 1 FROM turns parent
                WHERE parent.turn_id = cloud_deliveries.turn_id
                  AND parent.result_authority_version = 1
                  AND parent.state = 'failed'
                  AND json_extract(parent.envelope_json, '$.protocolVersion') = 3
              )
          `).run(timestamp, retryOfTurnId);
        }
      } else {
        if (this.userVersion() >= 13) {
          this.db.prepare(`
            INSERT INTO turn_authority_lineages(
              lineage_key, role_id, lane_key, root_source_id, latest_turn_id,
              revision, state, committed_group_id, created_at, updated_at,
              attempt_count, attempt_commitment
            ) VALUES (?, ?, ?, ?, ?, 1, 'open', NULL, ?, ?, 0, '')
          `).run(
            lineageKey, envelope.characterId, laneKey, rootSourceId,
            envelope.turnId, timestamp, timestamp
          );
        } else {
          this.db.prepare(`
            INSERT INTO turn_authority_lineages(
              lineage_key, role_id, lane_key, root_source_id, latest_turn_id,
              revision, state, committed_group_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, 'open', NULL, ?, ?)
          `).run(
            lineageKey, envelope.characterId, laneKey, rootSourceId,
            envelope.turnId, timestamp, timestamp
          );
        }
      }
      if (this.userVersion() >= 13) this.refreshLineageAttemptCommitmentInternal(lineageKey);
      this.claimInteractionLaneInternal({
        roleId: envelope.characterId,
        laneKey,
        expectedRevision: expectedLaneRevision,
        generatingTurnId: envelope.turnId,
        latestUserBatchId: inputUserBatchId,
        nativeCompletedGroupId: v3CursorAuthority?.cursor.nativeCompletedGroupId ?? undefined,
        nativeCompletedSequence: v3CursorAuthority?.cursor.nativeCompletedSequence ?? undefined,
        uiAppliedGroupId: v3CursorAuthority?.cursor.uiAppliedGroupId ?? undefined,
        uiAppliedSequence: v3CursorAuthority?.cursor.uiAppliedSequence ?? undefined,
        localSequence: inputVisibilitySequence,
        clearEpoch: v3CursorAuthority?.cursor.clearEpoch ?? undefined,
        clearedThroughSequence: v3CursorAuthority?.cursor.clearedThroughSequence ?? undefined,
        now: timestamp
      });
      const turn = this.getTurn(envelope.turnId);
      this.appendSync('turn', envelope.turnId, 'insert', turn);
      return { status: 'created', turn, agencySnapshot };
    });
  }

  refreshLineageAttemptCommitmentInternal(lineageKey) {
    const attempts = this.db.prepare(`
      SELECT t.lineage_revision_at_creation, t.turn_id,
             t.rollout_key AS turn_kind,
             t.retry_of_turn_id, t.input_user_batch_id, t.envelope_checksum,
             b.tombstone_commitment AS batch_tombstone_commitment
      FROM turns t
      LEFT JOIN current_user_batches b ON b.turn_id = t.turn_id
      WHERE t.authority_lineage_key = ? AND t.result_authority_version = 1
      ORDER BY t.lineage_revision_at_creation
    `).all(String(lineageKey));
    const commitment = authorityLineageAttemptsCommitment({
      lineageKey, attemptRows: attempts
    });
    const updated = this.db.prepare(`
      UPDATE turn_authority_lineages
      SET attempt_count = ?, attempt_commitment = ?
      WHERE lineage_key = ?
    `).run(commitment.attemptCount, commitment.commitment, String(lineageKey));
    if (Number(updated.changes) !== 1) throw new Error('lineage attempt commitment conflict');
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
    const triggerContext = envelope.trigger?.context || {};
    const triggerInput = triggerContext.input || triggerContext;
    const inputSnapshot = (candidate, idKeys) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
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
      const idKey = `${safeNamespace}Id`;
      const targetKey = safeNamespace === 'moment' ? 'targetMoment' : 'targetComment';
      const snapshot = inputSnapshot(triggerInput?.[targetKey], [idKey]);
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
      const scene = context.scene || envelope.trigger?.context?.scene || null;
      const relationship = context.relationship
        || context.relationshipState
        || scene?.relationshipStage
        || envelope.featureContext?.relationship
        || null;
      if (!relationship) throw new Error('canonical relationship target not found');
      if (!scene
        || !Object.hasOwn(scene, 'stagePersonaRevision')
        || typeof scene.stagePersonaRevision !== 'number'
        || !Number.isSafeInteger(scene.stagePersonaRevision)
        || scene.stagePersonaRevision < 0) {
        throw new Error('canonical relationship target revision conflict');
      }
      const stagePersonaRevision = scene.stagePersonaRevision;
      const snapshot = {
        relationshipStage: structuredClone(relationship),
        stagePersonaRevision
      };
      return {
        targetKey: `relationship:${turn.characterId}`,
        targetRevision: `sha256:${contentHash(snapshot)}`,
        authoritySource: 'input_snapshot',
        canonicalTarget: snapshot
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
    if (['moment_like', 'moment_comment', 'moment_reply'].includes(kind)) {
      assertCanonicalMomentActionPayload(kind, payload);
    }
    if (kind === 'relationship_transition') {
      assertCanonicalRelationshipActionPayload(payload);
    }
    const exactPayloadTarget = (key, legacyKey) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.hasOwn(payload, legacyKey)
        || !Object.hasOwn(payload, key)
        || typeof payload[key] !== 'string'
        || payload[key].length === 0) {
        throw new Error('canonical action target identity conflict');
      }
      return payload[key];
    };
    const targetId = namespace === 'lineage_create'
      ? `${turn.authorityLineageKey}:${kind}`
      : namespace === 'payment'
        ? payload.messageId
        : namespace === 'moment'
          ? payload.momentId
          : namespace === 'comment'
            ? exactPayloadTarget('replyToCommentId', 'commentId')
            : namespace === 'role_plan'
              ? exactPayloadTarget('planId', 'rolePlanId')
              : namespace === 'life_episode'
                ? exactPayloadTarget('targetEpisodeId', 'episodeId')
                : namespace === 'relationship'
                  ? turn.characterId
                  : null;
    if (!targetId) throw new Error(`canonical ${namespace} target not found`);
    const resolved = this.resolveCanonicalTargetRefInternal({
      turn,
      namespace,
      targetId
    });
    if (kind === 'relationship_transition'
      && resolved.canonicalTarget.stagePersonaRevision !== payload.expectedSceneRevision) {
      throw new Error('canonical relationship target revision conflict');
    }
    return resolved;
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

  loadCanonicalBridgeResultInternal(turnId) {
    try {
      const lookupTurn = this.getTurn(String(turnId || ''));
      if (!lookupTurn
        || Number(lookupTurn.resultAuthorityVersion || 0) !== 1
        || !lookupTurn.authorityLineageKey) {
        throw new Error('canonical bridge lookup turn conflict');
      }
      const lineage = this.getTurnAuthorityLineage(lookupTurn.authorityLineageKey);
      if (!lineage || lineage.state !== 'committed' || !lineage.committedGroupId) {
        throw new Error('canonical bridge lineage conflict');
      }
      const closure = this.assertVisibleGroupAuthorityInternal(lineage.committedGroupId, {
        purpose: 'bridge_result',
        expectedLineageKey: lineage.lineageKey
      });
      const receipt = closure.receipt;
      if (!receipt) throw new Error('canonical bridge receipt conflict');
      if (closure.status === 'redacted') {
        return {
          status: 'redacted',
          deliverable: false,
          turnId: receipt.authoritativeTurnId,
          authorityLineageKey: receipt.authorityLineageKey,
          visibleGroupId: receipt.visibleGroupId,
          commitChecksum: receipt.commitChecksum
        };
      }
      const authority = this.db.prepare(`
        SELECT
          r.lineage_key, r.group_id, r.authoritative_turn_id,
          r.authority_origin, r.commit_payload_version, r.commit_checksum,
          r.turn_revision_after, r.lineage_revision_after, r.lane_revision_after,
          g.role_id, g.lane_key, g.authoritative_release_id,
          g.generation_fingerprint, g.reply_checksum,
          t.input_visibility_sequence, t.input_clear_epoch,
          t.authority_lineage_key AS turn_lineage_key,
          t.authoritative_release_id AS turn_release_id,
          l.committed_group_id, l.latest_turn_id,
          p.release_id,
          il.role_id AS lane_role_id, il.lane_key AS joined_lane_key,
          m.semantic_checksum
        FROM visible_commit_receipts r
        JOIN visible_result_groups g
          ON g.group_id = r.group_id
         AND g.lineage_key = r.lineage_key
         AND g.authoritative_turn_id = r.authoritative_turn_id
        JOIN visible_result_manifests m ON m.group_id = g.group_id
        JOIN turn_authority_lineages l ON l.lineage_key = r.lineage_key
        JOIN turns t ON t.turn_id = r.authoritative_turn_id
        JOIN pipeline_releases p ON p.release_id = g.authoritative_release_id
        JOIN interaction_lanes il ON il.role_id = g.role_id AND il.lane_key = g.lane_key
        WHERE r.lineage_key = ? AND r.group_id = ?
      `).get(lineage.lineageKey, lineage.committedGroupId);
      if (!authority
        || authority.turn_lineage_key !== authority.lineage_key
        || authority.turn_release_id !== authority.authoritative_release_id
        || authority.release_id !== authority.authoritative_release_id
        || authority.committed_group_id !== authority.group_id
        || authority.latest_turn_id !== authority.authoritative_turn_id
        || authority.lane_role_id !== authority.role_id
        || authority.joined_lane_key !== authority.lane_key
        || authority.semantic_checksum !== authority.commit_checksum
        || Number(authority.turn_revision_after) !== Number(receipt.turnRevisionAfter)
        || Number(authority.lineage_revision_after) !== Number(receipt.lineageRevisionAfter)
        || Number(authority.lane_revision_after) !== Number(receipt.laneRevisionAfter)) {
        throw new Error('canonical bridge join conflict');
      }
      const storedItems = this.visibleItemsForGroup(authority.group_id);
      const storedActions = this.actionsForGroup(authority.group_id);
      if (contentHash({
        items: storedItems.map(item => item.item),
        actions: storedActions.map(action => ({
          kind: action.kind,
          targetKey: action.targetKey,
          targetRevision: action.targetRevision,
          payload: action.action
        }))
      }) !== authority.reply_checksum) {
        throw new Error('canonical bridge reply checksum conflict');
      }
      const replyParts = storedItems.map(item => ({
        ...item.item,
        messageId: item.messageId,
        ordinal: item.ordinal,
        itemChecksum: item.itemChecksum
      }));
      const actions = storedActions.map(action => ({
        actionId: action.actionId,
        ordinal: action.ordinal,
        actionChecksum: action.actionChecksum,
        kind: action.kind,
        targetKey: action.targetKey,
        targetRevision: action.targetRevision,
        payload: action.action
      }));
      return {
        protocolVersion: 3,
        turnId: authority.authoritative_turn_id,
        roleId: authority.role_id,
        authorityOrigin: authority.authority_origin,
        authorityLineageKey: authority.lineage_key,
        visibleGroupId: authority.group_id,
        lineageRevision: Number(receipt.lineageRevisionAfter),
        turnRevision: Number(receipt.turnRevisionAfter),
        laneKey: authority.lane_key,
        laneRevision: Number(receipt.laneRevisionAfter),
        inputVisibilitySequence: Number(authority.input_visibility_sequence),
        inputClearEpoch: Number(authority.input_clear_epoch),
        generationFingerprint: authority.generation_fingerprint,
        releaseId: authority.authoritative_release_id,
        commitPayloadVersion: authority.commit_payload_version,
        commitChecksum: authority.commit_checksum,
        terminalDisposition: closure.terminalDisposition,
        replyParts,
        actions
      };
    } catch (error) {
      if (error?.message === 'canonical bridge result authority conflict') throw error;
      throw new Error('canonical bridge result authority conflict', { cause: error });
    }
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
    const validated = this.assertVisibleGroupAuthorityInternal(groupId, { purpose: 'delivery' });
    const authority = this.db.prepare(`
      SELECT
        d.authority_group_id, d.peer_id, d.recovery_ack_seq,
        d.authority_commit_checksum, r.lineage_key, r.authoritative_turn_id,
        r.authority_origin, r.commit_payload_version, r.commit_checksum,
        g.role_id, g.lane_key, g.authoritative_release_id,
        g.generation_fingerprint, t.input_visibility_sequence,
        t.input_clear_epoch
      FROM cloud_deliveries d
      JOIN visible_commit_receipts r
        ON r.group_id = d.authority_group_id
       AND r.commit_checksum = d.authority_commit_checksum
      JOIN visible_result_groups g
        ON g.group_id = r.group_id
       AND g.lineage_key = r.lineage_key
       AND g.authoritative_turn_id = r.authoritative_turn_id
      JOIN turns t ON t.turn_id = r.authoritative_turn_id
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
      terminalDisposition: validated.terminalDisposition,
      inputVisibilitySequence: authority.input_visibility_sequence == null
        ? null
        : Number(authority.input_visibility_sequence),
      inputClearEpoch: Number(authority.input_clear_epoch || 0),
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
    if (!['waiting', 'pending', 'mailboxed', 'confirmed'].includes(existing.state)) {
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

  reserveCloudDeliveryRelayInternal({
    turnId, peerId, authorityGroupId = null, checksum, relayMessageId, attemptAt = now()
  }) {
    if (typeof turnId !== 'string' || !turnId
      || typeof peerId !== 'string' || !peerId
      || typeof checksum !== 'string' || !checksum
      || typeof attemptAt !== 'number' || !Number.isSafeInteger(attemptAt) || attemptAt <= 0) {
      throw new Error('cloud delivery relay reservation conflict');
    }
    return this.withImmediateTransaction(() => {
      const row = authorityGroupId
        ? this.db.prepare(`SELECT * FROM cloud_deliveries
            WHERE turn_id = ? AND peer_id = ? AND authority_group_id = ?`).get(
          turnId, peerId, String(authorityGroupId))
        : this.db.prepare(`SELECT * FROM cloud_deliveries
            WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL`).get(
          turnId, peerId);
      if (!row || !['pending', 'redaction_pending'].includes(row.state)) {
        throw new Error('cloud delivery relay reservation conflict');
      }
      const expectedRelayMessageId = stableId(
        'relay_pc',
        authorityGroupId
          ? `${authorityGroupId}:${peerId}:${row.authority_commit_checksum}`
          : `${turnId}:${peerId}:${checksum}`
      );
      if (relayMessageId != null && relayMessageId !== expectedRelayMessageId) {
        throw new Error('cloud delivery relay identity conflict');
      }
      if (row.state === 'redaction_pending') {
        if (row.relay_message_id !== expectedRelayMessageId) {
          throw new Error('cloud delivery relay identity conflict');
        }
        return {
          ...mapCloudDelivery(row),
          relayMessageId: expectedRelayMessageId
        };
      }
      if (row.checksum !== checksum) {
        throw new Error('cloud delivery relay reservation conflict');
      }
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET relay_message_id = COALESCE(relay_message_id, ?), updated_at = ?
        WHERE turn_id = ? AND peer_id = ?
          AND ${authorityGroupId ? 'authority_group_id = ?' : 'authority_group_id IS NULL'}
          AND state = 'pending' AND checksum = ?
          AND (relay_message_id IS NULL OR relay_message_id = ?)
      `).run(
        expectedRelayMessageId, attemptAt, turnId, peerId,
        ...(authorityGroupId ? [String(authorityGroupId)] : []), checksum,
        expectedRelayMessageId
      );
      if (Number(updated.changes) !== 1) {
        throw new Error('cloud delivery relay reservation CAS conflict');
      }
      return {
        ...mapCloudDelivery(this.db.prepare(`
          SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
        `).get(turnId, peerId)),
        relayMessageId: expectedRelayMessageId
      };
    });
  }

  markAuthorityCloudDeliveryAttempt(groupId, peerId) {
    const result = this.db.prepare(`
      UPDATE cloud_deliveries SET attempts = attempts + 1, updated_at = ?
      WHERE authority_group_id = ? AND peer_id = ? AND state = 'pending'
    `).run(now(), String(groupId || ''), String(peerId || ''));
    if (Number(result.changes) !== 1) throw new Error('pending canonical cloud delivery not found');
  }

  markAuthorityCloudDeliveryMailboxed(groupId, peerId, checksum, relayMessageId) {
    const timestamp = now();
    const relayId = String(relayMessageId || '');
    if (!relayId) throw new Error('canonical cloud delivery relay message id is required');
    const result = this.db.prepare(`
      UPDATE cloud_deliveries
      SET state = 'mailboxed', relay_message_id = ?, delivered_at = ?, updated_at = ?
      WHERE authority_group_id = ? AND peer_id = ?
        AND state = 'pending' AND checksum = ?
    `).run(relayId, timestamp, timestamp, String(groupId || ''), String(peerId || ''), String(checksum || ''));
    if (Number(result.changes) !== 1) {
      throw new Error('canonical cloud delivery acknowledgement conflict');
    }
    return mapCloudDelivery(this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE authority_group_id = ? AND peer_id = ?
    `).get(String(groupId), String(peerId)));
  }

  importExternalVisibleReceiptInternal(receipt) {
    const recordConflictDiagnostic = error => {
      const semantic = receipt?.semantic;
      const lineageKey = typeof semantic?.authorityLineageKey === 'string'
        ? semantic.authorityLineageKey : null;
      if (!lineageKey || !this.getTurnAuthorityLineage(lineageKey)) return;
      const turnId = typeof semantic?.authoritativeTurnId === 'string'
        ? semantic.authoritativeTurnId : lineageKey;
      this.transaction(() => {
        const existing = this.db.prepare(`
          SELECT 1 FROM diagnostics
          WHERE turn_id = ? AND stage = 'external_authority_conflict'
          LIMIT 1
        `).get(turnId);
        if (existing) return;
        this.putDiagnostic({
          turnId,
          stage: 'external_authority_conflict',
          level: 'error',
          detail: {
            authorityLineageKey: lineageKey,
            visibleGroupId: typeof semantic?.visibleGroupId === 'string'
              ? semantic.visibleGroupId : null,
            commitChecksum: typeof receipt?.commitChecksum === 'string'
              ? receipt.commitChecksum : null,
            reason: error?.message || 'external authority conflict'
          }
        });
      });
    };
    let normalized;
    try {
      normalized = normalizeExternalVisibleReceipt(receipt);
    } catch (error) {
      recordConflictDiagnostic(error);
      throw error;
    }
    const existingLineage = this.getTurnAuthorityLineage(normalized.lineageKey);
    let retryParent = null;
    if (existingLineage) {
      const existingReceipt = this.getVisibleCommitReceipt(normalized.lineageKey);
      if (existingReceipt?.commitChecksum === normalized.commitChecksum
        && existingReceipt.visibleGroupId === normalized.groupId
        && existingReceipt.authoritativeTurnId === normalized.turnId
        && existingReceipt.authorityOrigin === 'android_fallback') {
        const existingTurn = this.getTurn(normalized.turnId);
        if (!existingTurn || existingTurn.retryOfTurnId !== normalized.retryOfTurnId) {
          const error = new Error('external authority retry parent conflict');
          recordConflictDiagnostic(error);
          throw error;
        }
        return {
          authorityOrigin: 'android_fallback',
          authorityLineageKey: normalized.lineageKey,
          authoritativeTurnId: normalized.turnId,
          visibleGroupId: normalized.groupId,
          commitChecksum: normalized.commitChecksum,
          exactReplay: true
        };
      }
      if (normalized.retryOfTurnId === null) {
        recordConflictDiagnostic(new Error('cross-device authority conflict'));
        throw new Error('cross-device authority conflict');
      }
      retryParent = this.getTurn(normalized.retryOfTurnId);
      const parentFailure = parseJson(retryParent?.errorJson, null);
      if (!retryParent
        || retryParent.authorityLineageKey !== normalized.lineageKey
        || retryParent.state !== 'failed'
        || existingLineage.state !== 'open'
        || existingLineage.latestTurnId !== retryParent.turnId
        || existingLineage.committedGroupId != null
        || existingLineage.redactedAt != null
        || Number(existingLineage.revision) !== Number(retryParent.lineageRevisionAtCreation)
        || Number(normalized.semantic.lineageRevisionAtCreation)
          !== Number(retryParent.lineageRevisionAtCreation) + 1
        || !parentFailure
        || parentFailure.failureClass !== 'transient'
        || typeof parentFailure.retryAllowed !== 'boolean'
        || parentFailure.retryAllowed !== true) {
        const error = new Error('external authority retry parent conflict');
        recordConflictDiagnostic(error);
        throw error;
      }
    } else if (normalized.retryOfTurnId !== null) {
      throw new Error('external authority retry parent missing');
    }
    if (this.getTurn(normalized.turnId)
      || this.db.prepare('SELECT 1 FROM visible_result_groups WHERE group_id = ?').get(normalized.groupId)) {
      throw new Error('external authority identity conflict');
    }

    const timestamp = normalized.inputKind === 'direct'
      ? Number(normalized.input.batch.committedAt)
      : Number(normalized.input.trigger.executedAt);
    const fault = step => {
      if (this.importExternalVisibleReceiptFaultStep === step) {
        throw new Error(`forced external import fault: ${step}`);
      }
    };
    const reuseOrRejectMessage = ({
      message,
      turnId,
      characterId,
      origin,
      deviceId,
      deviceSeq,
      checksum,
      authorityGroupId = null,
      groupOrdinal = null
    }) => {
      const existing = this.db.prepare(
        'SELECT * FROM messages WHERE message_id = ?'
      ).get(String(message.messageId));
      if (!existing) return false;
      const existingOwner = this.getTurn(existing.turn_id);
      const sameAuthorityRoot = retryParent
        && existingOwner?.authorityLineageKey === normalized.lineageKey
        && existingOwner.retryOfTurnId == null;
      const sameCore = existing.character_id === String(characterId)
        && existing.speaker_id === String(message.speakerId)
        && existing.speaker_type === String(message.speakerType)
        && existing.recipient_id === String(message.recipientId)
        && existing.content === String(message.content)
        && Number(existing.sent_at) === Number(message.sentAt)
        && (existing.authority_group_id ?? null) === (authorityGroupId ?? null)
        && (existing.group_ordinal ?? null) === (groupOrdinal ?? null);
      const same = sameCore && (
        (existing.turn_id === String(turnId)
          && existing.origin === String(origin)
          && (existing.device_id ?? null) === (deviceId ?? null)
          && (existing.device_seq ?? null) === (deviceSeq ?? null)
          && existing.checksum === String(checksum))
        || (sameAuthorityRoot
          && existing.origin === 'phone'
          && (existing.device_id ?? null) === (existingOwner.deviceId ?? null)
          && (existing.device_seq ?? null) === (existingOwner.deviceSeq ?? null)
          && existing.checksum === contentHash({
            messageId: message.messageId,
            turnId: existingOwner.turnId,
            characterId: existingOwner.characterId,
            speakerId: message.speakerId,
            speakerType: message.speakerType,
            recipientId: message.recipientId,
            content: message.content,
            sentAt: message.sentAt,
            origin: 'phone',
            deviceId: existingOwner.deviceId,
            deviceSeq: existingOwner.deviceSeq
          }))
      );
      if (!same) throw new Error('external authority message conflict');
      const batchItem = this.db.prepare(`
        SELECT message_json FROM current_user_batch_items WHERE message_id = ?
      `).get(String(message.messageId));
      if (batchItem && canonicalJson(parseJson(batchItem.message_json, null))
        !== canonicalJson(message)) {
        throw new Error('external authority message conflict');
      }
      return true;
    };
    return this.transaction(() => {
      const release = normalized.release;
      const existingRelease = this.getPipelineRelease(release.releaseId);
      const releaseRow = {
        releaseId: release.releaseId,
        pipelineVersion: 'android-fallback-v2',
        presetVersion: release.contractChecksum,
        cognitionSchemaVersion: 1,
        expressionSchemaVersion: 1,
        evaluatorVersion: 'android-fallback-authority-v1',
        modelProfile: {
          origin: 'android_fallback',
          contract: release.contract,
          contractChecksum: release.contractChecksum
        },
        componentManifest: {
          origin: 'android_fallback',
          contract: release.contract,
          contractChecksum: release.contractChecksum,
          codecVersion: 1
        },
        releaseChecksum: release.releaseChecksum,
        createdAt: 0,
        retiredAt: null
      };
      if (existingRelease) {
        if (canonicalJson(existingRelease) !== canonicalJson({
          ...releaseRow,
          createdAt: existingRelease.createdAt
        })) throw new Error('external authority release identity conflict');
      } else {
        this.db.prepare(`
          INSERT INTO pipeline_releases(
            release_id, pipeline_version, preset_version, cognition_schema_version,
            expression_schema_version, evaluator_version, model_profile_json,
            component_manifest_json, release_checksum, created_at, retired_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          releaseRow.releaseId, releaseRow.pipelineVersion, releaseRow.presetVersion,
          releaseRow.cognitionSchemaVersion, releaseRow.expressionSchemaVersion,
          releaseRow.evaluatorVersion, canonicalJson(releaseRow.modelProfile),
          canonicalJson(releaseRow.componentManifest), releaseRow.releaseChecksum,
          releaseRow.createdAt, releaseRow.retiredAt
        );
      }
      fault('after_release');

      const lane = this.getInteractionLane(normalized.roleId, normalized.laneKey);
      const laneRevisionBefore = Number(lane?.revision || 0);
      const laneRevisionAfter = laneRevisionBefore + 1;
      if (!lane) {
        this.db.prepare(`
          INSERT INTO interaction_lanes(
            role_id, lane_key, revision, generating_turn_id, latest_user_batch_id,
            latest_authoritative_group_id, native_completed_group_id,
            native_completed_sequence, ui_applied_group_id, ui_applied_sequence,
            local_sequence, last_commit_checksum, updated_at, clear_epoch,
            cleared_through_sequence
          ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.roleId, normalized.laneKey, laneRevisionAfter,
          normalized.inputUserBatchId, normalized.groupId, normalized.groupId,
          normalized.input.visibilitySequence, normalized.groupId,
          normalized.input.visibilitySequence, normalized.input.visibilitySequence,
          normalized.commitChecksum, timestamp, normalized.input.clearEpoch,
          normalized.input.visibilitySequence
        );
      } else {
        const updated = this.db.prepare(`
          UPDATE interaction_lanes
          SET revision = ?, generating_turn_id = NULL, latest_user_batch_id = ?,
              latest_authoritative_group_id = ?, native_completed_group_id = ?,
              native_completed_sequence = ?, ui_applied_group_id = ?,
              ui_applied_sequence = ?, local_sequence = MAX(local_sequence, ?),
              last_commit_checksum = ?, updated_at = ?, clear_epoch = MAX(clear_epoch, ?),
              cleared_through_sequence = MAX(cleared_through_sequence, ?)
          WHERE role_id = ? AND lane_key = ? AND revision = ?
        `).run(
          laneRevisionAfter, normalized.inputUserBatchId, normalized.groupId,
          normalized.groupId, normalized.input.visibilitySequence, normalized.groupId,
          normalized.input.visibilitySequence, normalized.input.visibilitySequence,
          normalized.commitChecksum, timestamp, normalized.input.clearEpoch,
          normalized.input.visibilitySequence, normalized.roleId, normalized.laneKey,
          laneRevisionBefore
        );
        if (Number(updated.changes) !== 1) throw new Error('external authority lane conflict');
      }
      fault('after_lane');

      const batchMessage = normalized.inputKind === 'direct'
        ? normalized.input.batch.items.at(-1).message
        : null;
      const envelope = {
        protocolVersion: Number(normalized.semantic.protocolVersion),
        turnId: normalized.turnId,
        characterId: normalized.roleId,
        deviceId: normalized.deviceId,
        deviceSeq: normalized.journalSyncSeq,
        createdAt: timestamp,
        kind: normalized.turnKind,
        ...(batchMessage ? { message: batchMessage } : {
          trigger: structuredClone(normalized.input.trigger)
        }),
        context: {
          ...(normalized.inputKind === 'direct' ? {
            currentBatch: {
              ...normalized.input.batch,
              messageIds: normalized.input.batch.items.map(item => item.messageId),
              messages: normalized.input.batch.items.map(item => item.message)
            }
          } : {}),
          visibilityCursor: {
            nativeCompletedTurnId: normalized.turnId,
            nativeCompletedGroupId: normalized.groupId,
            nativeCompletedSequence: normalized.input.visibilitySequence,
            uiAppliedTurnId: normalized.turnId,
            uiAppliedGroupId: normalized.groupId,
            uiAppliedSequence: normalized.input.visibilitySequence,
            localSequence: normalized.input.visibilitySequence,
            clearedThroughSequence: normalized.input.visibilitySequence,
            clearEpoch: normalized.input.clearEpoch,
            chatOpen: false,
            quotedMessageId: null
          }
        },
        authority: {
          algorithm: 'al-authority-v1',
          roleId: normalized.roleId,
          laneKey: normalized.laneKey,
          rootSourceId: normalized.rootSourceId,
          lineageKey: normalized.lineageKey,
          claimedLineageRevision: normalized.semantic.lineageRevisionAtCreation,
          retryOfTurnId: normalized.retryOfTurnId
        }
      };
      const envelopeChecksum = contentHash(envelope);
      this.db.prepare(`
        INSERT INTO turns(
          turn_id, character_id, device_id, device_seq, source_message_id,
          state, origin, envelope_json, envelope_checksum, created_at, updated_at,
          pipeline_mode, preset_version, annotation_snapshot_json, reply_json,
          rollout_key, comparison_mode, rollout_revision, rollout_evidence_epoch,
          pipeline_checksum, shadow_epoch, canary_epoch, canary_slot,
          authoritative_release_id, comparison_release_id,
          authoritative_pipeline_checksum, comparison_pipeline_checksum,
          lane_key, lane_revision, input_visibility_sequence, generation_fingerprint,
          result_authority_version, authority_lineage_key,
          lineage_revision_at_creation, turn_revision, retry_of_turn_id,
          input_user_batch_id, agency_snapshot_checksum, input_clear_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.turnId, normalized.roleId, normalized.deviceId, normalized.journalSyncSeq,
        normalized.rootSourceId, 'committed', 'android_fallback', canonicalJson(envelope),
        envelopeChecksum, timestamp, timestamp, 'external', release.contractChecksum, '{}',
        canonicalJson({ messages: normalized.replyItems.map(item => item.message) }),
        normalized.turnKind, 'none', retryParent?.rolloutRevision ?? 1,
        retryParent?.rolloutEvidenceEpoch ?? 0, release.releaseChecksum,
        null, null, null, release.releaseId, null, release.releaseChecksum,
        null, normalized.laneKey, laneRevisionAfter,
        normalized.input.visibilitySequence, normalized.commitChecksum, 1,
        normalized.lineageKey, normalized.semantic.lineageRevisionAtCreation,
        normalized.semantic.turnRevision, normalized.retryOfTurnId,
        normalized.inputUserBatchId, normalized.semantic.agencySnapshotChecksum,
        normalized.input.clearEpoch
      );
      fault('after_turn');

      if (normalized.inputKind === 'direct') {
        const batch = normalized.input.batch;
        const batchRows = batch.items.map(item => ({
          sequence: item.sequence, message_id: item.messageId, checksum: item.checksum
        }));
        const batchCommitment = currentUserBatchTombstoneCommitment({
          turnId: normalized.turnId, batchId: batch.batchId, itemRows: batchRows
        });
        this.db.prepare(`
          INSERT INTO current_user_batches(
            turn_id, batch_id, character_id, source_message_id, started_at, committed_at,
            checksum, created_at, item_count, tombstone_commitment
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          normalized.turnId, batch.batchId, batch.characterId, batch.sourceMessageId,
          batch.startedAt, batch.committedAt, batch.checksum, timestamp,
          batchCommitment.itemCount, batchCommitment.commitment
        );
        const batchInsert = this.db.prepare(`
          INSERT INTO current_user_batch_items(
            turn_id, batch_id, message_id, sequence, message_json, checksum
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const item of batch.items) {
          const message = item.message;
          const normalizedMessage = {
            messageId: message.messageId, turnId: normalized.turnId,
            characterId: normalized.roleId,
            speakerId: message.speakerId, speakerType: message.speakerType,
            recipientId: message.recipientId, content: message.content,
            sentAt: message.sentAt, origin: 'phone', deviceId: normalized.deviceId,
            deviceSeq: item.sequence === 0 ? normalized.journalSyncSeq : null
          };
          const reused = reuseOrRejectMessage({
            message,
            turnId: normalizedMessage.turnId,
            characterId: normalizedMessage.characterId,
            origin: normalizedMessage.origin,
            deviceId: normalizedMessage.deviceId,
            deviceSeq: normalizedMessage.deviceSeq,
            checksum: contentHash(normalizedMessage)
          });
          batchInsert.run(
            normalized.turnId, batch.batchId, item.messageId, item.sequence,
            canonicalJson(item.message), item.checksum
          );
          if (!reused) this.db.prepare(`
            INSERT INTO messages(
              message_id, turn_id, character_id, speaker_id, speaker_type,
              recipient_id, content, sent_at, origin, device_id, device_seq, checksum, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            normalizedMessage.messageId, normalizedMessage.turnId, normalized.roleId,
            normalizedMessage.speakerId, normalizedMessage.speakerType,
            normalizedMessage.recipientId, normalizedMessage.content, normalizedMessage.sentAt,
            normalizedMessage.origin, normalizedMessage.deviceId, normalizedMessage.deviceSeq,
            contentHash(normalizedMessage), timestamp
          );
        }
      }
      fault('after_input');

      const itemRows = normalized.replyItems.map(item => ({
        ordinal: item.ordinal, message_id: item.messageId, item_checksum: item.checksum
      }));
      const actionRows = normalized.actions.map(action => ({
        ordinal: action.ordinal, action_id: action.actionId, action_checksum: action.checksum
      }));
      const tombstone = visibleResultTombstoneCommitment({
        groupId: normalized.groupId, itemRows, actionRows
      });
      const replyChecksum = contentHash({
        items: normalized.replyItems.map(item => item.message),
        actions: normalized.actions.map(action => ({
          kind: action.kind, targetKey: action.targetKey,
          targetRevision: action.targetRevision, payload: action.payload
        }))
      });
      const childLineageRevision = Number(normalized.semantic.lineageRevisionAtCreation);
      const lineageRevisionBefore = childLineageRevision;
      const lineageRevisionAfter = childLineageRevision + 1;
      if (retryParent) {
        const updatedLineage = this.db.prepare(`
          UPDATE turn_authority_lineages
          SET latest_turn_id = ?, revision = ?, state = 'committed',
              committed_group_id = ?, updated_at = ?
          WHERE lineage_key = ? AND state = 'open' AND latest_turn_id = ?
            AND revision = ? AND committed_group_id IS NULL
        `).run(
          normalized.turnId,
          lineageRevisionAfter,
          normalized.groupId,
          timestamp,
          normalized.lineageKey,
          retryParent.turnId,
          Number(retryParent.lineageRevisionAtCreation)
        );
        if (Number(updatedLineage.changes) !== 1) {
          throw new Error('external authority retry parent conflict');
        }
        this.db.prepare(`
          UPDATE cloud_deliveries
          SET state = 'superseded', updated_at = ?
          WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL
            AND state IN ('waiting', 'pending')
        `).run(timestamp, retryParent.turnId, retryParent.deviceId);
      } else {
        this.db.prepare(`
          INSERT INTO turn_authority_lineages(
            lineage_key, role_id, lane_key, root_source_id, latest_turn_id,
            revision, state, committed_group_id, created_at, updated_at,
            attempt_count, attempt_commitment
          ) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, ?, ?, 0, '')
        `).run(
          normalized.lineageKey, normalized.roleId, normalized.laneKey, normalized.rootSourceId,
          normalized.turnId, childLineageRevision + 1,
          normalized.groupId, timestamp, timestamp
        );
      }
      fault('after_lineage');
      this.db.prepare(`
        INSERT INTO visible_result_groups(
          group_id, lineage_key, authoritative_turn_id, role_id, lane_key, authority_origin,
          authoritative_release_id, generation_fingerprint, reply_checksum, created_at,
          item_count, action_count, tombstone_commitment
        ) VALUES (?, ?, ?, ?, ?, 'android_fallback', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.groupId, normalized.lineageKey, normalized.turnId, normalized.roleId,
        normalized.laneKey, normalized.release.releaseId, normalized.commitChecksum,
        replyChecksum, timestamp, tombstone.itemCount, tombstone.actionCount,
        tombstone.commitment
      );
      const itemInsert = this.db.prepare(`
        INSERT INTO visible_result_items(group_id, ordinal, message_id, item_json, item_checksum)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const item of normalized.replyItems) {
        const message = item.message;
        const messageChecksum = contentHash({
          messageId: message.messageId,
          content: String(message.content || ''),
          recipientId: String(message.recipientId || 'user')
        });
        const reused = reuseOrRejectMessage({
          message,
          turnId: normalized.turnId,
          characterId: normalized.roleId,
          origin: 'codex',
          deviceId: null,
          deviceSeq: null,
          checksum: messageChecksum,
          authorityGroupId: normalized.groupId,
          groupOrdinal: item.ordinal
        });
        itemInsert.run(normalized.groupId, item.ordinal, item.messageId,
          canonicalJson(item.message), item.checksum);
        if (!reused) this.db.prepare(`
          INSERT INTO messages(
            message_id, turn_id, character_id, speaker_id, speaker_type, recipient_id,
            content, sent_at, origin, device_id, device_seq, checksum, created_at,
            authority_group_id, group_ordinal
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'codex', NULL, NULL, ?, ?, ?, ?)
        `).run(
          message.messageId, normalized.turnId, normalized.roleId, message.speakerId,
          message.speakerType, message.recipientId, message.content, message.sentAt,
          messageChecksum, timestamp, normalized.groupId, item.ordinal
        );
      }
      const actionInsert = this.db.prepare(`
        INSERT INTO visible_result_actions(
          group_id, ordinal, action_id, action_kind, target_key, target_revision,
          action_json, action_checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const action of normalized.actions) {
        actionInsert.run(
          normalized.groupId, action.ordinal, action.actionId, action.kind,
          action.targetKey, action.targetRevision, canonicalJson(action.payload), action.checksum
        );
      }
      fault('after_group');
      this.db.prepare(`
        INSERT INTO visible_result_manifests(
          group_id, authority_origin, payload_version, semantic_json,
          semantic_checksum, redacted_at, created_at
        ) VALUES (?, 'android_fallback', ?, ?, ?, NULL, ?)
      `).run(
        normalized.groupId, ANDROID_FALLBACK_COMMIT_PAYLOAD_VERSION,
        canonicalJson(normalized.semantic), normalized.commitChecksum, timestamp
      );
      this.db.prepare(`
        INSERT INTO visible_commit_receipts(
          lineage_key, group_id, authoritative_turn_id, authority_origin,
          commit_payload_version, turn_revision_before, turn_revision_after,
          lineage_revision_before, lineage_revision_after, lane_revision_before,
          lane_revision_after, cognitive_state_revision_before,
          cognitive_state_revision_after, commit_checksum, committed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.lineageKey, normalized.groupId, normalized.turnId,
        'android_fallback', ANDROID_FALLBACK_COMMIT_PAYLOAD_VERSION,
        retryParent ? Number(retryParent.turnRevision) : 0,
        normalized.semantic.turnRevision, lineageRevisionBefore, lineageRevisionAfter,
        null, null, null, null,
        normalized.commitChecksum, timestamp
      );
      fault('after_receipt');
      this.refreshLineageAttemptCommitmentInternal(normalized.lineageKey);
      return {
        authorityOrigin: 'android_fallback',
        authorityLineageKey: normalized.lineageKey,
        authoritativeTurnId: normalized.turnId,
        visibleGroupId: normalized.groupId,
        commitChecksum: normalized.commitChecksum,
        exactReplay: false
      };
    });
  }

  commitVisibleResultInternal(input) {
    const timestamp = Number(input.now || now());
    const turn = this.getTurn(input.turnId);
    const lineage = this.getTurnAuthorityLineage(input.authorityLineageKey);
    const lane = this.getInteractionLane(turn.characterId, input.laneKey);
    const cognitiveState = this.getCognitiveState(turn.characterId);
    const items = Array.isArray(input.visibleGroup?.items) ? input.visibleGroup.items : [];
    const actions = Array.isArray(input.actionSet) ? input.actionSet : [];
    const terminalDisposition = deriveTerminalDisposition(turn.rolloutKey, items.length, actions.length);
    if (terminalDisposition === 'skip'
      && ((input.memoryJobs || []).length || input.comparisonJob?.jobType === 'turn_consolidation')) {
      throw new Error('skip result cannot enqueue evidence memory');
    }
    const itemTombstoneRows = items.map((item, ordinal) => ({
      ordinal,
      message_id: deriveVisibleMessageId(input.groupId, ordinal),
      item_checksum: contentHash(item)
    }));
    const actionTombstoneRows = actions.map((action, ordinal) => ({
      ordinal,
      action_id: deriveVisibleActionId(input.groupId, ordinal),
      action_checksum: contentHash(action)
    }));
    const tombstoneCommitment = visibleResultTombstoneCommitment({
      groupId: input.groupId,
      itemRows: itemTombstoneRows,
      actionRows: actionTombstoneRows
    });
    if (!input.authorityManifest
      || contentHash(input.authorityManifest) !== input.commitChecksum) {
      throw new Error('canonical manifest checksum authority conflict');
    }
    const failAfter = step => {
      if (Number(this.commitFaultAfterStep) === step) {
        throw new Error(`forced commit fault after step ${step}`);
      }
    };

    const groupColumns = this.userVersion() >= 13
      ? `group_id, lineage_key, authoritative_turn_id, role_id, lane_key,
         authority_origin, authoritative_release_id, generation_fingerprint,
         reply_checksum, created_at, item_count, action_count, tombstone_commitment`
      : `group_id, lineage_key, authoritative_turn_id, role_id, lane_key,
         authority_origin, authoritative_release_id, generation_fingerprint,
         reply_checksum, created_at`;
    const groupValues = [
      input.groupId, input.authorityLineageKey, input.turnId, turn.characterId,
      input.laneKey, input.authorityOrigin, input.authoritativeReleaseId,
      input.generationFingerprint, contentHash({ items, actions }), timestamp
    ];
    if (this.userVersion() >= 13) {
      groupValues.push(
        tombstoneCommitment.itemCount,
        tombstoneCommitment.actionCount,
        tombstoneCommitment.commitment
      );
    }
    this.db.prepare(`INSERT INTO visible_result_groups(${groupColumns})
                     VALUES (${groupValues.map(() => '?').join(', ')})`).run(...groupValues);
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
        input.authorityLineageKey,
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

    const recoveryAckSeq = Number(this.db.prepare(`
      SELECT ack_seq
      FROM sync_cursors
      WHERE peer_id = ?
    `).get(turn.deviceId)?.ack_seq || 0);

    this.db.prepare(`
      INSERT INTO cloud_deliveries(
        turn_id, peer_id, recovery_ack_seq, state, attempts,
        created_at, updated_at, authority_group_id, authority_commit_checksum
      ) VALUES (?, ?, ?, 'waiting', 0, ?, ?, ?, ?)
    `).run(
      input.turnId,
      turn.deviceId,
      recoveryAckSeq,
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
    const byId = new Map(batch.messages.map(message => [String(message.messageId || ''), message]));
    const batchItemRows = batch.messageIds.map((messageId, sequence) => {
      const message = byId.get(messageId) || { messageId };
      return {
        sequence,
        message_id: String(messageId),
        message_json: canonicalJson(message),
        checksum: contentHash(message)
      };
    });
    const tombstoneCommitment = currentUserBatchTombstoneCommitment({
      turnId: envelope.turnId,
      batchId: batch.batchId,
      itemRows: batchItemRows
    });
    if (this.userVersion() >= 13) {
      this.db.prepare(`
        INSERT INTO current_user_batches(
          turn_id, batch_id, character_id, source_message_id,
          started_at, committed_at, checksum, created_at, item_count, tombstone_commitment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.turnId, batch.batchId, envelope.characterId, batch.sourceMessageId,
        batch.startedAt, batch.committedAt, contentHash(canonical), now(),
        tombstoneCommitment.itemCount, tombstoneCommitment.commitment
      );
    } else {
      this.db.prepare(`
        INSERT INTO current_user_batches(
          turn_id, batch_id, character_id, source_message_id,
          started_at, committed_at, checksum, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        envelope.turnId, batch.batchId, envelope.characterId, batch.sourceMessageId,
        batch.startedAt, batch.committedAt, contentHash(canonical), now()
      );
    }
    const insert = this.db.prepare(`
      INSERT INTO current_user_batch_items(
        turn_id, batch_id, message_id, sequence, message_json, checksum
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    batchItemRows.forEach(item => {
      insert.run(
        envelope.turnId,
        batch.batchId,
        item.message_id,
        item.sequence,
        item.message_json,
        item.checksum
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

  resolveCurrentBatchAuthorityForMemoryInternal({ turnId, messageId, roleId }) {
    const turn = this.getTurn(turnId);
    const expectedRoleId = String(roleId || turn?.characterId || '').trim();
    if (!turn || !expectedRoleId || turn.characterId !== expectedRoleId
      || Number(turn.resultAuthorityVersion) !== 1 || turn.state === 'cancelled') {
      throw new Error('memory current-batch turn authority conflict');
    }
    const envelope = parseJson(turn.envelopeJson, null);
    if (!envelope || envelope.protocolVersion !== 3 || envelope.turnId !== turn.turnId
      || envelope.characterId !== expectedRoleId) {
      throw new Error('memory current-batch envelope authority conflict');
    }
    const batch = this.getCurrentUserBatch(turn.turnId);
    if (!batch || batch.characterId !== expectedRoleId
      || !batch.messageIds.includes(String(messageId))) {
      throw new Error('memory current-batch source authority conflict');
    }
    if (typeof this.assertCanonicalTurnInputAuthorityInternal === 'function') {
      this.assertCanonicalTurnInputAuthorityInternal({
        storedTurn: turn,
        incomingEnvelope: envelope,
        mode: 'live_reopen'
      });
    }
    const message = this.db.prepare(
      'SELECT * FROM messages WHERE turn_id = ? AND message_id = ?'
    ).get(turn.turnId, String(messageId));
    const batchMessage = batch.messages.find(item => item?.messageId === String(messageId));
    const expectedMessageChecksum = message ? contentHash({
      messageId: message.message_id,
      turnId: message.turn_id,
      characterId: message.character_id,
      speakerId: message.speaker_id,
      speakerType: message.speaker_type,
      recipientId: message.recipient_id,
      content: message.content,
      sentAt: message.sent_at,
      origin: message.origin,
      deviceId: message.device_id,
      deviceSeq: message.device_seq
    }) : null;
    if (!message || !batchMessage || typeof message.content !== 'string' || !message.content.trim()
      || message.character_id !== expectedRoleId || message.speaker_type !== 'user'
      || message.content !== batchMessage.content || Number(message.sent_at) !== Number(batchMessage.sentAt)
      || message.checksum !== expectedMessageChecksum) {
      throw new Error('memory current-batch message authority conflict');
    }
    return {
      turn,
      batch,
      message,
      ...currentBatchEvidenceAuthorityProjection({ lineageKey: turn.authorityLineageKey })
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

  listConsumedProactiveMotiveIdsInternal({ roleId = 'yuqi', excludeGroupId = null } = {}) {
    const rows = this.db.prepare(`
      SELECT m.group_id, m.semantic_json, m.semantic_checksum,
             t.annotation_snapshot_json
      FROM visible_result_manifests m
      JOIN visible_result_groups g ON g.group_id = m.group_id
      JOIN turns t ON t.turn_id = g.authoritative_turn_id
      WHERE t.character_id = ?
        AND t.result_authority_version = 1
        AND t.rollout_key = 'PROACTIVE_CHAT'
        AND t.state IN ('committed', 'delivered', 'completed')
        AND m.payload_version = 'pc-visible-commit-v3'
        AND (? IS NULL OR m.group_id <> ?)
      ORDER BY m.created_at, t.turn_id
    `).all(String(roleId), excludeGroupId, excludeGroupId);
    const ids = new Set();
    for (const row of rows) {
      const closure = this.assertVisibleGroupAuthorityInternal(row.group_id, { purpose: 'proactive_motive_consumption' });
      if (closure.status === 'redacted') continue;
      if (closure.status !== 'live' || !closure.manifest?.semantic) {
        throw new Error('proactive motive manifest authority conflict');
      }
      const validatedSemantic = closure.manifest.semantic;
      const manifest = parseJson(row.semantic_json, null);
      if (!manifest || contentHash(manifest) !== row.semantic_checksum) {
        throw new Error('proactive motive manifest checksum authority conflict');
      }
      if (contentHash(validatedSemantic) !== row.semantic_checksum) {
        throw new Error('proactive motive manifest checksum authority conflict');
      }
      const evidence = manifest.proactiveMotiveEvidenceIds;
      const manifestKeys = new Set([
        'payloadVersion', 'authorityOrigin', 'authorityLineageKey', 'laneKey', 'input',
        'agency', 'releases', 'generationFingerprint', 'visibleItems', 'actions',
        'statePatch', 'memoryJobs', 'comparison', 'proactiveMotiveEvidenceIds'
      ]);
      const actualManifestKeys = Object.keys(manifest);
      if (actualManifestKeys.length !== manifestKeys.size
        || actualManifestKeys.some(key => !manifestKeys.has(key))
        || manifest.payloadVersion !== 'pc-visible-commit-v3'
        || !Array.isArray(evidence)
        || new Set(evidence).size !== evidence.length
        || evidence.length > 3
        || evidence.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('proactive motive manifest evidence authority conflict');
      }
      const annotation = parseJson(row.annotation_snapshot_json, null);
      const candidates = annotation?.proactiveMotiveAuthority?.candidates;
      if (!Array.isArray(candidates)
        || candidates.some(candidate => typeof candidate?.motiveId !== 'string'
          || !candidate.motiveId.trim())
        || evidence.some(id => !candidates.some(candidate => candidate.motiveId === id))) {
        throw new Error('proactive motive manifest evidence authority conflict');
      }
      for (const id of evidence) ids.add(id);
    }
    return [...ids].sort();
  }

  listConsumedPublicMomentEvidenceIdsInternal({ roleId = 'yuqi', excludeGroupId = null } = {}) {
    const rows = this.db.prepare(`
      SELECT m.group_id, m.semantic_json, m.semantic_checksum
      FROM visible_result_manifests m
      JOIN visible_result_groups g ON g.group_id = m.group_id
      JOIN turns t ON t.turn_id = g.authoritative_turn_id
      WHERE t.character_id = ?
        AND t.result_authority_version = 1
        AND t.rollout_key = 'PROACTIVE_MOMENT'
        AND json_extract(t.envelope_json, '$.protocolVersion') = 3
        AND t.state IN ('committed', 'delivered', 'completed')
        AND m.payload_version = 'pc-visible-commit-v4'
        AND (? IS NULL OR m.group_id <> ?)
      ORDER BY m.created_at, t.turn_id
    `).all(String(roleId), excludeGroupId, excludeGroupId);
    const ids = new Set();
    for (const row of rows) {
      const closure = this.assertVisibleGroupAuthorityInternal(row.group_id, {
        purpose: 'public_moment_consumption'
      });
      if (closure.status === 'redacted') continue;
      if (closure.status !== 'live' || !closure.manifest?.semantic) {
        throw new Error('public moment manifest authority conflict');
      }
      const manifest = closure.manifest.semantic;
      if (contentHash(manifest) !== row.semantic_checksum
        || manifest.payloadVersion !== 'pc-visible-commit-v4'
        || !Array.isArray(manifest.publicMomentEvidenceIds)
        || new Set(manifest.publicMomentEvidenceIds).size !== manifest.publicMomentEvidenceIds.length
        || manifest.publicMomentEvidenceIds.some(id => typeof id !== 'string' || !id.trim())) {
        throw new Error('public moment manifest evidence authority conflict');
      }
      for (const id of manifest.publicMomentEvidenceIds) ids.add(id);
    }
    return [...ids].sort();
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
    this.assertLegacyTurnMutableInternal(turn);
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

  readCloudDeliveryInternal({ turnId, peerId, authorityGroupId = null }) {
    const row = authorityGroupId
      ? this.db.prepare(`SELECT * FROM cloud_deliveries
          WHERE turn_id = ? AND peer_id = ? AND authority_group_id = ?`).get(
        String(turnId), String(peerId), String(authorityGroupId))
      : this.db.prepare(`SELECT * FROM cloud_deliveries
          WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL`).get(
        String(turnId), String(peerId));
    if (!row) return null;
    return {
      ...mapCloudDelivery(row),
      redactionRequestedAt: row.redaction_requested_at == null ? null : row.redaction_requested_at,
      redactionAcknowledgedAt: row.redaction_acknowledged_at == null ? null : row.redaction_acknowledged_at
    };
  }

  listPendingCloudDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT d.* FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      WHERE d.state IN ('waiting', 'pending')
        AND d.authority_group_id IS NULL
        AND t.result_authority_version = 0
      ORDER BY d.updated_at ASC, d.turn_id ASC, d.peer_id ASC LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  listPendingAuthorityCloudDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      WHERE d.state IN ('waiting', 'pending')
        AND d.authority_group_id IS NOT NULL
        AND t.result_authority_version = 1
      ORDER BY d.updated_at ASC, d.authority_group_id ASC, d.peer_id ASC
      LIMIT ?
    `).all(safeLimit).map(mapCloudDelivery);
  }

  listPendingRedactionDeliveries(limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    const rows = this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      WHERE d.state = 'redaction_pending'
      ORDER BY d.redaction_requested_at ASC, d.turn_id ASC, d.peer_id ASC
    `).all().map(row => ({
      ...mapCloudDelivery(row),
      redactionRequestedAt: row.redaction_requested_at == null ? null : row.redaction_requested_at,
      redactionAcknowledgedAt: row.redaction_acknowledged_at == null ? null : row.redaction_acknowledged_at
    }));
    for (const row of rows) {
      try {
        this.assertRedactionDeliveryAuthorityInternal(row);
      } catch (error) {
        error.peerId = row.peerId;
        error.turnId = row.turnId;
        error.relayMessageId = row.relayMessageId;
        error.requestAt = row.redactionRequestedAt;
        throw error;
      }
    }
    return rows.slice(0, safeLimit);
  }

  listPendingRedactionPeerIdsInternal() {
    const rows = this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      WHERE d.state = 'redaction_pending'
      ORDER BY d.peer_id ASC, d.turn_id ASC
    `).all().map(mapCloudDelivery);
    for (const row of rows) this.assertRedactionDeliveryAuthorityInternal(row);
    return [...new Set(rows.map(row => row.peerId))].sort();
  }

  listQuarantinedRedactionPeerIdsInternal() {
    return [...new Set(this.db.prepare(`
      SELECT DISTINCT d.peer_id
      FROM cloud_deliveries d
      JOIN diagnostics x ON x.turn_id = d.turn_id
      WHERE d.state = 'quarantined'
        AND x.stage IN ('legacy_redaction_delivery_quarantined',
                        'canonical_redaction_delivery_quarantined')
      ORDER BY d.peer_id
    `).all().map(row => row.peer_id))].sort();
  }

  assertRedactionDeliveryAuthorityInternal(row) {
    if (!row || row.state !== 'redaction_pending'
      || typeof row.relayMessageId !== 'string' || row.relayMessageId.length === 0
      || row.payloadJson !== null || row.checksum !== ''
      || typeof row.updatedAt !== 'number' || !Number.isSafeInteger(row.updatedAt)
      || row.updatedAt <= 0) {
      throw new Error('redaction delivery authority conflict');
    }
    const turn = this.getTurn(row.turnId);
    if (!turn) throw new Error('redaction delivery turn conflict');
    if (Number(turn.resultAuthorityVersion) === 0) {
      this.loadValidatedLegacyTurnRedactionInternal(row.turnId);
    } else if (Number(turn.resultAuthorityVersion) === 1) {
      const lineage = this.getTurnAuthorityLineage(turn.authorityLineageKey);
      if (!lineage || lineage.redactedAt == null) throw new Error('redaction delivery lineage conflict');
      if (lineage.committedGroupId) {
        this.assertVisibleGroupAuthorityInternal(lineage.committedGroupId, { purpose: 'reopen' });
      } else {
        this.assertRedactedLineageAuthorityInternal(lineage.lineageKey, { purpose: 'reopen' });
      }
    } else {
      throw new Error('redaction delivery authority version conflict');
    }
    return row;
  }

  claimRedactionDeliveryInternal({ turnId, peerId, requestAt = now() }) {
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM cloud_deliveries
        WHERE turn_id = ? AND peer_id = ?
      `).get(String(turnId || ''), String(peerId || ''));
      if (!row) return null;
      const mapped = mapCloudDelivery(row);
      if (mapped.state !== 'redaction_pending') return null;
      if (typeof row.redaction_requested_at !== 'number'
        || !Number.isSafeInteger(row.redaction_requested_at)
        || row.redaction_requested_at <= 0
        || typeof row.relay_message_id !== 'string'
        || row.relay_message_id.length === 0) {
        throw new Error('redaction delivery authority conflict');
      }
      if (typeof requestAt !== 'number' || !Number.isSafeInteger(requestAt) || requestAt <= 0) {
        throw new Error('redaction delivery request time conflict');
      }
      this.assertRedactionDeliveryAuthorityInternal(mapped);
      return Object.freeze({
        turnId: mapped.turnId,
        peerId: mapped.peerId,
        relayMessageId: mapped.relayMessageId,
        requestAt: row.redaction_requested_at,
        authorityVersion: Number(this.getTurn(turnId).resultAuthorityVersion)
      });
    });
  }

  completeRedactionDeliveryInternal({
    turnId, peerId, relayMessageId, requestAt, ackAt = now()
  }) {
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM cloud_deliveries
        WHERE turn_id = ? AND peer_id = ?
      `).get(String(turnId || ''), String(peerId || ''));
      if (!row) return { state: 'redacted', alreadyRemoved: true };
      if (row.state === 'redacted' && row.relay_message_id === String(relayMessageId || '')) {
        return mapCloudDelivery(row);
      }
      if (typeof ackAt !== 'number' || !Number.isSafeInteger(ackAt) || ackAt <= 0
        || typeof row.redaction_requested_at !== 'number'
        || !Number.isSafeInteger(row.redaction_requested_at)
        || typeof requestAt !== 'number' || !Number.isSafeInteger(requestAt)
        || row.redaction_requested_at !== requestAt
        || row.state !== 'redaction_pending'
        || row.relay_message_id !== String(relayMessageId || '')
        || row.payload_json !== null || row.checksum !== null) {
        throw new Error('redaction delivery completion conflict');
      }
      this.assertRedactionDeliveryAuthorityInternal(mapCloudDelivery(row));
      const result = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'redacted', redaction_acknowledged_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state = 'redaction_pending'
          AND relay_message_id = ? AND redaction_requested_at = ?
          AND payload_json IS NULL AND checksum IS NULL
      `).run(Number(ackAt), Number(ackAt), String(turnId), String(peerId),
        String(relayMessageId), requestAt);
      if (Number(result.changes) !== 1) throw new Error('redaction delivery completion CAS conflict');
      return mapCloudDelivery(this.db.prepare(
        'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
      ).get(String(turnId), String(peerId)));
    });
  }

  quarantineRedactionDeliveryInternal({
    turnId, peerId, relayMessageId, requestAt, reasonCode = 'authority_conflict'
  }) {
    const validReasons = new Set(['authority_conflict', 'target_set_conflict']);
    if (typeof turnId !== 'string' || !turnId
      || typeof peerId !== 'string' || !peerId
      || typeof relayMessageId !== 'string' || !relayMessageId
      || typeof requestAt !== 'number' || !Number.isSafeInteger(requestAt) || requestAt <= 0
      || !validReasons.has(reasonCode)) {
      throw new Error('redaction quarantine input conflict');
    }
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
      `).get(turnId, peerId);
      if (!row) return { quarantineOutcome: 'already_removed', state: null };
      const turn = this.db.prepare(
        'SELECT result_authority_version, authority_redacted_at, authority_lineage_key, envelope_json '
        + 'FROM turns WHERE turn_id = ?'
      ).get(turnId);
      const version = Number(turn?.result_authority_version);
      if (!turn || ![0, 1].includes(version)
        || (version === 0
          ? turn.authority_redacted_at == null
          : !turn.authority_lineage_key || !this.db.prepare(
            'SELECT redacted_at FROM turn_authority_lineages WHERE lineage_key = ?'
          ).get(turn.authority_lineage_key)?.redacted_at)) {
        throw new Error('redaction quarantine authority conflict');
      }
      const stage = version === 0
        ? 'legacy_redaction_delivery_quarantined'
        : 'canonical_redaction_delivery_quarantined';
      const detail = {
        redacted: true,
        peerId,
        relayMessageId,
        reasonCode
      };
      const diagnostics = this.db.prepare(`
        SELECT diagnostic_id, detail_json FROM diagnostics
        WHERE turn_id = ? AND stage = ?
      `).all(turnId, stage);
      if (row.state === 'quarantined') {
        if (row.payload_json !== null || row.checksum !== null
          || row.relay_message_id !== relayMessageId
          || row.redaction_requested_at !== requestAt
          || row.redaction_acknowledged_at !== null
          || row.attempts !== 0 || diagnostics.length !== 1
          || diagnostics[0].detail_json !== canonicalJson(detail)) {
          throw new Error('redaction quarantine replay conflict');
        }
        return { ...mapCloudDelivery(row), quarantineOutcome: 'already_quarantined' };
      }
      if (row.state !== 'redaction_pending'
        || row.payload_json !== null || row.checksum !== null
        || row.relay_message_id !== relayMessageId
        || row.redaction_requested_at !== requestAt
        || row.redaction_acknowledged_at !== null
        || typeof row.attempts !== 'number' || !Number.isSafeInteger(row.attempts)
        || row.attempts < 0 || diagnostics.length !== 0) {
        throw new Error('redaction quarantine target conflict');
      }
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'quarantined', payload_json = NULL, checksum = NULL,
            attempts = 0, redaction_acknowledged_at = NULL, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state = 'redaction_pending'
          AND relay_message_id = ? AND redaction_requested_at = ?
          AND payload_json IS NULL AND checksum IS NULL AND attempts = ?
          AND redaction_acknowledged_at IS NULL
      `).run(now(), turnId, peerId, relayMessageId, requestAt, row.attempts);
      if (Number(updated.changes) !== 1) {
        throw new Error('redaction quarantine CAS conflict');
      }
      this.putDiagnostic({
        turnId,
        stage,
        level: 'error',
        detail
      });
      return {
        ...mapCloudDelivery(this.db.prepare(
          'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
        ).get(turnId, peerId)),
        quarantineOutcome: 'quarantined'
      };
    });
  }

  assertCloudDeliverySendableInternal({ turnId, peerId, authorityGroupId = null, checksum = null }) {
    const row = authorityGroupId
      ? this.db.prepare(`SELECT d.* FROM cloud_deliveries d
          WHERE d.turn_id = ? AND d.peer_id = ? AND d.authority_group_id = ?`).get(
        String(turnId), String(peerId), String(authorityGroupId))
      : this.db.prepare(`SELECT d.* FROM cloud_deliveries d
          WHERE d.turn_id = ? AND d.peer_id = ? AND d.authority_group_id IS NULL`).get(
        String(turnId), String(peerId));
    if (!row || ['redacted', 'redaction_pending'].includes(row.state)
      || (checksum != null && row.checksum !== String(checksum))) {
      throw new Error('cloud delivery stale redaction conflict');
    }
    if (authorityGroupId) {
      this.assertVisibleGroupAuthorityInternal(authorityGroupId, { purpose: 'delivery' });
    } else if (Number(this.getTurn(turnId)?.resultAuthorityVersion) === 0) {
      const status = this.publicLegacyRedactedTurnStatusInternal;
      if (typeof status === 'function') {
        try { status.call(this, turnId); } catch { /* live legacy turns remain sendable */ }
      }
    }
    return mapCloudDelivery(row);
  }

  assertCanonicalFailureDeliveryInternal(delivery) {
    const row = delivery?.turnId ? delivery : mapCloudDelivery(delivery);
    const turn = this.getTurn(row?.turnId);
    const lineage = this.getTurnAuthorityLineage(turn?.authorityLineageKey);
    const failure = parseJson(turn?.errorJson, null);
    const wire = parseJson(turn?.envelopeJson, null);
    if (!row || !turn || !lineage
      || row.authorityGroupId != null
      || Number(turn.resultAuthorityVersion) !== 1
      || Number(wire?.protocolVersion) !== 3
      || row.peerId !== turn.deviceId
      || !['waiting', 'pending', 'mailboxed', 'superseded', 'superseded_mailboxed', 'quarantined'].includes(row.state)) {
      throw new Error('canonical failure delivery authority conflict');
    }
    const isCurrentFailure = turn.state === 'failed'
      && lineage.state === 'open'
      && lineage.latestTurnId === turn.turnId
      && lineage.committedGroupId == null
      && lineage.redactedAt == null;
    if (isCurrentFailure) {
      projectCanonicalFailureSnapshotForWire({
        turn,
        failure,
        lineageRevision: Number(turn.lineageRevisionAtCreation)
      });
    }
    const payload = parseJson(row.payloadJson, null);
    const needsPayload = ['pending', 'mailboxed', 'superseded_mailboxed'].includes(row.state)
      || ((row.state === 'superseded' || row.state === 'quarantined') && row.payloadJson != null);
    if (needsPayload) {
      if (!payload?.failure || !payload?.lease || !row.checksum
        || Object.keys(payload).sort().join(',') !== 'failure,lease'
        || Object.keys(payload.lease).sort().join(',') !== 'leaseAttempt,leaseId,leasedAt'
        || !Number.isSafeInteger(Number(payload.lease.leaseAttempt))
        || Number(payload.lease.leaseAttempt) !== Number(row.attempts)
        || !Number.isSafeInteger(Number(payload.lease.leasedAt))
        || Number(payload.lease.leasedAt) <= 0
        || payload.lease.leaseId !== stableFailureId('failure_lease',
          `${row.turnId}:${row.peerId}:${row.checksum}:${row.attempts}`)) {
        throw new Error('canonical failure delivery lease conflict');
      }
      if ((row.state === 'pending' && Number(payload.lease.leasedAt) !== Number(row.updatedAt))
        || (row.state !== 'pending' && Number(payload.lease.leasedAt) > Number(row.updatedAt))) {
        throw new Error('canonical failure delivery lease time conflict');
      }
      {
        const expected = projectCanonicalFailureSnapshotForWire({
          turn,
          failure,
          lineageRevision: Number(turn.lineageRevisionAtCreation)
        });
        if (row.checksum !== expected.rawStatusChecksum
          || canonicalJson(payload.failure) !== canonicalJson({
            ok: true, ...expected, recoveryAckSeq: Number(row.recoveryAckSeq || 0)
          })) throw new Error('canonical failure delivery checksum conflict');
      }
    } else if (row.payloadJson != null || row.checksum || Number(row.attempts) !== 0) {
      throw new Error('canonical failure delivery state conflict');
    }
    if (['mailboxed', 'superseded_mailboxed'].includes(row.state)
      || (row.state === 'quarantined' && row.relayMessageId != null)) {
      const expectedRelay = stableFailureId('relay_failure', `${row.turnId}:${row.peerId}:${row.checksum}`);
      if (row.relayMessageId !== expectedRelay || !Number.isSafeInteger(Number(row.deliveredAt))) {
        throw new Error('canonical failure relay identity conflict');
      }
      if (payload?.lease && Number(row.deliveredAt) < Number(payload.lease.leasedAt)) {
        throw new Error('canonical failure delivery time conflict');
      }
    } else if (row.relayMessageId != null || row.deliveredAt != null) {
      throw new Error('canonical failure delivery state conflict');
    }
    if (row.state === 'waiting' && !isCurrentFailure) {
      throw new Error('canonical failure delivery authority conflict');
    }
    if (row.state === 'pending' && !isCurrentFailure) {
      throw new Error('canonical failure delivery authority conflict');
    }
    if (['superseded', 'superseded_mailboxed'].includes(row.state)) {
      const directChild = this.db.prepare(`
        SELECT * FROM turns
        WHERE retry_of_turn_id = ? AND authority_lineage_key = ?
          AND lineage_revision_at_creation = ?
      `).get(turn.turnId, turn.authorityLineageKey, Number(turn.lineageRevisionAtCreation) + 1);
      const latest = this.getTurn(lineage.latestTurnId);
      const childWire = parseJson(directChild?.envelope_json, null);
      const childIsCanonicalV3 = Number(childWire?.protocolVersion) === 3;
      const childIsAndroidFallbackV2 = directChild?.origin === 'android_fallback'
        && Number(childWire?.protocolVersion) === 2;
      if (!directChild || !latest
        || directChild.authority_lineage_key !== turn.authorityLineageKey
        || Number(directChild.result_authority_version) !== 1
        || (!childIsCanonicalV3 && !childIsAndroidFallbackV2)
        || latest.authorityLineageKey !== turn.authorityLineageKey
        || Number(latest.resultAuthorityVersion) !== 1
        || !['open', 'committed', 'cancelled'].includes(lineage.state)) {
        throw new Error('canonical failure delivery authority conflict');
      }
    }
    if (row.state === 'quarantined') {
      const diagnostics = this.db.prepare(`
        SELECT detail_json FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
      `).all(row.turnId).map(entry => parseJson(entry.detail_json, null));
      const hasRedactedDiagnostic = diagnostics.length === 1 && diagnostics.every(detail => detail
        && Object.keys(detail).sort().join(',') === 'peerId,reason,redacted'
        && detail.redacted === true
        && detail.peerId === row.peerId
        && typeof detail.reason === 'string'
        && ['authority_validation_failed', 'source_cancelled', 'source_redacted'].includes(detail.reason));
      if (!hasRedactedDiagnostic) throw new Error('canonical failure delivery quarantine diagnostic conflict');
    } else if (this.db.prepare(`
      SELECT 1 AS value FROM diagnostics
      WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
      LIMIT 1
    `).get(row.turnId)) {
      throw new Error('canonical failure delivery quarantine diagnostic conflict');
    }
    return row;
  }

  listPendingCanonicalFailureCloudDeliveries(limit = 50, timestamp = now()) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      JOIN turn_authority_lineages l
        ON l.lineage_key = t.authority_lineage_key
       AND l.latest_turn_id = t.turn_id
      WHERE d.authority_group_id IS NULL
        AND d.peer_id = t.device_id
        AND t.result_authority_version = 1
        AND t.state = 'failed'
        AND json_extract(t.envelope_json, '$.protocolVersion') = 3
        AND l.state = 'open' AND l.committed_group_id IS NULL AND l.redacted_at IS NULL
        AND (d.state = 'waiting' OR (d.state = 'pending' AND d.updated_at <= ?))
      ORDER BY d.updated_at ASC, d.turn_id ASC, d.peer_id ASC
      LIMIT ?
    `).all(Number(timestamp) - FAILURE_DELIVERY_LEASE_MS, safeLimit)
      .map(row => ({ ...mapCloudDelivery(row), deliveryType: 'canonical_failure' }));
  }

  claimCanonicalFailureCloudDeliveryInternal({ turnId, peerId, timestamp = now() }) {
    return this.withImmediateTransaction(() => {
      const existing = this.db.prepare(`
        SELECT d.*
        FROM cloud_deliveries d
        JOIN turns t ON t.turn_id = d.turn_id
        JOIN turn_authority_lineages l
          ON l.lineage_key = t.authority_lineage_key
         AND l.latest_turn_id = t.turn_id
         AND l.state = 'open' AND l.committed_group_id IS NULL AND l.redacted_at IS NULL
        WHERE d.turn_id = ? AND d.peer_id = ? AND d.authority_group_id IS NULL
          AND d.peer_id = t.device_id
          AND t.result_authority_version = 1 AND t.state = 'failed'
          AND json_extract(t.envelope_json, '$.protocolVersion') = 3
          AND NOT EXISTS (
            SELECT 1 FROM cloud_deliveries other
            WHERE other.turn_id = d.turn_id
              AND other.authority_group_id IS NULL
              AND other.peer_id <> t.device_id
          )
      `).get(String(turnId), String(peerId));
      if (!existing) throw new Error('canonical failure delivery authority conflict');
      const reclaimable = existing.state === 'waiting'
        || (existing.state === 'pending'
          && Number(existing.updated_at) <= Number(timestamp) - FAILURE_DELIVERY_LEASE_MS);
      if (!reclaimable) return null;
      const failure = this.loadCanonicalFailureForBridgeInternal(turnId);
      const leaseAttempt = Number(existing.attempts || 0) + 1;
      const rawStatusChecksum = failure.rawStatusChecksum;
      const leaseId = stableFailureId('failure_lease',
        `${turnId}:${peerId}:${rawStatusChecksum}:${leaseAttempt}`);
      const payload = {
        failure: { ok: true, ...failure, recoveryAckSeq: Number(existing.recovery_ack_seq || 0) },
        lease: { leaseId, leaseAttempt, leasedAt: Number(timestamp) }
      };
      const result = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'pending', payload_json = ?, checksum = ?, attempts = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL
          AND ((state = 'waiting' AND attempts = ?)
            OR (state = 'pending' AND attempts = ? AND updated_at <= ?))
      `).run(
        canonicalJson(payload), rawStatusChecksum, leaseAttempt, Number(timestamp),
        String(turnId), String(peerId), Number(existing.attempts || 0),
        Number(existing.attempts || 0), Number(timestamp) - FAILURE_DELIVERY_LEASE_MS
      );
      if (Number(result.changes) !== 1) return null;
      return {
        delivery: mapCloudDelivery(this.db.prepare(
          'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
        ).get(String(turnId), String(peerId))),
        payload: payload.failure,
        rawStatusChecksum,
        leaseId,
        leaseAttempt,
        relayMessageId: stableFailureId('relay_failure', `${turnId}:${peerId}:${rawStatusChecksum}`)
      };
    });
  }

  markCanonicalFailureCloudDeliveryMailboxedInternal({
    turnId, peerId, rawStatusChecksum, leaseId, leaseAttempt, relayMessageId, timestamp = now()
  }) {
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(
        `SELECT d.* FROM cloud_deliveries d
         JOIN turns t ON t.turn_id = d.turn_id
         JOIN turn_authority_lineages l
           ON l.lineage_key = t.authority_lineage_key
         WHERE d.turn_id = ? AND d.peer_id = ?
           AND d.peer_id = t.device_id
           AND t.result_authority_version = 1 AND t.state = 'failed'
           AND json_extract(t.envelope_json, '$.protocolVersion') = 3`
      ).get(String(turnId), String(peerId));
      if (!row) {
        throw new Error('canonical failure target set conflict');
      }
      this.assertCanonicalFailureDeliveryInternal(row);
      const payload = parseJson(row?.payload_json, null);
      const lease = payload?.lease;
      const expectedRelayMessageId = stableFailureId('relay_failure',
        `${turnId}:${peerId}:${rawStatusChecksum}`);
      if (!row || row.authority_group_id != null || row.checksum !== String(rawStatusChecksum)
        || lease?.leaseId !== leaseId || Number(lease?.leaseAttempt) !== Number(leaseAttempt)) {
        throw new Error('canonical failure delivery lease conflict');
      }
      if (String(relayMessageId) !== expectedRelayMessageId) {
        throw new Error('canonical failure relay identity conflict');
      }
      const nextState = row.state === 'pending'
        ? 'mailboxed'
        : row.state === 'superseded'
          ? 'superseded_mailboxed'
          : null;
      if (!nextState) throw new Error('canonical failure delivery lease conflict');
      const failedTurn = this.getTurn(turnId);
      const lineage = this.getTurnAuthorityLineage(failedTurn?.authorityLineageKey);
      if (!lineage) throw new Error('canonical failure delivery authority conflict');
      if (row.state === 'pending'
        && (lineage.state !== 'open' || lineage.latestTurnId !== String(turnId)
          || lineage.committedGroupId != null || lineage.redactedAt != null)) {
        throw new Error('canonical failure delivery lease conflict');
      }
      if (row.state === 'superseded') {
        const child = this.getTurn(lineage.latestTurnId);
        if (!child || child.authorityLineageKey !== failedTurn.authorityLineageKey
          || child.turnId === failedTurn.turnId
          || child.retryOfTurnId !== failedTurn.turnId
          || Number(child.lineageRevisionAtCreation) !== Number(failedTurn.lineageRevisionAtCreation) + 1
          || !['open', 'committed', 'cancelled'].includes(lineage.state)) {
          throw new Error('canonical failure delivery authority conflict');
        }
      }
      const result = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = ?, relay_message_id = ?, delivered_at = ?, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND state = ? AND checksum = ?
          AND payload_json = ? AND attempts = ?
      `).run(nextState, String(relayMessageId), Number(timestamp), Number(timestamp),
        String(turnId), String(peerId), row.state, String(rawStatusChecksum),
        String(row.payload_json), Number(leaseAttempt));
      if (Number(result.changes) !== 1) throw new Error('canonical failure delivery lease conflict');
      return mapCloudDelivery(this.db.prepare(
        'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
      ).get(String(turnId), String(peerId)));
    });
  }

  quarantineCanonicalCloudDeliveryInternal({
    turnId,
    peerId,
    expected,
    reason = 'authority_validation_failed'
  }) {
    const allowedReasons = new Set([
      'authority_validation_failed', 'source_cancelled', 'source_redacted'
    ]);
    const requiredSnapshotKeys = [
      'state', 'payloadJson', 'checksum', 'attempts',
      'relayMessageId', 'deliveredAt', 'updatedAt'
    ];
    if (!allowedReasons.has(String(reason))) {
      throw new Error('canonical failure delivery quarantine reason conflict');
    }
    if (!expected || requiredSnapshotKeys.some(key => !Object.hasOwn(expected, key))) {
      throw new Error('canonical failure delivery quarantine snapshot conflict');
    }
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT d.*, t.result_authority_version, t.device_id
        FROM cloud_deliveries d JOIN turns t ON t.turn_id = d.turn_id
        WHERE d.turn_id = ? AND d.peer_id = ?
          AND d.authority_group_id IS NULL
          AND t.result_authority_version = 1 AND t.device_id = d.peer_id
          AND json_extract(t.envelope_json, '$.protocolVersion') = 3
      `).get(String(turnId), String(peerId));
      if (!row) {
        const turn = this.getTurn(String(turnId));
        const lineage = this.getTurnAuthorityLineage(turn?.authorityLineageKey);
        if (turn?.state === 'cancelled' || lineage?.redactedAt != null || lineage?.state === 'cancelled') {
          return { quarantineOutcome: 'stale_redacted', state: null };
        }
        throw new Error('canonical failure delivery quarantine target conflict');
      }
      const detail = canonicalJson({ redacted: true, peerId: String(peerId), reason: String(reason) });
      const diagnosticRows = this.db.prepare(`
        SELECT diagnostic_id, detail_json
        FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
      `).all(String(turnId));
      if (row.state === 'quarantined') {
        if (row.payload_json != null || row.checksum != null || Number(row.attempts) !== 0
          || row.relay_message_id != null || row.delivered_at != null || row.confirmed_at != null
          || diagnosticRows.length !== 1 || diagnosticRows[0].detail_json !== detail) {
          throw new Error('canonical failure delivery quarantine conflict');
        }
        return { ...mapCloudDelivery(row), quarantineOutcome: 'already_quarantined' };
      }
      if (['mailboxed', 'confirmed', 'superseded', 'superseded_mailboxed', 'redaction_pending', 'redacted'].includes(row.state)) {
        return { ...mapCloudDelivery(row), quarantineOutcome: 'stale_terminal' };
      }
      if (!['waiting', 'pending'].includes(row.state)
        || row.state !== expected.state
        || (row.payload_json ?? null) !== (expected.payloadJson ?? null)
        || (row.checksum ?? null) !== (expected.checksum || null)
        || Number(row.attempts) !== Number(expected.attempts)
        || (row.relay_message_id ?? null) !== (expected.relayMessageId ?? null)
        || (row.delivered_at ?? null) !== (expected.deliveredAt ?? null)
        || Number(row.updated_at) !== Number(expected.updatedAt)) {
        throw new Error('canonical failure delivery quarantine snapshot conflict');
      }
      if (diagnosticRows.length !== 0) {
        throw new Error('canonical failure delivery quarantine diagnostic conflict');
      }
      const timestamp = now();
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'quarantined', payload_json = NULL, checksum = NULL,
            attempts = 0, relay_message_id = NULL, delivered_at = NULL,
            confirmed_at = NULL, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL
          AND state = ? AND payload_json IS ? AND checksum IS ? AND attempts = ?
          AND relay_message_id IS ? AND delivered_at IS ? AND updated_at = ?
      `).run(
        timestamp,
        String(turnId), String(peerId), expected.state,
        expected.payloadJson ?? null, expected.checksum || null, Number(expected.attempts),
        expected.relayMessageId ?? null, expected.deliveredAt ?? null, Number(expected.updatedAt)
      );
      if (Number(updated.changes) !== 1) {
        throw new Error('canonical failure delivery quarantine snapshot conflict');
      }
      this.putDiagnostic({
        turnId: String(turnId),
        stage: 'canonical_failure_delivery_quarantined',
        level: 'error',
        detail: JSON.parse(detail)
      });
      return { ...mapCloudDelivery(this.db.prepare(
        'SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?'
      ).get(String(turnId), String(peerId))), quarantineOutcome: 'quarantined' };
    });
  }

  quarantineCanonicalVisibleDeliveryInternal({
    turnId,
    peerId,
    authorityGroupId,
    authorityCommitChecksum,
    expected,
    reason = 'authority_validation_failed'
  }) {
    const allowedReasons = new Set([
      'authority_validation_failed',
      'source_cancelled',
      'source_redacted'
    ]);
    if (!allowedReasons.has(String(reason))) {
      throw new Error('canonical visible delivery quarantine reason conflict');
    }
    const requiredSnapshotKeys = [
      'state', 'payloadJson', 'checksum', 'attempts',
      'relayMessageId', 'deliveredAt', 'updatedAt'
    ];
    if (!expected || requiredSnapshotKeys.some(key => !Object.hasOwn(expected, key))) {
      throw new Error('canonical visible delivery quarantine snapshot conflict');
    }
    return this.withImmediateTransaction(() => {
      const row = this.db.prepare(`
        SELECT d.*, t.result_authority_version, t.device_id
        FROM cloud_deliveries d
        JOIN turns t ON t.turn_id = d.turn_id
        WHERE d.turn_id = ? AND d.peer_id = ?
          AND d.authority_group_id = ? AND d.authority_commit_checksum = ?
          AND t.result_authority_version = 1 AND t.device_id = d.peer_id
      `).get(
        String(turnId), String(peerId), String(authorityGroupId), String(authorityCommitChecksum)
      );
      if (!row) {
        const turn = this.getTurn(String(turnId));
        const lineage = this.getTurnAuthorityLineage(turn?.authorityLineageKey);
        if (turn?.state === 'cancelled' || lineage?.redactedAt != null || lineage?.state === 'cancelled') {
          return { quarantineOutcome: 'stale_redacted', state: null };
        }
        throw new Error('canonical visible delivery quarantine target conflict');
      }
      const detail = canonicalJson({
        redacted: true,
        groupId: String(authorityGroupId),
        peerId: String(peerId),
        reason: String(reason)
      });
      const diagnosticRows = this.db.prepare(`
        SELECT diagnostic_id, detail_json
        FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_visible_delivery_quarantined'
      `).all(String(turnId));
      if (row.state === 'quarantined') {
        if (row.payload_json != null || row.checksum != null || Number(row.attempts) !== 0
          || row.relay_message_id != null || row.delivered_at != null || row.confirmed_at != null
          || diagnosticRows.length !== 1 || diagnosticRows[0].detail_json !== detail) {
          throw new Error('canonical visible delivery quarantine conflict');
        }
        return { ...mapCloudDelivery(row), quarantineOutcome: 'already_quarantined' };
      }
      if (['mailboxed', 'confirmed', 'superseded', 'superseded_mailboxed', 'redaction_pending', 'redacted'].includes(row.state)) {
        return { ...mapCloudDelivery(row), quarantineOutcome: 'stale_terminal' };
      }
      if (!['waiting', 'pending'].includes(row.state)
        || row.state !== expected.state
        || (row.payload_json ?? null) !== (expected.payloadJson ?? null)
        || (row.checksum ?? null) !== (expected.checksum || null)
        || Number(row.attempts) !== Number(expected.attempts)
        || (row.relay_message_id ?? null) !== (expected.relayMessageId ?? null)
        || (row.delivered_at ?? null) !== (expected.deliveredAt ?? null)
        || Number(row.updated_at) !== Number(expected.updatedAt)) {
        throw new Error('canonical visible delivery quarantine snapshot conflict');
      }
      if (diagnosticRows.length !== 0) {
        throw new Error('canonical visible delivery quarantine diagnostic conflict');
      }
      const timestamp = now();
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'quarantined', payload_json = NULL, checksum = NULL,
            attempts = 0, relay_message_id = NULL, delivered_at = NULL,
            confirmed_at = NULL, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND authority_group_id = ?
          AND authority_commit_checksum = ? AND state = ?
          AND payload_json IS ? AND checksum IS ? AND attempts = ?
          AND relay_message_id IS ? AND delivered_at IS ? AND updated_at = ?
      `).run(
        timestamp,
        String(turnId), String(peerId), String(authorityGroupId), String(authorityCommitChecksum),
        expected.state,
        expected.payloadJson ?? null, expected.checksum || null, Number(expected.attempts),
        expected.relayMessageId ?? null, expected.deliveredAt ?? null, Number(expected.updatedAt)
      );
      if (Number(updated.changes) !== 1) {
        throw new Error('canonical visible delivery quarantine snapshot conflict');
      }
      this.putDiagnostic({
        turnId: String(turnId),
        stage: 'canonical_visible_delivery_quarantined',
        level: 'error',
        detail: JSON.parse(detail)
      });
      return { ...mapCloudDelivery(this.db.prepare(`
        SELECT * FROM cloud_deliveries
        WHERE turn_id = ? AND peer_id = ? AND authority_group_id = ?
      `).get(String(turnId), String(peerId), String(authorityGroupId))), quarantineOutcome: 'quarantined' };
    });
  }

  recoverFailedDraft(turnId, { peerId, sentAt = null } = {}) {
    const current = this.getTurn(turnId);
    if (!current) throw new Error('turn not found');
    this.assertLegacyTurnMutableInternal(current);
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
    this.assertLegacyTurnMutableInternal(current);
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
    this.assertLegacyCloudDeliveryInternal(turnId, peerId);
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

  assertLegacyCloudDeliveryInternal(turnId, peerId) {
    const row = this.db.prepare(`
      SELECT d.authority_group_id, t.result_authority_version
      FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      WHERE d.turn_id = ? AND d.peer_id = ?
    `).get(String(turnId), String(peerId));
    if (!row) throw new Error('cloud delivery not found');
    const turn = this.getTurn(turnId);
    this.assertLegacyTurnMutableInternal(turn);
    if (row.authority_group_id != null || Number(row.result_authority_version) !== 0) {
      throw new Error('canonical delivery API required');
    }
  }

  assertLegacyTurnMutableInternal(turn) {
    if (!turn || turn.authorityRedactedAt != null
      || canonicalJson(parseJson(turn.envelopeJson, null)) === canonicalJson({ redacted: true })) {
      throw new Error('redacted legacy turn is immutable');
    }
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
    this.assertLegacyCloudDeliveryInternal(turnId, peerId);
    const delivery = this.db.prepare(`
      SELECT * FROM cloud_deliveries WHERE turn_id = ? AND peer_id = ?
    `).get(turnId, String(peerId));
    if (!delivery) throw new Error('cloud delivery not found');
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
    this.assertLegacyCloudDeliveryInternal(turnId, peerId);
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

  confirmAuthorityCloudDeliveryInternal(receipt) {
    const normalized = validateAuthorityDeliveryReceipt(receipt);
    return this.withImmediateTransaction(() => {
      const target = this.assertCanonicalVisibleDeliveryTargetSetInternal({
        groupId: normalized.visibleGroupId,
        expectedLineageKey: normalized.authorityLineageKey
      });
      if (target.authorityLineageKey !== normalized.authorityLineageKey
        || target.turnId !== normalized.turnId
        || target.peerId !== normalized.peerId
        || target.commitChecksum !== normalized.commitChecksum
        || target.closure.terminalDisposition !== normalized.terminalDisposition) {
        throw new Error('canonical authority delivery receipt conflict');
      }
      const delivery = target.delivery;
      if (delivery.state === 'confirmed') {
        if (Number(delivery.confirmed_at) !== normalized.deliveredAt) {
          throw new Error('canonical authority delivery receipt conflict');
        }
        return mapCloudDelivery(delivery);
      }
      if (delivery.state !== 'mailboxed') {
        throw new Error('canonical authority delivery is not mailboxed');
      }
      const updatedAt = now();
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE authority_group_id = ? AND peer_id = ? AND turn_id = ?
          AND authority_commit_checksum = ? AND state = 'mailboxed'
      `).run(
        normalized.deliveredAt,
        updatedAt,
        normalized.visibleGroupId,
        normalized.peerId,
        normalized.turnId,
        normalized.commitChecksum
      );
      if (Number(updated.changes) !== 1) throw new Error('canonical authority delivery receipt conflict');
      return mapCloudDelivery(this.db.prepare(`
        SELECT * FROM cloud_deliveries
        WHERE authority_group_id = ? AND peer_id = ?
      `).get(normalized.visibleGroupId, normalized.peerId));
    });
  }

  confirmCanonicalV2DeliveryInternal(turnId, peerId, receipt) {
    const normalized = validateDeliveryReceipt(receipt);
    if (normalized.turnId !== String(turnId || '')) {
      throw new Error('canonical v2 delivery receipt turn conflict');
    }
    return this.withImmediateTransaction(() => {
      const lookupTurn = this.getTurn(normalized.turnId);
      if (!lookupTurn
        || Number(lookupTurn.resultAuthorityVersion || 0) !== 1
        || Number(lookupTurn.protocolVersion || 0) !== 2) {
        throw new Error('canonical v2 delivery receipt conflict');
      }
      const canonical = this.loadCanonicalBridgeResultInternal(lookupTurn.turnId);
      if (canonical.status === 'redacted') throw new Error('canonical v2 delivery receipt conflict');
      const target = this.assertCanonicalVisibleDeliveryTargetSetInternal({
        groupId: canonical.visibleGroupId,
        expectedLineageKey: canonical.authorityLineageKey
      });
      if (target.turnId !== canonical.turnId
        || target.peerId !== String(peerId)
        || target.commitChecksum !== canonical.commitChecksum) {
        throw new Error('canonical v2 delivery target conflict');
      }
      const projection = projectBridgeResultForWire(canonical, 2);
      const expectedItems = projection.deliveryItems;
      if (expectedItems.length === 0 || normalized.items.length !== expectedItems.length) {
        throw new Error('canonical v2 delivery receipt item conflict');
      }
      const expected = new Map(expectedItems.map(item => [`${item.kind}:${item.id}`, item.checksum]));
      for (const item of normalized.items) {
        if (expected.get(`${item.kind}:${item.id}`) !== item.checksum) {
          throw new Error('canonical v2 delivery receipt item conflict');
        }
      }
      const delivery = target.delivery;
      if (delivery.state === 'confirmed') {
        if (Number(delivery.confirmed_at) !== normalized.deliveredAt) {
          throw new Error('canonical v2 delivery receipt conflict');
        }
        return mapCloudDelivery(delivery);
      }
      if (delivery.state !== 'mailboxed') {
        throw new Error('canonical v2 delivery is not mailboxed');
      }
      const updated = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'confirmed', confirmed_at = ?, updated_at = ?
        WHERE authority_group_id = ? AND peer_id = ? AND turn_id = ?
          AND authority_commit_checksum = ? AND state = 'mailboxed'
      `).run(
        normalized.deliveredAt,
        now(),
        canonical.visibleGroupId,
        String(peerId),
        canonical.turnId,
        canonical.commitChecksum
      );
      if (Number(updated.changes) !== 1) throw new Error('canonical v2 delivery receipt conflict');
      return mapCloudDelivery(this.db.prepare(`
        SELECT * FROM cloud_deliveries
        WHERE authority_group_id = ? AND peer_id = ?
      `).get(canonical.visibleGroupId, String(peerId)));
    });
  }

  confirmCanonicalV2SimpleDeliveryInternal(turnId, peerId, receipt) {
    const lookupTurn = this.getTurn(String(turnId || ''));
    if (!lookupTurn
      || Number(lookupTurn.resultAuthorityVersion || 0) !== 1
      || Number(lookupTurn.protocolVersion || 0) !== 2) {
      throw new Error('canonical v2 delivery receipt conflict');
    }
    const canonical = this.loadCanonicalBridgeResultInternal(lookupTurn.turnId);
    if (canonical.status === 'redacted') throw new Error('canonical v2 delivery receipt conflict');
    const projection = projectBridgeResultForWire(canonical, 2);
    if (projection.replyParts.length !== 1 || projection.actions.length !== 0) {
      throw new Error('canonical v2 simple delivery receipt conflict');
    }
    const messageId = String(receipt?.messageId || '');
    const contentSha256 = String(receipt?.contentSha256 || '');
    const expectedContentHash = createHash('sha256')
      .update(String(projection.replyParts[0].content || ''), 'utf8')
      .digest('hex');
    if (messageId !== projection.replyParts[0].messageId || contentSha256 !== expectedContentHash) {
      throw new Error('canonical v2 simple delivery receipt conflict');
    }
    return this.confirmCanonicalV2DeliveryInternal(lookupTurn.turnId, peerId, {
      protocolVersion: 1,
      turnId: lookupTurn.turnId,
      deliveredAt: Math.max(1, Number(receipt?.receivedAt) || now()),
      items: [{
        kind: 'message',
        id: projection.replyParts[0].messageId,
        checksum: projection.replyParts[0].itemChecksum
      }]
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
    return this.withImmediateTransaction(() => {
      const timestamp = now();
      const current = this.getTurn(turnId);
      this.assertCanonicalAttemptMutableInternal({
        turnId,
        expectedState,
        expectedTurnRevision,
        operation: 'failure'
      });
      const failureClass = String(failure?.failureClass || 'terminal');
      if (!['transient', 'deterministic'].includes(failureClass)) {
        throw new Error('canonical failure class conflict');
      }
      if (failure?.retryAllowed === true && failureClass !== 'transient') {
        throw new Error('canonical deterministic retry permission conflict');
      }
      const wireProtocolVersion = Number(parseJson(current?.envelopeJson, {}).protocolVersion || 0);
      if (wireProtocolVersion === 3 && typeof failure?.retryAllowed !== 'boolean') {
        throw new Error('canonical v3 retry permission must be a native boolean');
      }
      const normalizedFailure = wireProtocolVersion === 3
        ? {
            name: String(failure?.name || 'Error').slice(0, 128),
            code: String(failure?.code || '').slice(0, 128),
            message: String(failure?.message || '').slice(0, 2048),
            failureClass,
            retryAllowed: failure?.retryAllowed,
            failedAt: timestamp
          }
        : {
            name: String(failure?.name || 'Error'),
            message: String(failure?.message || ''),
            failureClass
          };
      if (wireProtocolVersion === 3
        && normalizedFailure.code !== (failureClass === 'transient'
          ? 'YUQI_TRANSIENT_EXECUTION_FAILURE'
          : 'YUQI_DETERMINISTIC_EXECUTION_FAILURE')) {
        throw new Error('canonical v3 failure code conflict');
      }
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
        timestamp,
        String(turnId),
        expectedState,
        Number(expectedTurnRevision)
      );
      if (Number(result.changes) !== 1) {
        throw new Error('canonical turn authority conflict');
      }
      const turn = this.getTurn(turnId);
      if (wireProtocolVersion === 3) {
        const lineage = this.getTurnAuthorityLineage(turn.authorityLineageKey);
        const authority = projectCanonicalFailureForWire({ turn, lineage, failure: normalizedFailure });
        const recoveryAckSeq = Number(this.db.prepare(
          'SELECT ack_seq FROM sync_cursors WHERE peer_id = ?'
        ).get(turn.deviceId)?.ack_seq || 0);
        this.db.prepare(`
          INSERT INTO cloud_deliveries(
            turn_id, peer_id, recovery_ack_seq, state, payload_json, checksum,
            attempts, created_at, updated_at, delivered_at,
            authority_group_id, authority_commit_checksum
          ) VALUES (?, ?, ?, 'waiting', NULL, NULL, 0, ?, ?, NULL, NULL, NULL)
          ON CONFLICT(turn_id, peer_id) DO NOTHING
        `).run(turn.turnId, turn.deviceId, recoveryAckSeq, timestamp, timestamp);
        if (!this.db.prepare(`
          SELECT 1 AS value FROM cloud_deliveries
          WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL
            AND state = 'waiting' AND payload_json IS NULL AND checksum IS NULL
        `).get(turn.turnId, turn.deviceId)) {
          throw new Error('canonical failure delivery authority conflict');
        }
        // The projection is intentionally built in the writer transaction: malformed
        // persisted failure records cannot become a bridge-visible terminal state.
        void authority;
      }
      this.appendSync('turn', turnId, 'state', turn);
      return turn;
    });
  }

  loadCanonicalFailureForBridgeInternal(turnId) {
    const turn = this.getTurn(turnId);
    if (!turn || Number(turn.resultAuthorityVersion) !== 1 || turn.protocolVersion !== 3) {
      throw new Error('canonical failure authority conflict');
    }
    const delivery = this.db.prepare(`
      SELECT d.*
      FROM cloud_deliveries d
      JOIN turns t ON t.turn_id = d.turn_id
      WHERE d.turn_id = ?
        AND d.authority_group_id IS NULL
        AND d.peer_id = t.device_id
        AND NOT EXISTS (
          SELECT 1 FROM cloud_deliveries other
          WHERE other.turn_id = d.turn_id
            AND other.authority_group_id IS NULL
            AND other.peer_id <> t.device_id
        )
    `).get(String(turnId));
    if (!delivery) throw new Error('canonical failure target set conflict');
    this.assertCanonicalFailureDeliveryInternal(delivery);
    const lineage = this.getTurnAuthorityLineage(turn.authorityLineageKey);
    const failure = parseJson(turn.errorJson, null);
    return projectCanonicalFailureForWire({ turn, lineage, failure });
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
      const wireProtocolVersion = Number(parseJson(current.envelopeJson, {}).protocolVersion || 0);
      if (wireProtocolVersion === 3 || failure.retryAllowed === true) {
        throw new Error('canonical v3 failures require an authorized child retry');
      }
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
    const currentTurn = this.getTurn(turnId);
    const wireProtocolVersion = Number(parseJson(currentTurn?.envelopeJson, {}).protocolVersion || 0);
    const existingFailureDelivery = wireProtocolVersion === 3
      ? this.db.prepare(`
        SELECT d.* FROM cloud_deliveries d
        JOIN turns t ON t.turn_id = d.turn_id
        WHERE d.turn_id = ? AND d.peer_id = t.device_id
          AND d.authority_group_id IS NULL
          AND t.result_authority_version = 1
          AND json_extract(t.envelope_json, '$.protocolVersion') = 3
      `).get(String(turnId))
      : null;
    const preserveClosedFailure = Boolean(existingFailureDelivery);
    if (existingFailureDelivery && ['waiting', 'pending'].includes(existingFailureDelivery.state)) {
      const diagnosticRows = this.db.prepare(`
        SELECT diagnostic_id FROM diagnostics
        WHERE turn_id = ? AND stage = 'canonical_failure_delivery_quarantined'
      `).all(String(turnId));
      if (diagnosticRows.length !== 0) {
        throw new Error('canonical failure delivery quarantine diagnostic conflict');
      }
      const quarantined = this.db.prepare(`
        UPDATE cloud_deliveries
        SET state = 'quarantined', payload_json = NULL, checksum = NULL,
            attempts = 0, relay_message_id = NULL, delivered_at = NULL,
            confirmed_at = NULL, updated_at = ?
        WHERE turn_id = ? AND peer_id = ? AND authority_group_id IS NULL
          AND state = ? AND payload_json IS ? AND checksum IS ? AND attempts = ?
          AND relay_message_id IS ? AND delivered_at IS ? AND updated_at = ?
      `).run(
        Number(timestamp), String(turnId), existingFailureDelivery.peer_id,
        existingFailureDelivery.state,
        existingFailureDelivery.payload_json ?? null, existingFailureDelivery.checksum ?? null,
        Number(existingFailureDelivery.attempts), existingFailureDelivery.relay_message_id ?? null,
        existingFailureDelivery.delivered_at ?? null, Number(existingFailureDelivery.updated_at)
      );
      if (Number(quarantined.changes) !== 1) {
        throw new Error('canonical failure delivery quarantine snapshot conflict');
      }
      this.putDiagnostic({
        turnId: String(turnId),
        stage: 'canonical_failure_delivery_quarantined',
        level: 'error',
        detail: { redacted: true, peerId: existingFailureDelivery.peer_id, reason: 'source_cancelled' }
      });
    }
    const turnResult = this.db.prepare(`
      UPDATE turns
      SET state = 'failed', worker_id = NULL,
          error_json = CASE WHEN ? = 1 THEN error_json ELSE ? END, updated_at = ?,
          turn_revision = turn_revision + 1
      WHERE turn_id = ? AND result_authority_version = 1
        AND authority_lineage_key = ? AND reply_json IS NULL
        AND turn_revision = ?
    `).run(
      preserveClosedFailure ? 1 : 0,
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
      this.settleCanaryFailureInternal({
        rolloutKey: result.turn.rolloutKey,
        canaryEpoch: result.turn.canaryEpoch,
        canarySlot: result.turn.canarySlot,
        reasonCode: String(input.reasonCode || 'CANONICAL_CANCELLED'),
        now: input.timestamp || now()
      });
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

  putFactInternal(fact) {
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
  }

  putFact(fact) {
    return this.transaction(() => this.putFactInternal(fact));
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
    return this.listFacts(characterId, options).filter(fact => {
      if ((fact.sourceMessageIds || []).some(messageId => suppressed.has(messageId))) return false;
      return this.validateMemoryFactLifecycleInternal(fact);
    });
  }

  /**
   * Resolve a persisted fact against the same store-owned authority used by
   * conversation clear.  This is intentionally independent of model output:
   * source IDs are joined to durable message/action and turn/group rows, and
   * the optional authority tuple must be an exact projection of those rows.
   */
  resolveMemoryFactEvidenceInternal(fact, { frozen = null, roleId = null } = {}) {
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) {
      throw new Error('memory fact authority conflict');
    }
    const messageIds = fact.sourceMessageIds;
    const actionIds = fact.sourceActionIds == null ? [] : fact.sourceActionIds;
    const nativeIds = value => Array.isArray(value)
      && value.every(id => typeof id === 'string' && id.trim().length > 0)
      && new Set(value).size === value.length;
    if (!nativeIds(messageIds) || !nativeIds(actionIds)
      || (!messageIds.length && !actionIds.length)) {
      throw new Error('memory fact source IDs conflict');
    }
    const expectedRoleId = String(roleId || fact.characterId || '').trim();
    if (!expectedRoleId) throw new Error('memory fact role authority conflict');
    const messages = [];
    const actions = [];
    const lanes = new Set();
    const authorities = [];
    const affectedMessageIds = new Set(frozen?.messageIds || []);
    const affectedActionIds = new Set(frozen?.actionIds || []);
    const affectedTurnIds = new Set(frozen?.turnIds || []);
    const sourceMessageSet = new Set(messageIds);
    const sourceActionSet = new Set(actionIds);
    for (const messageId of messageIds) {
      const row = this.db.prepare(`
        SELECT m.*, t.result_authority_version, t.lane_key, t.envelope_json, t.authority_lineage_key,
               t.character_id AS turn_character_id, t.state AS turn_state,
               g.group_id AS authority_group_id, g.redacted_at AS group_redacted_at,
               r.commit_checksum AS authority_commit_checksum
        FROM messages m
        JOIN turns t ON t.turn_id = m.turn_id
        LEFT JOIN visible_result_groups g ON g.group_id = m.authority_group_id
        LEFT JOIN visible_commit_receipts r ON r.group_id = g.group_id
        WHERE m.message_id = ?
      `).get(messageId);
      if (!row || row.character_id !== expectedRoleId) {
        throw new Error(`memory fact source message authority conflict: ${messageId}`);
      }
      if (row.turn_character_id !== expectedRoleId) {
        throw new Error(`memory fact source message turn authority conflict: ${messageId}`);
      }
      if (row.turn_state === 'cancelled' || typeof row.content !== 'string' || !row.content.trim()) {
        throw new Error(`memory fact source message lifecycle conflict: ${messageId}`);
      }
      let currentBatchAuthority = null;
      if (Number(row.result_authority_version) === 1 && !row.authority_group_id) {
        currentBatchAuthority = this.resolveCurrentBatchAuthorityForMemoryInternal({
          turnId: row.turn_id, messageId, roleId: expectedRoleId
        });
      } else if (Number(row.result_authority_version) === 1
        && (!row.authority_commit_checksum || row.group_redacted_at != null
          || !/^[a-f0-9]{64}$/.test(row.authority_commit_checksum))) {
        throw new Error(`memory fact source message receipt conflict: ${messageId}`);
      }
      let lane = currentBatchAuthority?.lane || String(row.lane_key || '').trim();
      if (!lane) {
        const envelope = parseJson(row.envelope_json, null);
        lane = Number(envelope?.protocolVersion) === 1
          ? 'private_chat'
          : (envelope ? laneKeyForEnvelope(envelope) : '');
      }
      if (!lane) throw new Error(`memory fact source message lane conflict: ${messageId}`);
      lanes.add(lane);
      const authority = {
        authorityGroupId: currentBatchAuthority?.authorityGroupId || row.authority_group_id || null,
        authorityLineageKey: currentBatchAuthority?.authorityLineageKey || row.authority_lineage_key || null,
        authorityCommitChecksum: currentBatchAuthority?.authorityCommitChecksum || row.authority_commit_checksum || null
      };
      messages.push({ row, messageId, lane, affected: affectedMessageIds.has(messageId)
        || affectedTurnIds.has(row.turn_id), authority });
      authorities.push(authority);
    }
    for (const actionId of actionIds) {
      const row = this.db.prepare(`
        SELECT a.*, g.group_id, g.role_id, g.lineage_key, g.authoritative_turn_id,
               g.authority_origin, r.commit_checksum, t.lane_key, t.character_id,
               t.result_authority_version, t.state AS turn_state, t.envelope_json,
               g.redacted_at AS group_redacted_at
        FROM visible_result_actions a
        JOIN visible_result_groups g ON g.group_id = a.group_id
        JOIN turns t ON t.turn_id = g.authoritative_turn_id
        LEFT JOIN visible_commit_receipts r ON r.group_id = g.group_id
        WHERE a.action_id = ?
      `).get(actionId);
      if (!row || row.role_id !== expectedRoleId || row.character_id !== expectedRoleId) {
        throw new Error(`memory fact source action authority conflict: ${actionId}`);
      }
      if (row.turn_state === 'cancelled' || row.redacted_at != null || row.group_redacted_at != null) {
        throw new Error(`memory fact source action lifecycle conflict: ${actionId}`);
      }
      if (Number(row.result_authority_version) !== 1
        || !row.group_id || !row.commit_checksum
        || !/^[a-f0-9]{64}$/.test(row.commit_checksum)) {
        throw new Error(`memory fact source action receipt conflict: ${actionId}`);
      }
      let lane = String(row.lane_key || '').trim();
      if (!lane) {
        const envelope = parseJson(row.envelope_json, null);
        lane = Number(envelope?.protocolVersion) === 1
          ? 'private_chat'
          : (envelope ? laneKeyForEnvelope(envelope) : '');
      }
      if (!lane) throw new Error(`memory fact source action lane conflict: ${actionId}`);
      lanes.add(lane);
      const authority = {
        authorityGroupId: row.group_id || null,
        authorityLineageKey: row.lineage_key || null,
        authorityCommitChecksum: row.commit_checksum || null
      };
      actions.push({ row, actionId, lane, affected: affectedActionIds.has(actionId)
        || affectedTurnIds.has(row.authoritative_turn_id), authority });
      authorities.push(authority);
    }
    if (lanes.size > 1) throw new Error('memory fact mixed lane authority conflict');
    const lane = [...lanes][0];
    if (!['private_chat', 'public_moment', 'moment_thread'].includes(lane)) {
      throw new Error('memory fact lane authority conflict');
    }
    const derivedEvidenceAuthority = {
      authorityGroupIds: [...new Set(authorities.map(item => item.authorityGroupId).filter(Boolean))].sort(),
      lineageKeys: [...new Set(authorities.map(item => item.authorityLineageKey).filter(Boolean))].sort(),
      commitChecksums: [...new Set(authorities.map(item => item.authorityCommitChecksum).filter(Boolean))].sort()
    };
    const survivingAuthorities = [
      ...messages.filter(item => !item.affected).map(item => item.authority),
      ...actions.filter(item => !item.affected).map(item => item.authority)
    ];
    const survivingEvidenceAuthority = {
      authorityGroupIds: [...new Set(survivingAuthorities.map(item => item.authorityGroupId).filter(Boolean))].sort(),
      lineageKeys: [...new Set(survivingAuthorities.map(item => item.authorityLineageKey).filter(Boolean))].sort(),
      commitChecksums: [...new Set(survivingAuthorities.map(item => item.authorityCommitChecksum).filter(Boolean))].sort()
    };
    if (fact.evidenceAuthority != null) {
      const supplied = fact.evidenceAuthority;
      const keys = ['authorityGroupIds', 'commitChecksums', 'lineageKeys'];
      if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
        || canonicalJson(Object.keys(supplied).sort()) !== canonicalJson([...keys].sort())
        || keys.some(key => !Array.isArray(supplied[key])
          || supplied[key].some(value => typeof value !== 'string' || !value.trim())
          || new Set(supplied[key]).size !== supplied[key].length)
        || canonicalJson(supplied) !== canonicalJson(derivedEvidenceAuthority)) {
        throw new Error('memory fact evidence authority conflict');
      }
    }
    return {
      lane,
      messages,
      actions,
      authorities,
      derivedEvidenceAuthority,
      survivingEvidenceAuthority,
      affected: [...messages.filter(item => item.affected).map(item => item.messageId),
        ...actions.filter(item => item.affected).map(item => item.actionId)].sort(),
      surviving: [...messages.filter(item => !item.affected).map(item => item.messageId),
        ...actions.filter(item => !item.affected).map(item => item.actionId)].sort(),
      sourceMessageSet,
      sourceActionSet
    };
  }

  validateMemoryFactLifecycleInternal(fact) {
    if (!fact || fact.status !== 'verified' || fact.redacted || fact.archived
      || fact.withdrawn || fact.superseded) return false;
    let authority;
    try {
      authority = classifyMemoryFactAuthority(fact);
    } catch {
      return false;
    }
    if (authority.kind === 'config') return true;
    try {
      const resolved = this.resolveMemoryFactEvidenceInternal(fact);
      if (['public_moment', 'moment_thread'].includes(resolved.lane)) return true;
      return resolved.lane === 'private_chat' && resolved.affected.length === 0;
    } catch {
      return false;
    }
  }

  prepareMemoryPruneInternal({ roleId, frozen, controlId, redactedAt }) {
    const rows = this.db.prepare(`
      SELECT * FROM facts
      WHERE character_id = ? AND status NOT IN ('archived', 'redacted')
      ORDER BY fact_id
    `).all(String(roleId));
    const plan = [];
    for (const row of rows) {
      const fact = mapFact(row);
      if (!fact) throw new Error('memory fact authority conflict');
      const authority = classifyMemoryFactAuthority(fact);
      if (authority.kind === 'config') continue;
      const resolved = this.resolveMemoryFactEvidenceInternal(fact, { frozen, roleId });
      if (resolved.lane !== 'private_chat') {
        if (resolved.affected.length) throw new Error(`memory fact public lane conflict: ${fact.factId}`);
        continue;
      }
      if (!resolved.affected.length) continue;
      if (resolved.surviving.length && resolved.lane !== 'private_chat') {
        throw new Error(`memory fact mixed lane conflict: ${fact.factId}`);
      }
      plan.push({ row, fact, resolved, controlId: String(controlId), redactedAt: Number(redactedAt) });
    }
    return { facts: plan };
  }

  appendSyncAtInternal(entityType, entityId, operation, payload, createdAt) {
    const payloadJson = canonicalJson(payload);
    const checksum = contentHash(payload);
    const result = this.db.prepare(`
      INSERT INTO sync_log(entity_type, entity_id, operation, payload_json, checksum, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(entityType, entityId, operation, payloadJson, checksum, Number(createdAt));
    return Number(result.lastInsertRowid);
  }

  assertMemoryPruneClosureInternal({ controlId, roleId, redactedAt }) {
    const audits = this.db.prepare(`
      SELECT * FROM sync_log WHERE entity_type = 'fact_redaction' ORDER BY seq
    `).all();
    const matching = [];
    for (const row of audits) {
      const payload = parseJson(row.payload_json, null);
      if (payload?.controlId === String(controlId)) matching.push({ row, payload });
    }
    const summaries = this.db.prepare(
      "SELECT * FROM sync_log WHERE entity_type = 'fact_redaction_set' AND entity_id = ? ORDER BY seq"
    ).all(String(controlId));
    if (summaries.length !== 1) throw new Error('memory fact redaction set audit conflict');
    const summaryPayload = parseJson(summaries[0].payload_json, null);
    const summaryKeys = [
      'auditVersion', 'controlId', 'factCommitment', 'factCount', 'redactedAt', 'roleId'
    ];
    if (!summaryPayload || canonicalJson(Object.keys(summaryPayload).sort())
      !== canonicalJson(summaryKeys.sort())
      || summaryPayload.auditVersion !== 'fact-redaction-set-v1'
      || summaryPayload.controlId !== String(controlId)
      || summaryPayload.roleId !== String(roleId)
      || summaryPayload.redactedAt !== Number(redactedAt)
      || !Number.isSafeInteger(summaryPayload.factCount)
      || summaryPayload.factCount !== matching.length
      || !/^[a-f0-9]{64}$/.test(summaryPayload.factCommitment || '')
      || summaries[0].checksum !== contentHash(summaryPayload)) {
      throw new Error('memory fact redaction set summary conflict');
    }
    const seen = new Set();
    for (const { row, payload } of matching) {
      const expectedKeys = [
        'auditVersion', 'controlId', 'factId', 'newChecksum', 'oldChecksum',
        'redactedAt', 'replacementFactId', 'roleId'
      ];
      if (canonicalJson(Object.keys(payload).sort()) !== canonicalJson(expectedKeys.sort())
        || payload.auditVersion !== 'fact_redaction_v1'
        || payload.roleId !== String(roleId)
        || payload.factId !== row.entity_id
        || payload.redactedAt !== Number(redactedAt)
        || !/^[a-f0-9]{64}$/.test(payload.oldChecksum || '')
        || !/^[a-f0-9]{64}$/.test(payload.newChecksum || '')
        || row.checksum !== contentHash(payload)
        || seen.has(payload.factId)) {
        throw new Error(`memory fact redaction audit conflict: ${row.entity_id}`);
      }
      seen.add(payload.factId);
      const factRow = this.db.prepare('SELECT * FROM facts WHERE fact_id = ?').get(payload.factId);
      const shell = {
        factId: payload.factId,
        characterId: String(roleId),
        status: 'archived',
        redacted: true,
        redactedAt: Number(redactedAt)
      };
      if (!factRow || factRow.checksum !== payload.newChecksum
        || canonicalJson(parseJson(factRow.fact_json, null)) !== canonicalJson(shell)
        || factRow.subject_id !== '__redacted__' || factRow.predicate !== 'redacted'
        || factRow.object_json !== 'null' || factRow.evidence_mode !== 'redacted'
        || factRow.source_message_ids_json !== '[]' || factRow.exact_quotes_json !== '[]'
        || factRow.status !== 'archived' || Number(factRow.confidence) !== 0
        || factRow.origin !== 'redacted' || factRow.verified_at != null) {
        throw new Error(`memory fact redaction shell conflict: ${payload.factId}`);
      }
      if (payload.replacementFactId != null) {
        if (typeof payload.replacementFactId !== 'string' || !payload.replacementFactId.trim()) {
          throw new Error(`memory fact replacement identity conflict: ${payload.factId}`);
        }
        const replacement = this.db.prepare(
          'SELECT * FROM facts WHERE fact_id = ?'
        ).get(payload.replacementFactId);
        const replacementFact = mapFact(replacement);
        if (!replacement || !replacementFact || replacementFact.supersedes !== payload.factId
          || replacementFact.status === 'archived' || replacementFact.redacted
          || !this.validateMemoryFactLifecycleInternal(replacementFact)) {
          throw new Error(`memory fact replacement conflict: ${payload.factId}`);
        }
      }
    }
    if (summaryPayload.factCommitment !== factRedactionSetCommitment({
      controlId, roleId, entries: matching.map(({ payload }) => payload)
    })) {
      throw new Error('memory fact redaction set commitment conflict');
    }
    return matching.length;
  }

  applyMemoryPrunePlanInternal(plan, { roleId, controlId, redactedAt }) {
    const facts = Array.isArray(plan) ? plan : (plan?.facts || []);
    const auditEntries = [];
    for (const entry of facts) {
      const { row, fact, resolved } = entry;
      if (row.checksum !== contentHash(fact)) throw new Error(`memory fact checksum conflict: ${fact.factId}`);
      const survivingMessageIds = fact.sourceMessageIds.filter(id => resolved.surviving.includes(id));
      const survivingActionIds = (fact.sourceActionIds || []).filter(id => resolved.surviving.includes(id));
      if (!survivingMessageIds.length && !survivingActionIds.length) {
        const shell = {
          factId: fact.factId,
          characterId: fact.characterId,
          status: 'archived',
          redacted: true,
          redactedAt: Number(redactedAt)
        };
        const newChecksum = contentHash(shell);
        const updated = this.db.prepare(`
          UPDATE facts SET subject_id = '__redacted__', predicate = 'redacted',
            object_json = 'null', evidence_mode = 'redacted',
            source_message_ids_json = '[]', exact_quotes_json = '[]',
            status = 'archived', confidence = 0, origin = 'redacted',
            checksum = ?, verified_at = NULL, fact_json = ?
          WHERE fact_id = ? AND checksum = ? AND status NOT IN ('archived', 'redacted')
        `).run(newChecksum, canonicalJson(shell), fact.factId, row.checksum);
        if (Number(updated.changes) !== 1) throw new Error(`memory fact CAS conflict: ${fact.factId}`);
        const audit = {
          auditVersion: 'fact_redaction_v1',
          controlId: String(controlId),
          roleId: String(roleId),
          factId: fact.factId,
          oldChecksum: row.checksum,
          newChecksum,
          redactedAt: Number(redactedAt),
          replacementFactId: null
        };
        this.appendSyncAtInternal('fact_redaction', fact.factId, 'redact', audit, redactedAt);
        auditEntries.push(audit);
        continue;
      }
      const survivingEvidenceChecksum = contentHash({
        sourceMessageIds: survivingMessageIds,
        sourceActionIds: survivingActionIds,
        evidenceAuthority: resolved.survivingEvidenceAuthority
      });
      const replacementFactId = stableId('fact_prune', `${fact.factId}:${controlId}:${survivingEvidenceChecksum}`);
      const replacement = {
        ...fact,
        factId: replacementFactId,
        supersedes: fact.factId,
        sourceMessageIds: survivingMessageIds,
        sourceActionIds: survivingActionIds,
        exactQuotes: (fact.exactQuotes || []).filter(quote => survivingMessageIds.includes(quote.messageId)),
        exactActions: (fact.exactActions || []).filter(action => survivingActionIds.includes(action.actionId)),
        evidenceAuthority: resolved.survivingEvidenceAuthority,
        createdAt: Number(redactedAt),
        verifiedAt: resolved.messages.every(item => item.row.delivery_state === 'confirmed')
          ? (fact.verifiedAt ?? Number(redactedAt)) : null
      };
      const replacementChecksum = contentHash(replacement);
      const archivedChecksum = contentHash({ factId: fact.factId, characterId: fact.characterId,
        status: 'archived', redacted: true, redactedAt: Number(redactedAt) });
      const archived = this.db.prepare(`
        UPDATE facts SET subject_id = '__redacted__', predicate = 'redacted',
          object_json = 'null', evidence_mode = 'redacted', source_message_ids_json = '[]',
          exact_quotes_json = '[]', status = 'archived', confidence = 0, origin = 'redacted',
          checksum = ?, verified_at = NULL, fact_json = ?
        WHERE fact_id = ? AND checksum = ? AND status NOT IN ('archived', 'redacted')
      `).run(archivedChecksum,
      canonicalJson({ factId: fact.factId, characterId: fact.characterId, status: 'archived',
        redacted: true, redactedAt: Number(redactedAt) }), fact.factId, row.checksum);
      if (Number(archived.changes) !== 1) throw new Error(`memory fact CAS conflict: ${fact.factId}`);
      this.db.prepare(`
        INSERT INTO facts(
          fact_id, character_id, subject_id, predicate, object_json, evidence_mode,
          source_message_ids_json, exact_quotes_json, status, confidence, supersedes,
          origin, checksum, created_at, verified_at, fact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        replacement.factId, replacement.characterId, replacement.subjectId, replacement.predicate,
        canonicalJson(replacement.object ?? null), replacement.evidenceMode || 'uncertain',
        canonicalJson(replacement.sourceMessageIds), canonicalJson(replacement.exactQuotes),
        replacement.status, replacement.confidence, replacement.supersedes,
        replacement.origin, replacementChecksum, replacement.createdAt, replacement.verifiedAt,
        canonicalJson(replacement)
      );
      const audit = {
        auditVersion: 'fact_redaction_v1', controlId: String(controlId), roleId: String(roleId),
        factId: fact.factId, oldChecksum: row.checksum,
        newChecksum: archivedChecksum,
        redactedAt: Number(redactedAt), replacementFactId
      };
      this.appendSyncAtInternal('fact_redaction', fact.factId, 'redact', audit, redactedAt);
      this.appendSyncAtInternal('fact', replacement.factId, 'insert', replacement, redactedAt);
      auditEntries.push(audit);
    }
    const summary = {
      auditVersion: 'fact-redaction-set-v1',
      controlId: String(controlId),
      roleId: String(roleId),
      factCount: auditEntries.length,
      factCommitment: factRedactionSetCommitment({ controlId, roleId, entries: auditEntries }),
      redactedAt: Number(redactedAt)
    };
    this.appendSyncAtInternal('fact_redaction_set', String(controlId), 'redact', summary, redactedAt);
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

  putLifePlanInternal(characterId, episodes, {
    sourceTurnId = null,
    writerToken = null
  } = {}) {
    const safeCharacterId = String(characterId || '');
    if (!safeCharacterId || !Array.isArray(episodes)) throw new Error('invalid life plan');
    const trustedWriter = writerToken === TRUSTED_LIFE_RESULT_WRITER;
    for (const item of episodes) {
      if (item?.payload && typeof item.payload === 'object'
        && !Array.isArray(item.payload)
        && Object.hasOwn(item.payload, 'publicMomentCandidate')) {
        if (!trustedWriter) {
          throw new Error('reserved public moment candidate requires trusted life-result writer');
        }
        validateTrustedPublicMomentCandidate(item.payload.publicMomentCandidate);
      }
    }
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

  assertPersistedLifePlanningAttemptAuthorityInternal(planningIdOrAttempt) {
    const planningId = typeof planningIdOrAttempt === 'string'
      ? planningIdOrAttempt
      : planningIdOrAttempt?.planningId;
    const attempt = this.getLifePlanningAttempt(planningId);
    if (!attempt) throw new Error('life planning attempt authority conflict: missing');
    if (!['created', 'running', 'retry_wait', 'result_committed', 'completed', 'failed', 'cancelled']
      .includes(attempt.executionState)) {
      throw new Error('life planning attempt authority conflict: execution state');
    }
    assertLifePlanningAttemptPins(attempt, this);
    if (attempt.executionState === 'completed' && !attempt.authoritativeResultChecksum) {
      throw new Error('life planning attempt authority conflict: completed proof');
    }
    return attempt;
  }

  createLifePlanningAttemptInternal(attempt) {
    const roleId = String(attempt?.roleId || '');
    if (!roleId) throw new Error('life planning role is required');
    const existingOpen = this.getOpenLifePlanningAttempt(roleId);
    if (existingOpen) {
      this.assertPersistedLifePlanningAttemptAuthorityInternal(existingOpen.planningId);
      assertLifePlanningAttemptReuseIdentity(existingOpen, { ...attempt, roleId });
      return existingOpen;
    }
    const exact = this.getLifePlanningAttemptByRequestKey(attempt.requestKey);
    if (exact) {
      this.assertPersistedLifePlanningAttemptAuthorityInternal(exact.planningId);
      assertLifePlanningAttemptReuseIdentity(exact, { ...attempt, roleId });
      if (exact.authoritativeResultChecksum) this.assertLifePlanningTerminalReplayInternal(exact);
      return exact;
    }
    assertLifePlanningInputAuthority({
      ...attempt,
      roleId,
      inputSnapshot: attempt.inputSnapshot
    }, this);
    const rolloutRow = this.db.prepare(
      'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
    ).get('LIFE_PLANNING');
    if (!rolloutRow || Number(rolloutRow.revision) !== Number(attempt.rolloutRevision)) {
      throw new RolloutRevisionConflictError();
    }
    const rollout = mapCognitionRollout(rolloutRow);
    const pair = resolvePipelinePair(rollout);
    const comparison = comparisonContractForDirection(pair.comparisonDirection);
    if (String(attempt.authoritativeReleaseId || '') !== pair.visibleReleaseId
      || String(attempt.comparisonReleaseId || '') !== String(pair.comparisonReleaseId || '')
      || String(attempt.comparisonDirection || '') !== String(comparison.comparisonDirection || '')
      || String(attempt.comparisonMode || '') !== comparison.comparisonMode
      || String(attempt.pipelineMode || '') !== rollout.currentMode) {
      throw new RolloutRevisionConflictError('life planning rollout release pair conflict');
    }
    const authoritativeRelease = this.getPipelineRelease(pair.visibleReleaseId);
    const comparisonRelease = pair.comparisonReleaseId
      ? this.getPipelineRelease(pair.comparisonReleaseId)
      : null;
    if (!authoritativeRelease
      || authoritativeRelease.releaseChecksum !== attempt.authoritativePipelineChecksum
      || attempt.pipelineChecksum !== authoritativeRelease.releaseChecksum
      || attempt.presetVersion !== authoritativeRelease.presetVersion
      || (comparisonRelease
        ? comparisonRelease.releaseChecksum !== attempt.comparisonPipelineChecksum
        : attempt.comparisonPipelineChecksum != null)) {
      throw new Error('life planning release checksum authority conflict');
    }
    const reservesCanaryComparison = pair.candidatePhase === 'canary'
      && pair.comparisonReleaseId !== null;
    const canarySlot = reservesCanaryComparison
      ? Number(rollout.canaryStartedCount) + 1
      : null;
    if (reservesCanaryComparison) {
      const outstanding = this.readCanaryOutstandingAuthorityInternal({
        rolloutKey: 'LIFE_PLANNING',
        canaryEpoch: rollout.canaryEpoch
      });
      if (outstanding.count >= rollout.canaryMaxOutstanding) {
        throw new Error('canary outstanding authority limit reached');
      }
      const reservation = this.db.prepare(`
        UPDATE cognition_kind_rollouts
        SET revision = revision + 1,
            canary_started_count = canary_started_count + 1,
            canary_started_at = COALESCE(canary_started_at, ?),
            updated_at = ?
        WHERE rollout_key = ? AND revision = ?
          AND canary_started_count < canary_target_count
          AND (
            canary_started_count - canary_completed_count - canary_failure_count
          ) < canary_max_outstanding
      `).run(
        Number(attempt.now || now()),
        Number(attempt.now || now()),
        'LIFE_PLANNING',
        Number(attempt.rolloutRevision)
      );
      if (Number(reservation.changes) !== 1) {
        throw new RolloutRevisionConflictError('life canary reservation conflict');
      }
    }
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
        canary_slot, authoritative_release_id, comparison_release_id,
        authoritative_pipeline_checksum, comparison_pipeline_checksum,
        preset_version, input_snapshot_json, input_checksum,
        execution_state, comparison_state, attempt_count, due_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'LIFE_PLANNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'created', ?, 0, ?, ?, ?)
    `).run(
      planningId, attempt.requestBaseKey, attempt.requestKey, roleId, revision,
      Number(attempt.planningWindowStartAt), Number(attempt.planningWindowEndAt),
      attempt.lifeBasisChecksum, attempt.contextChecksum, attempt.pipelineMode,
      comparisonMode, attempt.authoritativePipeline, attempt.comparisonDirection || null,
      Number(attempt.rolloutRevision), Number(attempt.rolloutEvidenceEpoch),
      attempt.pipelineChecksum, attempt.shadowEpoch ?? null, attempt.canaryEpoch ?? null,
      canarySlot, authoritativeRelease.releaseId, comparisonRelease?.releaseId || null,
      authoritativeRelease.releaseChecksum, comparisonRelease?.releaseChecksum || null,
      attempt.presetVersion, inputSnapshotJson, inputChecksum,
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

  assertLifePlanningTerminalReplayInternal(attempt) {
    assertLifePlanningAttemptEvidence(attempt, this);
    const storedResult = attempt.authoritativeResult;
    if (!storedResult || typeof storedResult !== 'object' || Array.isArray(storedResult)
      || !Array.isArray(storedResult.episodes)
      || contentHash(storedResult) !== attempt.authoritativeResultChecksum) {
      throw new Error('life planning result authority conflict');
    }
    const expectedEpisodes = storedResult.episodes;
    const expectedIds = expectedEpisodes.map(item => item?.episodeId);
    if (expectedEpisodes.some(item => !item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.episodeId !== 'string' || !item.episodeId)
      || new Set(expectedIds).size !== expectedIds.length) {
      throw new Error('life planning episode authority conflict');
    }
    const persistedEpisodes = this.db.prepare(`
      SELECT * FROM life_episodes
      WHERE character_id = ? AND source_turn_id = ?
      ORDER BY episode_id
    `).all(attempt.roleId, attempt.planningId).map(mapLifeEpisode);
    if (persistedEpisodes.length !== expectedEpisodes.length) {
      throw new Error('life planning episode authority conflict');
    }
    const persistedById = new Map(persistedEpisodes.map(item => [item.episodeId, item]));
    for (const expected of expectedEpisodes) {
      const persisted = persistedById.get(expected.episodeId);
      if (!persisted) throw new Error('life planning episode authority conflict');
      const expectedPayload = expected.payload && typeof expected.payload === 'object'
        && !Array.isArray(expected.payload) ? expected.payload : {};
      const expectedStored = {
        episodeId: expected.episodeId,
        characterId: attempt.roleId,
        kind: expected.kind,
        title: expected.title,
        startAt: expected.startAt,
        endAt: expected.endAt,
        payload: expectedPayload
      };
      if (persisted.sourceTurnId !== attempt.planningId
        || persisted.kind !== expected.kind
        || persisted.title !== expected.title
        || persisted.startAt !== expected.startAt
        || persisted.endAt !== expected.endAt
        || canonicalJson(persisted.payload) !== canonicalJson(expectedPayload)
        || persisted.checksum !== contentHash(expectedStored)) {
        throw new Error('life planning episode authority conflict');
      }
      if (Object.hasOwn(expectedPayload, 'publicMomentCandidate')) {
        validateTrustedPublicMomentCandidate(expectedPayload.publicMomentCandidate);
      }
    }
    if (attempt.comparisonMode === 'none') {
      if (attempt.compareJobId) throw new Error('life planning comparison authority conflict');
      return;
    }
    const job = this.getConsolidationJob(attempt.compareJobId);
    if (!job || job.subjectType !== 'life_planning' || job.subjectId !== attempt.planningId
      || job.payloadChecksum !== contentHash(job.payload)
      || job.payload.authoritativeResultChecksum !== attempt.authoritativeResultChecksum) {
      throw new Error('life planning comparison authority conflict');
    }
  }

  commitLifePlanningResultInternal({ planningId, workerId, validatedResult, now: committedAt = now() }) {
    const attempt = this.getLifePlanningAttempt(planningId);
    if (!attempt) throw new Error('life planning attempt not found');
    const validated = assertLifePlanningValidatedResultShape(validatedResult);
    const result = {
      episodes: validated.episodes.map((item, index) => ({
        ...item,
        episodeId: `life:${planningId}:${index + 1}`
      }))
    };
    const checksum = contentHash(result);
    if (attempt.authoritativeResultChecksum) {
      if (attempt.authoritativeResultChecksum !== checksum) throw new LifePlanningResultConflictError();
      this.assertLifePlanningTerminalReplayInternal(attempt);
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
      this.settleCanaryFailureInternal({
        rolloutKey: attempt.rolloutKey,
        canaryEpoch: attempt.canaryEpoch,
        canarySlot: attempt.canarySlot,
        reasonCode: 'LIFE_BASIS_STALE',
        now: committedAt
      });
      return this.getLifePlanningAttempt(planningId);
    }
    assertLifePlanningAttemptEvidence(attempt, this);
    for (const episode of result.episodes) {
      if (episode.payload && Object.hasOwn(episode.payload, 'publicMomentCandidate')) {
        validateTrustedPublicMomentCandidate(episode.payload.publicMomentCandidate);
      }
    }
    this.putLifePlanInternal(attempt.roleId, result.episodes, {
      sourceTurnId: planningId,
      writerToken: TRUSTED_LIFE_RESULT_WRITER
    });
    let compareJob = null;
    if (attempt.comparisonMode !== 'none') {
      const comparison = comparisonContractForMode(attempt.comparisonMode);
      if (comparison.comparisonDirection !== attempt.comparisonDirection
        || !attempt.comparisonReleaseId || !attempt.comparisonPipelineChecksum) {
        throw new Error('life planning comparison authority conflict');
      }
      compareJob = this.createConsolidationJobInternal({
        subjectType: 'life_planning',
        subjectId: planningId,
        roleId: attempt.roleId,
        jobType: comparison.jobType,
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
          authoritativeReleaseId: attempt.authoritativeReleaseId,
          comparisonReleaseId: attempt.comparisonReleaseId,
          authoritativePipelineChecksum: attempt.authoritativePipelineChecksum,
          comparisonPipelineChecksum: attempt.comparisonPipelineChecksum,
          comparisonDirection: comparison.comparisonDirection,
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
    this.settleCanaryFailureInternal({
      rolloutKey: attempt.rolloutKey,
      canaryEpoch: attempt.canaryEpoch,
      canarySlot: attempt.canarySlot,
      reasonCode: String(errorCode || 'LIFE_PLANNING_FAILED'),
      now: failedAt
    });
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
    throw new CognitiveStateConflictError('cognitive state deletion is unsupported');
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

  validateConsolidationJobLifecycleInternal({
    jobId, workerId, roleId, sourceMessageIds = [], sourceActionIds = [], now: at = now()
  } = {}) {
    const job = this.db.prepare('SELECT * FROM consolidation_jobs WHERE job_id = ?')
      .get(String(jobId || ''));
    if (!job || job.state !== 'running' || job.lease_owner !== String(workerId || '')
      || !Number.isSafeInteger(Number(job.lease_expires_at))
      || Number(job.lease_expires_at) <= Number(at)) {
      throw new Error('consolidation job lease lifecycle conflict');
    }
    if (String(job.role_id || '') !== String(roleId || '')) {
      throw new Error('consolidation job role lifecycle conflict');
    }
    if (!Array.isArray(sourceMessageIds) && !Array.isArray(sourceActionIds)) {
      throw new Error('consolidation source IDs conflict');
    }
    if (sourceMessageIds.length === 0 && sourceActionIds.length === 0) {
      return { job: mapConsolidationJob(job), resolved: null };
    }
    const fact = {
      factId: `job:${job.job_id}`,
      characterId: String(roleId || ''),
      status: 'verified',
      origin: 'consolidation',
      sourceMessageIds,
      sourceActionIds
    };
    const resolved = this.resolveMemoryFactEvidenceInternal(fact, { roleId });
    if (!resolved || resolved.affected.length) throw new Error('consolidation source lifecycle conflict');
    return { job: mapConsolidationJob(job), resolved };
  }

  /**
   * Commit consolidation facts only after the final source projection and
   * worker lease have been revalidated in the same BEGIN IMMEDIATE transaction
   * as the first fact write.  Conversation clear uses the same transaction
   * boundary, so whichever transaction wins the source CAS is authoritative.
   */
  commitConsolidationFactsInternal({
    jobId, workerId, roleId, candidates = [], rawMessages = [], now: at = now(),
    faultAfterStep = null
  } = {}) {
    if (!Array.isArray(candidates) || !Array.isArray(rawMessages)) {
      throw new Error('consolidation candidate input conflict');
    }
    return this.transaction(() => {
      const sourceMessageIds = [...new Set(candidates.flatMap(candidate =>
        Array.isArray(candidate?.sourceMessageIds) ? candidate.sourceMessageIds : []))];
      const sourceActionIds = [...new Set(candidates.flatMap(candidate =>
        Array.isArray(candidate?.sourceActionIds) ? candidate.sourceActionIds : []))];
      const gate = this.validateConsolidationJobLifecycleInternal({
        jobId, workerId, roleId, sourceMessageIds, sourceActionIds, now: at
      });
      if (faultAfterStep === 'after_source_revalidation') {
        throw new Error('forced consolidation commit fault: after_source_revalidation');
      }
      const persistedEvidence = [
        ...(gate.resolved?.messages || []).map(item => ({
          messageId: item.row.message_id,
          speakerId: item.row.speaker_id,
          speakerType: item.row.speaker_type,
          content: item.row.content,
          sentAt: item.row.sent_at,
          committed: true,
          authorityVerified: true,
          resultAuthorityVersion: Number(item.row.result_authority_version) || 1,
          turnState: item.row.turn_state || 'committed',
          authorityGroupId: item.authority.authorityGroupId,
          authorityLineageKey: item.authority.authorityLineageKey,
          authorityCommitChecksum: item.authority.authorityCommitChecksum,
          deliveryState: item.row.delivery_state
            || (item.row.speaker_type === 'character' ? 'confirmed' : 'input'),
          redacted: false
        })),
        ...(gate.resolved?.actions || []).map(item => ({
          evidenceKind: 'action',
          actionId: item.row.action_id,
          kind: item.row.kind,
          targetKey: item.row.target_key,
          targetRevision: item.row.target_revision,
          payload: parseJson(item.row.payload_json, null),
          actionChecksum: item.row.action_checksum,
          authorityVerified: true,
          resultAuthorityVersion: Number(item.row.result_authority_version) || 1,
          turnState: item.row.turn_state || 'committed',
          authorityGroupId: item.authority.authorityGroupId,
          authorityLineageKey: item.authority.authorityLineageKey,
          authorityCommitChecksum: item.authority.authorityCommitChecksum,
          authorityRoleId: roleId,
          deliveryState: 'confirmed',
          redacted: false
        }))
      ];
      const result = { verified: [], provisional: [], rejected: [] };
      const verified = [];
      for (const candidate of candidates) {
        // rawMessages is retained only for the worker API shape; all candidate
        // quote/action content is checked against the persisted projection
        // captured above, never against a caller/model-owned array.
        const validation = validateConsolidationCandidate(candidate, persistedEvidence);
        if (validation.status === 'rejected') {
          result.rejected.push(validation);
          continue;
        }
        if (validation.fact.characterId !== String(roleId || '')) {
          throw new Error('consolidation candidate role authority conflict');
        }
        this.resolveMemoryFactEvidenceInternal(validation.fact, { roleId });
        verified.push(validation);
      }
      for (const validation of verified) {
        this.putFactInternal(validation.fact);
        result.verified.push(validation);
      }
      if (faultAfterStep === 'after_fact_write') {
        throw new Error('forced consolidation commit fault: after_fact_write');
      }
      void gate;
      return result;
    });
  }

  loadComparisonExecutionAuthorityInternal({ jobId, workerId }) {
    const job = this.getConsolidationJob(jobId);
    if (!job || job.state !== 'running' || job.leaseOwner !== String(workerId || '')) {
      throw new Error('comparison job lease authority conflict');
    }
    if (!['shadow_cognition', 'active_canary_compare'].includes(job.jobType)
      || contentHash(job.payload) !== job.payloadChecksum) {
      throw new Error('comparison job payload authority conflict');
    }
    let contract = null;
    try {
      contract = comparisonContractForDirection(job.payload.comparisonDirection);
    } catch {
      const legacyJobType = job.payload.comparisonDirection === 'legacy_authoritative_cognition_compare'
        ? 'shadow_cognition'
        : job.payload.comparisonDirection === 'cognition_authoritative_legacy_compare'
          ? 'active_canary_compare'
          : null;
      if (legacyJobType !== job.jobType || job.authorityGroupId) {
        throw new Error('comparison direction authority conflict');
      }
      if (job.subjectType === 'life_planning') {
        const attempt = this.getLifePlanningAttempt(job.subjectId);
        if (!attempt
          || contentHash(attempt.inputSnapshot) !== attempt.inputChecksum
          || contentHash(attempt.authoritativeResult) !== attempt.authoritativeResultChecksum) {
          throw new Error('legacy life comparison execution authority conflict');
        }
        if (['cancelled', 'failed'].includes(attempt.executionState)) {
          return {
            status: 'cancelled_redacted',
            authorityVersion: 0,
            subjectType: 'life_planning',
            subjectId: attempt.planningId
          };
        }
        return {
          status: 'ready',
          authorityVersion: 0,
          subjectType: 'life_planning',
          subjectId: attempt.planningId,
          comparisonDirection: job.payload.comparisonDirection,
          authoritativeResult: attempt.authoritativeResult,
          execution: { attempt, inputSnapshot: attempt.inputSnapshot }
        };
      }
      if (job.subjectType !== 'turn') {
        throw new Error('legacy comparison subject authority conflict');
      }
      const turn = this.getTurn(job.turnId);
      if (!turn || Number(turn.resultAuthorityVersion || 0) !== 0) {
        throw new Error('legacy comparison turn authority conflict');
      }
      const envelope = parseJson(turn.envelopeJson, {});
      const pinnedInput = {
        envelope,
        route: turn.route,
        routeReasons: turn.routeReasons,
        presetVersion: turn.presetVersion,
        annotationSnapshot: turn.annotationSnapshot
      };
      const authoritativeResult = parseJson(turn.replyJson, {});
      if (contentHash(pinnedInput) !== job.payload.inputChecksum
        || contentHash(authoritativeResult) !== job.payload.authoritativeResultChecksum) {
        throw new Error('legacy comparison input authority conflict');
      }
      const currentBatch = this.getCurrentUserBatch(turn.turnId);
      return {
        status: 'ready',
        authorityVersion: 0,
        subjectType: 'turn',
        subjectId: job.payload.subjectId || turn.turnId,
        comparisonDirection: job.payload.comparisonDirection,
        authoritativeResult,
        execution: {
          turn,
          envelope,
          currentBatch,
          scene: {},
          routeDecision: {
            route: turn.route,
            allowedActionTargets: [envelope.characterId, 'user']
          }
        }
      };
    }
    if (contract.jobType !== job.jobType) {
      throw new Error('comparison direction authority conflict');
    }
    if (job.subjectType === 'life_planning') {
      const attempt = this.getLifePlanningAttempt(job.subjectId);
      if (!attempt || attempt.compareJobId !== job.jobId
        || attempt.comparisonReleaseId !== job.payload.comparisonReleaseId
        || attempt.comparisonPipelineChecksum !== job.payload.comparisonPipelineChecksum
        || attempt.comparisonDirection !== job.payload.comparisonDirection
        || attempt.authoritativeResultChecksum !== job.payload.authoritativeResultChecksum
        || attempt.inputChecksum !== job.payload.inputChecksum
        || contentHash(attempt.inputSnapshot) !== attempt.inputChecksum
        || contentHash(attempt.authoritativeResult) !== attempt.authoritativeResultChecksum) {
        throw new Error('life comparison execution authority conflict');
      }
      if (['cancelled', 'failed'].includes(attempt.executionState)) {
        return {
          status: 'cancelled_redacted',
          authorityVersion: 1,
          subjectType: 'life_planning',
          subjectId: attempt.planningId
        };
      }
      return {
        status: 'ready',
        authorityVersion: 1,
        subjectType: 'life_planning',
        subjectId: attempt.planningId,
        comparisonReleaseId: attempt.comparisonReleaseId,
        comparisonReleaseChecksum: attempt.comparisonPipelineChecksum,
        comparisonDirection: attempt.comparisonDirection,
        authoritativeResult: attempt.authoritativeResult,
        execution: {
          attempt,
          inputSnapshot: attempt.inputSnapshot
        }
      };
    }
    if (job.subjectType !== 'turn' || !job.authorityGroupId) {
      throw new Error('comparison subject authority conflict');
    }
    const closure = this.assertVisibleGroupAuthorityInternal(job.authorityGroupId, {
      purpose: 'comparison'
    });
    if (closure.status === 'redacted') {
      return {
        status: 'cancelled_redacted',
        authorityVersion: 1,
        subjectType: 'turn',
        subjectId: closure.group.authorityLineageKey
      };
    }
    const receipt = closure.receipt;
    const turn = this.getTurn(receipt.authoritativeTurnId);
    const envelope = turn ? parseJson(turn.envelopeJson, {}) : {};
    const expectedInputChecksum = turn ? contentHash({
      envelope,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonPipelineChecksum: turn.comparisonPipelineChecksum,
      rolloutRevision: turn.rolloutRevision,
      rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
      shadowEpoch: turn.shadowEpoch,
      canaryEpoch: turn.canaryEpoch,
      canarySlot: turn.canarySlot
    }) : null;
    const comparisonRelease = turn?.comparisonReleaseId
      ? this.getPipelineRelease(turn.comparisonReleaseId)
      : null;
    if (!turn || Number(turn.resultAuthorityVersion) !== 1
      || job.turnId !== turn.turnId
      || job.subjectId !== turn.authorityLineageKey
      || job.payload.comparisonReleaseId !== turn.comparisonReleaseId
      || job.payload.comparisonDirection !== contract.comparisonDirection
      || Number(job.payload.rolloutEvidenceEpoch) !== Number(turn.rolloutEvidenceEpoch)
      || (job.payload.shadowEpoch ?? null) !== (turn.shadowEpoch ?? null)
      || (job.payload.canaryEpoch ?? null) !== (turn.canaryEpoch ?? null)
      || (job.payload.canarySlot ?? null) !== (turn.canarySlot ?? null)
      || job.payload.annotationSnapshotChecksum !== contentHash(turn.annotationSnapshot || {})
      || job.payload.inputChecksum !== expectedInputChecksum
      || !comparisonRelease
      || comparisonRelease.releaseChecksum !== turn.comparisonPipelineChecksum
      || job.payload.authoritativeResultChecksum !== receipt.commitChecksum) {
      throw new Error('canonical comparison execution authority conflict');
    }
    const items = this.visibleItemsForGroup(job.authorityGroupId).map(item => ({
      ...item.item,
      messageId: item.messageId,
      ordinal: item.ordinal
    }));
    const actions = this.actionsForGroup(job.authorityGroupId).map(action => ({
      ...action.action,
      actionId: action.actionId,
      ordinal: action.ordinal,
      kind: action.kind,
      targetKey: action.targetKey,
      targetRevision: action.targetRevision
    }));
    return {
      status: 'ready',
      authorityVersion: 1,
      subjectType: 'turn',
      subjectId: turn.authorityLineageKey,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonReleaseChecksum: turn.comparisonPipelineChecksum,
      comparisonDirection: job.payload.comparisonDirection,
      authoritativeResult: {
        terminalDisposition: closure.terminalDisposition,
        replyParts: items,
        actions,
        commitChecksum: receipt.commitChecksum
      },
      execution: {
        turn,
        envelope,
        currentBatch: this.getCurrentUserBatch(turn.turnId),
        scene: envelope.context?.scene || {},
        allowedActionTargets: [turn.characterId, 'user']
      }
    };
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
      const before = this.getConsolidationJob(jobId);
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
      if (!retry && before
        && ['shadow_cognition', 'active_canary_compare'].includes(before.jobType)) {
        let contract = null;
        try {
          contract = comparisonContractForDirection(before.payload?.comparisonDirection);
        } catch {}
        if (contract?.jobType === before.jobType) {
          let subject = null;
          if (before.subjectType === 'life_planning') {
            subject = this.getLifePlanningAttempt(before.subjectId);
            if (subject) {
              this.db.prepare(`
                UPDATE cognition_life_planning_attempts
                SET execution_state = 'completed', comparison_state = 'failed',
                    completed_at = ?, last_error_code = ?, updated_at = ?
                WHERE planning_id = ? AND compare_job_id = ?
                  AND execution_state = 'result_committed'
                  AND comparison_state IN ('queued','running')
              `).run(
                Number(failedAt),
                String(errorCode || 'COMPARISON_FAILED'),
                Number(failedAt),
                before.subjectId,
                before.jobId
              );
            }
          } else if (before.subjectType === 'turn' && before.authorityGroupId) {
            const receipt = this.getVisibleCommitReceipt(before.subjectId);
            subject = receipt ? this.getTurn(receipt.authoritativeTurnId) : null;
          }
          if (contract.jobType === 'active_canary_compare' && subject) {
            this.settleCanaryFailureInternal({
              rolloutKey: subject.rolloutKey,
              canaryEpoch: subject.canaryEpoch,
              canarySlot: subject.canarySlot,
              reasonCode: String(errorCode || 'CANARY_COMPARISON_FAILED'),
              now: failedAt
            });
          }
        }
      }
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

  settleCanaryFailureInternal({
    rolloutKey,
    canaryEpoch,
    canarySlot,
    reasonCode,
    now: settledAt = now()
  }) {
    if (canarySlot == null) return false;
    const key = String(rolloutKey || '');
    const epoch = Number(canaryEpoch);
    const slot = Number(canarySlot);
    if (!key || !Number.isSafeInteger(epoch) || epoch < 0
      || !Number.isSafeInteger(slot) || slot < 1 || slot > 10) {
      throw new Error('CANARY_ACCOUNTING_INVARIANT');
    }
    const rollout = this.db.prepare(
      'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
    ).get(key);
    if (!rollout) {
      if (allocationRows.length === 0) return { count: 0, oldestAt: null };
      throw new Error('CANARY_ACCOUNTING_INVARIANT');
    }
    if (Number(rollout.canary_epoch) !== epoch) return false;
    const update = this.db.prepare(`
      UPDATE cognition_kind_rollouts
      SET canary_failure_count = canary_failure_count + 1,
          revision = revision + 1, last_reason_code = ?, updated_at = ?
      WHERE rollout_key = ? AND canary_epoch = ?
        AND canary_started_count >= ?
        AND canary_completed_count + canary_failure_count < canary_started_count
    `).run(
      String(reasonCode || 'CANARY_TERMINAL_FAILURE'),
      Number(settledAt),
      key,
      epoch,
      slot
    );
    if (Number(update.changes) !== 1) throw new Error('CANARY_ACCOUNTING_INVARIANT');
    return true;
  }

  recordComparisonOutcomeInternal({
    jobId,
    workerId,
    run,
    report,
    criticalFindings = [],
    terminalCancellation = null,
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
      let freshContract = null;
      try {
        freshContract = comparisonContractForDirection(payload.comparisonDirection);
      } catch {}
      const freshAuthority = Boolean(freshContract);
      let authority = null;
      let subject = null;
      let rolloutKey = payload.rolloutKey;
      let rolloutEvidenceEpoch = payload.rolloutEvidenceEpoch;
      let shadowEpoch = payload.shadowEpoch;
      let canaryEpoch = payload.canaryEpoch;
      let canarySlot = payload.canarySlot;
      let pipelineChecksum = payload.pipelineChecksum;
      let shadowDirection = payload.comparisonDirection
        === 'legacy_authoritative_cognition_compare';

      if (freshAuthority) {
        if (freshContract.jobType !== job.job_type) {
          throw new Error('comparison direction authority conflict');
        }
        authority = this.loadComparisonExecutionAuthorityInternal({ jobId, workerId });
        if (authority.status === 'cancelled_redacted') {
          if (terminalCancellation !== 'cancelled_redacted') {
            throw new Error('comparison source was redacted before outcome commit');
          }
          if (job.subject_type === 'life_planning') {
            subject = this.getLifePlanningAttempt(job.subject_id);
            this.db.prepare(`
              UPDATE cognition_life_planning_attempts
              SET comparison_state = 'cancelled', completed_at = COALESCE(completed_at, ?),
                  updated_at = ?
              WHERE planning_id = ? AND comparison_state NOT IN ('completed','failed','cancelled')
            `).run(Number(recordedAt), Number(recordedAt), job.subject_id);
          } else {
            const cancelledTurn = this.db.prepare(`
              SELECT * FROM turns
              WHERE authority_lineage_key = ? AND result_authority_version = 1
              ORDER BY created_at, turn_id LIMIT 1
            `).get(job.subject_id);
            subject = cancelledTurn ? mapTurn(cancelledTurn) : null;
          }
          if (subject) {
            this.settleCanaryFailureInternal({
              rolloutKey: subject.rolloutKey,
              canaryEpoch: subject.canaryEpoch,
              canarySlot: subject.canarySlot,
              reasonCode: 'CANARY_SOURCE_REDACTED',
              now: recordedAt
            });
          }
          const cancelled = this.db.prepare(`
            UPDATE consolidation_jobs
            SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
                last_error_code = 'SOURCE_REDACTED', updated_at = ?
            WHERE job_id = ? AND state = 'running' AND lease_owner = ?
          `).run(Number(recordedAt), jobId, workerId);
          if (Number(cancelled.changes) !== 1) throw new Error('comparison job lease is not held');
          return {
            status: 'cancelled_redacted',
            run: null,
            report: null,
            rollout: subject ? this.getCognitionRollout(subject.rolloutKey) : null,
            staleForRollout: false
          };
        }
        if (terminalCancellation) {
          throw new Error('comparison terminal cancellation authority conflict');
        }
        if (authority.status !== 'ready') {
          throw new Error('comparison execution authority is unavailable');
        }
        subject = authority.subjectType === 'life_planning'
          ? authority.execution.attempt
          : authority.execution.turn;
        rolloutKey = subject.rolloutKey;
        rolloutEvidenceEpoch = subject.rolloutEvidenceEpoch;
        shadowEpoch = subject.shadowEpoch;
        canaryEpoch = subject.canaryEpoch;
        canarySlot = subject.canarySlot;
        pipelineChecksum = authority.comparisonReleaseChecksum;
        shadowDirection = freshContract.jobType === 'shadow_cognition';
      } else {
        const legacyPair = payload.comparisonDirection === 'legacy_authoritative_cognition_compare'
          ? 'shadow_cognition'
          : payload.comparisonDirection === 'cognition_authoritative_legacy_compare'
            ? 'active_canary_compare'
            : null;
        if (legacyPair !== job.job_type) {
          throw new Error('comparison direction authority conflict');
        }
        if (terminalCancellation) {
          throw new Error('legacy comparison cannot use canonical cancellation');
        }
      }

      const rollout = this.db.prepare(
        'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
      ).get(rolloutKey);
      const validEpoch = Boolean(rollout)
        && Number(rollout.evidence_epoch) === Number(rolloutEvidenceEpoch)
        && (
          freshAuthority
            ? shadowDirection
              ? rollout.current_mode === 'shadow'
                && rollout.candidate_phase === 'shadow'
                && rollout.stable_release_id === subject.authoritativeReleaseId
                && rollout.candidate_release_id === subject.comparisonReleaseId
                && Number(rollout.shadow_epoch) === Number(shadowEpoch)
              : rollout.current_mode === 'active'
                && rollout.candidate_phase === 'canary'
                && rollout.candidate_release_id === subject.authoritativeReleaseId
                && rollout.stable_release_id === subject.comparisonReleaseId
                && Number(rollout.canary_epoch) === Number(canaryEpoch)
                && Number(subject.canarySlot) === Number(canarySlot)
            : rollout.pipeline_checksum === pipelineChecksum
              && (shadowDirection
                ? rollout.current_mode === 'shadow'
                  && Number(rollout.shadow_epoch) === Number(shadowEpoch)
                : rollout.current_mode === 'active'
                  && rollout.rollout_phase === 'canary'
                  && Number(rollout.canary_epoch) === Number(canaryEpoch))
        );
      const stale = !validEpoch;
      if (!run || typeof run !== 'object') throw new Error('comparison run is required');
      const reportInput = report && typeof report === 'object' ? report : {};
      this.putCognitionShadowRunInternal({
        ...run,
        runId: run.runId || `run_${contentHash({ jobId, payload }).slice(0, 24)}`,
        subjectType: freshAuthority ? authority.subjectType : payload.subjectType,
        subjectId: freshAuthority ? authority.subjectId : payload.subjectId,
        turnId: freshAuthority && authority.subjectType === 'turn'
          ? subject.turnId
          : payload.turnId || null,
        rolloutKey,
        source: 'live',
        comparisonDirection: payload.comparisonDirection,
        evidenceEpoch: rolloutEvidenceEpoch,
        shadowEpoch,
        canaryEpoch,
        canarySlot,
        rolloutRevision: freshAuthority ? subject.rolloutRevision : payload.rolloutRevision,
        pipelineChecksum,
        authoritativeResultChecksum: payload.authoritativeResultChecksum,
        criticalFindings,
        staleForRollout: stale,
        state: 'completed',
        createdAt: recordedAt,
        updatedAt: recordedAt
      });
      const summary = {
        ...(reportInput.summary || {}),
        rolloutKey,
        jobId,
        staleForRollout: stale,
        criticalFindings
      };
      const reportId = reportInput.reportId
        || `report_compare_${contentHash({ jobId, summary }).slice(0, 24)}`;
      const storedReport = this.putEvaluationReportInternal({
        reportId,
        reportType: shadowDirection ? 'live_shadow' : 'active_canary',
        rolloutKey,
        sourceType: 'comparison_run',
        sourceRef: jobId,
        artifactPath: reportInput.artifactPath || '',
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
          Number(recordedAt), rolloutKey, Number(rollout.revision)
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
      if (freshAuthority && authority.subjectType === 'life_planning') {
        this.db.prepare(`
          UPDATE cognition_life_planning_attempts
          SET execution_state = 'completed', comparison_state = 'completed',
              completed_at = ?, updated_at = ?
          WHERE planning_id = ? AND compare_job_id = ?
            AND execution_state = 'result_committed' AND comparison_state = 'queued'
        `).run(Number(recordedAt), Number(recordedAt), subject.planningId, jobId);
      }
      return {
        run: this.getCognitionShadowRun(run.runId || `run_${contentHash({ jobId, payload }).slice(0, 24)}`),
        report: this.getEvaluationReport(reportId),
        rollout: this.getCognitionRollout(rolloutKey),
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

  readCanaryOutstandingAuthorityInternal({ rolloutKey, canaryEpoch }) {
    const key = String(rolloutKey || '');
    const epoch = Number(canaryEpoch);
    if (!key || !Number.isSafeInteger(epoch) || epoch < 0) {
      throw new Error('invalid canary outstanding authority query');
    }
    const allocationRows = [];
    const owners = [];
    let completed = 0;
    let failure = 0;
    const classifyCompletedRun = ({ subjectType, subjectId, slot }) => {
      const runs = this.db.prepare(`
        SELECT critical_findings_json
        FROM cognition_shadow_runs
        WHERE source = 'live' AND stale_for_rollout = 0
          AND subject_type = ? AND subject_id = ?
          AND rollout_key = ? AND canary_epoch = ? AND canary_slot = ?
          AND state = 'completed'
        ORDER BY created_at, run_id
      `).all(subjectType, subjectId, key, epoch, slot);
      if (runs.length !== 1) throw new Error('CANARY_ACCOUNTING_INVARIANT');
      return Array.isArray(parseJson(runs[0].critical_findings_json, []))
        && parseJson(runs[0].critical_findings_json, []).length > 0
        ? 'failure'
        : 'completed';
    };
    if (key !== 'LIFE_PLANNING') {
      for (const row of this.db.prepare(`
        SELECT root.authority_lineage_key AS subject_id, root.created_at,
               root.canary_slot, lineage.state AS lineage_state
        FROM turns root
        JOIN turn_authority_lineages lineage
          ON lineage.lineage_key = root.authority_lineage_key
        WHERE root.result_authority_version = 1
          AND root.retry_of_turn_id IS NULL
          AND root.rollout_key = ?
          AND root.canary_epoch = ?
          AND root.canary_slot IS NOT NULL
        ORDER BY root.canary_slot, root.created_at, root.turn_id
      `).all(key, epoch)) {
        allocationRows.push(row);
        if (row.lineage_state === 'cancelled') {
          failure += 1;
          continue;
        }
        const terminalJobs = this.db.prepare(`
          SELECT job_id, state
          FROM consolidation_jobs
          WHERE subject_type = 'turn' AND subject_id = ?
            AND job_type = 'active_canary_compare'
            AND state IN ('completed','failed','cancelled')
          ORDER BY created_at, job_id
        `).all(row.subject_id);
        if (terminalJobs.length > 1) throw new Error('CANARY_ACCOUNTING_INVARIANT');
        if (terminalJobs.length === 0) {
          owners.push(Number(row.created_at));
          continue;
        }
        if (terminalJobs[0].state !== 'completed') {
          failure += 1;
          continue;
        }
        const outcome = classifyCompletedRun({
          subjectType: 'turn', subjectId: row.subject_id, slot: Number(row.canary_slot)
        });
        if (outcome === 'completed') completed += 1;
        else failure += 1;
      }
    }
    if (key === 'LIFE_PLANNING') {
      for (const row of this.db.prepare(`
        SELECT planning_id, created_at, canary_slot, execution_state, comparison_state
        FROM cognition_life_planning_attempts
        WHERE rollout_key = 'LIFE_PLANNING'
          AND canary_epoch = ?
          AND canary_slot IS NOT NULL
        ORDER BY created_at, planning_id
      `).all(epoch)) {
        allocationRows.push({
          subject_id: row.planning_id,
          created_at: row.created_at,
          canary_slot: row.canary_slot
        });
        const terminalExecution = ['failed', 'cancelled'].includes(row.execution_state);
        if (terminalExecution || ['failed', 'cancelled'].includes(row.comparison_state)) {
          failure += 1;
          continue;
        }
        if (row.comparison_state === 'completed') {
          const outcome = classifyCompletedRun({
            subjectType: 'life_planning',
            subjectId: row.planning_id,
            slot: Number(row.canary_slot)
          });
          if (outcome === 'completed') completed += 1;
          else failure += 1;
          continue;
        }
        owners.push(Number(row.created_at));
      }
    }
    const rollout = this.db.prepare(
      'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
    ).get(key);
    if (!rollout) {
      if (allocationRows.length === 0) return { count: 0, oldestAt: null };
      throw new Error('CANARY_ACCOUNTING_INVARIANT');
    }
    if (Number(rollout.canary_epoch) === epoch) {
      const started = Number(rollout.canary_started_count);
      const slots = allocationRows.map(row => Number(row.canary_slot)).sort((a, b) => a - b);
      const contiguous = slots.length === started
        && slots.every((slot, index) => slot === index + 1);
      if (!contiguous
        || completed !== Number(rollout.canary_completed_count)
        || failure !== Number(rollout.canary_failure_count)
        || started !== completed + failure + owners.length) {
        throw new Error('CANARY_ACCOUNTING_INVARIANT');
      }
    }
    return {
      count: owners.length,
      oldestAt: owners.length ? Math.min(...owners) : null
    };
  }

  countOutstandingComparisonSubjects(input, options = {}) {
    const rolloutKey = typeof input === 'string' ? input : input.rolloutKey;
    const direction = typeof input === 'string' ? null : input.direction;
    const evidenceEpoch = typeof input === 'string' ? null : input.evidenceEpoch;
    const shadowEpoch = typeof input === 'string' ? null : input.shadowEpoch ?? null;
    const canaryEpoch = typeof input === 'string'
      ? options.canaryEpoch ?? null
      : input.canaryEpoch ?? null;
    if (canaryEpoch != null) {
      const authority = this.readCanaryOutstandingAuthorityInternal({
        rolloutKey,
        canaryEpoch
      });
      return typeof input === 'string' ? authority : authority.count;
    }
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
