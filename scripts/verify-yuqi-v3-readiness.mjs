import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync
} from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { validateReadinessInputReport } from './generate-yuqi-v3-readiness-inputs.mjs';
import {
  validateCollectionAttestation, validateVisiblePathProducerAttestations
} from './generate-yuqi-visible-path-metrics.mjs';
import {
  assertEvidenceDirectoryScope, assertEvidencePath, finalizeVisiblePathCollection, gitStatusArgsForEvidence,
  instrumentationXmlSnapshots, loadVisiblePathProductionInputs, validateVisiblePathStartControl
} from './run-yuqi-visible-path-formal.mjs';
import { assertQualityReportProvenance } from './report-yuqi-lived-quality.mjs';
import { validateQualityArtifactBundle } from './report-yuqi-lived-quality.mjs';
import { assertVerifiedQualityReplayPlan } from '../yuqi-runtime/src/quality-replay.mjs';

const execFileAsync = promisify(execFile);
const loadedManifests = new WeakSet();
const SAFE_MAX = Number.MAX_SAFE_INTEGER;
const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CONNECTED_DEVICE_RACE_NAMES = Object.freeze([
  'native_completed_before_ui_open', 'ui_open_before_notification',
  'event_and_poll_same_group', 'event_lost_poll_recovers',
  'plugin_promise_hangs_then_replay', 'page_reload_before_ui_ack',
  'ambiguous_remote_timeout_never_falls_back',
  'android_fallback_receipt_syncs_without_pc_redelivery',
  'conversation_clear_while_result_in_flight',
  'role_delete_pending_suppresses_late_lan_result',
  'role_delete_applied_acks_late_cloud_without_semantic_write'
]);
const PC_RACE_NAMES = Object.freeze([
  'proactive_generating_then_user_batch', 'proactive_outbox_then_user_batch',
  'runtime_restart_before_visible_commit', 'runtime_restart_after_visible_commit',
  'original_retry_and_sibling_retry_compete', 'populated_v15_migrates_and_restarts',
  'canary_rollback_while_turn_in_flight', 'same_fingerprint_adjacent_revisions',
  'cloud_waiting_does_not_block_next_local_turn', 'pc_android_receipt_conflict_is_quarantined',
  'conversation_clear_after_outbox_snapshot', 'redacted_group_stale_outbox_snapshot_does_not_send'
]);
export const CONNECTED_DEVICE_RACE_TEST_CLASS =
  'com.siyi.al.execution.YuqiV3ConnectedRaceTest';
export const READINESS_ARTIFACT_NAMES = Object.freeze([
  'baseline', 'migration', 'migrationClone', 'protocol', 'quality', 'races',
  'qualityPlan', 'qualityReplay', 'qualityManualReview',
  'androidFallback', 'rolloutStatus', 'visiblePathMetrics', 'nodeTests', 'androidTests',
  'connectedDeviceRaces'
]);
const CANDIDATE_BOUND_ARTIFACTS = new Set([
  'quality', 'protocol', 'androidFallback', 'rolloutStatus', 'visiblePathMetrics', 'nodeTests',
  'androidTests', 'connectedDeviceRaces'
]);
const FIXED_INPUT_FILES = Object.freeze({
  baseline: 'baseline.json',
  migration: 'history-source-v15-migration-report.json',
  migrationClone: 'history-source-v15.sqlite',
  protocol: 'protocol-report.json',
  quality: 'quality-report.json',
  qualityPlan: 'quality-replay-plan.json',
  qualityReplay: 'quality-replay.jsonl',
  qualityManualReview: 'quality-manual-review.jsonl',
  races: 'race-report.json',
  androidFallback: 'android-fallback-report.json',
  rolloutStatus: 'rollout-status.json',
  visiblePathMetrics: 'visible-path-metrics.json'
});
const MIGRATION_COUNT_KEYS = Object.freeze([
  'cloud_deliveries', 'facts', 'life_episodes', 'messages', 'relationship_history',
  'relationship_states', 'result_outbox', 'role_plans', 'turn_authority_lineages',
  'turns', 'visible_commit_receipts', 'visible_result_actions', 'visible_result_groups',
  'visible_result_items', 'visible_result_manifests'
]);
const MIGRATION_SEMANTIC_COUNT_KEYS = Object.freeze([
  ...MIGRATION_COUNT_KEYS, 'conversation_clear_controls'
]);
const QUALITY_TOP_LEVEL_KEYS = Object.freeze([
  'version', 'productionReleaseMutation', 'candidateRelease', 'planChecksum',
  'replayProvenance', 'replayRunId', 'qualityPlanSha256', 'qualityReplaySha256',
  'qualityManualReviewSha256', 'qualityGate', 'manualReview', 'eligible', 'failedGates', 'sourceHead'
]);
const QUALITY_BLOCKED_KEYS = Object.freeze([
  'version', 'productionReleaseMutation', 'eligible', 'failedGates', 'blockingReason'
]);
const QUALITY_RELEASE_KEYS = Object.freeze([
  'pipelineVersion', 'presetVersion', 'cognitionSchemaVersion', 'expressionSchemaVersion',
  'evaluatorVersion', 'modelProfile', 'componentManifest', 'createdAt', 'releaseId', 'releaseChecksum'
]);
const QUALITY_GATE_KEYS = Object.freeze([
  'protocolFailures', 'sentinelSevereFailureCount', 'dimensionAverages', 'scoreOneCount',
  'candidatePreferredRate', 'regressionRate', 'tieOrUnresolvedRate', 'structuralRegressionCount',
  'candidateWins', 'stableWins', 'tieCount', 'unresolvedCount', 'completedPairs',
  'evidenceCount', 'failedGates', 'eligible'
]);
const QUALITY_MANUAL_KEYS = Object.freeze([
  'eligible', 'failedGates', 'unresolvedCount', 'requiredCount', 'requirements', 'queue'
]);
const VISIBLE_PATH_KINDS = Object.freeze([
  'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION', 'MOMENT_REPLY'
]);
const VISIBLE_PATH_SAMPLE_KEYS = Object.freeze([
  'authorityLineageKeySha256', 'authorityMode', 'createdAt', 'elapsedMs',
  'kind', 'pipelineReleaseId', 'sampleId', 'terminalDisposition', 'turnIdSha256',
  'uiAppliedAt', 'visibleGroupIdSha256'
]);
const VISIBLE_PATH_ANDROID_METADATA_KEYS = Object.freeze([
  'candidateReleaseId', 'completedAt', 'deviceSerial', 'recordType', 'runId',
  'schemaVersion', 'startedAt', 'producerAttestation'
]);
const VISIBLE_PATH_PC_METADATA_KEYS = Object.freeze([
  'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt', 'recordType', 'runId', 'schemaVersion',
  'sourceHead', 'startedAt', 'producerAttestation'
]);
const VISIBLE_PATH_ANDROID_INPUT_ROW_KEYS = Object.freeze([
  'authorityLineageKeySha256', 'createdAt', 'elapsedMs', 'kind',
  'pipelineReleaseId', 'terminalDisposition', 'turnIdSha256', 'uiAppliedAt', 'visibleGroupIdSha256'
]);
const VISIBLE_PATH_PC_INPUT_ROW_KEYS = Object.freeze([
  'authorityLineageKeySha256', 'authorityMode', 'kind', 'pipelineReleaseId',
  'turnIdSha256', 'visibleGroupIdSha256'
]);
const VISIBLE_PATH_METRIC_KEYS = Object.freeze([
  'directReplyMedianMs', 'directReplyP95Ms', 'maximumVisibleMs', 'shadowBlockedVisibleCount'
]);

function validateMigrationReport(value) {
  exactKeys(value, [
    'afterCounts', 'applied', 'beforeCounts', 'boundaryCount', 'cognitiveRevision',
    'decisionChecksum', 'decisions', 'insertedCount', 'roleId', 'schemaVersion',
    'sourceDatabaseSha256', 'sourceDatabaseSha256After', 'sourceTableCounts',
    'sourceUserVersion', 'v14InvariantSummary', 'workingDatabaseSha256', 'workingUserVersion'
  ], 'migration report');
  if (value.schemaVersion !== 1 || value.roleId !== 'yuqi'
    || value.sourceUserVersion !== 14 || value.workingUserVersion !== 15
    || value.applied !== false || !Number.isSafeInteger(value.boundaryCount)
    || value.boundaryCount < 0 || !Number.isSafeInteger(value.insertedCount)
    || value.insertedCount < 0 || value.cognitiveRevision !== null
    || !Array.isArray(value.decisions)) fail('migration authority shape');
  for (const key of ['decisionChecksum', 'sourceDatabaseSha256', 'sourceDatabaseSha256After', 'workingDatabaseSha256']) {
    if (!/^[a-f0-9]{64}$/.test(value[key] || '')) fail(`migration ${key}`);
  }
  if (value.sourceDatabaseSha256 !== value.sourceDatabaseSha256After) fail('migration source changed');
  const validateCounts = (counts, label) => {
    exactKeys(counts, MIGRATION_COUNT_KEYS, label);
    for (const key of MIGRATION_COUNT_KEYS) {
      if (counts[key] !== null && (!Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
        fail(`${label} count`);
      }
    }
  };
  const validateSemanticCounts = counts => {
    exactKeys(counts, MIGRATION_SEMANTIC_COUNT_KEYS, 'migration semantic table counts');
    for (const key of MIGRATION_SEMANTIC_COUNT_KEYS) {
      if (counts[key] !== null && (!Number.isSafeInteger(counts[key]) || counts[key] < 0)) {
        fail('migration semantic table count');
      }
    }
  };
  validateCounts(value.sourceTableCounts, 'migration source table counts');
  validateCounts(value.beforeCounts, 'migration before counts');
  validateCounts(value.afterCounts, 'migration after counts');
  if (canonical(value.beforeCounts) !== canonical(value.afterCounts)
    || canonical(value.beforeCounts) !== canonical(value.sourceTableCounts)) fail('migration count binding');
  exactKeys(value.v14InvariantSummary, ['checksum', 'indexes', 'rolloutCanary', 'semantic', 'userVersion'], 'migration invariant');
  if (value.v14InvariantSummary.userVersion !== 15 || !Array.isArray(value.v14InvariantSummary.indexes)
    || !Array.isArray(value.v14InvariantSummary.rolloutCanary) || !/^[a-f0-9]{64}$/.test(value.v14InvariantSummary.checksum || '')) {
    fail('migration invariant fields');
  }
  exactKeys(value.v14InvariantSummary.semantic,
    ['canonicalTurnCount', 'checksum', 'lineageCount', 'receiptCount', 'tableCounts', 'userVersion'],
    'migration semantic invariant');
  if (value.v14InvariantSummary.semantic.userVersion !== 15
    || !Number.isSafeInteger(value.v14InvariantSummary.semantic.canonicalTurnCount)
    || !Number.isSafeInteger(value.v14InvariantSummary.semantic.lineageCount)
    || !Number.isSafeInteger(value.v14InvariantSummary.semantic.receiptCount)
    || value.v14InvariantSummary.semantic.canonicalTurnCount < 0
    || value.v14InvariantSummary.semantic.lineageCount < 0
    || value.v14InvariantSummary.semantic.receiptCount < 0
    || !/^[a-f0-9]{64}$/.test(value.v14InvariantSummary.semantic.checksum || '')) {
    fail('migration semantic invariant fields');
  }
  validateSemanticCounts(value.v14InvariantSummary.semantic.tableCounts);
  const semanticWithoutChecksum = { ...value.v14InvariantSummary.semantic };
  delete semanticWithoutChecksum.checksum;
  if (sha256(semanticWithoutChecksum) !== value.v14InvariantSummary.semantic.checksum) {
    fail('migration semantic invariant checksum');
  }
}

function cloneTableCounts(db) {
  const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const counts = {};
  for (const key of MIGRATION_SEMANTIC_COUNT_KEYS) {
    if (!names.has(key)) {
      counts[key] = null;
      continue;
    }
    counts[key] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${key.replaceAll('"', '""')}"`).get().count);
  }
  return counts;
}

function readMigrationClone(path, migration) {
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = `${path}${suffix}`;
    if (existsSync(sidecar) && statSync(sidecar).size > 0) fail(`migration clone ${suffix} sidecar`);
  }
  const mainBefore = sha256(readFileSync(path));
  const inspect = () => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
      if (userVersion !== 15) fail('migration clone user_version');
      const tableCounts = cloneTableCounts(db);
      const expectedTableCounts = migration.v14InvariantSummary.semantic.tableCounts;
      if (canonical(tableCounts) !== canonical(expectedTableCounts)) fail('migration clone table counts');
      const turnColumns = new Set(db.prepare('PRAGMA table_info(turns)').all().map(row => row.name));
      const canonicalTurnCount = turnColumns.has('result_authority_version')
        ? Number(db.prepare('SELECT COUNT(*) AS count FROM turns WHERE result_authority_version=1').get().count) : 0;
      const lineageCount = Number(db.prepare('SELECT COUNT(*) AS count FROM turn_authority_lineages').get().count);
      const receiptCount = Number(db.prepare('SELECT COUNT(*) AS count FROM visible_commit_receipts').get().count);
      const semantic = { userVersion, tableCounts, canonicalTurnCount, lineageCount, receiptCount };
      semantic.checksum = sha256(semantic);
      const expected = migration.v14InvariantSummary.semantic;
      const expectedWithoutChecksum = { ...expected };
      delete expectedWithoutChecksum.checksum;
      const semanticWithoutChecksum = { ...semantic };
      delete semanticWithoutChecksum.checksum;
      if (canonical(semanticWithoutChecksum) !== canonical(expectedWithoutChecksum)
        || semantic.checksum !== expected.checksum) fail('migration clone semantic invariant');
      return { userVersion, tableCounts, semantic };
    } finally { db.close(); }
  };
  const first = inspect();
  const second = inspect();
  if (canonical(first) !== canonical(second)) fail('migration clone reopen changed');
  const mainAfter = sha256(readFileSync(path));
  if (mainBefore !== mainAfter || mainBefore !== migration.workingDatabaseSha256) fail('migration clone raw checksum');
  return first;
}

