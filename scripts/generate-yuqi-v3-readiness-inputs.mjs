import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync
} from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { ReplayRunner } from '../yuqi-runtime/src/replay-runner.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const execFileAsync = promisify(execFile);
const PROTOCOL_ROOT = 'tests/fixtures/yuqi-cognition-protocol-v1';
const FALLBACK_TEST = 'yuqi-runtime/test/android-fallback-authority.test.mjs';
const FALLBACK_FIXTURE = 'tests/fixtures/android-fallback-authority-v2.json';
const ROLLOUT_KEYS = Object.freeze([
  'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION', 'MOMENT_REPLY', 'LIFE_PLANNING'
]);
const PROTOCOL_KINDS = Object.freeze([
  'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION', 'MOMENT_REPLY'
]);
const ROLLOUT_ROW_KEYS = Object.freeze([
  'rolloutKey', 'currentMode', 'rolloutPhase', 'candidatePhase', 'revision',
  'evidenceEpoch', 'shadowEpoch', 'stableReleaseId', 'candidateReleaseId',
  'stableReleaseChecksum', 'candidateReleaseChecksum'
]);
const QUALITY_BUNDLE_FILES = Object.freeze({
  qualityPlan: 'quality-replay-plan.json',
  qualityReplay: 'quality-replay.jsonl',
  qualityManualReview: 'quality-manual-review.jsonl'
});

function parseTapSummary(output) {
  const counters = new Map([['tests', []], ['pass', []], ['fail', []], ['skipped', []]]);
  for (const match of String(output || '').matchAll(/^\s*ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/gmi)) {
    counters.get(match[1]).push(Number(match[2]));
  }
  const blockCount = counters.get('tests').length;
  if (blockCount === 0 || [...counters.values()].some(values =>
    values.length !== blockCount || values.some(value => !Number.isSafeInteger(value)))) {
    throw new Error('fallback sentinel counters');
  }
  for (let index = 0; index < blockCount; index += 1) {
    const tests = counters.get('tests')[index];
    const pass = counters.get('pass')[index];
    const fail = counters.get('fail')[index];
    const skipped = counters.get('skipped')[index];
    if (tests <= 0 || tests !== pass + fail + skipped) throw new Error('fallback sentinel counters');
  }
  const sum = label => counters.get(label).reduce((total, value) => total + value, 0);
  return { tests: sum('tests'), passed: sum('pass'), failed: sum('fail'), skipped: sum('skipped') };
}

function rawSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function rawFileSha256(path) {
  return rawSha256(readFileSync(path));
}

function nowSafe() {
  const value = Date.now();
  if (!Number.isSafeInteger(value)) throw new Error('readiness timestamp');
  return value;
}

function withoutChecksum(report) {
  const copy = { ...report };
  delete copy.reportChecksum;
  return copy;
}

export function reportChecksum(report) {
  return contentHash(withoutChecksum(report));
}

function closeReport(report) {
  return { ...report, reportChecksum: reportChecksum(report) };
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} closed keys`);
  }
}

function safeTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.now()) {
    throw new Error(`${label} timestamp`);
  }
}

function assertSha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} checksum`);
  }
}

function nullableString(value, label) {
  if (value !== null && typeof value !== 'string') throw new Error(`${label} native type`);
}

