import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, realpathSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { DatabaseSync } from 'node:sqlite';
import { assertVerifiedQualityReplayPlan } from '../yuqi-runtime/src/quality-replay.mjs';
import {
  createQualityProductionExecutionAuthority,
  assertQualityRunAuthority,
  requestProfileFromRelease,
  assertPrivateNoFollowPath,
} from '../yuqi-runtime/src/quality-replay-production-bridge.mjs';

const PRIVATE_ROOT = 'artifacts/yuqi-lived-agency-v3/private';
const MATERIAL_FILE = join(PRIVATE_ROOT, 'quality-production-config.json');
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SHA40 = /^[0-9a-f]{40}$/;
const TRACKED_PLAN_CHECKSUM = 'dc704d836d1b0224f0202b5771f38334292df90eaedd7c8f8880c7c3bb89243c';
const RELEASE_KEYS = Object.freeze([
  'releaseId', 'pipelineVersion', 'presetVersion', 'cognitionSchemaVersion',
  'expressionSchemaVersion', 'evaluatorVersion', 'modelProfile', 'componentManifest',
  'releaseChecksum', 'createdAt', 'retiredAt',
]);
const RELEASE_BASIS_KEYS = Object.freeze(RELEASE_KEYS.filter(key => !['releaseId', 'releaseChecksum', 'retiredAt'].includes(key)));
const LANE_KEYS = Object.freeze([
  'version', 'lane', 'command', 'args', 'cwd', 'env', 'clientInfo',
  'requestTimeoutMs', 'turnTimeoutMs', 'maxRoleTurns', 'sessionStorePath',
  'sessionNamespace', 'modelProfile', 'approvalPolicy', 'sandbox', 'schema',
]);
const MATERIAL_KEYS = Object.freeze([
  'version', 'sourceHead', 'runtimeConfig', 'stableRelease', 'candidateRelease',
  'lanes', 'stableRuntime', 'candidateRuntime', 'seedDatabasePath',
  'stableDatabasePath', 'candidateDatabasePath', 'seedDatabaseSha256',
]);
const LANE_NAMES = Object.freeze([
  'stable_execution', 'candidate_execution', 'evaluator_primary', 'evaluator_secondary',
]);
const AUTHORITY_KEYS = Object.freeze([
  'version', 'runId', 'finalKeys', 'planChecksum', 'sourceHead', 'stableRelease',
  'candidateRelease', 'attestation', 'attestationChecksum', 'artifactPaths',
  'createdAt', 'evidenceEligible',
]);

function ownKeys(value) {
  return Object.keys(value).sort().join(',');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ownKeys(value) !== [...keys].sort().join(',')) {
    throw new Error(`${label} closed shape conflict`);
  }
}

function rejectOperationalObjects(value, path = 'value', seen = new Set()) {
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`${path} operational object conflict`);
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) throw new Error(`${path} cycle conflict`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const manifestDataKey = path.endsWith('.componentManifest') || path.endsWith('.stableRuntime') || path.endsWith('.candidateRuntime');
    if (!manifestDataKey && ['runtime', 'runtimeFactory', 'client', 'store', 'slot', 'executor', 'callback', 'createStore'].includes(key)) {
      throw new Error(`${path}.${key} operational injection forbidden`);
    }
    rejectOperationalObjects(child, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sourceIdentity(rootDir) {
  const cwd = realpathSync(rootDir);
  const privateRoot = assertPrivateEvidenceRoot(cwd);
  let status;
  let head;
  try {
    status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd, encoding: 'utf8', windowsHide: true,
    });
    head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd, encoding: 'utf8', windowsHide: true,
    }).trim().toLowerCase();
    try {
      execFileSync('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        cwd, encoding: 'utf8', windowsHide: true,
      });
      throw new Error('quality source checkout must be detached');
    } catch (branchError) {
      if (branchError?.status !== 1 && branchError?.message !== 'quality source checkout must be detached') throw branchError;
      if (branchError?.message === 'quality source checkout must be detached') throw branchError;
    }
  } catch (error) {
    const text = String(error?.stdout || '').trim();
    if (text || error?.status !== 1) throw new Error('quality source checkout unavailable');
    // A detached HEAD is expected; status/head were already captured above.
  }
  if (!SHA40.test(head)) throw new Error('quality source HEAD conflict');
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const code = line.slice(0, 2);
    const listed = line.slice(3).replaceAll('\\', '/');
    if (code === '??' && listed.startsWith(`${PRIVATE_ROOT}/`)) {
      const absolute = resolve(cwd, listed);
      const real = existsSync(absolute) ? realpathSync(absolute) : absolute;
      const relativePrivate = relative(privateRoot, real);
      if (!relativePrivate || relativePrivate.startsWith('..') || relativePrivate.includes(':')
        || !isIgnoredPath(cwd, listed)) {
        throw new Error('quality private evidence scope conflict');
      }
      continue;
    }
    if (line.trim()) throw new Error('quality source tree is dirty');
  }
  return { rootDir: cwd, sourceHead: head };
}

