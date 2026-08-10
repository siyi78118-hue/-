import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONNECTED_DEVICE_RACE_NAMES,
  CONNECTED_DEVICE_RACE_TEST_CLASS
} from '../scripts/verify-yuqi-v3-readiness.mjs';

test('connected registry is the closed eleven-name contract', () => {
  assert.equal(CONNECTED_DEVICE_RACE_NAMES.length, 11);
  assert.equal(new Set(CONNECTED_DEVICE_RACE_NAMES).size, 11);
  assert.equal(CONNECTED_DEVICE_RACE_TEST_CLASS,
    'com.siyi.al.execution.YuqiV3ConnectedRaceTest');
});
test('connected names are exact and do not accept prefix or suffix variants', () => {
  for (const name of CONNECTED_DEVICE_RACE_NAMES) {
    assert.ok(CONNECTED_DEVICE_RACE_NAMES.includes(name));
    assert.equal(CONNECTED_DEVICE_RACE_NAMES.includes(`${name}Extra`), false);
    assert.equal(CONNECTED_DEVICE_RACE_NAMES.includes(`prefix_${name}`), false);
    assert.equal(CONNECTED_DEVICE_RACE_NAMES.includes(name.slice(0, -1)), false);
  }
});