function fail(message) {
  throw new Error(`readiness evidence: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} keys`);
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function safeTime(value, now) {
  return Number.isSafeInteger(value) && value >= 0 && value <= now;
}

function safePath(root, declared) {
  if (typeof declared !== 'string' || declared.length === 0 || isAbsolute(declared)) return null;
  const file = resolve(root, declared);
  const rel = relative(resolve(root), file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return null;
  const realRoot = realpathSync(root);
  let cursor = resolve(root);
  for (const segment of rel.split(/[\\/]/)) {
    cursor = join(cursor, segment);
    if (!existsSync(cursor)) continue;
    if (lstatSync(cursor).isSymbolicLink()) return null;
    const realCursor = realpathSync(cursor);
    const realRelative = relative(realRoot, realCursor);
    if (realRelative.startsWith('..') || isAbsolute(realRelative)) return null;
  }
  if (!existsSync(file)) return file;
  const realFile = realpathSync(file);
  const realRelative = relative(realRoot, realFile);
  return realRelative && !realRelative.startsWith('..') && !isAbsolute(realRelative) ? realFile : null;
}

function parseAttributes(raw) {
  const attrs = {};
  for (const match of String(raw || '').matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

export function parseConnectedTestResults(xml) {
  const names = [];
  let invalid = false;
  let wrongClass = false;
  const source = String(xml || '');
  const testcasePattern = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
  for (const match of source.matchAll(testcasePattern)) {
    const attrs = parseAttributes(match[1]);
    const name = attrs.name || '';
    if (attrs.classname !== CONNECTED_DEVICE_RACE_TEST_CLASS) wrongClass = true;
    if (!name || /<(?:failure|error|skipped)\b/.test(match[2] || '')) invalid = true;
    names.push(name);
  }
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) || 0) + 1);
  const exact = names.length === CONNECTED_DEVICE_RACE_NAMES.length
    && CONNECTED_DEVICE_RACE_NAMES.every(name => counts.get(name) === 1)
    && names.every(name => CONNECTED_DEVICE_RACE_NAMES.includes(name));
  return { ready: exact && !invalid && !wrongClass, names, invalid, wrongClass };
}

export function parseAdbDevices(output) {
  const devices = [];
  for (const line of String(output || '').split(/\r?\n/).slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)(?:\s|$)/);
    if (match && match[2] === 'device') devices.push(match[1]);
  }
  return devices;
}

function selectAdbDevice(output, requestedSerial = '') {
  const online = parseAdbDevices(output);
  const selected = requestedSerial || (online.length === 1 ? online[0] : '');
  if (!selected || online.length === 0 || !online.includes(selected)
    || (!requestedSerial && online.length !== 1)) {
    fail('CONNECTED_DEVICE_RACES_INCOMPLETE: exactly one online device is required');
  }
  return selected;
}

function findRecentXml(root, startedAt) {
  const candidates = [];
  if (!existsSync(root)) return candidates;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) candidates.push(...findRecentXml(full, startedAt));
    else if (entry.isFile() && /^TEST-.*\.xml$/i.test(entry.name)
      && statSync(full).mtimeMs >= startedAt) candidates.push(full);
  }
  return candidates;
}

function runIdFor(startedAt) {
  return `run-${startedAt}-${process.pid}-${randomUUID()}`;
}

export function resolveAdbExecutable(repoRoot, environment = process.env) {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates = [environment.ANDROID_HOME, environment.ANDROID_SDK_ROOT]
    .filter(value => typeof value === 'string' && value.length > 0)
    .map(value => resolve(value, 'platform-tools', executable));
  const properties = resolve(repoRoot, 'android', 'local.properties');
  if (existsSync(properties)) {
    const match = readFileSync(properties, 'utf8').match(/^sdk\.dir=(.+)$/m);
    if (match) {
      const sdkRoot = match[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\');
      candidates.push(resolve(sdkRoot, 'platform-tools', executable));
    }
  }
  const selected = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
  if (!selected) fail('ANDROID_ADB_UNAVAILABLE: absolute adb executable required');
  return selected;
}

export function resolveNpmExecutable(environment = process.env) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const pathEntries = typeof environment.PATH === 'string' ? environment.PATH.split(delimiter) : [];
  const candidates = pathEntries.filter(Boolean).map(entry => resolve(entry, executable));
  if (process.platform === 'win32' && typeof environment.ProgramFiles === 'string') {
    candidates.push(resolve(environment.ProgramFiles, 'nodejs', 'npm.cmd'));
  }
  const selected = candidates.find(candidate => isAbsolute(candidate) && existsSync(candidate));
  if (!selected) fail('NPM_UNAVAILABLE: absolute npm executable required');
  return selected;
}

export function parseNodeTestSummary(output) {
  const counters = new Map([
    ['tests', []], ['pass', []], ['fail', []], ['skipped', []]
  ]);
  for (const match of String(output || '').matchAll(/^\s*ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/gmi)) {
    counters.get(match[1]).push(Number(match[2]));
  }
  const blockCount = counters.get('tests').length;
  if (blockCount === 0 || [...counters.values()].some(values =>
    values.length !== blockCount || values.some(value => !Number.isSafeInteger(value)))) {
    fail('node test counters');
  }
  for (let index = 0; index < blockCount; index += 1) {
    if (counters.get('tests')[index] <= 0
      || counters.get('tests')[index] !== counters.get('pass')[index]
        + counters.get('fail')[index] + counters.get('skipped')[index]) fail('node test counters');
  }
  const sum = label => counters.get(label).reduce((total, value) => total + value, 0);
  const summary = {
    tests: sum('tests'),
    passed: sum('pass'),
    failed: sum('fail'),
    skipped: sum('skipped')
  };
  return summary;
}

function validateSourceRaceReport(value, candidateReleaseId) {
  if (!value || value.schemaVersion !== 'yuqi-v3-race-report-v1'
    || (value.candidateReleaseId !== undefined && value.candidateReleaseId !== null
      && value.candidateReleaseId !== candidateReleaseId)
    || !/^[a-f0-9]{64}$/.test(value.registryChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.overallChecksum || '')
    || value.releaseEligible !== false
    || !Array.isArray(value.connectedAndroidCases)
    || JSON.stringify(value.connectedAndroidCases.map(row => row?.id))
      !== JSON.stringify(CONNECTED_DEVICE_RACE_NAMES)
    || value.connectedAndroidCases.some(row => row?.status !== 'pending_connected_android'
      || row?.passed !== 0 || row?.failed !== 0 || row?.skipped !== 0)
    || !Array.isArray(value.pcCases)
    || JSON.stringify(value.pcCases.map(row => row?.id)) !== JSON.stringify(PC_RACE_NAMES)
    || value.pcCases.some(row => row?.status !== 'passed' || row?.passed !== 1
      || row?.failed !== 0 || row?.skipped !== 0)) {
    fail('race source registry');
  }
}

export function connectedXmlWasRewritten(before, after) {
  if (!after || !Number.isFinite(after.mtimeMs) || !/^[a-f0-9]{64}$/.test(after.sha256 || '')) return false;
  return !before || after.mtimeMs > before.mtimeMs;
}

function connectedXmlSnapshots(root) {
  return new Map(findRecentXml(root, Number.NEGATIVE_INFINITY).map(file => {
    const stat = statSync(file);
    return [resolve(file), { mtimeMs: stat.mtimeMs, sha256: sha256(readFileSync(file)) }];
  }));
}

function relativeFiles(root, prefix = '') {
  const directory = prefix ? join(root, prefix) : root;
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const child = prefix ? join(prefix, entry.name) : entry.name;
    return entry.isDirectory() ? relativeFiles(root, child) : [child];
  });
}

/**
 * The Android APK must contain the exact WebView bytes used by the connected
 * tests. Capacitor is allowed to leave its generated cordova support files,
 * but a missing or changed source asset is a hard readiness failure.
 */
