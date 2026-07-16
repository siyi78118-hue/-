import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('./cloud-timer-worker.js', import.meta.url), 'utf8');
const workerModuleUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`;
const { default: cloudTimerWorker } = await import(workerModuleUrl);

const runDueJobsSource = workerSource.slice(
  workerSource.indexOf('async function runDueJobs'),
  workerSource.indexOf('async function getLastCron')
);
assert.doesNotMatch(runDueJobsSource, /\.list\s*\(/, 'cron delivery must remain bucket-driven');
assert.match(workerSource, /url\.pathname === '\/cancel-device-tasks'/);

function createPaginatedKv(entries, pageSize = 1) {
  const store = new Map(entries);
  const listCalls = [];

  return {
    store,
    listCalls,
    binding: {
      async get(key) {
        return store.get(key) ?? null;
      },

      async put(key, value) {
        store.set(key, value);
      },

      async delete(key) {
        store.delete(key);
      },

      async list({ prefix = '', cursor = '' } = {}) {
        listCalls.push({ prefix, cursor });
        const names = [...store.keys()]
          .filter(key => key.startsWith(prefix))
          .sort();
        const start = cursor ? Number(cursor) : 0;
        const page = names.slice(start, start + pageSize);
        const listComplete = start + pageSize >= names.length;
        return {
          keys: page.map(name => ({ name })),
          list_complete: listComplete,
          ...(listComplete ? {} : { cursor: String(start + pageSize) })
        };
      }
    }
  };
}

const fixture = createPaginatedKv([
  ['sub:device-a', '{"deviceId":"device-a"}'],
  ['sub:device-b', '{"deviceId":"device-b"}'],
  ['job:mom_device-a_char-1_a', '{"deviceId":"device-a","jobId":"mom_device-a_char-1_a","kind":"moment"}'],
  ['job:pro_device-a_char-1_b', '{"deviceId":"device-a","jobId":"pro_device-a_char-1_b","kind":"chat"}'],
  ['job:rpl_device-a_plan-1_200', '{"deviceId":"device-a","jobId":"rpl_device-a_plan-1_200","type":"role-plan","kind":"private_message"}'],
  ['job:mom_device-b_char-2_c', '{"deviceId":"device-b","jobId":"mom_device-b_char-2_c","kind":"moment"}'],
  ['job:test_device-a_char-1_d', '{"deviceId":"device-a","jobId":"test_device-a_char-1_d","kind":"chat","test":true}'],
  ['due:100', '["mom_device-a_char-1_a","mom_device-b_char-2_c"]'],
  ['due:101', '["pro_device-a_char-1_b"]'],
  ['due:102', '["mom_device-a_char-1_orphan"]'],
  ['due:103', '["test_device-a_char-1_d"]'],
  ['due:104', '["rpl_device-a_plan-1_200"]']
]);
const env = { AL_TIMER_KV: fixture.binding };

const response = await cloudTimerWorker.fetch(new Request('https://worker.example/cancel-device-tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'device-a' })
}), env);
const result = await response.json();

assert.equal(response.status, 200);
assert.deepEqual(result, {
  ok: true,
  deviceId: 'device-a',
  momentJobsDeleted: 1,
  chatJobsDeleted: 1,
  rolePlanJobsDeleted: 1,
  dueReferencesDeleted: 4,
  dueBucketsDeleted: 3,
  subscriptionPreserved: true
});
assert.equal(fixture.store.has('job:mom_device-a_char-1_a'), false);
assert.equal(fixture.store.has('job:pro_device-a_char-1_b'), false);
assert.equal(fixture.store.has('job:rpl_device-a_plan-1_200'), false);
assert.equal(fixture.store.has('job:mom_device-b_char-2_c'), true);
assert.equal(fixture.store.has('job:test_device-a_char-1_d'), true);
assert.equal(fixture.store.has('sub:device-a'), true);
assert.equal(fixture.store.has('sub:device-b'), true);
assert.equal(fixture.store.get('due:100'), '["mom_device-b_char-2_c"]');
assert.equal(fixture.store.has('due:101'), false);
assert.equal(fixture.store.has('due:102'), false);
assert.equal(fixture.store.get('due:103'), '["test_device-a_char-1_d"]');
assert.ok(
  fixture.listCalls.filter(call => call.prefix === 'due:').length > 1,
  'due buckets must be listed across every KV page'
);

const repeatedResponse = await cloudTimerWorker.fetch(new Request('https://worker.example/cancel-device-tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: 'device-a' })
}), env);
assert.equal(repeatedResponse.status, 200);
assert.deepEqual(await repeatedResponse.json(), {
  ok: true,
  deviceId: 'device-a',
  momentJobsDeleted: 0,
  chatJobsDeleted: 0,
  rolePlanJobsDeleted: 0,
  dueReferencesDeleted: 0,
  dueBucketsDeleted: 0,
  subscriptionPreserved: true
});

const invalidResponse = await cloudTimerWorker.fetch(new Request('https://worker.example/cancel-device-tasks', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceId: '../all' })
}), env);
assert.equal(invalidResponse.status, 400);
assert.match(String((await invalidResponse.json()).error || ''), /invalid deviceId/i);

console.log('Cloud device cleanup tests passed.');
