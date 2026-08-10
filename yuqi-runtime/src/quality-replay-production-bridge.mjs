import { copyFileSync, existsSync, mkdirSync, rmSync, lstatSync, realpathSync, mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from './codex-client.mjs';

import { contentHash } from './protocol.mjs';
import { compileQualitySubject } from './quality-evaluator.mjs';
import { deriveAuthorityLineageKey } from './authority-identity.mjs';
import { YuqiStore } from './store.mjs';
import { CognitivePipeline } from './cognitive-pipeline.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { PromotionController } from './promotion-controller.mjs';
import {
  assertProductionRuntimeAttestation,
  assertQualityPhaseClientSlot,
  composeYuqiExecutionRuntime,
} from './runtime-composition.mjs';
import {
  bindQualityPhaseClientSlot,
  assertQualityPhaseClientSlotBinding,
  isQualityPhaseBinding,
  isQualityPhaseClientSlot,
  qualityPhaseClientSlotHasLedger,
  createQualityPhaseClientSlot,
  createQualityPhaseBinding,
  LedgerBackedModelClient,
  qualityPhaseBindingScope,
  qualityPhaseClientLedger,
} from './quality-replay-ledger.mjs';

const ATTACHMENT_KEYS = Object.freeze(['attachments', 'images', 'imagePaths', 'attachmentPaths']);
const SUBJECT_TYPES = new Set(['turn', 'life_planning']);
const TURN_KINDS = new Set([
  'DIRECT_REPLY', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT', 'MOMENT_INTERACTION',
  'MOMENT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT',
  'ROLE_PLAN_CHAT_PRIVATE', 'ROLE_PLAN_MOMENT_PRIVATE'
]);
const TURN_SEMANTIC_KEYS = new Set([
  'protocolVersion', 'turnId', 'characterId', 'deviceId', 'deviceSeq', 'createdAt',
  'kind', 'message', 'context', 'authority', 'trigger', 'content', 'scene',
]);
const LIFE_FORBIDDEN_KEYS = new Set([
  'annotation', 'annotations', 'evaluator', 'evaluatorId', 'release',
  'releaseId', 'releaseChecksum', 'pipelineReleaseId', 'candidateReleaseId',
]);
const SUBJECT_ESCAPE_KEYS = new Set([
  'envelope', 'episodes', 'accept', 'buildExecution', 'executeTurn', 'executeSubject'
]);
const COMPILED_SUBJECT_KEYS = Object.freeze([
  'version', 'subjectType', 'finalKey', 'turnKind', 'semanticInput',
  'semanticInputChecksum', 'blindAnnotation'
]);
const COMPILED_SEMANTIC_KEYS = Object.freeze([
  'version', 'sceneId', 'turnKind', 'turns', 'context',
  'stateCheckpoint', 'structuredActionTargets', 'planningWindow'
]);
const CLOSED_STORES = new WeakSet();
const CONTEXT_BINDINGS = new WeakMap();
const CONTEXT_PHASE_BINDINGS = new WeakMap();
const QUALITY_PRODUCTION_CONFIG_BRAND = new WeakSet();
const QUALITY_PRODUCTION_CONFIG_STATE = new WeakMap();
const QUALITY_RUN_AUTHORITY_BRAND = new WeakSet();
const QUALITY_RUN_AUTHORITY_STATE = new WeakMap();
const INTERNAL_PRODUCTION_CONTEXT_TOKEN = Symbol('quality-production-context');
const PRODUCTION_AUTHORITY_TOKEN = Symbol('quality-production-authority');
const TRACKED_PLAN_CHECKSUM = 'dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c';

const PRODUCTION_CONFIG_DESCRIPTOR_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead',
  'stableRelease', 'candidateRelease', 'attestation', 'attestationChecksum',
  'artifactPaths', 'ledgerPath', 'createdAt', 'evidenceEligible'
]);
const RUN_AUTHORITY_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead',
  'stableRelease', 'candidateRelease', 'attestation', 'attestationChecksum',
  'artifactPaths', 'ledgerPath', 'createdAt', 'evidenceEligible'
]);

