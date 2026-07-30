import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRelativePath = 'preset-references/yuqi-social-experience-catalog.json';
const coreRelativePath = 'yuqi-runtime/presets/cognition-core.md';
const outputRelativePath = 'yuqi-runtime/presets/social-experience.json';
const v3PresetRelativeDir = 'yuqi-runtime/presets/2.1.0';
const v3ModuleFiles = [
  'foundation.md',
  'cognition-core-v3.md',
  'expression-v3.md',
  'supervisor-v3.md',
  'consolidation-v3.md'
];
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

function validateV3SocialExperience(asset, { rootDir }) {
  if (asset?.schemaVersion !== 3 || !Array.isArray(asset.experiences)
      || asset.experiences.length === 0) {
    throw new Error('v3 social experience must use schemaVersion 3 and contain experiences');
  }
  const ids = new Set();
  for (const [index, experience] of asset.experiences.entries()) {
    const label = `experiences[${index}]`;
    if (!/^social_|^whole_|^emotion_|^return_|^stance_|^natural_|^independent_|^implicit_/.test(
      String(experience?.experienceId || '')
    )) {
      throw new Error(`${label}.experienceId is invalid`);
    }
    if (ids.has(experience.experienceId)) {
      throw new Error(`duplicate experienceId: ${experience.experienceId}`);
    }
    ids.add(experience.experienceId);
    assertNonEmptyString(experience.pattern, `${label}.pattern`);
    assertNonEmptyString(experience.counterPattern, `${label}.counterPattern`);
    assertNonEmptyStringArray(experience.applicability, `${label}.applicability`);
    assertNonEmptyStringArray(experience.sourceRefs, `${label}.sourceRefs`);
    if (containsCopyableDialogue(experience.pattern)
        || containsCopyableDialogue(experience.counterPattern)) {
      throw new Error(`${experience.experienceId} contains copyable dialogue`);
    }
    for (const reference of experience.sourceRefs) {
      const [filename, section] = String(reference).split('#');
      const sourcePath = resolve(rootDir, 'preset-references', filename);
      if (!existsSync(sourcePath)) throw new Error(`v3 source does not exist: ${filename}`);
      if (!section || !readFileSync(sourcePath, 'utf8').includes(section)) {
        throw new Error(`v3 source section was not found: ${reference}`);
      }
    }
  }
  return asset;
}

export function validateLivedAgencyV3Assets({ rootDir = defaultRoot } = {}) {
  const presetDir = resolve(rootDir, v3PresetRelativeDir);
  const moduleChecksums = {};
  for (const filename of v3ModuleFiles) {
    const text = readFileSync(resolve(presetDir, filename), 'utf8').trim();
    if (!text) throw new Error(`v3 preset module is empty: ${filename}`);
    if (text.length > 16_000) throw new Error(`v3 preset module is too large: ${filename}`);
    moduleChecksums[filename] = createHash('sha256').update(text).digest('hex');
  }
  const socialText = readFileSync(resolve(presetDir, 'social-experience-v3.json'), 'utf8');
  if (socialText.length > 24_000) throw new Error('v3 social experience exceeds 24000 characters');
  const socialExperience = validateV3SocialExperience(JSON.parse(socialText), { rootDir });
  return {
    moduleChecksums,
    experienceCount: socialExperience.experiences.length,
    socialExperienceChecksum: createHash('sha256').update(socialText).digest('hex')
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
  const livedAgencyV3 = validateLivedAgencyV3Assets({ rootDir });
  return { changed, asset, outputPath, livedAgencyV3 };
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
    livedAgencyV3Experiences: result.livedAgencyV3.experienceCount,
    sourceChecksum: result.asset.sourceChecksum
  })}\n`);
}
