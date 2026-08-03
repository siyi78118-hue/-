import assert from 'node:assert/strict';

import { applyStanceTransitions } from './agency-state.mjs';
import { generationFingerprint as computeGenerationFingerprint } from './interaction-lanes.mjs';
import { contentHash } from './protocol.mjs';
import { deriveVisibleGroupId } from './store.mjs';
import { comparisonContractForMode } from './comparison-contract.mjs';

function exactObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.join(',')}`);
}

function sha256(value, label) {
  const normalized = String(value || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a SHA-256 checksum`);
  }
  return normalized;
}

function optionalSha256(value, label) {
  if (value == null || value === '') return '';
  return sha256(value, label);
}

const VISIBLE_ITEM_FIELDS = new Set([
  'content',
  'speakerId',
  'speakerType',
  'recipientId',
  'contentType',
  'attachment',
  'attachments',
  'replyToMessageId',
  'messageId',
  'groupId',
  'turnId',
  'ordinal'
]);

function normalizeVisibleItem(item) {
  exactObject(item, VISIBLE_ITEM_FIELDS, 'visible item');
  const normalized = {
    content: String(item.content ?? ''),
    speakerId: String(item.speakerId || ''),
    speakerType: String(item.speakerType || ''),
    recipientId: String(item.recipientId || '')
  };
  for (const key of ['contentType', 'attachment', 'attachments', 'replyToMessageId']) {
    if (item[key] !== undefined) normalized[key] = structuredClone(item[key]);
  }
  return normalized;
}

function normalizeAction(action) {
  exactObject(action, new Set([
    'kind', 'targetKey', 'targetRevision', 'payload',
    'actionId', 'groupId', 'turnId', 'ordinal'
  ]), 'visible action');
  return {
    kind: String(action.kind || ''),
    targetKey: String(action.targetKey || ''),
    targetRevision: String(action.targetRevision ?? ''),
    payload: structuredClone(action.payload || {})
  };
}

function assertContiguousRolePlanActionBlock(actions) {
  const ordinals = (Array.isArray(actions) ? actions : [])
    .map((action, ordinal) => String(action?.kind || '').startsWith('role_plan_') ? ordinal : -1)
    .filter(ordinal => ordinal >= 0);
  if (ordinals.length > 1
    && ordinals.at(-1) - ordinals[0] + 1 !== ordinals.length) {
    throw new Error('canonical role plan actions must form one contiguous ordinal block');
  }
}

function normalizeStateIntent(patch) {
  if (patch == null) return null;
  exactObject(patch, new Set(['mood', 'currentStances', 'openThreads']), 'state patch');
  return {
    mood: String(patch.mood || ''),
    currentStances: structuredClone(patch.currentStances || []),
    openThreads: structuredClone(patch.openThreads || [])
  };
}

function normalizeMemoryJob(job) {
  exactObject(job, new Set([
    'jobId', 'jobType', 'dueAt', 'createdAt', 'updatedAt', 'workerId', 'payload'
  ]), 'memory job');
  if (job.jobType !== 'turn_consolidation') throw new Error('unsupported memory job type');
  const payload = job.payload || {};
  exactObject(payload, new Set([
    'cognitionPacketChecksum', 'resultingCognitiveStateChecksum',
    'turnId', 'jobId', 'attemptId', 'dueAt', 'createdAt', 'updatedAt', 'workerId'
  ]), 'memory job payload');
  return {
    jobType: 'turn_consolidation',
    cognitionPacketChecksum: sha256(
      payload.cognitionPacketChecksum,
      'memory job cognitionPacketChecksum'
    ),
    resultingCognitiveStateChecksum: sha256(
      payload.resultingCognitiveStateChecksum,
      'memory job resultingCognitiveStateChecksum'
    )
  };
}

