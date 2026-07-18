import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from '../yuqi-runtime/src/codex-client.mjs';
import { YuqiStore } from '../yuqi-runtime/src/store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = join(root, 'yuqi-runtime');
const configPath = resolve(process.argv[2] || join(runtimeDir, 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = isAbsolute(config.databasePath) ? config.databasePath : resolve(runtimeDir, config.databasePath);
const store = new YuqiStore(databasePath);
const client = new CodexAppServerClient({
  store,
  command: config.codexCommand || 'codex',
  args: config.codexArgs || ['app-server'],
  cwd: config.codexRuntimeDirectory || root,
  requestTimeoutMs: 30_000
});

try {
  const sessions = {};
  for (const role of ['memory', 'brain', 'supervisor']) sessions[role] = await client.ensureThread(role);
  process.stdout.write(`${JSON.stringify({ ok: true, roles: Object.keys(sessions), isolated: new Set(Object.values(sessions)).size === 3 })}\n`);
} finally {
  await client.stop();
  store.close();
}
