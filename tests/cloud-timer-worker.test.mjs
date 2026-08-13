import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workerSource = readFileSync('cloud-timer-worker.js', 'utf8').replace(
  'async function sendPush(target, env, payload = {}) {',
  'async function sendPush(target, env, payload = {}) {\n  if (globalThis.__alTestSendPush) return globalThis.__alTestSendPush(target, env, payload);'
);
const worker = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#worker-state-tests`);
globalThis.__alTestSendPush = async (_target, _env, payload) => payload.jobId === 'retry-job'
  ? ({ ok: false, reason: 'temporary FCM outage', retry: true })
  : ({ ok: true, transport: 'fcm', payload: true });

class MemoryTimerStore {
  constructor() {
    this.devices = new Map();
    this.jobs = new Map();
    this.cronSummary = null;
  }
  async getSubscription(deviceId) {
    return this.devices.get(deviceId) || null;
  }
  async saveSubscription(target) {
    const previous = await this.getSubscription(target.deviceId);
    const idempotent = previous != null
      && previous.transport === target.transport
      && previous.fcmToken === target.fcmToken
      && previous.backgroundAck === target.backgroundAck
      && JSON.stringify(previous.subscription) === JSON.stringify(target.subscription);
    if (!idempotent) this.devices.set(target.deviceId, structuredClone(target));
    return { idempotent };
  }
  async deleteSubscription(deviceId) {
    return this.devices.delete(deviceId);
  }
  async getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }
  async saveJob(job, logicalKey) {
    const active = [...this.jobs.values()].find(row => row.logicalKey === logicalKey) || null;
    const previous = await this.getJob(job.jobId);
    const comparable = value => JSON.stringify({ ...value, updatedAt: 0, logicalKey: undefined });
    if (active?.jobId === job.jobId && previous && comparable(previous) === comparable(job)) {
      return { idempotent: true, replacedJobId: '' };
    }
    if (active && active.jobId !== job.jobId) this.jobs.delete(active.jobId);
    this.jobs.set(job.jobId, { ...structuredClone(job), logicalKey });
    return { idempotent: false, replacedJobId: active?.jobId || '' };
  }
  async deleteJob(jobId) {
    return this.jobs.delete(jobId);
  }
  async dueJobs(now, limit = 100) {
    return [...this.jobs.values()]
      .filter(row => Date.parse(row.dueAt) <= now)
      .sort((left, right) => Date.parse(left.dueAt) - Date.parse(right.dueAt))
      .slice(0, limit);
  }
  async deviceJobs(deviceId) {
    return [...this.jobs.values()].filter(row => row.deviceId === deviceId);
  }
  async getCronSummary() {
    return this.cronSummary;
  }
  async saveCronSummary(summary) {
    this.cronSummary = structuredClone(summary);
  }
}

function envFor(store = new MemoryTimerStore()) {
  return {
    AL_TIMER_STORE: store,
    FIREBASE_PROJECT_ID: 'test-project',
    FIREBASE_CLIENT_EMAIL: 'test@example.com',
    FIREBASE_PRIVATE_KEY: 'unused-by-test-hook'
  };
}

async function post(env, path, body) {
  return worker.default.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
}

async function registerAndSchedule(env, { jobId, dueAt }) {
  const register = await post(env, '/register', {
    deviceId: 'device-a',
    transport: 'fcm',
    fcmToken: 'token-a',
    capabilities: { backgroundAck: 1 }
  });
  assert.equal(register.status, 200);
  const schedule = await post(env, '/schedule', {
    deviceId: 'device-a',
    charId: 'char-a',
    jobId,
    kind: 'chat',
    dueAt
  });
  assert.equal(schedule.status, 200);
}

async function runCron(env) {
  const pending = [];
  await worker.default.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
}

test('a transient push failure migrates the job into a future retry bucket', async () => {
  const env = envFor();
  const dueAt = new Date(Date.now() - 61000).toISOString();
  await registerAndSchedule(env, { jobId: 'retry-job', dueAt });
  await runCron(env);

  const stored = await env.AL_TIMER_STORE.getJob('retry-job');
  assert.ok(Date.parse(stored.dueAt) > Date.now(), 'retry must have a new future dueAt');
  assert.equal(Number(stored.deliveryAttempts), 1);
  assert.deepEqual(await env.AL_TIMER_STORE.dueJobs(Date.now()), [], 'retried job must leave the due query');
});

test('an accepted FCM push stays pending until the matching phone acknowledges it', async () => {
  const env = envFor();
  const dueAt = new Date(Date.now() - 61000).toISOString();
  await registerAndSchedule(env, { jobId: 'ack-job', dueAt });
  await runCron(env);

  const waiting = await env.AL_TIMER_STORE.getJob('ack-job');
  assert.equal(waiting.awaitingAck, true);
  assert.equal(waiting.deliveryAttempts, 1);
  const wrong = await post(env, '/ack', { deviceId: 'device-b', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(wrong.status, 400);
  assert.ok(await env.AL_TIMER_STORE.getJob('ack-job'));
  const acknowledged = await post(env, '/ack', { deviceId: 'device-a', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(acknowledged.status, 200);
  assert.equal(await env.AL_TIMER_STORE.getJob('ack-job'), null);
});

test('FCM uses the documented Android high priority value and survives short offline periods', async () => {
  const fcmRequests = [];
  const originalFetch = globalThis.fetch;
  const isolatedSource = readFileSync('cloud-timer-worker.js', 'utf8').replace(
    'const accessToken = await getFirebaseAccessToken(env);',
    "const accessToken = 'test-access-token';"
  );
  const isolatedWorker = await import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString('base64')}#fcm-payload-test`);
  globalThis.fetch = async (url, options = {}) => {
    fcmRequests.push({ url: String(url), options });
    return new Response('{"name":"projects/test/messages/1"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };
  try {
    const env = envFor();
    const register = await post(env, '/register', {
      deviceId: 'device-fcm',
      transport: 'fcm',
      fcmToken: 'token-fcm',
      capabilities: { backgroundAck: 1 }
    });
    assert.equal(register.status, 200);
    const trigger = await isolatedWorker.default.fetch(new Request('https://worker.example/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-fcm', charId: 'char-a', jobId: 'fcm-job', kind: 'chat' })
    }), env);
    assert.equal(trigger.status, 200);
    const body = JSON.parse(fcmRequests[0].options.body);
    assert.equal(body.message.android.priority, 'high');
    assert.equal(body.message.android.ttl, '86400s');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
