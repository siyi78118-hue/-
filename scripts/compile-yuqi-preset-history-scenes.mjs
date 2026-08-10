import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';

const SOURCE_AUTHORITY = 'tracked_human_annotations';
const ANNOTATION_VERSION = 'task25f-annotation-v1';
const SOURCE_INDEX_KEYS = new Set([
  'schemaVersion', 'sourceAuthority', 'annotationVersion', 'scenes', 'indexChecksum'
]);
const SCENE_KEYS = new Set([
  'sceneId', 'file', 'heading', 'sourceDocSha256', 'sectionChecksum', 'sceneChecksum',
  'rolloutKey', 'prompt', 'context', 'followUp', 'focus', 'severity', 'mustNotice',
  'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation',
  'initialState'
]);
const FORBIDDEN_TEMPLATE_KEYS = new Set([
  'assistantReply', 'replyTemplate', 'expectedResponse', 'acceptedReply', 'modelAnswer'
]);
const ALLOWED_FILES = new Set([
  '真人聊天训练批注-第一轮.md',
  '真人聊天训练批注-第二轮.md'
]);
const ALLOWED_ROLLOUT_KEYS = new Set(['DIRECT_REPLY', 'PROACTIVE_CHAT']);
const ALLOWED_SEVERITIES = new Set(['critical', 'high', 'medium']);

function sha256Utf8(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} shape conflict`);
}

function assertClosedKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} unknown key: ${unknown[0]}`);
}

