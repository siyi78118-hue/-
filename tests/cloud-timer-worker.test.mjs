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

class FakeKV {
  constructor() {
    this.rows = new Map();
  }
  async get(key) {
    return this.rows.get(key) ?? null;
  }
  async put(key, value) {
    this.rows.set(key, String(value));
  }
  async delete(key) {
    this.rows.delete(key);
  }
}

function envFor(kv = new FakeKV()) {
  return {
    AL_TIMER_KV: kv,
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
  const oldMinute = Math.ceil(Date.parse(dueAt) / 60000);
  await registerAndSchedule(env, { jobId: 'retry-job', dueAt });
  await runCron(env);

  const stored = JSON.parse(await env.AL_TIMER_KV.get('job:retry-job'));
  assert.ok(Date.parse(stored.dueAt) > Date.now(), 'retry must have a new future dueAt');
  assert.equal(Number(stored.deliveryAttempts), 1);
  assert.equal(await env.AL_TIMER_KV.get(`due:${oldMinute}`), null, 'past bucket must be cleared');
  const retryMinute = Math.ceil(Date.parse(stored.dueAt) / 60000);
  assert.deepEqual(JSON.parse(await env.AL_TIMER_KV.get(`due:${retryMinute}`)), ['retry-job']);
});

test('an accepted FCM push stays pending until the matching phone acknowledges it', async () => {
  const env = envFor();
  const dueAt = new Date(Date.now() - 61000).toISOString();
  await registerAndSchedule(env, { jobId: 'ack-job', dueAt });
  await runCron(env);

  const waiting = JSON.parse(await env.AL_TIMER_KV.get('job:ack-job'));
  assert.equal(waiting.awaitingAck, true);
  assert.equal(waiting.deliveryAttempts, 1);
  const wrong = await post(env, '/ack', { deviceId: 'device-b', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(wrong.status, 400);
  assert.ok(await env.AL_TIMER_KV.get('job:ack-job'));
  const acknowledged = await post(env, '/ack', { deviceId: 'device-a', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(acknowledged.status, 200);
  assert.equal(await env.AL_TIMER_KV.get('job:ack-job'), null);
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
