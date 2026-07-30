import assert from 'node:assert/strict';

import { generationFingerprint as computeGenerationFingerprint } from './interaction-lanes.mjs';
import { contentHash } from './protocol.mjs';
import { deriveVisibleGroupId } from './store.mjs';

export function canonicalCommitPayload(input) {
  return {
    payloadVersion: 'pc-visible-commit-v1',
    authorityOrigin: 'pc',
    authorityLineageKey: input.authorityLineageKey,
    turnId: input.turnId,
    laneKey: input.laneKey,
    inputUserBatchId: input.expectedLatestUserBatchId,
    inputVisibilitySequence: input.inputVisibilitySequence,
    agencySnapshotChecksum: input.agencySnapshotChecksum,
    cognitiveStateRevision: input.expectedCognitiveStateRevision,
    authoritativeReleaseId: input.authoritativeReleaseId,
    generationFingerprint: input.generationFingerprint,
    visibleGroup: input.visibleGroup,
    actionSet: input.actionSet || [],
    statePatch: input.statePatch || null,
    memoryJobs: input.memoryJobs || [],
    comparisonJob: input.comparisonJob || null
  };
}

export function commitVisibleResult(input) {
  if (!input?.store) throw new Error('visible commit store is required');
  const canonicalPayload = canonicalCommitPayload(input);
  const commitChecksum = contentHash(canonicalPayload);
  return input.store.withImmediateTransaction(() => {
    const existing = input.store.getVisibleCommitReceipt(input.authorityLineageKey);
    if (existing) {
      assert.equal(
        existing.authorityOrigin,
        'pc',
        'lineage already committed by a different authority origin'
      );
      assert.equal(
        existing.commitPayloadVersion,
        'pc-visible-commit-v1',
        'lineage receipt payload version conflict'
      );
      assert.equal(
        existing.commitChecksum,
        commitChecksum,
        'lineage already committed with different checksum'
      );
      return { ...existing, committed: false };
    }

    const authority = input.store.readCommitAuthority({
      turnId: input.turnId,
      authorityLineageKey: input.authorityLineageKey,
      laneKey: input.laneKey
    });
    if (!authority.turn || authority.turn.resultAuthorityVersion !== 1) {
      throw new Error('result authority conflict');
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
    const expectedFingerprint = computeGenerationFingerprint({
      roleId: authority.turn.characterId,
      laneKey: authority.turn.laneKey,
      laneRevision: authority.turn.laneRevision,
      visibleGroup: input.visibleGroup,
      actionSet: input.actionSet || [],
      contextRevision: input.agencySnapshotChecksum
    });
    if (input.generationFingerprint !== expectedFingerprint) {
      throw new Error('generation fingerprint authority conflict');
    }
    for (const action of input.actionSet || []) {
      if (String(action.targetKey || '').startsWith('conversation:')
        && String(action.targetRevision ?? '') !== String(authority.lane.revision)) {
        throw new Error('action target revision authority conflict');
      }
    }
    return input.store.commitVisibleResultInternal({
      ...input,
      authorityOrigin: 'pc',
      commitPayloadVersion: 'pc-visible-commit-v1',
      groupId: deriveVisibleGroupId(input.authorityLineageKey),
      commitChecksum
    });
  });
}
