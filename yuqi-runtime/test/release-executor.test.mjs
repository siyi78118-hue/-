import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ReleaseExecutor,
  supportsPipelineVersion
} from '../src/release-executor.mjs';

const RELEASES = new Map([
  ['stable', {
    releaseId: 'stable',
    pipelineVersion: 'stable-visible-baseline-2026-07-30',
    releaseChecksum: 'a'.repeat(64)
  }],
  ['candidate', {
    releaseId: 'candidate',
    pipelineVersion: 'cognition-v2-candidate-2026-07-30',
    releaseChecksum: 'b'.repeat(64)
  }]
]);

function adapter(adapterId) {
  return {
    async executeTurn({ dryRun, capabilities }) {
      return { adapterId, dryRun, capabilities };
    },
    async executeLife({ dryRun, capabilities }) {
      return { adapterId, dryRun, capabilities };
    }
  };
}

function completeAdapters() {
  return new Map([
    ['legacy-v1', adapter('legacy-v1')],
    ['cognition-v2', adapter('cognition-v2')],
    ['cognition-v3', adapter('cognition-v3')]
  ]);
}

test('release executor verifies immutable release identity and shares adapter selection', async () => {
  const executor = new ReleaseExecutor({
    getRelease: releaseId => RELEASES.get(releaseId) || null,
    turnAdapters: completeAdapters(),
    lifeAdapters: completeAdapters()
  });
  const visible = await executor.executeTurn({
    releaseId: 'candidate',
    releaseChecksum: 'b'.repeat(64),
    execution: { input: true },
    dryRun: false
  });
  assert.equal(visible.adapterId, 'cognition-v2');
  assert.equal(visible.capabilities.visibleCommit, true);
  assert.equal(visible.releaseId, 'candidate');
  assert.equal(visible.releaseChecksum, 'b'.repeat(64));
  assert.equal(visible.draft.adapterId, 'cognition-v2');

  const compare = await executor.executeTurn({
    releaseId: 'candidate',
    releaseChecksum: 'b'.repeat(64),
    execution: { input: true },
    dryRun: true
  });
  assert.equal(compare.adapterId, 'cognition-v2');
  assert.equal(compare.capabilities.visibleCommit, false);
  assert.equal(compare.capabilities.notification, false);

  const life = await executor.executeLife({
    releaseId: 'stable',
    releaseChecksum: 'a'.repeat(64),
    execution: { input: true },
    dryRun: false
  });
  assert.equal(life.adapterId, 'legacy-v1');
  assert.equal(life.draft.adapterId, 'legacy-v1');

  await assert.rejects(() => executor.executeTurn({
    releaseId: 'candidate',
    releaseChecksum: 'c'.repeat(64),
    execution: {},
    dryRun: false
  }), /release checksum authority conflict/);
  await assert.rejects(() => executor.executeTurn({
    releaseId: 'missing',
    releaseChecksum: 'd'.repeat(64),
    execution: {},
    dryRun: false
  }), /release executor unavailable/);
});

test('release executor rejects incomplete or extra production adapter maps at construction', () => {
  const complete = completeAdapters();
  const missing = completeAdapters();
  missing.delete('cognition-v3');
  const extra = completeAdapters();
  extra.set('invented-v4', adapter('invented-v4'));

  assert.throws(() => new ReleaseExecutor({
    getRelease: () => null,
    turnAdapters: missing,
    lifeAdapters: complete
  }), /complete production release adapter set is required/);
  assert.throws(() => new ReleaseExecutor({
    getRelease: () => null,
    turnAdapters: complete,
    lifeAdapters: extra
  }), /complete production release adapter set is required/);
});

test('supported pipeline versions are one closed mapping', () => {
  assert.equal(supportsPipelineVersion('stable-visible-baseline-2026-07-30'), true);
  assert.equal(supportsPipelineVersion('cognition-v2-candidate-2026-07-30'), true);
  assert.equal(supportsPipelineVersion('yuqi-lived-agency-v3'), true);
  assert.equal(supportsPipelineVersion('invented-v4'), false);
});
