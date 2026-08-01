import assert from 'node:assert/strict';
import test from 'node:test';

import { composeYuqiExecutionRuntime } from '../src/runtime-composition.mjs';

function runtimeFixture() {
  const releases = new Map();
  return {
    store: {
      getPipelineRelease: id => releases.get(id) || null
    },
    presets: { current: () => ({ version: 'test' }) },
    codex: {},
    promotionController: {},
    cognitivePipeline: {
      runV2ReleaseDraft: async () => ({}),
      runV3ReleaseDraft: async () => ({}),
      runShadow: async () => ({})
    }
  };
}

test('production composition injects one complete release executor before exposure', () => {
  const runtime = composeYuqiExecutionRuntime(runtimeFixture());
  assert.strictEqual(runtime.orchestrator.releaseExecutor, runtime.releaseExecutor);
  assert.strictEqual(runtime.lifePlanningDispatcher.releaseExecutor, runtime.releaseExecutor);
  assert.strictEqual(runtime.shadowDispatcher.releaseExecutor, runtime.releaseExecutor);
  assert.deepEqual(runtime.releaseExecutor.adapterIds(), {
    turn: ['legacy-v1', 'cognition-v2', 'cognition-v3'],
    life: ['legacy-v1', 'cognition-v2', 'cognition-v3']
  });
  assert.equal(runtime.orchestrator.releaseExecutorAttached, true);
  assert.throws(
    () => runtime.orchestrator.attachReleaseExecutor(runtime.releaseExecutor),
    /release executor already attached/
  );
});
