import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LifeSimulationCoordinator } from '../src/life-simulation.mjs';
import { YuqiStore } from '../src/store.mjs';

const at = value => Date.parse(value);

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-life-'));
  const database = join(dir, 'runtime.sqlite');
  const store = new YuqiStore(database);
  try {
    return run({ store, database });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('life timeline persists and catches up across a restart without overlapping episodes', () => {
  fixture(({ store, database }) => {
    const firstCoordinator = new LifeSimulationCoordinator({ store });
    const first = firstCoordinator.advanceTo('yuqi', at('2026-07-23T14:00:00+08:00'));
    assert.equal(first.current.kind, 'work');
    const firstIds = firstCoordinator.ensureHorizon('yuqi', at('2026-07-23T14:00:00+08:00'))
      .map(item => item.episodeId);
    store.close();

    const restartedStore = new YuqiStore(database);
    try {
      const restarted = new LifeSimulationCoordinator({ store: restartedStore });
      const afterRestart = restarted.advanceTo('yuqi', at('2026-07-23T17:30:00+08:00'));
      assert.equal(afterRestart.current.kind, 'commute');
      assert.deepEqual(
        restarted.ensureHorizon('yuqi', at('2026-07-23T14:00:00+08:00')).map(item => item.episodeId),
        firstIds
      );
      const ordered = restartedStore.listLifeEpisodes('yuqi');
      assert.equal(ordered.some((item, index) => index > 0 && item.startAt < ordered[index - 1].endAt), false);
    } finally {
      restartedStore.close();
    }
  });
});

test('life simulation rejects forbidden major events and replay conflicts', () => {
  fixture(({ store }) => {
    assert.throws(() => store.putLifePlan('yuqi', [{
      episodeId: 'ep_major',
      kind: 'major_accident',
      title: '事故',
      startAt: 100,
      endAt: 200
    }]), /forbidden life episode kind/);

    store.putLifePlan('yuqi', [{
      episodeId: 'ep_safe',
      kind: 'personal',
      title: '散步',
      startAt: 100,
      endAt: 200
    }]);
    assert.throws(() => store.putLifePlan('yuqi', [{
      episodeId: 'ep_safe',
      kind: 'work',
      title: '改稿',
      startAt: 100,
      endAt: 200
    }]), /life episode checksum conflict/);
  });
});

test('an approved user-driven adjustment can reschedule Yuqi life without inventing user control', () => {
  fixture(({ store }) => {
    const coordinator = new LifeSimulationCoordinator({ store });
    coordinator.ensureHorizon('yuqi', at('2026-07-23T14:00:00+08:00'));
    const personal = store.listLifeEpisodes('yuqi').find(item => item.kind === 'personal');
    const adjusted = coordinator.applyAdjustment('yuqi', {
      type: 'reschedule',
      targetEpisodeId: personal.episodeId,
      startAt: personal.startAt + 60 * 60_000,
      endAt: personal.endAt + 60 * 60_000,
      reason: '虞栖决定先继续聊天，晚一点再散步'
    }, 'turn_adjust', at('2026-07-23T14:05:00+08:00'));

    assert.equal(adjusted.sourceTurnId, 'turn_adjust');
    assert.match(adjusted.adjustmentReason, /虞栖决定/);
    assert.equal(store.getLifeEpisode(personal.episodeId).startAt, personal.startAt + 60 * 60_000);
  });
});