function isIgnoredPath(rootDir, relativePath) {
  try {
    execFileSync('git', ['check-ignore', '--no-index', '--quiet', '--', relativePath], {
      cwd: rootDir, windowsHide: true,
    });
    return true;
  } catch { return false; }
}

function assertPrivateEvidenceRoot(rootDir) {
  const root = realpathSync(rootDir);
  const absolute = resolve(root, PRIVATE_ROOT);
  if (!existsSync(absolute)) throw new Error('quality private artifact root unavailable');
  let cursor = root;
  for (const part of PRIVATE_ROOT.split('/')) {
    cursor = join(cursor, part);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || stat.isJunction?.()) {
      throw new Error('quality private artifact root link conflict');
    }
  }
  const real = realpathSync(absolute);
  const containment = relative(root, real);
  if (!containment || containment.startsWith('..') || containment.includes(':')) {
    throw new Error('quality private artifact root containment conflict');
  }
  if (!isIgnoredPath(root, `${PRIVATE_ROOT}/`)) {
    // Git may only match the directory after a concrete child exists; the
    // concrete manifest is checked below, so do not treat this as evidence of
    // an ignored scope on its own.
    if (!isIgnoredPath(root, MATERIAL_FILE)) {
      throw new Error('quality private artifact root must be ignored');
    }
  }
  return real;
}

function privatePath(rootDir, value, label) {
  if (typeof value !== 'string' || !value || isAbsolute(value)
    || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`${label} path conflict`);
  }
  const root = realpathSync(rootDir);
  const privateRoot = resolve(root, PRIVATE_ROOT);
  if (!existsSync(privateRoot) || lstatSync(privateRoot).isSymbolicLink()
    || lstatSync(privateRoot).isJunction?.()) {
    throw new Error('quality private artifact root unavailable');
  }
  const absolute = resolve(root, value);
  // Use the bridge-owned no-follow checker for every path, including missing
  // tails.  This closes the ancestor-junction gap that a final-component-only
  // lstat cannot see.
  assertPrivateNoFollowPath(root, absolute, label);
  const rel = relative(privateRoot, absolute);
  if (!rel || rel.startsWith('..') || rel.includes(':')) throw new Error(`${label} private containment conflict`);
  let cursor = privateRoot;
  for (const part of rel.split(/[\\/]/)) {
    cursor = join(cursor, part);
    if (existsSync(cursor) && (lstatSync(cursor).isSymbolicLink() || lstatSync(cursor).isJunction?.())) {
      throw new Error(`${label} symlink conflict`);
    }
  }
  return { relative: relative(root, absolute).replaceAll('\\', '/'), absolute };
}

