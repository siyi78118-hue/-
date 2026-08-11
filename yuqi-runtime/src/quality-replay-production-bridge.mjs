import { copyFileSync, existsSync, mkdirSync, rmSync, lstatSync, statSync, realpathSync, mkdtempSync, linkSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from './codex-client.mjs';

import { contentHash } from './protocol.mjs';
import { compileQualitySubject, QUALITY_BLIND_EVALUATION_SCHEMA } from './quality-evaluator.mjs';
import { deriveAuthorityLineageKey } from './authority-identity.mjs';
import { YuqiStore } from './store.mjs';
import { CognitivePipeline } from './cognitive-pipeline.mjs';
import {
  COGNITION_SCHEMA_V2, COGNITION_SCHEMA_V3,
  EXPRESSION_SCHEMA_V2, EXPRESSION_SCHEMA_V3,
  ROLE_OUTPUT_SCHEMAS,
} from './role-schemas.mjs';
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
  qualityPhaseClientSlotIsBound,
  createQualityPhaseClientSlot,
  createQualityPhaseBinding,
  LedgerBackedModelClient,
  qualityPhaseBindingScope,
  qualityPhaseClientSlotLedger,
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

// A normal read-only SQLite open can create a shared-memory sidecar when the
// database was created in WAL mode.  Authority reads must be observational:
// immutable URI mode prevents that reader-created artifact and also makes it
// impossible for the verifier to accidentally repair or migrate a published
// store while checking it.
function openImmutableReadOnly(databasePath) {
  const absolute = resolve(String(databasePath));
  const uri = `file:${encodeURI(absolute.replace(/\\/g, '/'))}?immutable=1`;
  return new DatabaseSync(uri, { readOnly: true, uri: true });
}
const CONTEXT_BINDINGS = new WeakMap();
const CONTEXT_PHASE_BINDINGS = new WeakMap();
const QUALITY_PRODUCTION_CONFIG_BRAND = new WeakSet();
const QUALITY_PRODUCTION_CONFIG_STATE = new WeakMap();
const QUALITY_PRODUCTION_INPUT_PATHS = new WeakMap();
const QUALITY_PRODUCTION_SOURCE_ROOTS = new WeakMap();
const QUALITY_RUN_AUTHORITY_BRAND = new WeakSet();
const QUALITY_RUN_AUTHORITY_STATE = new WeakMap();
const INTERNAL_PRODUCTION_CONTEXT_TOKEN = Symbol('quality-production-context');
const PRODUCTION_AUTHORITY_TOKEN = Symbol('quality-production-authority');
const TRACKED_PLAN_CHECKSUM = 'dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c';

const PRODUCTION_CONFIG_DESCRIPTOR_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead',
  'stableRelease', 'candidateRelease', 'attestation', 'attestationChecksum',
  'artifactPaths', 'ledgerPath', 'inputArtifactChecksums', 'createdAt', 'evidenceEligible'
]);
const RUN_AUTHORITY_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead',
  'stableRelease', 'candidateRelease', 'attestation', 'attestationChecksum',
  'artifactPaths', 'ledgerPath', 'inputArtifactChecksums', 'createdAt', 'evidenceEligible'
]);

const PRIVATE_EVIDENCE_RELATIVE = 'artifacts/yuqi-lived-agency-v3/private';

function isReparseOrLink(stat) {
  return Boolean(stat?.isSymbolicLink?.() || stat?.isJunction?.() || stat?.isReparsePoint?.());
}

export function assertPrivateNoFollowPath(rootDir, value, label = 'quality private path') {
  const root = realpathSync(rootDir);
  const privateRoot = resolve(root, PRIVATE_EVIDENCE_RELATIVE);
  if (!existsSync(privateRoot) || isReparseOrLink(lstatSync(privateRoot))) {
    throw new Error(`${label} private root link conflict`);
  }
  const absolute = isAbsolute(value) ? resolve(value) : resolvePathUnderRoot(root, value);
  const privateRelative = relative(privateRoot, absolute);
  if (!privateRelative || privateRelative.startsWith('..') || privateRelative.includes(':')) {
    throw new Error(`${label} outside private evidence root`);
  }
  let cursor = root;
  const rootRelative = relative(root, absolute);
  for (const part of rootRelative.split(/[\\/]/)) {
    if (!part || part === '.') continue;
    cursor = join(cursor, part);
    if (existsSync(cursor) && isReparseOrLink(lstatSync(cursor))) {
      throw new Error(`${label} symlink/junction ancestor conflict`);
    }
  }
  const existingParent = existsSync(absolute) ? absolute : nearestExisting(dirname(absolute));
  const existingReal = realpathSync(existingParent);
  const realRelative = relative(privateRoot, existingReal);
  if (realRelative.startsWith('..') || realRelative.includes(':')) {
    throw new Error(`${label} realpath containment conflict`);
  }
  return absolute;
}

