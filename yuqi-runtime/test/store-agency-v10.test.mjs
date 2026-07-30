import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { YuqiStore } from '../src/store.mjs';

const V10_TABLES = [
  'pipeline_releases',
  'constraint_records',
  'stance_records',
  'interaction_lanes',
  'quality_eval_runs',
  'quality_findings',
  'state_migration_audit'
];

const V10_COLUMNS = {
  cognition_kind_rollouts: [
    'stable_release_id',
    'candidate_release_id',
    'candidate_phase'
  ],
  turns: [
    'authoritative_release_id',
    'comparison_release_id',
    'authoritative_pipeline_checksum',
    'comparison_pipeline_checksum',
    'lane_key',
    'lane_revision',
    'input_visibility_sequence',
    'generation_fingerprint'
  ],
  cognition_life_planning_attempts: [
    'authoritative_release_id',
    'comparison_release_id',
    'authoritative_pipeline_checksum',
    'comparison_pipeline_checksum',
    'lane_key',
    'lane_revision',
    'input_visibility_sequence',
    'generation_fingerprint'
  ]
};

function envelope(id, sequence = 1) {
  return {
    protocolVersion: 2,
    turnId: id,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: sequence,
    createdAt: 1_000 + sequence,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_${id}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '测试消息',
      sentAt: 1_000 + sequence
    }
  };
}

function directRollout() {
  return {
    rolloutKey: 'DIRECT_REPLY',
    currentMode: 'legacy',
    rolloutPhase: 'stable',
    presetVersion: '1.9.2',
    pipelineChecksum: 'a'.repeat(64)
  };
}

function columns(database, table) {
  return new Set(database.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name));
}

function stripV10Schema(path) {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys = OFF;');
    for (const table of V10_TABLES) database.exec(`DROP TABLE IF EXISTS "${table}";`);
    for (const [table, names] of Object.entries(V10_COLUMNS)) {
      const existing = columns(database, table);
      for (const name of names) {
        if (existing.has(name)) database.exec(`ALTER TABLE "${table}" DROP COLUMN "${name}";`);
      }
    }
    database.exec('PRAGMA user_version = 9;');
  } finally {
    database.close();
  }
}

function countStructuralRows(path) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const names = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    ).all().map(row => row.name));
    return Object.fromEntries([
      'messages',
      'facts',
      'relationship_states',
      'relationship_history',
      'role_plans',
      'life_episodes',
      'turns',
      'result_outbox'
    ].map(name => [
      name,
      names.has(name)
        ? Number(database.prepare(`SELECT COUNT(*) AS value FROM "${name}"`).get().value)
        : null
    ]));
  } finally {
    database.close();
  }
}

