export const CANARY_COMPARISON_TARGET = 10;

const PHASES = new Set(['none', 'shadow', 'canary', 'rolled_back']);

export function resolvePipelinePair(rollout) {
  if (!rollout || typeof rollout !== 'object' || Array.isArray(rollout)) {
    throw new Error('rollout release authority is required');
  }
  const candidatePhase = String(rollout.candidatePhase || '');
  const stableReleaseId = String(rollout.stableReleaseId || '');
  const candidateReleaseId = rollout.candidateReleaseId == null
    ? null
    : String(rollout.candidateReleaseId);
  const canaryStartedCount = Number(rollout.canaryStartedCount);
  const canaryTargetCount = Number(rollout.canaryTargetCount);
  const candidateRequired = candidatePhase === 'shadow' || candidatePhase === 'canary';
  if (!stableReleaseId
    || !PHASES.has(candidatePhase)
    || !Number.isSafeInteger(canaryStartedCount)
    || canaryStartedCount < 0
    || canaryStartedCount > CANARY_COMPARISON_TARGET
    || canaryTargetCount !== CANARY_COMPARISON_TARGET
    || (candidateRequired
      && (!candidateReleaseId || candidateReleaseId === stableReleaseId))
    || (!candidateRequired && candidateReleaseId === stableReleaseId)) {
    throw new Error('invalid rollout release authority');
  }
  if (candidatePhase === 'shadow') {
    return {
      visibleReleaseId: stableReleaseId,
      comparisonReleaseId: candidateReleaseId,
      comparisonDirection: 'stable_authoritative_candidate_compare',
      candidatePhase
    };
  }
  if (candidatePhase === 'canary') {
    const compare = canaryStartedCount < CANARY_COMPARISON_TARGET;
    return {
      visibleReleaseId: candidateReleaseId,
      comparisonReleaseId: compare ? stableReleaseId : null,
      comparisonDirection: compare
        ? 'candidate_authoritative_stable_compare'
        : null,
      candidatePhase
    };
  }
  return {
    visibleReleaseId: stableReleaseId,
    comparisonReleaseId: null,
    comparisonDirection: null,
    candidatePhase
  };
}
