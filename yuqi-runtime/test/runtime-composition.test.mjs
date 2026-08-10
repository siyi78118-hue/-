import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CognitivePipeline } from '../src/cognitive-pipeline.mjs';
import {
  assertProductionRuntimeAttestation,
  assertQualityPhaseClientSlot,
  composeYuqiExecutionRuntime,
} from '../src/runtime-composition.mjs';
import { createQualityPhaseClientSlot, QualityReplayLedger } from '../src/quality-replay-ledger.mjs';

function withLedgerSlot(identity, run) {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-runtime-composition-'));
  const ledger = new QualityReplayLedger(join(root, 'quality.sqlite'));
  try {
    return run(createQualityPhaseClientSlot(identity, { ledger }));
  } finally {
    try { ledger.close(); } catch {}
    try { rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

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

test('production composition rejects fake dependencies at the attestation boundary', () => {
  const runtime = composeYuqiExecutionRuntime({
    ...runtimeFixture(),
    sourceHead: 'a'.repeat(40),
  });
  assert.throws(() => assertProductionRuntimeAttestation(runtime, {
    sourceHead: 'a'.repeat(40),
  }), /production runtime dependencies/);
  assert.throws(() => assertProductionRuntimeAttestation({ ...runtime }, {}), /production runtime attestation/);
});

test('quality runtime keeps an immutable branded phase slot out of public mutation', () => {
  withLedgerSlot({
    runId: 'run_quality_1', finalKey: 'coverage:scene-0:0',
    phase: 'stable_execution', side: 'stable'
  }, slot => {
    const runtime = composeYuqiExecutionRuntime({ ...runtimeFixture(), qualityPhaseClientSlot: slot });
    assert.equal(assertQualityPhaseClientSlot(runtime, slot), true);
    assert.throws(() => assertQualityPhaseClientSlot(runtime, {}), /phase slot|identity/i);
    assert.equal(Object.prototype.hasOwnProperty.call(runtime, 'qualityPhaseClientSlot'), false);
    assert.throws(() => { runtime.qualityPhaseClientSlot = {}; }, /read only|extensible|strict/i);
  });
});

test('quality composition clones the cognitive pipeline and never mutates the caller instance', () => {
  withLedgerSlot({
    runId: 'run_quality_2', finalKey: 'coverage:scene-1:0',
    phase: 'stable_execution', side: 'stable'
  }, slot => {
    const sourceClient = { runTurn() {} };
    const sourcePipeline = new CognitivePipeline({
      store: {}, codexClient: sourceClient, presetRegistry: {}, routePolicy: null,
    });
    const runtime = composeYuqiExecutionRuntime({
      ...runtimeFixture(), cognitivePipeline: sourcePipeline,
      qualityPhaseClientSlot: slot,
    });
    assert.equal(sourcePipeline.codexClient, sourceClient);
    assert.notEqual(runtime.orchestrator.cognitivePipeline, sourcePipeline);
    assert.notEqual(runtime.orchestrator.cognitivePipeline.codexClient, sourceClient);
    assert.equal(assertQualityPhaseClientSlot(runtime, slot), true);
  });
});
