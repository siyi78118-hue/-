import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  loadSocialExperienceCatalog,
  selectSocialExperience
} from '../src/social-experience.mjs';

function lesson(lessonId, {
  priority = 50,
  scenes = ['direct_chat'],
  relationshipStages = ['all'],
  appliesWhen = ['gift'],
  counterSignals = []
} = {}) {
  return {
    lessonId,
    status: 'approved',
    priority,
    scenes,
    relationshipStages,
    appliesWhen,
    principle: `${lessonId} principle`,
    counterSignals,
    forbiddenInference: [`${lessonId} forbidden`]
  };
}

test('loads only a valid compiled social-experience asset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-social-experience-'));
  try {
    const path = join(dir, 'social-experience.json');
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      generatedFrom: 'source.json',
      sourceChecksum: 'a'.repeat(64),
      lessons: [lesson('lesson_one')]
    }), 'utf8');
    const catalog = loadSocialExperienceCatalog(path);
    assert.equal(catalog.lessons.length, 1);
    assert.equal(catalog.lessons[0].lessonId, 'lesson_one');

    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      lessons: [{ ...lesson('lesson_bad'), status: 'provisional' }]
    }), 'utf8');
    assert.throws(() => loadSocialExperienceCatalog(path), /approved/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selects at most five approved lessons using explainable signals and stable ties', () => {
  const catalog = {
    schemaVersion: 1,
    lessons: [
      lesson('lesson_countered', {
        priority: 100,
        counterSignals: ['报销']
      }),
      lesson('lesson_wrong_scene', {
        priority: 100,
        scenes: ['proactive_moment']
      }),
      lesson('lesson_alpha', { priority: 80 }),
      lesson('lesson_beta', { priority: 80 }),
      lesson('lesson_gamma', { priority: 70 }),
      lesson('lesson_delta', { priority: 60 }),
      lesson('lesson_epsilon', { priority: 50 }),
      lesson('lesson_zeta', { priority: 40 }),
      { ...lesson('lesson_provisional', { priority: 100 }), status: 'provisional' }
    ]
  };
  const selected = selectSocialExperience({
    catalog,
    turnKind: 'DIRECT_REPLY',
    currentBatch: {
      messages: [{ content: '这个 gift 不是报销，是我想送你的' }]
    },
    trigger: null,
    relationshipStage: { id: 'familiar' },
    routeReasons: ['relationship_action']
  });

  assert.equal(selected.length, 5);
  assert.deepEqual(
    selected.slice(0, 2).map((item) => item.lessonId),
    ['lesson_alpha', 'lesson_beta']
  );
  assert.ok(selected.every((item) => Number.isFinite(item.selectionScore)));
  assert.ok(selected.every((item) => Array.isArray(item.selectionReasons)));
  assert.equal(selected.some((item) => item.lessonId === 'lesson_provisional'), false);
  assert.equal(selected.some((item) => item.lessonId === 'lesson_wrong_scene'), false);
  assert.equal(selected.some((item) => item.lessonId === 'lesson_countered'), false);
});
