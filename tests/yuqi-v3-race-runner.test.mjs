import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PC_RACE_CASES,
  PC_RACE_IDS,
  runPcRaceMatrix,
  sha256,
  writeRaceReport
} from '../scripts/verify-yuqi-v3-races.mjs';

function nodeOutput(names, {
  tests = 12,
  pass = names.length,
  fail = 0,
  cancelled = 0,
  skipped = 12 - pass - fail - cancelled,
  exitCode = fail || cancelled ? 1 : 0
} = {}) {
  return {
    exitCode,
    stdout: `${names.map(name => `✔ ${name} (1ms)`).join('\n')}\n`
      + `ℹ tests ${tests}\nℹ pass ${pass}\nℹ fail ${fail}\n`
      + `ℹ cancelled ${cancelled}\nℹ skipped ${skipped}\n`,
    stderr: ''
  };
}

test('race registry is a closed id to file/pattern mapping', () => {
  assert.equal(typeof PC_RACE_CASES, 'object');
  assert.equal(Array.isArray(PC_RACE_CASES), false);
  assert.deepEqual(Object.keys(PC_RACE_CASES), PC_RACE_IDS);
  for (const [id, entry] of Object.entries(PC_RACE_CASES)) {
    assert.deepEqual(Object.keys(entry).sort(), ['file', 'pattern']);
    assert.equal(entry.file, 'tests/yuqi-v3-races.test.mjs');
    assert.equal(new RegExp(entry.pattern).test(id), true);
    assert.equal(new RegExp(entry.pattern).test(`${id}_suffix`), false);
    assert.equal(new RegExp(entry.pattern).test(`prefix_${id}`), false);
    assert.equal(new RegExp(entry.pattern).test(id.slice(1)), false);
    assert.equal(new RegExp(entry.pattern).test(id.slice(0, -1)), false);
  }
});

test('runner accepts exactly twelve named passes once', async () => {
  const result = await runPcRaceMatrix({
    execute: async ({ id }) => nodeOutput([id], { skipped: 11 })
  });
  assert.equal(result.counts.passed, 12);
  assert.deepEqual(result.pcCases.map(item => item.id), PC_RACE_IDS);
});

test('runner passes each closed file and anchored pattern to its command executor', async () => {
  const seen = [];
  await runPcRaceMatrix({
    execute: async context => {
      seen.push(context);
      return nodeOutput([context.id], { skipped: 11 });
    }
  });
  assert.deepEqual(seen.map(item => item.id), PC_RACE_IDS);
  for (const item of seen) {
    assert.equal(item.file, PC_RACE_CASES[item.id].file);
    assert.equal(item.pattern, PC_RACE_CASES[item.id].pattern);
    assert.equal(new RegExp(item.pattern).test(item.id), true);
    assert.equal(new RegExp(item.pattern).test(`${item.id}_suffix`), false);
    assert.equal(new RegExp(item.pattern).test(`prefix_${item.id}`), false);
    assert.equal(new RegExp(item.pattern).test(item.id.slice(1)), false);
  }
});

for (const [name, output] of [
  ['missing name', ({ id }) => nodeOutput([], { pass: 0, skipped: 12 })],
  ['duplicate pass', ({ id }) => nodeOutput([id, id], { pass: 2, skipped: 10 })],
  ['extra test', ({ id }) => nodeOutput([id, 'unexpected_case'], { pass: 2, skipped: 10 })],
  ['zero tests', ({ id }) => nodeOutput([], { tests: 0, pass: 0, skipped: 0 })],
  ['skip', ({ id }) => nodeOutput([id], { pass: 1, skipped: 12 })],
  ['fail and cancel', ({ id }) => nodeOutput([id], { fail: 1, cancelled: 1, pass: 0, skipped: 10 })],
  ['nonzero exit', ({ id }) => ({ ...nodeOutput([id], { skipped: 11 }), exitCode: 7 })],
  ['wrong registered name', ({ id }) => nodeOutput(['wrong_registered_name'], { pass: 1, skipped: 11 })]
]) {
  test(`runner rejects ${name}`, async () => {
    await assert.rejects(
      () => runPcRaceMatrix({ execute: async context => output(context) }),
      /closed registry|did not execute|failed or skipped|output does not exactly match/
    );
  });
}

test('source checksum helper hashes raw bytes', () => {
  assert.equal(
    sha256(Buffer.from([0, 255, 1])),
    '47ffa3ea45a70b8a41c2c0825df323c00a8b7a01c1ea06083cc41dddcc001123'
  );
});

test('race report records orchestrator and runner source bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-v3-race-report-'));
  try {
    const report = await writeRaceReport({
      out: join(root, 'race-report.json'),
      execute: async ({ id }) => nodeOutput([id], { skipped: 11 })
    });
    assert.equal(typeof report.sourceChecksums['yuqi-runtime/src/orchestrator.mjs'], 'string');
    assert.equal(typeof report.sourceChecksums['tests/yuqi-v3-race-runner.test.mjs'], 'string');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
