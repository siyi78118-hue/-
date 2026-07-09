const EXPECTED_VERSION = '2026-07-09.2';

const endpoint = (process.argv[2] || process.env.AL_TIMER_ENDPOINT || process.env.TIMER_ENDPOINT || '').replace(/\/+$/, '');

if (!endpoint) {
  console.error('Usage: node scripts/check-cloud-timer.mjs <https://worker-url>');
  console.error('Or set AL_TIMER_ENDPOINT.');
  process.exit(2);
}

const resp = await fetch(`${endpoint}/health`, { method: 'GET' });
if (!resp.ok) {
  console.error(`Cloud timer health failed: HTTP ${resp.status}`);
  process.exit(1);
}

const data = await resp.json();
const version = String(data.version || '');
console.log(`Cloud timer: ${data.service || 'unknown'} version=${version || 'unknown'}`);

if (version !== EXPECTED_VERSION) {
  console.error(`Expected version ${EXPECTED_VERSION}, got ${version || 'unknown'}. Deploy cloud-timer-worker.js.`);
  process.exit(1);
}

console.log('Cloud timer version is up to date.');
