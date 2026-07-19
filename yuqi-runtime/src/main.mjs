import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-client.mjs';
import { CloudRelayPump } from './cloud-relay-pump.mjs';
import { createYuqiServer } from './local-server.mjs';
import { YuqiOrchestrator } from './orchestrator.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { YuqiReconciler } from './reconcile.mjs';
import { YuqiStore } from './store.mjs';
import { createSystemCloudFetch } from '../../scripts/cloud-http.mjs';

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
const reconciler = new YuqiReconciler({ store, codex });
const server = createYuqiServer({ secret: config.pairingSecret, store, orchestrator, reconciler });
const cloudPump = config.cloudRelay?.enabled ? new CloudRelayPump({
  relayUrl: config.cloudRelay.url,
  deviceId: config.cloudRelay.deviceId,
  deviceToken: config.cloudRelay.deviceToken,
  encryptionKeyBase64: config.cloudRelay.encryptionKeyBase64,
  orchestrator,
  reconciler,
  fetchImpl: createSystemCloudFetch()
}) : null;

await server.listen({ host: config.host || '0.0.0.0', port: Number(config.port) || 17891 });
cloudPump?.start(config.cloudRelay.pollIntervalMs || 1500);
const address = server.address();
process.stdout.write(`Yuqi runtime listening on ${address.address}:${address.port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try { cloudPump?.stop(); } catch {}
  try { await server.close(); } catch {}
  try { await codex.stop(); } catch {}
  store.close();
}
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