function validatePlan(rootDir, plan, planPath) {
  rejectOperationalObjects(plan, 'plan');
  const verified = assertVerifiedQualityReplayPlan(plan);
  if (verified.planChecksum !== TRACKED_PLAN_CHECKSUM || verified.items.length !== 246) {
    throw new Error('quality replay plan authority conflict');
  }
  const finalKeys = verified.items.map(item => {
    if (!item || typeof item !== 'object' || typeof item.layer !== 'string'
      || typeof item.sceneId !== 'string' || !Number.isSafeInteger(item.repeatIndex) || item.repeatIndex < 0) {
      throw new Error('quality replay plan item conflict');
    }
    return `${item.layer}:${item.sceneId}:${item.repeatIndex}`;
  });
  if (new Set(finalKeys).size !== finalKeys.length) throw new Error('quality replay plan final key conflict');
  const bytes = readFileSync(planPath.absolute);
  let persisted;
  try { persisted = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('quality replay plan JSON conflict'); }
  if (canonicalJson(persisted) !== canonicalJson(verified)
    || persisted.planChecksum !== verified.planChecksum) {
    throw new Error('quality replay plan bytes/checksum conflict');
  }
  return { finalKeys, planChecksum: verified.planChecksum, planSha256: sha256Bytes(bytes) };
}

function validateRelease(value, label) {
  exactKeys(value, RELEASE_KEYS, label);
  rejectOperationalObjects(value, label);
  for (const key of RELEASE_BASIS_KEYS.filter(key => !['componentManifest', 'createdAt', 'modelProfile'].includes(key))) {
    if (['cognitionSchemaVersion', 'expressionSchemaVersion'].includes(key)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new Error(`${label} ${key} conflict`);
    } else if (typeof value[key] !== 'string' || !value[key]) throw new Error(`${label} ${key} conflict`);
  }
  if (!value.componentManifest || typeof value.componentManifest !== 'object' || Array.isArray(value.componentManifest)
    || !value.modelProfile || typeof value.modelProfile !== 'object' || Array.isArray(value.modelProfile)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || (value.retiredAt !== null && (!Number.isSafeInteger(value.retiredAt) || value.retiredAt < value.createdAt))) {
    throw new Error(`${label} native field conflict`);
  }
  if (!SHA256.test(value.releaseChecksum)) throw new Error(`${label} checksum shape conflict`);
  requestProfileFromRelease(value, label.toLowerCase().includes('candidate')
    ? 'candidate_execution' : 'stable_execution');
  return Object.freeze(structuredClone(value));
}

function validateLane(value, laneName, rootDir, releases) {
  exactKeys(value, LANE_KEYS, `${laneName} lane`);
  rejectOperationalObjects(value, `${laneName} lane`);
  if (value.version !== 1 || value.lane !== laneName || typeof value.command !== 'string' || !value.command
    || !Array.isArray(value.args) || value.args.some(item => typeof item !== 'string')
    || typeof value.cwd !== 'string' || !value.cwd
    || !value.env || typeof value.env !== 'object' || Array.isArray(value.env)
    || !value.clientInfo || typeof value.clientInfo !== 'object' || Array.isArray(value.clientInfo)
    || !Number.isSafeInteger(value.requestTimeoutMs) || value.requestTimeoutMs <= 0
    || !Number.isSafeInteger(value.turnTimeoutMs) || value.turnTimeoutMs <= 0
    || !Number.isSafeInteger(value.maxRoleTurns) || value.maxRoleTurns <= 0
    || typeof value.sessionStorePath !== 'string' || typeof value.sessionNamespace !== 'string'
    || !value.sessionStorePath || !value.sessionNamespace || !value.modelProfile
    || !value.modelProfile || value.approvalPolicy !== 'never' || value.sandbox !== 'read-only'
    || !value.schema || typeof value.schema !== 'object' || Array.isArray(value.schema)) {
    throw new Error(`${laneName} lane native/config conflict`);
  }
  const sessionPath = privatePath(rootDir, value.sessionStorePath, `${laneName} session store`);
  const expectedKind = laneName.startsWith('evaluator_') ? 'blind_evaluation' : 'production_execution';
  exactKeys(value.schema, ['version', 'kind'], `${laneName} schema`);
  if (value.schema.version !== 1 || value.schema.kind !== expectedKind) throw new Error(`${laneName} schema conflict`);
  if (laneName === 'stable_execution' && contentHash(value.modelProfile) !== contentHash(releases.stable.modelProfile)) throw new Error('stable release profile conflict');
  if (laneName === 'candidate_execution' && contentHash(value.modelProfile) !== contentHash(releases.candidate.modelProfile)) throw new Error('candidate release profile conflict');
  return Object.freeze({ ...structuredClone(value), sessionStorePath: sessionPath.relative });
}