function nullableSafeInteger(value, label) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${label} native type`);
  }
}

function candidateIdFromQuality(rootDir, explicitPath = null) {
  const path = explicitPath || join(rootDir, 'quality-report.json');
  if (!existsSync(path)) return null;
  let value;
  try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (value?.eligible !== true || !value.candidateRelease
    || typeof value.candidateRelease.releaseId !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.candidateRelease.releaseChecksum || '')) return null;
  return {
    releaseId: value.candidateRelease.releaseId,
    releaseChecksum: value.candidateRelease.releaseChecksum
  };
}

function structuralPipeline(label) {
  return {
    async run({ envelope }) {
      return {
        schemaValid: true,
        usedMessageIds: envelope.message ? [envelope.message.messageId] : [],
        actions: [],
        executionMode: 'structural-dry-run',
        label
      };
    }
  };
}

async function runProtocolFixture({ rootDir, datasetPath, startedAt }) {
  const tempDir = mkdtempSync(join(tmpdir(), 'yuqi-v3-protocol-replay-'));
  const store = new YuqiStore(join(tempDir, 'runtime.sqlite'));
  const runId = `readiness-protocol-${startedAt}-${process.pid}`;
  try {
    const runner = new ReplayRunner({
      store,
      legacyPipeline: structuralPipeline('legacy'),
      cognitivePipeline: structuralPipeline('cognition'),
      sandboxFactory: async ({ clock }) => ({
        dryRun: true,
        clock,
        actionSink: { send() { throw new Error('protocol action side effect'); } },
        notificationSink: { send() { throw new Error('protocol notification side effect'); } },
        cloudSink: { send() { throw new Error('protocol cloud side effect'); } }
      }),
      artifactRoot: join(tempDir, 'artifacts'),
      concurrency: 2
    });
    return await runner.runFixtureBatch({
      runId,
      datasetPath,
      presetVersion: '2.0.0',
      modelProfileChecksum: 'structural-only-not-promotion-evidence'
    });
  } finally {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function generateProtocolReport({
  rootDir = process.cwd(), evidenceDir = resolve('artifacts/yuqi-lived-agency-v3'),
  candidateReleaseId = null, candidateReleaseChecksum = null, sourceHead = null
} = {}) {
  const startedAt = nowSafe();
  const datasetPath = resolve(rootDir, PROTOCOL_ROOT);
  const manifestPath = join(datasetPath, 'manifest.json');
  const casesPath = join(datasetPath, 'cases.jsonl');
  if (!existsSync(manifestPath) || !existsSync(casesPath)) {
    throw new Error('protocol fixture unavailable');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const cases = readFileSync(casesPath, 'utf8').split(/\r?\n/).filter(Boolean);
  if (manifest.suitePurpose !== 'protocol_regression'
    || manifest.qualityEvidenceEligible !== false || manifest.caseCount !== 270
    || cases.length !== 270) throw new Error('protocol fixture contract');
  const replay = await runProtocolFixture({ rootDir, datasetPath, startedAt });
  const summary = replay.summary;
  const completedAt = nowSafe();
  const report = closeReport({
    schemaVersion: 'yuqi-v3-protocol-report-v1',
    candidateReleaseId: candidateReleaseId ?? null,
    candidateReleaseChecksum: candidateReleaseChecksum ?? null,
    sourceHead: sourceHead ?? null,
    suitePurpose: 'protocol_regression',
    caseCount: 270,
    passed: Number(summary.completed),
    failed: Number(summary.failed),
    skipped: 0,
    critical: Number(summary.criticalErrors),
    liveShadowCountBefore: Number(summary.liveShadowCountBefore),
    liveShadowCountAfter: Number(summary.liveShadowCountAfter),
    qualityEvidenceEligible: false,
    productionReleaseMutation: false,
    status: Number(summary.completed) === 270 && Number(summary.failed) === 0
      && Number(summary.criticalErrors) === 0 && Number(summary.liveShadowCountBefore) === 0
      && Number(summary.liveShadowCountAfter) === 0 ? 'passed' : 'failed',
    byKind: summary.byKind,
    manifestSha256: rawFileSha256(manifestPath),
    casesSha256: rawFileSha256(casesPath),
    command: {
      execution: 'in_process', module: 'yuqi-runtime/src/replay-runner.mjs',
      export: 'ReplayRunner.runFixtureBatch',
      args: ['--source', 'fixture', '--preset-version', '2.0.0',
        '--model-profile-checksum', 'structural-only-not-promotion-evidence']
    },
    commandOutputSha256: rawSha256(Buffer.from(`${canonicalJson(summary)}\n`, 'utf8')),
    startedAt,
    completedAt
  });
  return report;
}

async function runNodeTest({ rootDir, path }) {
  const startedAt = nowSafe();
  try {
    const result = await execFileAsync(process.execPath, ['--test', path], {
      cwd: rootDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
      env: (() => { const value = { ...process.env }; delete value.NODE_TEST_CONTEXT; return value; })()
    });
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    return { startedAt, completedAt: nowSafe(), exitCode: 0, output, outputSha256: rawSha256(Buffer.from(output, 'utf8')) };
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`;
    return {
      startedAt, completedAt: nowSafe(), exitCode: Number(error.code || 1), output,
      outputSha256: rawSha256(Buffer.from(output, 'utf8'))
    };
  }
}

