import { canonicalJson, contentHash } from './protocol.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  compileQualitySuite,
  isVerifiedCompiledQualitySuite
} from '../../scripts/compile-yuqi-lived-quality-scenes.mjs';

const LAYER_RULES = Object.freeze({
  sentinel: Object.freeze({ repeats: 3, expected: 24 }),
  coverage: Object.freeze({ repeats: 2, expected: 72 }),
  history: Object.freeze({ repeats: 1, expected: 30 })
});

const PLAN_TYPE = 'yuqi-lived-quality-replay-v1';
const PLAN_KEYS = new Set(['version', 'planType', 'items', 'finalKeys', 'commitments', 'historyManifest', 'planChecksum']);
const COMMITMENT_KEYS = new Set([
  'sourceGroundingChecksum', 'sentinelContentChecksum', 'coverageContentChecksum',
  'historyScenesChecksum', 'itemsChecksum'
]);
const EXPECTED_PROJECTION_KEYS = new Set([
  'version', 'planType', 'planChecksum', 'sourceGroundingChecksum', 'items', 'finalKeys', 'commitments', 'historyManifest'
]);

function deepFreezeClone(value) {
  const clone = structuredClone(value);
  const freeze = current => {
    if (current && typeof current === 'object' && !Object.isFrozen(current)) {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(clone);
}

function assertSceneList(value, layer) {
  const rule = LAYER_RULES[layer];
  if (!Array.isArray(value) || value.length !== rule.expected) {
    throw new Error(`${layer} scene count must be ${rule.expected}`);
  }
  const ids = value.map(scene => scene?.sceneId);
  if (ids.some(id => typeof id !== 'string' || !id)
    || new Set(ids).size !== ids.length) {
    throw new Error(`${layer} scene IDs must be unique strings`);
  }
  return value;
}

export function qualityFinalKey(value) {
  if (!value || !['sentinel', 'coverage', 'history'].includes(value.layer)
    || typeof value.sceneId !== 'string' || !value.sceneId
    || !Number.isSafeInteger(value.repeatIndex) || value.repeatIndex < 0) {
    throw new Error('invalid quality final identity');
  }
  return `${value.layer}:${value.sceneId}:${value.repeatIndex}`;
}

export function qualityAttemptKey(value) {
  qualityFinalKey(value);
  if (!Number.isSafeInteger(value.attemptIndex) || value.attemptIndex < 0
    || typeof value.evaluatorId !== 'string' || !value.evaluatorId) {
    throw new Error('invalid quality attempt identity');
  }
  return `${qualityFinalKey(value)}:${value.attemptIndex}:${value.evaluatorId}`;
}

export function buildQualityReplayPlan({ sentinelSeeds, coverageScenes, historyScenes }) {
  const layers = [
    ['sentinel', assertSceneList(sentinelSeeds, 'sentinel')],
    ['coverage', assertSceneList(coverageScenes, 'coverage')],
    ['history', assertSceneList(historyScenes, 'history')]
  ];
  const plan = [];
  for (const [layer, scenes] of layers) {
    const repeats = LAYER_RULES[layer].repeats;
    for (const scene of scenes) {
      for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex += 1) {
        const item = { layer, sceneId: scene.sceneId, repeatIndex, scene };
        qualityFinalKey(item);
        plan.push(item);
      }
    }
  }
  if (new Set(plan.map(qualityFinalKey)).size !== plan.length) {
    throw new Error('duplicate quality final identity');
  }
  return plan;
}

function assertHistoryManifestShape(historyManifest) {
  if (!historyManifest || typeof historyManifest !== 'object' || Array.isArray(historyManifest)
    || Object.keys(historyManifest).sort().join(',') !== 'sceneIds,scenesChecksum,schemaVersion'
    || historyManifest.schemaVersion !== 1
    || !Array.isArray(historyManifest.sceneIds)
    || historyManifest.sceneIds.length !== LAYER_RULES.history.expected
    || historyManifest.sceneIds.some(id => typeof id !== 'string' || !id)
    || new Set(historyManifest.sceneIds).size !== historyManifest.sceneIds.length
    || !/^[0-9a-f]{64}$/.test(historyManifest.scenesChecksum)) {
    throw new Error('history manifest/checksum authority conflict');
  }
}

function assertHistoryManifest(historyScenes, historyManifest) {
  if (!Array.isArray(historyScenes) || historyScenes.length !== LAYER_RULES.history.expected) {
    throw new Error('quality history scenes must contain exactly 30 entries');
  }
  assertHistoryManifestShape(historyManifest);
  if (historyManifest.sceneIds.join('\u0000') !== historyScenes.map(scene => scene?.sceneId).join('\u0000')
    || historyManifest.scenesChecksum !== contentHash(historyScenes)) {
    throw new Error('history manifest/checksum authority conflict');
  }
}

function finalKeysForPlan(plan) {
  const keys = {
    sentinelFinalKeys: [],
    coverageFinalKeys: [],
    historyFinalKeys: []
  };
  for (const item of plan) {
    const key = qualityFinalKey(item);
    keys[`${item.layer}FinalKeys`].push(key);
  }
  for (const key of Object.keys(keys)) Object.freeze(keys[key]);
  return Object.freeze(keys);
}

function planBasis({
  finalKeys,
  sourceGroundingChecksum,
  sentinelContentChecksum,
  compiledCoverageChecksum,
  historyManifest,
  itemsChecksum
}) {
  return {
    version: 1,
    planType: PLAN_TYPE,
    finalKeys,
    commitments: {
      sourceGroundingChecksum,
      sentinelContentChecksum,
      coverageContentChecksum: compiledCoverageChecksum,
      historyScenesChecksum: historyManifest.scenesChecksum,
      itemsChecksum
    },
    historyManifest
  };
}

export function buildVerifiedQualityReplayPlan({ compiledSuite, historyScenes, historyManifest } = {}) {
  if (!isVerifiedCompiledQualitySuite(compiledSuite)) {
    throw new Error('verified compiled quality suite required');
  }
  assertHistoryManifest(historyScenes, historyManifest);
  const planItems = buildQualityReplayPlan({
    sentinelSeeds: compiledSuite.sentinelSeeds,
    coverageScenes: compiledSuite.coverageScenes,
    historyScenes
  });
  const finalKeys = finalKeysForPlan(planItems);
  const sourceGroundingChecksum = contentHash(compiledSuite.sourceGroundingIndex);
  const sentinelContentChecksum = contentHash(compiledSuite.sentinelSeeds);
  const compiledCoverageChecksum = contentHash(compiledSuite.coverageScenes);
  const frozenItems = deepFreezeClone(planItems);
  const frozenHistoryManifest = deepFreezeClone(historyManifest);
  const itemsChecksum = contentHash(frozenItems);
  const basis = planBasis({
    finalKeys,
    sourceGroundingChecksum,
    sentinelContentChecksum,
    compiledCoverageChecksum,
    historyManifest: frozenHistoryManifest,
    itemsChecksum
  });
  return deepFreezeClone({
    version: 1,
    planType: PLAN_TYPE,
    items: frozenItems,
    finalKeys,
    commitments: {
      sourceGroundingChecksum,
      sentinelContentChecksum,
      coverageContentChecksum: compiledCoverageChecksum,
      historyScenesChecksum: frozenHistoryManifest.scenesChecksum,
      itemsChecksum
    },
    historyManifest: frozenHistoryManifest,
    planChecksum: contentHash(basis)
  });
}

export function assertVerifiedQualityReplayPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)
    || Object.keys(plan).some(key => !PLAN_KEYS.has(key))
    || Object.keys(plan).length !== PLAN_KEYS.size
    || plan.version !== 1 || plan.planType !== PLAN_TYPE || !Array.isArray(plan.items)) {
    throw new Error('verified quality replay plan required');
  }
  if (!plan.commitments || Object.keys(plan.commitments).some(key => !COMMITMENT_KEYS.has(key))
    || Object.keys(plan.commitments).length !== COMMITMENT_KEYS.size
    || Object.values(plan.commitments).some(value => !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error('quality replay commitment shape conflict');
  }
  assertHistoryManifestShape(plan.historyManifest);
  const recomputedKeys = finalKeysForPlan(plan.items);
  if (canonicalJson(recomputedKeys) !== canonicalJson(plan.finalKeys)) {
    throw new Error('quality replay final key authority conflict');
  }
  const itemsChecksum = contentHash(plan.items);
  if (plan.commitments.itemsChecksum !== itemsChecksum
    || plan.commitments.historyScenesChecksum !== plan.historyManifest.scenesChecksum) {
    throw new Error('quality replay content checksum/authority conflict');
  }
  const basis = planBasis({
    finalKeys: recomputedKeys,
    sourceGroundingChecksum: plan.commitments.sourceGroundingChecksum,
    sentinelContentChecksum: plan.commitments.sentinelContentChecksum,
    compiledCoverageChecksum: plan.commitments.coverageContentChecksum,
    historyManifest: plan.historyManifest,
    itemsChecksum
  });
  if (plan.planChecksum !== contentHash(basis)) {
    throw new Error('quality replay plan checksum conflict');
  }
  return plan;
}

