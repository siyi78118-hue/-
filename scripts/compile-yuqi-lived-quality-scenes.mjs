import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { contentHash } from '../yuqi-runtime/src/protocol.mjs';

const VARIANT_KINDS = Object.freeze([
  'surface_rewording',
  'delayed_or_interrupted',
  'feature_coupled'
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readJsonLines(path) {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${path}:${index + 1} is not JSON: ${error.message}`);
      }
    });
}

function turn(at, speaker, messageId, text, extra = {}) {
  return { at, speaker, batch: [{ messageId, type: 'text', text }], ...extra };
}

function candidate(at) {
  return { at, speaker: 'system', event: 'candidate_response' };
}

function baseTurns(seed) {
  return [
    turn('2026-07-01T20:00:00+08:00', 'user', `${seed.sceneId}:u1`, seed.prompt),
    turn('2026-07-01T20:00:25+08:00', 'assistant', `${seed.sceneId}:a1`, seed.context),
    turn('2026-07-01T20:01:00+08:00', 'user', `${seed.sceneId}:u2`, seed.followUp),
    candidate('2026-07-01T20:01:05+08:00')
  ];
}

function variantTurns(seed, coverage) {
  const detail = seed.variants?.[coverage.variantKind];
  if (!detail) throw new Error(`${seed.sceneId} lacks ${coverage.variantKind} content`);
  if (coverage.variantKind === 'surface_rewording') {
    return [
      turn('2026-07-02T19:20:00+08:00', 'user', `${coverage.sceneId}:u1`, detail.opening),
      turn('2026-07-02T19:20:20+08:00', 'assistant', `${coverage.sceneId}:a1`, detail.context),
      turn('2026-07-02T19:21:00+08:00', 'user', `${coverage.sceneId}:u2`, detail.followUp),
      candidate('2026-07-02T19:21:05+08:00')
    ];
  }
  if (coverage.variantKind === 'delayed_or_interrupted') {
    return [
      turn('2026-07-03T19:00:00+08:00', 'user', `${coverage.sceneId}:u1`, detail.opening),
      turn('2026-07-03T19:00:20+08:00', 'assistant', `${coverage.sceneId}:a1`, detail.context),
      turn('2026-07-03T22:14:00+08:00', 'user', `${coverage.sceneId}:u2`, detail.followUp),
      turn('2026-07-03T22:14:20+08:00', 'assistant', `${coverage.sceneId}:a2`, detail.afterGap),
      candidate('2026-07-03T22:14:25+08:00')
    ];
  }
  const feature = detail.feature || coverage.feature || 'structured_event';
  return [
    turn('2026-07-04T18:40:00+08:00', 'user', `${coverage.sceneId}:u1`, detail.opening),
    turn('2026-07-04T18:40:20+08:00', 'assistant', `${coverage.sceneId}:a1`, detail.context),
    {
      at: '2026-07-04T18:41:00+08:00',
      speaker: 'user',
      batch: [{ messageId: `${coverage.sceneId}:feature`, type: feature, text: detail.featureText }]
    },
    turn('2026-07-04T18:41:20+08:00', 'user', `${coverage.sceneId}:u2`, detail.followUp),
    candidate('2026-07-04T18:41:25+08:00')
  ];
}

function materializeVariant(seed, coverage) {
  const turns = variantTurns(seed, coverage);
  return {
    ...seed,
    sceneId: coverage.sceneId,
    parentSentinelId: seed.sceneId,
    variantKind: coverage.variantKind,
    rolloutKey: coverage.rolloutKey,
    turns,
    requiredActionIntegrity: {
      ...seed.requiredActionIntegrity,
      featureTargetMustMatch: coverage.variantKind === 'feature_coupled'
        ? `${coverage.sceneId}:feature`
        : `${coverage.sceneId}:u2`
    }
  };
}

function assertAnnotationSource(scene, sources, rootDir) {
  const source = sources.sentinels?.[scene.sceneId] || sources.sentinels?.[scene.parentSentinelId];
  if (!source) throw new Error(`missing source map for ${scene.sceneId}`);
  if (source.file !== scene.sourceAnnotation.file || source.heading !== scene.sourceAnnotation.heading) {
    throw new Error(`source map mismatch for ${scene.sceneId}`);
  }
  const markdownPath = join(rootDir, 'preset-references', source.file);
  const markdown = readFileSync(markdownPath, 'utf8');
  const heading = String(source.heading).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!new RegExp(`^#{1,6}\\s+${heading}\\s*$`, 'm').test(markdown)) {
    throw new Error(`source heading not found for ${scene.sceneId}: ${source.file}#${source.heading}`);
  }
}

function validateScene(scene) {
  if (!scene.sceneId || !Array.isArray(scene.turns) || scene.turns.length < 4 || scene.turns.length > 12) {
    throw new Error(`invalid turn depth for ${scene.sceneId}`);
  }
  for (const field of [
    'mustNotice', 'allowedDecisionRange', 'forbiddenFailurePatterns', 'allowedPersonalityVariation'
  ]) {
    if (!Array.isArray(scene[field]) || scene[field].length === 0) {
      throw new Error(`${scene.sceneId} has empty ${field}`);
    }
  }
  if (!scene.requiredActionIntegrity || !scene.expectedStateTransitions || !scene.forbiddenStateTransitions) {
    throw new Error(`${scene.sceneId} has incomplete state/action annotations`);
  }
  if (!['critical', 'high', 'medium'].includes(scene.severity)) {
    throw new Error(`${scene.sceneId} has invalid severity`);
  }
  if (/脱敏测试消息\s*\d+/.test(JSON.stringify(scene))) {
    throw new Error(`${scene.sceneId} contains numbered dummy content`);
  }
  if (/(见面|约饭|上门|接你|送你过去)/.test(JSON.stringify(scene.turns))) {
    throw new Error(`${scene.sceneId} contains an offline-only promise`);
  }
}

function validateCoverageDistribution(scenes) {
  const counts = Object.fromEntries(scenes.map(scene => [scene.rolloutKey, 0]));
  for (const scene of scenes) counts[scene.rolloutKey] = (counts[scene.rolloutKey] || 0) + 1;
  const minimums = {
    DIRECT_REPLY: 18,
    PROACTIVE_CHAT: 6,
    PROACTIVE_MOMENT: 6,
    MOMENT_INTERACTION: 6,
    MOMENT_REPLY: 6,
    ROLE_PLAN_CHAT: 4,
    ROLE_PLAN_MOMENT: 4,
    ROLE_PLAN_CHAT_PRIVATE: 4,
    ROLE_PLAN_MOMENT_PRIVATE: 4,
    LIFE_PLANNING: 4
  };
  for (const [kind, minimum] of Object.entries(minimums)) {
    if (Number(counts[kind] || 0) < minimum) throw new Error(`coverage ${kind} is below ${minimum}`);
  }
  return counts;
}

function enrichScene(scene) {
  return {
    initialState: {
      relationship: { base: 'familiar', phase: 'normal' },
      lifeSignals: [],
      currentStances: [],
      verifiedFacts: [],
      ...(scene.initialState || {})
    },
    mustNotice: [scene.focus || scene.followUp],
    allowedDecisionRange: ['direct attitude', 'brief question', 'natural pause'],
    forbiddenFailurePatterns: ['analysis template', 'invented history', 'unearned service promise'],
    requiredActionIntegrity: { responseMustTarget: 'current_user_turn' },
    allowedPersonalityVariation: ['warm', 'teasing', 'reserved', 'brief'],
    expectedStateTransitions: { allow: ['create', 'maintain', 'soften', 'reverse'] },
    forbiddenStateTransitions: { hardConstraintFromYuqiPreference: true },
    ...scene
  };
}

export function compileQualitySuite({ rootDir = process.cwd(), checkOnly = false } = {}) {
  const suiteRoot = resolve(rootDir, 'tests/fixtures/yuqi-lived-quality-v1');
  const manifest = readJson(join(suiteRoot, 'manifest.json'));
  const sentinelSeeds = readJsonLines(join(suiteRoot, 'sentinel-seeds.jsonl')).map(enrichScene);
  const coveragePlan = readJsonLines(join(suiteRoot, 'coverage-scenes.jsonl'));
  const sources = readJson(join(suiteRoot, 'sources.json'));
  if (manifest.suitePurpose !== 'source_grounded_human_quality' || manifest.qualityEvidenceEligible !== true) {
    throw new Error('quality manifest does not declare source-grounded human quality purpose');
  }
  if (sentinelSeeds.length !== 24 || coveragePlan.length !== 72) {
    throw new Error(`quality suite count mismatch: ${sentinelSeeds.length} sentinels, ${coveragePlan.length} coverage`);
  }
  const seedById = new Map(sentinelSeeds.map(scene => [scene.sceneId, scene]));
  if (seedById.size !== 24) throw new Error('duplicate sentinel scene id');
  for (const scene of sentinelSeeds) {
    scene.turns = baseTurns(scene);
    validateScene(scene);
    assertAnnotationSource(scene, sources, rootDir);
  }
  const coverageScenes = coveragePlan.map(coverage => {
    const seed = seedById.get(coverage.parentSentinelId);
    if (!seed) throw new Error(`unknown coverage parent ${coverage.parentSentinelId}`);
    return materializeVariant(seed, coverage);
  });
  const variantsByParent = new Map();
  for (const scene of coverageScenes) {
    validateScene(scene);
    assertAnnotationSource(scene, sources, rootDir);
    const list = variantsByParent.get(scene.parentSentinelId) || [];
    list.push(scene);
    variantsByParent.set(scene.parentSentinelId, list);
  }
  for (const [seedId, variants] of variantsByParent) {
    if (variants.length !== 3 || new Set(variants.map(scene => scene.variantKind)).size !== 3) {
      throw new Error(`${seedId} does not have exactly three variant kinds`);
    }
    if (new Set(variants.map(scene => contentHash(scene.turns))).size !== 3) {
      throw new Error(`${seedId} has duplicate variant structure`);
    }
  }
  if (variantsByParent.size !== sentinelSeeds.length) throw new Error('a sentinel has no coverage variants');
  const coverageByRolloutKey = validateCoverageDistribution(coverageScenes);
  return { manifest, sentinelSeeds, coverageScenes, sources, coverageByRolloutKey, checkOnly };
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  const checkOnly = process.argv.includes('--check');
  const suite = compileQualitySuite({ checkOnly });
  process.stdout.write(`${JSON.stringify({
    suiteId: suite.manifest.suiteId,
    sentinelCount: suite.sentinelSeeds.length,
    coverageCount: suite.coverageScenes.length,
    coverageByRolloutKey: suite.coverageByRolloutKey,
    sourcesChecksum: contentHash(suite.sources)
  }, null, 2)}\n`);
}