function ignoredPath(rootDir, relativePath) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relativePath], {
      cwd: rootDir, windowsHide: true,
    });
    return true;
  } catch { return false; }
}

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
      && path.startsWith(`${PRIVATE_EVIDENCE_RELATIVE}/`)
      && ignoredPath(sourceRootDir, path);
    if (privateUntracked) assertPrivateNoFollowPath(sourceRootDir, path, 'quality source evidence');
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} data-only client config required`);
  }
  rejectOperationalObjects(value, label);
  const allowed = new Set([
    'command', 'args', 'cwd', 'env', 'clientInfo', 'requestTimeoutMs',
    'turnTimeoutMs', 'maxRoleTurns', 'modelProfile', 'sessionNamespace',
    'namespace', 'threadNamespace', 'lane', 'sessionStorePath',
    'approvalPolicy', 'sandbox', 'schema'
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

function rejectOperationalObjects(value, path = 'value', seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${path} operational object conflict`);
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} cycle conflict`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) rejectOperationalObjects(child, `${path}.${key}`, seen);
  seen.delete(value);
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
    || contentHash(descriptor.inputArtifactChecksums) !== contentHash(productionConfig.inputArtifactChecksums)
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
  if (!descriptor.inputArtifactChecksums
    || Object.keys(descriptor.inputArtifactChecksums).sort().join(',') !== 'materials,plan,seedDatabase'
    || Object.values(descriptor.inputArtifactChecksums).some(value => !/^[a-f0-9]{64}$/i.test(value))) {
    throw new Error('quality production input artifact checksum conflict');
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
  assertDirectProductionAuthorityInputs(sourceRootDir, descriptor, materials);
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
  const verifiedRoot = realpathSync(sourceRootDir);
  const verifiedPlanPath = assertPrivateNoFollowPath(
    verifiedRoot,
    resolvePathUnderRoot(verifiedRoot, descriptor.artifactPaths.plan),
    'quality verified plan',
  );
  const verifiedMaterialsPath = assertPrivateNoFollowPath(
    verifiedRoot,
    join(verifiedRoot, PRIVATE_EVIDENCE_RELATIVE, 'quality-production-config.json'),
    'quality verified materials',
  );
  QUALITY_PRODUCTION_INPUT_PATHS.set(config, Object.freeze({
    planPath: verifiedPlanPath,
    materialsPath: verifiedMaterialsPath,
    seedDatabasePath: realpathSync(materials.seedDatabasePath),
  }));
  QUALITY_PRODUCTION_SOURCE_ROOTS.set(config, verifiedRoot);
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

function assertDirectProductionAuthorityInputs(sourceRootDir, descriptor, materials) {
  const planPath = assertPrivateNoFollowPath(
    sourceRootDir,
    descriptor?.artifactPaths?.plan,
    'quality direct authority plan',
  );
  const materialsPath = assertPrivateNoFollowPath(
    sourceRootDir,
    join(sourceRootDir, PRIVATE_EVIDENCE_RELATIVE, 'quality-production-config.json'),
    'quality direct authority materials',
  );
  const seedPath = assertPrivateNoFollowPath(
    sourceRootDir,
    materials?.seedDatabasePath,
    'quality direct authority seed',
  );
  const expectedChecksums = descriptor?.inputArtifactChecksums;
  if (!expectedChecksums || typeof expectedChecksums !== 'object'
    || createHash('sha256').update(readFileSync(planPath)).digest('hex') !== expectedChecksums.plan
    || createHash('sha256').update(readFileSync(materialsPath)).digest('hex') !== expectedChecksums.materials
    || createHash('sha256').update(readFileSync(seedPath)).digest('hex') !== expectedChecksums.seedDatabase) {
    throw new Error('quality direct authority input artifact drift');
  }
  let plan;
  let manifest;
  try {
    plan = JSON.parse(readFileSync(planPath, 'utf8'));
    manifest = JSON.parse(readFileSync(materialsPath, 'utf8'));
  } catch {
    throw new Error('quality direct authority input JSON conflict');
  }
  if (plan.planChecksum !== TRACKED_PLAN_CHECKSUM
    || plan.planChecksum !== descriptor.planChecksum
    || !Array.isArray(plan.items) || plan.items.length !== 246) {
    throw new Error('quality direct authority plan conflict');
  }
  const finalKeys = plan.items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.layer !== 'string'
      || typeof item.sceneId !== 'string' || !Number.isSafeInteger(item.repeatIndex) || item.repeatIndex < 0) {
      throw new Error('quality direct authority plan item conflict');
    }
    return `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
  });
  if (new Set(finalKeys).size !== 246
    || contentHash(finalKeys) !== contentHash(descriptor.finalKeys)
    || finalKeys.some((key, index) => key !== descriptor.finalKeys[index])) {
    throw new Error('quality direct authority final-key conflict');
  }
  if (!manifest || manifest.version !== 1 || manifest.sourceHead !== descriptor.sourceHead
    || contentHash(manifest.stableRelease) !== contentHash(descriptor.stableRelease)
    || contentHash(manifest.candidateRelease) !== contentHash(descriptor.candidateRelease)
    || manifest.seedDatabaseSha256 !== expectedChecksums.seedDatabase) {
    throw new Error('quality direct authority materials conflict');
  }
  for (const [field, expected] of [
    ['seedDatabasePath', materials.seedDatabasePath],
    ['stableDatabasePath', materials.stableDatabasePath],
    ['candidateDatabasePath', materials.candidateDatabasePath],
  ]) {
    const manifestPath = realpathSync(resolve(sourceRootDir, manifest[field]));
    if (manifestPath !== realpathSync(resolve(expected))) {
      throw new Error(`quality direct authority ${field} conflict`);
    }
  }
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
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${absolute}${suffix}`;
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw new Error('quality production source database sidecar conflict');
      }
    }
    const db = openImmutableReadOnly(absolute);
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
        releaseIds: side === 'stable'
          ? { stableReleaseId: productionConfig.stableRelease.releaseId }
          : {
            stableReleaseId: productionConfig.stableRelease.releaseId,
            candidateReleaseId: productionConfig.candidateRelease.releaseId,
          },
        stableRelease: productionConfig.stableRelease,
        ...(side === 'candidate' ? { candidateRelease: productionConfig.candidateRelease } : {}),
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
  // The temporary runtime attestation is an adversarial boundary: all raw
  // inputs and source identity must be re-read after it, before this
  // preflight can mint/hand off any writable ledger authority.
  assertDirectProductionAuthorityInputs(root, productionConfig, state.materials);
  assertCleanQualitySourceIdentity({ sourceRootDir: root, expectedHead: productionConfig.sourceHead });
  // Re-read the source identity after temporary runtime construction.  A
  // release/manifest change during attestation invalidates the whole run.
  const postAttestationPaths = [
    state.materials.seedDatabasePath,
    state.materials.stableDatabasePath,
    state.materials.candidateDatabasePath,
  ].map(path => isAbsolute(path) ? resolve(path) : resolvePathUnderRoot(root, path));
  const postAttestation = openImmutableReadOnly(postAttestationPaths[0]);
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
  for (const databasePath of postAttestationPaths) {
    const database = openImmutableReadOnly(databasePath);
    try {
      const schemaVersion = Number(database.prepare('PRAGMA user_version').get().user_version);
      const quickCheck = String(database.prepare('PRAGMA quick_check').get().quick_check || '');
      if (schemaVersion !== 15 || quickCheck !== 'ok') {
        throw new Error('quality production source database identity drift');
      }
    } finally { database.close(); }
  }
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
  return assertPrivateNoFollowPath(root, value, 'quality production path');
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
  const clock = typeof runtimeConfig.clock === 'function' ? runtimeConfig.clock : (() => Date.now());
  const presetDir = runtimeConfig.presetDir
    || join(dirname(fileURLToPath(import.meta.url)), '..', 'presets');
  const clientConfig = materials.clientConfigs[side === 'stable' ? 'stable_execution' : 'candidate_execution'];
  const rawCodex = attestationOnly
    ? createAttestationOnlyClient()
    : new CodexAppServerClient({ ...clientConfig, store });
  const codex = createReleaseProfileClient({ underlying: rawCodex, release, lane: side });
  const presets = new PresetRegistry({ presetDir, store, clock });
  const promotionController = new PromotionController({
    store, presetRegistry: presets, clock,
  });
  promotionController.initialize();
  const cognitivePipeline = new CognitivePipeline({
    store, codexClient: codex, presetRegistry: presets,
    clock,
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
  const ledger = qualityPhaseClientSlotLedger(slot);
  const materials = context.config.productionMaterials;
  if (!materials) throw new Error('quality production materials unavailable');
  const release = side === 'stable' ? context.config.stableRelease : context.config.candidateRelease;
  const rawUnderlying = new CodexAppServerClient({
    ...materials.clientConfigs[phaseInput.phase],
    store: context.prepared[side === 'stable' ? 'stableStore' : 'candidateStore'],
  });
  const underlying = createReleaseProfileClient({
    underlying: rawUnderlying, release, lane: side,
  });
  const client = new LedgerBackedModelClient({
    ledger, underlying, runId: context.config.runId,
  });
  const binding = createQualityPhaseBinding(client, phaseInput);
  // The raw Codex client owns the child app-server process; retain that owner
  // on the context so partial/ordinary close can stop it deterministically.
  context.ownedClients?.add(rawUnderlying);
  context.phaseClients?.set(side, rawUnderlying);
  bindQualityPhaseClientSlot(slot, binding);
  registerQualityPhaseBinding(context, side, binding);
  return binding;
}

async function createProductionContextForFinal(config, materials, input = {}) {
  if (!input || typeof input !== 'object' || !input.item || !input.ledger) {
    throw new Error('production context ledger/input required');
  }
  // Re-read the immutable source artifacts after attestation and immediately
  // before opening the seed/store/runtime graph.  This closes the final
  // pre-call TOCTOU window; the config brand alone is not an input authority.
  assertProductionInputAuthority(config);
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
  const buildRoot = mkdtempSync(join(dirname(tempStem), `.quality-${contentHash({ runId: config.runId, finalKey }).slice(0, 24)}-`));
  const seedPath = join(buildRoot, 'seed.sqlite');
  const stablePath = `${tempStem}.stable.sqlite`;
  const candidatePath = `${tempStem}.candidate.sqlite`;
  copyDatabaseBytes(materials.seedDatabasePath, seedPath);
  const seedStore = new YuqiStore(seedPath);
  const seedInput = createProductionRuntimeInput({
    store: seedStore, side: 'stable', sourceHead: config.sourceHead,
    release: config.stableRelease, materials,
  });
  // Stable/candidate are published only after the seed subject has been
  // materialized and closed.  Opening them here would create a stale clone and
  // would force a later overwrite of an already-published final.
  let context;
  try {
    context = createQualityProductionContext({
      runId: config.runId, finalKey, ordinal, sourceHead: config.sourceHead,
      createdAt: config.createdAt,
      anchorAt: input.item.anchorAt, planChecksum: config.planChecksum,
      seedStore, seedRuntime: composeYuqiExecutionRuntime({
        ...seedInput, qualityPhaseClientSlot: undefined,
      }),
      seedDatabasePath: seedPath,
      seedWorkingDatabasePath: `${stablePath}.seed-working.sqlite`,
      stableDatabasePath: stablePath,
      candidateDatabasePath: candidatePath,
      stableStore: null, candidateStore: null,
      stableRelease: config.stableRelease,
      candidateRelease: config.candidateRelease,
      stablePhaseClientSlot: stableSlot,
      candidatePhaseClientSlot: candidateSlot,
      runtimeInputs: {},
      productionMaterials: materials,
      inputArtifactChecksums: config.inputArtifactChecksums,
    verifiedInputPaths: QUALITY_PRODUCTION_INPUT_PATHS.get(config) || null,
    verifiedSourceRoot: QUALITY_PRODUCTION_SOURCE_ROOTS.get(config) || null,
      evidenceEligible: true,
      [INTERNAL_PRODUCTION_CONTEXT_TOKEN]: true,
      evaluatorPrimaryDatabasePath: `${stablePath}.evaluator-primary.sqlite`,
      evaluatorSecondaryDatabasePath: `${stablePath}.evaluator-secondary.sqlite`,
      unpublishedTempPaths: [buildRoot],
      publishedStorePaths: [
        `${stablePath}.seed-working.sqlite`, stablePath, candidatePath,
        `${stablePath}.evaluator-primary.sqlite`, `${stablePath}.evaluator-secondary.sqlite`,
      ],
    });
  } catch (error) {
    try { closeStore(seedStore); } catch {}
    try { rmSync(buildRoot, { recursive: true, force: true }); } catch {}
    throw error;
  }
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

function ensureStoreManifestRow(store, value, { replace = false } = {}) {
  const db = store?.db;
  if (!db) throw new Error('quality store manifest database authority unavailable');
  const expected = JSON.stringify(value);
  const checksum = contentHash(value);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS quality_production_store_manifest (
      manifest_id TEXT PRIMARY KEY CHECK (manifest_id = 'quality-store-manifest-v1'),
      manifest_json TEXT NOT NULL,
      manifest_checksum TEXT NOT NULL
    )`);
    const rows = db.prepare('SELECT manifest_id,manifest_json,manifest_checksum FROM quality_production_store_manifest').all();
    if (rows.length > 1) throw new Error('quality store manifest multiplicity conflict');
    if (rows.length === 1 && replace) {
      db.prepare('DELETE FROM quality_production_store_manifest').run();
      db.prepare('INSERT INTO quality_production_store_manifest(manifest_id,manifest_json,manifest_checksum) VALUES(?,?,?)')
        .run('quality-store-manifest-v1', expected, checksum);
    } else if (rows.length === 1) {
      if (rows[0].manifest_id !== 'quality-store-manifest-v1'
        || rows[0].manifest_json !== expected || rows[0].manifest_checksum !== checksum) {
        throw new Error('quality store manifest authority conflict');
      }
    } else {
      db.prepare('INSERT INTO quality_production_store_manifest(manifest_id,manifest_json,manifest_checksum) VALUES(?,?,?)')
        .run('quality-store-manifest-v1', expected, checksum);
    }
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function publishStoreClone(sourcePath, destinationPath, manifest) {
  if (existsSync(destinationPath)) {
    const existing = readQualityProductionStoreManifest(destinationPath);
    if (contentHash(existing) !== contentHash(manifest)) throw new Error('quality store final manifest conflict');
    return false;
  }
  mkdirSync(dirname(destinationPath), { recursive: true });
  const temporary = `${destinationPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  let store = null;
  try {
    copyDatabaseBytes(sourcePath, temporary);
    store = new YuqiStore(temporary);
    ensureStoreManifestRow(store, manifest, { replace: true });
    try { store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    closeStore(store);
    store = null;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(`${temporary}${suffix}`)) throw new Error('quality store final sidecar remains');
    }
    if (existsSync(destinationPath)) {
      const existing = readQualityProductionStoreManifest(destinationPath);
      if (contentHash(existing) !== contentHash(manifest)) throw new Error('quality store final manifest conflict');
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${temporary}${suffix}`, { force: true });
      return false;
    }
    // renameSync is replace-on-POSIX and therefore cannot establish a single
    // creator.  A same-volume hard-link is the non-overwriting publish
    // primitive: exactly one creator links the closed, verified temp inode;
    // every loser reopens and compares the winner before discarding its temp.
    try {
      linkSync(temporary, destinationPath);
    } catch (error) {
      if (!existsSync(destinationPath)) throw error;
      const existing = readQualityProductionStoreManifest(destinationPath);
      if (contentHash(existing) !== contentHash(manifest)) throw new Error('quality store final manifest conflict');
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(`${temporary}${suffix}`, { force: true });
      return false;
    }
    rmSync(temporary, { force: true });
    return true;
  } catch (error) {
    const cleanupErrors = [];
    if (store) {
      try { closeStore(store); }
      catch (cleanupError) { cleanupErrors.push(`store close: ${cleanupError?.message || String(cleanupError)}`); }
    }
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        rmSync(`${temporary}${suffix}`, { force: true });
      }
    } catch (cleanupError) {
      cleanupErrors.push(`temporary cleanup: ${cleanupError?.message || String(cleanupError)}`);
    }
    if (cleanupErrors.length) {
      error.message = `${error.message}; ${cleanupErrors.join('; ')}`;
      error.cleanupErrors = cleanupErrors;
    }
    throw error;
  }
}