export function verifyAndroidWebAssetCopy(repoRoot) {
  const sourceRoot = resolve(repoRoot, 'tavern-app');
  const androidRoot = resolve(repoRoot, 'android', 'app', 'src', 'main', 'assets', 'public');
  if (!existsSync(sourceRoot) || !existsSync(androidRoot)) fail('ANDROID_WEB_ASSET_SYNC: web roots missing');
  const generated = new Set(['cordova.js', 'cordova_plugins.js']);
  const sourceFiles = relativeFiles(sourceRoot);
  const androidFiles = relativeFiles(androidRoot);
  for (const relativePath of sourceFiles) {
    const sourcePath = resolve(sourceRoot, relativePath);
    const androidPath = resolve(androidRoot, relativePath);
    if (!existsSync(androidPath) || sha256(readFileSync(sourcePath)) !== sha256(readFileSync(androidPath))) {
      fail(`ANDROID_WEB_ASSET_SYNC: stale or missing ${relativePath}`);
    }
  }
  for (const relativePath of androidFiles) {
    if (!sourceFiles.includes(relativePath) && !generated.has(relativePath)) {
      fail(`ANDROID_WEB_ASSET_SYNC: unexpected copied asset ${relativePath}`);
    }
  }
  return Object.fromEntries(sourceFiles.map(relativePath => [relativePath,
    sha256(readFileSync(resolve(sourceRoot, relativePath)))]));
}

function validateConnectedWrapper(value, root, candidateReleaseId, manifestDevice, now, manifest) {
  exactKeys(value, [
    'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt', 'deviceSerial', 'results', 'schemaVersion',
    'sourceRaceOverallChecksum', 'sourceRaceReportSha256', 'sourceRegistryChecksum',
    'replacements', 'sourceHead', 'startedAt', 'testClass', 'xmlPath', 'xmlSha256'
  ], 'connected report');
  if (value.schemaVersion !== 'yuqi-v3-connected-device-report-v1'
    || value.candidateReleaseId !== candidateReleaseId
    || value.deviceSerial !== manifestDevice
    || typeof value.deviceSerial !== 'string' || value.deviceSerial.length === 0
    || value.testClass !== CONNECTED_DEVICE_RACE_TEST_CLASS
    || !safeTime(value.startedAt, now) || !safeTime(value.completedAt, now)
    || value.completedAt < value.startedAt || !/^[a-f0-9]{64}$/.test(value.xmlSha256)) fail('connected report identity');
  if ((value.sourceHead ?? null) !== (manifest.sourceHead ?? null)
    || (candidateReleaseId !== null && !/^[a-f0-9]{40}$/.test(value.sourceHead || ''))) {
    fail('connected report sourceHead');
  }
  if (value.candidateReleaseId === null) {
    if (value.candidateReleaseChecksum !== null) fail('connected candidate checksum pair');
  } else if (!/^[a-f0-9]{64}$/.test(value.candidateReleaseChecksum || '')) {
    fail('connected candidate checksum');
  }
  if (!Array.isArray(value.replacements)
    || JSON.stringify(value.replacements) !== JSON.stringify(CONNECTED_DEVICE_RACE_NAMES)
    || !/^[a-f0-9]{64}$/.test(value.sourceRaceReportSha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.sourceRaceOverallChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.sourceRegistryChecksum || '')) fail('connected source race binding');
  const raceDescriptor = manifest.artifacts?.races;
  const raceFile = raceDescriptor && safePath(root, raceDescriptor.path);
  if (!raceFile || !existsSync(raceFile)) fail('connected source race missing');
  const raceBytes = readFileSync(raceFile);
  if (sha256(raceBytes) !== value.sourceRaceReportSha256) fail('connected source race bytes');
  let raceReport;
  try { raceReport = JSON.parse(raceBytes.toString('utf8')); } catch { fail('connected source race JSON'); }
  if (raceReport.overallChecksum !== value.sourceRaceOverallChecksum
    || raceReport.registryChecksum !== value.sourceRegistryChecksum
    || !Array.isArray(raceReport.connectedAndroidCases)
    || JSON.stringify(raceReport.connectedAndroidCases.map(row => row?.id))
      !== JSON.stringify(CONNECTED_DEVICE_RACE_NAMES)
    || raceReport.connectedAndroidCases.some(row => row?.status !== 'pending_connected_android'
      || row?.passed !== 0 || row?.failed !== 0 || row?.skipped !== 0)) fail('connected source race registry');
  const xmlFile = safePath(root, value.xmlPath);
  if (!xmlFile || !existsSync(xmlFile)) fail('connected XML path');
  const xmlBytes = readFileSync(xmlFile);
  if (sha256(xmlBytes) !== value.xmlSha256 || statSync(xmlFile).mtimeMs + 1 < value.startedAt) fail('connected XML bytes/mtime');
  if (!parseConnectedTestResults(xmlBytes.toString('utf8')).ready) fail('connected XML results');
  if (!value.results || typeof value.results !== 'object' || Array.isArray(value.results)
    || JSON.stringify(Object.keys(value.results).sort()) !== JSON.stringify([...CONNECTED_DEVICE_RACE_NAMES].sort())) fail('connected result set');
  for (const name of CONNECTED_DEVICE_RACE_NAMES) {
    const result = value.results[name];
    exactKeys(result, ['checksum', 'failed', 'name', 'passed', 'skipped', 'status'], `connected result ${name}`);
    if (result.name !== name || result.status !== 'passed'
      || result.passed !== 1 || result.failed !== 0 || result.skipped !== 0
      || !/^[a-f0-9]{64}$/.test(result.checksum)
      || result.checksum !== sha256({ name, status: result.status, passed: result.passed, failed: result.failed, skipped: result.skipped })) fail(`connected result ${name}`);
  }
}

