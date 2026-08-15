import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  canonicalScheduleJson,
  scheduleSemanticChecksum,
  scheduleTransitionChecksum,
  validateScheduleTransition
} from '../automatic-schedule-contract.mjs';
import { createProactiveAuthorityHarness } from '../scripts/verify-proactive-single-authority.mjs';

const contractSource = await readFile(new URL('../automatic-schedule-contract.mjs', import.meta.url), 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contractSource).toString('base64')}#automatic-schedule-contract`;
const workerSource = (await readFile(new URL('../cloud-timer-worker.js', import.meta.url), 'utf8'))
  .replace("from './automatic-schedule-contract.mjs'", `from '${contractUrl}'`);
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#d1-store`);
const { createD1TimerStore } = await import(`data:text/javascript;base64,${Buffer.from(`${workerSource}\nexport { createD1TimerStore };`).toString('base64')}#d1-store-internals`);

test('actual D1 migration retires three conflicting legacy candidates behind one generation-one claim', async () => {
  const harness = await createProactiveAuthorityHarness({ kind: 'chat' });
  try {
    const transition = await harness.migrateThreeLegacyCandidates();
    const snapshot = harness.snapshot();
    assert.equal(transition.generation, 1);
    assert.equal(snapshot.authorityCount, 1);
    assert.equal(snapshot.legacyProjectionCount, 0);
    assert.equal(snapshot.alarmProjectionCount, 1, 'only the new authority projection remains');
    assert.equal(snapshot.workProjectionCount, 1, 'only the new authority projection remains');
    assert.deepEqual(snapshot.duplicateOutboxGenerations, []);
  } finally {
    harness.closeDatabase();
  }
});

class SingleJobD1 {
  constructor() {
    this.row = null;
  }

  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async () => {
          if (sql.includes('WHERE logical_key = ?1')) {
            return this.row?.logical_key === args[0]
              ? { job_id: this.row.job_id, payload_json: this.row.payload_json }
              : null;
          }
          if (sql.includes('WHERE job_id = ?1')) {
            return this.row?.job_id === args[0] ? { payload_json: this.row.payload_json } : null;
          }
          throw new Error(`unexpected first SQL: ${sql}`);
        },
        run: async () => {
          if (!sql.includes('INSERT OR REPLACE INTO timer_jobs')) throw new Error(`unexpected run SQL: ${sql}`);
          this.row = {
            job_id: args[0],
            logical_key: args[1],
            payload_json: args[10],
            delivery_attempts: args[11],
            awaiting_ack: args[12],
            updated_at: args[14]
          };
          return { meta: { changes: 1 } };
        }
      })
    };
  }
}

