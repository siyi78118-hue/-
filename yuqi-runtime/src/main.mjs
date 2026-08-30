import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-client.mjs';
import { CognitivePipeline } from './cognitive-pipeline.mjs';
import { ConsolidationWorker } from './consolidation-worker.mjs';
import { CloudRelayPump } from './cloud-relay-pump.mjs';
import { createYuqiServer } from './local-server.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { PromotionController } from './promotion-controller.mjs';
import { YuqiReconciler } from './reconcile.mjs';
import { ResultOutbox } from './result-outbox.mjs';
import { selectTurnRoute } from './route-policy.mjs';
import { YuqiStore } from './store.mjs';
import { composeYuqiExecutionRuntime } from './runtime-composition.mjs';
import { FilePersonaEvolutionRepository } from './persona-evolution/file-repository.mjs';
import { ExperienceInterpreter } from './persona-evolution/experience-interpreter.mjs';
import { CodexExperienceInterpretationGenerator } from './persona-evolution/experience-interpretation-generator.mjs';
import { ExperienceInterpretationWorker } from './persona-evolution/experience-interpretation-worker.mjs';
import { ExperienceMemoryRetriever } from './persona-evolution/experience-memory-retriever.mjs';
import { StoreSessionConversationSource } from './persona-evolution/session-conversation-source.mjs';
import { CodexSessionSummaryGenerator } from './persona-evolution/session-summary-generator.mjs';
import { SessionSummarizer } from './persona-evolution/session-summarizer.mjs';
import { SessionSummaryWorker } from './persona-evolution/session-summary-worker.mjs';
import { createSystemCloudFetch } from '../../scripts/cloud-http.mjs';
import { createVerifiedYuqiBackup } from '../../scripts/backup-yuqi-memory.mjs';

const runtimeDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(process.argv[2] || join(runtimeDir, 'config.json'));
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const databasePath = isAbsolute(config.databasePath || '')
  ? config.databasePath
  : resolve(runtimeDir, config.databasePath || 'data/yuqi-runtime.sqlite');
const snapshotsDir = isAbsolute(config.snapshotsDir || '')
  ? config.snapshotsDir
  : resolve(runtimeDir, config.snapshotsDir || 'snapshots');
mkdirSync(dirname(databasePath), { recursive: true });

const store = new YuqiStore(databasePath);
store.repairTerminalCanonicalV3LaneOwnersInternal();
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
const executionRuntime = composeYuqiExecutionRuntime({
  store,
  presets,
  codex,
  cognitivePipeline,
  promotionController,
  contextLimit: 200,
  generationContextLimit: 20,
  roleProfiles: config.roleProfiles
});
const {
  orchestrator,
  turnDispatcher: dispatcher,
  lifePlanningDispatcher,
  shadowDispatcher
} = executionRuntime;
const reconciler = new YuqiReconciler({ store, codex });
const consolidationWorker = new ConsolidationWorker({
  store,
  codexClient: codex,
  presetRegistry: presets,
  workerId: 'yuqi-memory-consolidation'
});
const sessionSummaryConfig = config.sessionSummary || {};
const sessionSummaryEnabled = sessionSummaryConfig.enabled !== false;
const sessionSummaryRoot = isAbsolute(sessionSummaryConfig.rootDir || '')
  ? sessionSummaryConfig.rootDir
  : resolve(runtimeDir, sessionSummaryConfig.rootDir || 'local_data/persona');
const sessionSummaryLogger = event => {
  process.stdout.write(`[session-summary] ${JSON.stringify(event)}\n`);
};
const personaRepository = new FilePersonaEvolutionRepository({ rootDir: sessionSummaryRoot });
const experienceInterpreterConfig = config.experienceInterpreter || {};
const experienceInterpreterEnabled = experienceInterpreterConfig.enabled === true;
const experienceInterpreterLogger = event => {
  process.stdout.write(`[experience-interpretation] ${JSON.stringify(event)}\n`);
};
const experienceRoleIds = Array.isArray(experienceInterpreterConfig.roleIds)
  && experienceInterpreterConfig.roleIds.length
  ? experienceInterpreterConfig.roleIds
  : Array.isArray(sessionSummaryConfig.roleIds) && sessionSummaryConfig.roleIds.length
    ? sessionSummaryConfig.roleIds
    : ['yuqi'];
