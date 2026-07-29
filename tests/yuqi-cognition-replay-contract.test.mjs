import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { contentHash, validateEnvelope } from '../yuqi-runtime/src/protocol.mjs';

const root = join(process.cwd(), 'tests/fixtures/yuqi-cognition-replay-v1');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const cases = readFileSync(join(root, 'cases.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map(line => JSON.parse(line));

test('replay fixture contains exactly thirty cases for all nine turn kinds', () => {
  assert.equal(cases.length, 270);
  assert.equal(manifest.caseCount, 270);
  assert.equal(new Set(cases.map(item => item.caseId)).size, 270);
  assert.equal(contentHash(cases), manifest.casesChecksum);
  assert.deepEqual(new Set(cases.map(item => item.turnKind)), new Set(manifest.turnKinds));
  for (const kind of manifest.turnKinds) {
    assert.equal(cases.filter(item => item.turnKind === kind).length, 30, kind);
  }
});

test('every fixture is protocol-valid, target-resolvable and contains no secrets or base64', () => {
  const serialized = JSON.stringify(cases);
  assert.doesNotMatch(serialized, /BEGIN (?:RSA |EC )?PRIVATE KEY|AIza[0-9A-Za-z_-]{20,}|data:image\/[^;]+;base64/i);
  for (const item of cases) {
    assert.equal(validateEnvelope(item.envelope).kind, item.turnKind);
    assert.ok(Array.isArray(item.expected.allowedActions));
    assert.ok(Array.isArray(item.expected.forbiddenActions));
    assert.ok(Array.isArray(item.expected.publicPrivateConstraints));
  }
});

test('each kind preserves the required source-category quota', () => {
  for (const kind of manifest.turnKinds) {
    const group = cases.filter(item => item.turnKind === kind);
    for (const [category, expected] of Object.entries(manifest.sourceQuotaPerTurnKind)) {
      assert.equal(group.filter(item => item.category === category).length, expected, `${kind}:${category}`);
    }
  }
});

