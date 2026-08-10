import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import {
  assertQualityReportProvenance,
  evidenceBoundaryChecksum,
  loadQualityHistoryArtifacts,
  validateQualityArtifactBundle
} from './report-yuqi-lived-quality.mjs';
import { createQualityReplayPlan } from './run-yuqi-lived-quality-replay.mjs';
import { expectedFinalKeysProjection, loadQualityReplayPlanArtifact } from '../yuqi-runtime/src/quality-replay.mjs';
import { assertEvidenceDirectoryScope, gitStatusArgsForEvidence } from './run-yuqi-visible-path-formal.mjs';

const VALIDATED_RAW_BUNDLES = new WeakSet();
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const ROLLOUT_EVIDENCE_ROOT = 'artifacts/yuqi-lived-agency-v3';

function defaultRolloutCommandRunner(executable, args, { cwd } = {}) {
  try {
    return { exitCode: 0, stdout: execFileSync(executable, args, {
      cwd, encoding: 'utf8', windowsHide: true
    }) };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error.status) ? error.status : 1,
      stdout: String(error.stdout || ''),
      stderr: String(error.stderr || ''),
      error
    };
  }
}

let rolloutCommandRunner = defaultRolloutCommandRunner;

// Test-only seam: the CLI never reads options for this dependency.
export function setRolloutCommandRunnerForTests(runner = null) {
  if (runner !== null && typeof runner !== 'function') {
    throw new TypeError('rollout command runner must be a function or null');
  }
  rolloutCommandRunner = runner || defaultRolloutCommandRunner;
}

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      result._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function readJson(path, label) {
  if (!path || !existsSync(path)) throw new Error(`${label} is unavailable`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function commandOutput(result) {
  return String(result?.stdout ?? result?.output ?? '');
}

function pathIsWithin(parent, candidate, allowSame = false) {
  const rel = relative(parent, candidate);
  return (allowSame && rel === '') || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

function assertRolloutEvidenceScope(rootDir, evidenceDir) {
  const fixedRoot = resolve(rootDir, ROLLOUT_EVIDENCE_ROOT);
  if (!pathIsWithin(fixedRoot, resolve(evidenceDir), true)) {
    throw new Error('evidence directory scope');
  }
  return assertEvidenceDirectoryScope(rootDir, evidenceDir);
}

function assertScopedStatus(statusText, rootDir, evidenceDir) {
  const records = String(statusText).split('\0').filter(Boolean);
  for (const record of records) {
    const pathText = record.length >= 3 && /^[ MARCUD?!][ MARCUD?!] /.test(record)
      ? record.slice(3)
      : record;
    for (const rawPath of pathText.split(' -> ')) {
      if (!rawPath) continue;
      if (isAbsolute(rawPath)) throw new Error('source tree status path is outside repository');
      const candidate = resolve(rootDir, rawPath);
      if (!pathIsWithin(rootDir, candidate, true)) {
        throw new Error('source tree is dirty outside evidence directory');
      }
      if (!pathIsWithin(evidenceDir, candidate, true)) {
        throw new Error('source tree is dirty outside evidence directory');
      }
    }
  }
}

export function preflightRolloutSourceAuthority({ rootDir = process.cwd(), reportPath, commandRunner = rolloutCommandRunner } = {}) {
  if (typeof reportPath !== 'string' || !reportPath) throw new Error('quality report path required');
  const root = resolve(rootDir);
  const evidenceDir = dirname(resolve(reportPath));
  assertRolloutEvidenceScope(root, evidenceDir);
  const report = readJson(resolve(reportPath), 'quality report');
  const reportHead = report?.sourceHead;
  const provenanceHead = report?.replayProvenance?.sourceHead;
  if (!/^[0-9a-f]{40}$/.test(reportHead || '')
    || provenanceHead !== reportHead) {
    throw new Error('quality report source authority is unavailable');
  }
  const run = (executable, args) => {
    const result = commandRunner(executable, args, { cwd: root });
    if (!result || !Number.isInteger(result.exitCode)) {
      throw new Error('rollout command runner returned an invalid result');
    }
    return result;
  };
  const headResult = run('git', ['rev-parse', 'HEAD']);
  if (headResult.exitCode !== 0) throw new Error('git rev-parse HEAD failed');
  const currentHead = commandOutput(headResult).trim();
  if (!/^[0-9a-f]{40}$/.test(currentHead) || currentHead !== reportHead) {
    throw new Error('quality report sourceHead is stale');
  }
  const statusResult = run('git', gitStatusArgsForEvidence(root, evidenceDir));
  if (statusResult.exitCode !== 0) throw new Error('git status source preflight failed');
  assertScopedStatus(commandOutput(statusResult), root, evidenceDir);
  return { sourceHead: currentHead, evidenceDir, evidenceScope: 'scoped' };
}

function rawSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileFingerprint(path) {
  if (!existsSync(path)) return { exists: false, bytes: null };
  return { exists: true, bytes: readFileSync(path).toString('base64') };
}

function normalizeSqlValue(value) {
  if (value instanceof Uint8Array) {
    return { type: 'blob', base64: Buffer.from(value).toString('base64') };
  }
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function quoteSqlIdentifier(identifier) {
  return `"${String(identifier).replaceAll('"', '""')}"`;
}

function databaseSemanticFingerprint(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const schema = db.prepare(`
      SELECT type, name, tbl_name, sql
      FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    const tables = [];
    for (const entry of schema.filter(row => row.type === 'table')) {
      const tableName = String(entry.name);
      const rows = db.prepare(`SELECT * FROM ${quoteSqlIdentifier(tableName)}`).all()
        .map(row => Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)])
        ))
        .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
      tables.push({ tableName, rows });
    }
    const userVersion = Number(db.prepare('PRAGMA user_version').get().user_version);
    db.exec('COMMIT');
    return contentHash({
      userVersion,
      schema: schema.map(row => ({
        type: row.type, name: row.name, tblName: row.tbl_name, sql: row.sql
      })),
      tables
    });
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

function databaseFingerprint(path) {
  const walPath = `${path}-wal`;
  const journalPath = `${path}-journal`;
  const journal = [
    { kind: 'wal', ...fileFingerprint(walPath) },
    { kind: 'rollback', ...fileFingerprint(journalPath) }
  ];
  return contentHash({
    semantic: databaseSemanticFingerprint(path),
    userVersion: databaseUserVersion(path),
    main: fileFingerprint(path),
    journal: journal.map(entry => ({
      kind: entry.kind,
      // A missing/empty journal is not an identity-bearing sidecar.  A
      // non-empty journal is retained byte-for-byte for mutation detection.
      exists: entry.exists && Boolean(entry.bytes),
      bytes: entry.exists && entry.bytes ? entry.bytes : null
    }))
  });
}

function databaseUserVersion(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(db.prepare('PRAGMA user_version').get().user_version);
  } finally {
    db.close();
  }
}

function cloneDatabaseForReadOnlyAudit(databasePath) {
  const tempDir = mkdtempSync(join(tmpdir(), 'yuqi-rollout-readonly-'));
  const clonePath = join(tempDir, 'runtime.sqlite');
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const escapedClonePath = clonePath.replaceAll("'", "''");
    source.exec(`VACUUM INTO '${escapedClonePath}'`);
  } finally {
    source.close();
  }
  return { tempDir, clonePath };
}

function runtimeFromConfig(configPath, { readOnly = false } = {}) {
  const resolvedConfigPath = resolve(configPath);
  const config = readJson(resolvedConfigPath, 'rollout config');
  const databasePath = config.databasePath || config.database || config.runtimeDatabase;
  if (typeof databasePath !== 'string' || !databasePath.trim()) {
    throw new Error('rollout config databasePath is required');
  }
  const sourceDatabasePath = resolve(dirname(resolvedConfigPath), databasePath);
  const sourceFingerprint = readOnly ? databaseFingerprint(sourceDatabasePath) : null;
  const sourceVersion = readOnly ? databaseUserVersion(sourceDatabasePath) : null;
  const clone = readOnly ? cloneDatabaseForReadOnlyAudit(sourceDatabasePath) : null;
  const store = new YuqiStore(clone?.clonePath || sourceDatabasePath);
  const registry = { evidenceManifest: () => ({ checksum: '', presetVersion: '' }) };
  return {
    store,
    controller: new PromotionController({ store, presetRegistry: registry }),
    config,
    readonly: readOnly,
    readonlyAudit: readOnly ? {
      sourceDatabasePath, sourceFingerprint, sourceVersion, tempDir: clone.tempDir
    } : null
  };
}

export function loadQualityPromotionRawBundle({ artifactPath, artifact, rootDir = process.cwd() }) {
  if (typeof artifactPath !== 'string' || !artifactPath) throw new Error('quality report path required');
  const directory = dirname(resolve(artifactPath));
  const paths = {
    plan: join(directory, 'quality-replay-plan.json'),
    replay: join(directory, 'quality-replay.jsonl'),
    manual: join(directory, 'quality-manual-review.jsonl')
  };
  if (Object.values(paths).some(path => !existsSync(path))) {
    throw new Error('quality raw bundle is incomplete');
  }
  const planBytes = readFileSync(paths.plan);
  const replayBytes = readFileSync(paths.replay);
  const manualBytes = readFileSync(paths.manual);
  const history = loadQualityHistoryArtifacts({ rootDir });
  const plan = loadQualityReplayPlanArtifact({
    artifactPath: paths.plan,
    rootDir,
    historyScenes: history.historyScenes,
    historyManifest: history.historyManifest
  });
  if (!artifact || artifact.qualityPlanSha256 !== rawSha256(planBytes)
    || artifact.qualityReplaySha256 !== rawSha256(replayBytes)
    || artifact.qualityManualReviewSha256 !== rawSha256(manualBytes)) {
    throw new Error('quality raw artifact checksum binding conflict');
  }
  const bundle = validateQualityArtifactBundle({
    plan,
    replayArtifactPath: paths.replay,
    manualReviewArtifactPath: paths.manual,
    candidateRelease: artifact.candidateRelease,
    qualityReport: artifact
  });
  if (bundle.runId !== artifact.replayRunId
    || canonicalJson(bundle.provenance) !== canonicalJson(artifact.replayProvenance)) {
    throw new Error('quality raw provenance binding conflict');
  }
  const validatedBundle = { ...bundle, plan, paths, checksums: {
    plan: rawSha256(planBytes), replay: rawSha256(replayBytes), manual: rawSha256(manualBytes)
  } };
  VALIDATED_RAW_BUNDLES.add(validatedBundle);
  return validatedBundle;
}

export function reportSummaryFromArtifact({ artifact, rollout, rootDir = process.cwd(), rawBundle = null }) {
  if (!rawBundle || typeof rawBundle !== 'object' || Array.isArray(rawBundle)
    || !VALIDATED_RAW_BUNDLES.has(rawBundle)
    || !rawBundle.plan || !rawBundle.provenance || !rawBundle.checksums
    || typeof rawBundle.checksums.plan !== 'string'
    || typeof rawBundle.checksums.replay !== 'string'
    || typeof rawBundle.checksums.manual !== 'string') {
    throw new Error('validated quality raw bundle is required');
  }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('quality report object is required');
  }
  const allowed = new Set([
    'version', 'productionReleaseMutation', 'eligible', 'failedGates', 'candidateRelease',
    'planChecksum', 'replayProvenance', 'qualityGate', 'manualReview', 'reportId',
    'evidenceBoundary', 'sourceHead', 'replayRunId', 'qualityPlanSha256',
    'qualityReplaySha256', 'qualityManualReviewSha256', 'evidenceBoundaryChecksum'
  ]);
  if (Object.keys(artifact).some(key => !allowed.has(key))) {
    throw new Error('quality report contains unknown fields');
  }
  if (artifact.version !== 1 || artifact.productionReleaseMutation !== false
    || artifact.eligible !== true || !Array.isArray(artifact.failedGates)
    || artifact.failedGates.length !== 0 || !artifact.candidateRelease
    || typeof artifact.planChecksum !== 'string' || artifact.planChecksum.length === 0
    || !artifact.replayProvenance || typeof artifact.replayProvenance !== 'object'
    || Array.isArray(artifact.replayProvenance)
    || !Array.isArray(artifact.replayProvenance.executionPairs)
    || !Array.isArray(artifact.replayProvenance.modelRuns)
    || !artifact.qualityGate || typeof artifact.qualityGate !== 'object'
    || Array.isArray(artifact.qualityGate)
    || artifact.qualityGate.eligible !== true
    || !Array.isArray(artifact.qualityGate.failedGates)
    || artifact.qualityGate.failedGates.length !== 0
    || !artifact.manualReview || artifact.manualReview.eligible !== true
    || !Array.isArray(artifact.manualReview.failedGates)
    || artifact.manualReview.failedGates.length !== 0
    || !artifact.evidenceBoundary
    || artifact.evidenceBoundary.version !== 1
    || artifact.evidenceBoundary.inputMode !== 'preset_default'
    || artifact.evidenceBoundary.sourceClass !== 'tracked_human_annotations'
    || artifact.evidenceBoundary.offlineModelEvaluation !== true
    || artifact.evidenceBoundary.realHistoryEvidence !== false
    || artifact.evidenceBoundary.liveShadowEvidence !== false
    || !/^[0-9a-f]{40}$/.test(artifact.sourceHead || '')
    || !/^[0-9a-f]{64}$/.test(artifact.planChecksum || '')
    || !/^[0-9a-f]{64}$/.test(artifact.evidenceBoundaryChecksum || '')
    || (artifact.reportId !== undefined
      && (typeof artifact.reportId !== 'string' || artifact.reportId.length === 0))) {
    throw new Error('eligible materialized quality report is required');
  }
  if (artifact.evidenceBoundaryChecksum !== evidenceBoundaryChecksum({
    evidenceBoundary: artifact.evidenceBoundary,
    planChecksum: artifact.planChecksum,
    sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum
  })) {
    throw new Error('eligible materialized quality report evidence boundary checksum conflict');
  }
  let trackedPlan;
  try {
    trackedPlan = createQualityReplayPlan({ rootDir });
  } catch (error) {
    throw new Error(`tracked annotation plan unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (artifact.planChecksum !== trackedPlan.planChecksum) {
    throw new Error('quality report plan is not the tracked annotation plan');
  }
  if (rawBundle.plan.planChecksum !== trackedPlan.planChecksum
    || canonicalJson(rawBundle.provenance) !== canonicalJson(artifact.replayProvenance)
    || artifact.qualityPlanSha256 !== rawBundle.checksums.plan
    || artifact.qualityReplaySha256 !== rawBundle.checksums.replay
    || artifact.qualityManualReviewSha256 !== rawBundle.checksums.manual
    || artifact.replayRunId !== rawBundle.runId) {
    throw new Error('quality raw bundle/report binding conflict');
  }
  const expectedProjection = expectedFinalKeysProjection(trackedPlan);
  const expectedFinalKeys = [
    ...expectedProjection.finalKeys.sentinelFinalKeys,
    ...expectedProjection.finalKeys.coverageFinalKeys,
    ...expectedProjection.finalKeys.historyFinalKeys
  ];
  try {
    assertQualityReportProvenance(artifact.replayProvenance, {
      expectedFinalKeys,
      candidateRelease: artifact.candidateRelease,
      sourceHead: artifact.sourceHead
    });
  } catch (error) {
    throw new Error(`eligible materialized quality report provenance: ${error instanceof Error ? error.message : String(error)}`);
  }
  const pair = artifact.replayProvenance?.executionPairs?.[0] || {};
  const candidate = artifact.candidateRelease;
  return {
    eligible: true,
    candidateRelease: candidate,
    stableBaselineReleaseId: pair.stableReleaseId,
    stableBaselineReleaseChecksum: pair.stableReleaseChecksum,
    evaluatorVersion: candidate.evaluatorVersion,
    suiteChecksum: artifact.planChecksum || '',
    evidenceBoundaryChecksum: artifact.evidenceBoundaryChecksum,
    sourceHead: artifact.sourceHead,
    provenanceChecksum: artifact.replayProvenance.provenanceChecksum,
    replayRunId: rawBundle.runId,
    qualityPlanSha256: rawBundle.checksums.plan,
    qualityReplaySha256: rawBundle.checksums.replay,
    qualityManualReviewSha256: rawBundle.checksums.manual,
    liveShadowSuccessCount: Number(artifact.qualityGate?.liveShadowSuccessCount || 0),
    criticalErrors: Number(artifact.qualityGate?.criticalErrors || 0)
  };
}

function persistMaterializedReport(store, rolloutKey, artifactPath, rollout, { rootDir = process.cwd() } = {}) {
  const artifact = readJson(resolve(artifactPath), 'quality report');
  const rawBundle = loadQualityPromotionRawBundle({ artifactPath, artifact, rootDir });
  const summary = reportSummaryFromArtifact({ artifact, rollout, rootDir, rawBundle });
  store.validateMaterializedPromotionReportInputInternal({ rolloutKey, summary });
  const reportId = artifact.reportId
    || `quality_report_${contentHash({ rolloutKey, artifact }).slice(0, 24)}`;
  const summaryChecksum = contentHash(summary);
  const existing = store.getEvaluationReport(reportId);
  if (existing) {
    if (existing.reportType !== 'promotion'
      || existing.rolloutKey !== String(rolloutKey)
      || existing.sourceType !== 'aggregate_gate'
      || existing.sourceRef !== artifactPath
      || existing.artifactPath !== artifactPath
      || existing.artifactChecksum !== summaryChecksum
      || contentHash(existing.summary || {}) !== existing.artifactChecksum) {
      throw new Error('quality report authority conflict');
    }
    if (existing.artifactState === 'materialized') return existing;
    if (existing.artifactState === 'pending') {
      return store.markEvaluationReportMaterialized({
        reportId: existing.reportId,
        expectedChecksum: summaryChecksum,
        now: Date.now()
      });
    }
    throw new Error('quality report state conflict');
  }
  const stored = store.putEvaluationReportInternal({
    reportId,
    reportType: 'promotion',
    rolloutKey,
    sourceType: 'aggregate_gate',
    sourceRef: artifactPath,
    artifactPath,
    summary,
    createdAt: Date.now()
  });
  return store.markEvaluationReportMaterialized({
    reportId: stored.reportId,
    expectedChecksum: stored.artifactChecksum,
    now: Date.now()
  });
}

export function executeRolloutCommand({ command, options, stdout = process.stdout } = {}) {
  const kind = String(options?.kind || 'DIRECT_REPLY');
  const configPath = options?.config;
  if (!configPath) throw new Error('--config is required');
  const rootDir = options.root ? resolve(String(options.root)) : process.cwd();
  if (command === 'promote') {
    preflightRolloutSourceAuthority({
      rootDir,
      reportPath: options.report
    });
  }
  const runtime = runtimeFromConfig(configPath, { readOnly: command === 'status' || command === 'check' });
  let commandError = null;
  try {
    const { store, controller } = runtime;
    if (command === 'status') {
      const status = controller.listStatus().map(row => ({
        ...row,
        evidence: controller.promotionCheck(row.rolloutKey)
      }));
      const result = { command, status, productionReleaseMutation: false };
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result;
    }
    if (command === 'check') {
      const result = controller.promotionCheck(kind);
      stdout.write(`${JSON.stringify({ command, ...result, productionReleaseMutation: false }, null, 2)}\n`);
      return result;
    }
    const current = controller.getStatus(kind);
    if (!current) throw new Error(`cognition rollout is unavailable: ${kind}`);
    if (command === 'rollback') {
      const result = controller.rollbackCandidate({
        rolloutKey: kind,
        expectedRevision: Number(options['expected-revision']),
        reasonCode: String(options.reason || 'MANUAL_SAFETY_ROLLBACK')
      });
      stdout.write(`${JSON.stringify({ command, rollout: result }, null, 2)}\n`);
      return result;
    }
    if (command !== 'promote') throw new Error(`unknown cognition rollout command: ${command}`);
    const report = persistMaterializedReport(store, kind, options.report, current, {
      rootDir
    });
    if (options['candidate-release-id']
      && String(options['candidate-release-id']) !== report.summary.candidateRelease.releaseId) {
      throw new Error('candidate release id does not match materialized quality report');
    }
    const input = {
      rolloutKey: kind,
      expectedRevision: Number(options['expected-revision']),
      reportId: report.reportId,
      reportChecksum: report.artifactChecksum
    };
    const result = current.candidatePhase === 'none' || current.candidatePhase === 'rolled_back'
      ? controller.registerCandidate({
          ...input,
          releaseId: report.summary.candidateRelease.releaseId
        })
      : current.candidatePhase === 'shadow'
        ? controller.promoteToCanary(input)
        : current.candidatePhase === 'canary'
          ? controller.graduateCandidate(input)
          : (() => { throw new Error(`promotion phase is not actionable: ${current.candidatePhase}`); })();
    stdout.write(`${JSON.stringify({ command, rollout: result }, null, 2)}\n`);
    return result;
  } catch (error) {
    commandError = error;
    throw error;
  } finally {
    runtime.store.close();
    if (runtime.readonlyAudit) {
      const audit = runtime.readonlyAudit;
      const changed = databaseFingerprint(audit.sourceDatabasePath) !== audit.sourceFingerprint
        || databaseUserVersion(audit.sourceDatabasePath) !== audit.sourceVersion;
      try { rmSync(audit.tempDir, { recursive: true, force: true }); } catch {}
      if (changed && !commandError) throw new Error('read-only rollout audit mutated source database');
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] || 'status';
  try {
    executeRolloutCommand({ command, options });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
