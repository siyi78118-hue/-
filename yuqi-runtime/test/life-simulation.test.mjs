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
    store.putLifePlan('yuqi', [
      {
        episodeId: 'life_work',
        kind: 'work',
        title: '处理编辑工作',
        startAt: at('2026-07-23T13:00:00+08:00'),
        endAt: at('2026-07-23T17:00:00+08:00')
      },
      {
        episodeId: 'life_commute',
        kind: 'commute',
        title: '下班回去',
        startAt: at('2026-07-23T17:00:00+08:00'),
        endAt: at('2026-07-23T18:00:00+08:00')
      }
    ]);
    const first = firstCoordinator.advanceTo('yuqi', at('2026-07-23T14:00:00+08:00'));
    assert.equal(first.current.kind, 'work');
    const firstIds = store.listLifeEpisodes('yuqi').map(item => item.episodeId);
    store.close();

    const restartedStore = new YuqiStore(database);
    try {
      const restarted = new LifeSimulationCoordinator({ store: restartedStore });
      const afterRestart = restarted.advanceTo('yuqi', at('2026-07-23T17:30:00+08:00'));
      assert.equal(afterRestart.current.kind, 'commute');
      assert.deepEqual(
        restartedStore.listLifeEpisodes('yuqi').map(item => item.episodeId),
        firstIds
      );
      const ordered = restartedStore.listLifeEpisodes('yuqi');
      assert.equal(ordered.some((item, index) => index > 0 && item.startAt < ordered[index - 1].endAt), false);
    } finally {
      restartedStore.close();
    }
  });
});

test('an empty timeline requests chat-brain planning instead of pre-filling a fixed daily template', () => {
  fixture(({ store }) => {
    const coordinator = new LifeSimulationCoordinator({ store });
    const context = coordinator.advanceTo('yuqi', at('2026-07-23T14:00:00+08:00'));

    assert.equal(context.current, null);
    assert.equal(context.needsPlan, true);
    assert.equal(store.listLifeEpisodes('yuqi').length, 0);
  });
});

test('legacy fixed-template future episodes are retired so the chat brain can take over planning', () => {
  fixture(({ store }) => {
    const now = at('2026-07-23T14:00:00+08:00');
    store.putLifePlan('yuqi', [{
      episodeId: 'life_legacy_template',
      kind: 'work',
      title: '固定模板工作',
      startAt: now,
      endAt: now + 8 * 60 * 60_000,
      payload: { planVersion: 'life-v1', ordinaryLowRisk: true }
    }]);

    const context = new LifeSimulationCoordinator({ store }).advanceTo('yuqi', now);

    assert.equal(store.getLifeEpisode('life_legacy_template').status, 'cancelled');
    assert.equal(context.needsPlan, true);
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
    assert.throws(() => store.putLifePlan('yuqi', [{
      episodeId: 'ep_major_cn',
      kind: 'personal',
      title: '突然生病住院',
      startAt: 300,
      endAt: 400
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
    store.putLifePlan('yuqi', [{
      episodeId: 'life_personal',
      kind: 'personal',
      title: '散步',
      startAt: at('2026-07-23T19:00:00+08:00'),
      endAt: at('2026-07-23T20:00:00+08:00')
    }]);
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
