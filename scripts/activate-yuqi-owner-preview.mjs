import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { createMemorySnapshot } from './backup-yuqi-memory.mjs';
import {
  OWNER_PREVIEW_EVIDENCE_CLASS,
  OWNER_PREVIEW_MODEL_PROFILE,
  OWNER_PREVIEW_PRESET_VERSION,
  OWNER_PREVIEW_ROLLOUT_KEY
} from '../yuqi-runtime/src/owner-preview-contract.mjs';
import { PresetRegistry } from '../yuqi-runtime/src/preset-registry.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const SOURCE_HEAD = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function removeSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) rmSync(`${path}${suffix}`, { force: true });
}

function tableSnapshot(database, tableName) {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.length) return { count: 0, checksum: contentHash([]) };
  const primary = columns.filter(column => Number(column.pk) > 0)
    .sort((left, right) => Number(left.pk) - Number(right.pk))
    .map(column => column.name);
  const order = primary.length ? primary : columns.map(column => column.name);
  const rows = database.prepare(
    `SELECT * FROM ${tableName} ORDER BY ${order.map(name => `"${name}"`).join(', ')}`
  ).all();
  return { count: rows.length, checksum: contentHash(rows) };
}

function rolloutProjection(row) {
  return Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right)));
}

export function inspectOwnerPreviewDatabase({ databasePath }) {
  const path = resolve(databasePath || '');
  if (!path || !existsSync(path)) throw new Error('owner preview database does not exist');
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const messages = tableSnapshot(database, 'messages');
    const facts = tableSnapshot(database, 'facts');
    const rolloutRows = database.prepare(
      'SELECT * FROM cognition_kind_rollouts ORDER BY rollout_key'
    ).all();
    const rollouts = Object.fromEntries(rolloutRows.map(row => [row.rollout_key, rolloutProjection(row)]));
    const directRow = rolloutRows.find(row => row.rollout_key === OWNER_PREVIEW_ROLLOUT_KEY) || null;
    const candidate = directRow?.candidate_release_id
      ? database.prepare('SELECT * FROM pipeline_releases WHERE release_id = ?')
        .get(directRow.candidate_release_id)
      : null;
    return {
      userVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
      messages,
      facts,
      rollouts,
      direct: directRow ? {
        rolloutKey: directRow.rollout_key,
        currentMode: directRow.current_mode,
        rolloutPhase: directRow.rollout_phase,
        revision: Number(directRow.revision),
        stableReleaseId: directRow.stable_release_id,
        candidateReleaseId: directRow.candidate_release_id,
        candidatePhase: directRow.candidate_phase,
        lastReasonCode: directRow.last_reason_code
      } : null,
      currentPresetVersion: String(database.prepare(
        "SELECT value FROM runtime_state WHERE key='current_preset_version'"
      ).get()?.value || ''),
      candidate: candidate ? {
        releaseId: candidate.release_id,
        pipelineVersion: candidate.pipeline_version,
        presetVersion: candidate.preset_version,
        cognitionSchemaVersion: Number(candidate.cognition_schema_version),
        expressionSchemaVersion: Number(candidate.expression_schema_version),
        evaluatorVersion: candidate.evaluator_version,
        modelProfile: JSON.parse(candidate.model_profile_json),
        releaseChecksum: candidate.release_checksum
      } : null
    };
  } finally {
    database.close();
  }
}

function candidateReleaseChecksum(release) {
  return contentHash({
    pipelineVersion: release.pipelineVersion,
    presetVersion: release.presetVersion,
    cognitionSchemaVersion: release.cognitionSchemaVersion,
    expressionSchemaVersion: release.expressionSchemaVersion,
    evaluatorVersion: release.evaluatorVersion,
    modelProfile: release.modelProfile,
    componentManifest: release.componentManifest,
    createdAt: release.createdAt
  });
}

function exactOwnerPreviewIsActive(rollout, report, candidate) {
  return rollout?.currentMode === 'active'
    && rollout?.candidatePhase === 'canary'
    && rollout?.candidateReleaseId === candidate.releaseId
    && rollout?.lastReportId === report.reportId
    && rollout?.lastReportChecksum === report.artifactChecksum
    && rollout?.lastReasonCode === 'owner_preview_started';
}

