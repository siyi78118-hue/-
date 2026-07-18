import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-client.mjs';
import { createYuqiServer } from './local-server.mjs';
import { YuqiOrchestrator } from './orchestrator.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { YuqiStore } from './store.mjs';

const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.argv[2] || join(runtimeDir, 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = isAbsolute(config.databasePath || '')
  ? config.databasePath
  : resolve(runtimeDir, config.databasePath || 'data/yuqi-runtime.sqlite');
mkdirSync(dirname(databasePath), { recursive: true });

const store = new YuqiStore(databasePath);
const presets = new PresetRegistry({ presetDir: join(runtimeDir, 'presets'), store });
const codex = new CodexAppServerClient({
  store,
  command: config.codexCommand || 'codex',
  args: config.codexArgs || ['app-server'],
  cwd: config.codexRuntimeDirectory || runtimeDir
});
const orchestrator = new YuqiOrchestrator({ store, presets, codex, contextLimit: 200 });
const server = createYuqiServer({ secret: config.pairingSecret, store, orchestrator });

await server.listen({ host: config.host || '0.0.0.0', port: Number(config.port) || 17891 });
const address = server.address();
process.stdout.write(`Yuqi runtime listening on ${address.address}:${address.port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { await server.close(); } catch {}
  try { await codex.stop(); } catch {}
  store.close();
}
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