class StreamAuthorityD1 {
  constructor({
    claimMetaChangesZero = false,
    mutationMetaChangesZero = false,
    beforeTransitionUpdate = null,
    hideNextStreamRead = false
  } = {}) {
    this.rows = new Map();
    this.legacyRows = new Map();
    this.writeCount = 0;
    this.claimMetaChangesZero = claimMetaChangesZero;
    this.mutationMetaChangesZero = mutationMetaChangesZero;
    this.beforeTransitionUpdate = beforeTransitionUpdate;
    this.hideNextStreamRead = hideNextStreamRead;
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  prepare(sql) {
    return {
      bind: (...args) => ({
        first: async () => {
          if (!sql.includes('FROM timer_stream_authorities') || !sql.includes('logical_key = ?1')) {
            throw new Error(`unexpected stream first SQL: ${sql}`);
          }
          if (this.hideNextStreamRead) {
            this.hideNextStreamRead = false;
            return null;
          }
          return structuredClone(this.rows.get(args[0]) || null);
        },
        run: async () => {
          if (sql.includes('DELETE FROM timer_jobs WHERE logical_key = ?1')) {
            const deleted = this.legacyRows.delete(args[0]);
            return { meta: { changes: deleted ? 1 : 0 } };
          }
          if (sql.includes('INSERT INTO timer_stream_authorities')) {
            if (this.rows.has(args[0])) return { meta: { changes: 0 } };
            this.rows.set(args[0], {
              logical_key: args[0], device_id: args[1], char_id: args[2], kind: args[3], owner: args[4],
              authority_epoch: args[5], generation: args[6], state: args[7], active_job_id: args[8],
              due_at: args[9], payload_json: args[10], expected_previous_job_id: args[11],
              schedule_checksum: args[12], delivery_attempts: 0, updated_at: args[13]
            });
            this.writeCount += 1;
            return this.mutationMetaChangesZero
              ? { results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [], meta: { changes: 0 } }
              : { meta: { changes: 1 } };
          }
          if (sql.includes('UPDATE timer_stream_authorities')) {
            let current = this.rows.get(args[0]);
            if (sql.includes('due_at = ?5') && sql.includes('due_at = ?6')) {
              const matches = current && current.authority_epoch === args[1]
                && current.generation === args[2] && current.active_job_id === args[3]
                && current.due_at === args[5] && ['scheduled', 'awaiting_ack'].includes(current.state);
              if (!matches) return { meta: { changes: 0 } };
              this.rows.set(args[0], { ...current, due_at: args[4], updated_at: args[6] });
              this.writeCount += 1;
              if (this.claimMetaChangesZero) {
                return {
                  results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [],
                  meta: { changes: 0 }
                };
              }
              return this.mutationMetaChangesZero
                ? { results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [], meta: { changes: 0 } }
                : { meta: { changes: 1 } };
            }
            if (sql.includes('delivery_attempts = delivery_attempts + 1')) {
              const matches = current && current.authority_epoch === args[1]
                && current.generation === args[2] && current.active_job_id === args[3]
                && ['scheduled', 'awaiting_ack'].includes(current.state);
              if (!matches) return { meta: { changes: 0 } };
              this.rows.set(args[0], {
                ...current, state: args[4], due_at: args[5],
                delivery_attempts: current.delivery_attempts + 1, updated_at: args[6]
              });
              this.writeCount += 1;
              return this.mutationMetaChangesZero
                ? { results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [], meta: { changes: 0 } }
                : { meta: { changes: 1 } };
            }
            if (sql.includes('active_job_id = NULL')) {
              const matches = current && current.authority_epoch === args[1]
                && current.generation === args[2] && current.active_job_id === args[3]
                && ['scheduled', 'awaiting_ack'].includes(current.state);
              if (!matches) return { meta: { changes: 0 } };
              this.rows.set(args[0], {
                ...current, state: 'paused', active_job_id: null, due_at: null, payload_json: null,
                expected_previous_job_id: args[3], delivery_attempts: 0, updated_at: args[4]
              });
              this.writeCount += 1;
              return this.mutationMetaChangesZero
                ? { results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [], meta: { changes: 0 } }
                : { meta: { changes: 1 } };
            }
            if (this.beforeTransitionUpdate) {
              const mutate = this.beforeTransitionUpdate;
              this.beforeTransitionUpdate = null;
              mutate(this.rows, args[0]);
              current = this.rows.get(args[0]);
            }
            const matches = current
              && current.owner === args[10]
              && current.authority_epoch === args[11]
              && current.generation === args[12]
              && (current.active_job_id ?? null) === (args[13] ?? null)
              && current.schedule_checksum === args[14]
              && (!sql.includes('state = ?16') || current.state === args[15])
              && (!sql.includes('due_at = ?17') || (current.due_at ?? null) === (args[16] ?? null))
              && (!sql.includes('payload_json = ?18') || (current.payload_json ?? null) === (args[17] ?? null))
              && (!sql.includes('expected_previous_job_id = ?19') || (current.expected_previous_job_id ?? null) === (args[18] ?? null));
            if (!matches) return { meta: { changes: 0 } };
            this.rows.set(args[0], {
              ...current, generation: args[1], state: args[2], active_job_id: args[3], due_at: args[4],
              payload_json: args[5], expected_previous_job_id: args[6], schedule_checksum: args[7],
              delivery_attempts: 0, updated_at: args[8]
            });
            this.writeCount += 1;
            return this.mutationMetaChangesZero
              ? { results: sql.includes('RETURNING logical_key') ? [{ logical_key: args[0] }] : [], meta: { changes: 0 } }
              : { meta: { changes: 1 } };
          }
          throw new Error(`unexpected stream run SQL: ${sql}`);
        },
        all: async () => {
          if (!sql.includes('timer_stream_authorities')) throw new Error(`unexpected stream all SQL: ${sql}`);
          const now = args[0];
          const limit = args[1];
          const results = [...this.rows.values()]
            .filter(row => ['scheduled', 'awaiting_ack'].includes(row.state) && row.due_at <= now)
            .sort((left, right) => left.due_at - right.due_at)
            .slice(0, limit)
            .map(row => ({ ...structuredClone(row), automatic_authority: 1 }));
          return { results };
        }
      })
    };
  }
}

async function nextTransition(previous, overrides = {}) {
  const transition = {
    ...structuredClone(previous),
    generation: previous.generation + 1,
    expectedPreviousJobId: previous.jobId,
    sourceType: 'direct_terminal',
    sourceId: `turn-${previous.generation + 1}`,
    sourceChecksum: String(previous.generation + 1).padStart(64, 'c'),
    transitionChecksum: '0'.repeat(64),
    scheduleChecksum: '0'.repeat(64),
    ...overrides
  };
  transition.transitionChecksum = await scheduleTransitionChecksum(transition);
  if (transition.operation === 'schedule') {
    transition.jobId = `${transition.kind === 'chat' ? 'pro' : 'mom'}_${transition.transitionChecksum.slice(0, 16)}_${transition.generation}`;
  }
  transition.scheduleChecksum = await scheduleSemanticChecksum(transition);
  return transition;
}

class MemoryTimerStore {
  constructor() {
    this.devices = new Map();
    this.jobs = new Map();
    this.automaticStreams = new Map();
    this.transitionCalls = 0;
  }
  async getSubscription(deviceId) { return this.devices.get(deviceId) || null; }
  async saveSubscription(target) {
    const previous = this.devices.get(target.deviceId) || null;
    const idempotent = previous != null
      && previous.transport === target.transport
      && previous.fcmToken === target.fcmToken
      && previous.backgroundAck === target.backgroundAck
      && JSON.stringify(previous.subscription) === JSON.stringify(target.subscription);
    if (!idempotent) this.devices.set(target.deviceId, structuredClone(target));
    return { idempotent };
  }
  async deleteSubscription(deviceId) { return this.devices.delete(deviceId); }
  async getJob(jobId) { return this.jobs.get(jobId) || null; }
  async saveJob(job, logicalKey) {
    const previous = this.jobs.get(job.jobId) || null;
    const active = [...this.jobs.values()].find(row => row.logicalKey === logicalKey) || null;
    const comparable = value => JSON.stringify({ ...value, updatedAt: 0, logicalKey: undefined });
    if (active?.jobId === job.jobId && previous && comparable(previous) === comparable(job)) {
      return { idempotent: true, replacedJobId: '' };
    }
    if (active && active.jobId !== job.jobId) this.jobs.delete(active.jobId);
    this.jobs.set(job.jobId, { ...structuredClone(job), logicalKey });
    return { idempotent: false, replacedJobId: active?.jobId || '' };
  }
  async deleteJob(jobId) { return this.jobs.delete(jobId); }
  async dueJobs(now, limit = 100) {
    return [...this.jobs.values()].filter(row => Date.parse(row.nextDeliveryAttemptAt || row.dueAt) <= now)
      .sort((a, b) => Date.parse(a.nextDeliveryAttemptAt || a.dueAt) - Date.parse(b.nextDeliveryAttemptAt || b.dueAt)).slice(0, limit);
  }
  async deviceJobs(deviceId) { return [...this.jobs.values()].filter(row => row.deviceId === deviceId); }
  async getAutomaticStreamStatus(logicalKey) { return this.automaticStreams.get(logicalKey) || null; }
  async transitionAutomaticStream(transition) {
    this.transitionCalls += 1;
    const previous = this.automaticStreams.get(transition.streamKey) || null;
    this.automaticStreams.set(transition.streamKey, structuredClone(transition));
    for (const [jobId, job] of this.jobs) {
      if (job.logicalKey === transition.streamKey) this.jobs.delete(jobId);
    }
    return { idempotent: false, previous, current: structuredClone(transition) };
  }
}

async function post(store, path, body) {
  return worker.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), { AL_TIMER_STORE: store });
}

