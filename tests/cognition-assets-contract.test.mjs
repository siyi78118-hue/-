import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import {
  compileCognitionAssets,
  validateSourceCatalog
} from '../scripts/compile-yuqi-cognition-assets.mjs';

const projectRoot = resolve(import.meta.dirname, '..');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeCatalog(overrides = {}) {
  return {
    schemaVersion: 1,
    lessons: [
      {
        lessonId: 'lesson_approved_high',
        status: 'approved',
        priority: 90,
        scenes: ['direct_chat'],
        relationshipStages: ['all'],
        appliesWhen: ['用户表达可能同时承担关系动作'],
        principle: '先识别关系动作，再决定是否回应字面内容。',
        counterSignals: ['用户明确要求只处理字面任务'],
        forbiddenInference: ['一次亲密表达不能证明稳定人格'],
        sourceRefs: [
          {
            path: 'preset-references/source.md',
            section: '## 已确认原则'
          }
        ]
      },
      {
        lessonId: 'lesson_provisional_low',
        status: 'provisional',
        priority: 10,
        scenes: ['direct_chat'],
        relationshipStages: ['all'],
        appliesWhen: ['证据仍不充分'],
        principle: '只把未确认解释保留为待观察线索。',
        counterSignals: ['后续行为不一致'],
        forbiddenInference: ['不得写入已批准运行时经验'],
        sourceRefs: []
      }
    ],
    ...overrides
  };
}

function makeFixtureRoot() {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'yuqi-cognition-assets-'));
  mkdirSync(resolve(rootDir, 'preset-references'), { recursive: true });
  mkdirSync(resolve(rootDir, 'yuqi-runtime', 'presets'), { recursive: true });
  writeFileSync(
    resolve(rootDir, 'preset-references', 'source.md'),
    '# 来源\n\n## 已确认原则\n\n这是人工确认过的原则。\n',
    'utf8'
  );
  writeFileSync(
    resolve(rootDir, 'yuqi-runtime', 'presets', 'cognition-core.md'),
    '# 认知核心\n\n先形成状态，再选择话语。\n',
    'utf8'
  );
  return rootDir;
}

function writeCatalog(rootDir, catalog) {
  const path = resolve(rootDir, 'preset-references', 'yuqi-social-experience-catalog.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
}

test('source catalog rejects invalid identity, status, sources and copyable dialogue', () => {
  const rootDir = makeFixtureRoot();
  try {
    assert.doesNotThrow(() => validateSourceCatalog(makeCatalog(), { rootDir }));

    const duplicate = makeCatalog();
    duplicate.lessons.push(clone(duplicate.lessons[0]));
    assert.throws(
      () => validateSourceCatalog(duplicate, { rootDir }),
      /duplicate lessonId/
    );

    const invalidId = makeCatalog();
    invalidId.lessons[0].lessonId = 'Approved High';
    assert.throws(
      () => validateSourceCatalog(invalidId, { rootDir }),
      /lessonId/
    );

    const invalidStatus = makeCatalog();
    invalidStatus.lessons[0].status = 'draft';
    assert.throws(
      () => validateSourceCatalog(invalidStatus, { rootDir }),
      /status/
    );

    const missingSource = makeCatalog();
    missingSource.lessons[0].sourceRefs[0].path = 'preset-references/missing.md';
    assert.throws(
      () => validateSourceCatalog(missingSource, { rootDir }),
      /sourceRefs/
    );

    const missingSection = makeCatalog();
    missingSection.lessons[0].sourceRefs[0].section = '## 不存在';
    assert.throws(
      () => validateSourceCatalog(missingSection, { rootDir }),
      /section/
    );

    const dialogue = makeCatalog();
    dialogue.lessons[0].principle = '固定回复“那你先忙”。';
    assert.throws(
      () => validateSourceCatalog(dialogue, { rootDir }),
      /copyable dialogue/
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('compiler emits only approved lessons in deterministic order and check detects drift', () => {
  const rootDir = makeFixtureRoot();
  try {
    const catalog = makeCatalog();
    const secondApproved = clone(catalog.lessons[0]);
    secondApproved.lessonId = 'lesson_approved_alpha';
    secondApproved.priority = 90;
    catalog.lessons.push(secondApproved);
    writeCatalog(rootDir, catalog);

    const result = compileCognitionAssets({ rootDir });
    assert.equal(result.changed, true);
    assert.equal(result.asset.schemaVersion, 1);
    assert.equal(
      result.asset.generatedFrom,
      'preset-references/yuqi-social-experience-catalog.json'
    );
    assert.match(result.asset.sourceChecksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(
      result.asset.lessons.map((lesson) => lesson.lessonId),
      ['lesson_approved_alpha', 'lesson_approved_high']
    );
    assert.ok(result.asset.lessons.every((lesson) => lesson.status === 'approved'));
    assert.ok(!JSON.stringify(result.asset).includes('lesson_provisional_low'));

    const generatedPath = resolve(rootDir, 'yuqi-runtime', 'presets', 'social-experience.json');
    assert.deepEqual(JSON.parse(readFileSync(generatedPath, 'utf8')), result.asset);
    assert.equal(compileCognitionAssets({ rootDir, checkOnly: true }).changed, false);

    writeFileSync(generatedPath, '{}\n', 'utf8');
    assert.throws(
      () => compileCognitionAssets({ rootDir, checkOnly: true }),
      /out of sync/
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test('project cognition core and compiled experience stay within prompt budgets', () => {
  const catalog = JSON.parse(
    readFileSync(
      resolve(projectRoot, 'preset-references', 'yuqi-social-experience-catalog.json'),
      'utf8'
    )
  );
  assert.doesNotThrow(() => validateSourceCatalog(catalog, { rootDir: projectRoot }));

  const core = readFileSync(
    resolve(projectRoot, 'yuqi-runtime', 'presets', 'cognition-core.md'),
    'utf8'
  );
  assert.ok(core.length <= 12_000, `cognition core is ${core.length} characters`);

  const result = compileCognitionAssets({ rootDir: projectRoot, checkOnly: true });
  const compiled = `${JSON.stringify(result.asset, null, 2)}\n`;
  assert.ok(compiled.length <= 36_000, `compiled experience is ${compiled.length} characters`);
});
