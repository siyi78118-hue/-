import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('./cloud-timer-worker.js', import.meta.url), 'utf8');
const workerModuleUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#task-singleton`;
const { default: cloudTimerWorker } = await import(workerModuleUrl);

class FakeKV {
  constructor() {
    this.rows = new Map();
    this.puts = [];
    this.deletes = [];
  }

  async get(key) {
    return this.rows.get(key) ?? null;
  }

  async put(key, value) {
    this.puts.push({ key, value: String(value) });
    this.rows.set(key, String(value));
  }

  async delete(key) {
    this.deletes.push(key);
    this.rows.delete(key);
  }
}

async function post(kv, path, body) {
  return cloudTimerWorker.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), { AL_TIMER_KV: kv });
}

function futureIso(minutes) {
  return new Date(Date.now() + minutes * 60000).toISOString();
}

const kv = new FakeKV();
const registration = {
  deviceId: 'device-a',
  transport: 'fcm',
  fcmToken: 'same-fcm-token',
  capabilities: { backgroundAck: 1 }
};
assert.equal((await post(kv, '/register', registration)).status, 200);
const writesBeforeDuplicateRegistration = kv.puts.length;
const duplicateRegistration = await post(kv, '/register', registration);
assert.equal(duplicateRegistration.status, 200);
assert.equal((await duplicateRegistration.json()).idempotent, true);
assert.equal(kv.puts.length, writesBeforeDuplicateRegistration, 'opening the app with the same FCM token must not consume another KV write');

const first = {
  deviceId: 'device-a',
  jobId: 'mom_device-a_char-a_first-random-id',
  charId: 'char-a',
  dueAt: futureIso(60),
  kind: 'moment',
  mode: 'dice'
};
const second = {
  ...first,
  jobId: 'mom_device-a_char-a_second-random-id',
  dueAt: futureIso(120)
};

assert.equal((await post(kv, '/schedule', first)).status, 200);
assert.equal((await post(kv, '/schedule', second)).status, 200);

const jobKeys = [...kv.rows.keys()].filter(key => key.startsWith('job:'));
const dueKeys = [...kv.rows.keys()].filter(key => key.startsWith('due:'));
const activeKeys = [...kv.rows.keys()].filter(key => key.startsWith('active:'));
assert.deepEqual(jobKeys, [`job:${second.jobId}`], 'one device/character/kind must retain exactly one job');
assert.equal(dueKeys.length, 1, 'superseding a logical task must remove its old due bucket');
assert.equal(activeKeys.length, 1, 'the worker must keep one logical-task pointer');

const oldStatus = await (await post(kv, '/job-status', { deviceId: first.deviceId, jobId: first.jobId })).json();
const newStatus = await (await post(kv, '/job-status', { deviceId: second.deviceId, jobId: second.jobId })).json();
assert.equal(oldStatus.exists, false);
assert.equal(newStatus.exists, true);
assert.equal(newStatus.bucketHasJob, true);

const writesBeforeIdempotentRetry = kv.puts.length;
const deletesBeforeIdempotentRetry = kv.deletes.length;
assert.equal((await post(kv, '/schedule', second)).status, 200);
assert.equal(kv.puts.length, writesBeforeIdempotentRetry, 'identical schedule retries must not consume KV writes');
assert.equal(kv.deletes.length, deletesBeforeIdempotentRetry, 'identical schedule retries must not consume KV deletes');

await post(kv, '/cancel', { deviceId: first.deviceId, jobId: first.jobId });
const statusAfterLateCancel = await (await post(kv, '/job-status', { deviceId: second.deviceId, jobId: second.jobId })).json();
assert.equal(statusAfterLateCancel.exists, true, 'a late cancel for an old generation must not delete the current task');

const productionChat = {
  deviceId: 'device-a', jobId: 'pro_device-a_char-a_production', charId: 'char-a',
  dueAt: futureIso(180), kind: 'chat', mode: 'dice'
};
const testChat = {
  deviceId: 'device-a', jobId: 'test_device-a_char-a_manual', charId: 'char-a',
  dueAt: futureIso(1), kind: 'chat', mode: 'planned', test: true
};
assert.equal((await post(kv, '/schedule', productionChat)).status, 200);
assert.equal((await post(kv, '/schedule', testChat)).status, 200);
assert.equal((await (await post(kv, '/job-status', { deviceId: 'device-a', jobId: productionChat.jobId })).json()).exists, true,
  'manual tests must not replace the production chat alarm');
assert.equal((await (await post(kv, '/job-status', { deviceId: 'device-a', jobId: testChat.jobId })).json()).exists, true,
  'manual tests must use an isolated logical slot');

console.log('Cloud timer logical singleton tests passed.');
