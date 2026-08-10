import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  assertFrozenSourceSnapshotUnchanged,
  captureFrozenSourceSnapshot,
  exportYuqiVisiblePathPc,
  sha256Canonical
} from '../scripts/export-yuqi-visible-path-pc.mjs';
import { generationFingerprint, laneKeyForEnvelope } from '../yuqi-runtime/src/interaction-lanes.mjs';
import { PromotionController } from '../yuqi-runtime/src/promotion-controller.mjs';
import { contentHash, validateEnvelope } from '../yuqi-runtime/src/protocol.mjs';
import { resolvePipelinePair } from '../yuqi-runtime/src/release-pair.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';
import { commitVisibleResult } from '../yuqi-runtime/src/visible-result-commit.mjs';

const CANDIDATE_ID = 'candidate-release-v3';
const CANDIDATE_CHECKSUM = 'b'.repeat(64);
const SOURCE_HEAD = 'a'.repeat(40);
const STARTED_AT = 1_000;
const COMPLETED_AT = 2_000;

test('PC source snapshot binds main database and WAL/journal existence and bytes', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-snapshot-'));
  try {
    const databasePath = join(root, 'runtime.sqlite');
    writeFileSync(databasePath, 'database');
    for (const suffix of ['-wal', '-journal']) {
      let snapshot = captureFrozenSourceSnapshot(databasePath);
      writeFileSync(`${databasePath}${suffix}`, '');
      assert.throws(() => assertFrozenSourceSnapshotUnchanged(databasePath, snapshot),
        /source database changed/i);
      rmSync(`${databasePath}${suffix}`);
      snapshot = captureFrozenSourceSnapshot(databasePath);
      writeFileSync(`${databasePath}${suffix}`, 'pending');
      assert.throws(() => assertFrozenSourceSnapshotUnchanged(databasePath, snapshot),
        /source database changed|uncheckpointed/i);
      rmSync(`${databasePath}${suffix}`);
    }
    const snapshot = captureFrozenSourceSnapshot(databasePath);
    writeFileSync(databasePath, 'database changed');
    assert.throws(() => assertFrozenSourceSnapshotUnchanged(databasePath, snapshot),
      /source database changed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createSource(root, { version = 15 } = {}) {
  const databasePath = join(root, 'runtime.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA user_version = ${version};
    CREATE TABLE pipeline_releases(
      release_id TEXT PRIMARY KEY,
      release_checksum TEXT NOT NULL
    );
    CREATE TABLE turns(
      turn_id TEXT PRIMARY KEY,
      result_authority_version INTEGER NOT NULL,
      state TEXT NOT NULL,
      rollout_key TEXT NOT NULL,
      pipeline_mode TEXT NOT NULL,
      comparison_mode TEXT NOT NULL,
      authoritative_release_id TEXT NOT NULL,
      authority_lineage_key TEXT NOT NULL,
      authority_redacted_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE turn_authority_lineages(
      lineage_key TEXT PRIMARY KEY,
      latest_turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      committed_group_id TEXT,
      redacted_at INTEGER
    );
    CREATE TABLE visible_result_groups(
      group_id TEXT PRIMARY KEY,
      lineage_key TEXT NOT NULL,
      authoritative_turn_id TEXT NOT NULL,
      authority_origin TEXT NOT NULL,
      authoritative_release_id TEXT NOT NULL,
      redacted_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE visible_result_manifests(
      group_id TEXT PRIMARY KEY,
      semantic_json TEXT,
      semantic_checksum TEXT,
      redacted_at INTEGER
    );
    CREATE TABLE visible_commit_receipts(
      lineage_key TEXT NOT NULL,
      group_id TEXT NOT NULL,
      authoritative_turn_id TEXT NOT NULL,
      authority_origin TEXT,
      commit_payload_version TEXT,
      commit_checksum TEXT NOT NULL,
      committed_at INTEGER NOT NULL
    );
  `);
  database.prepare('INSERT INTO pipeline_releases(release_id, release_checksum) VALUES (?, ?)')
    .run(CANDIDATE_ID, CANDIDATE_CHECKSUM);
  return { database, databasePath };
}

function addCommitted(database, {
  suffix,
  kind = 'DIRECT_REPLY',
  pipelineMode = 'active',
  comparisonMode = 'legacy_compare',
  releaseId = CANDIDATE_ID,
  createdAt = 1_100,
  committedAt = createdAt + 1,
  redactedAt = null
}) {
  const turnId = `turn_${suffix}`;
  const lineageKey = `lineage_${suffix}`;
  const groupId = `group_${suffix}`;
  database.prepare(`
    INSERT INTO turns(
      turn_id, result_authority_version, state, rollout_key, pipeline_mode,
      comparison_mode, authoritative_release_id, authority_lineage_key,
      authority_redacted_at, created_at
    ) VALUES (?, 1, 'completed', ?, ?, ?, ?, ?, ?, ?)
  `).run(turnId, kind, pipelineMode, comparisonMode, releaseId, lineageKey, redactedAt, createdAt);
  database.prepare(`
    INSERT INTO turn_authority_lineages(
      lineage_key, latest_turn_id, state, committed_group_id, redacted_at
    ) VALUES (?, ?, 'committed', ?, ?)
  `).run(lineageKey, turnId, groupId, redactedAt);
  database.prepare(`
    INSERT INTO visible_result_groups(
      group_id, lineage_key, authoritative_turn_id, authority_origin,
      authoritative_release_id, redacted_at, created_at
    ) VALUES (?, ?, ?, 'pc', ?, ?, ?)
  `).run(groupId, lineageKey, turnId, releaseId, redactedAt, createdAt);
  database.prepare(`
    INSERT INTO visible_result_manifests(group_id, semantic_json, redacted_at)
    VALUES (?, ?, ?)
  `).run(groupId, redactedAt == null ? '{}' : null, redactedAt);
  database.prepare(`
    INSERT INTO visible_commit_receipts(
      lineage_key, group_id, authoritative_turn_id, commit_checksum, committed_at
    ) VALUES (?, ?, ?, ?, ?)
  `).run(lineageKey, groupId, turnId, sha256Canonical(`commit-${suffix}`), committedAt);
  return { turnId, lineageKey, groupId };
}

function corruptDatabase(databasePath, mutate) {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON;');
    mutate(database);
  } finally {
    database.close();
  }
}

function shadowCandidateRelease() {
  const release = {
    releaseId: 'candidate-r3',
    pipelineVersion: 'yuqi-lived-agency-v3',
    presetVersion: '2.0.0',
    cognitionSchemaVersion: 3,
    expressionSchemaVersion: 3,
    evaluatorVersion: 'yuqi-lived-quality-v1',
    modelProfile: { cognition: 'candidate-model' },
    componentManifest: { suite: 'quality-suite-v1' },
    createdAt: 2_000,
    retiredAt: null
  };
  const releaseChecksum = contentHash({
    pipelineVersion: release.pipelineVersion,
    presetVersion: release.presetVersion,
    cognitionSchemaVersion: release.cognitionSchemaVersion,
    expressionSchemaVersion: release.expressionSchemaVersion,
    evaluatorVersion: release.evaluatorVersion,
    modelProfile: release.modelProfile,
    componentManifest: release.componentManifest,
    createdAt: release.createdAt
  });
  return {
    ...release,
    releaseId: `quality_candidate_${releaseChecksum.slice(0, 16)}`,
    releaseChecksum
  };
}

function realPromotionController(store) {
  return new PromotionController({
    store,
    presetRegistry: {
      evidenceManifest(rolloutKey) {
        return {
          manifest: { rolloutKey, checksum: 'fixture-evidence' },
          checksum: `fixture-evidence:${rolloutKey}`,
          presetVersion: '2.0.0'
        };
      }
    },
    clock: () => 2_200
  });
}

function registerRealShadowCandidate(store) {
  const controller = realPromotionController(store);
  const rollout = store.getCognitionRollout('DIRECT_REPLY');
  const candidate = shadowCandidateRelease();
  const stable = store.getPipelineRelease(rollout.stableReleaseId);
  const report = store.putEvaluationReportInternal({
    reportId: 'quality-report-shadow-direct',
    reportType: 'promotion',
    rolloutKey: 'DIRECT_REPLY',
    sourceType: 'aggregate_gate',
    sourceRef: 'quality-report-shadow-direct.json',
    artifactPath: 'artifacts/quality-report-shadow-direct.json',
    summary: {
      eligible: true,
      candidateRelease: candidate,
      stableBaselineReleaseId: stable.releaseId,
      stableBaselineReleaseChecksum: stable.releaseChecksum,
      evaluatorVersion: candidate.evaluatorVersion,
      suiteChecksum: 'suite-checksum-v1',
      liveShadowSuccessCount: 30,
      criticalErrors: 0
    },
    createdAt: 2_100
  });
  store.markEvaluationReportMaterialized({
    reportId: report.reportId,
    expectedChecksum: report.artifactChecksum,
    now: 2_150
  });
  const registered = controller.registerCandidate({
    rolloutKey: 'DIRECT_REPLY',
    expectedRevision: rollout.revision,
    releaseId: candidate.releaseId,
    reportId: report.reportId,
    reportChecksum: report.artifactChecksum
  });
  return { controller, candidate, report, registered };
}

function createRealV15CanonicalSource(root, { redactedAt = null, beforeCommit = null } = {}) {
  const databasePath = join(root, 'real-runtime.sqlite');
  const store = new YuqiStore(databasePath);
  try {
    store.initializeCognitionRolloutsInternal({
      rows: [{
        rolloutKey: 'DIRECT_REPLY',
        currentMode: 'active',
        rolloutPhase: 'stable',
        presetVersion: '1.9.2',
        pipelineChecksum: CANDIDATE_CHECKSUM
      }],
      now: 1_000
    });
    beforeCommit?.({ store });
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const pair = resolvePipelinePair(rollout);
    const messages = [0, 1, 2].map(index => ({
      messageId: `msg_real_pc_${index}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `real canonical bubble ${index}`,
      sentAt: 900 + index * 10
    }));
    const envelope = {
      protocolVersion: 2,
      turnId: 'turn_real_pc_1',
      characterId: 'yuqi',
      deviceId: 'phone',
      deviceSeq: 1,
      createdAt: 1_100,
      kind: 'DIRECT_REPLY',
      message: messages[2],
      context: {
        currentBatch: {
          batchId: 'batch_real_pc_1',
          messageIds: messages.map(message => message.messageId),
          startedAt: 900,
          committedAt: 1_100,
          messages
        }
      }
    };
    const laneKey = laneKeyForEnvelope(envelope);
    const lane = store.getInteractionLane('yuqi', laneKey);
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: 1_000 });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: pair.visibleReleaseId,
      comparisonReleaseId: pair.comparisonReleaseId,
      comparisonDirection: pair.comparisonDirection,
      laneKey,
      expectedLaneRevision: Number(lane?.revision || 0),
      inputUserBatchId: 'batch_real_pc_1',
      inputVisibilitySequence: Number(lane?.localSequence || 0),
      inputClearEpoch: Number(lane?.clearEpoch || 0),
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    const visibleGroup = {
      items: [{ content: 'real canonical reply', speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }]
    };
    const state = store.getCognitiveState('yuqi');
    const comparisonJob = pair.comparisonReleaseId == null
      ? null
      : (() => {
          const jobId = `comparison-job-${turn.turnId}`;
          const inputChecksum = contentHash({
            envelope: validateEnvelope(envelope),
            authoritativeReleaseId: turn.authoritativeReleaseId,
            authoritativePipelineChecksum: turn.authoritativePipelineChecksum,
            comparisonReleaseId: turn.comparisonReleaseId,
            comparisonPipelineChecksum: turn.comparisonPipelineChecksum,
            rolloutRevision: turn.rolloutRevision,
            rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
            shadowEpoch: turn.shadowEpoch,
            canaryEpoch: turn.canaryEpoch,
            canarySlot: turn.canarySlot
          });
          return {
            jobId,
            jobType: 'shadow_cognition',
            dueAt: 1_200,
            createdAt: 1_200,
            updatedAt: 1_200,
            workerId: null,
            payload: {
              comparisonReleaseId: turn.comparisonReleaseId,
              comparisonDirection: pair.comparisonDirection,
              rolloutEvidenceEpoch: turn.rolloutEvidenceEpoch,
              shadowEpoch: turn.shadowEpoch,
              canaryEpoch: turn.canaryEpoch,
              canarySlot: turn.canarySlot,
              annotationSnapshotChecksum: contentHash({}),
              inputChecksum,
              turnId: turn.turnId,
              jobId,
              attemptId: `attempt-${turn.turnId}`,
              dueAt: 1_200,
              createdAt: 1_200,
              updatedAt: 1_200,
              workerId: null
            }
          };
        })();
    const receipt = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
      expectedCognitiveStateRevision: Number(state?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      protocolVersion: turn.protocolVersion,
      turnKind: turn.rolloutKey,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      comparisonReleaseId: turn.comparisonReleaseId,
      comparisonDirection: pair.comparisonDirection,
      visibleGroup,
      actionSet: [],
      proactiveMotiveEvidenceIds: [],
      statePatch: { mood: 'warm', openThreads: [], currentStances: [] },
      memoryJobs: [],
      comparisonJob,
      generationFingerprint: generationFingerprint({
        roleId: turn.characterId,
        laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup,
        actionSet: [],
        contextRevision: turn.agencySnapshotChecksum
      }),
      now: 1_200
    });
    if (redactedAt !== null) {
      const lineageRow = store.db.prepare(
        'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
      ).get(turn.authorityLineageKey);
      store.withImmediateTransaction(() => store.redactCanonicalConversationLineageInternal({
        lineage: lineageRow,
        redactedAt,
        reasonCode: 'test_redaction',
        fault() {}
      }));
    }
    const release = store.getPipelineRelease(rollout.stableReleaseId);
    return {
      databasePath,
      candidateReleaseId: release.releaseId,
      candidateReleaseChecksum: release.releaseChecksum,
      turnId: turn.turnId,
      lineageKey: turn.authorityLineageKey,
      groupId: receipt.visibleGroupId
    };
  } finally {
    store.close();
  }
}