function validateQualityReport(value, manifest = null) {
  if (value && value.version === 1 && value.eligible === false && value.productionReleaseMutation === false
    && Object.prototype.hasOwnProperty.call(value, 'blockingReason')) {
    exactKeys(value, QUALITY_BLOCKED_KEYS, 'quality blocked report');
    if (!Array.isArray(value.failedGates) || value.failedGates.length === 0
      || value.failedGates.some(code => typeof code !== 'string' || code.length === 0)
      || typeof value.blockingReason !== 'string' || value.blockingReason.length === 0) {
      fail('quality blocked fields');
    }
    return { blocked: true };
  }
  exactKeys(value, QUALITY_TOP_LEVEL_KEYS, 'quality report');
  if (value.version !== 1 || value.productionReleaseMutation !== false
    || typeof value.eligible !== 'boolean' || !Array.isArray(value.failedGates)
    || !value.candidateRelease || typeof value.candidateRelease !== 'object'
    || typeof value.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(value.sourceHead)) {
    fail('quality report fields');
  }
  exactKeys(value.candidateRelease, QUALITY_RELEASE_KEYS, 'quality candidate release');
  if (typeof value.candidateRelease.releaseId !== 'string' || !value.candidateRelease.releaseId
    || !/^[a-f0-9]{64}$/.test(value.candidateRelease.releaseChecksum || '')) fail('quality candidate identity');
  if (manifest && (value.sourceHead !== manifest.sourceHead
    || value.candidateRelease.releaseId !== manifest.candidateReleaseId)) {
    fail('quality candidate binding');
  }
  if (!Number.isSafeInteger(value.candidateRelease.createdAt) || value.candidateRelease.createdAt < 0
    || typeof value.candidateRelease.componentManifest !== 'object' || value.candidateRelease.componentManifest === null) {
    fail('quality candidate native fields');
  }
  if (!/^[a-f0-9]{64}$/.test(value.planChecksum || '')
    || !value.replayProvenance || typeof value.replayProvenance !== 'object'
    || !Array.isArray(value.replayProvenance.executionPairs)
    || !Array.isArray(value.replayProvenance.modelRuns)) fail('quality provenance');
  if (typeof value.replayRunId !== 'string' || !RUN_ID_PATTERN.test(value.replayRunId)
    || !/^[a-f0-9]{64}$/.test(value.qualityPlanSha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.qualityReplaySha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.qualityManualReviewSha256 || '')
    || value.replayProvenance.runId !== value.replayRunId) fail('quality raw bundle identity');
  exactKeys(value.qualityGate, QUALITY_GATE_KEYS, 'quality gate');
  exactKeys(value.manualReview, QUALITY_MANUAL_KEYS, 'quality manual review');
  if (typeof value.qualityGate.eligible !== 'boolean' || !Array.isArray(value.qualityGate.failedGates)
    || typeof value.manualReview.eligible !== 'boolean' || !Array.isArray(value.manualReview.failedGates)) {
    fail('quality nested fields');
  }
  if (value.eligible !== (value.qualityGate.eligible && value.manualReview.eligible)) fail('quality eligibility binding');
  if (value.eligible === true) {
    try {
      assertQualityReportProvenance(value.replayProvenance, {
        candidateRelease: value.candidateRelease,
        sourceHead: value.sourceHead
      });
    } catch (error) {
      fail(`quality replay provenance: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { blocked: false };
}

function assertUniqueInstrumentationXmlSource(sourceDirectory, attestation) {
  const sourceRoot = resolve(sourceDirectory);
  const resultRoot = resolve(
    sourceRoot, 'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected', 'debug');
  const attestedFile = resolve(sourceRoot, ...attestation.testXmlSourcePath.split('/'));
  const relativeAttested = relative(sourceRoot, attestedFile).replaceAll('\\', '/');
  if (relativeAttested !== attestation.testXmlSourcePath
    || relative(resultRoot, attestedFile).replaceAll('\\', '/').startsWith('../')
    || !existsSync(resultRoot) || !existsSync(attestedFile)) {
    fail('visible path metrics instrumentation XML source authority');
  }
  const candidates = [...instrumentationXmlSnapshots(sourceRoot).entries()]
    .filter(([file, snapshot]) => /^TEST-.*\.xml$/i.test(basename(file))
      && snapshot.mtimeMs >= attestation.instrumentationLaunchedAt
      && snapshot.sha256 === attestation.testXmlSha256)
    .map(([file, snapshot]) => ({ file: resolve(file), mtimeMs: snapshot.mtimeMs }));
  if (candidates.length !== 1 || candidates[0].file !== attestedFile
    || candidates[0].mtimeMs !== attestation.testXmlSourceMtimeMs) {
    fail('visible path metrics instrumentation XML source authority');
  }
}

function validateVisiblePathMetrics(
  value, manifest = null, now = Date.now(), root = null, sourceDirectory = root
) {
  exactKeys(value, [
    'androidExportPath', 'androidExportSha256', 'candidateReleaseChecksum', 'candidateReleaseId',
    'completedAt', 'deviceSerial', 'metadataSha256', 'metrics', 'pcExportPath', 'pcExportSha256',
    'producerAttestationChecksum', 'productionReleaseMutation', 'reportChecksum', 'runId', 'sampleSetChecksum', 'samples',
    'collectionAttestation',
    'schemaVersion', 'sourceHead', 'startedAt'
  ], 'visible path metrics');
  if (value.schemaVersion !== 'yuqi-v3-visible-path-metrics-v1'
    || value.productionReleaseMutation !== false
    || (value.candidateReleaseId === null) !== (value.candidateReleaseChecksum === null)
    || (value.sourceHead === null) !== (value.candidateReleaseId === null)
    || typeof value.deviceSerial !== 'string' || value.deviceSerial.length === 0
    || typeof value.runId !== 'string' || !RUN_ID_PATTERN.test(value.runId)) fail('visible path metrics identity');
  if (value.candidateReleaseChecksum !== null && !/^[a-f0-9]{64}$/.test(value.candidateReleaseChecksum)) fail('visible path metrics candidate checksum');
  if (value.sourceHead !== null && !/^[a-f0-9]{40}$/.test(value.sourceHead)) fail('visible path metrics sourceHead');
  if (!/^[a-f0-9]{64}$/.test(value.androidExportSha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.pcExportSha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.sampleSetChecksum || '')
    || !/^[a-f0-9]{64}$/.test(value.metadataSha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.producerAttestationChecksum || '')) fail('visible path metrics export checksums');
  if (manifest && ((value.candidateReleaseId ?? null) !== (manifest.candidateReleaseId ?? null)
    || (value.sourceHead ?? null) !== (manifest.sourceHead ?? null))) fail('visible path metrics candidate binding');
  if (value.androidExportPath !== 'private/visible-path-android.jsonl'
    || value.pcExportPath !== 'private/visible-path-pc.jsonl') fail('visible path metrics export paths');
  if (typeof root !== 'string') fail('visible path metrics evidence root');
  const androidFile = safePath(root, value.androidExportPath);
  const pcFile = safePath(root, value.pcExportPath);
  if (!androidFile || !pcFile || !existsSync(androidFile) || !existsSync(pcFile)) fail('visible path metrics export missing');
  const androidBytes = readFileSync(androidFile);
  const pcBytes = readFileSync(pcFile);
  if (sha256(androidBytes) !== value.androidExportSha256 || sha256(pcBytes) !== value.pcExportSha256) {
    fail('visible path metrics export checksum');
  }
  if (!safeTime(value.startedAt, now) || !safeTime(value.completedAt, now)
    || value.completedAt < value.startedAt) fail('visible path metrics timestamp');
  exactKeys(value.metrics, VISIBLE_PATH_METRIC_KEYS, 'visible path metrics fields');
  if (Object.values(value.metrics).some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0)) fail('visible path metrics native fields');
  if (!Array.isArray(value.samples) || value.samples.length === 0) fail('visible path metrics samples');
  const sampleWithoutId = sample => {
    const copy = { ...sample };
    delete copy.sampleId;
    return copy;
  };
  for (const sample of value.samples) {
    exactKeys(sample, VISIBLE_PATH_SAMPLE_KEYS, 'visible path metrics sample');
    if (!/^[a-f0-9]{64}$/.test(sample.sampleId || '')
      || !/^[a-f0-9]{64}$/.test(sample.turnIdSha256 || '')
      || !/^[a-f0-9]{64}$/.test(sample.authorityLineageKeySha256 || '')
      || !/^[a-f0-9]{64}$/.test(sample.visibleGroupIdSha256 || '')
      || !VISIBLE_PATH_KINDS.includes(sample.kind)
      || sample.pipelineReleaseId !== value.candidateReleaseId
      || !Number.isSafeInteger(sample.createdAt) || !Number.isSafeInteger(sample.uiAppliedAt)
      || !Number.isSafeInteger(sample.elapsedMs) || sample.elapsedMs < 0
      || sample.uiAppliedAt < sample.createdAt
      || sample.elapsedMs !== sample.uiAppliedAt - sample.createdAt
      || sample.createdAt < value.startedAt || sample.uiAppliedAt > value.completedAt
      || sample.terminalDisposition !== 'visible'
      || !['active_canary', 'live_shadow'].includes(sample.authorityMode)
      || sample.sampleId !== sha256(sampleWithoutId(sample))) {
      fail('visible path metrics sample fields');
    }
  }
  const parseJsonl = (bytes, label) => {
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (lines.length === 0) fail(`${label} rows`);
    if (lines.some(line => line.length === 0)) fail(`${label} blank line`);
    try { return lines.map(line => JSON.parse(line)); }
    catch { fail(`${label} JSON`); }
  };
  const androidRecords = parseJsonl(androidBytes, 'visible path metrics android export');
  const pcRecords = parseJsonl(pcBytes, 'visible path metrics pc export');
  const [androidMetadata, ...androidRows] = androidRecords;
  const [pcMetadata, ...pcRows] = pcRecords;
  exactKeys(androidMetadata, VISIBLE_PATH_ANDROID_METADATA_KEYS, 'visible path metrics android metadata');
  exactKeys(pcMetadata, VISIBLE_PATH_PC_METADATA_KEYS, 'visible path metrics pc metadata');
  if (androidMetadata.recordType !== 'metadata'
    || androidMetadata.schemaVersion !== 'yuqi-v3-visible-path-android-v1'
    || androidMetadata.candidateReleaseId !== value.candidateReleaseId
    || androidMetadata.deviceSerial !== value.deviceSerial
    || androidMetadata.runId !== value.runId
    || androidMetadata.startedAt !== value.startedAt
    || androidMetadata.completedAt !== value.completedAt
    || !safeTime(androidMetadata.startedAt, now) || !safeTime(androidMetadata.completedAt, now)
    || androidMetadata.completedAt < androidMetadata.startedAt) fail('visible path metrics android metadata');
  if (pcMetadata.recordType !== 'metadata'
    || pcMetadata.schemaVersion !== 'yuqi-v3-visible-path-pc-v1'
    || pcMetadata.candidateReleaseId !== value.candidateReleaseId
    || pcMetadata.candidateReleaseChecksum !== value.candidateReleaseChecksum
    || pcMetadata.runId !== value.runId
    || pcMetadata.sourceHead !== value.sourceHead
    || !Number.isSafeInteger(pcMetadata.startedAt) || !Number.isSafeInteger(pcMetadata.completedAt)
    || pcMetadata.startedAt !== value.startedAt || pcMetadata.completedAt !== value.completedAt
    || pcMetadata.completedAt < pcMetadata.startedAt) fail('visible path metrics pc metadata');
  let producerAttestations;
  try {
    producerAttestations = validateVisiblePathProducerAttestations({
      androidMetadata, androidRows, pcMetadata, pcRows
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (producerAttestations.checksum !== value.producerAttestationChecksum) {
    fail('visible path metrics producer attestation checksum');
  }
  if (value.collectionAttestation == null) fail('visible path metrics collection attestation required');
  let collectionAttestation;
  try {
    collectionAttestation = validateCollectionAttestation(value.collectionAttestation, {
      androidMetadata, pcMetadata,
      androidExportSha256: value.androidExportSha256,
      pcExportSha256: value.pcExportSha256
    });
  } catch (error) {
    fail(`visible path metrics collection attestation: ${error instanceof Error ? error.message : String(error)}`);
  }
  const startFile = safePath(root, 'private/visible-path-collection-start.json');
  const testXmlFile = safePath(root, 'private/visible-path-android-test.xml');
  if (!startFile || !testXmlFile || !existsSync(startFile) || !existsSync(testXmlFile)) {
    fail('visible path metrics collection start control or test XML missing');
  }
  let startControl;
  try {
    startControl = validateVisiblePathStartControl(JSON.parse(readFileSync(startFile, 'utf8')));
  } catch (error) {
    fail(`visible path metrics start control: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (startControl.checksum !== collectionAttestation.android.startControlChecksum
    || startControl.runId !== value.runId
    || startControl.sourceHead !== value.sourceHead
    || startControl.candidateReleaseId !== value.candidateReleaseId
    || startControl.candidateReleaseChecksum !== value.candidateReleaseChecksum
    || startControl.deviceSerial !== value.deviceSerial
    || startControl.startedAt !== value.startedAt
    || startControl.runtimeDatabasePathHash !== sha256(resolve(startControl.runtimeDatabasePath))) {
    fail('visible path metrics start control binding');
  }
  const testXmlBytes = readFileSync(testXmlFile);
  const testXml = testXmlBytes.toString('utf8');
  const suite = testXml.match(/<testsuite\b([^>]*)>/i)?.[1] || '';
  const cases = [...testXml.matchAll(/<testcase\b([^>]*)>/gi)];
  if (sha256(testXmlBytes) !== collectionAttestation.android.testXmlSha256
    || !/\btests="1"/i.test(suite) || !/\bfailures="0"/i.test(suite)
    || !/\berrors="0"/i.test(suite) || !/\bskipped="0"/i.test(suite)
    || cases.length !== 1
    || !/\bclassname="com\.siyi\.al\.execution\.YuqiVisiblePathExportTest"/i.test(cases[0][1])
    || !/\bname="exportCurrentDeviceVisiblePathArtifact"/i.test(cases[0][1])
    || /<skipped\b|<failure\b|<error\b/i.test(testXml)) {
    fail('visible path metrics instrumentation XML authority');
  }
  assertUniqueInstrumentationXmlSource(sourceDirectory, collectionAttestation.android);
  const androidDescriptor = collectionAttestation.android.commandDescriptor;
  const androidPullDescriptor = collectionAttestation.android.pullCommandDescriptor;
  const outputArgument = androidDescriptor.args.find(value =>
    String(value).startsWith('-Pandroid.testInstrumentationRunnerArguments.visiblePathOutputPath='));
  const outputPath = String(outputArgument || '').split('=').slice(1).join('=').replaceAll('\\', '/');
  if (!outputPath.startsWith('/')
    || !outputPath.endsWith(`/com.siyi.al/files/visible-path/${value.runId}/visible-path-android.jsonl`)) {
    fail('visible path metrics Android output authority');
  }
  const expectedAndroidArgs = [
    ':app:connectedDebugAndroidTest', '--no-daemon', '--no-problems-report',
    '-Pandroid.testInstrumentationRunnerArguments.class=com.siyi.al.execution.YuqiVisiblePathExportTest#exportCurrentDeviceVisiblePathArtifact',
    outputArgument,
    `-Pandroid.testInstrumentationRunnerArguments.candidateReleaseId=${value.candidateReleaseId}`,
    `-Pandroid.testInstrumentationRunnerArguments.deviceSerial=${value.deviceSerial}`,
    `-Pandroid.testInstrumentationRunnerArguments.runId=${value.runId}`,
    `-Pandroid.testInstrumentationRunnerArguments.selectionFrom=${value.startedAt}`,
    `-Pandroid.testInstrumentationRunnerArguments.selectionTo=${value.completedAt}`
  ];
  const expectedAndroidPullArgs = [
    '-s', value.deviceSerial, 'exec-out', 'run-as', 'com.siyi.al', 'cat', outputPath
  ];
  const pcDescriptor = collectionAttestation.pc.commandDescriptor;
  const expectedPcTail = [
    '--database', startControl.runtimeDatabasePath,
    '--out', pcFile,
    '--candidate-release-id', value.candidateReleaseId,
    '--candidate-release-checksum', value.candidateReleaseChecksum,
    '--source-head', value.sourceHead,
    '--run-id', value.runId,
    '--started-at', String(value.startedAt),
    '--completed-at', String(value.completedAt)
  ];
  if (!isAbsolute(androidDescriptor.command) || !/gradlew\.bat$/i.test(androidDescriptor.command)
    || canonical(androidDescriptor.args) !== canonical(expectedAndroidArgs)
    || canonical(androidDescriptor.environment) !== canonical({ ANDROID_SERIAL: value.deviceSerial })
    || !isAbsolute(androidPullDescriptor.command)
    || !/^adb(?:\.exe)?$/i.test(basename(androidPullDescriptor.command))
    || canonical(androidPullDescriptor.args) !== canonical(expectedAndroidPullArgs)
    || canonical(androidPullDescriptor.environment) !== canonical({})
    || pcDescriptor.command !== process.execPath
    || !isAbsolute(pcDescriptor.args[0] || '')
    || !/scripts[\\/]export-yuqi-visible-path-pc\.mjs$/i.test(pcDescriptor.args[0])
    || canonical(pcDescriptor.environment) !== canonical({})
    || canonical(pcDescriptor.args.slice(1)) !== canonical(expectedPcTail)) {
    fail('visible path metrics collection command authority');
  }
  if (androidRows.length !== value.samples.length || pcRows.length !== value.samples.length) {
    fail('visible path metrics export row count');
  }
  const rawAndroidKeys = VISIBLE_PATH_ANDROID_INPUT_ROW_KEYS;
  const rawPcKeys = VISIBLE_PATH_PC_INPUT_ROW_KEYS;
  const pcByJoin = new Map();
  for (let index = 0; index < androidRows.length; index += 1) {
    const android = androidRows[index];
    exactKeys(android, rawAndroidKeys, 'visible path metrics android export row');
    const { sampleId, authorityMode, ...sampleInput } = value.samples[index];
    const finalSample = { ...sampleInput, authorityMode };
    if (canonical(android) !== canonical(sampleInput)
      || sampleId !== sha256(finalSample)) fail('visible path metrics android export join');
  }
  for (const row of pcRows) {
    exactKeys(row, rawPcKeys, 'visible path metrics pc export row');
    const joinKey = canonical({
      authorityLineageKeySha256: row.authorityLineageKeySha256,
      turnIdSha256: row.turnIdSha256,
      visibleGroupIdSha256: row.visibleGroupIdSha256
    });
    if (pcByJoin.has(joinKey)) fail('visible path metrics pc export duplicate');
    pcByJoin.set(joinKey, row);
  }
  for (const sample of value.samples) {
    const row = pcByJoin.get(canonical({
      authorityLineageKeySha256: sample.authorityLineageKeySha256,
      turnIdSha256: sample.turnIdSha256,
      visibleGroupIdSha256: sample.visibleGroupIdSha256
    }));
    if (!row || row.turnIdSha256 !== sample.turnIdSha256
      || row.kind !== sample.kind || row.pipelineReleaseId !== sample.pipelineReleaseId
      || row.authorityLineageKeySha256 !== sample.authorityLineageKeySha256
      || row.visibleGroupIdSha256 !== sample.visibleGroupIdSha256
      || row.authorityMode !== sample.authorityMode) {
      fail('visible path metrics pc authority join');
    }
  }
  const activeSamples = value.samples.filter(sample => sample.authorityMode === 'active_canary');
  const directSamples = activeSamples.filter(sample => sample.kind === 'DIRECT_REPLY');
  if (directSamples.length < 20
    || VISIBLE_PATH_KINDS.some(kind => kind !== 'DIRECT_REPLY'
      && !activeSamples.some(sample => sample.kind === kind))) fail('visible path metrics sample coverage');
  if (value.sampleSetChecksum !== sha256(value.samples)) fail('visible path metrics sample set checksum');
  const metadata = {
    androidExportSha256: value.androidExportSha256,
    candidateReleaseChecksum: value.candidateReleaseChecksum,
    candidateReleaseId: value.candidateReleaseId,
    deviceSerial: value.deviceSerial,
    pcExportSha256: value.pcExportSha256,
    androidExportPath: value.androidExportPath,
    pcExportPath: value.pcExportPath,
    runId: value.runId,
    sampleSetChecksum: value.sampleSetChecksum,
    sourceHead: value.sourceHead
  };
  if (value.metadataSha256 !== sha256(metadata)) fail('visible path metrics metadata checksum');
  const sortedElapsed = directSamples.map(sample => sample.elapsedMs).sort((a, b) => a - b);
  const middle = Math.floor(sortedElapsed.length / 2);
  const derived = {
    directReplyMedianMs: sortedElapsed.length % 2 === 1
      ? sortedElapsed[middle] : (sortedElapsed[middle - 1] + sortedElapsed[middle]) / 2,
    directReplyP95Ms: sortedElapsed[Math.ceil(sortedElapsed.length * 0.95) - 1],
    maximumVisibleMs: Math.max(...value.samples.map(sample => sample.elapsedMs)),
    shadowBlockedVisibleCount: value.samples.filter(sample => sample.authorityMode === 'live_shadow' && sample.uiAppliedAt !== null).length
  };
  if (canonical(value.metrics) !== canonical(derived)) fail('visible path metrics derived values');
  const withoutChecksum = { ...value };
  delete withoutChecksum.reportChecksum;
  if (value.reportChecksum !== sha256(withoutChecksum)) fail('visible path metrics checksum');
}

function validateArtifactValue(key, value, root, manifest, now, sourceDirectory = root) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${key} value`);
  if (key === 'protocol' || key === 'androidFallback' || key === 'rolloutStatus') {
    try { validateReadinessInputReport(value); }
    catch (error) { fail(`${key} ${error.message}`); }
    if (CANDIDATE_BOUND_ARTIFACTS.has(key)
      && (value.candidateReleaseId ?? null) !== manifest.candidateReleaseId) fail(`${key} candidate`);
    if (CANDIDATE_BOUND_ARTIFACTS.has(key)
      && (value.sourceHead ?? null) !== (manifest.sourceHead ?? null)) fail(`${key} sourceHead`);
    return;
  }
  if (key === 'migrationClone') {
    exactKeys(value, ['path', 'semanticChecksum', 'tableCounts', 'userVersion'], 'migration clone');
    if (value.userVersion !== 15 || !/^[a-f0-9]{64}$/.test(value.semanticChecksum || '')) fail('migration clone identity');
    return;
  }
  if (key === 'visiblePathMetrics') {
    validateVisiblePathMetrics(value, manifest, now, root, sourceDirectory);
    return;
  }
  if (key === 'quality') {
    validateQualityReport(value, manifest);
    return;
  }
  if (key === 'qualityPlan') {
    try { assertVerifiedQualityReplayPlan(value); }
    catch (error) { fail(`quality plan ${error instanceof Error ? error.message : String(error)}`); }
    return;
  }
  if (key === 'qualityReplay' || key === 'qualityManualReview') {
    fail(`${key} JSONL must be loaded from raw lines`);
  }
  if (key === 'races') validateSourceRaceReport(value, manifest.candidateReleaseId);
  if (CANDIDATE_BOUND_ARTIFACTS.has(key)
    && (value.candidateReleaseId ?? null) !== manifest.candidateReleaseId) fail(`${key} candidate`);
  if (CANDIDATE_BOUND_ARTIFACTS.has(key)) {
    if ((value.sourceHead ?? null) !== (manifest.sourceHead ?? null)) fail(`${key} sourceHead`);
    if (manifest.candidateReleaseId !== null
      && (!/^[a-f0-9]{40}$/.test(value.sourceHead || '')
        || value.candidateReleaseId === null)) fail(`${key} candidate binding`);
  }
  if (key === 'baseline') {
    if (!/^[a-f0-9]{40}$/.test(value.gitHead || '')
      || !value.database || !/^[a-f0-9]{64}$/.test(value.database.sha256 || '')
      || value.database.sourceChangedDuringAudit !== undefined && value.database.sourceChangedDuringAudit !== false) {
      fail('baseline immutable anchor');
    }
    if (value.gitHead === manifest.sourceHead) fail('baseline must differ from candidate sourceHead');
  }
  if (key === 'migration') {
    validateMigrationReport(value);
  }
  if (key === 'nodeTests') {
    exactKeys(value, [
      'candidateReleaseChecksum', 'candidateReleaseId', 'exitCode', 'failed', 'outputSha256', 'passed',
      'sourceHead',
      'sentinel', 'skipped', 'tests'
    ], 'node test report');
    const sentinel = value.sentinel;
    exactKeys(sentinel, ['exitCode', 'failed', 'outputSha256', 'passed', 'path', 'skipped', 'tests'], 'sentinel');
    if (value.exitCode !== 0 || value.failed !== 0 || value.skipped !== 0
      || value.tests <= 0 || value.passed !== value.tests
      || !/^[a-f0-9]{64}$/.test(value.outputSha256)
      || sentinel.path !== 'yuqi-runtime/test/android-fallback-authority.test.mjs'
      || sentinel.exitCode !== 0 || sentinel.failed !== 0 || sentinel.skipped !== 0
      || sentinel.tests <= 0 || sentinel.passed !== sentinel.tests
      || !/^[a-f0-9]{64}$/.test(sentinel.outputSha256)) fail('node test outcome');
  }
  if (key === 'androidTests') {
    exactKeys(value, [
      'candidateReleaseChecksum', 'candidateReleaseId', 'deviceSerial', 'exitCode', 'failed', 'outputSha256',
      'passed', 'skipped', 'webAssetChecksums'
      , 'sourceHead'
    ], 'android test report');
    if (value.exitCode !== 0 || value.failed !== 0 || value.skipped !== 0
      || value.passed !== CONNECTED_DEVICE_RACE_NAMES.length
      || value.deviceSerial !== manifest.deviceSerial || !/^[a-f0-9]{64}$/.test(value.outputSha256)
      || !value.webAssetChecksums || typeof value.webAssetChecksums !== 'object'
      || Array.isArray(value.webAssetChecksums) || Object.keys(value.webAssetChecksums).length === 0
      || Object.entries(value.webAssetChecksums).some(([path, checksum]) =>
        typeof path !== 'string' || path.length === 0 || path.startsWith('/') || path.startsWith('\\')
        || path.split(/[\\/]/).includes('..') || !/^[a-f0-9]{64}$/.test(checksum))) fail('android test outcome');
  }
  if (key === 'connectedDeviceRaces') validateConnectedWrapper(value, root, manifest.candidateReleaseId, manifest.deviceSerial, now, manifest);
}

export function loadReadinessManifest({ manifestPath, evidenceDirectory, sourceDirectory = evidenceDirectory }) {
  if (typeof manifestPath !== 'string' || typeof evidenceDirectory !== 'string') fail('manifest arguments');
  const root = resolve(evidenceDirectory);
  const file = safePath(root, relative(root, resolve(manifestPath)));
  if (!file || !existsSync(file)) fail('manifest path');
  let manifest;
  try { manifest = JSON.parse(readFileSync(file, 'utf8')); } catch { fail('manifest JSON'); }
  exactKeys(manifest, [
    'artifacts', 'candidateReleaseId', 'createdAt', 'deviceSerial',
    'schemaVersion', 'sourceHead'
  ], 'manifest');
  if (manifest.schemaVersion !== 'yuqi-v3-readiness-input-v1'
    || (manifest.candidateReleaseId !== null
      && (typeof manifest.candidateReleaseId !== 'string' || manifest.candidateReleaseId.length === 0))
    || typeof manifest.sourceHead !== 'string' || !/^[a-f0-9]{40}$/.test(manifest.sourceHead)
    || typeof manifest.deviceSerial !== 'string' || manifest.deviceSerial.length === 0
    || !safeTime(manifest.createdAt, Date.now())) fail('manifest identity');
  exactKeys(manifest.artifacts, READINESS_ARTIFACT_NAMES, 'artifact set');
  const artifacts = {};
  for (const name of READINESS_ARTIFACT_NAMES) {
    const descriptor = manifest.artifacts[name];
    exactKeys(descriptor, ['path', 'sha256'], `${name} descriptor`);
    if (!/^[a-f0-9]{64}$/.test(descriptor.sha256)) fail(`${name} checksum shape`);
    const artifactFile = safePath(root, descriptor.path);
    if (!artifactFile || !existsSync(artifactFile)) fail(`${name} artifact missing`);
    const bytes = readFileSync(artifactFile);
    const actual = sha256(bytes);
    if (actual !== descriptor.sha256) fail(`${name} checksum`);
    if (name === 'migrationClone') {
      const migration = artifacts.migration?.value;
      if (!migration) fail('migration clone migration binding');
      const cloneValue = readMigrationClone(artifactFile, migration);
      artifacts[name] = { path: descriptor.path, sha256: actual, value: {
        path: descriptor.path,
        userVersion: cloneValue.userVersion,
        tableCounts: cloneValue.tableCounts,
        semantic: cloneValue.semantic
      } };
      continue;
    }
    let value;
    try {
      if (name === 'qualityReplay' || name === 'qualityManualReview') {
        value = bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
          try { return JSON.parse(line); } catch { fail(`${name} line ${index + 1} JSON`); }
        });
      } else {
        value = JSON.parse(bytes.toString('utf8'));
      }
    } catch { fail(`${name} JSON`); }
    if ((name === 'qualityReplay' || name === 'qualityManualReview')
      && (!Array.isArray(value) || value.length === 0)) fail(`${name} rows`);
    if (name === 'qualityReplay' || name === 'qualityManualReview') {
      if (value.some(row => !row || typeof row !== 'object' || Array.isArray(row)
        || typeof row.recordType !== 'string' || typeof row.runId !== 'string')) fail(`${name} row schema`);
      artifacts[name] = { path: descriptor.path, sha256: actual, value };
      continue;
    }
    validateArtifactValue(name, value, root, manifest, Date.now(), resolve(sourceDirectory));
    artifacts[name] = { path: descriptor.path, sha256: actual, value };
  }
  const qualityValue = artifacts.quality?.value;
  if (qualityValue && qualityValue.eligible !== false && manifest.candidateReleaseId !== null) {
    const qualityChecksum = qualityValue.candidateRelease?.releaseChecksum;
    if (!/^[a-f0-9]{64}$/.test(qualityChecksum || '')) fail('quality candidate checksum');
    for (const name of CANDIDATE_BOUND_ARTIFACTS) {
      if (name === 'quality') continue;
      const candidate = artifacts[name]?.value;
      if (candidate && candidate.candidateReleaseId === manifest.candidateReleaseId
        && candidate.candidateReleaseChecksum !== qualityChecksum) {
        fail('quality candidate checksum binding');
      }
    }
  }
  if (artifacts.qualityPlan?.value && artifacts.qualityReplay?.value && artifacts.qualityManualReview?.value) {
    if (!qualityValue || qualityValue.eligible !== true) fail('quality raw bundle requires eligible report');
    try {
      const bundle = validateQualityArtifactBundle({
        plan: artifacts.qualityPlan.value,
        replayArtifactPath: join(root, artifacts.qualityReplay.path),
        manualReviewArtifactPath: join(root, artifacts.qualityManualReview.path),
        candidateRelease: qualityValue.candidateRelease,
        qualityReport: qualityValue
      });
      const rawPlanSha = sha256(readFileSync(join(root, artifacts.qualityPlan.path)));
      if (qualityValue.qualityPlanSha256 !== rawPlanSha
        || qualityValue.qualityReplaySha256 !== artifacts.qualityReplay.sha256
        || qualityValue.qualityManualReviewSha256 !== artifacts.qualityManualReview.sha256) {
        fail('quality raw artifact checksum binding');
      }
      if (bundle.runId !== qualityValue.replayRunId) fail('quality replay run binding');
    } catch (error) {
      fail(`quality raw bundle ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const evidence = {
    schemaVersion: manifest.schemaVersion,
    candidateReleaseId: manifest.candidateReleaseId,
    sourceHead: manifest.sourceHead,
    createdAt: manifest.createdAt,
    deviceSerial: manifest.deviceSerial,
    artifacts,
    metrics: artifacts.visiblePathMetrics?.value?.metrics ?? null,
    inputSha256: sha256(readFileSync(file))
  };
  loadedManifests.add(evidence);
  return evidence;
}

export function verifyReadiness(evidence) {
  if (!loadedManifests.has(evidence)) fail('verifyReadiness requires loadReadinessManifest');
  const failedGates = [];
  for (const name of READINESS_ARTIFACT_NAMES) {
    if (!evidence.artifacts?.[name]) failedGates.push(`MISSING_${name.toUpperCase()}`);
  }
  const candidateValues = ['protocol', 'androidFallback', 'rolloutStatus', 'visiblePathMetrics', 'nodeTests', 'androidTests', 'connectedDeviceRaces']
    .map(name => evidence.artifacts[name]?.value?.candidateReleaseId ?? null);
  candidateValues.push(evidence.artifacts.quality?.value?.candidateRelease?.releaseId ?? null);
  if (candidateValues.some(value => value !== evidence.candidateReleaseId)) failedGates.push('CANDIDATE_RELEASE_MISMATCH');
  const candidateChecksums = ['protocol', 'androidFallback', 'rolloutStatus', 'visiblePathMetrics', 'nodeTests', 'androidTests', 'connectedDeviceRaces']
    .map(name => evidence.artifacts[name]?.value?.candidateReleaseChecksum ?? null);
  const qualityRelease = evidence.artifacts.quality?.value?.candidateRelease;
  if (evidence.candidateReleaseId !== null
    && (!qualityRelease || qualityRelease.releaseId !== evidence.candidateReleaseId
      || !/^[a-f0-9]{64}$/.test(qualityRelease.releaseChecksum || '')
      || candidateChecksums.some(value => value !== qualityRelease.releaseChecksum))) {
    failedGates.push('CANDIDATE_RELEASE_CHECKSUM_MISMATCH');
  }
  if (evidence.candidateReleaseId === null && candidateChecksums.some(value => value !== null)) {
    failedGates.push('CANDIDATE_RELEASE_CHECKSUM_WITHOUT_ID');
  }
  if (evidence.artifacts.androidTests?.value?.deviceSerial !== evidence.deviceSerial
    || evidence.artifacts.connectedDeviceRaces?.value?.deviceSerial !== evidence.deviceSerial) failedGates.push('DEVICE_SERIAL_MISMATCH');
  const metrics = evidence.artifacts.visiblePathMetrics?.value?.metrics;
  if (!metrics || typeof metrics !== 'object') failedGates.push('METRICS_EVIDENCE_UNAVAILABLE');
  const safeMetrics = metrics || { directReplyMedianMs: 0, directReplyP95Ms: 0, maximumVisibleMs: 0, shadowBlockedVisibleCount: 0 };
  if (safeMetrics.directReplyMedianMs > 60_000) failedGates.push('DIRECT_MEDIAN_ABOVE_TARGET');
  if (safeMetrics.directReplyP95Ms > 180_000) failedGates.push('DIRECT_P95_ABOVE_THREE_MINUTES');
  if (safeMetrics.maximumVisibleMs > 300_000) failedGates.push('VISIBLE_REPLY_ABOVE_HARD_LIMIT');
  if (safeMetrics.shadowBlockedVisibleCount > 0) failedGates.push('SHADOW_BLOCKED_VISIBLE_PATH');
  if (evidence.artifacts.quality?.value?.eligible !== true) failedGates.push('QUALITY_INCOMPLETE');
  const raceSource = evidence.artifacts.races?.value;
  const connectedReplacementComplete = JSON.stringify(evidence.artifacts.connectedDeviceRaces?.value?.replacements || [])
    === JSON.stringify(CONNECTED_DEVICE_RACE_NAMES);
  const pcCasesComplete = Array.isArray(raceSource?.pcCases)
    && raceSource.pcCases.length === PC_RACE_NAMES.length
    && raceSource.pcCases.every(row => row.status === 'passed'
      && row.passed === 1 && row.failed === 0 && row.skipped === 0);
  if (raceSource?.releaseEligible !== true && !(pcCasesComplete && connectedReplacementComplete)) {
    failedGates.push('RACES_INCOMPLETE');
  }
  if (evidence.artifacts.protocol?.value?.status !== 'passed') failedGates.push('PROTOCOL_INCOMPLETE');
  if (evidence.artifacts.androidFallback?.value?.status !== 'passed') failedGates.push('ANDROID_FALLBACK_INCOMPLETE');
  if (evidence.artifacts.rolloutStatus?.value?.status !== 'available') failedGates.push('ROLLOUT_INCOMPLETE');
  const rollout = evidence.artifacts.rolloutStatus?.value;
  if (rollout?.status === 'available') {
    if (rollout.userVersion !== 15) failedGates.push('ROLLOUT_SCHEMA_VERSION');
    if (!Array.isArray(rollout.kinds) || rollout.kinds.length !== 10
      || rollout.kinds.some(row => row.candidatePhase !== 'stable'
        || row.candidateReleaseId !== evidence.candidateReleaseId)) {
      failedGates.push('ROLLOUT_NOT_V3_STABLE');
    }
  }
  if (evidence.candidateReleaseId === null) failedGates.push('CANDIDATE_RELEASE_UNAVAILABLE');
  const checksums = Object.fromEntries(READINESS_ARTIFACT_NAMES.map(name => [name, evidence.artifacts[name]?.sha256 || null]));
  return { ready: failedGates.length === 0, failedGates, candidateReleaseId: evidence.candidateReleaseId, checksums };
}

export function materializeReadinessReport(evidence, { startedAt, completedAt = Date.now() } = {}) {
  if (!loadedManifests.has(evidence)) fail('report requires loadReadinessManifest');
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt)
    || startedAt < 0 || completedAt < startedAt || completedAt > Date.now()) fail('report timestamps');
  const result = verifyReadiness(evidence);
  const report = {
    schemaVersion: 'yuqi-v3-readiness-report-v1',
    ready: result.ready,
    failedGates: result.failedGates,
    candidateReleaseId: evidence.candidateReleaseId,
    sourceHead: evidence.sourceHead,
    inputSha256: evidence.inputSha256,
    artifactChecksums: result.checksums,
    deviceSerial: evidence.deviceSerial,
    startedAt,
    completedAt
  };
  return { ...report, reportChecksum: sha256(report) };
}

