import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadLocalCloudflareToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return;
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
      return;
    }
  }
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

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/run-wrangler.mjs <wrangler args...>');
  process.exit(2);
}

loadLocalCloudflareToken();

if (args[0] === 'deploy' && !process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Missing CLOUDFLARE_API_TOKEN. Wrangler deploy cannot run non-interactively without it.');
  console.error('PowerShell: $env:CLOUDFLARE_API_TOKEN="your Cloudflare API token"');
  console.error('Or save it to %USERPROFILE%\\.codex\\secrets\\cloudflare-al-token.env');
  process.exit(2);
}

const command = wranglerCommand();
const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
});

process.exit(result.status || 0);