test('worker configuration and schema use D1 instead of KV task writes', async () => {
  const wrangler = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const migration = await readFile(new URL('../migrations/0001_timer_store.sql', import.meta.url), 'utf8');
  assert.match(wrangler, /\[\[d1_databases\]\][\s\S]*binding\s*=\s*"AL_TIMER_DB"/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS timer_devices/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS timer_jobs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS timer_meta/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_timer_jobs_due_at/);
  assert.doesNotMatch(workerSource, /AL_TIMER_KV\.(?:put|delete|list)/, 'new timer writes must not use KV');
  assert.match(
    workerSource,
    /INSERT OR REPLACE INTO timer_jobs[\s\S]+NOT EXISTS\s*\(SELECT 1 FROM timer_stream_authorities WHERE logical_key = \?16\)/,
    'legacy automatic writes must atomically lose once a stream authority exists'
  );
});

test('D1 persists FCM acknowledgement state without letting a schedule replay erase it', async () => {
  const db = new SingleJobD1();
  const store = createD1TimerStore(db);
  const logicalKey = 'active:device-a:char-a:chat';
  const scheduled = {
    deviceId: 'device-a',
    jobId: 'ack-job',
    charId: 'char-a',
    dueAt: '2026-08-14T10:27:40.294Z',
    type: 'proactive',
    kind: 'chat',
    mode: 'dice',
    updatedAt: 1000
  };
  await store.saveJob(scheduled, logicalKey);

  const awaitingAck = {
    ...scheduled,
    nextDeliveryAttemptAt: '2026-08-14T11:10:26.779Z',
    deliveryAttempts: 1,
    awaitingAck: true,
    lastPushedAt: 1786705526779,
    updatedAt: 2000
  };
  const transitioned = await store.saveJob(awaitingAck, logicalKey, { force: true });
  assert.equal(transitioned.idempotent, false);
  assert.equal(JSON.parse(db.row.payload_json).awaitingAck, true);
  assert.equal(db.row.awaiting_ack, 1);
  assert.equal(db.row.delivery_attempts, 1);

  const replayed = await store.saveJob({ ...scheduled, updatedAt: 3000 }, logicalKey);
  assert.equal(replayed.idempotent, true);
  assert.equal(JSON.parse(db.row.payload_json).awaitingAck, true);
  assert.equal(db.row.updated_at, 2000);
});