export function materializeBlockedReadinessReport({
  failedGate = 'CONNECTED_DEVICE_RACES_INCOMPLETE', failedGates = null,
  startedAt = Date.now(),
  completedAt = Date.now(),
  candidateReleaseId = null,
  sourceHead = null,
  deviceSerial = null
} = {}) {
  if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(completedAt)
    || startedAt < 0 || completedAt < startedAt || completedAt > Date.now()) fail('blocked report timestamps');
  const report = {
    schemaVersion: 'yuqi-v3-readiness-report-v1',
    ready: false,
    failedGates: Array.isArray(failedGates) && failedGates.length ? [...failedGates] : [failedGate],
    candidateReleaseId: null,
    sourceHead: null,
    inputSha256: null,
    artifactChecksums: Object.fromEntries(READINESS_ARTIFACT_NAMES.map(name => [name, null])),
    deviceSerial: null,
    startedAt,
    completedAt
  };
  return { ...report, reportChecksum: sha256(report) };
}

export async function writeReadinessReportExclusive({
  outPath, evidenceDirectory, repoRoot = process.cwd(), report
}) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('readiness report value');
  const scope = assertEvidenceDirectoryScope(repoRoot, evidenceDirectory);
  const target = assertEvidencePath(scope, resolve(outPath));
  if (existsSync(target)) fail('readiness report already exists');
  await mkdir(dirname(target), { recursive: true });
  assertEvidenceDirectoryScope(repoRoot, evidenceDirectory);
  assertEvidencePath(scope, target);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  assertEvidencePath(scope, target, { allowMissing: false });
  return target;
}