function normalizeComparisonJob(job) {
  if (job == null) return null;
  exactObject(job, new Set([
    'jobId', 'jobType', 'dueAt', 'createdAt', 'updatedAt', 'workerId', 'payload'
  ]), 'comparison job');
  const payload = job.payload || {};
  exactObject(payload, new Set([
    'comparisonReleaseId', 'comparisonDirection', 'rolloutEvidenceEpoch',
    'shadowEpoch', 'canaryEpoch', 'canarySlot', 'annotationSnapshotChecksum',
    'inputChecksum', 'turnId', 'jobId', 'attemptId', 'dueAt', 'createdAt',
    'updatedAt', 'workerId'
  ]), 'comparison job payload');
  if (!new Set(['shadow_cognition', 'active_canary_compare']).has(job.jobType)) {
    throw new Error('unsupported comparison job type');
  }
  return {
    jobType: job.jobType,
    comparisonReleaseId: String(payload.comparisonReleaseId || ''),
    comparisonDirection: String(payload.comparisonDirection || ''),
    rolloutEvidenceEpoch: Number(payload.rolloutEvidenceEpoch || 0),
    shadowEpoch: payload.shadowEpoch == null ? null : Number(payload.shadowEpoch),
    canaryEpoch: payload.canaryEpoch == null ? null : Number(payload.canaryEpoch),
    canarySlot: payload.canarySlot == null ? null : Number(payload.canarySlot),
    annotationSnapshotChecksum: optionalSha256(
      payload.annotationSnapshotChecksum,
      'comparison job annotationSnapshotChecksum'
    ),
    inputChecksum: optionalSha256(payload.inputChecksum, 'comparison job inputChecksum')
  };
}

export function validateStatePatchAgainstAgency({
  patch,
  turn,
  cognitiveState,
  activeStances,
  currentBatch,
  evidenceIndex,
  effectiveAt
}) {
  const semanticPatch = normalizeStateIntent(patch);
  if (semanticPatch == null) return null;
  const relevantBatch = {
    turnId: turn.turnId,
    messageIds: (currentBatch?.messages || []).map(message => String(message.messageId)),
    topics: [...new Set([
      ...(currentBatch?.topics || []),
      ...semanticPatch.currentStances.map(item => item.topic).filter(Boolean),
      ...activeStances.map(item => item.topic).filter(Boolean)
    ])]
  };
  const stanceResult = applyStanceTransitions({
    stances: activeStances,
    transitions: semanticPatch.currentStances,
    relevantBatch,
    evidenceIndex,
    now: effectiveAt
  });
  const previous = cognitiveState?.state || {
    slowState: {},
    mediumState: {},
    fastState: {}
  };
  const nextState = {
    slowState: structuredClone(previous.slowState || {}),
    mediumState: structuredClone(previous.mediumState || {}),
    fastState: {
      ...(structuredClone(previous.fastState || {})),
      mood: semanticPatch.mood,
      openThreadIds: semanticPatch.openThreads.map(item =>
        typeof item === 'string' ? item : String(item?.threadId || '')
      ).filter(Boolean)
    }
  };
  return {
    semanticPatch,
    schemaVersion: Number(cognitiveState?.schemaVersion || 2),
    state: nextState,
    stanceRevisions: stanceResult.changedRecords
  };
}

function canonicalCommitPayloadV1(input) {
  return {
    payloadVersion: 'pc-visible-commit-v1',
    authorityOrigin: 'pc',
    authorityLineageKey: input.authorityLineageKey,
    laneKey: input.laneKey,
    input: {
      userBatchId: input.expectedLatestUserBatchId,
      visibilitySequence: Number(input.inputVisibilitySequence)
    },
    agency: {
      snapshotChecksum: input.agencySnapshotChecksum,
      cognitiveStateRevision: Number(input.expectedCognitiveStateRevision)
    },
    releases: {
      authoritativeReleaseId: input.authoritativeReleaseId,
      comparisonReleaseId: input.comparisonReleaseId || null,
      comparisonDirection: input.comparisonDirection || null
    },
    generationFingerprint: input.generationFingerprint,
    visibleItems: (input.visibleGroup?.items || []).map(normalizeVisibleItem),
    actions: (input.actionSet || []).map(normalizeAction),
    statePatch: normalizeStateIntent(input.statePatch),
    memoryJobs: (input.memoryJobs || []).map(normalizeMemoryJob),
    comparison: normalizeComparisonJob(input.comparisonJob)
  };
}

export function canonicalCommitPayload(input) {
  const payload = canonicalCommitPayloadV1(input);
  payload.payloadVersion = 'pc-visible-commit-v2';
  payload.input.clearEpoch = Number(input.inputClearEpoch ?? 0);
  return payload;
}

