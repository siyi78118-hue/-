import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { canonicalJson, contentHash } from '../yuqi-runtime/src/protocol.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const STRUCTURAL_TABLES = Object.freeze([
  'messages',
  'facts',
  'relationship_states',
  'relationship_history',
  'role_plans',
  'life_episodes',
  'turns',
  'result_outbox',
  'turn_authority_lineages',
  'visible_result_groups',
  'visible_result_items',
  'visible_result_actions',
  'visible_commit_receipts',
  'cloud_deliveries'
]);

function normalizedText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function uniqueIds(values) {
  return [...new Set((values || []).map(value => String(value ?? '').trim()).filter(Boolean))];
}

function boundarySourceId(boundary) {
  return String(
    boundary?.boundaryId
    || boundary?.id
    || `legacy_boundary_${contentHash(boundary || {}).slice(0, 24)}`
  );
}

function resolveExactEvidence(sourceMessageIds, messages) {
  const index = new Map((messages || []).map(message => [String(message.messageId || ''), message]));
  const ids = uniqueIds(sourceMessageIds);
  if (!ids.length) return [];
  const resolved = ids.map(id => index.get(id));
  return resolved.every(Boolean) ? resolved : [];
}

function evidenceTextMatches(boundary, evidence) {
  const boundaryText = normalizedText(boundary?.text || boundary?.rule || boundary?.position);
  if (!boundaryText || !evidence.length) return false;
  return evidence.some(message => normalizedText(message.content) === boundaryText);
}

function isExplicitBoundaryEvidence(boundary, evidence) {
  if (!evidence.length
    || evidence.some(message => message.speakerType !== 'user')
    || !evidenceTextMatches(boundary, evidence)) {
    return false;
  }
  if (boundary?.authority === 'user'
    || boundary?.provenance === 'explicit_user_boundary'
    || boundary?.classification === 'hard_constraint') {
    return true;
  }
  const text = normalizedText(boundary?.text);
  return /^(?:请)?(?:不要|别|停止|不许|到此为止|这个限制可以取消|我不(?:同意|愿意|接受))/.test(text);
}

function isStillTemporallyRelevant(boundary, now) {
  if (boundary?.expiresAt != null) return Number(boundary.expiresAt) > Number(now);
  const text = normalizedText(boundary?.text);
  const temporal = /(?:今天|今晚|这次|这回|暂时|先不|现在不|目前)/.test(text);
  if (!temporal) return false;
  const createdAt = Number(boundary?.createdAt || 0);
  return !createdAt || Number(now) - createdAt <= 3 * 24 * 60 * 60 * 1000;
}

function shortExpiry(boundary, now) {
  if (boundary?.expiresAt != null) return Number(boundary.expiresAt);
  return Number(now) + 24 * 60 * 60 * 1000;
}

function classificationEvidence(evidence) {
  return evidence.map(message => ({
    messageId: String(message.messageId),
    speakerType: String(message.speakerType),
    createdAt: Number(message.createdAt ?? message.sentAt ?? 0)
  }));
}

function buildHardConstraintClassification(boundary, evidence, now) {
  const sourceId = boundarySourceId(boundary);
  const authority = ['system', 'author', 'user'].includes(boundary?.authority)
    ? boundary.authority
    : 'user';
  return {
    classification: 'hard_constraint',
    reasonCode: authority === 'user'
      ? 'EXPLICIT_MATCHING_USER_BOUNDARY'
      : 'DECLARED_SYSTEM_OR_AUTHOR_AUTHORITY',
    evidence: classificationEvidence(evidence),
    record: {
      constraintId: `constraint_migrated_${contentHash(sourceId).slice(0, 24)}`,
      revision: 1,
      roleId: String(boundary?.roleId || 'yuqi'),
      authority,
      kind: String(boundary?.kind || 'consent'),
      subject: String(boundary?.subject || 'both'),
      scope: boundary?.scope || { channel: 'all', target: String(boundary?.topic || 'legacy_boundary') },
      rule: normalizedText(boundary?.rule || boundary?.text),
      sourceMessageIds: uniqueIds(boundary?.sourceMessageIds),
      sourceConfigRef: boundary?.sourceConfigRef ?? null,
      releaseCondition: boundary?.releaseCondition ?? null,
      status: 'active',
      supersedes: null,
      createdAt: Number(boundary?.createdAt || now),
      updatedAt: Number(now)
    }
  };
}