const configuredMemoryLimit = Number(experienceInterpreterConfig.memoryLimit);
const experienceInterpretationWorker = experienceInterpreterEnabled
  ? new ExperienceInterpretationWorker({
    repository: personaRepository,
    interpreter: new ExperienceInterpreter({
      repository: personaRepository,
      retriever: new ExperienceMemoryRetriever(),
      generator: new CodexExperienceInterpretationGenerator({
        codexClient: codex,
        model: experienceInterpreterConfig.model || 'gpt-5.6-sol',
        effort: experienceInterpreterConfig.effort || 'medium',
        turnTimeoutMs: Number(experienceInterpreterConfig.turnTimeoutMs) || 120_000
      }),
      memoryLimit: Number.isSafeInteger(configuredMemoryLimit) && configuredMemoryLimit >= 0
        ? configuredMemoryLimit
        : 8,
      logger: experienceInterpreterLogger
    }),
    roleIds: experienceRoleIds,
    sweepIntervalMs: Number(experienceInterpreterConfig.sweepIntervalMs) || 60 * 1000,
    logger: experienceInterpreterLogger
  })
  : null;
const sessionSummaryWorker = sessionSummaryEnabled ? new SessionSummaryWorker({
  source: new StoreSessionConversationSource({
    store,
    pageSize: Number(sessionSummaryConfig.pageSize) || 500
  }),
  summarizer: new SessionSummarizer({
    repository: personaRepository,
    generator: new CodexSessionSummaryGenerator({
      codexClient: codex,
      model: sessionSummaryConfig.model || 'gpt-5.6-sol',
      effort: sessionSummaryConfig.effort || 'medium',
      turnTimeoutMs: Number(sessionSummaryConfig.turnTimeoutMs) || 120_000
    }),
    maxInputBytes: Number(sessionSummaryConfig.maxInputBytes) || 64 * 1024,
    logger: sessionSummaryLogger
  }),
  roleIds: Array.isArray(sessionSummaryConfig.roleIds) && sessionSummaryConfig.roleIds.length
    ? sessionSummaryConfig.roleIds
    : ['yuqi'],
  idleTimeoutMs: Number(sessionSummaryConfig.idleTimeoutMs) || 30 * 60 * 1000,
  sweepIntervalMs: Number(sessionSummaryConfig.sweepIntervalMs) || 60 * 1000,
  logger: sessionSummaryLogger,
  onSummaryFinalized: event => experienceInterpretationWorker?.observeSummary(event)
}) : null;
dispatcher.setVisibleMessageObserver(event => sessionSummaryWorker?.observeVisibleMessage(event));
const explicitProxy = config.cloudRelay?.proxy?.enabled === true;
const cloudFetch = config.cloudRelay?.enabled
  ? (explicitProxy ? globalThis.fetch : createSystemCloudFetch())
  : null;
const createVerifiedBackup = ({ roleId, requestedAt, androidRoomHead }) =>
  createVerifiedYuqiBackup({
    databasePath,
    snapshotsDir,
    roleId,
    createdAt: requestedAt,
    androidRoomHead
  });
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
  createVerifiedBackup,
  fetchImpl: cloudFetch,
  proxyEnabled: explicitProxy
}) : null;
const server = createYuqiServer({
  secret: config.pairingSecret,
  store,
  orchestrator,
  dispatcher,
  reconciler,
  createVerifiedBackup,
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
experienceInterpretationWorker?.start();
sessionSummaryWorker?.start();
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
  try { sessionSummaryWorker?.stop(); await sessionSummaryWorker?.idle(); } catch {}
  try {
    experienceInterpretationWorker?.stop();
    await experienceInterpretationWorker?.idle();
  } catch {}
  try { shadowDispatcher.stop(); } catch {}
  try { cloudPump?.stop(); } catch {}
  try { await server.close(); } catch {}
  try { await codex.stop(); } catch {}
  store.close();
}
process.once('SIGINT', () => stop().finally(() => process.exit(0)));
process.once('SIGTERM', () => stop().finally(() => process.exit(0)));
