import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const endpoint = (process.argv[2] || process.env.AL_TIMER_ENDPOINT || process.env.TIMER_ENDPOINT || '').replace(/\/+$/, '');

function loadLocalCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const candidates = [
    join(homedir(), '.codex', 'secrets', 'cloudflare-al-token.env'),
    join(homedir(), '.cloudflare', 'al-token.env')
  ];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const line = text.split(/\r?\n/).find(item => item.trim().startsWith('CLOUDFLARE_API_TOKEN='));
    if (!line) continue;
    const token = line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
    if (token) {
      process.env.CLOUDFLARE_API_TOKEN = token;
      return token;
    }
  }
  return '';
}

const token = loadLocalCloudflareToken();

if (!token) {
  console.error('Missing CLOUDFLARE_API_TOKEN.');
  console.error('PowerShell: $env:CLOUDFLARE_API_TOKEN="your Cloudflare API token"');
  console.error('Or save it to %USERPROFILE%\\.codex\\secrets\\cloudflare-al-token.env');
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