export function expectedFinalKeysProjection(plan) {
  const verified = assertVerifiedQualityReplayPlan(plan);
  return deepFreezeClone({
    version: 1,
    planType: PLAN_TYPE,
    planChecksum: verified.planChecksum,
    sourceGroundingChecksum: verified.commitments.sourceGroundingChecksum,
    items: verified.items,
    finalKeys: verified.finalKeys,
    commitments: verified.commitments,
    historyManifest: verified.historyManifest
  });
}

export function assertVerifiedExpectedFinalKeys(projection) {
  if (!projection || typeof projection !== 'object' || Array.isArray(projection)
    || Object.keys(projection).some(key => !EXPECTED_PROJECTION_KEYS.has(key))
    || Object.keys(projection).length !== EXPECTED_PROJECTION_KEYS.size
    || projection.version !== 1 || projection.planType !== PLAN_TYPE
    || !Array.isArray(projection.items)) {
    throw new Error('verified expected final key projection required');
  }
  assertHistoryManifestShape(projection.historyManifest);
  if (!projection.commitments || Object.keys(projection.commitments).some(key => !COMMITMENT_KEYS.has(key))
    || Object.keys(projection.commitments).length !== COMMITMENT_KEYS.size
    || projection.commitments.sourceGroundingChecksum !== projection.sourceGroundingChecksum
    || projection.commitments.historyScenesChecksum !== projection.historyManifest.scenesChecksum) {
    throw new Error('verified expected final key projection conflict');
  }
  assertVerifiedQualityReplayPlan({
    version: projection.version,
    planType: projection.planType,
    items: projection.items,
    finalKeys: projection.finalKeys,
    commitments: projection.commitments,
    historyManifest: projection.historyManifest,
    planChecksum: projection.planChecksum
  });
  return projection;
}

