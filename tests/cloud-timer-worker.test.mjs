import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contractSource = readFileSync('automatic-schedule-contract.mjs', 'utf8');
const contractUrl = `data:text/javascript;base64,${Buffer.from(contractSource).toString('base64')}#automatic-schedule-contract`;
const workerSource = readFileSync('cloud-timer-worker.js', 'utf8')
  .replace("from './automatic-schedule-contract.mjs'", `from '${contractUrl}'`)
  .replace(
    'async function sendPush(target, env, payload = {}) {',
    'async function sendPush(target, env, payload = {}) {\n  if (globalThis.__alTestSendPush) return globalThis.__alTestSendPush(target, env, payload);'
  );
const worker = await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#worker-state-tests`);
const sentPayloads = [];
globalThis.__alTestSendPush = async (_target, _env, payload) => {
  sentPayloads.push(structuredClone(payload));
  return payload.jobId === 'retry-job'
    ? ({ ok: false, reason: 'temporary FCM outage', retry: true })
    : ({ ok: true, transport: 'fcm', payload: true });
};

class MemoryTimerStore {
  constructor() {
    this.devices = new Map();
    this.jobs = new Map();
    this.cronSummary = null;
    this.deliveryProbe = null;
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
      .filter(row => Date.parse(row.nextDeliveryAttemptAt || row.dueAt) <= now)
      .sort((left, right) => Date.parse(left.nextDeliveryAttemptAt || left.dueAt) - Date.parse(right.nextDeliveryAttemptAt || right.dueAt))
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
  async saveDeliveryProbe(probe) {
    this.deliveryProbe = structuredClone(probe);
  }
  async getDeliveryProbe() {
    return this.deliveryProbe && structuredClone(this.deliveryProbe);
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

async function registerAndSchedule(env, { jobId, dueAt, test: manualTest = false }) {
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
    dueAt,
    test: manualTest
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
  assert.equal(stored.dueAt, dueAt, 'transport retry must not rewrite the role\'s scheduled time');
  assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now(), 'retry must have a separate future transport deadline');
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
  assert.equal(waiting.dueAt, dueAt, 'ACK wait must preserve the original proactive deadline');
  assert.ok(Date.parse(waiting.nextDeliveryAttemptAt) > Date.now());
  const status = await (await post(env, '/job-status', { deviceId: 'device-a', jobId: 'ack-job' })).json();
  assert.equal(status.job.dueAt, dueAt);
  assert.equal(status.job.nextDeliveryAttemptAt, waiting.nextDeliveryAttemptAt);
  const wrong = await post(env, '/ack', { deviceId: 'device-b', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(wrong.status, 400);
  assert.ok(await env.AL_TIMER_STORE.getJob('ack-job'));
  const acknowledged = await post(env, '/ack', { deviceId: 'device-a', jobId: 'ack-job', outcome: 'generated' });
  assert.equal(acknowledged.status, 200);
  assert.equal(await env.AL_TIMER_STORE.getJob('ack-job'), null);
});

test('cron defers an automatic authority job without writing the legacy timer table', async () => {
  const store = new MemoryTimerStore();
  const automatic = {
    automaticAuthority: true,
    streamKey: 'active:device-a:char-a:chat',
    authorityEpoch: '00112233445566778899aabbccddeeff',
    generation: 1,
    deviceId: 'device-a',
    characterId: 'char-a',
    charId: 'char-a',
    kind: 'chat',
    jobId: 'pro_authority_1',
    dueAt: Date.now() - 60_000,
    nextDeliveryAttemptAt: new Date(Date.now() - 60_000).toISOString()
  };
  let legacyWrites = 0;
  let deferred = null;
  store.devices.set('device-a', {
    deviceId: 'device-a', transport: 'fcm', fcmToken: 'token-a', backgroundAck: 1
  });
  store.dueJobs = async () => deferred ? [] : [structuredClone(automatic)];
  store.saveJob = async () => {
    legacyWrites += 1;
    return { idempotent: false };
  };
  store.deferAutomaticDelivery = async input => {
    deferred = structuredClone(input);
    return { deferred: true };
  };
  store.claimAutomaticDelivery = async () => ({ claimed: true });

  sentPayloads.length = 0;
  await runCron(envFor(store));

  assert.equal(legacyWrites, 0);
  assert.equal(deferred.streamKey, automatic.streamKey);
  assert.equal(deferred.authorityEpoch, automatic.authorityEpoch);
  assert.equal(deferred.generation, automatic.generation);
  assert.equal(deferred.jobId, automatic.jobId);
  assert.equal(deferred.awaitingAck, true);
  assert.ok(deferred.nextAttemptAt > Date.now());
  assert.equal(store.deliveryProbe?.workerVersion, '2026-08-15.9');
  assert.equal(store.deliveryProbe?.stage, 'awaiting_phone_ack');
  assert.equal(store.deliveryProbe?.jobId, automatic.jobId);
  assert.deepEqual(
    {
      owner: sentPayloads[0].owner,
      authorityEpoch: sentPayloads[0].authorityEpoch,
      generation: sentPayloads[0].generation,
      jobId: sentPayloads[0].jobId
    },
    {
      owner: 'android-v1',
      authorityEpoch: automatic.authorityEpoch,
      generation: automatic.generation,
      jobId: automatic.jobId
    },
    'the phone must receive the exact Room/D1 claim token'
  );
});

test('a missing push subscription never consumes an automatic authority generation', async () => {
  const store = new MemoryTimerStore();
  const automatic = {
    automaticAuthority: true,
    streamKey: 'active:device-missing:char-a:chat',
    authorityEpoch: '00112233445566778899aabbccddeeff',
    generation: 7,
    deviceId: 'device-missing',
    charId: 'char-a',
    kind: 'chat',
    jobId: 'pro_missing_subscription_7',
    dueAt: Date.now() - 60_000,
    nextDeliveryAttemptAt: new Date(Date.now() - 60_000).toISOString(),
    deliveryAttempts: 99
  };
  let deferred = null;
  let acknowledged = 0;
  store.dueJobs = async () => deferred ? [] : [structuredClone(automatic)];
  store.claimAutomaticDelivery = async () => ({ claimed: true });
  store.deferAutomaticDelivery = async input => {
    deferred = structuredClone(input);
    return { deferred: true };
  };
  store.ackAutomaticDelivery = async () => {
    acknowledged += 1;
    return { acknowledged: true };
  };

  await runCron(envFor(store));

  assert.equal(acknowledged, 0, 'transport absence is not a phone acknowledgement');
  assert.equal(deferred.streamKey, automatic.streamKey);
  assert.equal(deferred.awaitingAck, false);
  assert.ok(deferred.nextAttemptAt > Date.now());
});

test('manual push tests use an isolated job and never wait for automatic authority ACK', async () => {
  const env = envFor();
  const dueAt = new Date(Date.now() - 1000).toISOString();
  await registerAndSchedule(env, { jobId: 'manual-test-job', dueAt, test: true });
  const stored = await env.AL_TIMER_STORE.getJob('manual-test-job');
  assert.match(stored.logicalKey, /^active:test:/);

  sentPayloads.length = 0;
  const response = await post(env, '/trigger', {
    deviceId: 'device-a', charId: 'char-a', jobId: 'manual-test-job', kind: 'chat', test: true
  });
  assert.equal(response.status, 200);
  assert.equal(sentPayloads[0].test, true);
  assert.equal(await env.AL_TIMER_STORE.getJob('manual-test-job'), null);
});

test('FCM uses the documented Android high priority value and survives short offline periods', async () => {
  const fcmRequests = [];
  const originalFetch = globalThis.fetch;
  const isolatedSource = readFileSync('cloud-timer-worker.js', 'utf8')
    .replace("from './automatic-schedule-contract.mjs'", `from '${contractUrl}'`)
    .replace(
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

async function importWorkerWithShortFirebaseDeadline(sourceEdits = value => value, suffix = 'firebase-deadline') {
  const isolatedSource = sourceEdits(readFileSync('cloud-timer-worker.js', 'utf8'))
    .replace("from './automatic-schedule-contract.mjs'", `from '${contractUrl}'`)
    .replace('const FIREBASE_FETCH_TIMEOUT_MS = 10_000;', 'const FIREBASE_FETCH_TIMEOUT_MS = 10;')
    .replace('const PUSH_SUBSCRIPTION_TIMEOUT_MS = 10_000;', 'const PUSH_SUBSCRIPTION_TIMEOUT_MS = 10;')
    .replace('const PUSH_DELIVERY_TIMEOUT_MS = 30_000;', 'const PUSH_DELIVERY_TIMEOUT_MS = 100;');
  return import(`data:text/javascript;base64,${Buffer.from(isolatedSource).toString('base64')}#${suffix}-${Date.now()}`);
}

async function postTo(workerModule, env, path, body) {
  return workerModule.default.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
}

async function runWorkerCron(workerModule, env) {
  const pending = [];
  await workerModule.default.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
}

async function registerDueLegacyJob(workerModule, env, jobId) {
  assert.equal((await postTo(workerModule, env, '/register', {
    deviceId: 'device-timeout',
    transport: 'fcm',
    fcmToken: 'token-timeout',
    capabilities: { backgroundAck: 1 }
  })).status, 200);
  assert.equal((await postTo(workerModule, env, '/schedule', {
    deviceId: 'device-timeout',
    charId: 'char-timeout',
    jobId,
    kind: 'chat',
    dueAt: new Date(Date.now() - 61_000).toISOString(),
    test: true
  })).status, 200);
}

function neverReturningFetchThatHonorsAbort() {
  return async (_url, options = {}) => new Promise((_resolve, reject) => {
    const signal = options.signal;
    if (!signal) return;
    const abort = () => reject(signal.reason || new Error('aborted'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('a hung Firebase OAuth request times out and enters durable delivery backoff', async () => {
  const originalFetch = globalThis.fetch;
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source.replace(
      'const assertion = await createFirebaseServiceAccountJWT(env, now);',
      "const assertion = 'test-assertion';"
    ).replace(
      '() => createFirebaseServiceAccountJWT(env, now)',
      "() => Promise.resolve('test-assertion')"
    ),
    'firebase-oauth-timeout'
  );
  globalThis.fetch = neverReturningFetchThatHonorsAbort();
  try {
    const env = envFor();
    await registerDueLegacyJob(isolatedWorker, env, 'oauth-timeout-job');
    const outcome = await Promise.race([
      runWorkerCron(isolatedWorker, env).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
    ]);
    assert.equal(outcome, 'completed');
    const stored = await env.AL_TIMER_STORE.getJob('oauth-timeout-job');
    assert.equal(stored.deliveryAttempts, 1);
    assert.equal(stored.lastDeliveryError, 'firebase oauth timeout');
    assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a hung push subscription lookup times out and enters durable delivery backoff', async () => {
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    value => value,
    'push-subscription-timeout'
  );
  const env = envFor();
  await registerDueLegacyJob(isolatedWorker, env, 'subscription-timeout-job');
  env.AL_TIMER_STORE.getSubscription = async () => new Promise(() => {});
  const outcome = await Promise.race([
    runWorkerCron(isolatedWorker, env).then(() => 'completed'),
    new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
  ]);
  assert.equal(outcome, 'completed');
  const stored = await env.AL_TIMER_STORE.getJob('subscription-timeout-job');
  assert.equal(stored.deliveryAttempts, 1);
  assert.equal(stored.lastDeliveryError, 'push subscription timeout');
  assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
});

test('a hung Firebase JWT signing stage times out and enters durable delivery backoff', async () => {
  const originalFetch = globalThis.fetch;
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source
      .replace(
        'const assertion = await createFirebaseServiceAccountJWT(env, now);',
        'const assertion = await new Promise(() => {});'
      )
      .replace(
        "const assertion = await runFirebaseStageWithTimeout('jwt', () => createFirebaseServiceAccountJWT(env, now));",
        "const assertion = await runFirebaseStageWithTimeout('jwt', () => new Promise(() => {}));"
      )
      .replace(
        '() => createFirebaseServiceAccountJWT(env, now)',
        '() => new Promise(() => {})'
      ),
    'firebase-jwt-timeout'
  );
  globalThis.fetch = async () => {
    throw new Error('fetch must not run while JWT signing is hung');
  };
  try {
    const env = envFor();
    await registerDueLegacyJob(isolatedWorker, env, 'jwt-timeout-job');
    const outcome = await Promise.race([
      runWorkerCron(isolatedWorker, env).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
    ]);
    assert.equal(outcome, 'completed');
    const stored = await env.AL_TIMER_STORE.getJob('jwt-timeout-job');
    assert.equal(stored.deliveryAttempts, 1);
    assert.equal(stored.lastDeliveryError, 'firebase jwt timeout');
    assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a hung Firebase send request times out and enters durable delivery backoff', async () => {
  const originalFetch = globalThis.fetch;
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source.replace(
      'const accessToken = await getFirebaseAccessToken(env);',
      "const accessToken = 'test-access-token';"
    ),
    'firebase-send-timeout'
  );
  globalThis.fetch = neverReturningFetchThatHonorsAbort();
  try {
    const env = envFor();
    await registerDueLegacyJob(isolatedWorker, env, 'send-timeout-job');
    const outcome = await Promise.race([
      runWorkerCron(isolatedWorker, env).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
    ]);
    assert.equal(outcome, 'completed');
    const stored = await env.AL_TIMER_STORE.getJob('send-timeout-job');
    assert.equal(stored.deliveryAttempts, 1);
    assert.equal(stored.lastDeliveryError, 'firebase send timeout');
    assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a Firebase OAuth response body that never finishes times out and enters durable delivery backoff', async () => {
  const originalFetch = globalThis.fetch;
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source.replace(
      '() => createFirebaseServiceAccountJWT(env, now)',
      "() => Promise.resolve('test-assertion')"
    ),
    'firebase-oauth-body-timeout'
  );
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => new Promise(() => {})
  });
  try {
    const env = envFor();
    await registerDueLegacyJob(isolatedWorker, env, 'oauth-body-timeout-job');
    const outcome = await Promise.race([
      runWorkerCron(isolatedWorker, env).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
    ]);
    assert.equal(outcome, 'completed');
    const stored = await env.AL_TIMER_STORE.getJob('oauth-body-timeout-job');
    assert.equal(stored.deliveryAttempts, 1);
    assert.equal(stored.lastDeliveryError, 'firebase oauth body timeout');
    assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an FCM send response body that never finishes times out and enters durable delivery backoff', async () => {
  const originalFetch = globalThis.fetch;
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source.replace(
      'const accessToken = await getFirebaseAccessToken(env);',
      "const accessToken = 'test-access-token';"
    ),
    'firebase-send-body-timeout'
  );
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => new Promise(() => {})
  });
  try {
    const env = envFor();
    await registerDueLegacyJob(isolatedWorker, env, 'send-body-timeout-job');
    const outcome = await Promise.race([
      runWorkerCron(isolatedWorker, env).then(() => 'completed'),
      new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
    ]);
    assert.equal(outcome, 'completed');
    const stored = await env.AL_TIMER_STORE.getJob('send-body-timeout-job');
    assert.equal(stored.deliveryAttempts, 1);
    assert.equal(stored.lastDeliveryError, 'firebase send body timeout');
    assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an unknown hung push transport is stopped by the outer delivery deadline and enters durable backoff', async () => {
  const isolatedWorker = await importWorkerWithShortFirebaseDeadline(
    source => source
      .replace('const PUSH_DELIVERY_TIMEOUT_MS = 30_000;', 'const PUSH_DELIVERY_TIMEOUT_MS = 10;')
      .replace(
        'async function sendPush(target, env, payload = {}) {',
        'async function sendPush(target, env, payload = {}) {\n  return new Promise(() => {});'
      ),
    'outer-push-timeout'
  );
  const env = envFor();
  await registerDueLegacyJob(isolatedWorker, env, 'outer-push-timeout-job');
  const outcome = await Promise.race([
    runWorkerCron(isolatedWorker, env).then(() => 'completed'),
    new Promise(resolve => setTimeout(() => resolve('still-hung'), 150))
  ]);
  assert.equal(outcome, 'completed');
  const stored = await env.AL_TIMER_STORE.getJob('outer-push-timeout-job');
  assert.equal(stored.deliveryAttempts, 1);
  assert.equal(stored.lastDeliveryError, 'push transport timeout');
  assert.ok(Date.parse(stored.nextDeliveryAttemptAt) > Date.now());
});