export function applyOwnerPreviewToStore({
  store,
  presetDir,
  sourceHead,
  authorizationId,
  authorizedAt,
  suiteChecksum
}) {
  if (!store || !SOURCE_HEAD.test(String(sourceHead || ''))
    || typeof authorizationId !== 'string'
    || !Number.isSafeInteger(authorizedAt) || authorizedAt < 0
    || !SHA256.test(String(suiteChecksum || ''))) {
    throw new Error('owner preview activation authority conflict');
  }
  const presets = new PresetRegistry({ presetDir: resolve(presetDir), store, clock: () => authorizedAt });
  const promotion = new PromotionController({ store, presetRegistry: presets, clock: () => authorizedAt });
  if (promotion.listStatus().length === 0) promotion.initialize();
  const direct = promotion.getStatus(OWNER_PREVIEW_ROLLOUT_KEY);
  if (!direct) throw new Error('owner preview direct rollout is unavailable');
  const stable = store.getPipelineRelease(direct.stableReleaseId);
  if (!stable) throw new Error('owner preview stable release is unavailable');
  const releaseBody = {
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: OWNER_PREVIEW_PRESET_VERSION,
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    evaluatorVersion: 'lived-quality-supervisor-v3',
    modelProfile: OWNER_PREVIEW_MODEL_PROFILE,
    componentManifest: presets.pipelineReleaseManifest(
      OWNER_PREVIEW_PRESET_VERSION,
      stable.releaseId,
      {
        modelProfile: OWNER_PREVIEW_MODEL_PROFILE,
        cognitionSchemaVersion: 3,
        expressionSchemaVersion: 3,
        evaluatorVersion: 'lived-quality-supervisor-v3'
      }
    ).components,
    createdAt: authorizedAt,
    retiredAt: null
  };
  const releaseChecksum = candidateReleaseChecksum(releaseBody);
  const candidate = {
    ...releaseBody,
    releaseId: `quality_candidate_${releaseChecksum.slice(0, 16)}`,
    releaseChecksum
  };
  const summary = {
    eligible: true,
    evidenceClass: OWNER_PREVIEW_EVIDENCE_CLASS,
    internalPreview: true,
    authorizedBy: 'owner',
    authorizationId,
    authorizedAt,
    sourceHead,
    rolloutScope: [OWNER_PREVIEW_ROLLOUT_KEY],
    stableBaselineReleaseId: stable.releaseId,
    stableBaselineReleaseChecksum: stable.releaseChecksum,
    candidateRelease: candidate,
    evaluatorVersion: candidate.evaluatorVersion,
    suiteChecksum,
    presetVersion: OWNER_PREVIEW_PRESET_VERSION,
    modelProfile: OWNER_PREVIEW_MODEL_PROFILE
  };
  const reportId = `owner_preview_${contentHash(summary).slice(0, 24)}`;
  let report = store.putEvaluationReportInternal({
    reportId,
    reportType: 'promotion',
    rolloutKey: OWNER_PREVIEW_ROLLOUT_KEY,
    sourceType: 'promotion_snapshot',
    sourceRef: `owner-preview:${authorizationId}`,
    artifactPath: `artifacts/owner-preview/runtime/${reportId}.json`,
    summary,
    createdAt: authorizedAt
  });
  report = store.markEvaluationReportMaterialized({
    reportId,
    expectedChecksum: report.artifactChecksum,
    now: authorizedAt
  });
  let rollout = promotion.getStatus(OWNER_PREVIEW_ROLLOUT_KEY);
  if (!exactOwnerPreviewIsActive(rollout, report, candidate)) {
    if (!(rollout.candidatePhase === 'shadow'
      && rollout.candidateReleaseId === candidate.releaseId
      && rollout.lastReportId === report.reportId)) {
      rollout = promotion.registerCandidate({
        rolloutKey: OWNER_PREVIEW_ROLLOUT_KEY,
        expectedRevision: rollout.revision,
        releaseId: candidate.releaseId,
        reportId: report.reportId,
        reportChecksum: report.artifactChecksum
      });
    }
    rollout = promotion.startOwnerPreview({
      rolloutKey: OWNER_PREVIEW_ROLLOUT_KEY,
      expectedRevision: rollout.revision,
      reportId: report.reportId,
      reportChecksum: report.artifactChecksum,
      authorizationId,
      sourceHead
    });
  }
  return { candidate, report, rollout };
}

