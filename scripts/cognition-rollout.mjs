import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

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

function reportSummaryFromArtifact({ artifact, rollout }) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error('quality report object is required');
  }
  const allowed = new Set([
    'version', 'productionReleaseMutation', 'eligible', 'failedGates', 'candidateRelease',
    'planChecksum', 'replayProvenance', 'qualityGate', 'manualReview', 'reportId'
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
    || (artifact.reportId !== undefined
      && (typeof artifact.reportId !== 'string' || artifact.reportId.length === 0))) {
    throw new Error('eligible materialized quality report is required');
  }
  const pair = artifact.replayProvenance?.executionPairs?.[0] || {};
  const candidate = artifact.candidateRelease;
  return {
    eligible: true,
    candidateRelease: candidate,
    stableBaselineReleaseId: pair.stableReleaseId || rollout.stableReleaseId,
    stableBaselineReleaseChecksum: pair.stableReleaseChecksum
      || null,
    evaluatorVersion: candidate.evaluatorVersion,
    suiteChecksum: artifact.planChecksum || '',
    liveShadowSuccessCount: Number(artifact.qualityGate?.liveShadowSuccessCount || 0),
    criticalErrors: Number(artifact.qualityGate?.criticalErrors || 0)
  };
}

function persistMaterializedReport(store, rolloutKey, artifactPath, rollout) {
  const artifact = readJson(resolve(artifactPath), 'quality report');
  const summary = reportSummaryFromArtifact({ artifact, rollout });
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
    const report = persistMaterializedReport(store, kind, options.report, current);
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
