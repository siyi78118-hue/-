import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('only the Store source mutates cognition_kind_rollouts', () => {
  const allowed = readFileSync(join(root, 'yuqi-runtime/src/store.mjs'), 'utf8');
  assert.match(allowed, /UPDATE cognition_kind_rollouts/);
  for (const relative of [
    'yuqi-runtime/src/promotion-controller.mjs',
    'yuqi-runtime/src/turn-dispatcher.mjs',
    'yuqi-runtime/src/orchestrator.mjs',
    'yuqi-runtime/src/local-server.mjs'
  ]) {
    const source = readFileSync(join(root, relative), 'utf8');
    assert.doesNotMatch(source, /UPDATE\s+cognition_kind_rollouts/i, relative);
  }
});

test('runtime bootstrap config has no activeKinds or shadowKinds authority', () => {
  const config = JSON.parse(readFileSync(join(root, 'yuqi-runtime/config.example.json'), 'utf8'));
  assert.equal(config.cognitionRuntime.rolloutBootstrap.defaultMode, 'legacy');
  assert.equal(config.cognitionRuntime.activeKinds, undefined);
  assert.equal(config.cognitionRuntime.shadowKinds, undefined);
});