function loadMaterials(rootDir, sourceHead) {
  const path = join(rootDir, MATERIAL_FILE);
  if (!existsSync(path)) throw new Error('quality production material manifest unavailable');
  const value = JSON.parse(readFileSync(path, 'utf8'));
  exactKeys(value, MATERIAL_KEYS, 'quality production materials');
  rejectOperationalObjects(value, 'quality production materials');
  if (value.version !== 1 || value.sourceHead !== sourceHead
    || !value.runtimeConfig || typeof value.runtimeConfig !== 'object' || Array.isArray(value.runtimeConfig)) {
    throw new Error('quality production material identity conflict');
  }
  for (const key of ['seedDatabasePath', 'stableDatabasePath', 'candidateDatabasePath']) {
    if (typeof value[key] !== 'string' || !value[key]) throw new Error(`quality material ${key} conflict`);
  }
  const seedPath = privatePath(rootDir, value.seedDatabasePath, 'quality seed database');
  if (!existsSync(seedPath.absolute)) throw new Error('quality seed database unavailable');
  const seedDatabaseSha256 = sha256Bytes(readFileSync(seedPath.absolute));
  if (!SHA256.test(value.seedDatabaseSha256) || value.seedDatabaseSha256 !== seedDatabaseSha256) {
    throw new Error('quality material seed checksum conflict');
  }
  const stableRelease = validateRelease(value.stableRelease, 'stable release');
  const candidateRelease = validateRelease(value.candidateRelease, 'candidate release');
  if (stableRelease.releaseId === candidateRelease.releaseId
    || stableRelease.releaseChecksum === candidateRelease.releaseChecksum) throw new Error('release pair conflict');
  exactKeys(value.lanes, LANE_NAMES, 'quality production lanes');
  const lanes = Object.fromEntries(LANE_NAMES.map(name => [name, validateLane(value.lanes[name], name, rootDir, { stable: stableRelease, candidate: candidateRelease })]));
  if (new Set(Object.values(lanes).map(lane => lane.sessionStorePath)).size !== LANE_NAMES.length
    || new Set(Object.values(lanes).map(lane => lane.sessionNamespace)).size !== LANE_NAMES.length) {
    throw new Error('quality production lane isolation conflict');
  }
  for (const key of ['stableRuntime', 'candidateRuntime']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])
      || value[key].version !== 1 || value[key].sourceHead !== sourceHead) throw new Error(`${key} attestation input conflict`);
  }
  return Object.freeze({
    runtimeConfig: Object.freeze(structuredClone(value.runtimeConfig)), stableRelease, candidateRelease, lanes,
    stableRuntime: Object.freeze(structuredClone(value.stableRuntime)),
    candidateRuntime: Object.freeze(structuredClone(value.candidateRuntime)),
    seedDatabasePath: value.seedDatabasePath,
    stableDatabasePath: value.stableDatabasePath,
    candidateDatabasePath: value.candidateDatabasePath,
    seedDatabaseSha256,
    manifestSha256: sha256Bytes(readFileSync(path)),
  });
}

