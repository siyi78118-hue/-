import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  canonicalJson,
  contentHash,
  deriveYuqiBackupReceiptId,
  validateAndroidRoomBackupHead,
  validateYuqiBackupReceipt
} from '../yuqi-runtime/src/protocol.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const MANIFEST_KEYS = Object.freeze([
  'manifestVersion', 'createdAt', 'schemaVersion', 'snapshotSha256',
  'logicalChecksum', 'tableRowCounts', 'roleLifecycleHeads',
  'redactedInvariantSummary', 'androidRoomHead', 'manifestChecksum'
]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-');
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function assertSafePositiveInteger(value, label) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function assertClosedKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} shape conflict`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} shape conflict`);
  }
}

function typedCell(value, database, quoteStatement) {
  if (value == null) return { type: 'null' };
  if (typeof value === 'bigint') return { type: 'integer', value: value.toString(10) };
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return { type: 'integer', value: String(value) };
    return { type: 'real', value: String(quoteStatement.get(value).value) };
  }
  if (typeof value === 'string') return { type: 'text', value };
  if (value instanceof Uint8Array) {
    return { type: 'blob', value: Buffer.from(value).toString('hex') };
  }
  void database;
  throw new Error('unsupported SQLite backup cell type');
}

function tableNames(database) {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type='table' AND (name NOT LIKE 'sqlite_%' OR name='sqlite_sequence')
    ORDER BY name
  `).all().map(row => String(row.name));
}

function logicalSnapshot(database, schemaVersion) {
  const quoteStatement = database.prepare('SELECT quote(?) AS value');
  const tables = tableNames(database).map(tableName => {
    const createSql = String(database.prepare(`
      SELECT sql FROM sqlite_master WHERE type='table' AND name=?
    `).get(tableName)?.sql || '');
    if (!createSql) throw new Error(`backup table schema missing: ${tableName}`);
    const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
      .sort((left, right) => Number(left.cid) - Number(right.cid));
    const select = database.prepare(`SELECT * FROM ${quoteIdentifier(tableName)}`);
    if (typeof select.setReadBigInts === 'function') select.setReadBigInts(true);
    const rows = select.all().map(row => columns.map(column =>
      typedCell(row[column.name], database, quoteStatement)
    ));
    rows.sort((left, right) => {
      const leftJson = canonicalJson(left);
      const rightJson = canonicalJson(right);
      return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
    });
    return { tableName, createSql, rows };
  });
  const basis = { contract: 'yuqi-backup-logical-v1', schemaVersion, tables };
  return {
    logicalChecksum: contentHash(basis),
    tableRowCounts: tables.map(table => ({ tableName: table.tableName, rowCount: table.rows.length }))
  };
}

function hasTable(database, tableName) {
  return Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(tableName));
}

function hasColumn(database, tableName, columnName) {
  if (!hasTable(database, tableName)) return false;
  return database.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all()
    .some(column => String(column.name) === columnName);
}

function roleLifecycleHeads(database) {
  const controls = hasTable(database, 'conversation_clear_controls')
    ? database.prepare(`
        SELECT control_id, role_id, clear_epoch, cleared_through_sequence, applied_at, checksum
        FROM conversation_clear_controls ORDER BY role_id, clear_epoch DESC, control_id
      `).all() : [];
  const lanes = hasTable(database, 'interaction_lanes')
    ? database.prepare(`
        SELECT role_id, lane_key, revision,
               ${hasColumn(database, 'interaction_lanes', 'clear_epoch') ? 'clear_epoch' : '0 AS clear_epoch'},
               ${hasColumn(database, 'interaction_lanes', 'cleared_through_sequence')
                 ? 'cleared_through_sequence' : '0 AS cleared_through_sequence'},
               last_commit_checksum
        FROM interaction_lanes ORDER BY role_id, lane_key
      `).all() : [];
  const lineages = hasTable(database, 'turn_authority_lineages')
    ? database.prepare(`
        SELECT lineage_key, role_id, lane_key, latest_turn_id, revision, state,
               committed_group_id,
               ${hasColumn(database, 'turn_authority_lineages', 'redacted_at')
                 ? 'redacted_at' : 'NULL AS redacted_at'}
        FROM turn_authority_lineages ORDER BY role_id, lineage_key
      `).all() : [];
  const roles = [...new Set([
    ...controls.map(row => String(row.role_id)),
    ...lanes.map(row => String(row.role_id)),
    ...lineages.map(row => String(row.role_id))
  ])].sort();
  return roles.map(roleId => {
    const control = controls.find(row => String(row.role_id) === roleId) || null;
    return {
      roleId,
      clearHead: control == null ? null : {
        controlId: String(control.control_id),
        clearEpoch: Number(control.clear_epoch),
        clearedThroughSequence: Number(control.cleared_through_sequence),
        appliedAt: Number(control.applied_at),
        checksum: String(control.checksum)
      },
      laneHeads: lanes.filter(row => String(row.role_id) === roleId).map(row => ({
        laneKey: String(row.lane_key),
        revision: Number(row.revision),
        clearEpoch: Number(row.clear_epoch || 0),
        clearedThroughSequence: Number(row.cleared_through_sequence || 0),
        lastCommitChecksum: row.last_commit_checksum == null ? null : String(row.last_commit_checksum)
      })),
      lineageHeads: lineages.filter(row => String(row.role_id) === roleId).map(row => ({
        lineageKey: String(row.lineage_key),
        laneKey: String(row.lane_key),
        latestTurnId: String(row.latest_turn_id),
        revision: Number(row.revision),
        state: String(row.state),
        committedGroupId: row.committed_group_id == null ? null : String(row.committed_group_id),
        redactedAt: row.redacted_at == null ? null : Number(row.redacted_at)
      }))
    };
  });
}

function count(database, sql) {
  return Number(database.prepare(sql).get().value);
}

function redactedInvariantSummary(database) {
  const sync = hasTable(database, 'sync_log');
  return {
    legacyRedactedTurns: sync ? count(database,
      "SELECT COUNT(DISTINCT entity_id) AS value FROM sync_log WHERE entity_type='legacy_turn_redaction'") : 0,
    redactedLineages: hasColumn(database, 'turn_authority_lineages', 'redacted_at') ? count(database,
      'SELECT COUNT(*) AS value FROM turn_authority_lineages WHERE redacted_at IS NOT NULL') : 0,
    redactedGroups: hasColumn(database, 'visible_result_groups', 'redacted_at') ? count(database,
      'SELECT COUNT(*) AS value FROM visible_result_groups WHERE redacted_at IS NOT NULL') : 0,
    authorityRedactionAudits: sync ? count(database,
      "SELECT COUNT(*) AS value FROM sync_log WHERE entity_type='authority_redaction'") : 0,
    agencyRedactionAudits: sync ? count(database,
      "SELECT COUNT(*) AS value FROM sync_log WHERE entity_type='agency_redaction'") : 0,
    factRedactionAudits: sync ? count(database,
      "SELECT COUNT(*) AS value FROM sync_log WHERE entity_type='fact_redaction'") : 0,
    factRedactionSetAudits: sync ? count(database,
      "SELECT COUNT(*) AS value FROM sync_log WHERE entity_type='fact_redaction_set'") : 0
  };
}

function inspectSnapshotAuthority(snapshotPath) {
  const database = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const schemaVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version || 0);
    const logical = logicalSnapshot(database, schemaVersion);
    return {
      schemaVersion,
      ...logical,
      roleLifecycleHeads: roleLifecycleHeads(database),
      redactedInvariantSummary: redactedInvariantSummary(database)
    };
  } finally {
    database.close();
  }
}

function writeSnapshot(databasePath, snapshotPath) {
  if (existsSync(snapshotPath)) rmSync(snapshotPath);
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA wal_checkpoint(FULL);');
    database.exec(`VACUUM INTO ${sqliteString(snapshotPath)};`);
  } finally {
    database.close();
  }
}

export function createMemorySnapshot(options = {}) {
  const databasePath = resolve(options.databasePath || '');
  if (!databasePath || !existsSync(databasePath)) throw new Error('Yuqi memory database does not exist');
  const snapshotsDir = resolve(options.snapshotsDir || join(dirname(databasePath), '..', 'snapshots'));
  const retain = Math.max(1, Number(options.retain) || 30);
  mkdirSync(snapshotsDir, { recursive: true });
  const snapshotPath = join(snapshotsDir, `yuqi-memory-${stamp(options.now)}.sqlite`);
  writeSnapshot(databasePath, snapshotPath);

  const snapshots = readdirSync(snapshotsDir)
    .filter(name => /^yuqi-memory-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const name of snapshots.slice(retain)) rmSync(join(snapshotsDir, name));
  return snapshotPath;
}

export function inspectMemorySnapshot(snapshotPath) {
  const resolved = resolve(snapshotPath || '');
  if (!resolved || !existsSync(resolved)) throw new Error('Yuqi memory snapshot does not exist');
  const sha256 = sha256File(resolved);
  const authority = inspectSnapshotAuthority(resolved);
  return {
    snapshotPath: resolved,
    sha256,
    schemaVersion: authority.schemaVersion,
    tableCounts: Object.fromEntries(authority.tableRowCounts.map(row => [row.tableName, row.rowCount])),
    logicalChecksum: authority.logicalChecksum,
    roleLifecycleHeads: authority.roleLifecycleHeads,
    redactedInvariantSummary: authority.redactedInvariantSummary
  };
}

function manifestWithoutChecksum(manifest) {
  const {
    manifestVersion,
    createdAt,
    schemaVersion,
    snapshotSha256,
    logicalChecksum,
    tableRowCounts,
    roleLifecycleHeads,
    redactedInvariantSummary,
    androidRoomHead
  } = manifest;
  return {
    manifestVersion,
    createdAt,
    schemaVersion,
    snapshotSha256,
    logicalChecksum,
    tableRowCounts,
    roleLifecycleHeads,
    redactedInvariantSummary,
    androidRoomHead
  };
}

function buildManifest(snapshotPath, createdAt, androidRoomHead) {
  const authority = inspectSnapshotAuthority(snapshotPath);
  const manifest = {
    manifestVersion: 'yuqi-backup-manifest-v1',
    createdAt,
    schemaVersion: authority.schemaVersion,
    snapshotSha256: sha256File(snapshotPath),
    logicalChecksum: authority.logicalChecksum,
    tableRowCounts: authority.tableRowCounts,
    roleLifecycleHeads: authority.roleLifecycleHeads,
    redactedInvariantSummary: authority.redactedInvariantSummary,
    androidRoomHead
  };
  return { ...manifest, manifestChecksum: contentHash(manifest) };
}

function assertArtifactDirectory(artifactDir) {
  const resolved = resolve(artifactDir || '');
  if (!resolved || !existsSync(resolved) || lstatSync(resolved).isSymbolicLink()
    || !lstatSync(resolved).isDirectory()) {
    throw new Error('Yuqi backup artifact directory conflict');
  }
  const files = readdirSync(resolved).sort();
  if (canonicalJson(files) !== canonicalJson(['manifest.json', 'snapshot.sqlite'])) {
    throw new Error('Yuqi backup artifact shape conflict');
  }
  for (const name of files) {
    const path = join(resolved, name);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile()
      || dirname(realpathSync(path)) !== realpathSync(resolved)) {
      throw new Error('Yuqi backup artifact path conflict');
    }
  }
  return resolved;
}

function validateManifestShape(manifest) {
  assertClosedKeys(manifest, MANIFEST_KEYS, 'Yuqi backup manifest');
  if (manifest.manifestVersion !== 'yuqi-backup-manifest-v1') {
    throw new Error('Yuqi backup manifest version conflict');
  }
  assertSafePositiveInteger(manifest.createdAt, 'Yuqi backup manifest createdAt');
  if (typeof manifest.schemaVersion !== 'number'
    || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 0) {
    throw new Error('Yuqi backup manifest schema conflict');
  }
  for (const key of ['snapshotSha256', 'logicalChecksum', 'manifestChecksum']) {
    if (typeof manifest[key] !== 'string' || !/^[a-f0-9]{64}$/.test(manifest[key])) {
      throw new Error(`Yuqi backup manifest ${key} conflict`);
    }
  }
  if (!Array.isArray(manifest.tableRowCounts) || !Array.isArray(manifest.roleLifecycleHeads)) {
    throw new Error('Yuqi backup manifest shape conflict');
  }
  if (manifest.androidRoomHead !== null) validateAndroidRoomBackupHead(manifest.androidRoomHead);
  assertClosedKeys(manifest.redactedInvariantSummary, [
    'legacyRedactedTurns', 'redactedLineages', 'redactedGroups',
    'authorityRedactionAudits', 'agencyRedactionAudits',
    'factRedactionAudits', 'factRedactionSetAudits'
  ], 'Yuqi backup manifest redacted summary');
  if (manifest.manifestChecksum !== contentHash(manifestWithoutChecksum(manifest))) {
    throw new Error('Yuqi backup manifest checksum conflict');
  }
  return manifest;
}

function validateRestartInvariant(snapshotPath) {
  const verifyDir = mkdtempSync(join(tmpdir(), 'yuqi-backup-verify-'));
  const clonePath = join(verifyDir, 'snapshot.sqlite');
  try {
    copyFileSync(snapshotPath, clonePath);
    const store = new YuqiStore(clonePath);
    store.close();
  } finally {
    rmSync(verifyDir, { recursive: true, force: true });
  }
}

export function verifyYuqiBackup({ artifactDir } = {}) {
  const resolved = assertArtifactDirectory(artifactDir);
  const snapshotPath = join(resolved, 'snapshot.sqlite');
  const manifestPath = join(resolved, 'manifest.json');
  let manifest;
  try {
    const manifestText = readFileSync(manifestPath, 'utf8');
    manifest = validateManifestShape(JSON.parse(manifestText));
    if (manifestText !== `${canonicalJson(manifest)}\n`) {
      throw new Error('Yuqi backup manifest canonical JSON conflict');
    }
  } catch (error) {
    if (/manifest/i.test(String(error?.message || ''))) throw error;
    throw new Error('Yuqi backup manifest JSON conflict', { cause: error });
  }
  const beforeSha = sha256File(snapshotPath);
  if (beforeSha !== manifest.snapshotSha256) throw new Error('Yuqi backup snapshot checksum conflict');
  const authority = inspectSnapshotAuthority(snapshotPath);
  for (const key of [
    'schemaVersion', 'logicalChecksum', 'tableRowCounts',
    'roleLifecycleHeads', 'redactedInvariantSummary'
  ]) {
    if (canonicalJson(authority[key]) !== canonicalJson(manifest[key])) {
      throw new Error(`Yuqi backup manifest ${key} conflict`);
    }
  }
  validateRestartInvariant(snapshotPath);
  if (sha256File(snapshotPath) !== beforeSha) throw new Error('Yuqi backup snapshot mutation conflict');
  return {
    artifactDir: resolved,
    snapshotPath,
    manifestPath,
    manifest,
    logicalChecksum: authority.logicalChecksum
  };
}

function buildReceipt(roleId, manifest) {
  validateBackupRoleId(roleId);
  const basis = {
    receiptVersion: 'yuqi-backup-receipt-v1',
    receiptId: deriveYuqiBackupReceiptId({
      roleId,
      manifestChecksum: manifest.manifestChecksum,
      snapshotSha256: manifest.snapshotSha256,
      logicalChecksum: manifest.logicalChecksum,
      createdAt: manifest.createdAt
    }),
    roleId,
    manifestChecksum: manifest.manifestChecksum,
    snapshotSha256: manifest.snapshotSha256,
    logicalChecksum: manifest.logicalChecksum,
    createdAt: manifest.createdAt
  };
  return validateYuqiBackupReceipt({ ...basis, receiptChecksum: contentHash(basis) });
}

function validateBackupRoleId(roleId) {
  if (typeof roleId !== 'string' || !ID_PATTERN.test(roleId)) {
    throw new Error('Yuqi backup role identity conflict');
  }
  return roleId;
}

function existingVerifiedBackup({ databasePath, snapshotsDir, roleId, createdAt, androidRoomHead }) {
  const store = new YuqiStore(databasePath);
  try {
    const matches = [];
    for (const row of store.db.prepare(`
      SELECT payload_json FROM sync_log
      WHERE entity_type='backup_receipt' AND operation='create'
      ORDER BY seq
    `).all()) {
      const receipt = validateYuqiBackupReceipt(JSON.parse(row.payload_json));
      if (receipt.roleId === roleId && receipt.createdAt === createdAt) matches.push(receipt);
    }
    if (!matches.length) return null;
    if (matches.length !== 1) throw new Error('Yuqi backup request replay conflict');
    const receipt = matches[0];
    const artifactDir = join(snapshotsDir, 'verified', receipt.receiptId);
    const verified = verifyYuqiBackup({ artifactDir });
    if (verified.manifest.manifestChecksum !== receipt.manifestChecksum
      || verified.manifest.snapshotSha256 !== receipt.snapshotSha256
      || verified.manifest.logicalChecksum !== receipt.logicalChecksum
      || verified.manifest.createdAt !== receipt.createdAt) {
      throw new Error('Yuqi backup request replay artifact conflict');
    }
    if (canonicalJson(verified.manifest.androidRoomHead) !== canonicalJson(androidRoomHead)) {
      throw new Error('Yuqi backup request replay Android Room head conflict');
    }
    return {
      artifactDir,
      snapshotPath: verified.snapshotPath,
      manifestPath: verified.manifestPath,
      manifest: verified.manifest,
      receipt
    };
  } finally {
    store.close();
  }
}

export function createVerifiedYuqiBackup(options = {}) {
  const databasePath = resolve(options.databasePath || '');
  if (!databasePath || !existsSync(databasePath)) throw new Error('Yuqi memory database does not exist');
  const snapshotsDir = resolve(options.snapshotsDir || join(dirname(databasePath), '..', 'snapshots'));
  const createdAt = assertSafePositiveInteger(
    options.createdAt == null ? Date.now() : options.createdAt,
    'Yuqi backup createdAt'
  );
  const roleId = validateBackupRoleId(options.roleId);
  const androidRoomHead = options.androidRoomHead == null ? null
    : validateAndroidRoomBackupHead(options.androidRoomHead, { roleId });
  mkdirSync(snapshotsDir, { recursive: true });
  const replay = existingVerifiedBackup({
    databasePath,
    snapshotsDir,
    roleId,
    createdAt,
    androidRoomHead
  });
  if (replay) return replay;
  const pendingDir = mkdtempSync(join(snapshotsDir, '.verified-pending-'));
  const snapshotPath = join(pendingDir, 'snapshot.sqlite');
  const manifestPath = join(pendingDir, 'manifest.json');
  let finalDir;
  try {
    writeSnapshot(databasePath, snapshotPath);
    const manifest = buildManifest(snapshotPath, createdAt, androidRoomHead);
    writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, 'utf8');
    verifyYuqiBackup({ artifactDir: pendingDir });
    const receipt = buildReceipt(roleId, manifest);
    const verifiedRoot = join(snapshotsDir, 'verified');
    mkdirSync(verifiedRoot, { recursive: true });
    finalDir = join(verifiedRoot, receipt.receiptId);
    if (existsSync(finalDir)) {
      const existing = verifyYuqiBackup({ artifactDir: finalDir });
      if (canonicalJson(existing.manifest) !== canonicalJson(manifest)) {
        throw new Error('Yuqi backup receipt artifact conflict');
      }
      rmSync(pendingDir, { recursive: true, force: true });
    } else {
      renameSync(pendingDir, finalDir);
    }
    const store = new YuqiStore(databasePath);
    try {
      store.registerBackupReceiptInternal(receipt);
    } finally {
      store.close();
    }
    return {
      artifactDir: finalDir,
      snapshotPath: join(finalDir, 'snapshot.sqlite'),
      manifestPath: join(finalDir, 'manifest.json'),
      manifest,
      receipt
    };
  } catch (error) {
    if (existsSync(pendingDir)) rmSync(pendingDir, { recursive: true, force: true });
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'yuqi-runtime');
  const configPath = resolve(process.argv[2] || join(runtimeDir, 'config.json'));
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const databasePath = resolve(config.databasePath);
  const roleIndex = process.argv.indexOf('--role');
  const verifyMode = process.argv.includes('--verify');
  if (roleIndex >= 0 || verifyMode) {
    const result = createVerifiedYuqiBackup({
      databasePath,
      snapshotsDir: config.snapshotsDir,
      roleId: roleIndex >= 0 ? process.argv[roleIndex + 1] : String(config.roleId || 'yuqi')
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } else {
    const result = createMemorySnapshot({ databasePath, retain: Number(process.argv[3]) || 30 });
    const inspection = inspectMemorySnapshot(result);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      ...inspection,
      preMigrationDatabaseSha256: inspection.sha256
    })}\n`);
  }
}
