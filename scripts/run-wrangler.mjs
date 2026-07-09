import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

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

if (args[0] === 'deploy' && !process.env.CLOUDFLARE_API_TOKEN) {
  console.error('Missing CLOUDFLARE_API_TOKEN. Wrangler deploy cannot run non-interactively without it.');
  console.error('PowerShell: $env:CLOUDFLARE_API_TOKEN="your Cloudflare API token"');
  process.exit(2);
}

const command = wranglerCommand();
const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: process.env
});

process.exit(result.status || 0);