export async function generateAndroidFallbackReport({
  rootDir = process.cwd(), evidenceDir = resolve('artifacts/yuqi-lived-agency-v3'),
  candidateReleaseId = null, candidateReleaseChecksum = null, sourceHead = null
} = {}) {
  const testPath = resolve(rootDir, FALLBACK_TEST);
  const fixturePath = resolve(rootDir, FALLBACK_FIXTURE);
  if (!existsSync(testPath) || !existsSync(fixturePath)) throw new Error('fallback sentinel/fixture unavailable');
  const result = await runNodeTest({ rootDir, path: FALLBACK_TEST });
  const counts = parseTapSummary(result.output);
  const sourceSha256 = rawFileSha256(testPath);
  const fixtureSha256 = rawFileSha256(fixturePath);
  const fullPass = result.exitCode === 0 && counts.tests > 0
    && counts.passed === counts.tests && counts.failed === 0 && counts.skipped === 0;
  const report = closeReport({
    schemaVersion: 'yuqi-v3-android-fallback-report-v1',
    candidateReleaseId: candidateReleaseId ?? null,
    candidateReleaseChecksum: candidateReleaseChecksum ?? null,
    sourceHead: sourceHead ?? null,
    testPath: FALLBACK_TEST,
    fixturePath: FALLBACK_FIXTURE,
    sourceSha256,
    fixtureSha256,
    command: [process.execPath, '--test', FALLBACK_TEST],
    commandOutputSha256: result.outputSha256,
    exitCode: result.exitCode,
    tests: counts.tests,
    passed: counts.passed,
    failed: counts.failed,
    skipped: counts.skipped,
    executionStatus: fullPass ? 'passed' : 'failed',
    status: candidateReleaseId && fullPass ? 'passed' : 'not_ready',
    reason: candidateReleaseId ? (fullPass ? null : 'ANDROID_FALLBACK_SENTINEL_FAILED') : 'CANDIDATE_RELEASE_UNAVAILABLE',
    productionReleaseMutation: false,
    startedAt: result.startedAt,
    completedAt: result.completedAt
  });
  return report;
}

function emptyRolloutKind(rolloutKey) {
  return {
    rolloutKey, currentMode: null, rolloutPhase: null, candidatePhase: 'none',
    revision: null, evidenceEpoch: null, shadowEpoch: null,
    stableReleaseId: null, candidateReleaseId: null,
    stableReleaseChecksum: null, candidateReleaseChecksum: null
  };
}

