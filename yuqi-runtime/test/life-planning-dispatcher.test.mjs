import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { LifePlanningDispatcher } from '../src/life-planning-dispatcher.mjs';
import { YuqiOrchestrator } from '../src/orchestrator.mjs';
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

test('cognition-v3 life provider uses the cognition planning request instead of the legacy request', async () => {
  const requests = [];
  const orchestrator = new YuqiOrchestrator({
    store: {},
    presets: { compileFor: () => ({}) },
    codex: {
      async runTurn(_role, text) {
        requests.push(JSON.parse(text));
        return {
          text: JSON.stringify({
            action: 'skip',
            reply: '',
            lifePlan: {
              episodes: [{
                kind: 'work', title: '工作室', startAt: 10_000, endAt: 30_000_000
              }]
            }
          })
        };
      }
    },
    lifePlanningEnabled: false
  });

  await orchestrator.executeCognitionV3LifeReleaseDraft({
    execution: {
      attempt: {
        planningId: 'planning_v3',
        roleId: 'yuqi',
        inputSnapshot: { planningWindow: { startAt: 10_000, targetPlanEndAt: 30_000_000 } }
      }
    }
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].task, 'plan_yuqi_life_with_cognition');
});