/** Shared source identity gate used before any production brand is minted. */
export function assertCleanQualitySourceIdentity({ sourceRootDir = process.cwd(), expectedHead } = {}) {
  let status;
  let head;
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: sourceRootDir, encoding: 'utf8'
    });
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: sourceRootDir, encoding: 'utf8'
    }).trim();
  } catch (error) {
    throw new Error(`quality source identity unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const blocking = status.split(/\r?\n/).filter(Boolean).filter(line => {
    const porcelainStatus = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, '').replaceAll('\\', '/');
    const privateUntracked = porcelainStatus === '??'
      && path.startsWith('artifacts/yuqi-lived-agency-v3/private/');
    return !privateUntracked;
  });
  if (blocking.length) throw new Error('quality source tree is dirty');
  if (!/^[0-9a-f]{40}$/i.test(head)) throw new Error('quality source HEAD invalid');
  if (expectedHead !== undefined && head.toLowerCase() !== String(expectedHead).toLowerCase()) {
    throw new Error('quality source HEAD drift');
  }
  return head;
}

function assertDataOnlyClientConfig(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => typeof value[key] === 'function')) {
    throw new Error(`${label} data-only client config required`);
  }
  const allowed = new Set([
    'command', 'args', 'cwd', 'env', 'clientInfo', 'requestTimeoutMs',
    'turnTimeoutMs', 'maxRoleTurns'
  ]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error(`${label} client config shape conflict`);
  }
  if (value.args !== undefined && (!Array.isArray(value.args)
    || value.args.some(item => typeof item !== 'string'))) {
    throw new Error(`${label} client args conflict`);
  }
  return Object.freeze(structuredClone(value));
}

function assertProductionMaterials(materials) {
  if (!materials || typeof materials !== 'object' || Array.isArray(materials)) {
    throw new Error('quality production data materials required');
  }
  const expected = ['runtimeConfig', 'seedDatabasePath', 'stableDatabasePath',
    'candidateDatabasePath', 'clientConfigs', 'clientConfigChecksums'];
  if (Object.keys(materials).sort().join(',') !== expected.sort().join(',')) {
    throw new Error('quality production data materials shape conflict');
  }
  for (const key of ['seedDatabasePath', 'stableDatabasePath', 'candidateDatabasePath']) {
    if (typeof materials[key] !== 'string' || !materials[key] || materials[key].includes('..')) {
      throw new Error(`quality production ${key} conflict`);
    }
  }
  if (!materials.runtimeConfig || typeof materials.runtimeConfig !== 'object'
    || Array.isArray(materials.runtimeConfig)
    || Object.keys(materials.runtimeConfig).some(key => typeof materials.runtimeConfig[key] === 'function')) {
    throw new Error('quality production runtime config must be data-only');
  }
  const configs = materials.clientConfigs;
  if (!configs || typeof configs !== 'object' || Array.isArray(configs)
    || Object.keys(configs).sort().join(',') !== 'candidate_execution,evaluator_primary,evaluator_secondary,stable_execution') {
    throw new Error('quality production client configs shape conflict');
  }
  const checksums = materials.clientConfigChecksums;
  if (!checksums || typeof checksums !== 'object' || Array.isArray(checksums)
    || Object.keys(checksums).sort().join(',') !== Object.keys(configs).sort().join(',')) {
    throw new Error('quality production client config attestation conflict');
  }
  const normalizedConfigs = Object.fromEntries(
    Object.entries(configs).map(([key, value]) => [key, assertDataOnlyClientConfig(value, key)])
  );
  for (const key of Object.keys(normalizedConfigs)) {
    if (checksums[key] !== contentHash(normalizedConfigs[key])) {
      throw new Error(`quality production ${key} client config checksum conflict`);
    }
  }
  return Object.freeze({
    runtimeConfig: Object.freeze(structuredClone(materials.runtimeConfig)),
    seedDatabasePath: materials.seedDatabasePath,
    stableDatabasePath: materials.stableDatabasePath,
    candidateDatabasePath: materials.candidateDatabasePath,
    clientConfigs: Object.freeze(normalizedConfigs),
    clientConfigChecksums: Object.freeze(structuredClone(checksums)),
  });
}

export function createQualityRunAuthority(options = {}) {
  if (!options || typeof options !== 'object' || Object.keys(options).some(key =>
    !['descriptor', 'productionConfig', 'materials', 'productionToken'].includes(key))) {
    throw new Error('quality run authority option conflict');
  }
  const { descriptor, productionConfig, materials, productionToken } = options;
  if (productionToken !== PRODUCTION_AUTHORITY_TOKEN) {
    throw new Error('quality run authority preflight is private');
  }
  assertQualityProductionExecutionConfig(productionConfig);
  if (!descriptor || typeof descriptor !== 'object'
    || Object.keys(descriptor).sort().join(',') !== [...RUN_AUTHORITY_KEYS].sort().join(',')) {
    throw new Error('quality run authority descriptor conflict');
  }
  if (descriptor.evidenceEligible !== true
    || !Array.isArray(descriptor.finalKeys) || descriptor.finalKeys.length !== 246
    || descriptor.finalKeys.some(key => typeof key !== 'string')
    || descriptor.runId !== productionConfig.runId
    || descriptor.planChecksum !== productionConfig.planChecksum
    || descriptor.sourceHead !== productionConfig.sourceHead
    || descriptor.ledgerPath !== productionConfig.ledgerPath
    || descriptor.createdAt !== productionConfig.createdAt
    || descriptor.attestationChecksum !== productionConfig.attestationChecksum
    || contentHash(descriptor.finalKeys) !== contentHash(productionConfig.finalKeys)
    || contentHash(descriptor.stableRelease) !== contentHash(productionConfig.stableRelease)
    || contentHash(descriptor.candidateRelease) !== contentHash(productionConfig.candidateRelease)
    || contentHash(descriptor.attestation) !== contentHash(productionConfig.attestation)
    || contentHash(descriptor.artifactPaths) !== contentHash(productionConfig.artifactPaths)) {
    throw new Error('quality run authority identity conflict');
  }
  const dataMaterials = materials || QUALITY_PRODUCTION_CONFIG_STATE.get(productionConfig)?.materials;
  assertProductionMaterials(dataMaterials);
  const authority = Object.freeze(structuredClone(descriptor));
  QUALITY_RUN_AUTHORITY_BRAND.add(authority);
  QUALITY_RUN_AUTHORITY_STATE.set(authority, Object.freeze({
    productionConfig,
    materials: dataMaterials,
  }));
  return authority;
}

export function assertQualityRunAuthority(authority) {
  if (!QUALITY_RUN_AUTHORITY_BRAND.has(authority)) {
    throw new Error('quality run authority is not branded');
  }
  return true;
}

export function qualityRunAuthorityProductionConfig(authority) {
  assertQualityRunAuthority(authority);
  return QUALITY_RUN_AUTHORITY_STATE.get(authority).productionConfig;
}

export function createQualityProductionExecutionConfig(options = {}) {
  if (!options || typeof options !== 'object' || Object.keys(options).some(key =>
    !['descriptor', 'materials', 'productionToken'].includes(key))) {
    throw new Error('quality production config option conflict');
  }
  const { descriptor, materials, productionToken } = options;
  if (productionToken !== PRODUCTION_AUTHORITY_TOKEN) {
    throw new Error('quality production preflight is private');
  }
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new Error('quality production config descriptor required');
  }
  const keys = Object.keys(descriptor).sort();
  if (keys.join(',') !== [...PRODUCTION_CONFIG_DESCRIPTOR_KEYS].sort().join(',')) {
    throw new Error('quality production config descriptor shape conflict');
  }
  if (descriptor.version !== 1 || descriptor.evidenceEligible !== true
    || typeof descriptor.runId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(descriptor.runId)
    || !Array.isArray(descriptor.finalKeys) || descriptor.finalKeys.length !== 246
    || descriptor.finalKeys.some(key => typeof key !== 'string')
    || typeof descriptor.sourceHead !== 'string' || !/^[a-f0-9]{40}$/i.test(descriptor.sourceHead)
    || descriptor.planChecksum !== TRACKED_PLAN_CHECKSUM
    || !Number.isSafeInteger(descriptor.createdAt) || descriptor.createdAt < 0) {
    throw new Error('quality production config authority conflict');
  }
  const dataMaterials = assertProductionMaterials(materials);
  if (descriptor.ledgerPath !== descriptor.artifactPaths?.ledger
    || !descriptor.artifactPaths
    || Object.keys(descriptor.artifactPaths).sort().join(',') !== 'ledger,plan,raw') {
    throw new Error('quality production ledger path authority conflict');
  }
  if (descriptor.attestationChecksum !== contentHash(descriptor.attestation)) {
    throw new Error('quality production attestation checksum conflict');
  }
  const config = Object.freeze(structuredClone(descriptor));
  QUALITY_PRODUCTION_CONFIG_BRAND.add(config);
  QUALITY_PRODUCTION_CONFIG_STATE.set(config, Object.freeze({
    materials: dataMaterials,
  }));
  return config;
}

/**
 * The sole public production authority entrance.  It performs the complete
 * read-only preflight before minting either private brand, so callers cannot
 * compose a descriptor/config pair or select an evidence class themselves.
 */
export function createQualityProductionExecutionAuthority({
  descriptor, materials, sourceRootDir = process.cwd()
} = {}) {
  assertCleanQualitySourceIdentity({ sourceRootDir, expectedHead: descriptor?.sourceHead });
  const config = createQualityProductionExecutionConfig({
    descriptor, materials, productionToken: PRODUCTION_AUTHORITY_TOKEN,
  });
  assertQualityProductionPreflight({
    productionConfig: config,
    sourceRootDir,
    ledgerPath: descriptor?.ledgerPath,
    planChecksum: descriptor?.planChecksum,
    finalKeys: descriptor?.finalKeys,
  });
  assertCleanQualitySourceIdentity({ sourceRootDir, expectedHead: descriptor?.sourceHead });
  return createQualityRunAuthority({
    descriptor,
    productionConfig: config,
    materials,
    productionToken: PRODUCTION_AUTHORITY_TOKEN,
  });
}

export function createQualityProductionContextFactory(base = {}) {
  throw new Error('callback-backed production context factory is forbidden; use run authority materials');
}

export function assertQualityProductionExecutionConfig(config) {
  if (!QUALITY_PRODUCTION_CONFIG_BRAND.has(config)) {
    throw new Error('quality production config is not branded');
  }
  const state = QUALITY_PRODUCTION_CONFIG_STATE.get(config);
  if (!state || !state.materials) {
    throw new Error('quality production config state conflict');
  }
  const descriptor = config;
  if (!Array.isArray(descriptor.finalKeys) || descriptor.finalKeys.length !== 246
    || new Set(descriptor.finalKeys).size !== 246) {
    throw new Error('quality production final key authority conflict');
  }
  if (!descriptor.artifactPaths || Object.keys(descriptor.artifactPaths).sort().join(',') !== 'ledger,plan,raw'
    || new Set(Object.values(descriptor.artifactPaths)).size !== 3) {
    throw new Error('quality production artifact authority conflict');
  }
  for (const release of [descriptor.stableRelease, descriptor.candidateRelease]) {
    if (!release || typeof release !== 'object'
      || typeof release.releaseId !== 'string' || !release.releaseId
      || typeof release.releaseChecksum !== 'string' || !/^[a-f0-9]{64}$/i.test(release.releaseChecksum)
      || !release.componentManifest || typeof release.componentManifest !== 'object') {
      throw new Error('quality production release authority conflict');
    }
  }
  if (!descriptor.attestation || descriptor.attestation.version !== 1
    || descriptor.attestation.sourceHead !== descriptor.sourceHead
    || contentHash(descriptor.attestation) !== descriptor.attestationChecksum) {
    throw new Error('quality production attestation conflict');
  }
  for (const key of ['evaluatorPrimary', 'evaluatorSecondary']) {
    const evaluator = descriptor.attestation[key];
    if (!evaluator || typeof evaluator.evaluatorId !== 'string' || !evaluator.evaluatorId
      || typeof evaluator.evaluatorVersion !== 'string' || !evaluator.evaluatorVersion) {
      throw new Error('quality production evaluator attestation conflict');
    }
  }
  if (descriptor.attestation.evaluatorPrimary.evaluatorId
    === descriptor.attestation.evaluatorSecondary.evaluatorId) {
    throw new Error('quality production evaluator identity conflict');
  }
  return true;
}

/**
 * Read-only production preflight.  This is deliberately a validator rather
 * than a constructor: it opens the source database read-only, verifies the
 * release/attestation/material identity, and performs no ledger or artifact
 * writes.  The replay runner must call it before opening its writable ledger.
 */
export function assertQualityProductionPreflight({
  productionConfig, runAuthority, sourceRootDir = process.cwd(),
  ledgerPath, planChecksum, finalKeys
} = {}) {
  assertQualityProductionExecutionConfig(productionConfig);
  if (runAuthority !== undefined && runAuthority !== null) {
    assertQualityRunAuthority(runAuthority);
    if (qualityRunAuthorityProductionConfig(runAuthority) !== productionConfig) {
      throw new Error('quality production preflight authority identity conflict');
    }
  }
  if (planChecksum !== undefined && planChecksum !== productionConfig.planChecksum) {
    throw new Error('quality production preflight plan conflict');
  }
  if (finalKeys !== undefined
    && (contentHash(finalKeys) !== contentHash(productionConfig.finalKeys))) {
    throw new Error('quality production preflight final key conflict');
  }
  const root = realpathSync(sourceRootDir);
  const privateRoot = resolve(root, 'artifacts/yuqi-lived-agency-v3/private');
  if (!existsSync(privateRoot) || lstatSync(privateRoot).isSymbolicLink()) {
    throw new Error('quality production private materials root unavailable');
  }
  const privateReal = realpathSync(privateRoot);
  const state = QUALITY_PRODUCTION_CONFIG_STATE.get(productionConfig);
  const paths = [state.materials.seedDatabasePath, state.materials.stableDatabasePath,
    state.materials.candidateDatabasePath];
  for (const candidate of paths) assertPrivateDataPath(root, candidate);
  if (ledgerPath !== undefined) {
    assertPrivateDataPath(root, ledgerPath);
    const ledgerAbsolute = isAbsolute(ledgerPath) ? resolve(ledgerPath)
      : resolvePathUnderRoot(root, ledgerPath);
    const ledgerRelative = relative(privateReal, ledgerAbsolute);
    if (ledgerRelative.startsWith('..') || ledgerRelative.includes(':')) {
      throw new Error('quality production ledger path must be private');
    }
  }
  let sourceAuthorityBefore = null;
  for (const [index, path] of paths.entries()) {
    const absolute = isAbsolute(path) ? resolve(path) : resolvePathUnderRoot(root, path);
    const materialRelative = relative(privateReal, absolute);
    if (materialRelative.startsWith('..') || materialRelative.includes(':')) {
      throw new Error('quality production material path must be private');
    }
    if (!existsSync(absolute)) throw new Error('quality production source database missing');
    const db = new DatabaseSync(absolute, { readOnly: true });
    try {
      const version = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (version !== 15) throw new Error('quality production source schema conflict');
      const integrity = String(db.prepare('PRAGMA quick_check').get().quick_check || '');
      if (integrity !== 'ok') throw new Error('quality production source integrity conflict');
      if (index === 0) {
        const table = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='pipeline_releases'"
        ).get();
        if (!table) throw new Error('quality production release authority unavailable');
        const sourceReleases = [];
        for (const release of [productionConfig.stableRelease, productionConfig.candidateRelease]) {
          const row = db.prepare(`
            SELECT release_id,release_checksum,component_manifest_json FROM pipeline_releases WHERE release_id=?
          `).get(release.releaseId);
          if (!row || row.release_checksum !== release.releaseChecksum) {
            throw new Error('quality production release row conflict');
          }
          let manifest;
          try { manifest = JSON.parse(row.component_manifest_json); } catch { throw new Error('quality production release manifest conflict'); }
          if (contentHash(manifest) !== contentHash(release.componentManifest)) {
            throw new Error('quality production release manifest conflict');
          }
          sourceReleases.push({ releaseId: row.release_id,
            releaseChecksum: row.release_checksum, manifest });
        }
        sourceAuthorityBefore = { schemaVersion: version, releases: sourceReleases };
      }
    } finally { db.close(); }
  }
  // Rebuild a model-free, real branded runtime on a temporary byte clone and
  // recompute its attestation.  This must happen before the writable ledger is
  // opened; all resources are closed even when the attestation drifts.
  const preflightDir = mkdtempSync(join(tmpdir(), 'yuqi-quality-preflight-'));
  const preflightPaths = {
    stable: join(preflightDir, 'stable.sqlite'),
    candidate: join(preflightDir, 'candidate.sqlite'),
  };
  const preflightStores = [];
  const runtimeAttestations = {};
  try {
    const seedSourceAbsolute = isAbsolute(state.materials.seedDatabasePath)
      ? resolve(state.materials.seedDatabasePath)
      : resolvePathUnderRoot(root, state.materials.seedDatabasePath);
    for (const side of ['stable', 'candidate']) {
      const preflightPath = preflightPaths[side];
      copyDatabaseBytes(seedSourceAbsolute, preflightPath);
      const preflightStore = new YuqiStore(preflightPath);
      preflightStores.push(preflightStore);
      const runtimeInput = createProductionRuntimeInput({
        store: preflightStore, side, sourceHead: productionConfig.sourceHead,
        release: side === 'stable' ? productionConfig.stableRelease : productionConfig.candidateRelease,
        materials: state.materials, attestationOnly: true,
      });
      const runtime = composeYuqiExecutionRuntime({
        ...runtimeInput, sourceHead: productionConfig.sourceHead,
      });
      runtimeAttestations[side] = assertProductionRuntimeAttestation(runtime, {
        sourceHead: productionConfig.sourceHead,
        ...(side === 'stable'
          ? { stableRelease: productionConfig.stableRelease }
          : { candidateRelease: productionConfig.candidateRelease }),
      });
    }
    for (const side of ['stable', 'candidate']) {
      const expected = productionConfig.attestation?.[`${side}Runtime`];
      if (!expected || contentHash(expected) !== contentHash(runtimeAttestations[side])) {
        throw new Error(`quality production ${side} runtime attestation conflict`);
      }
    }
  } finally {
    for (const store of preflightStores) closeStore(store);
    rmSync(preflightDir, { recursive: true, force: true });
  }
  // Re-read the source identity after temporary runtime construction.  A
  // release/manifest change during attestation invalidates the whole run.
  const postAttestation = new DatabaseSync(
    isAbsolute(state.materials.seedDatabasePath) ? resolve(state.materials.seedDatabasePath)
      : resolvePathUnderRoot(root, state.materials.seedDatabasePath),
    { readOnly: true }
  );
  try {
    const schemaVersion = Number(postAttestation.prepare('PRAGMA user_version').get().user_version);
    if (schemaVersion !== sourceAuthorityBefore?.schemaVersion) {
      throw new Error('quality production source schema drift');
    }
    const postReleases = [];
    for (const release of [productionConfig.stableRelease, productionConfig.candidateRelease]) {
      const row = postAttestation.prepare(`
        SELECT release_id,release_checksum,component_manifest_json
        FROM pipeline_releases WHERE release_id=?
      `).get(release.releaseId);
      if (!row) throw new Error('quality production release row drift');
      let manifest;
      try { manifest = JSON.parse(row.component_manifest_json); } catch {
        throw new Error('quality production release manifest drift');
      }
      postReleases.push({ releaseId: row.release_id,
        releaseChecksum: row.release_checksum, manifest });
    }
    if (contentHash(postReleases) !== contentHash(sourceAuthorityBefore?.releases || [])) {
      throw new Error('quality production release authority drift');
    }
  } finally { postAttestation.close(); }
  for (const release of [productionConfig.stableRelease, productionConfig.candidateRelease]) {
    if (contentHash(release.componentManifest) !== release.componentManifestChecksum
      && release.componentManifestChecksum !== undefined) {
      throw new Error('quality production release manifest checksum conflict');
    }
  }
  return true;
}

function resolvePathUnderRoot(root, value) {
  if (typeof value !== 'string' || !value || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new Error('quality production path shape conflict');
  }
  if (value.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error('quality production path shape conflict');
  }
  const absolute = resolve(root, value);
  const relativePath = relative(root, absolute);
  if (!relativePath || relativePath.startsWith('..') || relativePath.includes(':')) {
    throw new Error('quality production path escape');
  }
  return absolute;
}

function assertPrivateDataPath(root, value) {
  const absolute = isAbsolute(value)
    ? resolve(value)
    : resolvePathUnderRoot(root, value);
  const rootRelative = relative(root, absolute);
  if (rootRelative.startsWith('..') || rootRelative.includes(':')) {
    throw new Error('quality production path containment conflict');
  }
  const parent = dirname(absolute);
  const parentReal = existsSync(parent) ? realpathSync(parent) : realpathSync(nearestExisting(parent));
  const parentRelative = relative(root, parentReal);
  if (parentRelative.startsWith('..') || parentRelative.includes(':')) {
    throw new Error('quality production path containment conflict');
  }
  if (existsSync(absolute) && lstatSync(absolute).isSymbolicLink()) {
    throw new Error('quality production path symlink conflict');
  }
}

function nearestExisting(path) {
  let cursor = path;
  while (!existsSync(cursor)) {
    const next = dirname(cursor);
    if (next === cursor) throw new Error('quality production path parent missing');
    cursor = next;
  }
  return cursor;
}

export function isQualityProductionExecutionConfig(config) {
  return QUALITY_PRODUCTION_CONFIG_BRAND.has(config);
}

export async function prepareQualityProductionSubject(config, input) {
  assertQualityProductionExecutionConfig(config);
  const state = QUALITY_PRODUCTION_CONFIG_STATE.get(config);
  const context = await createProductionContextForFinal(config, state.materials, input);
  let subject;
  try { subject = input?.item?.subject || compileQualitySubject(input.item); }
  catch (error) {
    context.close?.();
    throw error;
  }
  try {
    await prepareQualitySubject(context, subject);
  } catch (error) {
    context.close?.();
    throw error;
  }
  context.subject = subject;
  if (!context || typeof context !== 'object' || !context.subject) {
    context.close?.();
    throw new Error('quality production context subject unavailable');
  }
  return context;
}

function createAttestationOnlyClient() {
  const reject = async () => { throw new Error('attestation-only client cannot execute model calls'); };
  return Object.freeze({
    turnTimeoutMs: 180_000,
    ensureThread: reject,
    readThread: reject,
    runTurn: reject,
    runRole: reject,
  });
}

function createProductionRuntimeInput({ store, side, sourceHead, release, materials,
  attestationOnly = false }) {
  const runtimeConfig = materials.runtimeConfig;
  const presetDir = runtimeConfig.presetDir
    || join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
  const clientConfig = materials.clientConfigs[side === 'stable' ? 'stable_execution' : 'candidate_execution'];
  const codex = attestationOnly
    ? createAttestationOnlyClient()
    : new CodexAppServerClient({ ...clientConfig, store });
  const presets = new PresetRegistry({ presetDir, store, clock: runtimeConfig.clock || (() => Date.now()) });
  const promotionController = new PromotionController({
    store, presetRegistry: presets, clock: runtimeConfig.clock || (() => Date.now()),
  });
  promotionController.initialize();
  const cognitivePipeline = new CognitivePipeline({
    store, codexClient: codex, presetRegistry: presets,
    clock: runtimeConfig.clock || (() => Date.now()),
  });
  return {
    store, codex, presets, promotionController, cognitivePipeline, sourceHead,
    release,
  };
}

export function bindQualityProductionPhase(context, phaseInput) {
  if (!context?.prepared || !phaseInput || !['stable_execution', 'candidate_execution'].includes(phaseInput.phase)) {
    throw new Error('quality production phase binding input conflict');
  }
  const side = phaseInput.phase === 'stable_execution' ? 'stable' : 'candidate';
  const slot = side === 'stable'
    ? context.config.stablePhaseClientSlot : context.config.candidatePhaseClientSlot;
  const ledger = qualityPhaseClientLedger(slot);
  const materials = context.config.productionMaterials;
  if (!materials) throw new Error('quality production materials unavailable');
  const underlying = new CodexAppServerClient({
    ...materials.clientConfigs[phaseInput.phase],
    store: context.prepared[side === 'stable' ? 'stableStore' : 'candidateStore'],
  });
  const client = new LedgerBackedModelClient({
    ledger, underlying, runId: context.config.runId,
  });
  const binding = createQualityPhaseBinding(client, phaseInput);
  registerQualityPhaseBinding(context, side, binding);
  return binding;
}

async function createProductionContextForFinal(config, materials, input = {}) {
  if (!input || typeof input !== 'object' || !input.item || !input.ledger) {
    throw new Error('production context ledger/input required');
  }
  const finalKey = String(input.finalKey || `${input.item.layer}:${input.item.sceneId}:${input.item.repeatIndex}`);
  const ordinal = Number.isSafeInteger(input.ordinal) ? input.ordinal : Number(input.item.repeatIndex || 0);
  const stableSlot = createQualityPhaseClientSlot({
    runId: config.runId, finalKey, phase: 'stable_execution', side: 'stable'
  }, { ledger: input.ledger });
  const candidateSlot = createQualityPhaseClientSlot({
    runId: config.runId, finalKey, phase: 'candidate_execution', side: 'candidate'
  }, { ledger: input.ledger });
  const tempStem = `${materials.seedDatabasePath}.quality-${contentHash({
    runId: config.runId, finalKey,
  }).slice(0, 24)}`;
  const seedPath = `${tempStem}.seed.sqlite`;
  const stablePath = `${tempStem}.stable.sqlite`;
  const candidatePath = `${tempStem}.candidate.sqlite`;
  copyDatabaseBytes(materials.seedDatabasePath, seedPath);
  const seedStore = new YuqiStore(seedPath);
  const seedInput = createProductionRuntimeInput({
    store: seedStore, side: 'stable', sourceHead: config.sourceHead,
    release: config.stableRelease, materials,
  });
  copyDatabaseBytes(seedPath, stablePath);
  copyDatabaseBytes(seedPath, candidatePath);
  const stableStore = new YuqiStore(stablePath);
  const candidateStore = new YuqiStore(candidatePath);
  const stableInput = createProductionRuntimeInput({
    store: stableStore, side: 'stable', sourceHead: config.sourceHead,
    release: config.stableRelease, materials,
  });
  const candidateInput = createProductionRuntimeInput({
    store: candidateStore, side: 'candidate', sourceHead: config.sourceHead,
    release: config.candidateRelease, materials,
  });
  // The runtime composition owns the actual store/client graph.  The seed
  // graph is used only to materialize the frozen subject before cloning.
  stableInput.qualityPhaseClientSlot = stableSlot;
  candidateInput.qualityPhaseClientSlot = candidateSlot;
  const context = createQualityProductionContext({
    runId: config.runId, finalKey, ordinal, sourceHead: config.sourceHead,
    anchorAt: input.item.anchorAt, planChecksum: config.planChecksum,
    seedStore, seedRuntime: composeYuqiExecutionRuntime({
      ...seedInput, qualityPhaseClientSlot: undefined,
    }),
    seedDatabasePath: seedPath,
    stableDatabasePath: stablePath,
    candidateDatabasePath: candidatePath,
    stableStore, candidateStore,
    stableRelease: config.stableRelease,
    candidateRelease: config.candidateRelease,
    stablePhaseClientSlot: stableSlot,
    candidatePhaseClientSlot: candidateSlot,
    runtimeInputs: { stable: stableInput, candidate: candidateInput },
    productionMaterials: materials,
    evidenceEligible: true,
    [INTERNAL_PRODUCTION_CONTEXT_TOKEN]: true,
    temporaryPaths: [seedPath, stablePath, candidatePath],
  });
  return context;
}

function requiredString(value, label) {
  const result = String(value || '');
  if (!result) throw new Error(`${label} is required`);
  return result;
}

function assertRunIdentity({ runId, finalKey, ordinal }) {
  requiredString(runId, 'runId');
  requiredString(finalKey, 'finalKey');
  if (!Number.isSafeInteger(Number(ordinal)) || Number(ordinal) < 0) {
    throw new Error('ordinal must be a non-negative safe integer');
  }
}

export function authorityIdFor({ runId, finalKey, ordinal }) {
  assertRunIdentity({ runId, finalKey, ordinal });
  return `quality-authority-${contentHash({
    runId: String(runId),
    finalKey: String(finalKey),
    ordinal: Number(ordinal),
  }).slice(0, 32)}`;
}

function attachmentsOf(subject) {
  for (const key of ATTACHMENT_KEYS) {
    if (subject && subject[key] != null) return subject[key];
  }
  return [];
}

function assertZeroAttachments(subject) {
  const active = new WeakSet();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (active.has(value)) throw new Error('quality production semantic input is cyclic');
    active.add(value);
    if (Array.isArray(value)) {
      value.forEach(visit);
      active.delete(value);
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (ATTACHMENT_KEYS.includes(key)) {
        if (!Array.isArray(child) || child.length !== 0) {
          throw new Error('quality production subjects require a zero-attachment plan');
        }
      }
      visit(child);
    }
    active.delete(value);
  };
  visit(subject);
}

function assertSubject(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)
    || Object.keys(subject).sort().join(',') !== [...COMPILED_SUBJECT_KEYS].sort().join(',')) {
    throw new Error('compiled quality subject closed shape required');
  }
  const type = String(subject.subjectType || '');
  if (!SUBJECT_TYPES.has(type)) throw new Error(`unsupported quality subject type: ${type}`);
  if (subject.version !== 1 || typeof subject.finalKey !== 'string' || !subject.finalKey) {
    throw new Error('compiled quality subject identity');
  }
  if (!subject?.semanticInput || typeof subject.semanticInput !== 'object'
    || Array.isArray(subject.semanticInput)) {
    throw new Error('compiled quality subject semanticInput is required');
  }
  const semanticKeys = Object.keys(subject.semanticInput).sort();
  const expectedSemantic = [...COMPILED_SEMANTIC_KEYS]
    .filter(key => type === 'life_planning' || key !== 'planningWindow')
    .sort();
  if (semanticKeys.join(',') !== expectedSemantic.join(',')) {
    throw new Error('compiled quality semanticInput closed shape');
  }
  if (subject.semanticInput.version !== 1
    || subject.semanticInput.sceneId !== subject.blindAnnotation?.sceneId
    || subject.semanticInput.turnKind !== subject.turnKind
    || (type === 'life_planning' && subject.turnKind !== 'LIFE_PLANNING')
    || (type === 'turn' && !TURN_KINDS.has(subject.turnKind))) {
    throw new Error('compiled quality subject kind/scene conflict');
  }
  if (typeof subject.semanticInputChecksum !== 'string'
    || !/^[a-f0-9]{64}$/.test(subject.semanticInputChecksum)
    || contentHash(subject.semanticInput) !== subject.semanticInputChecksum) {
    throw new Error('compiled quality semanticInput checksum conflict');
  }
  if (!subject.blindAnnotation || typeof subject.blindAnnotation !== 'object'
    || subject.blindAnnotation.sceneId !== subject.semanticInput.sceneId) {
    throw new Error('compiled quality blind annotation conflict');
  }
  assertZeroAttachments(subject);
  return type;
}

function assertNoLifeAuthorityFields(value, active = new WeakSet()) {
  if (!value || typeof value !== 'object') return;
  if (active.has(value)) throw new Error('life semantic input is cyclic');
  active.add(value);
  if (Array.isArray(value)) value.forEach(item => assertNoLifeAuthorityFields(item, active));
  else for (const [key, child] of Object.entries(value)) {
    if (LIFE_FORBIDDEN_KEYS.has(key)) throw new Error(`life semantic input contains forbidden authority field: ${key}`);
    assertNoLifeAuthorityFields(child, active);
  }
  active.delete(value);
}

function safeTime(value, label) {
  if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function candidateResponseAnchorAt(input) {
  const rows = (input.turns || []).filter(turn => turn?.speaker === 'system' && turn?.event === 'candidate_response');
  if (rows.length !== 1) throw new Error('quality candidate_response anchor must be unique');
  return safeTime(Date.parse(rows[0].at), 'candidate_response anchorAt');
}

function qualitySubjectAnnotation(subject, authorityId, config) {
  return {
    version: 1,
    authorityId,
    finalKey: subject.finalKey,
    planChecksum: config.planChecksum,
    semanticInput: structuredClone(subject.semanticInput),
    semanticInputChecksum: subject.semanticInputChecksum,
    anchorAt: config.anchorAt
  };
}

function materializeTurnEnvelope(subject, authorityId, config) {
  const input = structuredClone(subject.semanticInput);
  const turns = Array.isArray(input.turns) ? input.turns : [];
  const candidateIndexes = turns.map((turn, index) =>
    turn?.speaker === 'system' && turn?.event === 'candidate_response' ? index : -1
  ).filter(index => index >= 0);
  if (candidateIndexes.length !== 1) throw new Error('quality candidate_response anchor must be unique');
  const candidateIndex = candidateIndexes[0];
  if (turns.slice(candidateIndex + 1).some(turn => ['user', 'assistant'].includes(turn?.speaker))) {
    throw new Error('semantic turns after candidate_response are not permitted');
  }
  const userTurns = turns.filter(turn => turn?.speaker === 'user' && Array.isArray(turn.batch) && turn.batch.length);
  if (!userTurns.length) throw new Error('compiled turn scene has no user batch');
  const sourceTurn = userTurns.at(-1);
  if (turns.indexOf(sourceTurn) >= candidateIndex) throw new Error('current user batch must precede candidate_response');
  const anchorAt = candidateResponseAnchorAt(input);
  if (config.anchorAt != null && Number(config.anchorAt) !== anchorAt) {
    throw new Error('quality candidate_response anchor conflict');
  }
  const sourceAt = safeTime(Date.parse(sourceTurn.at), 'compiled turn source time');
  const characterId = 'yuqi';
  const deviceId = `quality-${contentHash({ runId: config.runId, sceneId: input.sceneId }).slice(0, 20)}`;
  const turnId = `turn_${contentHash({ authorityId, sceneId: input.sceneId, turns }).slice(0, 32)}`;
  const messages = sourceTurn.batch.map((raw, index) => {
    const content = String(raw?.text ?? raw?.content ?? '').trim();
    if (!content) throw new Error('compiled turn source message content');
    const sentAt = safeTime(Date.parse(sourceTurn.at) + index, 'compiled turn message time');
    return {
      messageId: `msg_${contentHash({ authorityId, source: raw, index }).slice(0, 28)}`,
      speakerId: 'user', speakerType: 'user', recipientId: characterId,
      content, sentAt, type: String(raw?.type || 'text')
    };
  });
  const message = messages.at(-1);
  const batchId = `batch_${contentHash({ authorityId, sourceTurn }).slice(0, 28)}`;
  const currentBatch = {
    batchId, messageIds: messages.map(item => item.messageId),
    startedAt: messages[0].sentAt, committedAt: messages.at(-1).sentAt, messages
  };
  const visibilityCursor = {
    nativeCompletedTurnId: null,
    nativeCompletedGroupId: null,
    nativeCompletedSequence: 0,
    uiAppliedTurnId: null,
    uiAppliedGroupId: null,
    uiAppliedSequence: 0,
    localSequence: 1,
    clearedThroughSequence: 0,
    clearEpoch: 0,
    clearedAt: 0,
    chatOpen: true,
    quotedMessageId: null,
  };
  const authority = {
    algorithm: 'al-authority-v1',
    roleId: characterId,
    laneKey: 'private_chat',
    rootSourceId: message.messageId,
    lineageKey: deriveAuthorityLineageKey({
      roleId: characterId, laneKey: 'private_chat', rootSourceId: message.messageId,
    }),
    claimedLineageRevision: 1,
    retryOfTurnId: null,
  };
  const kind = String(input.turnKind);
  const protocolVersion = 3;
  const base = {
    protocolVersion, turnId, characterId, deviceId, deviceSeq: Number(config.ordinal) + 1,
    createdAt: sourceAt, kind, message,
    context: {
      currentBatch, visibilityCursor,
      ...(input.context?.scene ? { scene: structuredClone(input.context.scene) } : {})
    }, authority
  };
  if (kind !== 'DIRECT_REPLY') {
    delete base.message;
    delete base.context.currentBatch;
    delete base.context.scene;
    base.context = { visibilityCursor };
    const triggerId = `trigger_${contentHash({ authorityId, sceneId: input.sceneId }).slice(0, 28)}`;
    const targetSpec = input.structuredActionTargets || {};
    const responseTarget = targetSpec.responseMustTarget;
    if (typeof responseTarget !== 'string' || !responseTarget) {
      throw new Error('responseMustTarget is required for non-direct quality turn');
    }
    const responseRows = ['current_user_turn', 'proactive_turn'].includes(responseTarget)
      ? messages.at(-1)
      : turns.flatMap(turn => turn.batch || [])
        .filter(item => String(item.messageId || '') === String(responseTarget)
          || String(item.messageId || '').endsWith(String(responseTarget).split(':').at(-1)));
    const resolvedTarget = Array.isArray(responseRows) ? responseRows : [responseRows];
    if (resolvedTarget.filter(Boolean).length !== 1) {
      throw new Error('responseMustTarget must resolve to one typed fact');
    }
    const resolvedResponse = resolvedTarget.find(Boolean);
    const featureMatches = targetSpec.featureTargetMustMatch
      ? turns.flatMap(turn => turn.batch || [])
        .filter(item => String(item.messageId || '') === String(targetSpec.featureTargetMustMatch)
          || String(item.messageId || '').endsWith(String(targetSpec.featureTargetMustMatch).split(':').at(-1)))
      : [];
    if (targetSpec.featureTargetMustMatch && featureMatches.length !== 1) {
      throw new Error('featureTargetMustMatch must resolve to one typed fact');
    }
    const resolvedMessage = featureMatches[0] || resolvedResponse;
    const momentId = String(resolvedMessage?.messageId || `moment_${contentHash({ authorityId, sceneId: input.sceneId }).slice(0, 24)}`);
    const laneKey = ['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(kind)
      ? `moment_interaction:${momentId}`
      : ['PROACTIVE_MOMENT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_MOMENT_PRIVATE'].includes(kind)
        ? 'public_moment' : 'private_chat';
    const targetComment = {
      commentId: `comment_${contentHash({ authorityId }).slice(0, 24)}`,
      authorType: 'user', authorId: 'user', text: String(resolvedMessage?.text || resolvedMessage?.content || ''),
      createdAt: sourceAt, replyToCommentId: null
    };
    const targetMoment = {
      momentId, authorType: 'character', authorId: characterId,
      text: String(resolvedMessage?.text || resolvedMessage?.content || input.context || ''),
      createdAt: sourceAt, likes: [], comments: [targetComment]
    };
    const triggerContext = kind === 'PROACTIVE_CHAT'
      ? { motiveCandidates: [] }
      : ['MOMENT_INTERACTION', 'MOMENT_REPLY'].includes(kind)
      ? {
          targetMoment,
          ...(kind === 'MOMENT_REPLY' ? {
            targetComment
          } : {})
        }
      : {};
    base.trigger = {
      triggerId,
      triggerType: kind.toLowerCase(), scheduledFor: sourceAt, executedAt: sourceAt
      , context: triggerContext
    };
    base.authority = {
      ...authority,
      laneKey,
      rootSourceId: triggerId,
      lineageKey: deriveAuthorityLineageKey({ roleId: characterId, laneKey, rootSourceId: triggerId })
    };
  }
  return {
    ...base
  };
}

function materializeLifePlan(subject, authorityId) {
  const input = structuredClone(subject.semanticInput);
  assertNoLifeAuthorityFields(input);
  const planningWindow = input.planningWindow;
  if (!planningWindow || typeof planningWindow !== 'object') {
    throw new Error('life planningWindow is required');
  }
  const candidateTurns = input.turns.filter(turn => turn?.speaker === 'system' && turn?.event === 'candidate_response');
  if (candidateTurns.length !== 1) throw new Error('life candidate_response anchor');
  const candidateIndex = input.turns.indexOf(candidateTurns[0]);
  if (input.turns.slice(candidateIndex + 1).some(turn => ['user', 'assistant'].includes(turn?.speaker))) {
    throw new Error('life semantic turns after candidate_response are not permitted');
  }
  const anchorAt = safeTime(Date.parse(candidateTurns[0].at), 'life anchorAt');
  const startAt = safeTime(planningWindow.startAt, 'life planningWindow.startAt');
  const targetEndAt = safeTime(planningWindow.targetEndAt, 'life planningWindow.targetEndAt');
  if (startAt !== anchorAt || targetEndAt !== anchorAt + 12 * 60 * 60_000) {
    throw new Error('life planningWindow must be anchored to candidate_response');
  }
  const userTurns = input.turns.filter(turn => turn?.speaker === 'user' && Array.isArray(turn.batch) && turn.batch.length);
  const featureItems = userTurns.flatMap(turn => turn.batch || [])
    .filter(item => String(item?.type || 'text') !== 'text');
  if (featureItems.length !== 1) throw new Error('life feature item must be unique');
  const rawFeature = featureItems[0];
  const feature = userTurns.find(turn => (turn.batch || []).includes(rawFeature));
  if (!feature || input.turns.indexOf(feature) >= candidateIndex) {
    throw new Error('life feature must precede candidate_response');
  }
  const featureType = String(rawFeature?.type || 'text');
  const featureText = String(rawFeature?.text ?? rawFeature?.content ?? '').trim();
  if (!featureText) throw new Error('life feature text is required');
  const featureAt = safeTime(Date.parse(feature.at), 'life feature time');
  const featureMessageId = String(rawFeature?.messageId || '');
  if (!featureMessageId) throw new Error('life feature source message id is required');
  const episode = {
    episodeId: `episode_${contentHash({ authorityId, sceneId: input.sceneId, feature: rawFeature }).slice(0, 28)}`,
    kind: featureType,
    title: featureText,
    startAt: featureAt - 60_000,
    endAt: featureAt,
    payload: {
      fixtureVersion: 1,
      sourceType: featureType,
      sourceMessageId: featureMessageId,
      transcriptSummary: input.turns.map(turn => {
        const body = (turn.batch || []).map(item =>
          `${item.type || 'text'}:${item.text || item.content || ''}`).join(' | ');
        return `${turn.at}|${turn.speaker}|${turn.event || ''}|${body}`;
      }).join('\n')
    },
  };
  if (!episode.kind || !episode.title || episode.endAt <= episode.startAt || episode.endAt >= anchorAt) {
    throw new Error('life context episode is not a closed pre-anchor feature');
  }
  return {
    roleId: 'yuqi',
    episodes: [episode],
    planningWindow: { startAt, targetEndAt },
    now: anchorAt,
  };
}

function copyDatabaseBytes(sourcePath, destinationPath) {
  mkdirSync(dirname(destinationPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const source = `${sourcePath}${suffix}`;
    const destination = `${destinationPath}${suffix}`;
    if (existsSync(source)) copyFileSync(source, destination);
    else if (existsSync(destination)) rmSync(destination, { force: true });
  }
}

function closeStore(store) {
  if (store && typeof store.close === 'function' && !CLOSED_STORES.has(store)) {
    CLOSED_STORES.add(store);
    store.close();
  }
}

function assertV15Store(store, label) {
  if (typeof store?.userVersion !== 'function') return;
  if (Number(store.userVersion()) !== 15) throw new Error(`${label} store must be v15`);
}

function openStore(path, factory) {
  if (typeof factory === 'function') return factory(path);
  return new YuqiStore(path);
}

function runtimeFor({ runtime, runtimeFactory, runtimeInput, store, side, sourceHead }) {
  if (runtime) return runtime;
  if (typeof runtimeFactory === 'function') return runtimeFactory({
    store, side, sourceHead,
    qualityPhaseClientSlot: runtimeInput?.qualityPhaseClientSlot,
  });
  if (runtimeInput && typeof runtimeInput === 'object') {
    return composeYuqiExecutionRuntime({ ...runtimeInput, store, sourceHead });
  }
  throw new Error(`${side} production runtime is required`);
}

function installCandidateRelease(store, release) {
  if (!release || !release.releaseId || !release.releaseChecksum) {
    throw new Error('candidate release authority is required');
  }
  if (typeof store.putPipelineReleaseInternal !== 'function') {
    throw new Error('candidate store release writer is unavailable');
  }
  const persisted = store.putPipelineReleaseInternal(release);
  const reread = store.getPipelineRelease?.(release.releaseId);
  if (!reread || String(reread.releaseChecksum) !== String(release.releaseChecksum)) {
    throw new Error('candidate release authority conflict');
  }
  return persisted || reread;
}

function buildTurnExecution(runtime, turnId, options = {}) {
  if (typeof runtime.orchestrator?.buildCanonicalReleaseExecution !== 'function') {
    throw new Error('canonical turn execution builder is unavailable');
  }
  return runtime.orchestrator.buildCanonicalReleaseExecution(turnId, options);
}

function buildLifeExecution(runtime, attempt, options = {}) {
  if (typeof runtime.orchestrator?.buildLifePlanningReleaseExecution !== 'function') {
    throw new Error('life execution builder is unavailable');
  }
  return runtime.orchestrator.buildLifePlanningReleaseExecution(attempt, options);
}

function executionAuthorityFingerprint(execution) {
  const value = execution?.turn || execution?.attempt || execution;
  return contentHash(value || null);
}

function executionInputChecksum(execution) {
  if (typeof execution?.inputChecksum !== 'string' || !/^[a-f0-9]{64}$/.test(execution.inputChecksum)) {
    throw new Error('quality execution input checksum authority is required');
  }
  return execution.inputChecksum;
}

function turnAuthoritySnapshot(store, turnId) {
  const turn = store.getTurn(turnId);
  if (!turn) throw new Error('quality turn authority snapshot missing');
  return {
    turnId: turn.turnId,
    state: turn.state,
    resultAuthorityVersion: turn.resultAuthorityVersion,
    turnRevision: turn.turnRevision,
    lineageRevisionAtCreation: turn.lineageRevisionAtCreation,
    laneRevision: turn.laneRevision,
    retryOfTurnId: turn.retryOfTurnId || null,
    inputUserBatchId: turn.inputUserBatchId || null,
    route: turn.route,
    rolloutRevision: turn.rolloutRevision,
    agencySnapshotChecksum: turn.agencySnapshotChecksum,
    annotationSnapshot: turn.annotationSnapshot || null,
    cognitiveState: store.getCognitiveState?.(turn.characterId) || null,
    envelopeChecksum: turn.envelopeChecksum,
    contentHash: turn.contentHash,
    authorityLineageKey: turn.authorityLineageKey,
    authorityGroupId: turn.authorityGroupId || null,
    laneKey: turn.laneKey,
    inputVisibilitySequence: turn.inputVisibilitySequence,
    inputClearEpoch: turn.inputClearEpoch,
    authoritativeReleaseId: turn.authoritativeReleaseId,
    authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
    comparisonReleaseId: turn.comparisonReleaseId || null,
    comparisonPipelineChecksum: turn.comparisonPipelineChecksum || null,
    envelopeJson: turn.envelopeJson,
    currentBatch: store.getCurrentUserBatch(turnId),
    lineage: turn.authorityLineageKey
      ? store.getTurnAuthorityLineage(turn.authorityLineageKey)
      : null
  };
}

function lifeAuthoritySnapshot(runtime, attempt, episodeId) {
  const episode = runtime.store.getLifeEpisode(episodeId);
  const context = runtime.orchestrator.lifeSimulation?.contextFor(
    attempt.roleId, Number(attempt.inputSnapshot?.planningAnchorAt)
  );
  const contextStable = context == null ? null : JSON.parse(JSON.stringify(context, (key, value) =>
    key === 'createdAt' || key === 'updatedAt' ? undefined : value));
  return {
    episode,
    episodeChecksum: episode?.checksum || null,
    context: contextStable,
    inputSnapshot: attempt.inputSnapshot,
    contextChecksum: attempt.contextChecksum,
    lifeBasisChecksum: attempt.lifeBasisChecksum,
    requestKey: attempt.requestKey,
    planningWindowStartAt: attempt.planningWindowStartAt,
    planningWindowEndAt: attempt.planningWindowEndAt,
    authoritativeReleaseId: attempt.authoritativeReleaseId,
    authoritativePipelineChecksum: attempt.authoritativePipelineChecksum,
    comparisonReleaseId: attempt.comparisonReleaseId || null,
    comparisonPipelineChecksum: attempt.comparisonPipelineChecksum || null,
    contextAuthorityVersion: attempt.inputSnapshot?.contextAuthorityVersion
  };
}

function sameAuthoritySnapshot(left, right) {
  return contentHash(left) === contentHash(right);
}

function assertExecutionAuthority(execution, authorityId, subjectId, type) {
  const declared = execution?.authorityId || execution?.turn?.authorityId
    || execution?.attempt?.authorityId || execution?.qualityAuthorityId;
  if (declared == null || String(declared) !== String(authorityId)) {
    throw new Error('execution authority identity conflict');
  }
  const actualId = type === 'turn' ? execution?.turn?.turnId : execution?.attempt?.planningId;
  if (!actualId || String(actualId) !== String(subjectId)) {
    throw new Error('execution subject authority identity conflict');
  }
}

function releaseSnapshotMatches(actual, expected) {
  if (!actual || !expected) return false;
  const keys = [
    'releaseId', 'pipelineVersion', 'presetVersion', 'cognitionSchemaVersion',
    'expressionSchemaVersion', 'evaluatorVersion', 'modelProfile',
    'componentManifest', 'releaseChecksum', 'createdAt', 'retiredAt',
  ];
  return keys.every(key => expected[key] === undefined
    || contentHash(actual[key]) === contentHash(expected[key]));
}

function rereadPreparedAuthority(context, binding) {
  const prepared = context.prepared;
  const stableRuntime = prepared.stableRuntime;
  const candidateRuntime = prepared.candidateRuntime;
  const expected = {
    sourceHead: context.config.sourceHead,
    releaseIds: { stableReleaseId: binding.stableRelease.releaseId },
    stableRelease: { ...binding.stableRelease, manifest: binding.stableRelease.componentManifest || binding.stableRelease.manifest },
  };
  assertProductionRuntimeAttestation(stableRuntime, expected);
  assertProductionRuntimeAttestation(candidateRuntime, {
    ...expected,
    releaseIds: {
      stableReleaseId: binding.stableRelease.releaseId,
      candidateReleaseId: binding.candidateRelease.releaseId,
    },
    candidateRelease: {
      ...binding.candidateRelease,
      manifest: binding.candidateRelease.componentManifest || binding.candidateRelease.manifest,
    },
  });
  const stableRelease = stableRuntime.store.getPipelineRelease(binding.stableRelease.releaseId);
  const candidateRelease = candidateRuntime.store.getPipelineRelease(binding.candidateRelease.releaseId);
  if (!releaseSnapshotMatches(stableRelease, binding.stableRelease)
    || !releaseSnapshotMatches(candidateRelease, binding.candidateRelease)) {
    throw new Error('quality release authority changed after preparation');
  }
  if (binding.type === 'turn') {
    const stableTurn = stableRuntime.store.getTurn(binding.turnId);
    const candidateTurn = candidateRuntime.store.getTurn(binding.turnId);
    if (!stableTurn || !candidateTurn
      || stableTurn.authoritativeReleaseId !== binding.stableRelease.releaseId
      || candidateTurn.authoritativeReleaseId !== binding.stableRelease.releaseId
      || stableTurn.authoritativePipelineChecksum !== binding.stableRelease.releaseChecksum
      || candidateTurn.authoritativePipelineChecksum !== binding.stableRelease.releaseChecksum) {
      throw new Error('quality stable turn authority changed after preparation');
    }
    if (!sameAuthoritySnapshot(turnAuthoritySnapshot(stableRuntime.store, binding.turnId), binding.stableTurnSnapshot)
      || !sameAuthoritySnapshot(turnAuthoritySnapshot(candidateRuntime.store, binding.turnId), binding.candidateTurnSnapshot)) {
      throw new Error('quality turn envelope/current batch authority changed after preparation');
    }
  } else {
    const stableAttempt = stableRuntime.store.getLifePlanningAttempt(binding.stablePlanningId);
    const candidateAttempt = candidateRuntime.store.getLifePlanningAttempt(binding.candidatePlanningId);
    if (!stableAttempt || !candidateAttempt
      || stableAttempt.contextChecksum !== candidateAttempt.contextChecksum
      || executionInputChecksum(prepared.execution) !== binding.stableInputChecksum
      || stableAttempt.authoritativeReleaseId !== binding.stableRelease.releaseId
      || candidateAttempt.authoritativeReleaseId !== binding.stableRelease.releaseId
      || stableAttempt.authoritativePipelineChecksum !== binding.stableRelease.releaseChecksum
      || candidateAttempt.authoritativePipelineChecksum !== binding.stableRelease.releaseChecksum) {
      throw new Error('quality life attempt authority changed after preparation');
    }
    if (!sameAuthoritySnapshot(
      lifeAuthoritySnapshot(stableRuntime, stableAttempt, binding.episodeId), binding.stableLifeSnapshot
    ) || !sameAuthoritySnapshot(
      lifeAuthoritySnapshot(candidateRuntime, candidateAttempt, binding.episodeId), binding.candidateLifeSnapshot
    )) {
      throw new Error('quality life context/episode authority changed after preparation');
    }
  }
  if (contentHash(prepared.execution.qualitySemanticInput) !== binding.semanticInputChecksum
    || contentHash(prepared.candidateExecution.qualitySemanticInput) !== binding.semanticInputChecksum) {
    throw new Error('quality semantic input authority changed after preparation');
  }
  if (executionInputChecksum(prepared.execution) !== binding.stableInputChecksum
    || executionInputChecksum(prepared.candidateExecution) !== binding.candidateInputChecksum) {
    throw new Error('quality execution input changed after preparation');
  }
}

export function createQualityProductionContext(config = {}) {
  assertRunIdentity(config);
  const internalProduction = config[INTERNAL_PRODUCTION_CONTEXT_TOKEN] === true;
  if (typeof config.runtimeFactory === 'function' && config.evidenceEligible !== false) {
    throw new Error('runtime factory injection requires evidenceEligible=false');
  }
  if (!internalProduction && (config.stableStore || config.candidateStore
    || config.stableRuntime || config.candidateRuntime)) {
    throw new Error('caller-provided clone stores/runtimes are not permitted');
  }
  for (const key of ['executeTurn', 'executeSubject', 'executeLife']) {
    if (Object.hasOwn(config, key)) throw new Error(`quality context config contains forbidden executor: ${key}`);
  }
  const sourceHead = requiredString(config.sourceHead, 'sourceHead');
  if (!/^[0-9a-f]{40}$/i.test(sourceHead)) throw new Error('sourceHead must be a 40-character git commit');
  if (config.stableRelease && config.candidateRelease
    && String(config.stableRelease.releaseId) === String(config.candidateRelease.releaseId)) {
    throw new Error('stable and candidate release identities must differ');
  }
  if (config.stablePhaseClientSlot !== undefined
    && !isQualityPhaseClientSlot(config.stablePhaseClientSlot)) {
    throw new Error('stable quality phase slot is not authentic');
  }
  if (config.candidatePhaseClientSlot !== undefined
    && !isQualityPhaseClientSlot(config.candidatePhaseClientSlot)) {
    throw new Error('candidate quality phase slot is not authentic');
  }
  if (config.stablePhaseClientSlot !== undefined
    && !qualityPhaseClientSlotHasLedger(config.stablePhaseClientSlot)) {
    throw new Error('stable quality phase ledger identity is required');
  }
  if (config.candidatePhaseClientSlot !== undefined
    && !qualityPhaseClientSlotHasLedger(config.candidatePhaseClientSlot)) {
    throw new Error('candidate quality phase ledger identity is required');
  }
  if (config.stablePhaseClientSlot !== undefined
    && config.stablePhaseClientSlot === config.candidatePhaseClientSlot) {
    throw new Error('stable and candidate quality phase slots must be independent');
  }
  if (config.stableDatabasePath && config.candidateDatabasePath
    && String(config.stableDatabasePath) === String(config.candidateDatabasePath)) {
    throw new Error('stable and candidate stores must use independent paths');
  }
  if (config.seedDatabasePath && (String(config.seedDatabasePath) === String(config.stableDatabasePath)
    || String(config.seedDatabasePath) === String(config.candidateDatabasePath))) {
    throw new Error('seed and clone stores must use independent paths');
  }
  const stableRelease = config.stableRelease ? structuredClone(config.stableRelease) : null;
  const candidateRelease = config.candidateRelease ? structuredClone(config.candidateRelease) : null;
  const seedStore = config.seedStore || (config.seedDatabasePath
    ? openStore(config.seedDatabasePath, config.createStore)
    : null);
  const seedRuntime = config.seedRuntime || (seedStore
    ? runtimeFor({
        runtimeFactory: config.runtimeFactory,
        runtimeInput: config.runtimeInput,
        store: seedStore,
        side: 'seed',
        sourceHead,
      })
    : null);
  const context = {
    config: { ...config, sourceHead, stableRelease, candidateRelease },
    seedStore,
    seedRuntime,
    phase: 'seed',
    prepared: null,
    ownedStores: new Set(seedStore ? [seedStore] : []),
  };
  context.close = () => {
    for (const store of context.ownedStores) closeStore(store);
    for (const path of context.config.temporaryPaths || []) {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        try { rmSync(`${path}${suffix}`, { force: true }); } catch {}
      }
    }
    context.phase = 'closed';
  };
  return context;
}

// The phase client never enters the per-call options object.  A branded
// ledger binding is registered once against the prepared context and retained
// only in this module-private map.
export function registerQualityPhaseBinding(context, side, binding) {
  if (!context || (side !== 'stable' && side !== 'candidate')
    || !isQualityPhaseBinding(binding)) {
    throw new Error('quality phase binding registration conflict');
  }
  const slot = side === 'stable'
    ? context.config.stablePhaseClientSlot : context.config.candidatePhaseClientSlot;
  const scope = qualityPhaseBindingScope(binding);
  if (!slot || slot.identity?.side !== side
    || slot.identity?.runId !== String(scope.runId)
    || slot.identity?.finalKey !== String(scope.finalKey)
    || slot.identity?.phase !== String(scope.phase)) {
    throw new Error('quality phase binding identity conflict');
  }
  assertQualityPhaseClientSlotBinding(slot, binding);
  const existing = CONTEXT_PHASE_BINDINGS.get(context) || {};
  if (existing[side]) throw new Error('quality phase binding already registered');
  CONTEXT_PHASE_BINDINGS.set(context, Object.freeze({ ...existing, [side]: binding }));
}

export async function prepareQualitySubject(context, subject) {
  if (!context || context.phase !== 'seed') throw new Error('quality context is not in seed phase');
  const type = assertSubject(subject);
  if (context.config.planChecksum !== TRACKED_PLAN_CHECKSUM) {
    throw new Error('quality plan checksum is required');
  }
  if (!context.seedStore || !context.seedRuntime) throw new Error('seed store/runtime is required');
  assertV15Store(context.seedStore, 'seed');
  const config = context.config;
  if (subject.finalKey !== config.finalKey) throw new Error('compiled quality finalKey conflict');
  if (subject.subjectType !== (type === 'turn' ? 'turn' : 'life_planning')) {
    throw new Error('compiled quality subject type conflict');
  }
  if (contentHash(subject.semanticInput) !== subject.semanticInputChecksum) {
    throw new Error('compiled quality semantic input conflict');
  }
  assertProductionRuntimeAttestation(context.seedRuntime, { sourceHead: config.sourceHead });
  if (!config.stableRelease || !config.candidateRelease) {
    throw new Error('stable and candidate release rows are required');
  }
  if (!config.candidateRelease.componentManifest && !config.candidateRelease.manifest) {
    throw new Error('candidate release manifest is required');
  }
  const authorityId = authorityIdFor({
    runId: config.runId,
    finalKey: config.finalKey,
    ordinal: config.ordinal,
  });
  let persistedSubject;
  let lifeAttempt = null;
  let lifePlanningContext = null;
  let lifeNow = null;
  let lifeEpisodeId = null;
  if (type === 'turn') {
    const envelope = materializeTurnEnvelope(subject, authorityId, config);
    persistedSubject = context.seedRuntime.orchestrator.accept(envelope, {
      qualitySubject: qualitySubjectAnnotation(subject, authorityId, config)
    });
    if (!persistedSubject || !persistedSubject.turnId) throw new Error('turn accept did not persist a turn');
    if (config.stableRelease?.releaseId
      && String(persistedSubject.authoritativeReleaseId || persistedSubject.pipelineReleaseId || '')
        !== String(config.stableRelease.releaseId)) {
      throw new Error('stable persisted turn release pin conflict');
    }
    if (config.stableRelease?.releaseChecksum
      && String(persistedSubject.authoritativePipelineChecksum || persistedSubject.pipelineChecksum || '')
        !== String(config.stableRelease.releaseChecksum)) {
      throw new Error('stable persisted turn release checksum conflict');
    }
  } else {
    const lifePlan = materializeLifePlan(subject, authorityId);
    lifeNow = lifePlan.now;
    const roleId = requiredString(lifePlan.roleId, 'life roleId');
    const episodes = lifePlan.episodes;
    lifeEpisodeId = episodes[0].episodeId;
    if (typeof context.seedStore.putLifePlan !== 'function') throw new Error('life plan writer is unavailable');
    context.seedStore.putLifePlan(roleId, episodes, { sourceTurnId: `quality-${authorityId}` });
    // The seed only owns the source plan.  Context authority is reconstructed
    // independently from each clone below; never accept a caller-supplied
    // planningContext as a shortcut.
    persistedSubject = { roleId };
  }

  const seedPath = config.seedDatabasePath || context.seedStore.filename;
  closeStore(context.seedStore);
  context.seedStore = null;
  context.seedRuntime = null;
  const stablePath = config.stableDatabasePath;
  const candidatePath = config.candidateDatabasePath;
  let stableStore = config.stableStore || null;
  let candidateStore = config.candidateStore || null;
  if (!stableStore && stablePath && seedPath) {
    if (typeof config.cloneDatabase === 'function') config.cloneDatabase(seedPath, stablePath);
    else copyDatabaseBytes(seedPath, stablePath);
    stableStore = openStore(stablePath, config.createStore);
  }
  if (!candidateStore && candidatePath && seedPath) {
    if (typeof config.cloneDatabase === 'function') config.cloneDatabase(seedPath, candidatePath);
    else copyDatabaseBytes(seedPath, candidatePath);
    candidateStore = openStore(candidatePath, config.createStore);
  }
  if (!stableStore || !candidateStore) throw new Error('independent stable/candidate stores are required');
  context.ownedStores.add(stableStore);
  context.ownedStores.add(candidateStore);
  assertV15Store(stableStore, 'stable');
  assertV15Store(candidateStore, 'candidate');
  if (stableStore === candidateStore
    || (stableStore.filename && candidateStore.filename
      && String(stableStore.filename) === String(candidateStore.filename))) {
    throw new Error('stable and candidate stores must be independent');
  }
  if (config.candidateRelease) installCandidateRelease(candidateStore, config.candidateRelease);
  const stableRuntime = runtimeFor({
    runtime: config.stableRuntime,
    runtimeFactory: config.runtimeFactory,
    store: stableStore,
    side: 'stable',
    sourceHead: config.sourceHead,
    runtimeInput: {
      ...(config.runtimeInputs?.stable || config.runtimeInput || {}),
      qualityPhaseClientSlot: config.stablePhaseClientSlot,
    },
  });
  const candidateRuntime = runtimeFor({
    runtime: config.candidateRuntime,
    runtimeFactory: config.runtimeFactory,
    store: candidateStore,
    side: 'candidate',
    sourceHead: config.sourceHead,
    runtimeInput: {
      ...(config.runtimeInputs?.candidate || config.runtimeInput || {}),
      qualityPhaseClientSlot: config.candidatePhaseClientSlot,
    },
  });
  if (stableRuntime === candidateRuntime
    || stableRuntime.store !== stableStore || candidateRuntime.store !== candidateStore
    || stableRuntime.orchestrator?.codex === candidateRuntime.orchestrator?.codex
    || stableRuntime.orchestrator?.cognitivePipeline === candidateRuntime.orchestrator?.cognitivePipeline
    || stableRuntime.orchestrator?.cognitivePipeline?.codexClient
      === candidateRuntime.orchestrator?.cognitivePipeline?.codexClient
    || stableRuntime.orchestrator?.presets === candidateRuntime.orchestrator?.presets
    || stableRuntime.orchestrator?.promotionController === candidateRuntime.orchestrator?.promotionController) {
    throw new Error('stable and candidate runtimes must be independent');
  }
  const stableAttestation = {
    sourceHead: config.sourceHead,
    releaseIds: { stableReleaseId: config.stableRelease?.releaseId },
    stableRelease: {
      ...config.stableRelease,
      manifest: config.stableRelease.componentManifest || config.stableRelease.manifest,
    },
  };
  const candidateAttestation = {
    sourceHead: config.sourceHead,
    releaseIds: {
      stableReleaseId: config.stableRelease?.releaseId,
      candidateReleaseId: config.candidateRelease?.releaseId,
    },
    stableRelease: {
      ...config.stableRelease,
      manifest: config.stableRelease.componentManifest || config.stableRelease.manifest,
    },
    candidateRelease: {
      ...config.candidateRelease,
      manifest: config.candidateRelease.componentManifest || config.candidateRelease.manifest,
    },
  };
  assertProductionRuntimeAttestation(stableRuntime, stableAttestation);
  assertProductionRuntimeAttestation(candidateRuntime, candidateAttestation);
  if (config.stablePhaseClientSlot !== undefined) {
    assertQualityPhaseClientSlot(stableRuntime, config.stablePhaseClientSlot);
  }
  if (config.candidatePhaseClientSlot !== undefined) {
    assertQualityPhaseClientSlot(candidateRuntime, config.candidatePhaseClientSlot);
  }
  let candidateLifeAttempt = null;
  if (type === 'life_planning') {
    const roleId = persistedSubject.roleId;
    const now = lifeNow;
    const stableController = stableRuntime.orchestrator.promotionController;
    const candidateController = candidateRuntime.orchestrator.promotionController;
    if (!stableController || typeof stableController.createLifePlanningAttempt !== 'function'
      || !candidateController || typeof candidateController.createLifePlanningAttempt !== 'function') {
      throw new Error('life planning attempt creator is unavailable');
    }
    // Always observe the real clone-local projection, but use the deterministic
    // semantic planning window supplied by the compiled subject when present.
    // This keeps the input authority independent of wall-clock Date.now while
    // still proving both production simulations can reconstruct the same view.
    const stableObservedContext = stableRuntime.orchestrator.lifeSimulation?.contextFor(roleId, now);
    const candidateObservedContext = candidateRuntime.orchestrator.lifeSimulation?.contextFor(roleId, now);
    if (!stableObservedContext || !candidateObservedContext) {
      throw new Error('life planning context is unavailable');
    }
    if (contentHash(stableObservedContext) !== contentHash(candidateObservedContext)) {
      throw new Error('stable/candidate life context authority mismatch');
    }
    const planningWindow = materializeLifePlan(subject, authorityId).planningWindow;
    const stablePlanningContext = {
      ...stableObservedContext,
      planWindowStartAt: planningWindow.startAt,
      targetPlanEndAt: planningWindow.targetEndAt,
    };
    const candidatePlanningContext = {
      ...candidateObservedContext,
      planWindowStartAt: planningWindow.startAt,
      targetPlanEndAt: planningWindow.targetEndAt,
    };
    if (contentHash(stablePlanningContext) !== contentHash(candidatePlanningContext)) {
      throw new Error('stable/candidate life context authority mismatch');
    }
    lifeAttempt = stableController.createLifePlanningAttempt({
      roleId, planningContext: stablePlanningContext, now,
    });
    candidateLifeAttempt = candidateController.createLifePlanningAttempt({
      roleId,
      planningContext: candidatePlanningContext,
      now,
    });
    persistedSubject.attempt = lifeAttempt;
  }
  const executionOptions = {
    qualityAuthorityId: authorityId,
    qualitySemanticInputChecksum: subject.semanticInputChecksum
  };
  const execution = type === 'turn'
    ? buildTurnExecution(stableRuntime, persistedSubject.turnId, executionOptions)
    : buildLifeExecution(stableRuntime, lifeAttempt, executionOptions);
  const candidateExecution = type === 'turn'
    ? buildTurnExecution(candidateRuntime, persistedSubject.turnId, executionOptions)
    : buildLifeExecution(candidateRuntime, candidateLifeAttempt, executionOptions);
  execution.qualitySemanticInput = structuredClone(subject.semanticInput);
  candidateExecution.qualitySemanticInput = structuredClone(subject.semanticInput);
  const executionSubjectId = type === 'turn' ? persistedSubject.turnId : lifeAttempt.planningId;
  assertExecutionAuthority(execution, authorityId, executionSubjectId, type);
  assertExecutionAuthority(candidateExecution, authorityId,
    type === 'turn' ? persistedSubject.turnId : candidateLifeAttempt.planningId, type);
  if (type === 'turn' && executionAuthorityFingerprint(execution) !== executionAuthorityFingerprint(candidateExecution)) {
    throw new Error('stable/candidate execution authority mismatch');
  }
  if (executionInputChecksum(execution) !== executionInputChecksum(candidateExecution)) {
    throw new Error('stable/candidate execution input checksum mismatch');
  }
  context.phase = 'prepared';
  context.prepared = {
    type,
    authorityId,
    persistedSubject,
    lifeAttempt,
    candidateLifeAttempt,
    stableStore,
    candidateStore,
    stableRuntime,
    candidateRuntime,
    execution,
    candidateExecution,
    stableRelease: config.stableRelease,
    candidateRelease: config.candidateRelease,
    semanticInputChecksum: subject.semanticInputChecksum,
  };
  CONTEXT_BINDINGS.set(context, Object.freeze({
    authorityId,
    type,
    turnId: type === 'turn' ? persistedSubject.turnId : null,
    stablePlanningId: type === 'life_planning' ? lifeAttempt.planningId : null,
    candidatePlanningId: type === 'life_planning' ? candidateLifeAttempt.planningId : null,
    stableRelease: structuredClone(config.stableRelease),
    candidateRelease: structuredClone(config.candidateRelease),
    stableInputChecksum: executionInputChecksum(execution),
    candidateInputChecksum: executionInputChecksum(candidateExecution),
    stableAuthorityFingerprint: executionAuthorityFingerprint(execution),
    candidateAuthorityFingerprint: executionAuthorityFingerprint(candidateExecution),
    semanticInputChecksum: subject.semanticInputChecksum,
    ...(type === 'turn' ? {
      stableTurnSnapshot: turnAuthoritySnapshot(stableStore, persistedSubject.turnId),
      candidateTurnSnapshot: turnAuthoritySnapshot(candidateStore, persistedSubject.turnId),
    } : {
      episodeId: lifeEpisodeId,
      stableLifeSnapshot: lifeAuthoritySnapshot(stableRuntime, lifeAttempt, lifeEpisodeId),
      candidateLifeSnapshot: lifeAuthoritySnapshot(candidateRuntime, candidateLifeAttempt, lifeEpisodeId),
    }),
  }));
  return context.prepared;
}

export async function executeQualitySubject(context, subject = {}) {
  if (!context?.prepared || context.phase !== 'prepared') throw new Error('quality subject is not prepared');
  const prepared = context.prepared;
  const binding = CONTEXT_BINDINGS.get(context);
  if (!binding) throw new Error('quality subject authority binding is missing');
  const type = binding.type;
  rereadPreparedAuthority(context, binding);
  const expectedMethod = type === 'turn' ? 'executeTurn' : 'executeLife';
  if (subject.method && subject.method !== expectedMethod) throw new Error('quality subject method authority conflict');
  if (subject.authorityId && String(subject.authorityId) !== String(binding.authorityId)) {
    throw new Error('quality subject authority identity conflict');
  }
  if (subject.inputChecksum
    && String(subject.inputChecksum) !== executionInputChecksum(prepared.execution)) {
    throw new Error('quality subject input checksum conflict');
  }
  if (!binding.stableRelease || !binding.candidateRelease) {
    throw new Error('stable and candidate release rows are required');
  }
  const stableCall = {
    releaseId: binding.stableRelease.releaseId,
    releaseChecksum: binding.stableRelease.releaseChecksum,
    execution: prepared.execution,
    dryRun: false,
  };
  const candidateCall = {
    releaseId: binding.candidateRelease.releaseId,
    releaseChecksum: binding.candidateRelease.releaseChecksum,
    execution: prepared.candidateExecution,
    dryRun: true,
  };
  const stable = await prepared.stableRuntime.releaseExecutor[expectedMethod](stableCall);
  const candidate = await prepared.candidateRuntime.releaseExecutor[expectedMethod](candidateCall);
  return { stable, candidate, authorityId: binding.authorityId };
}

export async function executeQualitySubjectSide(context, subject = {}, options = {}) {
  if (!context?.prepared || context.phase !== 'prepared') {
    throw new Error('quality subject is not prepared');
  }
  const binding = CONTEXT_BINDINGS.get(context);
  if (!binding) throw new Error('quality subject authority binding is missing');
  const side = options.side;
  if (side !== 'stable' && side !== 'candidate') throw new Error('quality subject side is invalid');
  const runtime = side === 'stable' ? context.prepared.stableRuntime : context.prepared.candidateRuntime;
  const expectedSlot = side === 'stable'
    ? context.config.stablePhaseClientSlot
    : context.config.candidatePhaseClientSlot;
  if (!expectedSlot || options.phaseClientSlot !== expectedSlot) {
    throw new Error('quality subject phase slot conflict');
  }
  assertQualityPhaseClientSlot(runtime, options.phaseClientSlot);
  rereadPreparedAuthority(context, binding);
  if (Object.hasOwn(options, 'phaseClient') || Object.hasOwn(options, 'phaseInput')) {
    throw new Error('quality phase client injection is forbidden');
  }
  const phaseBinding = CONTEXT_PHASE_BINDINGS.get(context)?.[side];
  if (!phaseBinding) {
    throw new Error('quality phase ledger binding is required');
  }
  const phaseInput = qualityPhaseBindingScope(phaseBinding);
  const expectedPhase = side === 'stable' ? 'stable_execution' : 'candidate_execution';
  if (phaseInput.phase !== expectedPhase
    || String(phaseInput.runId) !== String(context.config.runId)
    || String(phaseInput.finalKey) !== String(context.config.finalKey)
    || String(phaseInput.subjectChecksum) !== String(binding.semanticInputChecksum)
    || String(phaseInput.authorityInputChecksum)
      !== String(side === 'stable' ? binding.stableInputChecksum : binding.candidateInputChecksum)) {
    throw new Error('quality phase input authority conflict');
  }
  // This is intentionally the first operation that can touch the model
  // client.  bindQualityPhaseClientSlot only performs a read-only lookup and
  // accepts an exact persisted running phase/input identity.
  bindQualityPhaseClientSlot(options.phaseClientSlot, phaseBinding);
  const type = binding.type;
  const expectedMethod = type === 'turn' ? 'executeTurn' : 'executeLife';
  if (subject.method && subject.method !== expectedMethod) throw new Error('quality subject method authority conflict');
  if (subject.authorityId && String(subject.authorityId) !== String(binding.authorityId)) {
    throw new Error('quality subject authority identity conflict');
  }
  const execution = side === 'stable' ? context.prepared.execution : context.prepared.candidateExecution;
  const release = side === 'stable' ? binding.stableRelease : binding.candidateRelease;
  const call = {
    releaseId: release.releaseId,
    releaseChecksum: release.releaseChecksum,
    // The composition-installed private router is the only client.  Omit any
    // legacy execution.client field so CognitivePipeline cannot bypass it.
    execution: (() => {
      const { client: _ignoredClient, ...withoutClient } = execution;
      return withoutClient;
    })(),
    dryRun: side === 'candidate',
  };
  const value = await runtime.releaseExecutor[expectedMethod](call);
  // A model call may race a release/turn/LIFE mutation.  The result is never
  // accepted as phase evidence unless the complete authority rereads cleanly.
  rereadPreparedAuthority(context, binding);
  if ((side === 'stable' ? context.config.stablePhaseClientSlot : context.config.candidatePhaseClientSlot)
    !== options.phaseClientSlot) {
    throw new Error('quality phase slot authority changed');
  }
  return { [side]: value, authorityId: binding.authorityId };
}

export async function executeQualityEvaluatorSide(config, {
  side, role = 'brain', input, phaseInput, ledger, options = {}
} = {}) {
  assertQualityProductionExecutionConfig(config);
  if (side !== 'primary' && side !== 'secondary') {
    throw new Error('quality evaluator side is invalid');
  }
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('quality evaluator input is required');
  }
  const state = QUALITY_PRODUCTION_CONFIG_STATE.get(config);
  if (!phaseInput || !ledger) throw new Error('quality evaluator phase authority is required');
  const expectedPhase = side === 'primary' ? 'evaluator_primary' : 'evaluator_secondary';
  if (phaseInput.phase !== expectedPhase || phaseInput.runId !== config.runId) {
    throw new Error('quality evaluator phase identity conflict');
  }
  const clientConfig = state.materials.clientConfigs[expectedPhase];
  const underlying = new CodexAppServerClient({ ...clientConfig });
  const owner = new LedgerBackedModelClient({ ledger, underlying, runId: config.runId });
  const phaseClient = owner.forPhase(phaseInput);
  return phaseClient.runRole(role, input, options);
}
