import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(
  projectRoot,
  'tests',
  'fixtures',
  'yuqi-cognition-feature-matrix.json',
);
const planPath = path.join(
  projectRoot,
  'docs',
  'superpowers',
  'plans',
  '2026-07-29-yuqi-cognitive-runtime.md',
);

const expectedTurnKinds = [
  'DIRECT_REPLY',
  'ROLE_PLAN_CHAT',
  'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE',
  'PROACTIVE_CHAT',
  'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION',
  'MOMENT_REPLY',
];

const requiredCapabilities = [
  'fullCurrentBatch',
  'quotes',
  'images',
  'voiceMessages',
  'unicodeEmoji',
  'payment',
  'baseStage',
  'phaseStage',
  'stagePersona',
  'rolePlans',
  'roleSchedule',
  'lifeTimeline',
  'deliveryReceipt',
  'fallback',
  'phoneMemoryDb',
  'roleAndPlayerProfile',
  'chatUiState',
  'settingsCompatibility',
  'rolloutAuthority',
  'replayIsolation',
  'liveShadow',
  'activeCanary',
  'automaticRollback',
  'staleCompareIsolation',
  'canaryBackpressure',
  'activeFailureRollback',
  'serviceWorkerUpdate',
  'backupRestore',
  'clearDelete',
];

function readMatrix() {
  assert.ok(fs.existsSync(fixturePath), `feature matrix fixture is missing: ${fixturePath}`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

function collectPlannedFiles() {
  const plan = fs.readFileSync(planPath, 'utf8');
  return new Set(
    [...plan.matchAll(/^- 新建(?:（生成物）)?：`([^`]+)`/gmu)].map((match) =>
      match[1].replaceAll('/', path.sep),
    ),
  );
}

function assertReference(reference, { plannedFiles }) {
  assert.equal(typeof reference?.path, 'string');
  assert.ok(reference.path.length > 0);
  assert.ok(['implemented', 'planned'].includes(reference.status));

  const normalizedPath = reference.path.replaceAll('/', path.sep);
  if (reference.status === 'implemented') {
    assert.ok(
      fs.existsSync(path.join(projectRoot, normalizedPath)),
      `implemented test does not exist: ${reference.path}`,
    );
  } else {
    assert.ok(
      plannedFiles.has(normalizedPath),
      `planned test is not declared as a new file in the plan: ${reference.path}`,
    );
  }
}

function assertReferences(references, context) {
  assert.ok(Array.isArray(references));
  assert.ok(references.length > 0);
  for (const reference of references) {
    assertReference(reference, context);
  }
}

test('feature matrix covers every Yuqi turn kind without aliases', () => {
  const matrix = readMatrix();
  assert.equal(matrix.schemaVersion, 1);
  assert.deepEqual(Object.keys(matrix.turnKinds).sort(), [...expectedTurnKinds].sort());

  const context = { plannedFiles: collectPlannedFiles() };
  for (const turnKind of expectedTurnKinds) {
    const entry = matrix.turnKinds[turnKind];
    for (const field of ['requiredContext', 'allowedActions', 'forbiddenActions']) {
      assert.ok(Array.isArray(entry[field]), `${turnKind}.${field} must be an array`);
      assert.ok(entry[field].length > 0, `${turnKind}.${field} must not be empty`);
    }
    assertReferences(entry.legacyTests, context);
    assertReferences(entry.activeTests, context);
  }
});

test('feature matrix links every cross-cutting capability to legacy and cognition tests', () => {
  const matrix = readMatrix();
  assert.deepEqual(
    Object.keys(matrix.crossCuttingCapabilities).sort(),
    [...requiredCapabilities].sort(),
  );

  const context = { plannedFiles: collectPlannedFiles() };
  for (const capability of requiredCapabilities) {
    const entry = matrix.crossCuttingCapabilities[capability];
    assertReferences(entry.legacyTests, context);
    assertReferences(entry.cognitionTests, context);
    assert.ok(
      entry.legacyTests.some(({ status }) => status === 'implemented'),
      `${capability} needs an existing regression test`,
    );
    assert.ok(
      entry.cognitionTests.some(({ status }) => status === 'planned'),
      `${capability} needs a planned cognition-v2 test`,
    );
  }
});
