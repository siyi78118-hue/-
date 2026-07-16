import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./cloud-timer-worker.js', import.meta.url), 'utf8');
const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#role-plans`);

class FakeKV {
  constructor() { this.rows = new Map(); }
  async get(key) { return this.rows.get(key) ?? null; }
  async put(key, value) { this.rows.set(key, String(value)); }
  async delete(key) { this.rows.delete(key); }
}

async function post(kv, path, body) {
  return worker.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }), { AL_TIMER_KV: kv });
}

const future = minutes => new Date(Date.now() + minutes * 60000).toISOString();
const kv = new FakeKV();
const first = {
  deviceId: 'device-a', jobId: 'rpl_device-a_plan-1_100', planId: 'plan-1', occurrenceId: 'plan-1:100',
  charId: 'char-a', type: 'role-plan', kind: 'private_message', source: 'spoken', dueAt: future(30)
};
const second = {
  deviceId: 'device-a', jobId: 'rpl_device-a_plan-2_200', planId: 'plan-2', occurrenceId: 'plan-2:200',
  charId: 'char-a', type: 'role-plan', kind: 'moment_post', source: 'private_decision', dueAt: future(60)
};

assert.equal((await post(kv, '/schedule', first)).status, 200);
assert.equal((await post(kv, '/schedule', second)).status, 200);
assert.deepEqual(
  [...kv.rows.keys()].filter(key => key.startsWith('job:rpl_')).sort(),
  [`job:${first.jobId}`, `job:${second.jobId}`].sort(),
  'role plans for one character must coexist'
);
assert.equal([...kv.rows.keys()].filter(key => key.startsWith('active:role-plan:')).length, 2);

await post(kv, '/cancel', { deviceId: 'device-a', jobId: first.jobId });
assert.equal(kv.rows.has(`job:${first.jobId}`), false);
assert.equal(kv.rows.has(`job:${second.jobId}`), true, 'cancelling one plan must not cancel another');

const leaked = await post(kv, '/schedule', { ...first, jobId: 'rpl_device-a_leaked', intent: '起床后发早安' });
assert.equal(leaked.status, 400);
assert.match((await leaked.json()).error, /ROLE_PLAN_PAYLOAD_NOT_MINIMAL/);

const stored = JSON.stringify([...kv.rows.values()]);
assert.equal(stored.includes('起床后发早安'), false);
console.log('Cloud role plan tests passed.');