export function commitVisibleResult(input) {
  if (!input?.store) throw new Error('visible commit store is required');
  assertContiguousRolePlanActionBlock(input.actionSet || []);
  return input.store.withImmediateTransaction(() => {
    const existing = input.store.readCanonicalCommitOutcomeInternal({
      lineageKey: input.authorityLineageKey,
      expectedTurnId: input.turnId,
      expectedOrigin: 'pc'
    });
    if (existing) {
      const receipt = existing.receipt;
      if (existing.status === 'redacted' && !receipt) {
        throw new Error('canonical result lineage is redacted and cancelled');
      }
      const canonicalPayload = receipt.commitPayloadVersion === 'pc-visible-commit-v1'
        ? canonicalCommitPayloadV1(input)
        : canonicalCommitPayload(input);
      const commitChecksum = contentHash(canonicalPayload);
      assert.equal(
        receipt.authorityOrigin,
        'pc',
        'lineage already committed by a different authority origin'
      );
      assert.equal(
        receipt.commitPayloadVersion,
        canonicalPayload.payloadVersion,
        'lineage receipt payload version conflict'
      );
      assert.equal(
        receipt.commitChecksum,
        commitChecksum,
        'lineage already committed with different checksum'
      );
      return { ...receipt, status: existing.status, committed: false };
    }

    const canonicalPayload = input.store.userVersion() >= 13
      ? canonicalCommitPayload(input)
      : canonicalCommitPayloadV1(input);
    const commitChecksum = contentHash(canonicalPayload);

    const authority = input.store.readCommitAuthority({
      turnId: input.turnId,
      authorityLineageKey: input.authorityLineageKey,
      laneKey: input.laneKey
    });
    if (!authority.turn || authority.turn.resultAuthorityVersion !== 1) {
      throw new Error('result authority conflict');
    }
    if (Number(input.inputClearEpoch ?? 0) !== Number(authority.turn.inputClearEpoch || 0)) {
      throw new Error('clear epoch authority conflict');
    }
    const envelope = JSON.parse(authority.turn.envelopeJson);
    const effectiveAt = Number(
      envelope.message?.sentAt
      ?? envelope.trigger?.executedAt
      ?? envelope.trigger?.scheduledFor
      ?? envelope.createdAt
    );
    const agencySnapshot = input.store.readAgencyAuthoritySnapshotInternal({
      roleId: authority.turn.characterId,
      at: effectiveAt
    });
    if (agencySnapshot.checksum !== authority.turn.agencySnapshotChecksum) {
      throw new Error('AGENCY_AUTHORITY_STALE');
    }
    if (authority.turn.turnRevision !== Number(input.expectedTurnRevision)
      || !authority.lineage
      || authority.lineage.state !== 'open'
      || authority.lineage.latestTurnId !== input.turnId
      || authority.lineage.revision !== Number(input.expectedLineageRevision)
      || !authority.lane
      || authority.lane.revision !== Number(input.expectedLaneRevision)
      || authority.lane.latestUserBatchId !== input.expectedLatestUserBatchId
      || authority.lane.localSequence !== Number(input.inputVisibilitySequence)
      || Number(authority.cognitiveState?.revision || 0)
        !== Number(input.expectedCognitiveStateRevision)
      || authority.turn.agencySnapshotChecksum !== input.agencySnapshotChecksum
      || authority.turn.authoritativeReleaseId !== input.authoritativeReleaseId
      || authority.turn.generationFingerprint !== null) {
      throw new Error('visible result authority conflict');
    }
    for (const item of input.visibleGroup?.items || []) {
      if (String(item?.content || '').trim() === '') {
        throw new Error('visible item content must not be blank');
      }
      if (String(item?.speakerId || '') !== authority.turn.characterId
        || String(item?.speakerType || '') !== 'character'
        || String(item?.recipientId || '') !== 'user') {
        throw new Error('visible item identity authority conflict');
      }
    }
    const resolvedActions = (input.actionSet || []).map(action => {
      const resolved = input.store.resolveCanonicalActionTargetInternal({
        turn: authority.turn,
        action
      });
      if (String(action.targetKey || '') !== resolved.targetKey
        || String(action.targetRevision ?? '') !== resolved.targetRevision) {
        throw new Error('action target revision authority conflict');
      }
      return {
        kind: String(action.kind || ''),
        targetKey: resolved.targetKey,
        targetRevision: resolved.targetRevision,
        payload: structuredClone(action.payload || {})
      };
    });
    const expectedFingerprint = computeGenerationFingerprint({
      roleId: authority.turn.characterId,
      laneKey: authority.turn.laneKey,
      inputVisibilitySequence: authority.turn.inputVisibilitySequence,
      visibleGroup: input.visibleGroup,
      actionSet: resolvedActions,
      contextRevision: input.agencySnapshotChecksum
    });
    if (input.generationFingerprint !== expectedFingerprint) {
      throw new Error('generation fingerprint authority conflict');
    }
    const comparisonMode = String(authority.turn.comparisonMode || 'none');
    const expectedComparison = comparisonContractForMode(comparisonMode);
    if (!expectedComparison.jobType) {
      if (input.comparisonJob != null || authority.turn.comparisonReleaseId) {
        throw new Error('comparison authority conflict');
      }
      if (input.comparisonReleaseId != null || input.comparisonDirection != null) {
        throw new Error('comparison authority conflict');
      }
    } else {
      const payload = input.comparisonJob?.payload || {};
      const expectedAnnotationChecksum = contentHash(authority.turn.annotationSnapshot || {});
      const expectedInputChecksum = contentHash({
        envelope,
        authoritativeReleaseId: authority.turn.authoritativeReleaseId,
        authoritativePipelineChecksum: authority.turn.authoritativePipelineChecksum,
        comparisonReleaseId: authority.turn.comparisonReleaseId,
        comparisonPipelineChecksum: authority.turn.comparisonPipelineChecksum,
        rolloutRevision: authority.turn.rolloutRevision,
        rolloutEvidenceEpoch: authority.turn.rolloutEvidenceEpoch,
        shadowEpoch: authority.turn.shadowEpoch,
        canaryEpoch: authority.turn.canaryEpoch,
        canarySlot: authority.turn.canarySlot
      });
      if (String(input.comparisonReleaseId || '')
          !== String(authority.turn.comparisonReleaseId || '')
        || String(input.comparisonDirection || '') !== expectedComparison.comparisonDirection
        || input.comparisonJob?.jobType !== expectedComparison.jobType
        || String(payload.comparisonReleaseId || '') !== String(authority.turn.comparisonReleaseId || '')
        || String(payload.comparisonDirection || '')
          !== expectedComparison.comparisonDirection
        || Number(payload.rolloutEvidenceEpoch) !== Number(authority.turn.rolloutEvidenceEpoch)
        || (authority.turn.shadowEpoch == null
          ? payload.shadowEpoch != null
          : Number(payload.shadowEpoch) !== Number(authority.turn.shadowEpoch))
        || (authority.turn.canaryEpoch == null
          ? payload.canaryEpoch != null
          : Number(payload.canaryEpoch) !== Number(authority.turn.canaryEpoch))
        || (authority.turn.canarySlot == null
          ? payload.canarySlot != null
          : Number(payload.canarySlot) !== Number(authority.turn.canarySlot))
        || String(payload.annotationSnapshotChecksum || '') !== expectedAnnotationChecksum
        || String(payload.inputChecksum || '') !== expectedInputChecksum) {
        throw new Error('comparison authority conflict');
      }
    }
    const batch = envelope.context?.currentBatch || {
      batchId: envelope.message?.messageId || envelope.trigger?.triggerId,
      messages: envelope.message ? [envelope.message] : []
    };
    const evidenceIndex = new Map(
      (batch.messages || []).map(message => [String(message.messageId), message])
    );
    const validatedStatePatch = validateStatePatchAgainstAgency({
      patch: input.statePatch,
      turn: authority.turn,
      cognitiveState: authority.cognitiveState,
      activeStances: agencySnapshot.stances,
      currentBatch: batch,
      evidenceIndex,
      effectiveAt
    });
    const semantic = canonicalPayload;
    const normalizedItems = semantic.visibleItems;
    const normalizedMemoryJobs = semantic.memoryJobs.map((descriptor, ordinal) => ({
      jobId: input.memoryJobs?.[ordinal]?.jobId,
      jobType: descriptor.jobType,
      payload: descriptor
    }));
    assert.deepEqual(semantic.actions, resolvedActions.map(normalizeAction));
    assert.deepEqual(semantic.statePatch, validatedStatePatch?.semanticPatch ?? null);
    assert.deepEqual(
      semantic.memoryJobs,
      normalizedMemoryJobs.map(job => job.payload)
    );
    return input.store.commitVisibleResultInternal({
      ...input,
      visibleGroup: { items: normalizedItems },
      actionSet: resolvedActions,
      statePatch: validatedStatePatch,
      memoryJobs: normalizedMemoryJobs,
      authorityOrigin: 'pc',
      commitPayloadVersion: canonicalPayload.payloadVersion,
      authorityManifest: semantic,
      groupId: deriveVisibleGroupId(input.authorityLineageKey),
      commitChecksum
    });
  });
}