function sqliteSemanticFingerprint(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const schema = db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name`).all();
    const tables = schema.filter(row => row.type === 'table').map(row => ({
      name: row.name,
      rows: db.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()
        .sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
    }));
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    return { userVersion, fingerprint: contentHash({ schema, tables }) };
  } finally {
    db.close();
  }
}

function sidecarIdentity(path) {
  const bytes = name => existsSync(`${path}${name}`)
    ? rawFileSha256(`${path}${name}`) : null;
  return {
    main: rawFileSha256(path),
    wal: bytes('-wal'),
    journal: bytes('-journal')
  };
}

function sourceDatabaseIdentity(path) {
  const before = sidecarIdentity(path);
  const semantic = sqliteSemanticFingerprint(path);
  const after = sidecarIdentity(path);
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw new Error('rollout source changed during read-only audit');
  }
  return {
    files: before,
    semanticFingerprint: semantic.fingerprint,
    userVersion: semantic.userVersion,
    databaseSha256: contentHash({ files: before, semantic })
  };
}

function unavailableRolloutReport({ startedAt, configPath, reason, candidateReleaseId, candidateReleaseChecksum, sourceHead }) {
  return closeReport({
    schemaVersion: 'yuqi-v3-rollout-status-v1',
    candidateReleaseId: candidateReleaseId ?? null,
    candidateReleaseChecksum: candidateReleaseChecksum ?? null,
    sourceHead: sourceHead ?? null,
    status: 'unavailable', reason,
    configPath: configPath ? String(configPath).replaceAll('\\', '/') : null,
    databasePath: null, databaseSha256: null, semanticFingerprint: null, userVersion: null,
    kinds: ROLLOUT_KEYS.map(emptyRolloutKind), productionReleaseMutation: false,
    startedAt, completedAt: nowSafe()
  });
}

export async function generateRolloutStatusReport({
  rootDir = process.cwd(), evidenceDir = resolve('artifacts/yuqi-lived-agency-v3'),
  configPath = null, candidateReleaseId = null, candidateReleaseChecksum = null, sourceHead = null
} = {}) {
  const startedAt = nowSafe();
  let report;
  if (!configPath) {
    report = unavailableRolloutReport({
      startedAt, configPath: null, reason: 'ROLLOUT_CONFIG_UNAVAILABLE',
      candidateReleaseId, candidateReleaseChecksum, sourceHead
    });
  } else {
    const resolvedConfig = resolve(rootDir, configPath);
    if (!existsSync(resolvedConfig)) {
      return unavailableRolloutReport({
        startedAt, configPath, reason: 'ROLLOUT_CONFIG_UNAVAILABLE', candidateReleaseId, candidateReleaseChecksum, sourceHead
      });
    }
    const config = JSON.parse(readFileSync(resolvedConfig, 'utf8'));
    if (typeof config.databasePath !== 'string' || config.databasePath.trim().length === 0) {
      return unavailableRolloutReport({
        startedAt, configPath, reason: 'ROLLOUT_DATABASE_PATH_INVALID', candidateReleaseId: null, candidateReleaseChecksum: null, sourceHead: null
      });
    }
    const databasePath = resolve(dirname(resolvedConfig), config.databasePath);
    if (!existsSync(databasePath)) {
      return unavailableRolloutReport({
        startedAt, configPath, reason: 'ROLLOUT_DATABASE_UNAVAILABLE', candidateReleaseId, candidateReleaseChecksum, sourceHead
      });
    }
    const source = sourceDatabaseIdentity(databasePath);
    if (source.userVersion !== 15) {
      return unavailableRolloutReport({
        startedAt, configPath, reason: 'ROLLOUT_SOURCE_SCHEMA_UNSUPPORTED',
        candidateReleaseId: null, candidateReleaseChecksum: null, sourceHead: null
      });
    }
    const cloneDir = mkdtempSync(join(tmpdir(), 'yuqi-v3-rollout-clone-'));
    const clonePath = join(cloneDir, 'runtime.sqlite');
    const sourceDb = new DatabaseSync(databasePath, { readOnly: true });
    try {
      sourceDb.exec(`VACUUM INTO '${clonePath.replaceAll("'", "''")}'`);
    } finally { sourceDb.close(); }
    const afterClone = sourceDatabaseIdentity(databasePath);
    if (canonicalJson(source) !== canonicalJson(afterClone)) {
      rmSync(cloneDir, { recursive: true, force: true });
      throw new Error('rollout source changed during clone');
    }
    const store = new YuqiStore(clonePath);
    try {
      const rows = new Map(store.listCognitionRollouts().map(row => [row.rolloutKey, row]));
      let releaseError = null;
      const kinds = ROLLOUT_KEYS.map(key => {
        const row = rows.get(key);
        if (!row) return emptyRolloutKind(key);
        const stableRelease = row.stableReleaseId ? store.getPipelineRelease(row.stableReleaseId) : null;
        const candidateRelease = row.candidateReleaseId ? store.getPipelineRelease(row.candidateReleaseId) : null;
        if (row.stableReleaseId && (!stableRelease || !/^[a-f0-9]{64}$/.test(stableRelease.releaseChecksum || ''))) {
          releaseError = 'ROLLOUT_RELEASE_UNAVAILABLE';
        }
        if (row.candidateReleaseId && (!candidateRelease || !/^[a-f0-9]{64}$/.test(candidateRelease.releaseChecksum || ''))) {
          releaseError = 'ROLLOUT_RELEASE_UNAVAILABLE';
        }
        if (!['legacy', 'shadow', 'active'].includes(row.currentMode)
          || !['stable', 'canary'].includes(row.rolloutPhase)
          || !['none', 'shadow', 'canary', 'stable', 'rolled_back'].includes(row.candidatePhase || 'none')
          || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 0
          || !Number.isSafeInteger(Number(row.evidenceEpoch)) || Number(row.evidenceEpoch) < 0
          || !Number.isSafeInteger(Number(row.shadowEpoch)) || Number(row.shadowEpoch) < 0) {
          releaseError = 'ROLLOUT_ROW_INVALID';
        }
        if (row.candidateReleaseId && row.candidateReleaseChecksum
          && row.candidateReleaseChecksum !== candidateRelease.releaseChecksum) {
          releaseError = 'ROLLOUT_RELEASE_CHECKSUM_MISMATCH';
        }
        return {
          rolloutKey: key, currentMode: row.currentMode, rolloutPhase: row.rolloutPhase,
          candidatePhase: row.candidatePhase || 'none', revision: Number(row.revision),
          evidenceEpoch: Number(row.evidenceEpoch), shadowEpoch: Number(row.shadowEpoch),
          stableReleaseId: row.stableReleaseId || null,
          candidateReleaseId: row.candidateReleaseId || null,
          stableReleaseChecksum: stableRelease?.releaseChecksum || null,
          candidateReleaseChecksum: candidateRelease?.releaseChecksum || null
        };
      });
      const ids = [...new Set(kinds.map(row => row.candidateReleaseId).filter(Boolean))];
      const checksums = [...new Set(kinds.map(row => row.candidateReleaseChecksum).filter(Boolean))];
      const conflicting = ids.length > 1 || checksums.length > 1
        || (ids.length === 1 && checksums.length !== 1);
      const common = conflicting ? null : (ids[0] || null);
      report = {
        schemaVersion: 'yuqi-v3-rollout-status-v1', candidateReleaseId: releaseError ? null : common,
        candidateReleaseChecksum: releaseError || conflicting ? null : (checksums[0] || null),
        sourceHead: sourceHead ?? null,
        status: releaseError ? 'unavailable' : (conflicting ? 'conflict' : 'available'),
        reason: releaseError || (conflicting ? 'ROLLOUT_CANDIDATE_CONFLICT' : null),
        configPath: configPath.replaceAll('\\', '/'), databasePath: databasePath.replaceAll('\\', '/'),
        databaseSha256: source.databaseSha256, semanticFingerprint: source.semanticFingerprint,
        userVersion: source.userVersion, kinds, productionReleaseMutation: false,
        startedAt, completedAt: nowSafe()
      };
    } finally { store.close(); rmSync(cloneDir, { recursive: true, force: true }); }
  }
  return closeReport(report);
}