function buildAttestation(materials, sourceHead) {
  // Material manifests carry a versioned input wrapper; the runtime
  // attestation itself is the exact object returned by the branded runtime
  // verifier and therefore excludes that wrapper key.
  const runtimeAttestation = ({ version: _version, ...runtime }) => runtime;
  const evaluator = name => {
    const lane = materials.lanes[name];
    return {
      evaluatorId: name === 'evaluator_primary' ? 'evaluator-primary' : 'evaluator-secondary',
      evaluatorVersion: lane.lane,
      modelProfileChecksum: contentHash({ modelProfile: lane.modelProfile }),
      clientConfigChecksum: contentHash(lane),
      sessionNamespaceChecksum: contentHash({ sessionNamespace: lane.sessionNamespace }),
    };
  };
  const attestation = {
    version: 1, sourceHead,
    stableRuntime: runtimeAttestation(materials.stableRuntime),
    candidateRuntime: runtimeAttestation(materials.candidateRuntime),
    evaluatorPrimary: evaluator('evaluator_primary'), evaluatorSecondary: evaluator('evaluator_secondary'),
  };
  return Object.freeze(attestation);
}

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('quality authority options required');
  const allowed = ['rootDir', 'ledgerPath', 'plan', 'resumeRun', 'artifactPaths'];
  if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error('quality authority option conflict');
  if (typeof options.rootDir !== 'string' || !options.rootDir || typeof options.ledgerPath !== 'string' || !options.ledgerPath
    || !options.plan || !options.artifactPaths || typeof options.artifactPaths !== 'object' || Array.isArray(options.artifactPaths)) {
    throw new Error('quality authority data inputs required');
  }
  if (options.resumeRun !== null && options.resumeRun !== undefined && !RUN_ID.test(options.resumeRun)) {
    throw new Error('quality authority resume identity conflict');
  }
  exactKeys(options.artifactPaths, ['plan', 'ledger', 'raw'], 'quality authority artifact paths');
}

function readResumeHeader(path, runId) {
  if (!existsSync(path)) {
    if (runId) throw new Error('quality resume ledger unavailable');
    return null;
  }
  if (!runId) throw new Error('existing quality ledger requires --resume-run');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const meta = db.prepare('SELECT schema_version,evidence_class FROM quality_ledger_meta').all();
    if (meta.length !== 1 || Number(meta[0].schema_version) !== 1 || meta[0].evidence_class !== 'production') {
      throw new Error('quality resume ledger evidence class conflict');
    }
    const row = db.prepare('SELECT run_id,header_json,header_checksum,state FROM quality_runs WHERE run_id=?').get(runId);
    if (!row) throw new Error('quality resume run is unavailable');
    let header;
    try { header = JSON.parse(row.header_json); } catch { throw new Error('quality resume header JSON conflict'); }
    if (header.runId !== runId || !Number.isSafeInteger(header.createdAt)
      || canonicalJson(header) !== row.header_json || contentHash(header) !== row.header_checksum
      || !['open', 'finalized', 'blocked'].includes(row.state)) {
      throw new Error('quality resume header identity conflict');
    }
    return Object.freeze({ header, state: row.state });
  } finally { db.close(); }
}