async function runCommand(command, args, cwd, env = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    });
    const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { command, args, exitCode: 0, output: raw, outputSha256: sha256(raw), durationMs: Date.now() - startedAt };
  } catch (error) {
    const raw = `${error.stdout || ''}\n${error.stderr || ''}`;
    return { command, args, exitCode: Number(error.code || 1), output: raw, outputSha256: sha256(raw), durationMs: Date.now() - startedAt };
  }
}

export function preflightFixedReadinessInputs(directory, {
  allowPendingVisiblePathMetrics = false,
  sourceDirectory = directory
} = {}) {
  const failedGates = [];
  const values = {};
  for (const [key, filename] of Object.entries(FIXED_INPUT_FILES)) {
    const file = join(directory, filename);
    if (!existsSync(file)) {
      if (key === 'visiblePathMetrics' && allowPendingVisiblePathMetrics) continue;
      failedGates.push(`MISSING_FIXED_${key.toUpperCase()}`);
      continue;
    }
    try {
      if (key === 'migrationClone') {
        const migration = values.migration;
        if (!migration) throw new Error('migration clone migration binding');
        values[key] = readMigrationClone(file, migration);
        continue;
      }
      if (key === 'qualityReplay' || key === 'qualityManualReview') {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
        if (lines.length === 0) throw new Error('empty raw quality artifact');
        values[key] = lines.map(line => JSON.parse(line));
        continue;
      }
      values[key] = JSON.parse(readFileSync(file, 'utf8'));
      if (key === 'protocol' || key === 'androidFallback' || key === 'rolloutStatus') {
        validateReadinessInputReport(values[key]);
      }
      if (key === 'visiblePathMetrics') {
        validateVisiblePathMetrics(values[key], null, Date.now(), directory, sourceDirectory);
      }
      if (key === 'baseline'
        && (!/^[a-f0-9]{40}$/.test(values[key].gitHead || '')
          || !/^[a-f0-9]{64}$/.test(values[key].database?.sha256 || ''))) {
        failedGates.push('FIXED_BASELINE_SCHEMA');
      }
      if (key === 'migration'
        ) {
        try { validateMigrationReport(values[key]); }
        catch { failedGates.push('FIXED_MIGRATION_SCHEMA'); }
      }
      if (key === 'quality') {
        try { validateQualityReport(values[key]); }
        catch { failedGates.push('QUALITY_REPORT_INVALID'); }
      }
      if (key === 'races' && typeof values[key].releaseEligible !== 'boolean') {
        failedGates.push('RACE_REPORT_INVALID');
      }
    } catch (error) {
      failedGates.push(`FIXED_${key.toUpperCase()}_INVALID`);
    }
  }
  const qualityRelease = values.quality?.eligible === true ? values.quality.candidateRelease : null;
  const qualityCandidate = qualityRelease?.releaseId || null;
  if (values.quality?.eligible === true
    && (!qualityRelease || typeof qualityRelease.releaseId !== 'string'
      || qualityRelease.releaseId.length === 0
      || !/^[a-f0-9]{64}$/.test(qualityRelease.releaseChecksum || ''))) {
    failedGates.push('QUALITY_CANDIDATE_UNAVAILABLE');
  }
  if ((!values.visiblePathMetrics || !values.visiblePathMetrics.metrics)
    && !allowPendingVisiblePathMetrics) failedGates.push('METRICS_EVIDENCE_UNAVAILABLE');
  if (values.races && qualityCandidate) {
    try { validateSourceRaceReport(values.races, qualityCandidate); }
    catch { failedGates.push('RACE_REPORT_INVALID'); }
  }
  return { failedGates, values, candidateReleaseId: qualityCandidate };
}

