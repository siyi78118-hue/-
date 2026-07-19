import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { resolveWranglerInvocation } from './wrangler-invocation.mjs';

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

const args = process.argv.slice(2);
if (!args.length) {
  console.error('Usage: node scripts/run-wrangler.mjs <wrangler args...>');
  process.exit(2);
}

loadLocalCloudflareToken();

const invocation = resolveWranglerInvocation();
const result = spawnSync(invocation.command, [...invocation.prefixArgs, ...args], {
  stdio: 'inherit',
  shell: invocation.shell,
  env: process.env
});

process.exit(result.status || 0);
