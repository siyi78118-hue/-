import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LifePlanningDispatcher } from '../src/life-planning-dispatcher.mjs';
import { PromotionController } from '../src/promotion-controller.mjs';
import { YuqiStore } from '../src/store.mjs';

test('dispatcher claims one persisted attempt and commits its authoritative result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-life-dispatcher-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  try {
    let at = 1_000;
    const controller = new PromotionController({
      store,
      presetRegistry: { evidenceManifest: key => ({ checksum: `c:${key}`, presetVersion: '2.0.0' }) },
      clock: () => at
    });
    controller.initialize();
    const created = controller.createLifePlanningAttempt({
      roleId: 'yuqi',
      planningContext: { planWindowStartAt: 10_000, targetPlanEndAt: 30_000_000 },
      now: at
    });
    const dispatcher = new LifePlanningDispatcher({
      store,
      promotionController: controller,
      clock: () => at,
      executeAttempt: async attempt => {
        assert.equal(attempt.planningId, created.planningId);
        return { episodes: [{ kind: 'work', title: '工作', startAt: 10_000, endAt: 30_000_000 }] };
      }
    });
    const completed = await dispatcher.runOnce();
    assert.equal(completed.executionState, 'completed');
    assert.equal(store.listLifeEpisodes('yuqi').length, 1);
    assert.equal(await dispatcher.runOnce(), null);
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