export function validateReadinessInputReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('report object');
  const schema = report.schemaVersion;
  const common = ['schemaVersion', 'candidateReleaseId', 'candidateReleaseChecksum', 'productionReleaseMutation', 'sourceHead', 'startedAt', 'completedAt', 'reportChecksum'];
  let keys;
  if (schema === 'yuqi-v3-protocol-report-v1') {
    keys = [...common, 'suitePurpose', 'caseCount', 'passed', 'failed', 'skipped', 'critical', 'liveShadowCountBefore', 'liveShadowCountAfter', 'qualityEvidenceEligible', 'status', 'byKind', 'manifestSha256', 'casesSha256', 'command', 'commandOutputSha256'];
  } else if (schema === 'yuqi-v3-android-fallback-report-v1') {
    keys = [...common, 'testPath', 'fixturePath', 'sourceSha256', 'fixtureSha256', 'command', 'commandOutputSha256', 'exitCode', 'tests', 'passed', 'failed', 'skipped', 'executionStatus', 'status', 'reason'];
  } else if (schema === 'yuqi-v3-rollout-status-v1') {
    keys = [...common, 'status', 'reason', 'configPath', 'databasePath', 'databaseSha256', 'semanticFingerprint', 'userVersion', 'kinds'];
  } else throw new Error('unknown readiness input schema');
  exactKeys(report, keys, 'readiness report');
  if (report.candidateReleaseId !== null
    && (typeof report.candidateReleaseId !== 'string' || report.candidateReleaseId.length === 0)) throw new Error('candidateReleaseId native type');
  if (report.candidateReleaseChecksum !== null) assertSha(report.candidateReleaseChecksum, 'candidateReleaseChecksum');
  if ((report.candidateReleaseId === null) !== (report.candidateReleaseChecksum === null)) {
    throw new Error('candidate identity pair');
  }
  if (report.sourceHead !== null && !/^[a-f0-9]{40}$/.test(report.sourceHead)) throw new Error('sourceHead checksum');
  if ((report.candidateReleaseId === null) !== (report.sourceHead === null)) throw new Error('candidate sourceHead pair');
  if (report.productionReleaseMutation !== false) throw new Error('productionReleaseMutation');
  safeTimestamp(report.startedAt, 'startedAt'); safeTimestamp(report.completedAt, 'completedAt');
  if (report.completedAt < report.startedAt) throw new Error('report time order');
  assertSha(report.reportChecksum, 'reportChecksum');
  if (report.reportChecksum !== reportChecksum(report)) throw new Error('report checksum mismatch');
  if (schema === 'yuqi-v3-protocol-report-v1') {
    if (report.suitePurpose !== 'protocol_regression' || report.caseCount !== 270 || report.qualityEvidenceEligible !== false
      || !['passed', 'failed'].includes(report.status)) throw new Error('protocol report fields');
    for (const key of ['caseCount', 'passed', 'failed', 'skipped', 'critical', 'liveShadowCountBefore', 'liveShadowCountAfter']) {
      if (!Number.isSafeInteger(report[key]) || report[key] < 0) throw new Error('protocol native counters');
    }
    if (report.caseCount !== report.passed + report.failed + report.skipped
      || (report.status === 'passed'
        && (report.passed !== 270 || report.failed !== 0 || report.skipped !== 0
          || report.critical !== 0 || report.liveShadowCountBefore !== 0
          || report.liveShadowCountAfter !== 0))
      || (report.status === 'failed' && report.passed === 270 && report.failed === 0
        && report.skipped === 0 && report.critical === 0)) {
      throw new Error('protocol status counters');
    }
    assertSha(report.manifestSha256, 'manifestSha256'); assertSha(report.casesSha256, 'casesSha256');
    assertSha(report.commandOutputSha256, 'commandOutputSha256');
    if (!report.byKind || typeof report.byKind !== 'object' || Array.isArray(report.byKind)
      || JSON.stringify(Object.keys(report.byKind).sort()) !== JSON.stringify([...PROTOCOL_KINDS].sort())
      || PROTOCOL_KINDS.some(key => report.byKind[key] !== 30)
      || !report.command || typeof report.command !== 'object'
      || report.command.execution !== 'in_process'
      || report.command.module !== 'yuqi-runtime/src/replay-runner.mjs'
      || report.command.export !== 'ReplayRunner.runFixtureBatch') throw new Error('protocol execution descriptor');
    exactKeys(report.command, ['args', 'execution', 'export', 'module'], 'protocol command');
    if (!Array.isArray(report.command.args) || report.command.args.some(value => typeof value !== 'string')) {
      throw new Error('protocol command args');
    }
  }
  if (schema === 'yuqi-v3-android-fallback-report-v1') {
    if (report.testPath !== FALLBACK_TEST || report.fixturePath !== FALLBACK_FIXTURE
      || !['passed', 'failed'].includes(report.executionStatus) || !['passed', 'failed', 'not_ready'].includes(report.status)) throw new Error('fallback report fields');
    for (const key of ['exitCode', 'tests', 'passed', 'failed', 'skipped']) if (!Number.isSafeInteger(report[key]) || report[key] < 0) throw new Error('fallback native counters');
    for (const key of ['sourceSha256', 'fixtureSha256', 'commandOutputSha256']) assertSha(report[key], key);
    if (!Array.isArray(report.command) || report.command.length < 3
      || report.command.some(value => typeof value !== 'string')
      || report.command[1] !== '--test' || report.command.at(-1) !== FALLBACK_TEST) {
      throw new Error('fallback command');
    }
    if (!Number.isSafeInteger(report.tests) || report.tests <= 0
      || report.tests !== report.passed + report.failed + report.skipped) throw new Error('fallback counters');
    const fullPass = report.exitCode === 0 && report.passed === report.tests
      && report.failed === 0 && report.skipped === 0;
    if ((report.executionStatus === 'passed') !== fullPass) throw new Error('fallback execution status');
    if (report.executionStatus === 'passed') {
      if (report.candidateReleaseId === null) {
        if (report.status !== 'not_ready' || report.reason !== 'CANDIDATE_RELEASE_UNAVAILABLE') {
          throw new Error('fallback candidate status');
        }
      } else if (report.status !== 'passed' || report.reason !== null) {
        throw new Error('fallback passed status');
      }
    } else if (report.status !== 'not_ready' || report.reason !== 'ANDROID_FALLBACK_SENTINEL_FAILED') {
      throw new Error('fallback failed status');
    }
  }
  if (schema === 'yuqi-v3-rollout-status-v1') {
    if (!['available', 'unavailable', 'conflict'].includes(report.status) || !Array.isArray(report.kinds)
      || report.kinds.length !== ROLLOUT_KEYS.length || report.kinds.some(row => row?.candidatePhase !== 'none' && typeof row?.candidatePhase !== 'string')) throw new Error('rollout report fields');
    if (report.status === 'unavailable'
      && ['ROLLOUT_CONFIG_UNAVAILABLE', 'ROLLOUT_DATABASE_UNAVAILABLE', 'ROLLOUT_DATABASE_PATH_INVALID']
        .includes(report.reason)
      && (report.candidateReleaseId !== null || report.candidateReleaseChecksum !== null
        || report.databaseSha256 !== null || report.semanticFingerprint !== null || report.userVersion !== null)) {
      throw new Error('unavailable rollout identity');
    }
    if (report.databaseSha256 !== null) assertSha(report.databaseSha256, 'databaseSha256');
    if (report.semanticFingerprint !== null) assertSha(report.semanticFingerprint, 'semanticFingerprint');
    if (report.userVersion !== null && (!Number.isSafeInteger(report.userVersion) || report.userVersion < 0)) throw new Error('userVersion');
    if (report.configPath !== null && typeof report.configPath !== 'string') throw new Error('rollout config path');
    if (report.databasePath !== null && typeof report.databasePath !== 'string') throw new Error('rollout database path');
    const keys = report.kinds.map(row => row && row.rolloutKey);
    if (JSON.stringify(keys) !== JSON.stringify([...ROLLOUT_KEYS])) throw new Error('rollout kind set');
    for (const row of report.kinds) {
      exactKeys(row, ROLLOUT_ROW_KEYS, 'rollout kind');
      if (!ROLLOUT_KEYS.includes(row.rolloutKey)) throw new Error('rollout kind key');
      nullableString(row.currentMode, 'rollout currentMode');
      nullableString(row.rolloutPhase, 'rollout rolloutPhase');
      if (!['none', 'shadow', 'canary', 'stable', 'rolled_back'].includes(row.candidatePhase)) throw new Error('rollout candidate phase');
      nullableSafeInteger(row.revision, 'rollout revision');
      nullableSafeInteger(row.evidenceEpoch, 'rollout evidence epoch');
      nullableSafeInteger(row.shadowEpoch, 'rollout shadow epoch');
      nullableString(row.stableReleaseId, 'rollout stable release');
      nullableString(row.candidateReleaseId, 'rollout candidate release');
      if (row.candidateReleaseChecksum !== null) assertSha(row.candidateReleaseChecksum, 'rollout candidate checksum');
      if (row.stableReleaseChecksum !== null) assertSha(row.stableReleaseChecksum, 'rollout stable checksum');
      if (row.candidateReleaseId === null && row.candidateReleaseChecksum !== null) throw new Error('rollout candidate checksum without id');
      if (row.stableReleaseId === null && row.stableReleaseChecksum !== null) throw new Error('rollout stable checksum without id');
    }
    const rowIds = [...new Set(report.kinds.map(row => row.candidateReleaseId).filter(Boolean))];
    const rowChecksums = [...new Set(report.kinds.map(row => row.candidateReleaseChecksum).filter(Boolean))];
    if (report.status === 'conflict' && (report.candidateReleaseId !== null || report.candidateReleaseChecksum !== null)) {
      throw new Error('rollout conflict identity');
    }
    if (report.status === 'available') {
      if (report.userVersion !== 15) throw new Error('rollout source schema');
      if (rowIds.length === 1 && (report.candidateReleaseId !== rowIds[0]
        || rowChecksums.length !== 1 || report.candidateReleaseChecksum !== rowChecksums[0])) {
        throw new Error('rollout candidate binding');
      }
      if (rowIds.length > 1 || rowChecksums.length > 1) throw new Error('rollout candidate conflict');
    }
  }
  return report;
}