test('D1 timer contract keeps logical singleton jobs and independent role plans', async () => {
  const store = new MemoryTimerStore();
  const registered = await post(store, '/register', {
    deviceId: 'device-a', transport: 'fcm', fcmToken: 'token-a', capabilities: { backgroundAck: 1 }
  });
  assert.equal(registered.status, 200);

  const future = minutes => new Date(Date.now() + minutes * 60000).toISOString();
  const first = { deviceId: 'device-a', jobId: 'pro_device-a_char-a_1', charId: 'char-a', dueAt: future(30), kind: 'chat' };
  const second = { ...first, jobId: 'pro_device-a_char-a_2', dueAt: future(60) };
  assert.equal((await post(store, '/schedule', first)).status, 200);
  const replaced = await post(store, '/schedule', second);
  assert.equal(replaced.status, 200);
  assert.equal((await replaced.json()).replacedJobId, first.jobId);
  assert.equal(store.jobs.has(first.jobId), false);
  assert.equal(store.jobs.has(second.jobId), true);

  const planA = { deviceId: 'device-a', jobId: 'rpl_device-a_plan-a_100', planId: 'plan-a', occurrenceId: 'plan-a:100', charId: 'char-a', type: 'role-plan', kind: 'private_message', source: 'spoken', dueAt: future(90) };
  const planB = { ...planA, jobId: 'rpl_device-a_plan-b_200', planId: 'plan-b', occurrenceId: 'plan-b:200', dueAt: future(120) };
  assert.equal((await post(store, '/schedule', planA)).status, 200);
  assert.equal((await post(store, '/schedule', planB)).status, 200);
  assert.equal(store.jobs.has(planA.jobId), true);
  assert.equal(store.jobs.has(planB.jobId), true);

  const status = await (await post(store, '/job-status', { deviceId: 'device-a', jobId: planA.jobId })).json();
  assert.equal(status.exists, true);
  assert.equal(status.bucketHasJob, true, 'legacy field remains true for an indexed D1 row');
  assert.equal(status.subscriptionExists, true);

  const wrongAck = await post(store, '/ack', { deviceId: 'device-b', jobId: planA.jobId });
  assert.equal(wrongAck.status, 400);
  assert.equal(store.jobs.has(planA.jobId), true);
  const ack = await post(store, '/ack', { deviceId: 'device-a', jobId: planA.jobId, outcome: 'generated-role-plan' });
  assert.equal(ack.status, 200);
  assert.equal(store.jobs.has(planA.jobId), false);

  const cleanup = await (await post(store, '/cancel-device-tasks', { deviceId: 'device-a' })).json();
  assert.equal(cleanup.chatJobsDeleted, 1);
  assert.equal(cleanup.rolePlanJobsDeleted, 1);
  assert.equal(cleanup.subscriptionPreserved, true);
  assert.equal(store.jobs.size, 0);
});

test('D1 daily limit is returned as a retryable structured error', async () => {
  const store = new MemoryTimerStore();
  store.saveJob = async () => { throw new Error('D1 daily write limit exceeded'); };
  const response = await post(store, '/schedule', {
    deviceId: 'device-a', jobId: 'pro_device-a_char-a_quota', charId: 'char-a',
    dueAt: new Date(Date.now() + 60000).toISOString(), kind: 'chat'
  });
  const body = await response.json();
  assert.equal(response.status, 429);
  assert.equal(body.code, 'D1_DAILY_LIMIT');
  assert.ok(Date.parse(body.retryAt) > Date.now());
});

test('v2 schedule transition establishes one permanent automatic stream authority', async () => {
  const store = new MemoryTimerStore();
  const transition = {
    protocolVersion: 2,
    operation: 'schedule',
    owner: 'android-v1',
    authorityEpoch: '00112233445566778899aabbccddeeff',
    generation: 1,
    expectedPreviousJobId: null,
    deviceId: 'device-a',
    characterId: 'char-a',
    kind: 'chat',
    streamKey: 'active:device-a:char-a:chat',
    jobId: 'pro_53fd68a5b14aec79_1',
    dueAt: 1786728600000,
    mode: 'planned',
    sourceType: 'bootstrap',
    sourceId: 'bootstrap:char-a:chat',
    sourceChecksum: 'b'.repeat(64),
    policyRevision: 1,
    policyChecksum: 'a'.repeat(64),
    transitionChecksum: '53fd68a5b14aec79a154b157a6fe9f797be18b892a9ab97fff2f359fa2132ed2',
    scheduleChecksum: '8bf4550b02d4eba0e919ba5cca9505bd9a3fb732892e9f0ada3c7fb21057d6c2'
  };

  const response = await post(store, '/v2/schedule-transitions', transition);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.idempotent, false);
  assert.deepEqual(store.automaticStreams.get(transition.streamKey), transition);
});

test('v2 schedule transition rejects unknown fields before the D1 store', async () => {
  const store = new MemoryTimerStore();
  const response = await post(store, '/v2/schedule-transitions', {
    protocolVersion: 2,
    operation: 'schedule',
    owner: 'android-v1',
    authorityEpoch: '00112233445566778899aabbccddeeff',
    generation: 1,
    expectedPreviousJobId: null,
    deviceId: 'device-a',
    characterId: 'char-a',
    kind: 'chat',
    streamKey: 'active:device-a:char-a:chat',
    jobId: 'pro_53fd68a5b14aec79_1',
    dueAt: 1786728600000,
    mode: 'planned',
    sourceType: 'bootstrap',
    sourceId: 'bootstrap:char-a:chat',
    sourceChecksum: 'b'.repeat(64),
    policyRevision: 1,
    policyChecksum: 'a'.repeat(64),
    transitionChecksum: '53fd68a5b14aec79a154b157a6fe9f797be18b892a9ab97fff2f359fa2132ed2',
    scheduleChecksum: '8bf4550b02d4eba0e919ba5cca9505bd9a3fb732892e9f0ada3c7fb21057d6c2',
    extra: 'must-not-reach-D1'
  });

  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.code, 'SCHEDULE_CONTRACT_INVALID');
  assert.equal(store.transitionCalls, 0);
  assert.equal(store.automaticStreams.size, 0);
});

