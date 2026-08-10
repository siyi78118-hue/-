import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  assertAuthorityClosure,
  assertReadonlyV15Schema
} from './extract-yuqi-real-history-scenes.mjs';

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const KINDS = new Set([
  'DIRECT_REPLY', 'ROLE_PLAN_CHAT', 'ROLE_PLAN_MOMENT', 'ROLE_PLAN_CHAT_PRIVATE',
  'ROLE_PLAN_MOMENT_PRIVATE', 'PROACTIVE_CHAT', 'PROACTIVE_MOMENT',
  'MOMENT_INTERACTION', 'MOMENT_REPLY'
]);
const OPTION_KEYS = new Set([
  'candidateReleaseChecksum', 'candidateReleaseId', 'completedAt', 'databasePath',
  'outputPath', 'runId', 'sourceHead', 'startedAt'
]);

function fail(message) {
  throw new Error(`visible path PC export: ${message}`);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sha256Canonical(value) {
  const bytes = Buffer.isBuffer(value) || value instanceof Uint8Array
    ? value
    : Buffer.from(typeof value === 'string' ? value : canonical(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex');
}

function exactOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('options shape');
  for (const key of Object.keys(options)) if (!OPTION_KEYS.has(key)) fail(`unknown option ${key}`);
  if (Object.keys(options).length !== OPTION_KEYS.size
    || [...OPTION_KEYS].some(key => !Object.hasOwn(options, key))) fail('options shape');
}

function safeTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > Date.now()) fail(`${label} timestamp`);
  return value;
}

function assertInput(options) {
  exactOptions(options);
  if (typeof options.databasePath !== 'string' || !isAbsolute(options.databasePath)
    || typeof options.outputPath !== 'string' || !isAbsolute(options.outputPath)) fail('absolute paths required');
  if (typeof options.candidateReleaseId !== 'string' || options.candidateReleaseId.length === 0
    || !HEX64.test(options.candidateReleaseChecksum || '')
    || !HEX40.test(options.sourceHead || '')
    || !UUID.test(options.runId || '')) fail('run identity');
  safeTimestamp(options.startedAt, 'startedAt');
  safeTimestamp(options.completedAt, 'completedAt');
  if (options.completedAt < options.startedAt) fail('run timestamp order');
  const outputPath = resolve(options.outputPath);
  if (basename(outputPath) !== 'visible-path-pc.jsonl' || basename(dirname(outputPath)) !== 'private') {
    fail('fixed output path');
  }
  if (existsSync(outputPath)) fail('output already exists');
}

function assertFrozenSource(databasePath) {
  const snapshot = captureFrozenSourceSnapshot(databasePath);
  for (const suffix of ['-wal', '-journal']) {
    const sidecar = snapshot[suffix.slice(1)];
    if (sidecar.exists && sidecar.size > 0) fail(`source database has uncheckpointed ${suffix.slice(1)}`);
  }
}

function snapshotFile(path, required) {
  if (!existsSync(path)) {
    if (required) fail('source database missing');
    return { exists: false, mtimeMs: null, sha256: null, size: null };
  }
  const stats = lstatSync(path);
  if (!stats.isFile()) fail('source database snapshot entry');
  return {
    exists: true,
    mtimeMs: stats.mtimeMs,
    sha256: sha256Canonical(readFileSync(path)),
    size: stats.size
  };
}

export function captureFrozenSourceSnapshot(databasePath) {
  const resolved = resolve(databasePath);
  return {
    database: snapshotFile(resolved, true),
    wal: snapshotFile(`${resolved}-wal`, false),
    journal: snapshotFile(`${resolved}-journal`, false)
  };
}