function buildShortStanceClassification(boundary, evidence, now) {
  const sourceId = boundarySourceId(boundary);
  return {
    classification: 'current_stance',
    reasonCode: 'YUQI_TEMPORARY_ATTITUDE',
    evidence: classificationEvidence(evidence),
    record: {
      stanceId: `stance_migrated_${contentHash(sourceId).slice(0, 24)}`,
      revision: 1,
      roleId: String(boundary?.roleId || 'yuqi'),
      topic: String(boundary?.topic || boundary?.scope?.target || 'legacy_boundary'),
      position: normalizedText(boundary?.position || boundary?.text),
      reason: normalizedText(boundary?.reason || 'migrated temporary attitude'),
      strength: Math.min(1, Math.max(0, Number(boundary?.strength ?? 0.6))),
      flexibility: Math.min(1, Math.max(0, Number(boundary?.flexibility ?? 0.8))),
      sourceTurnId: String(boundary?.sourceTurnId || 'legacy_migration'),
      sourceMessageIds: uniqueIds(boundary?.sourceMessageIds),
      createdAt: Number(boundary?.createdAt || now),
      lastConfirmedAt: Number(boundary?.lastConfirmedAt || boundary?.createdAt || now),
      expiresAt: shortExpiry(boundary, now),
      remainingRelevantUserBatches: Math.min(
        3,
        Math.max(1, Number(boundary?.remainingRelevantUserBatches ?? 3))
      ),
      status: 'active',
      supersedes: null
    }
  };
}

export function classifyLegacyBoundary({ boundary, messages, now = Date.now() }) {
  const evidence = resolveExactEvidence(boundary?.sourceMessageIds, messages);
  if (boundary?.authority === 'system' || boundary?.authority === 'author') {
    if (!boundary?.sourceConfigRef && !evidenceTextMatches(boundary, evidence)) {
      return {
        classification: 'archive',
        reasonCode: 'INSUFFICIENT_OR_EXPIRED_AUTHORITY',
        evidence: classificationEvidence(evidence)
      };
    }
    return buildHardConstraintClassification(boundary, evidence, now);
  }
  if (isExplicitBoundaryEvidence(boundary, evidence)) {
    return buildHardConstraintClassification({ ...boundary, authority: 'user' }, evidence, now);
  }
  if (evidence.length > 0
    && evidence.every(message => message.speakerType === 'assistant')
    && evidenceTextMatches(boundary, evidence)
    && isStillTemporallyRelevant(boundary, now)) {
    return buildShortStanceClassification(boundary, evidence, now);
  }
  return {
    classification: 'archive',
    reasonCode: 'INSUFFICIENT_OR_EXPIRED_AUTHORITY',
    evidence: classificationEvidence(evidence)
  };
}

function tableCounts(database) {
  const existing = new Set(database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'"
  ).all().map(row => row.name));
  return Object.fromEntries(STRUCTURAL_TABLES.map(name => [
    name,
    existing.has(name)
      ? Number(database.prepare(`SELECT COUNT(*) AS value FROM "${name}"`).get().value)
      : null
  ]));
}