function databaseFileFingerprint(path) {
  return Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
    const candidate = `${path}${suffix}`;
    return [suffix || 'main', existsSync(candidate) ? sha256File(candidate) : null];
  }));
}

function assertMemoryUnchanged(before, after, label) {
  if (canonicalJson(before.messages) !== canonicalJson(after.messages)
    || canonicalJson(before.facts) !== canonicalJson(after.facts)) {
    throw new Error(`${label} changed Yuqi messages or facts`);
  }
}

function assertOtherRolloutsUnchanged(before, after) {
  for (const [key, row] of Object.entries(before.rollouts)) {
    if (key === OWNER_PREVIEW_ROLLOUT_KEY) continue;
    if (canonicalJson(after.rollouts[key]) !== canonicalJson(row)) {
      throw new Error(`owner preview changed unrelated rollout: ${key}`);
    }
  }
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${canonicalJson(value)}\n`, 'utf8');
  renameSync(temporary, path);
}

function restoreDatabase(snapshotPath, databasePath) {
  removeSidecars(databasePath);
  copyFileSync(snapshotPath, databasePath);
  removeSidecars(databasePath);
}

export function probeRuntimeStopped({ host = '127.0.0.1', port = 17891, timeoutMs = 500 } = {}) {
  return new Promise(resolveProbe => {
    const socket = connect({ host, port: Number(port) });
    const finish = stopped => {
      socket.destroy();
      resolveProbe(stopped);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', () => finish(true));
    socket.setTimeout(timeoutMs, () => finish(true));
  });
}

export async function activateOwnerPreview(options = {}) {
  const projectRoot = resolve(options.projectRoot || '.');
  const databasePath = resolve(options.databasePath || '');
  const presetDir = resolve(options.presetDir || join(projectRoot, 'yuqi-runtime', 'presets'));
  const backupDir = resolve(options.backupDir || join(dirname(databasePath), '..', 'snapshots'));
  const receiptDir = resolve(options.receiptDir || join(projectRoot, 'artifacts', 'owner-preview', 'runtime'));
  const authorizationId = String(options.authorizationId || '');
  const authorizedAt = Number(options.authorizedAt);
  const sourceHead = String(options.sourceHead || '');
  const suiteChecksum = String(options.suiteChecksum || '');
  if (!existsSync(databasePath) || !existsSync(presetDir)
    || !SOURCE_HEAD.test(sourceHead) || !SHA256.test(suiteChecksum)
    || !Number.isSafeInteger(authorizedAt) || authorizedAt < 0) {
    throw new Error('owner preview activation input conflict');
  }
  const runtimeStopped = await (options.runtimeProbe
    ? options.runtimeProbe()
    : probeRuntimeStopped({ host: options.host, port: options.port }));
  if (runtimeStopped !== true) throw new Error('Yuqi runtime must be stopped before owner preview activation');
  const readSourceHead = options.sourceHeadReader || (() => execFileSync(
    'git', ['rev-parse', '--verify', 'HEAD'], { cwd: projectRoot, encoding: 'utf8', windowsHide: true }
  ).trim().toLowerCase());
  if (readSourceHead() !== sourceHead) throw new Error('owner preview source HEAD conflict');

  const baseline = inspectOwnerPreviewDatabase({ databasePath });
  mkdirSync(backupDir, { recursive: true });
  const backupPath = createMemorySnapshot({
    databasePath,
    snapshotsDir: backupDir,
    now: new Date(authorizedAt),
    retain: 30
  });
  const backup = inspectOwnerPreviewDatabase({ databasePath: backupPath });
  assertMemoryUnchanged(baseline, backup, 'owner preview backup');
  assertOtherRolloutsUnchanged(baseline, backup);
  const sourceFingerprint = databaseFileFingerprint(databasePath);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'yuqi-owner-preview-activation-'));
  const clonePath = join(temporaryRoot, 'clone.sqlite');
  let sourceMutationStarted = false;
  try {
    copyFileSync(backupPath, clonePath);
    let cloneStore = new YuqiStore(clonePath);
    let cloneApplied;
    try {
      cloneApplied = applyOwnerPreviewToStore({
        store: cloneStore,
        presetDir,
        sourceHead,
        authorizationId,
        authorizedAt,
        suiteChecksum
      });
    } finally {
      cloneStore.close();
    }
    cloneStore = new YuqiStore(clonePath);
    cloneStore.close();
    const clone = inspectOwnerPreviewDatabase({ databasePath: clonePath });
    assertMemoryUnchanged(baseline, clone, 'owner preview clone');
    assertOtherRolloutsUnchanged(baseline, clone);
    if (clone.direct?.currentMode !== 'active' || clone.direct?.candidatePhase !== 'canary') {
      throw new Error('owner preview clone did not activate DIRECT_REPLY');
    }

    const receiptPath = join(receiptDir, `${authorizationId}.json`);
    if (options.dryRun === true) {
      const receipt = {
        version: 'yuqi-owner-preview-activation-v1',
        dryRun: true,
        authorizationId,
        authorizedAt,
        sourceHead,
        databaseBefore: { userVersion: baseline.userVersion, messages: baseline.messages, facts: baseline.facts },
        backup: { path: backupPath, sha256: sha256File(backupPath) },
        candidateReleaseId: cloneApplied.candidate.releaseId,
        candidateReleaseChecksum: cloneApplied.candidate.releaseChecksum,
        reportId: cloneApplied.report.reportId,
        reportChecksum: cloneApplied.report.artifactChecksum,
        direct: clone.direct
      };
      atomicWriteJson(receiptPath, receipt);
      return { ...receipt, receiptPath, backupPath, clone };
    }

    const verifiedSourceHead = readSourceHead();
    const verifiedSourceFingerprint = databaseFileFingerprint(databasePath);
    if (verifiedSourceHead !== sourceHead
      || canonicalJson(verifiedSourceFingerprint) !== canonicalJson(sourceFingerprint)) {
      throw new Error('owner preview source changed after clone verification');
    }
    sourceMutationStarted = true;
    const store = new YuqiStore(databasePath);
    let applied;
    try {
      applied = applyOwnerPreviewToStore({
        store,
        presetDir,
        sourceHead,
        authorizationId,
        authorizedAt,
        suiteChecksum
      });
    } finally {
      store.close();
    }
    const after = inspectOwnerPreviewDatabase({ databasePath });
    assertMemoryUnchanged(baseline, after, 'owner preview source');
    assertOtherRolloutsUnchanged(baseline, after);
    const receipt = {
      version: 'yuqi-owner-preview-activation-v1',
      dryRun: false,
      authorizationId,
      authorizedAt,
      sourceHead,
      databaseBefore: { userVersion: baseline.userVersion, messages: baseline.messages, facts: baseline.facts },
      databaseAfter: { userVersion: after.userVersion, messages: after.messages, facts: after.facts },
      backup: { path: backupPath, sha256: sha256File(backupPath) },
      candidateReleaseId: applied.candidate.releaseId,
      candidateReleaseChecksum: applied.candidate.releaseChecksum,
      reportId: applied.report.reportId,
      reportChecksum: applied.report.artifactChecksum,
      direct: after.direct
    };
    atomicWriteJson(receiptPath, receipt);
    return { ...receipt, receiptPath, backupPath, direct: after.direct };
  } catch (error) {
    if (sourceMutationStarted) {
      restoreDatabase(backupPath, databasePath);
      const restored = inspectOwnerPreviewDatabase({ databasePath });
      assertMemoryUnchanged(baseline, restored, 'owner preview restored source');
      assertOtherRolloutsUnchanged(baseline, restored);
    }
    throw error;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const configPath = resolve(argument('--config') || join('yuqi-runtime', 'config.json'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const result = await activateOwnerPreview({
    projectRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
    databasePath: resolve(config.databasePath),
    presetDir: resolve(dirname(fileURLToPath(import.meta.url)), '..', 'yuqi-runtime', 'presets'),
    backupDir: resolve(config.snapshotsDir),
    authorizationId: argument('--authorization-id'),
    authorizedAt: Number(argument('--authorized-at')),
    sourceHead: argument('--source-head'),
    suiteChecksum: argument('--suite-checksum'),
    host: config.host || '127.0.0.1',
    port: Number(config.port) || 17891,
    dryRun: process.argv.includes('--dry-run')
  });
  process.stdout.write(`${canonicalJson({ ok: true, ...result })}\n`);
}