export function assertFrozenSourceSnapshotUnchanged(databasePath, expected) {
  assertFrozenSource(databasePath);
  const actual = captureFrozenSourceSnapshot(databasePath);
  if (canonical(actual) !== canonical(expected)) {
    const entry = ['database', 'wal', 'journal'].find(name =>
      canonical(actual[name]) !== canonical(expected?.[name]));
    const field = ['exists', 'size', 'mtimeMs', 'sha256'].find(name =>
      actual[entry]?.[name] !== expected?.[entry]?.[name]);
    fail(`source database changed during export (${entry || 'snapshot'}.${field || 'shape'})`);
  }
}

function assertSchema(database) {
  try {
    assertReadonlyV15Schema(database);
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || String(integrity[0].integrity_check) !== 'ok') {
      throw new Error('source integrity');
    }
    const foreign = database.prepare('PRAGMA foreign_key_check').all();
    if (foreign.length !== 0) throw new Error('source foreign key closure');
    assertAuthorityClosure(database);
  } catch (error) {
    fail(`source authority closure: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function authorityMode(database, row) {
  const revision = Number(row.rollout_revision);
  if (!Number.isSafeInteger(revision) || revision < 1) fail('pinned rollout authority');
  const rollout = database.prepare(
    'SELECT * FROM cognition_kind_rollouts WHERE rollout_key = ?'
  ).get(row.rollout_key);
  if (!rollout) fail('pinned rollout authority');
  const historical = database.prepare(`
    SELECT from_mode, to_mode, from_phase, to_phase, from_revision, to_revision
    FROM cognition_promotion_history
    WHERE rollout_key = ? AND (from_revision = ? OR to_revision = ?)
  `).all(row.rollout_key, revision, revision);
  const states = [];
  if (Number(rollout.revision) === revision) {
    states.push({ mode: rollout.current_mode, phase: rollout.rollout_phase, current: true });
  }
  for (const event of historical) {
    if (Number(event.from_revision) === revision) states.push({ mode: event.from_mode, phase: event.from_phase, current: false });
    if (Number(event.to_revision) === revision) states.push({ mode: event.to_mode, phase: event.to_phase, current: false });
  }
  const unique = new Map(states.map(state => [`${state.mode}\u0000${state.phase}`, state]));
  if (unique.size !== 1) fail('pinned rollout authority');
  const state = [...unique.values()][0];
  if (String(row.pipeline_mode) !== String(state.mode)) fail('pinned rollout mode authority');
  if (row.pipeline_mode === 'active'
    && (row.comparison_mode === 'legacy_compare' || row.comparison_mode === 'none')) {
    const expectedPhase = row.comparison_mode === 'legacy_compare' ? 'canary' : 'stable';
    if (state.phase !== expectedPhase) fail('pinned rollout phase authority');
    if (state.current) {
      const expectedRelease = expectedPhase === 'canary'
        ? rollout.candidate_release_id : rollout.stable_release_id;
      if (expectedRelease !== row.authoritative_release_id
        || (expectedPhase === 'canary' && Number(row.canary_epoch) !== Number(rollout.canary_epoch))) {
        fail('pinned rollout release authority');
      }
    }
    return 'active_canary';
  }
  if (row.pipeline_mode === 'shadow' && row.comparison_mode === 'cognition_compare') {
    if (state.phase !== 'collecting') fail('pinned rollout phase authority');
    if (state.current && (rollout.stable_release_id !== row.authoritative_release_id
      || rollout.candidate_release_id !== row.comparison_release_id
      || Number(row.shadow_epoch) !== Number(rollout.shadow_epoch))) {
      fail('pinned rollout release authority');
    }
    return 'live_shadow';
  }
  fail('pinned authority mode');
}

function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function selectRows(database, options) {
  const releaseRows = database.prepare(`
    SELECT release_id, release_checksum FROM pipeline_releases WHERE release_id = ?
  `).all(options.candidateReleaseId);
  if (releaseRows.length !== 1
    || String(releaseRows[0].release_checksum) !== options.candidateReleaseChecksum) {
    fail('candidate release authority');
  }
  const selected = database.prepare(`
    SELECT
      g.group_id, g.lineage_key AS group_lineage_key,
      g.authoritative_turn_id AS group_turn_id, g.authority_origin,
      g.authoritative_release_id AS group_release_id, g.redacted_at AS group_redacted_at,
      g.created_at AS group_created_at,
      t.turn_id, t.result_authority_version, t.state AS turn_state,
      t.rollout_key, t.pipeline_mode, t.comparison_mode,
      t.rollout_revision, t.rollout_evidence_epoch, t.shadow_epoch, t.canary_epoch,
      t.authoritative_release_id AS turn_release_id,
      t.comparison_release_id,
      t.authority_lineage_key AS turn_lineage_key,
      t.authority_redacted_at AS turn_redacted_at,
      l.latest_turn_id, l.state AS lineage_state,
      l.committed_group_id, l.redacted_at AS lineage_redacted_at,
      m.semantic_json, m.redacted_at AS manifest_redacted_at,
      r.lineage_key AS receipt_lineage_key, r.group_id AS receipt_group_id,
      r.authoritative_turn_id AS receipt_turn_id, r.commit_checksum,
      r.committed_at
    FROM visible_result_groups g
    LEFT JOIN turns t ON t.turn_id = g.authoritative_turn_id
    LEFT JOIN turn_authority_lineages l ON l.lineage_key = g.lineage_key
    LEFT JOIN visible_result_manifests m ON m.group_id = g.group_id
    LEFT JOIN visible_commit_receipts r ON r.group_id = g.group_id
    WHERE g.authoritative_release_id = ?
      AND r.committed_at BETWEEN ? AND ?
    ORDER BY r.committed_at, g.authoritative_turn_id
  `).all(options.candidateReleaseId, options.startedAt, options.completedAt);
  const rows = [];
  const seen = new Set();
  for (const row of selected) {
    if (Number(row.result_authority_version) !== 1
      || !['committed', 'delivered', 'completed'].includes(row.turn_state)
      || row.lineage_state !== 'committed'
      || row.authority_origin !== 'pc'
      || row.turn_id !== row.group_turn_id
      || row.latest_turn_id !== row.turn_id
      || row.committed_group_id !== row.group_id
      || row.turn_lineage_key !== row.group_lineage_key
      || row.receipt_lineage_key !== row.group_lineage_key
      || row.receipt_group_id !== row.group_id
      || row.receipt_turn_id !== row.turn_id
      || row.turn_release_id !== options.candidateReleaseId
      || row.group_release_id !== options.candidateReleaseId
      || !HEX64.test(String(row.commit_checksum || ''))
      || !KINDS.has(String(row.rollout_key || ''))
      || !isSafeInteger(row.group_created_at)
      || !isSafeInteger(row.committed_at)
      || row.committed_at > options.completedAt
      || row.committed_at < options.startedAt
      || row.committed_at < row.group_created_at) {
      fail('canonical authority join');
    }
    const pinnedAuthorityMode = authorityMode(database, row);
    const redactionTimes = [
      row.group_redacted_at, row.turn_redacted_at,
      row.lineage_redacted_at, row.manifest_redacted_at
    ];
    if (redactionTimes.some(value => value != null)) {
      if (redactionTimes.some(value => value == null)
        || new Set(redactionTimes.map(Number)).size !== 1
        || row.semantic_json != null) fail('redacted authority closure');
      continue;
    }
    if (row.semantic_json == null) {
      fail('canonical authority join');
    }
    const projected = {
      authorityLineageKeySha256: sha256Canonical(String(row.group_lineage_key)),
      authorityMode: pinnedAuthorityMode,
      kind: String(row.rollout_key),
      pipelineReleaseId: options.candidateReleaseId,
      turnIdSha256: sha256Canonical(String(row.turn_id)),
      visibleGroupIdSha256: sha256Canonical(String(row.group_id))
    };
    const tuple = canonical({
      authorityLineageKeySha256: projected.authorityLineageKeySha256,
      turnIdSha256: projected.turnIdSha256,
      visibleGroupIdSha256: projected.visibleGroupIdSha256
    });
    if (seen.has(tuple)) fail('duplicate authority tuple');
    seen.add(tuple);
    rows.push(projected);
  }
  if (rows.length === 0) fail('candidate rows empty');
  return rows;
}

function writeJsonl(outputPath, records, verifySource) {
  const parent = dirname(outputPath);
  mkdirSync(parent, { recursive: true });
  const temp = `${outputPath}.tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    writeFileSync(temp, `${records.map(record => JSON.stringify(record)).join('\n')}\n`, {
      encoding: 'utf8', flag: 'wx'
    });
    verifySource();
    if (existsSync(outputPath)) fail('output already exists');
    renameSync(temp, outputPath);
    renamed = true;
    verifySource();
  } catch (error) {
    rmSync(temp, { force: true });
    if (renamed) rmSync(outputPath, { force: true });
    throw error;
  }
}