export async function preflightSourceTree(repoRoot, commandRunner, evidenceDirectory = null) {
  const scope = evidenceDirectory
    ? assertEvidenceDirectoryScope(repoRoot, evidenceDirectory)
    : null;
  const head = await commandRunner('git', ['rev-parse', 'HEAD'], repoRoot);
  const sourceHead = String(head.output || '').trim();
  const failedGates = [];
  let status;
  try {
    const statusArgs = evidenceDirectory
      ? gitStatusArgsForEvidence(repoRoot, evidenceDirectory)
      : ['status', '--porcelain=v1', '-z', '--untracked-files=all'];
    status = await commandRunner('git', statusArgs, repoRoot);
  } catch {
    failedGates.push('SOURCE_TREE_NOT_IMMUTABLE');
    status = { exitCode: 1, output: '' };
  }
  if (head.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(sourceHead)) failedGates.push('SOURCE_HEAD_UNAVAILABLE');
  if ((status.exitCode !== 0 || Buffer.byteLength(String(status.output || ''), 'utf8') > 0)
    && !failedGates.includes('SOURCE_TREE_NOT_IMMUTABLE')) failedGates.push('SOURCE_TREE_NOT_IMMUTABLE');
  const outsideEvidenceStatusChecksum = sha256(Buffer.from(String(status.output || ''), 'utf8'));
  const authorityBase = {
    evidenceDirectoryRealpath: scope?.realEvidence || null,
    outsideEvidenceStatusChecksum,
    sourceHead: /^[a-f0-9]{40}$/.test(sourceHead) ? sourceHead : null
  };
  return {
    ...authorityBase,
    authorityChecksum: sha256(authorityBase),
    failedGates
  };
}

function sameSourceAuthority(left, right) {
  return left?.authorityChecksum === right?.authorityChecksum
    && left?.sourceHead === right?.sourceHead
    && left?.evidenceDirectoryRealpath === right?.evidenceDirectoryRealpath
    && left?.outsideEvidenceStatusChecksum === right?.outsideEvidenceStatusChecksum;
}

