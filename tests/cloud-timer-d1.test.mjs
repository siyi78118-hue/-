import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workerSource = await readFile(new URL('../cloud-timer-worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#d1-store`);
const { createD1TimerStore } = await import(`data:text/javascript;base64,${Buffer.from(`${workerSource}\nexport { createD1TimerStore };`).toString('base64')}#d1-store-internals`);

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

class MemoryTimerStore {
  constructor() {
    this.devices = new Map();
    this.jobs = new Map();
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
