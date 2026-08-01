import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductionReleaseAdapters } from '../src/production-release-adapters.mjs';

test('production adapters bind each release flavor to one explicit draft provider', async () => {
  const calls = [];
  const args = Object.freeze({
    release: { releaseId: 'release-fixture', presetVersion: '2.1.0' },
    execution: { subjectId: 'subject-fixture' },
    dryRun: true,
    capabilities: Object.freeze({ visibleCommit: false, action: false, state: false })
  });
  const provider = label => input => {
    calls.push([label, input]);
    return { label };
  };
  const orchestrator = {
    executeLegacyReleaseTurnDraft: provider('legacy-turn'),
    executeLegacyLifeReleaseDraft: provider('legacy-life'),
    executeCognitionV2LifeReleaseDraft: provider('v2-life'),
    executeCognitionV3LifeReleaseDraft: provider('v3-life')
  };
  const cognitivePipeline = {
    runV2ReleaseDraft: provider('v2-turn'),
    runV3ReleaseDraft: provider('v3-turn')
  };
  const adapters = createProductionReleaseAdapters({ orchestrator, cognitivePipeline });
  assert.deepEqual([...adapters.turnAdapters.keys()], ['legacy-v1', 'cognition-v2', 'cognition-v3']);
  assert.deepEqual([...adapters.lifeAdapters.keys()], ['legacy-v1', 'cognition-v2', 'cognition-v3']);
  for (const adapter of adapters.turnAdapters.values()) await adapter.executeTurn(args);
  for (const adapter of adapters.lifeAdapters.values()) await adapter.executeLife(args);
  assert.deepEqual(calls.map(([label]) => label), [
    'legacy-turn', 'v2-turn', 'v3-turn',
    'legacy-life', 'v2-life', 'v3-life'
  ]);
  assert.ok(calls.every(([, input]) => input === args));
});

test('production adapters fail closed before exposure when any provider is absent', () => {
  assert.throws(() => createProductionReleaseAdapters({
    orchestrator: {},
    cognitivePipeline: {}
  }), /production release provider is unavailable/);
});