export async function generateReadinessInputs({
  rootDir = process.cwd(), evidenceDir = resolve('artifacts/yuqi-lived-agency-v3'), configPath = null, sourceHead = null
} = {}) {
  mkdirSync(evidenceDir, { recursive: true });
  const candidate = candidateIdFromQuality(evidenceDir);
  const boundCandidate = candidate && /^[a-f0-9]{40}$/.test(sourceHead || '') ? candidate : null;
  const protocol = await generateProtocolReport({ rootDir, evidenceDir, sourceHead: sourceHead ?? null, candidateReleaseId: boundCandidate?.releaseId, candidateReleaseChecksum: boundCandidate?.releaseChecksum });
  const androidFallback = await generateAndroidFallbackReport({ rootDir, evidenceDir, sourceHead: sourceHead ?? null, candidateReleaseId: boundCandidate?.releaseId, candidateReleaseChecksum: boundCandidate?.releaseChecksum });
  const rolloutStatus = await generateRolloutStatusReport({ rootDir, evidenceDir, configPath, sourceHead: sourceHead ?? null, candidateReleaseId: boundCandidate?.releaseId, candidateReleaseChecksum: boundCandidate?.releaseChecksum });
  const outputs = {
    protocol: 'protocol-report.json', androidFallback: 'android-fallback-report.json', rolloutStatus: 'rollout-status.json',
    ...QUALITY_BUNDLE_FILES
  };
  for (const [name, report] of Object.entries({ protocol, androidFallback, rolloutStatus })) {
    validateReadinessInputReport(report);
    writeFileSync(join(evidenceDir, outputs[name]), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  const qualityBundle = {};
  for (const [name, filename] of Object.entries(QUALITY_BUNDLE_FILES)) {
    const path = join(evidenceDir, filename);
    if (!existsSync(path)) throw new Error(`QUALITY_BUNDLE_ARTIFACT_UNAVAILABLE: ${filename}`);
    const bytes = readFileSync(path);
    if (bytes.length === 0) throw new Error(`QUALITY_BUNDLE_ARTIFACT_EMPTY: ${filename}`);
    qualityBundle[name] = { path: filename, sha256: rawSha256(bytes) };
  }
  return {
    candidateReleaseId: boundCandidate?.releaseId ?? null,
    candidateReleaseChecksum: boundCandidate?.releaseChecksum ?? null,
    reports: { protocol, androidFallback, rolloutStatus, qualityBundle },
    descriptors: Object.fromEntries(Object.entries(outputs).map(([name, path]) => {
      const bytes = readFileSync(join(evidenceDir, path));
      return [name, { path, sha256: rawSha256(bytes) }];
    }))
  };
}

if (process.argv[1] && /generate-yuqi-v3-readiness-inputs\.mjs$/i.test(process.argv[1])) {
  const evidenceIndex = process.argv.indexOf('--evidence-dir');
  const configIndex = process.argv.indexOf('--config');
  const evidenceDir = resolve(evidenceIndex >= 0 ? process.argv[evidenceIndex + 1] : 'artifacts/yuqi-lived-agency-v3');
  const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : 'yuqi-runtime/config.json';
  const verifiedSourceHead = (async () => {
    try {
      const head = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), windowsHide: true });
      const status = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: process.cwd(), windowsHide: true });
      const evidenceRelative = resolve(evidenceDir).replace(`${resolve(process.cwd())}${sep}`, '').replaceAll('\\', '/');
      const dirtyOutside = String(status.stdout || '').split(/\r?\n/).filter(Boolean).some(line => {
        const pathText = line.slice(3).trim().replace(/^"(.*)"$/, '$1').replaceAll('\\', '/');
        return !pathText.startsWith(`${evidenceRelative}/`) && pathText !== evidenceRelative;
      });
      const value = String(head.stdout || '').trim();
      return !dirtyOutside && /^[a-f0-9]{40}$/.test(value) ? value : null;
    } catch { return null; }
  })();
  verifiedSourceHead.then(sourceHead => generateReadinessInputs({ rootDir: process.cwd(), evidenceDir, configPath, sourceHead }))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 2; });
}
