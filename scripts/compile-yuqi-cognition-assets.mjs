import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelativePath = 'preset-references/yuqi-social-experience-catalog.json';
const coreRelativePath = 'yuqi-runtime/presets/cognition-core.md';
const outputRelativePath = 'yuqi-runtime/presets/social-experience.json';
const allowedStatuses = new Set(['approved', 'provisional', 'retired']);
const requiredArrayFields = [
  'scenes',
  'relationshipStages',
  'appliesWhen',
  'counterSignals',
  'forbiddenInference'
];

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertNonEmptyStringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  for (const [index, item] of value.entries()) {
    assertNonEmptyString(item, `${label}[${index}]`);
  }
}

function containsCopyableDialogue(principle) {
  return /[“”「」『』]|(?:^|[\s，。；：])["'][^"'\r\n]{1,80}["']/.test(principle);
}

export function validateSourceCatalog(catalog, { rootDir }) {
  if (!catalog || catalog.schemaVersion !== 1 || !Array.isArray(catalog.lessons)) {
    throw new Error('catalog must use schemaVersion 1 and contain lessons');
  }

  const lessonIds = new Set();
  for (const [index, lesson] of catalog.lessons.entries()) {
    const label = `lessons[${index}]`;
    if (typeof lesson.lessonId !== 'string' || !/^lesson_[a-z0-9_]+$/.test(lesson.lessonId)) {
      throw new Error(`${label}.lessonId is invalid`);
    }
    if (lessonIds.has(lesson.lessonId)) {
      throw new Error(`duplicate lessonId: ${lesson.lessonId}`);
    }
    lessonIds.add(lesson.lessonId);

    if (!allowedStatuses.has(lesson.status)) {
      throw new Error(`${lesson.lessonId}.status is invalid`);
    }
    if (!Number.isFinite(lesson.priority)) {
      throw new Error(`${lesson.lessonId}.priority must be finite`);
    }
    for (const field of requiredArrayFields) {
      assertNonEmptyStringArray(lesson[field], `${lesson.lessonId}.${field}`);
    }
    assertNonEmptyString(lesson.principle, `${lesson.lessonId}.principle`);
    if (containsCopyableDialogue(lesson.principle)) {
      throw new Error(`${lesson.lessonId}.principle contains copyable dialogue`);
    }

    if (!Array.isArray(lesson.sourceRefs)) {
      throw new Error(`${lesson.lessonId}.sourceRefs must be an array`);
    }
    if (lesson.status === 'approved' && lesson.sourceRefs.length === 0) {
      throw new Error(`${lesson.lessonId}.sourceRefs must include approved evidence`);
    }
    for (const [sourceIndex, sourceRef] of lesson.sourceRefs.entries()) {
      const sourceLabel = `${lesson.lessonId}.sourceRefs[${sourceIndex}]`;
      assertNonEmptyString(sourceRef?.path, `${sourceLabel}.path`);
      assertNonEmptyString(sourceRef?.section, `${sourceLabel}.section`);
      const sourcePath = resolve(rootDir, sourceRef.path);
      if (!existsSync(sourcePath)) {
        throw new Error(`${sourceLabel} does not exist: ${sourceRef.path}`);
      }
      if (!readFileSync(sourcePath, 'utf8').includes(sourceRef.section)) {
        throw new Error(`${sourceLabel}.section was not found: ${sourceRef.section}`);
      }
    }
  }
  return catalog;
}

function toRuntimeLesson(lesson) {
  return {
    lessonId: lesson.lessonId,
    status: lesson.status,
    priority: lesson.priority,
    scenes: lesson.scenes,
    relationshipStages: lesson.relationshipStages,
    appliesWhen: lesson.appliesWhen,
    principle: lesson.principle,
    counterSignals: lesson.counterSignals,
    forbiddenInference: lesson.forbiddenInference
  };
}

export function compileCognitionAssets({ rootDir = defaultRoot, checkOnly = false } = {}) {
  const sourcePath = resolve(rootDir, sourceRelativePath);
  const corePath = resolve(rootDir, coreRelativePath);
  const outputPath = resolve(rootDir, outputRelativePath);
  const sourceText = readFileSync(sourcePath, 'utf8');
  const catalog = validateSourceCatalog(JSON.parse(sourceText), { rootDir });
  const core = readFileSync(corePath, 'utf8');
  if (core.length > 12_000) {
    throw new Error(`cognition core exceeds 12000 characters: ${core.length}`);
  }

  const asset = {
    schemaVersion: 1,
    generatedFrom: sourceRelativePath,
    sourceChecksum: createHash('sha256').update(sourceText).digest('hex'),
    lessons: catalog.lessons
      .filter((lesson) => lesson.status === 'approved')
      .sort((left, right) => right.priority - left.priority || left.lessonId.localeCompare(right.lessonId))
      .map(toRuntimeLesson)
  };
  const expected = `${JSON.stringify(asset, null, 2)}\n`;
  if (expected.length > 36_000) {
    throw new Error(`compiled social experience exceeds 36000 characters: ${expected.length}`);
  }

  let actual = '';
  try {
    actual = readFileSync(outputPath, 'utf8');
  } catch {}
  const changed = actual !== expected;
  if (changed && checkOnly) {
    throw new Error(`cognition asset is out of sync: ${outputPath}`);
  }
  if (changed) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, expected, 'utf8');
  }
  return { changed, asset, outputPath };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = compileCognitionAssets({
    rootDir: defaultRoot,
    checkOnly: process.argv.includes('--check')
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    changed: result.changed,
    output: outputRelativePath,
    lessons: result.asset.lessons.length,
    sourceChecksum: result.asset.sourceChecksum
  })}\n`);
}
