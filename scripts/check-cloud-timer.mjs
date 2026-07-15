const EXPECTED_VERSION = '2026-07-15.14';
const DEFAULT_TIMEOUT_MS = 20000;

function normalizeEndpoint(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function timeoutMs() {
  const raw = Number(process.env.AL_TIMER_HEALTH_TIMEOUT_MS || process.env.TIMER_HEALTH_TIMEOUT_MS || 0);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

function friendlyFetchError(err) {
  const raw = String(err?.message || err || 'unknown error');
  const cause = String(err?.cause?.message || err?.cause?.code || '');
  const text = `${raw} ${cause}`;
  if (/timeout|timed out|UND_ERR_CONNECT_TIMEOUT|AbortError/i.test(text)) {
    return '连接云闹钟超时：请检查 Worker 地址、本机网络、代理或 DNS。';
  }
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|NetworkError/i.test(text)) {
    return '无法连接云闹钟：请检查 Worker 地址是否正确，以及当前终端网络能否访问 workers.dev。';
  }
  return raw;
}

async function fetchHealth(endpoint) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs());
  try {
    return await fetch(`${endpoint}/health`, { method: 'GET', signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const endpoint = normalizeEndpoint(process.argv[2] || process.env.AL_TIMER_ENDPOINT || process.env.TIMER_ENDPOINT || '');

if (!endpoint) {
  console.error('Usage: node scripts/check-cloud-timer.mjs <https://worker-url>');
  console.error('Or set AL_TIMER_ENDPOINT.');
  process.exit(2);
}

console.log(`Checking cloud timer: ${endpoint}/health`);

let resp;
try {
  resp = await fetchHealth(endpoint);
} catch (err) {
  console.error(friendlyFetchError(err));
  console.error(`Raw error: ${String(err?.message || err)}`);
  if (err?.cause) console.error(`Cause: ${String(err.cause?.code || err.cause?.message || err.cause)}`);
  process.exit(1);
}

if (!resp.ok) {
  const body = await resp.text().catch(() => '');
  console.error(`Cloud timer health failed: HTTP ${resp.status}${body ? ` ${body.slice(0, 180)}` : ''}`);
  process.exit(1);
}

const data = await resp.json();
const version = String(data.version || '');
console.log(`Cloud timer: ${data.service || 'unknown'} version=${version || 'unknown'}`);
if (data.cron?.finishedAt) {
  const at = new Date(data.cron.finishedAt).toISOString();
  console.log(`Cron: ok=${data.cron.ok !== false} last=${at} buckets=${data.cron.buckets || 0} jobs=${data.cron.jobsSeen || 0} delivered=${data.cron.delivered || 0} retry=${data.cron.retry || 0} failed=${data.cron.failed || 0}`);
} else {
  console.log('Cron: no execution record yet.');
}

if (version !== EXPECTED_VERSION) {
  console.error(`Expected version ${EXPECTED_VERSION}, got ${version || 'unknown'}. Deploy cloud-timer-worker.js.`);
  process.exit(1);
}

console.log('Cloud timer version is up to date.');