test('automatic schedule authority migration and frozen contract vectors exist', async () => {
  const migration = await readFile(new URL('../migrations/0003_automatic_schedule_authority.sql', import.meta.url), 'utf8');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));

  assert.match(migration, /CREATE TABLE IF NOT EXISTS timer_stream_authorities/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS timer_job_events/);
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS timer_stream_authority_insert_event/);
  assert.match(migration, /CREATE TRIGGER IF NOT EXISTS timer_stream_authority_update_event/);
  assert.doesNotMatch(migration, /timer_job_events[\s\S]{0,500}payload_json/i);
  assert.equal(fixture.protocolVersion, 1);
  assert.equal(fixture.vectors[0].transition.transitionChecksum, '53fd68a5b14aec79a154b157a6fe9f797be18b892a9ab97fff2f359fa2132ed2');
  assert.equal(fixture.vectors[0].transition.jobId, 'pro_53fd68a5b14aec79_1');
  assert.equal(fixture.vectors[0].transition.scheduleChecksum, '8bf4550b02d4eba0e919ba5cca9505bd9a3fb732892e9f0ada3c7fb21057d6c2');
});

test('D1 automatic authority accepts only exact replay or the next predecessor generation', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const first = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);

  assert.deepEqual(await store.transitionAutomaticStream(first), { idempotent: false });
  assert.deepEqual(await store.transitionAutomaticStream(first), { idempotent: true });
  assert.equal(db.writeCount, 1);

  const changedGenerationOne = await nextTransition({ ...first, generation: 0, jobId: null }, {
    generation: 1,
    expectedPreviousJobId: null,
    sourceId: 'forged-generation-one'
  });
  await assert.rejects(() => store.transitionAutomaticStream(changedGenerationOne), error => error.code === 'SCHEDULE_CHECKSUM_CONFLICT');

  const wrongPredecessor = await nextTransition(first, { expectedPreviousJobId: 'pro_wrong_1' });
  await assert.rejects(() => store.transitionAutomaticStream(wrongPredecessor), error => error.code === 'SCHEDULE_GENERATION_CONFLICT');

  const second = await nextTransition(first);
  assert.deepEqual(await store.transitionAutomaticStream(second), { idempotent: false });
  assert.equal(db.rows.get(first.streamKey).generation, 2);
  assert.equal(db.rows.get(first.streamKey).active_job_id, second.jobId);

  const secondSnapshot = structuredClone(db.rows.get(first.streamKey));
  const oldIdentity = {
    streamKey: first.streamKey,
    authorityEpoch: first.authorityEpoch,
    generation: first.generation,
    jobId: first.jobId
  };
  await assert.rejects(
    () => store.deferAutomaticDelivery({ ...oldIdentity, nextAttemptAt: first.dueAt + 60_000, awaitingAck: false }),
    error => error.code === 'SCHEDULE_STALE_DELIVERY'
  );
  await assert.rejects(() => store.ackAutomaticDelivery(oldIdentity), error => error.code === 'SCHEDULE_STALE_DELIVERY');
  assert.deepEqual(db.rows.get(first.streamKey), secondSnapshot);

  const foreignEpoch = await nextTransition(second, { authorityEpoch: 'ffeeddccbbaa99887766554433221100' });
  await assert.rejects(() => store.transitionAutomaticStream(foreignEpoch), error => error.code === 'SCHEDULE_AUTHORITY_CONFLICT');

  const paused = await nextTransition(second, {
    operation: 'pause', jobId: null, dueAt: null, mode: null, sourceType: 'direct_input'
  });
  assert.deepEqual(await store.transitionAutomaticStream(paused), { idempotent: false });
  assert.deepEqual(await store.transitionAutomaticStream(paused), { idempotent: true });
  assert.equal(db.rows.get(first.streamKey).state, 'paused');
  assert.equal(db.rows.get(first.streamKey).active_job_id, null);

  const disabled = await nextTransition(paused, {
    operation: 'disable', jobId: null, dueAt: null, mode: null, sourceType: 'lifecycle'
  });
  assert.deepEqual(await store.transitionAutomaticStream(disabled), { idempotent: false });
  assert.equal(db.rows.get(first.streamKey).state, 'disabled');
  assert.equal(db.rows.has(first.streamKey), true, 'disabled streams retain the permanent authority row');
  assert.equal(db.writeCount, 4);
});

test('first D1 authority claim atomically retires the pre-existing legacy automatic row', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  db.legacyRows.set(transition.streamKey, { jobId: 'pro_legacy_a' });
  const store = createD1TimerStore(db);

  assert.deepEqual(await store.transitionAutomaticStream(transition), { idempotent: false });
  assert.equal(db.rows.has(transition.streamKey), true);
  assert.equal(db.legacyRows.has(transition.streamKey), false);
});

test('two cron workers can claim one automatic due row only once before sending', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const firstStore = createD1TimerStore(db);
  const secondStore = createD1TimerStore(db);
  await firstStore.transitionAutomaticStream(transition);
  const claim = {
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: transition.generation,
    jobId: transition.jobId,
    expectedDueAt: transition.dueAt,
    leaseUntil: transition.dueAt + 60_000
  };

  const results = await Promise.all([
    firstStore.claimAutomaticDelivery(claim),
    secondStore.claimAutomaticDelivery(claim)
  ]);
  assert.deepEqual(results.sort((left, right) => Number(left.claimed) - Number(right.claimed)), [
    { claimed: false },
    { claimed: true }
  ]);
  assert.equal(db.rows.get(transition.streamKey).due_at, claim.leaseUntil);
});

test('a D1 claim uses the returned CAS row when metadata reports zero changes', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1({ claimMetaChangesZero: true });
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(transition);

  const result = await store.claimAutomaticDelivery({
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: transition.generation,
    jobId: transition.jobId,
    expectedDueAt: transition.dueAt,
    leaseUntil: transition.dueAt + 60_000
  });

  assert.deepEqual(result, { claimed: true });
  assert.equal(db.rows.get(transition.streamKey).due_at, transition.dueAt + 60_000);
});