function verifyPublishedStore(destinationPath, expectedManifest) {
  const actual = readQualityProductionStoreManifest(destinationPath);
  if (contentHash(actual) !== contentHash(expectedManifest)) {
    throw new Error('quality store final manifest authority conflict');
  }
  const db = openImmutableReadOnly(destinationPath);
  try {
    const version = Number(db.prepare('PRAGMA user_version').get().user_version);
    if (version !== 15) throw new Error('quality published store must be v15');
    const integrity = String(db.prepare('PRAGMA quick_check').get().quick_check || '');
    if (integrity !== 'ok') throw new Error('quality published store integrity conflict');
  } finally { db.close(); }
  return actual;
}

function clearInterruptedPublishTemps(destinationPath) {
  const prefix = `${destinationPath}.tmp-`;
  const prefixName = `${basename(destinationPath)}.tmp-`;
  let entries = [];
  try { entries = readdirSync(dirname(destinationPath), { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const candidate = join(dirname(destinationPath), entry.name);
    if (!candidate.startsWith(prefix) || !entry.name.startsWith(prefixName)) continue;
    // Temp names carry the creating PID.  A live creator owns its temp and
    // must never be cleaned by a concurrent publisher; only dead owners (or
    // legacy crash labels without a PID) are stale and eligible for removal.
    const owner = entry.name.slice(prefixName.length).match(/^(\d+)-[0-9a-f]+(?:-(?:wal|shm|journal))?$/i);
    if (!owner) continue;
    try { process.kill(Number(owner[1]), 0); continue; }
    catch (error) { if (error?.code !== 'ESRCH') continue; }
    rmSync(candidate, { recursive: true, force: true });
  }
}

function readManifestFromOpenStore(store) {
  const rows = store?.db?.prepare?.(
    'SELECT manifest_id,manifest_json,manifest_checksum FROM quality_production_store_manifest'
  ).all?.() || [];
  if (rows.length !== 1 || rows[0].manifest_id !== 'quality-store-manifest-v1') {
    throw new Error('quality open store manifest is not singleton');
  }
  let value;
  try { value = JSON.parse(rows[0].manifest_json); }
  catch { throw new Error('quality open store manifest JSON conflict'); }
  if (contentHash(value) !== rows[0].manifest_checksum) {
    throw new Error('quality open store manifest checksum conflict');
  }
  return value;
}

async function openOrPublishExpectedStore({ sourcePath, destinationPath, manifest, createStore, publicationResults = null }) {
  let concurrentPublishHandoff = false;
  for (let attempt = 0; ; attempt += 1) {
    const existedAtStart = existsSync(destinationPath);
    if (existedAtStart) clearInterruptedPublishTemps(destinationPath);
    try {
      if (existedAtStart) {
        // A concurrent creator may still be closing the winner it just opened.
        // Wait for the observable sidecar condition before the immutable
        // manifest reader runs; a persistent sidecar remains a hard conflict.
        await awaitPublishedStoreSidecarsGone([destinationPath], { timeoutMs: 3_000 });
      }
      const created = existedAtStart
        ? false
        : publishStoreClone(sourcePath, destinationPath, manifest);
      concurrentPublishHandoff ||= !existedAtStart && created === false;
      publicationResults?.set(String(destinationPath), created === true);
      await awaitPublishedStoreSidecarsGone([destinationPath], { timeoutMs: 3_000 });
      verifyPublishedStore(destinationPath, manifest);
      return openStore(destinationPath, createStore);
    } catch (error) {
      // A concurrent creator may have opened the just-published winner before
      // this reader verifies it, leaving SQLite's live -shm sidecar or a short
      // SQLITE_BUSY hand-off. Wait only for that bounded hand-off; a
      // persistent sidecar/lock remains a hard failure.
      const handoffError = /sidecar|database(?: table)? is locked|SQLITE_BUSY/i.test(
        String(error?.message || '')
      );
      if (!existedAtStart && existsSync(destinationPath) && handoffError) {
        concurrentPublishHandoff = true;
      }
      if ((!concurrentPublishHandoff && existedAtStart)
        || !existsSync(destinationPath) || !handoffError || attempt >= 79) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

export function readQualityProductionStoreManifest(path) {
  if (typeof path !== 'string' || !path) throw new Error('quality store manifest path required');
  assertNoMeaningfulStoreSidecars(path);
  const db = openImmutableReadOnly(path);
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='quality_production_store_manifest'").get();
    if (!table) throw new Error('quality store manifest is unavailable');
    const columns = db.prepare('PRAGMA table_info(quality_production_store_manifest)').all().map(row => row.name);
    if (columns.join(',') !== 'manifest_id,manifest_json,manifest_checksum') throw new Error('quality store manifest schema conflict');
    const rows = db.prepare('SELECT manifest_id,manifest_json,manifest_checksum FROM quality_production_store_manifest').all();
    if (rows.length !== 1 || rows[0].manifest_id !== 'quality-store-manifest-v1') throw new Error('quality store manifest is not singleton');
    let value;
    try { value = JSON.parse(rows[0].manifest_json); } catch { throw new Error('quality store manifest JSON conflict'); }
    if (contentHash(value) !== rows[0].manifest_checksum) throw new Error('quality store manifest checksum conflict');
    return Object.freeze(value);
  } finally { db.close(); }
}

function closeStore(store) {
  if (store && typeof store.close === 'function' && !CLOSED_STORES.has(store)) {
    CLOSED_STORES.add(store);
    // Flush this owner's WAL before releasing its connection.  A sibling
    // owner may still be active; SQLite reports BUSY in that case and the
    // sibling/parent remains responsible for the final quiescence edge.  We
    // never remove a sidecar here and never wait for another owner.
    try {
      store.db?.exec?.('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch (error) {
      if (!/database(?: table)? is locked|SQLITE_BUSY/i.test(String(error?.message || ''))) {
        CLOSED_STORES.delete(store);
        throw error;
      }
    }
    store.close();
  }
}

function assertNoMeaningfulStoreSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${path}${suffix}`;
    try {
      if (existsSync(sidecar) && statSync(sidecar).size > 0) {
        throw new Error(`quality store sidecar is not closed: ${sidecar}`);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function meaningfulStoreSidecars(paths = []) {
  const remaining = [];
  for (const path of new Set(paths.filter(Boolean).map(String))) {
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = `${path}${suffix}`;
      try {
        if (existsSync(sidecar) && statSync(sidecar).size > 0) remaining.push(sidecar);
      } catch (error) {
        // The last connection may remove the sidecar between the existence
        // probe and stat; that transition is the successful quiescence edge.
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return remaining;
}

async function awaitPublishedStoreSidecarsGone(paths = [], { timeoutMs = 30_000 } = {}) {
  // SQLite removes its WAL/SHM files after the last connection closes, but a
  // concurrent creator can still be in that final close window.  Yield to the
  // event loop and re-check the observable condition; never delete a sidecar
  // owned by another process.  The bound is only a liveness guard for an
  // actually-held connection, not a blind sleep used as synchronization.
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = meaningfulStoreSidecars(paths);
    if (!remaining.length) return;
    if (Date.now() >= deadline) {
      throw new Error(`quality published store sidecar barrier timed out: ${remaining.join(', ')}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * The parent/coordinator acknowledgement boundary may wait for all published
 * stores after every child context has joined.  A child context must never
 * call this while another legitimate owner still has the same final store
 * open: doing so creates a close/close cycle between sibling creators.
 */
export async function awaitQualityPublishedStoreSidecarsGone(paths = [], options = {}) {
  return await awaitPublishedStoreSidecarsGone(paths, options);
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

const RELEASE_PROFILE_KEYS = Object.freeze(['cognitionFast', 'cognitionDeep', 'expression', 'supervisor']);

function parseReleaseModelProfile(modelProfile, label = 'release model profile') {
  if (!modelProfile || typeof modelProfile !== 'object' || Array.isArray(modelProfile)
    || Object.keys(modelProfile).sort().join(',') !== [...RELEASE_PROFILE_KEYS].sort().join(',')) {
    throw new Error(`${label} closed shape conflict`);
  }
  const parsed = {};
  for (const key of RELEASE_PROFILE_KEYS) {
    const value = modelProfile[key];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} ${key} conflict`);
    const separator = value.lastIndexOf('/');
    if (separator <= 0 || separator === value.length - 1) throw new Error(`${label} ${key} must be model/effort`);
    const model = value.slice(0, separator).trim();
    const effort = value.slice(separator + 1).trim();
    if (!model || !['low', 'medium', 'high'].includes(effort)) {
      throw new Error(`${label} ${key} effort conflict`);
    }
    parsed[key] = Object.freeze({ model, effort });
  }
  return Object.freeze(parsed);
}

function assertProductionRoleSchema(role, schema, { cognitionVersion = 3, expressionVersion = 3 } = {}) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('production role output schema is required');
  }
  const schemaHash = contentHash(schema);
  const accepted = role === 'memory'
    ? [contentHash(cognitionVersion === 2 ? COGNITION_SCHEMA_V2 : COGNITION_SCHEMA_V3),
      contentHash(ROLE_OUTPUT_SCHEMAS.memory)]
    : role === 'brain'
      ? [contentHash(expressionVersion === 2 ? EXPRESSION_SCHEMA_V2 : EXPRESSION_SCHEMA_V3),
        contentHash(ROLE_OUTPUT_SCHEMAS.brain)]
      : role === 'supervisor'
        ? [contentHash(ROLE_OUTPUT_SCHEMAS.supervisor)] : [];
  if (accepted.includes(schemaHash)) return true;
  // The v3 fast route is the only production wrapper schema not exported by
  // role-schemas. Validate its closed route envelope without recreating it.
  if (role === 'memory' && cognitionVersion === 3
    && schema.type === 'object' && schema.additionalProperties === false
    && Array.isArray(schema.required)
    && schema.required.length === 2
    && schema.required.includes('routeDecision')
    && schema.required.includes('cognitionResult')
    && schema.properties?.routeDecision?.enum?.join(',') === 'fast,deep') return true;
  throw new Error('production role output schema conflict');
}

export function releaseExecutionProfileFromRelease(release) {
  if (!release || typeof release !== 'object' || !release.releaseId || !release.releaseChecksum) {
    throw new Error('quality release execution profile release identity required');
  }
  const parsed = parseReleaseModelProfile(release.modelProfile);
  const profiles = Object.freeze({
    cognitionFast: Object.freeze({ ...parsed.cognitionFast, outputSchema: `cognition-v${release.cognitionSchemaVersion}` }),
    cognitionDeep: Object.freeze({ ...parsed.cognitionDeep, outputSchema: `cognition-v${release.cognitionSchemaVersion}` }),
    expression: Object.freeze({ ...parsed.expression, outputSchema: `expression-v${release.expressionSchemaVersion}` }),
    supervisor: Object.freeze({ ...parsed.supervisor, outputSchema: `supervisor-v${release.evaluatorVersion}` }),
  });
  const body = { version: 1, releaseId: release.releaseId, releaseChecksum: release.releaseChecksum, profiles };
  return Object.freeze({ ...body, checksum: contentHash(body) });
}

class ReleaseProfileClient {
  constructor(underlying, release, lane = null) {
    this.underlying = underlying;
    this.release = release;
    this.executionProfile = releaseExecutionProfileFromRelease(release);
    this.profiles = this.executionProfile.profiles;
    this.lane = lane;
    this.turnTimeoutMs = underlying.turnTimeoutMs;
  }

  ensureThread(...args) { return this.underlying.ensureThread(...args); }
  readThread(...args) { return this.underlying.readThread(...args); }
  start(...args) { return this.underlying.start?.(...args); }
  stop(...args) { return this.underlying.stop?.(...args); }

  resolveRequestOptions(role, input, options = {}) {
    const parsedInput = typeof input === 'string' ? (() => {
      try { return JSON.parse(input); } catch { return {}; }
    })() : (input || {});
    const task = String(parsedInput.task || options.task || '');
    const memoryKeys = ['cognitionFast', 'cognitionDeep'];
    const key = role === 'memory'
      ? ((task.includes('deep') || task.includes('reconsider'))
        ? 'cognitionDeep'
        : (memoryKeys.find(candidate => options.model !== undefined
            && options.effort !== undefined
            && this.profiles[candidate].model === options.model
            && this.profiles[candidate].effort === options.effort)
          || 'cognitionFast'))
      : role === 'brain' ? 'expression'
        : role === 'supervisor' ? 'supervisor' : null;
    if (!key) throw new Error('release request role conflict');
    const profile = this.profiles[key];
    // CognitivePipeline supplies its historical defaults (and may select a
    // route before the release is known).  The branded release wrapper is the
    // authority for the actual production request, so it validates the role
    // schema above and injects the persisted release profile here rather than
    // treating a pipeline default as a drift failure.
    if (!options.outputSchema || typeof options.outputSchema !== 'object'
      || Array.isArray(options.outputSchema)
      || contentHash(options.outputSchema) === contentHash(QUALITY_BLIND_EVALUATION_SCHEMA)) {
      throw new Error('blind evaluator schema is not a production role schema');
    }
    assertProductionRoleSchema(role, options.outputSchema, {
      cognitionVersion: Number(this.release.cognitionSchemaVersion || 3),
      expressionVersion: Number(this.release.expressionSchemaVersion || 3),
    });
    return { ...options, model: profile.model, effort: profile.effort };
  }

  runTurn(role, input, options = {}) {
    return this.underlying.runTurn(role, input, this.resolveRequestOptions(role, input, options));
  }

  runRole(role, input, options = {}) { return this.runTurn(role, input, options); }
}

export function createReleaseProfileClient({ underlying, release, lane = null } = {}) {
  if (!underlying || typeof underlying.runTurn !== 'function') {
    throw new Error('release profile client underlying transport required');
  }
  return new ReleaseProfileClient(underlying, release, lane);
}

export function requestProfileFromRelease(release, lane) {
  if (!release || !['stable_execution', 'candidate_execution'].includes(lane)) {
    throw new Error('quality release request profile input conflict');
  }
  const parsed = parseReleaseModelProfile(release.modelProfile);
  const profile = {
    ...parsed.cognitionFast,
    outputSchema: `cognition-v${release.cognitionSchemaVersion ?? 3}`,
  };
  const body = Object.freeze({ model: profile.model, effort: profile.effort, outputSchema: profile.outputSchema });
  return Object.freeze({ ...body, checksum: contentHash(body) });
}

function rereadPreparedAuthority(context, binding) {
  if (context.productionAuthorityFingerprint
    && captureProductionAuthorityFingerprint(context) !== context.productionAuthorityFingerprint) {
    throw new Error('quality production authority drift before model call');
  }
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

function captureProductionAuthorityFingerprint(context) {
  const config = context.config || {};
  const prepared = context.prepared || {};
  const verified = config.verifiedInputPaths;
  const sha256Bytes = value => createHash('sha256').update(readFileSync(value)).digest('hex');
  if (config.verifiedSourceRoot) {
    assertCleanQualitySourceIdentity({ sourceRootDir: config.verifiedSourceRoot, expectedHead: config.sourceHead });
  }
  const sourceSeedSha256 = verified?.seedDatabasePath
    ? sha256Bytes(verified.seedDatabasePath)
    : config.productionMaterials?.seedDatabaseSha256 || null;
  const inputBytes = verified ? {
    plan: sha256Bytes(verified.planPath),
    materials: sha256Bytes(verified.materialsPath),
    seedDatabase: sourceSeedSha256,
  } : null;
  if (inputBytes && contentHash(inputBytes) !== contentHash(config.inputArtifactChecksums || {})) {
    throw new Error('quality production input artifact drift before model call');
  }
  // Use the deterministic authority paths, not SQLite's mutable filename
  // property.  In particular, an open better-sqlite3 connection may expose a
  // normalized/URI filename that does not byte-for-byte match the path used
  // in the expected manifest.  The path-to-open-store map is populated only
  // after each store has passed the expected-manifest validator.
  const storePaths = Object.keys(context.expectedStoreManifests || {}).length
    ? Object.keys(context.expectedStoreManifests)
    : [
      prepared.seedWorkingPath,
      prepared.stableStore?.filename,
      prepared.candidateStore?.filename,
      prepared.evaluatorStores?.primary?.filename,
      prepared.evaluatorStores?.secondary?.filename,
    ].filter(Boolean);
  const openStores = context.openStoreManifestStores || new Map([
    [prepared.stableStore?.filename && resolve(prepared.stableStore.filename), prepared.stableStore],
    [prepared.candidateStore?.filename && resolve(prepared.candidateStore.filename), prepared.candidateStore],
    [prepared.evaluatorStores?.primary?.filename && resolve(prepared.evaluatorStores.primary.filename), prepared.evaluatorStores?.primary],
    [prepared.evaluatorStores?.secondary?.filename && resolve(prepared.evaluatorStores.secondary.filename), prepared.evaluatorStores?.secondary],
  ].filter(([path]) => path));
  const manifests = storePaths.map(path => {
    const openStore = openStores instanceof Map
      ? openStores.get(String(path)) || openStores.get(resolve(String(path)))
      : openStores[String(path)] || openStores[resolve(String(path))];
    const actual = openStore
      ? readManifestFromOpenStore(openStore)
      : readQualityProductionStoreManifest(path);
    const expected = context.expectedStoreManifests?.[String(path)];
    if (!expected || contentHash(actual) !== contentHash(expected)) {
      throw new Error('quality production store manifest authority drift before model call');
    }
    return { path: String(path), manifest: actual };
  });
  return contentHash({
    sourceHead: config.sourceHead,
    planChecksum: config.planChecksum,
    inputArtifactChecksums: config.inputArtifactChecksums || null,
    inputBytes,
    sourceSeedSha256,
    stableRelease: config.stableRelease,
    candidateRelease: config.candidateRelease,
    manifests,
  });
}

function assertProductionInputAuthority(config) {
  const paths = QUALITY_PRODUCTION_INPUT_PATHS.get(config);
  if (!paths) throw new Error('quality production input paths are not branded');
  const expected = config.inputArtifactChecksums;
  const actual = {
    plan: createHash('sha256').update(readFileSync(paths.planPath)).digest('hex'),
    materials: createHash('sha256').update(readFileSync(paths.materialsPath)).digest('hex'),
    seedDatabase: createHash('sha256').update(readFileSync(paths.seedDatabasePath)).digest('hex'),
  };
  if (contentHash(actual) !== contentHash(expected)) {
    throw new Error('quality production input artifact drift before client');
  }
  const root = QUALITY_PRODUCTION_SOURCE_ROOTS.get(config);
  if (!root) throw new Error('quality production source root is not branded');
  assertCleanQualitySourceIdentity({ sourceRootDir: root, expectedHead: config.sourceHead });
  const state = QUALITY_PRODUCTION_CONFIG_STATE.get(config);
  const sourceDatabases = [
    state?.materials?.seedDatabasePath,
    state?.materials?.stableDatabasePath,
    state?.materials?.candidateDatabasePath,
  ].filter(Boolean);
  for (const databasePath of sourceDatabases) {
    const database = openImmutableReadOnly(databasePath);
    try {
      const version = Number(database.prepare('PRAGMA user_version').get().user_version);
      const quickCheck = String(database.prepare('PRAGMA quick_check').get().quick_check || '');
      if (version !== 15 || quickCheck !== 'ok') {
        throw new Error('quality production source database identity drift');
      }
    } finally {
      database.close();
    }
  }
  const seedDatabase = openImmutableReadOnly(state.materials.seedDatabasePath);
  try {
    for (const release of [config.stableRelease, config.candidateRelease]) {
      const row = seedDatabase.prepare(
        'SELECT release_id,release_checksum,component_manifest_json FROM pipeline_releases WHERE release_id=?'
      ).get(release.releaseId);
      if (!row || row.release_checksum !== release.releaseChecksum) {
        throw new Error('quality production source release identity drift');
      }
      let manifest;
      try { manifest = JSON.parse(row.component_manifest_json); }
      catch { throw new Error('quality production source release manifest drift'); }
      if (contentHash(manifest) !== contentHash(release.componentManifest)) {
        throw new Error('quality production source release manifest drift');
      }
    }
  } finally {
    seedDatabase.close();
  }
}

export function assertQualityProductionInputAuthority(runAuthority) {
  assertQualityRunAuthority(runAuthority);
  assertProductionInputAuthority(qualityRunAuthorityProductionConfig(runAuthority));
  return true;
}

export function createQualityProductionContext(config = {}) {
  assertRunIdentity(config);
  const internalProduction = config[INTERNAL_PRODUCTION_CONTEXT_TOKEN] === true;
  if (!internalProduction && config.evidenceEligible === true) {
    throw new Error('external quality context is always ineligible');
  }
  const effectiveEvidenceEligible = internalProduction && config.evidenceEligible === true;
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
    config: { ...config, sourceHead, stableRelease, candidateRelease, evidenceEligible: effectiveEvidenceEligible },
    seedStore,
    seedRuntime,
    phase: 'seed',
    prepared: null,
    ownedStores: new Set(seedStore ? [seedStore] : []),
    // Production lane clients own child app-server processes. Keep them
    // private to the context so close tears down every wire process without
    // touching published SQLite stores.
    ownedClients: new Set(),
    phaseClients: new Map(),
    // Internal publication evidence is derived only from the no-overwrite
    // primitive above; callers cannot inject or select the result.
    publicationResults: new Map(),
    cleanupErrors: [],
  };
  const finishStoresAndTemps = () => {
    const errors = [];
    for (const store of context.ownedStores) {
      try { closeStore(store); }
      catch (error) { errors.push(`store: ${error?.message || String(error)}`); }
    }
    for (const path of context.config.unpublishedTempPaths || []) {
      try { rmSync(path, { recursive: true, force: true }); }
      catch (error) { errors.push(`${path}: ${error?.message || String(error)}`); }
    }
    return errors;
  };
  context.close = () => {
    if (context.phase === 'closed') return;
    if (context.ownedClients.size) {
      throw new Error('quality context closeAsync required while clients are running');
    }
    const cleanupErrors = finishStoresAndTemps();
    context.cleanupErrors = cleanupErrors;
    context.phase = 'closed';
    if (cleanupErrors.length) {
      const error = new Error(`quality temporary cleanup failed: ${cleanupErrors.join('; ')}`);
      error.cleanupErrors = cleanupErrors;
      throw error;
    }
  };
  // Production callers must await every child process before stores or
  // temporary roots are closed.  This is the sole cleanup owner for contexts
  // that have ever bound a real lane client; it aggregates stop, store, and
  // temp errors without allowing a later close() to overwrite them.
  context.closeAsync = async () => {
    if (context.phase === 'closed') {
      if (context.cleanupErrors?.length) {
        const error = new Error(`quality cleanup failed: ${context.cleanupErrors.join('; ')}`);
        error.cleanupErrors = [...context.cleanupErrors];
        throw error;
      }
      return;
    }
    const cleanupErrors = [];
    for (const client of [...context.ownedClients]) {
      try { await client?.stop?.(); }
      catch (error) { cleanupErrors.push(`client: ${error?.message || String(error)}`); }
      context.ownedClients.delete(client);
    }
    // Only this context's clients, stores, and unpublished scratch are owned
    // here.  Published final sidecars may belong to another legal creator;
    // the parent/coordinator waits for the global barrier after all children
    // have joined, never from an individual close.
    cleanupErrors.push(...finishStoresAndTemps());
    context.cleanupErrors = cleanupErrors;
    context.phase = 'closed';
    if (cleanupErrors.length) {
      const error = new Error(`quality cleanup failed: ${cleanupErrors.join('; ')}`);
      error.cleanupErrors = [...cleanupErrors];
      throw error;
    }
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
  const seedWorkingPath = config.seedWorkingDatabasePath || `${seedPath}.seed-working.sqlite`;
  const manifestBase = {
    version: 1, runId: config.runId, finalKey: config.finalKey,
    sourceHead: config.sourceHead, planChecksum: config.planChecksum,
    createdAt: config.createdAt || Date.now(),
    planArtifactSha256: config.inputArtifactChecksums?.plan || null,
    materialsChecksum: config.inputArtifactChecksums?.materials || null,
    seedDatabaseSha256: config.inputArtifactChecksums?.seedDatabase || null,
  };
  const manifestFor = (lane, extra = {}) => {
    const body = { ...manifestBase, lane, ...extra };
    return { ...body, manifestChecksum: contentHash(body) };
  };
  const stableRequestProfile = (() => {
    try { return requestProfileFromRelease(config.stableRelease, 'stable_execution'); }
    catch { return null; }
  })();
  const candidateRequestProfile = (() => {
    try { return requestProfileFromRelease(config.candidateRelease, 'candidate_execution'); }
    catch { return null; }
  })();
  const expectedStoreManifests = {};
  const expectedManifest = (path, lane, extra = {}) => {
    const manifest = manifestFor(lane, extra);
    expectedStoreManifests[String(path)] = manifest;
    return manifest;
  };
  const seedWorkingManifest = expectedManifest(seedWorkingPath, 'seedWorking', {
    immutableSeedSourceSha256: config.inputArtifactChecksums?.seedDatabase || null,
  });
  ensureStoreManifestRow(context.seedStore, seedWorkingManifest);
  closeStore(context.seedStore);
  context.seedStore = null;
  context.seedRuntime = null;
  const seedWorkingExisted = existsSync(seedWorkingPath);
  // A crash can leave a verified-looking temp even when the deterministic
  // destination was never linked.  Clean only this destination's sibling
  // temps before any new publish attempt; never repair an existing final.
  clearInterruptedPublishTemps(seedWorkingPath);
  const seedWorkingCreated = seedWorkingExisted
    ? false
    : publishStoreClone(seedPath, seedWorkingPath, seedWorkingManifest);
  context.publicationResults.set(String(seedWorkingPath), seedWorkingCreated === true);
  verifyPublishedStore(seedWorkingPath, seedWorkingManifest);
  const cloneSourcePath = seedWorkingPath;
  const stablePath = config.stableDatabasePath;
  const candidatePath = config.candidateDatabasePath;
  const evaluatorPrimaryPath = config.evaluatorPrimaryDatabasePath || `${stablePath}.evaluator-primary.sqlite`;
  const evaluatorSecondaryPath = config.evaluatorSecondaryDatabasePath || `${stablePath}.evaluator-secondary.sqlite`;
  let stableStore = config.stableStore || null;
  let candidateStore = config.candidateStore || null;
  if (!stableStore && stablePath && cloneSourcePath) {
    const manifest = expectedManifest(stablePath, 'stable_execution', {
      releaseId: config.stableRelease.releaseId,
      releaseChecksum: config.stableRelease.releaseChecksum,
      sessionNamespace: config.productionMaterials?.clientConfigs?.stable_execution?.sessionNamespace || null,
      clientConfigChecksum: config.productionMaterials?.clientConfigChecksums?.stable_execution || null,
      requestProfile: stableRequestProfile,
      outputSchema: stableRequestProfile?.outputSchema || null,
    });
    stableStore = await openOrPublishExpectedStore({
      sourcePath: cloneSourcePath, destinationPath: stablePath, manifest, createStore: config.createStore,
      publicationResults: context.publicationResults,
    });
    context.ownedStores.add(stableStore);
  }
  if (!candidateStore && candidatePath && cloneSourcePath) {
    const manifest = expectedManifest(candidatePath, 'candidate_execution', {
      releaseId: config.candidateRelease.releaseId,
      releaseChecksum: config.candidateRelease.releaseChecksum,
      sessionNamespace: config.productionMaterials?.clientConfigs?.candidate_execution?.sessionNamespace || null,
      clientConfigChecksum: config.productionMaterials?.clientConfigChecksums?.candidate_execution || null,
      requestProfile: candidateRequestProfile,
      outputSchema: candidateRequestProfile?.outputSchema || null,
    });
    candidateStore = await openOrPublishExpectedStore({
      sourcePath: cloneSourcePath, destinationPath: candidatePath, manifest, createStore: config.createStore,
      publicationResults: context.publicationResults,
    });
    context.ownedStores.add(candidateStore);
  }
  if (!stableStore || !candidateStore) throw new Error('independent stable/candidate stores are required');
  const evaluatorPrimaryManifest = expectedManifest(evaluatorPrimaryPath, 'evaluator_primary', {
      evaluatorProfile: config.productionMaterials?.clientConfigs?.evaluator_primary?.modelProfile || null,
      sessionNamespace: config.productionMaterials?.clientConfigs?.evaluator_primary?.sessionNamespace || null,
      clientConfigChecksum: config.productionMaterials?.clientConfigChecksums?.evaluator_primary || null,
      outputSchema: config.productionMaterials?.clientConfigs?.evaluator_primary?.schema || null,
    });
  const evaluatorSecondaryManifest = expectedManifest(evaluatorSecondaryPath, 'evaluator_secondary', {
      evaluatorProfile: config.productionMaterials?.clientConfigs?.evaluator_secondary?.modelProfile || null,
      sessionNamespace: config.productionMaterials?.clientConfigs?.evaluator_secondary?.sessionNamespace || null,
      clientConfigChecksum: config.productionMaterials?.clientConfigChecksums?.evaluator_secondary || null,
      outputSchema: config.productionMaterials?.clientConfigs?.evaluator_secondary?.schema || null,
    });
  const evaluatorPrimaryStore = await openOrPublishExpectedStore({
    sourcePath: cloneSourcePath, destinationPath: evaluatorPrimaryPath,
    manifest: evaluatorPrimaryManifest, createStore: config.createStore,
    publicationResults: context.publicationResults,
  });
  context.ownedStores.add(evaluatorPrimaryStore);
  const evaluatorSecondaryStore = await openOrPublishExpectedStore({
    sourcePath: cloneSourcePath, destinationPath: evaluatorSecondaryPath,
    manifest: evaluatorSecondaryManifest, createStore: config.createStore,
    publicationResults: context.publicationResults,
  });
  context.ownedStores.add(evaluatorSecondaryStore);
  context.evaluatorStores = { primary: evaluatorPrimaryStore, secondary: evaluatorSecondaryStore };
  context.expectedStoreManifests = Object.freeze(expectedStoreManifests);
  context.openStoreManifestStores = Object.freeze({
    [String(stablePath)]: stableStore,
    [String(candidatePath)]: candidateStore,
    [String(evaluatorPrimaryPath)]: evaluatorPrimaryStore,
    [String(evaluatorSecondaryPath)]: evaluatorSecondaryStore,
  });
  assertV15Store(stableStore, 'stable');
  assertV15Store(candidateStore, 'candidate');
  if (stableStore === candidateStore
    || (stableStore.filename && candidateStore.filename
      && String(stableStore.filename) === String(candidateStore.filename))) {
    throw new Error('stable and candidate stores must be independent');
  }
  if (config.candidateRelease) installCandidateRelease(candidateStore, config.candidateRelease);
  const stableProductionInput = config.productionMaterials
    ? createProductionRuntimeInput({
      store: stableStore, side: 'stable', sourceHead: config.sourceHead,
      release: config.stableRelease, materials: config.productionMaterials,
    }) : null;
  const candidateProductionInput = config.productionMaterials
    ? createProductionRuntimeInput({
      store: candidateStore, side: 'candidate', sourceHead: config.sourceHead,
      release: config.candidateRelease, materials: config.productionMaterials,
    }) : null;
  if (stableProductionInput) stableProductionInput.qualityPhaseClientSlot = config.stablePhaseClientSlot;
  if (candidateProductionInput) candidateProductionInput.qualityPhaseClientSlot = config.candidatePhaseClientSlot;
  const stableRuntime = runtimeFor({
    runtime: config.stableRuntime,
    runtimeFactory: config.runtimeFactory,
    store: stableStore,
    side: 'stable',
    sourceHead: config.sourceHead,
    runtimeInput: {
      ...(config.runtimeInputs?.stable || stableProductionInput || config.runtimeInput || {}),
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
      ...(config.runtimeInputs?.candidate || candidateProductionInput || config.runtimeInput || {}),
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
    evaluatorStores: context.evaluatorStores,
    stableRuntime,
    candidateRuntime,
    execution,
    candidateExecution,
    stableRelease: config.stableRelease,
    candidateRelease: config.candidateRelease,
    semanticInputChecksum: subject.semanticInputChecksum,
    seedWorkingPath,
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
  context.persistProductionStores = true;
  context.productionAuthorityFingerprint = captureProductionAuthorityFingerprint(context);
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
  if (!qualityPhaseClientSlotIsBound(options.phaseClientSlot)) {
    bindQualityPhaseClientSlot(options.phaseClientSlot, phaseBinding);
  } else {
    assertQualityPhaseClientSlotBinding(options.phaseClientSlot, phaseBinding);
  }
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
  try {
    const value = await runtime.releaseExecutor[expectedMethod](call);
    // A model call may race a release/turn/LIFE mutation.  The result is never
    // accepted as phase evidence unless the complete authority rereads cleanly.
    rereadPreparedAuthority(context, binding);
    if ((side === 'stable' ? context.config.stablePhaseClientSlot : context.config.candidatePhaseClientSlot)
      !== options.phaseClientSlot) {
      throw new Error('quality phase slot authority changed');
    }
    return { [side]: value, authorityId: binding.authorityId };
  } finally {
    // A lane execution owns exactly one Codex app-server process.  Await its
    // shutdown before the caller can close stores or remove the scratch root.
    const client = context.phaseClients?.get(side);
    if (client) {
      await client.stop?.();
      context.phaseClients.delete(side);
      context.ownedClients?.delete(client);
    }
  }
}

export async function executeQualityEvaluatorSide(config, {
  side, role = 'brain', input, phaseInput, ledger, evaluatorStore = null,
  storeManifestAuthority = null, storeManifestStores = null, options = {}
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
  assertProductionInputAuthority(config);
  if (storeManifestAuthority) {
    for (const [path, expected] of Object.entries(storeManifestAuthority)) {
      const openStore = storeManifestStores?.[path] || storeManifestStores?.[resolve(path)];
      const actual = openStore ? readManifestFromOpenStore(openStore) : readQualityProductionStoreManifest(path);
      if (contentHash(actual) !== contentHash(expected)) {
        throw new Error('quality evaluator store manifest authority drift');
      }
    }
  }
  const expectedPhase = side === 'primary' ? 'evaluator_primary' : 'evaluator_secondary';
  if (phaseInput.phase !== expectedPhase || phaseInput.runId !== config.runId) {
    throw new Error('quality evaluator phase identity conflict');
  }
  const persistedPhase = ledger.getPhase(phaseInput);
  const persistedCalls = ledger.listModelCalls({
    runId: phaseInput.runId, finalKey: phaseInput.finalKey, phase: phaseInput.phase,
  });
  if (persistedPhase?.state === 'succeeded') {
    if (!persistedCalls.length || persistedCalls.some(call => call.state !== 'succeeded')) {
      throw new Error('quality evaluator succeeded replay ownership conflict');
    }
    return persistedPhase.output;
  }
  if (persistedPhase?.state === 'failed' || persistedPhase?.state === 'uncertain') {
    throw new Error('quality evaluator terminal phase cannot be replayed');
  }
  if (persistedPhase?.state !== 'running') {
    throw new Error('quality evaluator phase is not running');
  }
  const clientConfig = state.materials.clientConfigs[expectedPhase];
  const evaluatorProfile = clientConfig?.modelProfile;
  if (typeof evaluatorProfile !== 'string' || !evaluatorProfile.includes('/')) {
    throw new Error('quality evaluator model profile is not model/effort');
  }
  const separator = evaluatorProfile.lastIndexOf('/');
  const model = evaluatorProfile.slice(0, separator);
  const effort = evaluatorProfile.slice(separator + 1);
  if (!model || !['low', 'medium', 'high'].includes(effort)) {
    throw new Error('quality evaluator model profile is invalid');
  }
  const underlying = new CodexAppServerClient({ ...clientConfig, ...(evaluatorStore ? { store: evaluatorStore } : {}) });
  const owner = new LedgerBackedModelClient({ ledger, underlying, runId: config.runId });
  const phaseClient = owner.forPhase(phaseInput);
  try {
    return await phaseClient.runTurn('brain', input, {
      ...options, model, effort, outputSchema: QUALITY_BLIND_EVALUATION_SCHEMA,
    });
  } finally {
    await underlying.stop?.();
  }
}