export function writeQualityReplayPlanArtifact(plan, artifactPath) {
  const verified = assertVerifiedQualityReplayPlan(plan);
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('quality plan artifact path required');
  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, `${JSON.stringify(verified, null, 2)}\n`, 'utf8');
  return artifactPath;
}

export function loadQualityReplayPlanArtifact({
  artifactPath,
  rootDir = process.cwd(),
  historyScenes,
  historyManifest
} = {}) {
  if (typeof artifactPath !== 'string' || !artifactPath || !existsSync(artifactPath)) {
    throw new Error('quality plan artifact not found');
  }
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assertVerifiedQualityReplayPlan(artifact);
  const suite = compileQualitySuite({ rootDir, checkOnly: true });
  const recomputed = buildVerifiedQualityReplayPlan({
    compiledSuite: suite,
    historyScenes,
    historyManifest
  });
  if (canonicalJson(artifact) !== canonicalJson(recomputed)) {
    throw new Error('quality plan artifact/source commitment conflict');
  }
  return recomputed;
}

export function appendQualityAttempt(attempts, attempt) {
  if (!Array.isArray(attempts)) throw new Error('quality attempts array required');
  const key = qualityAttemptKey(attempt);
  if (attempts.some(existing => qualityAttemptKey(existing) === key)) {
    throw new Error('duplicate attempt identity');
  }
  const finalKey = qualityFinalKey(attempt);
  const siblings = attempts.filter(existing => qualityFinalKey(existing) === finalKey);
  const expectedIndex = siblings.length;
  if (attempt.attemptIndex !== expectedIndex) {
    throw new Error('quality attempt index gap');
  }
  attempts.push({ ...attempt });
  return attempt;
}