test('all automatic authority mutations use returned CAS rows when D1 reports zero metadata changes', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const first = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1({ mutationMetaChangesZero: true });
  const store = createD1TimerStore(db);

  assert.deepEqual(await store.transitionAutomaticStream(first), { idempotent: false });
  const second = await nextTransition(first);
  assert.deepEqual(await store.transitionAutomaticStream(second), { idempotent: false });
  const identity = {
    streamKey: second.streamKey,
    authorityEpoch: second.authorityEpoch,
    generation: second.generation,
    jobId: second.jobId
  };
  assert.deepEqual(await store.deferAutomaticDelivery({
    ...identity,
    nextAttemptAt: second.dueAt + 60_000,
    awaitingAck: true
  }), { deferred: true });
  assert.deepEqual(await store.ackAutomaticDelivery(identity), { acknowledged: true });
  assert.equal(db.rows.get(first.streamKey).state, 'paused');
});

test('the phone may advance from a cloud-acknowledged generation using its delivered job as predecessor', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const first = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(first);
  await store.ackAutomaticDelivery({
    streamKey: first.streamKey,
    authorityEpoch: first.authorityEpoch,
    generation: first.generation,
    jobId: first.jobId
  });

  const second = await nextTransition(first);
  assert.deepEqual(await store.transitionAutomaticStream(second), { idempotent: false });
  assert.equal(db.rows.get(first.streamKey).generation, 2);
  assert.equal(db.rows.get(first.streamKey).active_job_id, second.jobId);
});

test('an exact schedule replay restores only the empty paused shell left by cloud acknowledgement', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const scheduled = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);

  assert.deepEqual(await store.transitionAutomaticStream(scheduled), { idempotent: false });
  await store.ackAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId
  });
  const pausedShell = structuredClone(db.rows.get(scheduled.streamKey));
  assert.equal(pausedShell.state, 'paused');
  assert.equal(pausedShell.active_job_id, null);
  assert.equal(pausedShell.due_at, null);
  assert.equal(pausedShell.payload_json, null);
  assert.equal(pausedShell.expected_previous_job_id, scheduled.jobId);

  assert.deepEqual(await store.transitionAutomaticStream(scheduled), { idempotent: false, recovered: true });
  const recovered = db.rows.get(scheduled.streamKey);
  assert.equal(recovered.generation, scheduled.generation);
  assert.equal(recovered.state, 'scheduled');
  assert.equal(recovered.active_job_id, scheduled.jobId);
  assert.equal(recovered.due_at, scheduled.dueAt);
  assert.deepEqual(JSON.parse(recovered.payload_json), scheduled);
  assert.equal(recovered.schedule_checksum, scheduled.scheduleChecksum);

  const recoverySnapshot = structuredClone(recovered);
  assert.deepEqual(await store.transitionAutomaticStream(scheduled), { idempotent: true });
  assert.deepEqual(db.rows.get(scheduled.streamKey), recoverySnapshot, 'healthy exact replay must not rewrite timestamps');
});

test('same-generation replay cannot revive a user pause or a malformed paused shell', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const scheduled = fixture.vectors[0].transition;
  const directPause = await nextTransition(scheduled, {
    operation: 'pause', jobId: null, dueAt: null, mode: null, sourceType: 'direct_input'
  });

  const directDb = new StreamAuthorityD1();
  const directStore = createD1TimerStore(directDb);
  await directStore.transitionAutomaticStream(scheduled);
  await directStore.transitionAutomaticStream(directPause);
  const directSnapshot = structuredClone(directDb.rows.get(scheduled.streamKey));
  await assert.rejects(
    () => directStore.transitionAutomaticStream(scheduled),
    error => error.code === 'SCHEDULE_GENERATION_CONFLICT'
  );
  assert.deepEqual(directDb.rows.get(scheduled.streamKey), directSnapshot);

  for (const corrupt of [
    { active_job_id: scheduled.jobId },
    { due_at: scheduled.dueAt },
    { payload_json: JSON.stringify(scheduled) },
    { expected_previous_job_id: 'pro_foreign_job_1' }
  ]) {
    const db = new StreamAuthorityD1();
    const store = createD1TimerStore(db);
    await store.transitionAutomaticStream(scheduled);
    await store.ackAutomaticDelivery({
      streamKey: scheduled.streamKey,
      authorityEpoch: scheduled.authorityEpoch,
      generation: scheduled.generation,
      jobId: scheduled.jobId
    });
    db.rows.set(scheduled.streamKey, { ...db.rows.get(scheduled.streamKey), ...corrupt });
    const before = structuredClone(db.rows.get(scheduled.streamKey));
    await assert.rejects(
      () => store.transitionAutomaticStream(scheduled),
      error => error.code === 'SCHEDULE_GENERATION_CONFLICT'
    );
    assert.deepEqual(db.rows.get(scheduled.streamKey), before, 'nonempty or foreign paused shells must not be recovered');
  }
});