export function createQualityReplayRunAuthority(options = {}) {
  validateOptions(options);
  const { rootDir, ledgerPath, plan, resumeRun = null, artifactPaths } = options;
  const source = sourceIdentity(rootDir);
  const planPath = privatePath(source.rootDir, artifactPaths.plan, 'quality plan');
  const ledger = privatePath(source.rootDir, artifactPaths.ledger, 'quality ledger');
  const raw = privatePath(source.rootDir, artifactPaths.raw, 'quality raw');
  const ledgerInput = privatePath(source.rootDir, ledgerPath, 'quality ledger input');
  if (ledgerInput.relative !== ledger.relative) throw new Error('quality ledger path authority conflict');
  if (new Set([plan.relative, ledger.relative, raw.relative]).size !== 3) throw new Error('quality artifact paths must be distinct');
  const resumeState = readResumeHeader(ledger.absolute, resumeRun);
  const createdAt = resumeState?.header.createdAt ?? Date.now();
  const planAuthority = validatePlan(source.rootDir, plan, planPath);
  const materials = loadMaterials(source.rootDir, source.sourceHead);
  const attestation = buildAttestation(materials, source.sourceHead);
  const runId = resumeRun || randomUUID();
  const artifactChecksums = {
    plan: planAuthority.planSha256,
    ledger: existsSync(ledger.absolute) ? sha256Bytes(readFileSync(ledger.absolute)) : null,
    raw: existsSync(raw.absolute) ? sha256Bytes(readFileSync(raw.absolute)) : null,
  };
  const descriptor = {
    version: 1, runId, finalKeys: planAuthority.finalKeys, planChecksum: planAuthority.planChecksum,
    sourceHead: source.sourceHead, stableRelease: materials.stableRelease, candidateRelease: materials.candidateRelease,
    attestation, attestationChecksum: contentHash(attestation),
    artifactPaths: { plan: planPath.relative, ledger: ledger.relative, raw: raw.relative },
    ledgerPath: ledger.relative,
    createdAt, evidenceEligible: true,
  };
  const inputArtifactChecksums = {
    plan: artifactChecksums.plan,
    materials: materials.manifestSha256,
    seedDatabase: materials.seedDatabaseSha256,
  };
  descriptor.inputArtifactChecksums = inputArtifactChecksums;
  if (resumeState) {
    const expectedHeader = resumeState.header;
    // ledgerPath is an authority/config identity, not part of the closed
    // persisted run header (artifactPaths.ledger is the header binding).
    const expectedDescriptor = { ...descriptor };
    delete expectedDescriptor.ledgerPath;
    delete expectedDescriptor.evidenceEligible;
    if (canonicalJson(expectedHeader) !== canonicalJson(expectedDescriptor)
      || (resumeState.state === 'finalized' && resumeRun !== expectedHeader.runId)) {
      throw new Error('quality resume header authority conflict');
    }
  }
  return createQualityProductionExecutionAuthority({
    descriptor: { ...descriptor, ledgerPath: ledger.relative, inputArtifactChecksums },
    materials: {
      runtimeConfig: materials.runtimeConfig,
      // Bridge-owned runtime construction must not resolve these paths from
      // the caller's cwd; bind the already-contained source files to their
      // verified absolute paths once, before branding.
      seedDatabasePath: privatePath(source.rootDir, materials.seedDatabasePath, 'quality seed database').absolute,
      stableDatabasePath: privatePath(source.rootDir, materials.stableDatabasePath, 'quality stable database').absolute,
      candidateDatabasePath: privatePath(source.rootDir, materials.candidateDatabasePath, 'quality candidate database').absolute,
      clientConfigs: Object.fromEntries(Object.entries(materials.lanes).map(([name, lane]) => [name, {
        command: lane.command, args: lane.args, cwd: lane.cwd, env: lane.env,
        clientInfo: lane.clientInfo, requestTimeoutMs: lane.requestTimeoutMs,
        turnTimeoutMs: lane.turnTimeoutMs, maxRoleTurns: lane.maxRoleTurns,
        lane: lane.lane, sessionStorePath: lane.sessionStorePath,
        sessionNamespace: lane.sessionNamespace, modelProfile: lane.modelProfile,
        approvalPolicy: lane.approvalPolicy, sandbox: lane.sandbox, schema: lane.schema,
      }])),
      clientConfigChecksums: Object.fromEntries(Object.entries(materials.lanes).map(([name, lane]) => [name, contentHash({
        command: lane.command, args: lane.args, cwd: lane.cwd, env: lane.env,
        clientInfo: lane.clientInfo, requestTimeoutMs: lane.requestTimeoutMs,
        turnTimeoutMs: lane.turnTimeoutMs, maxRoleTurns: lane.maxRoleTurns,
        lane: lane.lane, sessionStorePath: lane.sessionStorePath,
        sessionNamespace: lane.sessionNamespace, modelProfile: lane.modelProfile,
        approvalPolicy: lane.approvalPolicy, sandbox: lane.sandbox, schema: lane.schema,
      })])),
    },
    sourceRootDir: source.rootDir,
  });
}

export function assertQualityReplayRunAuthority(value) {
  return assertQualityRunAuthority(value);
}

export function qualityReplayRunAuthorityMaterials(value) {
  assertQualityReplayRunAuthority(value);
  return qualityRunAuthorityMaterials(value);
}

export function qualityReplayRunAuthorityArtifactChecksums(value) {
  return qualityRunAuthorityInputArtifactChecksums(value);
}
