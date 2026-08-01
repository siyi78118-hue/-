import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ReplayRunner } from '../src/replay-runner.mjs';
import { YuqiStore } from '../src/store.mjs';

test('fixture replay is resumable, dry-run only, and never enters live shadow storage', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-replay-runner-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const artifactRoot = join(dir, 'artifacts');
  let sideEffects = 0;
  const pipeline = label => ({
    async run({ envelope, sandbox, dryRun }) {
      assert.equal(dryRun, true);
      assert.equal(sandbox.dryRun, true);
      return {
        schemaValid: true,
        usedMessageIds: envelope.message ? [envelope.message.messageId] : [],
        actions: [],
        label
      };
    }
  });
  const runner = new ReplayRunner({
    store,
    legacyPipeline: pipeline('legacy'),
    cognitivePipeline: pipeline('cognition'),
    sandboxFactory: async () => ({
      dryRun: true,
      actionSink: { send: () => { sideEffects += 1; } },
      notificationSink: { send: () => { sideEffects += 1; } },
      cloudSink: { send: () => { sideEffects += 1; } }
    }),
    artifactRoot,
    concurrency: 2
  });
  try {
    const result = await runner.runFixtureBatch({
      runId: 'fixture-test',
      datasetPath: 'tests/fixtures/yuqi-cognition-protocol-v1',
      presetVersion: '2.0.0'
    });
    assert.equal(result.summary.completed, 270);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.summary.eligible, true);
    assert.equal(result.summary.sourceType, 'fixture');
    assert.equal(result.summary.liveShadowCountBefore, 0);
    assert.equal(result.summary.liveShadowCountAfter, 0);
    assert.equal(sideEffects, 0);
    assert.equal(store.listReplayRuns('fixture-test').length, 270);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS value FROM cognition_shadow_runs').get().value, 0);
    const resumed = await runner.runFixtureBatch({
      runId: 'fixture-test',
      datasetPath: 'tests/fixtures/yuqi-cognition-protocol-v1',
      presetVersion: '2.0.0'
    });
    assert.equal(resumed.summary.completed, 270);
    assert.ok(store.listReplayRuns('fixture-test').every(run => run.sourceType === 'approved_fixture'));
    assert.ok(store.listReplayRuns('fixture-test').every(run => run.attemptCount === 1));
  } finally {
    store.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
