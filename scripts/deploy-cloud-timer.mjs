import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const endpoint = (process.argv[2] || process.env.AL_TIMER_ENDPOINT || process.env.TIMER_ENDPOINT || '').replace(/\/+$/, '');
const token = process.env.CLOUDFLARE_API_TOKEN || '';

if (!token) {
  console.error('Missing CLOUDFLARE_API_TOKEN.');
  console.error('PowerShell: $env:CLOUDFLARE_API_TOKEN="your Cloudflare API token"');
  console.error('Then run: npm run cloud:deploy');
  process.exit(2);
}

function wranglerCommand() {
  if (process.env.WRANGLER_CMD) return process.env.WRANGLER_CMD;
  const userWrapper = 'C:\\Users\\Administrator\\Tools\\bin\\wrangler.cmd';
  if (process.platform === 'win32' && existsSync(userWrapper)) return userWrapper;
  const localWrapper = process.platform === 'win32'
    ? 'node_modules\\.bin\\wrangler.cmd'
    : 'node_modules/.bin/wrangler';
  if (existsSync(localWrapper)) return localWrapper;
  return 'wrangler';
}

const command = wranglerCommand();
console.log(`Deploying cloud timer with ${command} ...`);
const result = spawnSync(command, ['deploy'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

if (endpoint) {
  console.log('Checking deployed cloud timer...');
  const check = spawnSync(process.execPath, ['scripts/check-cloud-timer.mjs', endpoint], {
    stdio: 'inherit',
    env: process.env
  });
  process.exit(check.status || 0);
}

console.log('Deploy finished. Set AL_TIMER_ENDPOINT or pass the Worker URL to run the health check automatically.');
