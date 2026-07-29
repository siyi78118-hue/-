import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CognitiveStateConflictError,
  ConsolidationJobConflictError,
  YuqiStore
} from '../src/store.mjs';

function envelope(sequence = 1) {
  return {
    protocolVersion: 2,
    turnId: `turn_${sequence}`,
    characterId: 'yuqi',
    deviceId: 'phone',
    deviceSeq: sequence,
    createdAt: 1_000 + sequence,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_${sequence}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: `消息 ${sequence}`,
      sentAt: 1_000 + sequence
    }
  };
}

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-cognition-store-'));
  const path = join(dir, 'memory.sqlite');
  const store = new YuqiStore(path);
  try {
    return run(store, path);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('opening a pre-cognition database twice pins old pending turns to legacy defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-old-store-'));
  const path = join(dir, 'memory.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE turns (
        turn_id TEXT PRIMARY KEY,
        character_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_seq INTEGER NOT NULL,
        source_message_id TEXT NOT NULL,
        state TEXT NOT NULL,
        worker_id TEXT,
        origin TEXT NOT NULL DEFAULT 'codex',
        memory_packet_json TEXT,
        brain_draft_json TEXT,
        supervisor_json TEXT,
        reply_json TEXT,
        error_json TEXT,
        envelope_json TEXT NOT NULL,
        envelope_checksum TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        route TEXT NOT NULL DEFAULT 'deep',
        route_reasons_json TEXT NOT NULL DEFAULT '[]',
        UNIQUE(device_id, device_seq)
      );
    `);
    db.prepare(`
      INSERT INTO turns(
        turn_id, character_id, device_id, device_seq, source_message_id, state,
        envelope_json, envelope_checksum, created_at, updated_at
      ) VALUES (?, 'yuqi', 'phone', 1, 'msg_old', 'memory_done', '{}', 'old', 1, 1)
    `).run('turn_old');
    db.close();

    const first = new YuqiStore(path);
    assert.equal(first.getTurn('turn_old').pipelineMode, 'legacy');
    assert.equal(first.getTurn('turn_old').presetVersion, '1.9.1');
    assert.deepEqual(first.getTurn('turn_old').annotationSnapshot, {});
    first.close();

    const second = new YuqiStore(path);
    assert.equal(second.getTurn('turn_old').state, 'memory_done');
    assert.equal(second.db.prepare('PRAGMA user_version').get().user_version, 9);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('new turns pin pipeline mode, preset, and annotation snapshot at creation', () => withStore(store => {
  const created = store.submitTurn(envelope(), {
    pipelineMode: 'shadow',
    presetVersion: '2.0.0',
    annotationSnapshot: { ids: ['annotation_1'], checksum: 'abc' }
  });
  assert.equal(created.pipelineMode, 'shadow');
  assert.equal(created.presetVersion, '2.0.0');
  assert.deepEqual(created.annotationSnapshot, { ids: ['annotation_1'], checksum: 'abc' });
  assert.equal(store.submitTurn(envelope(), {
    pipelineMode: 'active',
    presetVersion: 'future'
  }).pipelineMode, 'shadow');
}));

test('cognitive state uses revision CAS and makes same-turn retries idempotent', () => withStore(store => {
  const first = store.transaction(() => store.putCognitiveStateInternal({
    roleId: 'yuqi',
    schemaVersion: 1,
    revision: 1,
    lastTurnId: 'turn_1',
    state: { openThreads: ['tea'] }
  }));
  assert.equal(first.revision, 1);
  assert.deepEqual(first.state, { openThreads: ['tea'] });
  assert.equal(store.transaction(() => store.putCognitiveStateInternal({
    roleId: 'yuqi',
    schemaVersion: 1,
    revision: 1,
    lastTurnId: 'turn_1',
    state: { openThreads: ['tea'] }
  })).checksum, first.checksum);
  assert.throws(() => store.transaction(() => store.putCognitiveStateInternal({
    roleId: 'yuqi',
    revision: 1,
    lastTurnId: 'turn_other',
    state: {}
  })), CognitiveStateConflictError);
  assert.throws(() => store.transaction(() => store.putCognitiveStateInternal({
    roleId: 'yuqi',
    revision: 2,
    lastTurnId: 'turn_2',
    expectedChecksum: 'wrong',
    state: {}
  })), CognitiveStateConflictError);
}));

test('consolidation jobs are canonical, leased by declared type, and payload conflicts fail', () => withStore(store => {
  const job = {
    jobId: 'job_1',
    subjectType: 'turn',
    subjectId: 'turn_1',
    turnId: 'turn_1',
    roleId: 'yuqi',
    jobType: 'turn_consolidation',
    dueAt: 10,
    createdAt: 10,
    payload: { z: 1, a: 2 }
  };
  const created = store.transaction(() => store.createConsolidationJobInternal(job));
  assert.equal(created.payloadChecksum.length, 64);
  assert.equal(store.claimDueConsolidationJob({
    workerId: 'compare',
    jobTypes: ['shadow_cognition'],
    now: 20
  }), null);
  const claimed = store.claimDueConsolidationJob({
    workerId: 'consolidator',
    jobTypes: ['turn_consolidation'],
    now: 20,
    leaseMs: 100
  });
  assert.equal(claimed.state, 'running');
  assert.equal(claimed.attemptCount, 1);
  assert.equal(store.failConsolidationJob({
    jobId: claimed.jobId,
    workerId: 'consolidator',
    now: 30,
    errorCode: 'TEMPORARY',
    nextDueAt: 60
  }).state, 'retry_wait');
  assert.throws(() => store.transaction(() => store.createConsolidationJobInternal({
    ...job,
    payload: { changed: true }
  })), ConsolidationJobConflictError);
  assert.equal(store.listRecoverableConsolidationJobs({ now: 60 }).length, 1);
}));

test('corrupted queued job fails checksum validation instead of being reconstructed', () => withStore(store => {
  store.transaction(() => store.createConsolidationJobInternal({
    jobId: 'job_bad',
    subjectType: 'role_history',
    subjectId: 'yuqi:cursor',
    roleId: 'yuqi',
    jobType: 'history_backfill',
    dueAt: 1,
    payload: { cursor: 1 }
  }));
  store.db.prepare(`UPDATE consolidation_jobs SET payload_json = '{"cursor":2}' WHERE job_id = 'job_bad'`).run();
  assert.equal(store.claimDueConsolidationJob({
    workerId: 'worker',
    jobTypes: ['history_backfill'],
    now: 2
  }), null);
  assert.equal(
    store.db.prepare(`SELECT last_error_code FROM consolidation_jobs WHERE job_id = 'job_bad'`).get().last_error_code,
    'JOB_PAYLOAD_CHECKSUM_MISMATCH'
  );
}));

test('live shadow storage rejects replay evidence and preserves rollout identity', () => withStore(store => {
  assert.throws(() => store.transaction(() => store.putCognitionShadowRunInternal({
    source: 'replay'
  })), /live/);
  const run = store.transaction(() => store.putCognitionShadowRunInternal({
    runId: 'run_1',
    subjectType: 'turn',
    subjectId: 'turn_1',
    turnId: 'turn_1',
    rolloutKey: 'DIRECT_REPLY',
    source: 'live',
    comparisonDirection: 'legacy_authoritative_cognition_compare',
    evidenceEpoch: 1,
    shadowEpoch: 1,
    rolloutRevision: 2,
    pipelineChecksum: 'pipeline',
    state: 'queued'
  }));
  assert.equal(run.source, 'live');
  assert.equal(store.listLiveShadowRuns({
    rolloutKey: 'DIRECT_REPLY',
    direction: 'legacy_authoritative_cognition_compare',
    since: 0
  }).length, 1);
  assert.equal(store.countOutstandingComparisonSubjects({
    rolloutKey: 'DIRECT_REPLY',
    direction: 'legacy_authoritative_cognition_compare',
    evidenceEpoch: 1,
    shadowEpoch: 1,
    now: 10
  }), 1);
}));