function assertStringArray(value, label) {
  if (!Array.isArray(value) || !value.length
    || value.some(item => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be a non-empty string array`);
  }
}

function indexBasis(index) {
  return {
    schemaVersion: index.schemaVersion,
    sourceAuthority: index.sourceAuthority,
    annotationVersion: index.annotationVersion,
    scenes: index.scenes
  };
}

function sceneBasis(entry) {
  const {
    sourceDocSha256: _sourceDocSha256,
    sectionChecksum: _sectionChecksum,
    sceneChecksum: _sceneChecksum,
    ...basis
  } = entry;
  return basis;
}

function sourceSection(markdown, heading, file) {
  const normalized = markdown.replaceAll('\r\n', '\n');
  const lines = normalized.split('\n');
  const matches = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{2,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (match && match[2] === heading) matches.push({ index, level: match[1].length });
  }
  if (matches.length !== 1) {
    throw new Error(`annotation heading authority conflict: ${file}#${heading}`);
  }
  const start = matches[0];
  let end = lines.length;
  for (let index = start.index + 1; index < lines.length; index += 1) {
    const match = /^(#{2,6})\s+/.exec(lines[index]);
    if (match && match[1].length <= start.level) {
      end = index;
      break;
    }
  }
  return lines.slice(start.index, end).join('\n').trimEnd();
}

function validateEntryShape(entry) {
  assertClosedKeys(entry, SCENE_KEYS, 'preset history scene');
  for (const key of FORBIDDEN_TEMPLATE_KEYS) {
    if (Object.hasOwn(entry, key)) throw new Error(`reply template field forbidden: ${key}`);
  }
  for (const key of ['sceneId', 'file', 'heading', 'rolloutKey', 'prompt', 'context', 'followUp', 'focus']) {
    if (typeof entry[key] !== 'string' || !entry[key].trim()) throw new Error(`preset history ${key} conflict`);
  }
  if (!entry.sceneId.startsWith('history_annotation_')) throw new Error('preset history scene ID namespace conflict');
  if (!ALLOWED_FILES.has(entry.file) || basename(entry.file) !== entry.file) {
    throw new Error('preset history source file conflict');
  }
  if (!ALLOWED_ROLLOUT_KEYS.has(entry.rolloutKey)) throw new Error('preset history rollout kind conflict');
  if (!ALLOWED_SEVERITIES.has(entry.severity)) throw new Error('preset history severity conflict');
  for (const key of [
    'mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation'
  ]) {
    if (entry[key] !== undefined) assertStringArray(entry[key], `preset history ${key}`);
  }
  if (entry.initialState !== undefined) assertPlainObject(entry.initialState, 'preset history initialState');
}

function turnsFor(entry) {
  if (entry.rolloutKey === 'PROACTIVE_CHAT') {
    return [
      {
        at: '2026-07-06T20:00:00+08:00',
        speaker: 'user',
        batch: [{ messageId: `${entry.sceneId}:u1`, type: 'text', text: entry.prompt }]
      },
      { at: '2026-07-08T19:59:55+08:00', speaker: 'system', event: 'elapsed_time' },
      { at: '2026-07-08T20:00:00+08:00', speaker: 'system', event: 'proactive_context' },
      { at: '2026-07-08T20:00:05+08:00', speaker: 'system', event: 'candidate_response' }
    ];
  }
  return [
    {
      at: '2026-07-08T20:00:00+08:00',
      speaker: 'user',
      batch: [{ messageId: `${entry.sceneId}:u1`, type: 'text', text: entry.prompt }]
    },
    { at: '2026-07-08T20:00:20+08:00', speaker: 'system', event: 'scenario_context' },
    {
      at: '2026-07-08T20:01:00+08:00',
      speaker: 'user',
      batch: [{ messageId: `${entry.sceneId}:u2`, type: 'text', text: entry.followUp }]
    },
    { at: '2026-07-08T20:01:05+08:00', speaker: 'system', event: 'candidate_response' }
  ];
}

function materializeScene(entry) {
  const basis = sceneBasis(entry);
  const sceneChecksum = contentHash(basis);
  if (entry.sceneChecksum !== sceneChecksum) throw new Error(`annotation scene checksum conflict: ${entry.sceneId}`);
  return {
    sceneId: entry.sceneId,
    rolloutKey: entry.rolloutKey,
    sourceAuthority: SOURCE_AUTHORITY,
    evidenceClass: 'human_annotation_regression',
    qualityOnly: true,
    realHistoryEvidence: false,
    liveShadowEvidenceEligible: false,
    annotationVersion: ANNOTATION_VERSION,
    sourceAnnotation: {
      file: entry.file,
      heading: entry.heading,
      sourceDocSha256: entry.sourceDocSha256,
      sectionChecksum: entry.sectionChecksum,
      sceneChecksum
    },
    focus: entry.focus,
    severity: entry.severity,
    context: entry.rolloutKey === 'PROACTIVE_CHAT'
      ? { currentTrigger: entry.followUp }
      : {},
    turns: turnsFor(entry),
    initialState: structuredClone(entry.initialState || {
      relationship: { base: 'familiar', phase: 'normal' },
      lifeSignals: [],
      currentStances: [],
      verifiedFacts: []
    }),
    mustNotice: [...(entry.mustNotice || [entry.focus])],
    allowedDecisionRange: [...(entry.allowedDecisionRange || [
      'direct attitude', 'brief question', 'natural pause', 'concrete self-disclosure'
    ])],
    forbiddenFailurePatterns: [...(entry.forbiddenFailurePatterns || [
      'copy an annotated reply', 'analysis template', 'invented memory', 'automatic service posture'
    ])],
    requiredActionIntegrity: {
      responseMustTarget: entry.rolloutKey === 'PROACTIVE_CHAT' ? 'proactive_turn' : `${entry.sceneId}:u2`
    },
    allowedPersonalityVariation: [...(entry.allowedPersonalityVariation || [
      'warm', 'teasing', 'reserved', 'brief', 'temporarily impatient'
    ])],
    expectedStateTransitions: { allow: ['maintain', 'soften', 'reverse', 'pause'] },
    forbiddenStateTransitions: { inventRelationshipOrMemory: true }
  };
}

export function presetHistoryArtifactPaths(rootDir = process.cwd()) {
  const fixtureRoot = resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1');
  return {
    sourceIndexPath: join(fixtureRoot, 'task25f-history-source-index.json'),
    scenesPath: join(fixtureRoot, 'preset-history-scenes.jsonl'),
    manifestPath: join(fixtureRoot, 'preset-history-scenes.manifest.json')
  };
}

function readSourceIndex(path) {
  const index = JSON.parse(readFileSync(path, 'utf8'));
  assertClosedKeys(index, SOURCE_INDEX_KEYS, 'preset history source index');
  if (index.schemaVersion !== 1 || index.sourceAuthority !== SOURCE_AUTHORITY
    || index.annotationVersion !== ANNOTATION_VERSION || !Array.isArray(index.scenes)
    || index.scenes.length !== 30 || !/^[0-9a-f]{64}$/.test(index.indexChecksum || '')) {
    throw new Error('preset history source index authority conflict');
  }
  if (index.indexChecksum !== contentHash(indexBasis(index))) {
    throw new Error('preset history source index checksum conflict');
  }
  return index;
}

export function compilePresetHistoryScenes({ rootDir = process.cwd(), sourceIndexPath } = {}) {
  const paths = presetHistoryArtifactPaths(rootDir);
  const indexPath = sourceIndexPath || paths.sourceIndexPath;
  const index = readSourceIndex(indexPath);
  const ids = new Set();
  const sources = new Set();
  const scenes = [];
  for (const entry of index.scenes) {
    validateEntryShape(entry);
    if (ids.has(entry.sceneId)) throw new Error(`duplicate preset history scene ID: ${entry.sceneId}`);
    ids.add(entry.sceneId);
    const sourceKey = `${entry.file}\u0000${entry.heading}`;
    if (sources.has(sourceKey)) throw new Error(`duplicate annotation heading: ${entry.file}#${entry.heading}`);
    sources.add(sourceKey);
    const markdownPath = resolve(rootDir, 'preset-references', entry.file);
    const markdown = readFileSync(markdownPath, 'utf8');
    if (sha256Utf8(markdown) !== entry.sourceDocSha256) {
      throw new Error(`annotation source document checksum conflict: ${entry.file}`);
    }
    const section = sourceSection(markdown, entry.heading, entry.file);
    if (sha256Utf8(section) !== entry.sectionChecksum) {
      throw new Error(`annotation section checksum conflict: ${entry.file}#${entry.heading}`);
    }
    scenes.push(materializeScene(entry));
  }
  const sourceCounts = Object.fromEntries([...ALLOWED_FILES].map(file => [
    file,
    scenes.filter(scene => scene.sourceAnnotation.file === file).length
  ]));
  if (sourceCounts['真人聊天训练批注-第一轮.md'] !== 20
    || sourceCounts['真人聊天训练批注-第二轮.md'] !== 10) {
    throw new Error('preset history annotation round distribution conflict');
  }
  const manifest = {
    schemaVersion: 1,
    sceneIds: scenes.map(scene => scene.sceneId),
    scenesChecksum: contentHash(scenes)
  };
  return { scenes, manifest, sourceIndex: index };
}

export function writePresetHistoryArtifacts({ rootDir = process.cwd(), sourceIndexPath } = {}) {
  const paths = presetHistoryArtifactPaths(rootDir);
  const compiled = compilePresetHistoryScenes({ rootDir, sourceIndexPath });
  writeFileSync(paths.scenesPath, `${compiled.scenes.map(scene => canonicalJson(scene)).join('\n')}\n`, 'utf8');
  writeFileSync(paths.manifestPath, `${JSON.stringify(compiled.manifest, null, 2)}\n`, 'utf8');
  return { ...compiled, ...paths };
}

export function loadVerifiedPresetHistoryArtifacts({ rootDir = process.cwd() } = {}) {
  const paths = presetHistoryArtifactPaths(rootDir);
  const compiled = compilePresetHistoryScenes({ rootDir });
  const diskScenes = readFileSync(paths.scenesPath, 'utf8')
    .split(/\r?\n/).filter(line => line.trim()).map(JSON.parse);
  const diskManifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
  if (canonicalJson(diskScenes) !== canonicalJson(compiled.scenes)
    || canonicalJson(diskManifest) !== canonicalJson(compiled.manifest)) {
    throw new Error('human annotation source commitment conflict');
  }
  return compiled;
}

function cliOption(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const rootDir = cliOption('--root') || process.cwd();
  const sourceIndexPath = cliOption('--source-index');
  const result = process.argv.includes('--write')
    ? writePresetHistoryArtifacts({ rootDir, sourceIndexPath })
    : compilePresetHistoryScenes({ rootDir, sourceIndexPath });
  process.stdout.write(`${JSON.stringify({
    sourceAuthority: SOURCE_AUTHORITY,
    annotationVersion: ANNOTATION_VERSION,
    sceneCount: result.scenes.length,
    scenesChecksum: result.manifest.scenesChecksum
  }, null, 2)}\n`);
}