export function exportYuqiVisiblePathPc(options) {
  assertInput(options);
  const databasePath = resolve(options.databasePath);
  const outputPath = resolve(options.outputPath);
  assertFrozenSource(databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec('PRAGMA query_only = ON;');
    assertFrozenSource(databasePath);
    assertSchema(database);
    assertFrozenSource(databasePath);
    const sourceSnapshot = captureFrozenSourceSnapshot(databasePath);
    const beforeHash = sourceSnapshot.database.sha256;
    const rows = selectRows(database, options);
    assertFrozenSourceSnapshotUnchanged(databasePath, sourceSnapshot);
    const attestationBase = {
      candidateReleaseChecksum: options.candidateReleaseChecksum,
      candidateReleaseId: options.candidateReleaseId,
      completedAt: options.completedAt,
      databaseUserVersion: 15,
      producer: 'pc_authority_readonly_export_v1',
      readOnly: true,
      rowCount: rows.length,
      runId: options.runId,
      selectionChecksum: sha256Canonical({ producer: 'pc_authority_readonly_export_v1', rows }),
      sourceDatabaseSha256: beforeHash,
      sourceHead: options.sourceHead,
      startedAt: options.startedAt
    };
    const producerAttestation = {
      ...attestationBase,
      attestationChecksum: sha256Canonical(attestationBase)
    };
    const metadata = {
      recordType: 'metadata',
      schemaVersion: 'yuqi-v3-visible-path-pc-v1',
      candidateReleaseId: options.candidateReleaseId,
      candidateReleaseChecksum: options.candidateReleaseChecksum,
      sourceHead: options.sourceHead,
      runId: options.runId,
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      producerAttestation
    };
    writeJsonl(outputPath, [metadata, ...rows], () =>
      assertFrozenSourceSnapshotUnchanged(databasePath, sourceSnapshot));
    return { outputPath, metadata, rows };
  } finally {
    database.close();
  }
}

function cliOptions(argv) {
  const aliases = new Map([
    ['--database', 'databasePath'], ['--out', 'outputPath'],
    ['--candidate-release-id', 'candidateReleaseId'],
    ['--candidate-release-checksum', 'candidateReleaseChecksum'],
    ['--source-head', 'sourceHead'], ['--run-id', 'runId'],
    ['--started-at', 'startedAt'], ['--completed-at', 'completedAt']
  ]);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = aliases.get(argv[index]);
    if (!key || argv[index + 1] == null) fail(`unknown CLI argument ${argv[index]}`);
    const raw = argv[++index];
    options[key] = key === 'startedAt' || key === 'completedAt' ? Number(raw) : raw;
  }
  if (options.databasePath) options.databasePath = resolve(options.databasePath);
  if (options.outputPath) options.outputPath = resolve(options.outputPath);
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = exportYuqiVisiblePathPc(cliOptions(process.argv.slice(2)));
    console.log(JSON.stringify({ outputPath: result.outputPath, rowCount: result.rows.length }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
