import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANARY_COMPARISON_TARGET,
  resolvePipelinePair
} from '../src/release-pair.mjs';

function rollout(overrides = {}) {
  return {
    stableReleaseId: 'stable-r2',
    candidateReleaseId: 'candidate-r3',
    candidatePhase: 'none',
    canaryStartedCount: 0,
    canaryTargetCount: 10,
    ...overrides
  };
}

test('release pair is the single stable shadow canary and rollback projection', () => {
  assert.equal(CANARY_COMPARISON_TARGET, 10);
  assert.deepEqual(resolvePipelinePair(rollout()), {
    visibleReleaseId: 'stable-r2',
    comparisonReleaseId: null,
    comparisonDirection: null,
    candidatePhase: 'none'
  });
  assert.deepEqual(resolvePipelinePair(rollout({ candidatePhase: 'shadow' })), {
    visibleReleaseId: 'stable-r2',
    comparisonReleaseId: 'candidate-r3',
    comparisonDirection: 'stable_authoritative_candidate_compare',
    candidatePhase: 'shadow'
  });
  assert.deepEqual(resolvePipelinePair(rollout({
    candidatePhase: 'canary',
    canaryStartedCount: 9
  })), {
    visibleReleaseId: 'candidate-r3',
    comparisonReleaseId: 'stable-r2',
    comparisonDirection: 'candidate_authoritative_stable_compare',
    candidatePhase: 'canary'
  });
  assert.deepEqual(resolvePipelinePair(rollout({
    candidatePhase: 'canary',
    canaryStartedCount: 10
  })), {
    visibleReleaseId: 'candidate-r3',
    comparisonReleaseId: null,
    comparisonDirection: null,
    candidatePhase: 'canary'
  });
  assert.deepEqual(resolvePipelinePair(rollout({ candidatePhase: 'rolled_back' })), {
    visibleReleaseId: 'stable-r2',
    comparisonReleaseId: null,
    comparisonDirection: null,
    candidatePhase: 'rolled_back'
  });
});

test('release pair rejects malformed or impossible rollout authority', () => {
  for (const invalid of [
    null,
    rollout({ stableReleaseId: '' }),
    rollout({ candidatePhase: 'unknown' }),
    rollout({ candidatePhase: 'shadow', candidateReleaseId: null }),
    rollout({ candidatePhase: 'canary', candidateReleaseId: 'stable-r2' }),
    rollout({ canaryStartedCount: 11 }),
    rollout({ canaryStartedCount: 1.5 }),
    rollout({ canaryTargetCount: 11 })
  ]) {
    assert.throws(() => resolvePipelinePair(invalid), /rollout release authority/);
  }
});
