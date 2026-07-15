import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const workerSource = await readFile(new URL('./cloud-timer-worker.js', import.meta.url), 'utf8');
const workerModuleUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}#quota-recovery`;
const { default: cloudTimerWorker } = await import(workerModuleUrl);

class FakeKV {
  constructor({ failPut } = {}) {
    this.rows = new Map();
    this.puts = [];
    this.failPut = failPut;
  }

  async get(key) {
    return this.rows.get(key) ?? null;
  }

  async put(key, value) {
    this.puts.push({ key, value: String(value) });
    if (this.failPut?.(key)) throw new Error('KV put() limit exceeded for the day.');
    this.rows.set(key, String(value));
  }

  async delete(key) {
    this.rows.delete(key);
  }
}

function envFor(kv) {
  return { AL_TIMER_KV: kv };
}

async function post(env, path, body) {
  return cloudTimerWorker.fetch(new Request(`https://worker.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }), env);
}

async function runCron(env) {
  const pending = [];
  await cloudTimerWorker.scheduled({}, env, { waitUntil(promise) { pending.push(promise); } });
  await Promise.all(pending);
}

const quotaKv = new FakeKV({ failPut: key => key.startsWith('job:') });
const quotaResponse = await post(envFor(quotaKv), '/schedule', {
  deviceId: 'device-a',
  jobId: 'pro_device-a_char-a_quota',
  charId: 'char-a',
  dueAt: new Date(Date.now() + 600000).toISOString(),
  kind: 'chat'
});
const quotaJson = await quotaResponse.json();
assert.equal(quotaResponse.status, 429, 'daily KV write exhaustion must be retryable, not a generic 400');
assert.equal(quotaJson.code, 'KV_DAILY_WRITE_LIMIT');
assert.match(quotaJson.error, /KV.*(?:额度|limit)/i);
assert.ok(Date.parse(quotaJson.retryAt) > Date.now(), 'quota response must tell the app when writes reset');

const idleKv = new FakeKV();
const originalDateNow = Date.now;
const realMinute = Math.floor(originalDateNow() / 60000);
const hourStartMinute = realMinute - (realMinute % 60);
try {
  for (let offset = 0; offset < 60; offset += 1) {
    Date.now = () => (hourStartMinute + offset) * 60000;
    await runCron(envFor(idleKv));
  }
} finally {
  Date.now = originalDateNow;
}
assert.equal(
  idleKv.puts.filter(row => row.key === 'meta:lastCron').length,
  1,
  'sixty idle cron invocations must persist at most one health heartbeat'
);

const scheduleKv = new FakeKV();
const scheduleResponse = await post(envFor(scheduleKv), '/schedule', {
  deviceId: 'device-a',
  jobId: 'pro_device-a_char-a_normal',
  charId: 'char-a',
  dueAt: new Date(Date.now() + 600000).toISOString(),
  kind: 'chat'
});
assert.equal(scheduleResponse.status, 200);
assert.equal(
  scheduleKv.puts.some(row => row.key === 'meta:recentEvents'),
  false,
  'routine schedule success must not spend another KV write on diagnostics'
);

const html = await readFile(new URL('./tavern-app/index.html', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('./tavern-app/sw-v11.js', import.meta.url), 'utf8');
const scheduleFunction = html.match(/async function scheduleCloudProactive\([\s\S]*?\n}\nasync function resubmitCloudProactive/)?.[0] || '';
const postFunction = html.match(/async function postCloudSchedule\([\s\S]*?\n}\nasync function verifyCloudJobStatus/)?.[0] || '';
assert.match(postFunction, /await\s+cloudTimerResponseError\(resp/,
  'the app must parse the Worker error body instead of showing only HTTP status');
assert.match(html, /KV_DAILY_WRITE_LIMIT/,
  'the app must recognize the Worker daily quota error code');
assert.match(scheduleFunction, /isCloudTimerQuotaError\(err\)[\s\S]*cloudTimerQuotaRetryAt/,
  'quota errors must preserve the local job and save a cloud retry deadline');
assert.match(scheduleFunction, /isCloudTimerQuotaError\(err\)[\s\S]*return true;/,
  'quota errors must not fall through to the normal local-job rollback');
assert.match(html, /cloudTimerQuotaPauseActive\(\)/,
  'foreground recovery must suppress repeated cloud writes before quota reset');
assert.match(serviceWorker, /isCloudTimerQuotaError\(err\)[\s\S]*cloudTimerQuotaRetryAt[\s\S]*return true;/,
  'service-worker recovery must preserve its local job when the daily quota is exhausted');

console.log('Cloud timer quota recovery tests passed.');