function readMigrationSourceSnapshot(store) {
  if (typeof store.readMigrationSourceSnapshot === 'function') {
    return store.readMigrationSourceSnapshot();
  }
  const state = store.getCognitiveState('yuqi');
  const activeBoundaries = Array.isArray(state?.state?.activeBoundaries)
    ? structuredClone(state.state.activeBoundaries)
    : [];
  const ids = uniqueIds(activeBoundaries.flatMap(boundary => boundary.sourceMessageIds || []));
  const messages = ids.map(id => store.getMessage(id)).filter(Boolean);
  return {
    roleId: 'yuqi',
    cognitiveRevision: state?.revision ?? null,
    activeBoundaries,
    messages,
    beforeCounts: tableCounts(store.db)
  };
}

function decisionView(boundary, decision) {
  const sourceId = boundarySourceId(boundary);
  return {
    sourceType: 'active_boundary',
    sourceId,
    classification: decision.classification,
    targetId: decision.record?.constraintId || decision.record?.stanceId || null,
    reasonCode: decision.reasonCode,
    evidenceMessageIds: decision.evidence.map(item => item.messageId)
  };
}

function existingAuditSourceIds(store) {
  const exists = store.db.prepare(`
    SELECT 1 AS value FROM sqlite_master
    WHERE type = 'table' AND name = 'state_migration_audit'
  `).get();
  if (!exists) return new Set();
  return new Set(store.db.prepare(`
    SELECT source_id FROM state_migration_audit
    WHERE role_id = 'yuqi' AND source_type = 'active_boundary'
  `).all().map(row => row.source_id));
}

function applyDecisions(store, entries, now) {
  const existing = existingAuditSourceIds(store);
  const pending = entries.filter(entry => !existing.has(entry.view.sourceId));
  if (!pending.length) return 0;
  store.transaction(() => {
    for (const entry of pending) {
      if (entry.decision.classification === 'hard_constraint') {
        store.putConstraintRevisionInternal(entry.decision.record);
      } else if (entry.decision.classification === 'current_stance') {
        store.putStanceRevisionInternal(entry.decision.record);
      }
      store.putStateMigrationAuditInternal({
        auditId: `agency_migration_${contentHash(entry.view.sourceId).slice(0, 24)}`,
        roleId: 'yuqi',
        sourceType: entry.view.sourceType,
        sourceId: entry.view.sourceId,
        classification: entry.view.classification,
        targetId: entry.view.targetId,
        reasonCode: entry.view.reasonCode,
        evidence: { messageIds: entry.view.evidenceMessageIds },
        createdAt: Number(now)
      });
    }
  });
  return pending.length;
}

export function migrateAgencyState({ store, apply = false, now = Date.now() }) {
  const snapshot = readMigrationSourceSnapshot(store);
  const entries = snapshot.activeBoundaries.map(boundary => {
    const decision = classifyLegacyBoundary({ boundary, messages: snapshot.messages, now });
    return { boundary, decision, view: decisionView(boundary, decision) };
  });
  const decisions = entries.map(entry => entry.view);
  const decisionChecksum = contentHash(decisions);
  const existing = existingAuditSourceIds(store);
  const pendingCount = decisions.filter(decision => !existing.has(decision.sourceId)).length;
  const insertedCount = apply ? applyDecisions(store, entries, now) : pendingCount;
  const afterCounts = tableCounts(store.db);
  return {
    schemaVersion: 1,
    roleId: snapshot.roleId || 'yuqi',
    cognitiveRevision: snapshot.cognitiveRevision,
    boundaryCount: entries.length,
    insertedCount,
    decisionChecksum,
    decisions,
    beforeCounts: snapshot.beforeCounts || tableCounts(store.db),
    afterCounts
  };
}

function fileSha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function rawDatabaseSnapshot(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      sha256: fileSha256(path),
      userVersion: Number(database.prepare('PRAGMA user_version').get().user_version),
      tableCounts: tableCounts(database)
    };
  } finally {
    database.close();
  }
}

function v11InvariantSummary(store) {
  store.assertAgencyV10Invariants();
  return store.visibleAuthorityV11InvariantSummary();
}

