import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConsolidationWorker } from '../src/consolidation-worker.mjs';
import { YuqiStore } from '../src/store.mjs';

function envelope(seq = 1) {
  return {
    protocolVersion: 2,
    turnId: `turn_device_${seq}`,
    characterId: 'yuqi',
    deviceId: 'device',
    deviceSeq: seq,
    createdAt: 1784400000000 + seq,
    kind: 'DIRECT_REPLY',
    message: {
      messageId: `msg_device_${seq}`,
      speakerId: 'user',
      speakerType: 'user',
      recipientId: 'yuqi',
      content: '我喜欢砂锅米线',
      sentAt: 1784400000000 + seq
    }
  };
}

function withFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'yuqi-consolidation-'));
  const store = new YuqiStore(join(dir, 'runtime.sqlite'));
  const presetRegistry = {
    current: () => ({ version: '2.0.0' }),
    resolvePresetBundle: () => '只整理有原文证据的记忆'
  };
  return Promise.resolve(run({ store, presetRegistry })).finally(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
}

function createJob(store, turn, now = 1784400001000) {
  return store.createConsolidationJobInternal({
    subjectType: 'turn',
    subjectId: turn.turnId,
    turnId: turn.turnId,
    roleId: 'yuqi',
    jobType: 'turn_consolidation',
    dueAt: now,
    createdAt: now,
    payload: { turnId: turn.turnId }
  });
}

test('a turn consolidation job commits evidence-backed facts once and completes its lease', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(1), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    createJob(store, turn);
    const codexClient = {
      async runTurn() {
        return {
          text: JSON.stringify({
            candidates: [{
              factId: 'fact_user_food_1',
              characterId: 'yuqi',
              type: 'preference',
              subjectId: 'user',
              predicate: 'likes_food',
              object: { food: '砂锅米线' },
              evidenceMode: 'direct',
              sourceMessageIds: ['msg_device_1'],
              exactQuotes: [{
                messageId: 'msg_device_1',
                speakerId: 'user',
                text: '我喜欢砂锅米线'
              }],
              confidence: 0.99
            }]
          })
        };
      }
    };
    const worker = new ConsolidationWorker({
      store, codexClient, presetRegistry, clock: () => 1784400001000
    });

    await worker.runOnce();
    await worker.runOnce();

    assert.equal(store.listFacts('yuqi').length, 1);
    assert.equal(store.listFacts('yuqi')[0].status, 'verified');
    assert.equal(
      store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).state,
      'completed'
    );
  });
});

test('an undelivered Yuqi message can only create provisional evidence', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(2), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    store.putMessage({
      messageId: 'msg_yuqi_2',
      turnId: turn.turnId,
      characterId: 'yuqi',
      speakerId: 'yuqi',
      speakerType: 'character',
      recipientId: 'user',
      content: '我答应你，晚上回来找你',
      sentAt: 1784400000500,
      origin: 'codex'
    });
    createJob(store, turn);
    const codexClient = {
      async runTurn() {
        return {
          text: JSON.stringify({
            candidates: [{
              factId: 'fact_yuqi_promise_2',
              characterId: 'yuqi',
              type: 'commitment',
              subjectId: 'yuqi',
              predicate: 'promised_to_return',
              object: { when: 'evening' },
              promisedBy: 'yuqi',
              promisedTo: 'user',
              evidenceMode: 'direct',
              sourceMessageIds: ['msg_yuqi_2'],
              exactQuotes: [{
                messageId: 'msg_yuqi_2',
                speakerId: 'yuqi',
                text: '我答应你，晚上回来找你'
              }],
              confidence: 0.99
            }]
          })
        };
      }
    };
    const worker = new ConsolidationWorker({
      store, codexClient, presetRegistry, clock: () => 1784400001000
    });

    await worker.runOnce();

    assert.equal(store.listFacts('yuqi')[0].status, 'provisional');
    assert.equal(store.listFacts('yuqi')[0].evidenceSource, 'fallback_provisional');
  });
});

test('failures back off for four attempts and the fifth failure is auditable without changing the turn', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(3), {
      pipelineMode: 'active',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    createJob(store, turn);
    let now = 1784400001000;
    const worker = new ConsolidationWorker({
      store,
      presetRegistry,
      clock: () => now,
      codexClient: { async runTurn() { throw new Error('temporary provider failure'); } }
    });
    const delays = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];
    for (const delay of delays) {
      await worker.runOnce();
      const row = store.db.prepare(
        'SELECT state, due_at FROM consolidation_jobs WHERE turn_id = ?'
      ).get(turn.turnId);
      assert.equal(row.state, 'retry_wait');
      assert.equal(row.due_at, now + delay);
      now = row.due_at;
    }
    await worker.runOnce();
    const failed = store.db.prepare(
      'SELECT state, attempt_count, last_error_code FROM consolidation_jobs WHERE turn_id = ?'
    ).get(turn.turnId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.attempt_count, 5);
    assert.equal(failed.last_error_code, 'Error');
    assert.equal(store.getTurn(turn.turnId).state, 'queued');
  });
});

test('turn consolidation never claims a shadow job', async () => {
  await withFixture(async ({ store, presetRegistry }) => {
    const turn = store.submitTurn(envelope(4), {
      pipelineMode: 'shadow',
      presetVersion: '2.0.0',
      annotationSnapshot: {}
    });
    store.createConsolidationJobInternal({
      subjectType: 'turn',
      subjectId: turn.turnId,
      turnId: turn.turnId,
      roleId: 'yuqi',
      jobType: 'shadow_cognition',
      dueAt: 1784400001000,
      payload: { turnId: turn.turnId }
    });
    const worker = new ConsolidationWorker({
      store,
      presetRegistry,
      clock: () => 1784400001000,
      codexClient: { async runTurn() { throw new Error('must not run'); } }
    });

    assert.equal(await worker.runOnce(), null);
    assert.equal(
      store.db.prepare('SELECT state FROM consolidation_jobs WHERE turn_id = ?').get(turn.turnId).state,
      'queued'
    );
  });
});
