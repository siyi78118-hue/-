import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const verifier = readFileSync(new URL('../scripts/verify-yuqi-runtime.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Yuqi verifier covers every deterministic delivery gate', () => {
  for (const check of [
    'node-runtime-tests',
    'relay-tests',
    'android-jvm-tests',
    'protocol-v2-contract',
    'no-empty-user-trigger',
    'version-contract'
  ]) {
    assert.match(verifier, new RegExp(`['\"]${check}['\"]`));
  }
  assert.equal(pkg.scripts['yuqi:verify'], 'node scripts/verify-yuqi-runtime.mjs');
});