test('paused-shell recovery loses its CAS when another writer changes the inspected shell', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const scheduled = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(scheduled);
  await store.ackAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId
  });
  db.beforeTransitionUpdate = (rows, streamKey) => {
    rows.set(streamKey, {
      ...rows.get(streamKey),
      state: 'disabled',
      expected_previous_job_id: null,
      updated_at: 999_999
    });
  };

  await assert.rejects(
    () => store.transitionAutomaticStream(scheduled),
    error => error.code === 'SCHEDULE_GENERATION_CONFLICT'
  );
  assert.equal(db.rows.get(scheduled.streamKey).state, 'disabled');
  assert.equal(db.rows.get(scheduled.streamKey).active_job_id, null);
  assert.equal(db.rows.get(scheduled.streamKey).payload_json, null);
  assert.equal(db.rows.get(scheduled.streamKey).updated_at, 999_999);
});

test('an insert loser recovers an exact paused winner and two recovery callers converge once', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const scheduled = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(scheduled);
  await store.ackAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId
  });

  db.hideNextStreamRead = true;
  assert.deepEqual(await store.transitionAutomaticStream(scheduled), { idempotent: false, recovered: true });
  await store.ackAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId
  });

  const results = await Promise.all([
    createD1TimerStore(db).transitionAutomaticStream(scheduled),
    createD1TimerStore(db).transitionAutomaticStream(scheduled)
  ]);
  assert.deepEqual(results.sort((left, right) => Number(left.idempotent) - Number(right.idempotent)), [
    { idempotent: false, recovered: true },
    { idempotent: true }
  ]);
  assert.equal(db.rows.get(scheduled.streamKey).state, 'scheduled');
  assert.equal(db.rows.get(scheduled.streamKey).active_job_id, scheduled.jobId);
});

test('awaiting-ack schedule replay is immutable and a foreign identity cannot recover a paused shell', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const scheduled = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(scheduled);
  await store.deferAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId,
    nextAttemptAt: scheduled.dueAt + 60_000,
    awaitingAck: true
  });
  const awaitingSnapshot = structuredClone(db.rows.get(scheduled.streamKey));
  assert.deepEqual(await store.transitionAutomaticStream(scheduled), { idempotent: true });
  assert.deepEqual(db.rows.get(scheduled.streamKey), awaitingSnapshot);

  await store.ackAutomaticDelivery({
    streamKey: scheduled.streamKey,
    authorityEpoch: scheduled.authorityEpoch,
    generation: scheduled.generation,
    jobId: scheduled.jobId
  });
  const pausedSnapshot = structuredClone(db.rows.get(scheduled.streamKey));
  await assert.rejects(
    () => store.transitionAutomaticStream({ ...scheduled, deviceId: 'device-foreign' }),
    error => error.code === 'SCHEDULE_AUTHORITY_CONFLICT'
  );
  assert.deepEqual(db.rows.get(scheduled.streamKey), pausedSnapshot);
});

test('automatic schedule contract freezes canonical bytes and rejects coerced native types', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const vector = fixture.vectors[0];
  const transition = vector.transition;
  const validated = await validateScheduleTransition(transition);
  const { protocolVersion, jobId, transitionChecksum, scheduleChecksum, ...transitionBasis } = validated;
  const { protocolVersion: ignoredProtocol, scheduleChecksum: ignoredSchedule, ...scheduleBasis } = validated;
  assert.equal(canonicalScheduleJson(transitionBasis), vector.transitionCanonicalJson);
  assert.equal(canonicalScheduleJson(scheduleBasis), vector.scheduleCanonicalJson);

  const mutations = [
    { field: 'deviceId', value: ['device-a'], resign: true },
    { field: 'characterId', value: ['char-a'], resign: true },
    { field: 'authorityEpoch', value: ['00112233445566778899aabbccddeeff'], resign: true },
    { field: 'expectedPreviousJobId', value: ['pro_previous_1'], resign: true },
    { field: 'jobId', value: [transition.jobId] },
    { field: 'sourceId', value: ['bootstrap:char-a:chat'], resign: true },
    { field: 'sourceChecksum', value: ['b'.repeat(64)], resign: true },
    { field: 'policyChecksum', value: ['a'.repeat(64)], resign: true },
    { field: 'transitionChecksum', value: [transition.transitionChecksum] },
    { field: 'scheduleChecksum', value: [transition.scheduleChecksum] },
    { field: 'generation', value: '1' },
    { field: 'dueAt', value: String(transition.dueAt) },
    { field: 'policyRevision', value: 1.5 },
    { field: 'protocolVersion', value: 3 }
  ];
  for (const mutation of mutations) {
    const candidate = { ...transition, [mutation.field]: mutation.value };
    if (mutation.resign) {
      candidate.transitionChecksum = await scheduleTransitionChecksum(candidate);
      candidate.jobId = `pro_${candidate.transitionChecksum.slice(0, 16)}_${candidate.generation}`;
      candidate.scheduleChecksum = await scheduleSemanticChecksum(candidate);
    }
    await assert.rejects(
      () => validateScheduleTransition(candidate),
      error => error.code === 'SCHEDULE_CONTRACT_INVALID',
      mutation.field
    );
  }
});

