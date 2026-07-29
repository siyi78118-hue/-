import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-client.mjs';
import { CognitivePipeline } from './cognitive-pipeline.mjs';
import { ConsolidationWorker } from './consolidation-worker.mjs';
import { CloudRelayPump } from './cloud-relay-pump.mjs';
import { createYuqiServer } from './local-server.mjs';
import { YuqiOrchestrator } from './orchestrator.mjs';
import { LifePlanningDispatcher } from './life-planning-dispatcher.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { PromotionController } from './promotion-controller.mjs';
import { YuqiReconciler } from './reconcile.mjs';
import { ResultOutbox } from './result-outbox.mjs';
import { selectTurnRoute } from './route-policy.mjs';
import { ShadowDispatcher } from './shadow-dispatcher.mjs';
import { YuqiStore } from './store.mjs';
import { TurnDispatcher } from './turn-dispatcher.mjs';
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
const promotionController = new PromotionController({
  store,
  presetRegistry: presets,
  bootstrap: config.cognitionRuntime?.rolloutBootstrap || {}
});
promotionController.initialize();
const codex = new CodexAppServerClient({
  store,
  command: config.codexCommand || 'codex',
  args: config.codexArgs || ['app-server'],
  cwd: config.codexRuntimeDirectory || runtimeDir
});
const cognitivePipeline = new CognitivePipeline({
  store,
  codexClient: codex,
  presetRegistry: presets,
  routePolicy: selectTurnRoute
});
const orchestrator = new YuqiOrchestrator({
  store,
  presets,
  codex,
  cognitivePipeline,
  promotionController,
  contextLimit: 200,
  generationContextLimit: 20,
  roleProfiles: config.roleProfiles
});
const lifePlanningDispatcher = new LifePlanningDispatcher({
  store,
  promotionController,
  executeAttempt: attempt => orchestrator.executeLifePlanningAttempt(attempt)
});
orchestrator.setLifePlanningDispatcher(lifePlanningDispatcher);
const reconciler = new YuqiReconciler({ store, codex });
const dispatcher = new TurnDispatcher({ store, orchestrator });
const consolidationWorker = new ConsolidationWorker({
  store,
  codexClient: codex,
  presetRegistry: presets,
  workerId: 'yuqi-memory-consolidation'
});
const shadowDispatcher = new ShadowDispatcher({
  store,
  cognitivePipeline,
  promotionController,
  foregroundActivity: { isBusy: () => dispatcher.inflight.size > 0 }
});
const explicitProxy = config.cloudRelay?.proxy?.enabled === true;
const cloudFetch = config.cloudRelay?.enabled
  ? (explicitProxy ? globalThis.fetch : createSystemCloudFetch())
  : null;
const resultOutbox = config.cloudRelay?.enabled ? new ResultOutbox({
  relayUrl: config.cloudRelay.url,
  deviceId: config.cloudRelay.deviceId,
  deviceToken: config.cloudRelay.deviceToken,
  encryptionKeyBase64: config.cloudRelay.encryptionKeyBase64,
  store,
  fetchImpl: cloudFetch
}) : null;
let cloudPump = config.cloudRelay?.enabled ? new CloudRelayPump({
  relayUrl: config.cloudRelay.url,
  deviceId: config.cloudRelay.deviceId,
  deviceToken: config.cloudRelay.deviceToken,
  encryptionKeyBase64: config.cloudRelay.encryptionKeyBase64,
  orchestrator,
  dispatcher,
  store,
  outbox: resultOutbox,
  reconciler,
  fetchImpl: cloudFetch,
  proxyEnabled: explicitProxy
}) : null;
const server = createYuqiServer({
  secret: config.pairingSecret,
  store,
  orchestrator,
  dispatcher,
  reconciler,
  getCloudRelayStatus: () => cloudPump?.status() || {
    enabled: false,
    proxyEnabled: explicitProxy,
    connected: false,
    lastSuccessAt: 0,
    lastErrorAt: 0,
    lastError: '',
    pendingProcessed: 0
  }
});

await server.listen({ host: config.host || '0.0.0.0', port: Number(config.port) || 17891 });
dispatcher.recover();
lifePlanningDispatcher.recover();
lifePlanningDispatcher.start();
consolidationWorker.start();
shadowDispatcher.start();
cloudPump?.start(config.cloudRelay.pollIntervalMs || 1500);
function checkLifePlanning() {
  orchestrator.ensureLifePlan('yuqi', Date.now()).catch(error => {
    store.putDiagnostic({
      turnId: null,
      stage: 'life_planning',
      level: 'error',
      detail: { name: error.name, message: error.message }
    });
  });
}
checkLifePlanning();
const lifeBoundaryTimer = setInterval(checkLifePlanning, 60_000);
lifeBoundaryTimer.unref?.();
const address = server.address();
process.stdout.write(`Yuqi runtime listening on ${address.address}:${address.port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(lifeBoundaryTimer);
  try { await lifePlanningDispatcher.stop(); } catch {}
  try { await consolidationWorker.stop(); } catch {}
  try { shadowDispatcher.stop(); } catch {}
  try { cloudPump?.stop(); } catch {}
  try { await server.close(); } catch {}
  try { await codex.stop(); } catch {}
  store.close();
}
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