function sqliteString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cloneDatabase(sourcePath, clonePath) {
  mkdirSync(dirname(clonePath), { recursive: true });
  if (existsSync(clonePath)) rmSync(clonePath);
  const database = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    database.exec(`VACUUM INTO ${sqliteString(clonePath)};`);
  } finally {
    database.close();
  }
}

function writeJsonAtomically(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  if (existsSync(path)) rmSync(path);
  renameSync(temporary, path);
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const configPath = option('--config');
  const explicitDatabase = option('--database');
  if (!configPath && !explicitDatabase) throw new Error('--config or --database is required');
  const configuredDatabase = configPath
    ? JSON.parse(readFileSync(resolve(configPath), 'utf8')).databasePath
    : null;
  const sourceDatabase = resolve(explicitDatabase || configuredDatabase);
  if (!existsSync(sourceDatabase)) throw new Error('migration database does not exist');
  const apply = process.argv.includes('--apply');
  const dryRun = process.argv.includes('--dry-run') || !apply;
  const cloneOut = option('--clone-out');
  const expectedPath = option('--expect-report');
  if (dryRun && (!cloneOut || resolve(cloneOut) === sourceDatabase)) {
    throw new Error('dry-run requires --clone-out different from source');
  }
  if (apply && !expectedPath) {
    throw new Error('apply requires --expect-report');
  }
  const sourceBefore = rawDatabaseSnapshot(sourceDatabase);
  let expected = null;
  if (apply) {
    expected = JSON.parse(readFileSync(resolve(expectedPath), 'utf8'));
    if (expected.sourceDatabaseSha256 !== sourceBefore.sha256
      || Number(expected.sourceUserVersion) !== sourceBefore.userVersion
      || canonicalJson(expected.sourceTableCounts) !== canonicalJson(sourceBefore.tableCounts)) {
      throw new Error('migration source changed since approved dry-run');
    }
  }
  if (cloneOut && resolve(cloneOut) !== sourceDatabase) cloneDatabase(sourceDatabase, resolve(cloneOut));
  const workingDatabase = cloneOut ? resolve(cloneOut) : sourceDatabase;
  const store = apply
    ? YuqiStore.openForMigration(workingDatabase, {
        expectedSourceVersion: sourceBefore.userVersion,
        expectedPostMigrationInvariantChecksum: expected.v11InvariantSummary.checksum
      })
    : new YuqiStore(workingDatabase);
  let report;
  try {
    report = migrateAgencyState({ store, apply, now: Date.now() });
    report.workingUserVersion = store.userVersion();
    report.v11InvariantSummary = v11InvariantSummary(store);
  } finally {
    store.close();
  }
  const sourceAfter = rawDatabaseSnapshot(sourceDatabase);
  report.sourceDatabaseSha256 = sourceBefore.sha256;
  report.sourceDatabaseSha256After = sourceAfter.sha256;
  report.sourceUserVersion = sourceBefore.userVersion;
  report.sourceTableCounts = sourceBefore.tableCounts;
  report.workingDatabaseSha256 = fileSha256(workingDatabase);
  report.applied = apply;

  if (expectedPath) {
    expected ??= JSON.parse(readFileSync(resolve(expectedPath), 'utf8'));
    if (expected.decisionChecksum !== report.decisionChecksum
      || canonicalJson(expected.beforeCounts) !== canonicalJson(report.beforeCounts)
      || canonicalJson(expected.v11InvariantSummary) !== canonicalJson(report.v11InvariantSummary)) {
      throw new Error('migration dry-run/apply report checksum mismatch');
    }
  }
  const outPath = option('--out');
  if (outPath) writeJsonAtomically(resolve(outPath), report);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    applied: apply,
    boundaryCount: report.boundaryCount,
    insertedCount: report.insertedCount,
    decisionChecksum: report.decisionChecksum,
    outPath: outPath ? resolve(outPath) : null,
    cloneOut: cloneOut ? resolve(cloneOut) : null
  })}\n`);
}
