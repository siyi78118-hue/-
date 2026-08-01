const FRESH_COMPARISON_CONTRACTS = Object.freeze([
  Object.freeze({
    comparisonMode: 'none',
    comparisonDirection: null,
    jobType: null
  }),
  Object.freeze({
    comparisonMode: 'cognition_compare',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    jobType: 'shadow_cognition'
  }),
  Object.freeze({
    comparisonMode: 'legacy_compare',
    comparisonDirection: 'candidate_authoritative_stable_compare',
    jobType: 'active_canary_compare'
  })
]);

function copy(contract) {
  return { ...contract };
}

export function comparisonContractForDirection(comparisonDirection) {
  const normalized = comparisonDirection == null ? null : comparisonDirection;
  const contract = FRESH_COMPARISON_CONTRACTS.find(
    item => item.comparisonDirection === normalized
  );
  if (!contract) throw new Error('fresh comparison contract direction conflict');
  return copy(contract);
}

export function comparisonContractForMode(comparisonMode) {
  const contract = FRESH_COMPARISON_CONTRACTS.find(
    item => item.comparisonMode === comparisonMode
  );
  if (!contract) throw new Error('fresh comparison contract mode conflict');
  return copy(contract);
}