test('legacy automatic scheduling is accepted before claim and permanently rejected after owner claim', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const claim = fixture.vectors[0].transition;
  const store = new MemoryTimerStore();
  const legacyA = {
    deviceId: 'device-a', jobId: 'pro_legacy_a', charId: 'char-a', kind: 'chat',
    dueAt: new Date(Date.now() + 60_000).toISOString()
  };
  const legacyB = {
    ...legacyA, jobId: 'pro_legacy_b', dueAt: new Date(Date.now() + 120_000).toISOString()
  };

  assert.equal((await post(store, '/schedule', legacyA)).status, 200);
  assert.equal((await post(store, '/v2/schedule-transitions', claim)).status, 200);
  const before = structuredClone([...store.jobs.entries()]);
  const rejected = await post(store, '/schedule', legacyB);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'SCHEDULE_AUTHORITY_CONFLICT');
  assert.deepEqual([...store.jobs.entries()], before);
  assert.equal(store.jobs.has(legacyA.jobId), false, 'the first owner claim retires the pre-authority row');
  assert.equal(store.jobs.has(legacyB.jobId), false);
});

test('automatic delivery defer and ACK mutate only the exact current epoch generation and job', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(transition);

  const identity = {
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: transition.generation,
    jobId: transition.jobId
  };
  assert.deepEqual(await store.deferAutomaticDelivery({
    ...identity, nextAttemptAt: transition.dueAt + 60_000, awaitingAck: true
  }), { deferred: true });
  assert.equal(db.rows.get(transition.streamKey).state, 'awaiting_ack');
  assert.equal(db.rows.get(transition.streamKey).delivery_attempts, 1);

  const before = structuredClone(db.rows.get(transition.streamKey));
  await assert.rejects(
    () => store.deferAutomaticDelivery({ ...identity, generation: 0, nextAttemptAt: transition.dueAt + 120_000, awaitingAck: false }),
    error => error.code === 'SCHEDULE_STALE_DELIVERY'
  );
  assert.deepEqual(db.rows.get(transition.streamKey), before);

  assert.deepEqual(await store.ackAutomaticDelivery(identity), { acknowledged: true });
  const acknowledged = db.rows.get(transition.streamKey);
  assert.equal(acknowledged.state, 'paused');
  assert.equal(acknowledged.active_job_id, null);
  assert.equal(acknowledged.payload_json, null);
  await assert.rejects(() => store.ackAutomaticDelivery(identity), error => error.code === 'SCHEDULE_STALE_DELIVERY');
});

test('v2 automatic status defer and ACK routes expose no full epoch and reject stale delivery', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(transition);

  const statusResponse = await post(store, '/v2/schedule-status', {
    deviceId: transition.deviceId,
    characterId: transition.characterId,
    kind: transition.kind
  });
  const status = await statusResponse.json();
  assert.equal(statusResponse.status, 200);
  assert.equal(status.exists, true);
  assert.equal(status.generation, 1);
  assert.equal(status.jobId, transition.jobId);
  assert.equal(status.authorityEpochFingerprint, transition.authorityEpoch.slice(0, 8));
  assert.equal(JSON.stringify(status).includes(transition.authorityEpoch), false);
  assert.equal(db.writeCount, 1, 'read-only status must not refresh or rewrite authority state');

  const deferResponse = await post(store, '/v2/schedule-defer', {
    protocolVersion: 2,
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: 1,
    jobId: transition.jobId,
    nextAttemptAt: transition.dueAt + 60_000,
    awaitingAck: true
  });
  assert.equal(deferResponse.status, 200);
  assert.equal(db.rows.get(transition.streamKey).state, 'awaiting_ack');
  const deferredStatus = await (await post(store, '/v2/schedule-status', {
    deviceId: transition.deviceId,
    characterId: transition.characterId,
    kind: transition.kind
  })).json();
  assert.equal(deferredStatus.dueAt, transition.dueAt, 'transport retry must not rewrite the planned due time');
  assert.equal(deferredStatus.nextDeliveryAttemptAt, transition.dueAt + 60_000);

  const staleAck = await post(store, '/v2/schedule-ack', {
    protocolVersion: 2,
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: 2,
    jobId: transition.jobId
  });
  assert.equal(staleAck.status, 409);
  assert.equal((await staleAck.json()).code, 'SCHEDULE_STALE_DELIVERY');
  assert.equal(db.rows.get(transition.streamKey).state, 'awaiting_ack');

  const ackResponse = await post(store, '/v2/schedule-ack', {
    protocolVersion: 2,
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: 1,
    jobId: transition.jobId
  });
  assert.equal(ackResponse.status, 200);
  assert.equal(db.rows.get(transition.streamKey).state, 'paused');
});

test('D1 due query returns current automatic authority and a defer cannot resurrect an older due time', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/automatic-schedule-authority-v1.json', import.meta.url), 'utf8'));
  const transition = fixture.vectors[0].transition;
  const db = new StreamAuthorityD1();
  const store = createD1TimerStore(db);
  await store.transitionAutomaticStream(transition);

  const due = await store.dueJobs(transition.dueAt + 1, 10);
  assert.equal(due.length, 1);
  assert.equal(due[0].automaticAuthority, true);
  assert.equal(due[0].streamKey, transition.streamKey);
  assert.equal(due[0].authorityEpoch, transition.authorityEpoch);
  assert.equal(due[0].generation, 1);
  assert.equal(due[0].jobId, transition.jobId);
  assert.equal(due[0].charId, transition.characterId);

  await store.deferAutomaticDelivery({
    streamKey: transition.streamKey,
    authorityEpoch: transition.authorityEpoch,
    generation: 1,
    jobId: transition.jobId,
    nextAttemptAt: transition.dueAt + 60_000,
    awaitingAck: false
  });
  assert.deepEqual(await store.dueJobs(transition.dueAt + 30_000, 10), []);
});