function withTemporaryDatabase(run) {
  const directory = mkdtempSync(join(tmpdir(), 'yuqi-agency-v10-'));
  const path = join(directory, 'memory.sqlite');
  try {
    return run(path);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function createV9Database(path, { populated }) {
  const store = new YuqiStore(path);
  if (populated) {
    store.initializeCognitionRolloutsInternal({ rows: [directRollout()], now: 1000 });
    store.submitTurn(envelope('turn_v2'), { rolloutKey: 'DIRECT_REPLY' });
    store.putCognitiveStateInternal({
      roleId: 'yuqi',
      schemaVersion: 1,
      revision: 1,
      lastTurnId: 'turn_v2',
      state: { relationshipBase: 'familiar' },
      updatedAt: 1000
    });
  }
  store.close();
  stripV10Schema(path);
}

function cognitiveSnapshotV2() {
  return {
    roleId: 'yuqi',
    schemaVersion: 2,
    revision: 1,
    lastTurnId: 'turn_v3',
    updatedAt: 2000,
    state: {
      slowState: {
        preferenceFactIds: ['fact_sweet'],
        formalCommitmentFactIds: [],
        longTermRelationshipBase: 'familiar'
      },
      mediumState: {
        relationshipPhase: 'normal',
        unresolvedConflictIds: [],
        activeRolePlanIds: [],
        activeLifeEpisodeIds: []
      },
      fastState: {
        mood: 'annoyed',
        body: '',
        attention: 'chat',
        openThreadIds: ['gift_play']
      }
    }
  };
}

test('clean v9 migrates once to the exact v10 authority schema', () => withTemporaryDatabase(path => {
  createV9Database(path, { populated: false });
  const store = new YuqiStore(path);
  try {
    assert.equal(store.userVersion(), 10);
    for (const table of V10_TABLES) {
      assert.equal(
        Boolean(store.db.prepare(
          "SELECT 1 AS value FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(table)),
        true,
        table
      );
    }
    assert.equal(store.listPipelineReleases().length, 2);
    assert.ok(store.listCognitionRollouts().every(row => row.candidatePhase === 'none'));
    store.migrate();
    assert.equal(store.userVersion(), 10);
    assert.equal(store.listPipelineReleases().length, 2);
  } finally {
    store.close();
  }
}));

test('populated v9 to v10 is non-destructive and idempotent', () => withTemporaryDatabase(path => {
  createV9Database(path, { populated: true });
  const before = countStructuralRows(path);
  const store = new YuqiStore(path);
  try {
    assert.equal(store.userVersion(), 10);
    assert.deepEqual(countStructuralRows(path), before);
    assert.equal(store.listCognitionRollouts()[0].candidatePhase, 'none');
    store.migrate();
    assert.equal(store.userVersion(), 10);
    assert.equal(store.listPipelineReleases().length, 2);
    assert.deepEqual(countStructuralRows(path), before);
  } finally {
    store.close();
  }
}));

test('versions above v10 stop instead of being rewritten', () => withTemporaryDatabase(path => {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA user_version = 11;');
  database.close();
  assert.throws(() => new YuqiStore(path), /unsupported.*11/i);
}));

test('new turns pin release pair and lane revision while old turns remain readable', () =>
  withTemporaryDatabase(path => {
    createV9Database(path, { populated: true });
    const store = new YuqiStore(path);
    try {
      const oldTurn = store.getTurn('turn_v2');
      assert.equal(oldTurn.authoritativeReleaseId, null);
      const created = store.createTurnWithReleasePinInternal({
        envelope: envelope('turn_v3', 2),
        rolloutKey: 'DIRECT_REPLY',
        laneKey: 'private_chat',
        expectedLaneRevision: 0
      });
      assert.ok(created.authoritativeReleaseId);
      assert.ok(created.comparisonReleaseId);
      assert.match(created.authoritativePipelineChecksum, /^[a-f0-9]{64}$/);
      assert.equal(created.laneKey, 'private_chat');
      assert.equal(created.laneRevision, 0);
    } finally {
      store.close();
    }
  }));

test('v2 cognitive snapshot separates slow medium and fast state', () =>
  withTemporaryDatabase(path => {
    const store = new YuqiStore(path);
    try {
      store.putCognitiveStateInternal('yuqi', cognitiveSnapshotV2());
      const state = store.getCognitiveState('yuqi');
      assert.equal(state.schemaVersion, 2);
      assert.deepEqual(Object.keys(state.state).sort(), ['fastState', 'mediumState', 'slowState']);
      assert.equal(state.state.slowState.longTermRelationshipBase, 'familiar');
      assert.equal(state.state.fastState.mood, 'annoyed');
    } finally {
      store.close();
    }
  }));

test('constraint and stance revisions are append-only and active reads are time-aware', () =>
  withTemporaryDatabase(path => {
    const store = new YuqiStore(path);
    try {
      store.putConstraintRevisionInternal({
        constraintId: 'c1',
        revision: 1,
        roleId: 'yuqi',
        authority: 'user',
        kind: 'consent',
        subject: 'both',
        scope: { channel: 'private_chat', target: 'gift_play' },
        rule: 'stop',
        sourceMessageIds: ['u1'],
        status: 'active',
        createdAt: 1000,
        updatedAt: 1000
      });
      store.putConstraintRevisionInternal({
        constraintId: 'c1',
        revision: 2,
        roleId: 'yuqi',
        authority: 'user',
        kind: 'consent',
        subject: 'both',
        scope: { channel: 'private_chat', target: 'gift_play' },
        rule: 'stop',
        sourceMessageIds: ['u2'],
        status: 'released',
        supersedes: 'c1',
        createdAt: 1000,
        updatedAt: 2000
      });
      assert.equal(store.listActiveConstraints('yuqi').length, 0);

      store.putStanceRevisionInternal({
        stanceId: 's1',
        revision: 1,
        roleId: 'yuqi',
        topic: 'gift_play',
        position: 'not now',
        reason: 'already accepted one',
        strength: 0.7,
        flexibility: 0.8,
        sourceTurnId: 'turn_v2',
        sourceMessageIds: ['u1'],
        createdAt: 1000,
        lastConfirmedAt: 1000,
        expiresAt: 1500,
        remainingRelevantUserBatches: 2,
        status: 'active'
      });
      assert.equal(store.listActiveStances('yuqi', 1200).length, 1);
      assert.equal(store.listActiveStances('yuqi', 2000).length, 0);
      assert.throws(() => store.putStanceRevisionInternal({
        stanceId: 's1',
        revision: 1,
        roleId: 'yuqi',
        topic: 'changed',
        position: 'changed',
        reason: '',
        strength: 0.1,
        flexibility: 0.1,
        sourceTurnId: 'turn_v2',
        sourceMessageIds: ['u1'],
        createdAt: 1000,
        lastConfirmedAt: 1000,
        remainingRelevantUserBatches: 1,
        status: 'active'
      }), /revision conflict/);
    } finally {
      store.close();
    }
  }));

test('release, lane, quality, and migration audit methods round-trip canonical records', () =>
  withTemporaryDatabase(path => {
    const store = new YuqiStore(path);
    try {
      const releases = store.listPipelineReleases();
      assert.equal(store.getPipelineRelease(releases[0].releaseId).releaseChecksum,
        releases[0].releaseChecksum);
      const lane = store.claimInteractionLaneInternal({
        roleId: 'yuqi',
        laneKey: 'private_chat',
        expectedRevision: 0,
        generatingTurnId: 'turn_1',
        latestUserBatchId: 'batch_1',
        now: 1000
      });
      assert.equal(lane.revision, 1);
      assert.equal(store.getInteractionLane('yuqi', 'private_chat').generatingTurnId, 'turn_1');

      store.putQualityEvalRunInternal({
        evalRunId: 'eval_1',
        releaseId: releases[1].releaseId,
        baselineReleaseId: releases[0].releaseId,
        suiteVersion: 'v1',
        sourceType: 'fixture',
        state: 'running',
        manifestChecksum: 'b'.repeat(64),
        summary: {},
        artifactPath: 'artifacts/eval_1.json',
        createdAt: 1000
      });
      store.putQualityFindingInternal({
        findingId: 'finding_1',
        evalRunId: 'eval_1',
        rolloutKey: 'DIRECT_REPLY',
        sceneId: 'scene_1',
        repeatIndex: 0,
        code: 'NONE',
        owner: 'runtime',
        severity: 'info',
        evidence: {},
        scores: {},
        createdAt: 1000
      });
      store.putStateMigrationAuditInternal({
        auditId: 'audit_1',
        roleId: 'yuqi',
        sourceType: 'boundary',
        sourceId: 'old_1',
        classification: 'current_stance',
        targetId: 's1',
        reasonCode: 'EXPLICIT_TEMPORARY',
        evidence: { messageIds: ['u1'] },
        createdAt: 1000
      });
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS value FROM quality_findings').get().value,
        1
      );
      assert.equal(
        store.db.prepare('SELECT COUNT(*) AS value FROM state_migration_audit').get().value,
        1
      );
    } finally {
      store.close();
    }
  }));