function exportOptions(root, databasePath, overrides = {}) {
  const options = {
    databasePath,
    outputPath: join(root, 'private', 'visible-path-pc.jsonl'),
    candidateReleaseId: CANDIDATE_ID,
    candidateReleaseChecksum: CANDIDATE_CHECKSUM,
    sourceHead: SOURCE_HEAD,
    runId: '4f12c753-6e8b-4c07-bc20-a30360b95b6b',
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT
  };
  for (const key of [
    'candidateReleaseId', 'candidateReleaseChecksum', 'sourceHead',
    'runId', 'startedAt', 'completedAt'
  ]) {
    if (Object.hasOwn(overrides, key)) options[key] = overrides[key];
  }
  return options;
}

function appendRealV15CanonicalSource(databasePath, { suffix = 'second', now = 1_600 } = {}) {
  const store = new YuqiStore(databasePath);
  try {
    const rollout = store.getCognitionRollout('DIRECT_REPLY');
    const messages = [0, 1, 2].map(index => ({
      messageId: `msg_real_pc_${suffix}_${index}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `real canonical bubble ${suffix} ${index}`,
      sentAt: now - 100 + index * 10
    }));
    const envelope = {
      protocolVersion: 2,
      turnId: `turn_real_pc_${suffix}`,
      characterId: 'yuqi',
      deviceId: 'phone',
      deviceSeq: 2,
      createdAt: now,
      kind: 'DIRECT_REPLY',
      message: messages[2],
      context: {
        currentBatch: {
          batchId: `batch_real_pc_${suffix}`,
          messageIds: messages.map(message => message.messageId),
          startedAt: now - 100,
          committedAt: now,
          messages
        }
      }
    };
    const laneKey = laneKeyForEnvelope(envelope);
    const lane = store.getInteractionLane('yuqi', laneKey);
    if (!lane) throw new Error(`real fixture lane missing: ${laneKey}`);
    const agency = store.readAgencyAuthoritySnapshotInternal({ roleId: 'yuqi', at: now });
    const turn = store.createCanonicalVisibleTurnInternal({
      envelope,
      rolloutKey: 'DIRECT_REPLY',
      expectedRolloutRevision: rollout.revision,
      authoritativeReleaseId: rollout.stableReleaseId,
      comparisonReleaseId: null,
      comparisonDirection: null,
      laneKey,
      expectedLaneRevision: Number(lane.revision || 0),
      inputUserBatchId: `batch_real_pc_${suffix}`,
      inputVisibilitySequence: Number(lane.localSequence || 0),
      inputClearEpoch: Number(lane.clearEpoch || 0),
      agencySnapshotChecksum: agency.checksum,
      annotationSnapshot: {}
    }).turn;
    const visibleGroup = {
      items: [{ content: `real canonical reply ${suffix}`, speakerId: 'yuqi', speakerType: 'character', recipientId: 'user' }]
    };
    const state = store.getCognitiveState('yuqi');
    const receipt = commitVisibleResult({
      store,
      turnId: turn.turnId,
      authorityLineageKey: turn.authorityLineageKey,
      laneKey: turn.laneKey,
      expectedTurnRevision: turn.turnRevision,
      expectedLineageRevision: store.getTurnAuthorityLineage(turn.authorityLineageKey).revision,
      expectedLaneRevision: store.getInteractionLane('yuqi', turn.laneKey).revision,
      expectedCognitiveStateRevision: Number(state?.revision || 0),
      expectedLatestUserBatchId: turn.inputUserBatchId,
      inputVisibilitySequence: turn.inputVisibilitySequence,
      inputClearEpoch: turn.inputClearEpoch,
      protocolVersion: turn.protocolVersion,
      turnKind: turn.rolloutKey,
      agencySnapshotChecksum: turn.agencySnapshotChecksum,
      authoritativeReleaseId: turn.authoritativeReleaseId,
      visibleGroup,
      actionSet: [],
      proactiveMotiveEvidenceIds: [],
      statePatch: { mood: 'warm', openThreads: [], currentStances: [] },
      memoryJobs: [],
      comparisonJob: null,
      generationFingerprint: generationFingerprint({
        roleId: turn.characterId,
        laneKey,
        inputVisibilitySequence: turn.inputVisibilitySequence,
        visibleGroup,
        actionSet: [],
        contextRevision: turn.agencySnapshotChecksum
      }),
      now: now + 100
    });
    return { turnId: turn.turnId, lineageKey: turn.authorityLineageKey, groupId: receipt.visibleGroupId };
  } finally {
    store.close();
  }
}

function createMixedLiveRedactedSource(root) {
  const redacted = createRealV15CanonicalSource(root);
  const live = appendRealV15CanonicalSource(redacted.databasePath, { suffix: 'mixed', now: 1_600 });
  const store = new YuqiStore(redacted.databasePath);
  try {
    const lineage = store.db.prepare(
      'SELECT * FROM turn_authority_lineages WHERE lineage_key = ?'
    ).get(redacted.lineageKey);
    store.withImmediateTransaction(() => store.redactCanonicalConversationLineageInternal({
      lineage,
      redactedAt: 1_800,
      reasonCode: 'test_mixed_redaction',
      fault() {}
    }));
  } finally {
    store.close();
  }
  return { redacted, live };
}

test('PC exporter reads a real YuqiStore v15 canonical commit and emits exact metadata-only rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-'));
  try {
    const fixture = createRealV15CanonicalSource(root);
    const { databasePath } = fixture;
    const options = exportOptions(root, databasePath, fixture);
    const before = readFileSync(databasePath);
    const beforeMtime = statSync(databasePath).mtimeMs;

    const result = exportYuqiVisiblePathPc(options);
    const records = readFileSync(result.outputPath, 'utf8').trimEnd().split(/\r?\n/).map(JSON.parse);
    assert.equal(records.length, 2);
    assert.equal(records[1].authorityMode, 'active_canary');
    assert.equal(records[1].kind, 'DIRECT_REPLY');
    assert.equal(records[1].turnIdSha256, sha256Canonical(fixture.turnId));
    assert.equal(records.some(record => Object.hasOwn(record, 'sampleId') || Object.hasOwn(record, 'elapsedMs')), false);
    assert.equal(records[0].startedAt, STARTED_AT);
    assert.equal(records[0].completedAt, COMPLETED_AT);
    assert.equal(records[0].producerAttestation.rowCount, 1);
    assert.match(records[0].producerAttestation.attestationChecksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(readFileSync(databasePath), before);
    assert.equal(statSync(databasePath).mtimeMs, beforeMtime);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('user_version 15 plus six minimal tables cannot masquerade as a v15 authority snapshot', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-pseudo-v15-'));
  try {
    const { database, databasePath } = createSource(root);
    addCommitted(database, { suffix: 'pseudo' });
    database.close();
    assert.throws(
      () => exportYuqiVisiblePathPc(exportOptions(root, databasePath)),
      /v15|authority|schema/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('redacted rows reject receipt, origin, release, mode, and lineage corruption', () => {
  const mutations = [
    {
      name: 'receipt',
      apply(database, fixture) {
        database.prepare("UPDATE visible_commit_receipts SET lineage_key = 'foreign' WHERE group_id = ?")
          .run(fixture.groupId);
      }
    },
    {
      name: 'origin',
      apply(database, fixture) {
        database.prepare("UPDATE visible_result_groups SET authority_origin = 'android_fallback' WHERE group_id = ?")
          .run(fixture.groupId);
      }
    },
    {
      name: 'release',
      apply(database, fixture) {
        database.prepare("UPDATE visible_result_groups SET authoritative_release_id = 'foreign-release' WHERE group_id = ?")
          .run(fixture.groupId);
      }
    },
    {
      name: 'mode',
      apply(database, fixture) {
        database.prepare("UPDATE turns SET pipeline_mode = 'legacy' WHERE turn_id = ?")
          .run(fixture.turnId);
      }
    },
    {
      name: 'lineage',
      apply(database, fixture) {
        database.prepare("UPDATE turn_authority_lineages SET state = 'open' WHERE lineage_key = ?")
          .run(fixture.lineageKey);
      }
    }
  ];
  for (const mutation of mutations) {
    const root = mkdtempSync(join(tmpdir(), `yuqi-visible-pc-redacted-${mutation.name}-`));
    try {
      const fixture = createRealV15CanonicalSource(root, { redactedAt: 1_500 });
      const { databasePath } = fixture;
      corruptDatabase(databasePath, database => mutation.apply(database, fixture));
      assert.throws(
        () => exportYuqiVisiblePathPc(exportOptions(root, databasePath, fixture)),
        /redacted|authority|receipt|lineage|mode/i,
        mutation.name
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

test('live rows reject non-JSON semantic payloads and semantic/receipt checksum mismatch', () => {
  const mutations = [
    (database, fixture) => {
      database.prepare("UPDATE visible_result_manifests SET semantic_json = 'not-json-secret' WHERE group_id = ?")
        .run(fixture.groupId);
    },
    (database, fixture) => {
      database.prepare("UPDATE visible_result_manifests SET semantic_checksum = ? WHERE group_id = ?")
        .run('f'.repeat(64), fixture.groupId);
    },
    (database, fixture) => {
      database.prepare("UPDATE visible_commit_receipts SET commit_checksum = ? WHERE group_id = ?")
        .run('f'.repeat(64), fixture.groupId);
    }
  ];
  for (const mutate of mutations) {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-semantic-'));
    try {
      const fixture = createRealV15CanonicalSource(root);
      const { databasePath } = fixture;
      corruptDatabase(databasePath, database => mutate(database, fixture));
      assert.throws(
        () => exportYuqiVisiblePathPc(exportOptions(root, databasePath, fixture)),
        /semantic|checksum|receipt|authority/i
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

test('receipt committed inside the run window is selected even when its group predates the window', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-window-'));
  try {
    const fixture = createRealV15CanonicalSource(root);
    const { databasePath } = fixture;
    corruptDatabase(databasePath, database => database.prepare(
      'UPDATE visible_result_groups SET created_at = 900 WHERE group_id = ?'
    ).run(fixture.groupId));
    assert.doesNotThrow(() => exportYuqiVisiblePathPc(exportOptions(root, databasePath, fixture)));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('PC exporter fails closed for version, release, mode, authority join, sidecar, and overwrite conflicts', () => {
  const cases = [
    {
      name: 'wrong version',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        corruptDatabase(fixture.databasePath, database => database.exec('PRAGMA user_version = 14'));
        return fixture;
      }
    },
    {
      name: 'release checksum',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        corruptDatabase(fixture.databasePath, database => database.prepare(
          'UPDATE pipeline_releases SET release_checksum = ? WHERE release_id = ?'
        ).run('d'.repeat(64), fixture.candidateReleaseId));
        return fixture;
      }
    },
    {
      name: 'unsupported pinned mode',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        corruptDatabase(fixture.databasePath, database => database.prepare(
          "UPDATE turns SET pipeline_mode = 'legacy', comparison_mode = 'none' WHERE turn_id = ?"
        ).run(fixture.turnId));
        return fixture;
      }
    },
    {
      name: 'authority join',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        corruptDatabase(fixture.databasePath, database => database.prepare(
          "UPDATE visible_commit_receipts SET lineage_key = 'foreign' WHERE group_id = ?"
        ).run(fixture.groupId));
        return fixture;
      }
    },
    {
      name: 'nonempty WAL sidecar',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        writeFileSync(`${fixture.databasePath}-wal`, 'uncheckpointed');
        return fixture;
      }
    },
    {
      name: 'existing output',
      build(root) {
        const fixture = createRealV15CanonicalSource(root);
        const options = exportOptions(root, fixture.databasePath, fixture);
        rmSync(join(root, 'private'), { recursive: true, force: true });
        exportYuqiVisiblePathPc(options);
        return fixture;
      }
    }
  ];
  for (const entry of cases) {
    const root = mkdtempSync(join(tmpdir(), `yuqi-visible-pc-${entry.name.replaceAll(' ', '-')}-`));
    try {
      const fixture = entry.build(root);
      assert.throws(
        () => exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture)),
        /visible path PC export/i,
        entry.name
      );
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

function assertReceiptCorruptionRejected(name, redacted, apply) {
  const root = mkdtempSync(join(tmpdir(), `yuqi-visible-pc-receipt-closure-${name.replaceAll(' ', '-')}-`));
  try {
    const fixture = redacted
      ? createMixedLiveRedactedSource(root).redacted
      : createRealV15CanonicalSource(root);
    corruptDatabase(fixture.databasePath, database => apply(database, fixture));
    assert.throws(
      () => exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture)),
      /authority|receipt|revision|delivery|payload|checksum/i,
      name
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
}

test('rejects redacted receipt payload version corruption', () => {
  assertReceiptCorruptionRejected('redacted-receipt-payload-version', true, (database, fixture) => {
    assert.equal(Number(database.prepare(
      'UPDATE visible_commit_receipts SET commit_payload_version = ? WHERE group_id = ?'
    ).run('pc-forged-v99', fixture.groupId).changes), 1);
    assert.equal(Number(database.prepare(
      'UPDATE visible_result_manifests SET payload_version = ? WHERE group_id = ?'
    ).run('pc-forged-v99', fixture.groupId).changes), 1);
  });
});

test('rejects redacted receipt revision corruption', () => {
  assertReceiptCorruptionRejected('redacted-receipt-revision', true, (database, fixture) => {
    assert.equal(Number(database.prepare(
      'UPDATE visible_commit_receipts SET turn_revision_before = 700, turn_revision_after = 701, lineage_revision_before = 800, lineage_revision_after = 801 WHERE group_id = ?'
    ).run(fixture.groupId).changes), 1);
  });
});

test('rejects live delivery payload and checksum corruption', () => {
  assertReceiptCorruptionRejected('live-delivery-payload-checksum', false, (database, fixture) => {
    assert.equal(Number(database.prepare(
      'UPDATE cloud_deliveries SET payload_json = ?, checksum = ? WHERE authority_group_id = ?'
    ).run('{"forged":"delivery"}', 'f'.repeat(64), fixture.groupId).changes), 1);
  });
});

test('rejects a self-consistent turn mode that disagrees with the cognition rollout authority', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-rollout-mode-corruption-'));
  try {
    const fixture = createRealV15CanonicalSource(root);
    corruptDatabase(fixture.databasePath, database => {
      database.prepare(
        "UPDATE turns SET pipeline_mode = 'shadow', comparison_mode = 'cognition_compare' WHERE turn_id = ?"
      ).run(fixture.turnId);
      database.prepare(
        "UPDATE cognition_kind_rollouts SET current_mode = 'active', rollout_phase = 'stable' WHERE rollout_key = 'DIRECT_REPLY'"
      ).run();
    });
    assert.throws(
      () => exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture)),
      /rollout|mode|authority/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('accepts real committed, delivered, and completed authority states', () => {
  for (const state of ['committed', 'delivered', 'completed']) {
    const root = mkdtempSync(join(tmpdir(), `yuqi-visible-pc-state-${state}-`));
    try {
      const fixture = createRealV15CanonicalSource(root);
      corruptDatabase(fixture.databasePath, database => database.prepare(
        'UPDATE turns SET state = ? WHERE turn_id = ?'
      ).run(state, fixture.turnId));
      const result = exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture));
      assert.equal(result.rows.length, 1, state);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }
});

test('keeps active-none candidate authority and excludes normal stable shadow from candidate samples', () => {
  {
    const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-mode-active-none-'));
    try {
      const fixture = createRealV15CanonicalSource(root);
      corruptDatabase(fixture.databasePath, database => database.prepare(
        "UPDATE turns SET comparison_mode = 'none' WHERE turn_id = ?"
      ).run(fixture.turnId));
      const result = exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture));
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].authorityMode, 'active_canary');
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-mode-shadow-excluded-'));
  try {
    let qualityCandidate = null;
    const fixture = createRealV15CanonicalSource(root, {
      beforeCommit({ store }) {
        qualityCandidate = registerRealShadowCandidate(store).candidate;
      }
    });
    assert.ok(qualityCandidate?.releaseId);
    assert.match(qualityCandidate.releaseChecksum, /^[0-9a-f]{64}$/);
    assert.throws(
      () => exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, {
        ...fixture,
        candidateReleaseId: qualityCandidate.releaseId,
        candidateReleaseChecksum: qualityCandidate.releaseChecksum
      })),
      /candidate|visible|row|empty|authority/i,
      'stable-authoritative shadow must not masquerade as a candidate performance row'
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('rejects LIFE_PLANNING as a visible RA1 group and never counts it as a visible-path kind', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-life-planning-'));
  try {
    const fixture = createRealV15CanonicalSource(root);
    corruptDatabase(fixture.databasePath, database => database.prepare(
      "UPDATE turns SET rollout_key = 'LIFE_PLANNING' WHERE turn_id = ?"
    ).run(fixture.turnId));
    assert.throws(
      () => exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture)),
      /kind|authority|schema/i
    );
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});

test('accepts a real mixed live and redacted authority snapshot while exporting only live rows', () => {
  const root = mkdtempSync(join(tmpdir(), 'yuqi-visible-pc-mixed-live-redacted-'));
  try {
    const { redacted, live } = createMixedLiveRedactedSource(root);
    const fixture = {
      ...redacted,
      ...live,
      databasePath: redacted.databasePath,
      candidateReleaseId: redacted.candidateReleaseId,
      candidateReleaseChecksum: redacted.candidateReleaseChecksum
    };
    const result = exportYuqiVisiblePathPc(exportOptions(root, fixture.databasePath, fixture));
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].turnIdSha256, sha256Canonical(live.turnId));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
  }
});
