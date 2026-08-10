import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIFE_CONTEXT_AUTHORITY_VERSION,
  projectLifePlanningContext,
  lifePlanningContextChecksum,
  assertLifePlanningContextAuthority,
  lifePlanningRequestBaseKey
} from '../src/life-planning-authority.mjs';
import { contentHash } from '../src/protocol.mjs';

function episode(overrides = {}) {
  return {
    episodeId: 'episode-1',
    characterId: 'yuqi',
    kind: 'work',
    title: 'studio',
    startAt: 100,
    endAt: 200,
    status: 'committed',
    payload: { detail: 'same' },
    checksum: 'a'.repeat(64),
    sourceTurnId: 'turn-1',
    adjustmentReason: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    contextAuthorityVersion: 2,
    cognitiveState: { mood: 'steady' },
    allowedActions: ['create_life_episode'],
    current: null,
    recent: [episode()],
    upcoming: [],
    ...overrides
  };
}

test('v2 context projection excludes lifecycle timestamps but includes semantic episode data', () => {
  const first = projectLifePlanningContext(snapshot());
  const second = projectLifePlanningContext(projectLifePlanningContext(snapshot()));
  assert.equal(first.contextAuthorityVersion, LIFE_CONTEXT_AUTHORITY_VERSION);
  assert.deepEqual(first, second);
  assert.equal(first.recent[0].createdAt, undefined);
  assert.equal(first.recent[0].updatedAt, undefined);
  assert.equal(first.recent[0].payload.detail, 'same');
});

test('v2 checksum ignores createdAt and updatedAt but changes for current recent upcoming semantics', () => {
  const base = snapshot();
  const lifecycleChanged = snapshot({ recent: [episode({ createdAt: 999, updatedAt: 1000 })] });
  assert.equal(lifePlanningContextChecksum(base), lifePlanningContextChecksum(lifecycleChanged));

  const currentChanged = snapshot({ current: episode({ episodeId: 'current-1' }) });
  const upcomingChanged = snapshot({ upcoming: [episode({ episodeId: 'upcoming-1' })] });
  const payloadChanged = snapshot({ recent: [episode({ payload: { detail: 'changed' } })] });
  assert.notEqual(lifePlanningContextChecksum(base), lifePlanningContextChecksum(currentChanged));
  assert.notEqual(lifePlanningContextChecksum(base), lifePlanningContextChecksum(upcomingChanged));
  assert.notEqual(lifePlanningContextChecksum(base), lifePlanningContextChecksum(payloadChanged));
});

test('v2 semantic changes alter the request base identity while lifecycle timestamps do not', () => {
  const base = snapshot();
  const baseArgs = {
    roleId: 'yuqi', startAt: 10, endAt: 20, lifeBasisChecksum: 'b'.repeat(64),
    contextChecksum: lifePlanningContextChecksum(base)
  };
  const lifecycleArgs = {
    ...baseArgs,
    contextChecksum: lifePlanningContextChecksum(
      snapshot({ recent: [episode({ createdAt: 900, updatedAt: 901 })] })
    )
  };
  assert.equal(lifePlanningRequestBaseKey(baseArgs), lifePlanningRequestBaseKey(lifecycleArgs));
  for (const changed of [
    snapshot({ current: episode({ episodeId: 'current-2' }) }),
    snapshot({ recent: [episode({ payload: { detail: 'changed' } })] }),
    snapshot({ upcoming: [episode({ episodeId: 'upcoming-2' })] })
  ]) {
    assert.notEqual(
      lifePlanningRequestBaseKey(baseArgs),
      lifePlanningRequestBaseKey({ ...baseArgs, contextChecksum: lifePlanningContextChecksum(changed) })
    );
    assert.notEqual(contentHash(base), contentHash(changed));
  }
});

test('v2 authority accepts exact native marker and rejects unknown versions', () => {
  assert.doesNotThrow(() => assertLifePlanningContextAuthority(snapshot()));
  assert.throws(() => assertLifePlanningContextAuthority({
    ...snapshot(), contextAuthorityVersion: 3
  }), /life planning context authority version/);
  assert.throws(() => assertLifePlanningContextAuthority({
    ...snapshot(), contextAuthorityVersion: '2'
  }), /life planning context authority version/);
  assert.throws(() => lifePlanningContextChecksum({
    ...snapshot(), contextAuthorityVersion: 3
  }), /life planning context authority version/);
});
