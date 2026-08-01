import assert from 'node:assert/strict';
import test from 'node:test';

import {
  comparisonContractForDirection,
  comparisonContractForMode
} from '../src/comparison-contract.mjs';

test('fresh comparison contract keeps compatibility mode direction and job type distinct', () => {
  assert.deepEqual(comparisonContractForDirection(null), {
    comparisonMode: 'none',
    comparisonDirection: null,
    jobType: null
  });
  assert.deepEqual(
    comparisonContractForDirection('stable_authoritative_candidate_compare'),
    {
      comparisonMode: 'cognition_compare',
      comparisonDirection: 'stable_authoritative_candidate_compare',
      jobType: 'shadow_cognition'
    }
  );
  assert.deepEqual(comparisonContractForMode('legacy_compare'), {
    comparisonMode: 'legacy_compare',
    comparisonDirection: 'candidate_authoritative_stable_compare',
    jobType: 'active_canary_compare'
  });
});

test('fresh comparison contract rejects compatibility strings as directions and legacy aliases', () => {
  for (const invalid of [
    'cognition_compare',
    'legacy_compare',
    'legacy_authoritative_cognition_compare',
    'cognition_authoritative_legacy_compare'
  ]) {
    assert.throws(
      () => comparisonContractForDirection(invalid),
      /fresh comparison contract direction conflict/
    );
  }
  assert.throws(
    () => comparisonContractForMode('stable_authoritative_candidate_compare'),
    /fresh comparison contract mode conflict/
  );
});