export async function verifyReadinessFromDirectory({
  evidenceDir,
  run = false,
  commandRunner = runCommand,
  repoRoot = process.cwd(),
  runtimeConfig = resolve(repoRoot, 'yuqi-runtime', 'config.json'),
  formalFinalizer = finalizeVisiblePathCollection,
  productionInputsLoader = loadVisiblePathProductionInputs
} = {}) {
  const directory = resolve(evidenceDir || 'artifacts/yuqi-lived-agency-v3');
  assertEvidenceDirectoryScope(repoRoot, directory);
  await mkdir(directory, { recursive: true });
  const evidenceScope = assertEvidenceDirectoryScope(repoRoot, directory);
  if (!run) {
    const evidence = loadReadinessManifest({
      manifestPath: join(directory, 'readiness-input.json'), evidenceDirectory: directory,
      sourceDirectory: repoRoot
    });
    return materializeReadinessReport(evidence, {
      startedAt: evidence.createdAt,
      completedAt: Date.now()
    });
  }

  const startedAt = Date.now();
  const startControlPath = join(directory, 'private', 'visible-path-collection-start.json');
  const hasStartControl = existsSync(startControlPath);
  const fixedPreflight = preflightFixedReadinessInputs(directory, {
    allowPendingVisiblePathMetrics: hasStartControl,
    sourceDirectory: repoRoot
  });
  if (!hasStartControl) fixedPreflight.failedGates.push('MISSING_VISIBLE_PATH_COLLECTION_START');
  if (fixedPreflight.failedGates.length > 0) {
    return materializeBlockedReadinessReport({
      failedGates: fixedPreflight.failedGates,
      startedAt,
      completedAt: Date.now(),
      candidateReleaseId: fixedPreflight.candidateReleaseId || null
    });
  }
  const initialSourcePreflight = await preflightSourceTree(repoRoot, commandRunner, directory);
  if (initialSourcePreflight.sourceHead !== fixedPreflight.values.quality?.sourceHead) {
    initialSourcePreflight.failedGates.push('SOURCE_HEAD_MISMATCH');
  }
  if (initialSourcePreflight.failedGates.length > 0) {
    return materializeBlockedReadinessReport({
      failedGates: initialSourcePreflight.failedGates,
      startedAt, completedAt: Date.now(),
      candidateReleaseId: fixedPreflight.candidateReleaseId || null,
      sourceHead: null
    });
  }
  const candidateReleaseId = fixedPreflight.values.quality?.candidateRelease?.releaseId;
  const candidateReleaseChecksum = fixedPreflight.values.quality?.candidateRelease?.releaseChecksum;
  let productionInputs;
  try {
    productionInputs = await productionInputsLoader({ evidenceDir: directory, runtimeConfig, repoRoot });
  } catch {
    return materializeBlockedReadinessReport({
      failedGate: 'FORMAL_RUNTIME_PREFLIGHT_FAILED',
      startedAt, completedAt: Date.now(),
      candidateReleaseId: candidateReleaseId || null,
      sourceHead: null
    });
  }
  const preFormalSource = await preflightSourceTree(repoRoot, commandRunner, directory);
  if (!sameSourceAuthority(initialSourcePreflight, preFormalSource)
    || preFormalSource.sourceHead !== fixedPreflight.values.quality?.sourceHead) {
    preFormalSource.failedGates.push('SOURCE_AUTHORITY_CHANGED');
  }
  if (preFormalSource.failedGates.length > 0) {
    return materializeBlockedReadinessReport({
      failedGates: preFormalSource.failedGates,
      startedAt, completedAt: Date.now(),
      candidateReleaseId: candidateReleaseId || null,
      sourceHead: null
    });
  }
  const formalOptions = {
    evidenceDir: directory, runtimeConfig, repoRoot,
    candidateReleaseId, candidateReleaseChecksum,
    expectedSourceHead: fixedPreflight.values.quality?.sourceHead,
    ...productionInputs
  };
  try {
    await formalFinalizer(formalOptions);
  } catch {
    return materializeBlockedReadinessReport({
      failedGate: 'FORMAL_VISIBLE_PATH_COLLECTION_FAILED',
      startedAt, completedAt: Date.now()
    });
  }
  if (!existsSync(join(directory, FIXED_INPUT_FILES.visiblePathMetrics))) {
    return materializeBlockedReadinessReport({
      failedGate: 'FORMAL_VISIBLE_PATH_COLLECTION_FAILED',
      startedAt, completedAt: Date.now()
    });
  }
  const finalizedPreflight = preflightFixedReadinessInputs(directory, { sourceDirectory: repoRoot });
  if (finalizedPreflight.failedGates.length > 0) {
    return materializeBlockedReadinessReport({
      failedGates: finalizedPreflight.failedGates,
      startedAt, completedAt: Date.now()
    });
  }
  const sourcePreflight = await preflightSourceTree(repoRoot, commandRunner, directory);
  if (!sameSourceAuthority(initialSourcePreflight, sourcePreflight)) {
    sourcePreflight.failedGates.push('SOURCE_AUTHORITY_CHANGED');
  }
  if (sourcePreflight.failedGates.length > 0) {
    return materializeBlockedReadinessReport({
      failedGates: sourcePreflight.failedGates, startedAt, completedAt: Date.now(),
      candidateReleaseId: fixedPreflight.candidateReleaseId || null,
      sourceHead: null
    });
  }
  const adb = await commandRunner(resolveAdbExecutable(repoRoot), ['devices', '-l'], repoRoot);
  const selected = selectAdbDevice(adb.output, process.env.ANDROID_SERIAL || '');
  const runId = runIdFor(startedAt);
  const runDirectory = join(directory, runId);
  assertEvidencePath(evidenceScope, runDirectory);
  await mkdir(runDirectory, { recursive: true });
  assertEvidencePath(evidenceScope, runDirectory, { allowMissing: false });

  const npmExecutable = resolveNpmExecutable();
  const webAssetChecksums = verifyAndroidWebAssetCopy(repoRoot);

  const nodeResult = await commandRunner(npmExecutable, ['test'], repoRoot);
  const sentinelPath = 'yuqi-runtime/test/android-fallback-authority.test.mjs';
  const sentinelResult = await commandRunner(
    process.execPath,
    ['--test', sentinelPath],
    repoRoot
  );
  const xmlRoot = resolve(repoRoot, 'android', 'app', 'build', 'outputs', 'androidTest-results', 'connected');
  const xmlBeforeRun = connectedXmlSnapshots(xmlRoot);
  const androidResult = await commandRunner(
    resolve(repoRoot, 'android', 'gradlew.bat'),
    [
      'testDebugUnitTest', 'assembleDebugAndroidTest', 'connectedDebugAndroidTest',
      `-Pandroid.testInstrumentationRunnerArguments.class=${CONNECTED_DEVICE_RACE_TEST_CLASS}`,
      '--rerun-tasks', '--no-daemon', '--no-problems-report'
    ],
    resolve(repoRoot, 'android'),
    { ANDROID_SERIAL: selected }
  );

  const fixed = {};
  for (const [key, filename] of Object.entries(FIXED_INPUT_FILES)) {
    const file = join(directory, filename);
    if (!existsSync(file)) fail(`READINESS_INPUT_UNAVAILABLE: ${filename}`);
    let value;
    if (key === 'migrationClone') {
      value = readMigrationClone(file, fixed.migration.value);
    } else if (key === 'qualityReplay' || key === 'qualityManualReview') {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
      if (!lines.length) fail(`fixed artifact ${key} rows`);
      value = lines.map(line => JSON.parse(line));
    } else {
      try { value = JSON.parse(readFileSync(file, 'utf8')); } catch { fail(`fixed artifact ${key} JSON`); }
    }
    fixed[key] = { filename, value, sha256: sha256(readFileSync(file)) };
  }
  const fixedCandidateReleaseId = fixed.quality.value.candidateRelease?.releaseId;
  const fixedCandidateReleaseChecksum = fixed.quality.value.candidateRelease?.releaseChecksum;
  const sourceHead = sourcePreflight.sourceHead;
  const metrics = fixed.visiblePathMetrics.value.metrics;
  if (typeof fixedCandidateReleaseId !== 'string' || fixedCandidateReleaseId.length === 0
    || typeof sourceHead !== 'string' || sourceHead.length === 0
    || !/^[a-f0-9]{64}$/.test(fixedCandidateReleaseChecksum || '')
    || !metrics || typeof metrics !== 'object') fail('fixed readiness identity/metrics');

  const nodeCounts = parseNodeTestSummary(nodeResult.output);
  const sentinelCounts = parseNodeTestSummary(sentinelResult.output);
  const nodeValue = {
    candidateReleaseId: fixedCandidateReleaseId,
    candidateReleaseChecksum: fixedCandidateReleaseChecksum,
    sourceHead,
    exitCode: nodeResult.exitCode,
    tests: nodeCounts.tests,
    passed: nodeCounts.passed,
    failed: nodeCounts.failed,
    skipped: nodeCounts.skipped,
    outputSha256: nodeResult.outputSha256,
    sentinel: {
      path: sentinelPath,
      exitCode: sentinelResult.exitCode,
      tests: sentinelCounts.tests,
      passed: sentinelCounts.passed,
      failed: sentinelCounts.failed,
      skipped: sentinelCounts.skipped,
      outputSha256: sentinelResult.outputSha256
    }
  };
  const xmlCandidates = findRecentXml(xmlRoot, startedAt);
  if (androidResult.exitCode !== 0 || xmlCandidates.length !== 1) {
    fail('CONNECTED_DEVICE_RACES_INCOMPLETE: missing unique fresh connected XML');
  }
  const xmlFile = xmlCandidates[0];
  const xmlBytes = readFileSync(xmlFile);
  const xmlAfterRun = { mtimeMs: statSync(xmlFile).mtimeMs, sha256: sha256(xmlBytes) };
  if (!connectedXmlWasRewritten(xmlBeforeRun.get(resolve(xmlFile)), xmlAfterRun)) {
    fail('CONNECTED_DEVICE_RACES_INCOMPLETE: connected XML was not rewritten by this run');
  }
  const parsed = parseConnectedTestResults(xmlBytes.toString('utf8'));
  if (!parsed.ready) fail('CONNECTED_DEVICE_RACES_INCOMPLETE: connected XML result set');
  const postBuildWebAssetChecksums = verifyAndroidWebAssetCopy(repoRoot);
  if (canonical(postBuildWebAssetChecksums) !== canonical(webAssetChecksums)) {
    fail('ANDROID_WEB_ASSET_SYNC: assets changed during Android build');
  }
  const androidValue = {
    candidateReleaseId: fixedCandidateReleaseId,
    candidateReleaseChecksum: fixedCandidateReleaseChecksum,
    sourceHead,
    exitCode: androidResult.exitCode,
    passed: parsed.names.length,
    failed: 0,
    skipped: 0,
    deviceSerial: selected,
    outputSha256: androidResult.outputSha256,
    webAssetChecksums
  };
  await writeFile(join(runDirectory, 'node-test-report.json'), `${JSON.stringify(nodeValue)}\n`, 'utf8');
  await writeFile(join(runDirectory, 'android-test-report.json'), `${JSON.stringify(androidValue)}\n`, 'utf8');
  const copiedXml = join(runDirectory, 'connected-races.xml');
  copyFileSync(xmlFile, copiedXml);
  const completedAt = Date.now();
  const connectedValue = {
    schemaVersion: 'yuqi-v3-connected-device-report-v1',
    candidateReleaseId: fixedCandidateReleaseId,
    candidateReleaseChecksum: fixedCandidateReleaseChecksum,
    sourceHead,
    deviceSerial: selected,
    testClass: CONNECTED_DEVICE_RACE_TEST_CLASS,
    startedAt,
    completedAt,
    xmlPath: `${runId}/connected-races.xml`,
    xmlSha256: sha256(xmlBytes),
    sourceRaceReportSha256: fixed.races.sha256,
    sourceRaceOverallChecksum: fixed.races.value.overallChecksum,
    sourceRegistryChecksum: fixed.races.value.registryChecksum,
    replacements: [...CONNECTED_DEVICE_RACE_NAMES],
    results: Object.fromEntries(CONNECTED_DEVICE_RACE_NAMES.map(name => [name, {
      name, status: 'passed', passed: 1, failed: 0, skipped: 0,
      checksum: sha256({ name, status: 'passed', passed: 1, failed: 0, skipped: 0 })
    }]))
  };
  await writeFile(join(runDirectory, 'connected-device-race-report.json'), `${JSON.stringify(connectedValue)}\n`, 'utf8');

  const artifacts = {};
  for (const [key, value] of Object.entries(fixed)) {
    artifacts[key] = { path: value.filename, sha256: value.sha256 };
  }
  for (const [key, filename] of [
    ['nodeTests', 'node-test-report.json'],
    ['androidTests', 'android-test-report.json'],
    ['connectedDeviceRaces', 'connected-device-race-report.json']
  ]) {
    const bytes = readFileSync(join(runDirectory, filename));
    artifacts[key] = { path: `${runId}/${filename}`, sha256: sha256(bytes) };
  }
  const input = {
    schemaVersion: 'yuqi-v3-readiness-input-v1',
    candidateReleaseId: fixedCandidateReleaseId,
    sourceHead,
    createdAt: startedAt,
    deviceSerial: selected,
    artifacts
  };
  await writeFile(join(directory, 'readiness-input.json'), `${JSON.stringify(input, null, 2)}\n`, 'utf8');
  const evidence = loadReadinessManifest({
    manifestPath: join(directory, 'readiness-input.json'), evidenceDirectory: directory,
    sourceDirectory: repoRoot
  });
  return materializeReadinessReport(evidence, { startedAt, completedAt });
}

if (process.argv[1] && /verify-yuqi-v3-readiness\.mjs$/i.test(process.argv[1])) {
  const run = process.argv.includes('--run');
  const evidenceIndex = process.argv.indexOf('--evidence-dir');
  const runtimeConfigIndex = process.argv.indexOf('--runtime-config');
  const outIndex = process.argv.indexOf('--out');
  const evidenceDir = evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : 'artifacts/yuqi-lived-agency-v3';
  const runtimeConfig = runtimeConfigIndex >= 0
    ? process.argv[runtimeConfigIndex + 1] : resolve('yuqi-runtime/config.json');
  const out = outIndex >= 0 ? process.argv[outIndex + 1] : join(evidenceDir, 'readiness-report.json');
  const invocationStartedAt = Date.now();
  verifyReadinessFromDirectory({ evidenceDir, runtimeConfig, run }).then(result =>
    writeReadinessReportExclusive({
      outPath: out, evidenceDirectory: evidenceDir, repoRoot: process.cwd(), report: result
    }).then(() => {
      console.log(JSON.stringify({ ready: result.ready, failedGates: result.failedGates }));
      if (!result.ready) process.exitCode = 2;
    })).catch(async error => {
      if (run && /CONNECTED_DEVICE_RACES_INCOMPLETE/.test(String(error.message || ''))) {
        const blocked = materializeBlockedReadinessReport({ startedAt: invocationStartedAt });
        await writeReadinessReportExclusive({
          outPath: out, evidenceDirectory: evidenceDir, repoRoot: process.cwd(), report: blocked
        });
        console.error(error.message);
        process.exitCode = 2;
        return;
      }
      console.error(error.message);
      process.exitCode = 2;
    });
}
