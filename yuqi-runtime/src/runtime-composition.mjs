import { LifePlanningDispatcher } from './life-planning-dispatcher.mjs';
import { YuqiOrchestrator } from './orchestrator.mjs';
import { createProductionReleaseAdapters } from './production-release-adapters.mjs';
import { ReleaseExecutor, supportsPipelineVersion } from './release-executor.mjs';
import { ShadowDispatcher } from './shadow-dispatcher.mjs';
import { TurnDispatcher } from './turn-dispatcher.mjs';
import { contentHash } from './protocol.mjs';
import { CognitivePipeline } from './cognitive-pipeline.mjs';
import { PresetRegistry } from './preset-registry.mjs';
import { PromotionController } from './promotion-controller.mjs';
import { YuqiStore } from './store.mjs';
import {
  createQualityPhaseClientRouter,
  qualityPhaseClientSlotHasLedger,
  isQualityPhaseClientSlot,
} from './quality-replay-ledger.mjs';

const PRODUCTION_RUNTIME_BRAND = new WeakSet();
const PRODUCTION_RUNTIME_METADATA = new WeakMap();
const QUALITY_RUNTIME_SLOT = new WeakMap();

function assertSourceHead(value) {
  if (value == null || value === '') return null;
  const sourceHead = String(value);
  if (!/^[0-9a-f]{40}$/i.test(sourceHead)) {
    throw new Error('production runtime sourceHead must be a 40-character git commit');
  }
  return sourceHead.toLowerCase();
}

function releaseMatches(actual, expected, label) {
  if (!expected) return;
  if (!actual || String(actual.releaseId) !== String(expected.releaseId)
    || String(actual.releaseChecksum) !== String(expected.releaseChecksum)) {
    throw new Error(`production runtime ${label} release authority conflict`);
  }
  if (!supportsPipelineVersion(actual.pipelineVersion)) {
    throw new Error(`production runtime ${label} adapter authority conflict`);
  }
  if (expected.manifest != null) {
    const actualManifest =
      actual.manifest ?? actual.componentManifest ?? actual.components ?? null;
    if (contentHash(actualManifest) !== contentHash(expected.manifest)) {
      throw new Error(`production runtime ${label} release manifest conflict`);
    }
  }
}

export function assertProductionRuntimeAttestation(runtime, expected = {}) {
  if (!runtime || typeof runtime !== 'object' || !PRODUCTION_RUNTIME_BRAND.has(runtime)) {
    throw new Error('production runtime attestation is required');
  }
  const metadata = PRODUCTION_RUNTIME_METADATA.get(runtime);
  if (!metadata || metadata.store !== runtime.store) {
    throw new Error('production runtime attestation is invalid');
  }
  if (!(metadata.store instanceof YuqiStore)
    || !(runtime.orchestrator instanceof YuqiOrchestrator)
    || !(runtime.releaseExecutor instanceof ReleaseExecutor)
    || !(runtime.orchestrator.cognitivePipeline instanceof CognitivePipeline)
    || !(runtime.orchestrator.presets instanceof PresetRegistry)
    || !(runtime.orchestrator.promotionController instanceof PromotionController)) {
    throw new Error('production runtime dependencies are not authentic');
  }
  const expectedSourceHead = assertSourceHead(expected.sourceHead);
  if (expectedSourceHead != null && metadata.sourceHead !== expectedSourceHead) {
    throw new Error('production runtime sourceHead authority conflict');
  }
  if (runtime.releaseExecutor !== metadata.releaseExecutor
    || runtime.releaseExecutor.executeTurn !== metadata.executeTurn
    || runtime.releaseExecutor.executeLife !== metadata.executeLife
    || runtime.releaseExecutor.adapterIds !== metadata.adapterIdsMethod) {
    throw new Error('production runtime release executor authority conflict');
  }
  if (runtime.store?.getPipelineRelease !== metadata.getPipelineRelease) {
    throw new Error('production runtime store authority conflict');
  }
  const adapters = runtime.releaseExecutor?.adapterIds?.();
  const required = ['legacy-v1', 'cognition-v2', 'cognition-v3'];
  if (!adapters || JSON.stringify(adapters.turn) !== JSON.stringify(required)
    || JSON.stringify(adapters.life) !== JSON.stringify(required)) {
    throw new Error('production runtime adapter authority conflict');
  }
  const releaseIds = expected.releaseIds || {};
  const stableReleaseId = releaseIds.stableReleaseId || expected.stableRelease?.releaseId;
  const candidateReleaseId = releaseIds.candidateReleaseId || expected.candidateRelease?.releaseId;
  const stable = stableReleaseId
    ? metadata.store.getPipelineRelease(stableReleaseId)
    : null;
  const candidate = candidateReleaseId
    ? metadata.store.getPipelineRelease(candidateReleaseId)
    : null;
  releaseMatches(stable, expected.stableRelease, 'stable');
  releaseMatches(candidate, expected.candidateRelease, 'candidate');
  if (expected.stableRelease && !stable) throw new Error('production runtime stable release is missing');
  if (expected.candidateRelease && !candidate) throw new Error('production runtime candidate release is missing');
  if (expected.candidateRelease) {
    if (typeof runtime.orchestrator.presets.pipelineReleaseManifest !== 'function') {
      throw new Error('production runtime candidate manifest authority is unavailable');
    }
    const manifest = runtime.orchestrator.presets.pipelineReleaseManifest(
      candidate.presetVersion,
      stable?.releaseId || expected.stableRelease?.releaseId,
      {
        modelProfile: candidate.modelProfile,
        cognitionSchemaVersion: candidate.cognitionSchemaVersion,
        expressionSchemaVersion: candidate.expressionSchemaVersion,
        evaluatorVersion: candidate.evaluatorVersion,
      }
    );
    const storedManifest = candidate.componentManifest || {};
    const manifestMatches = contentHash(storedManifest) === contentHash(manifest)
      || contentHash(storedManifest) === contentHash(manifest.components);
    if (!manifestMatches
      || contentHash(candidate.modelProfile) !== contentHash(manifest.modelProfile)
      || String(manifest.checksum || '').length !== 64) {
      throw new Error('production runtime candidate component authority conflict');
    }
  }
  return Object.freeze({
    attestationVersion: 1,
    sourceHead: metadata.sourceHead,
    adapterIds: {
      turn: [...adapters.turn],
      life: [...adapters.life],
    },
    stableReleaseId: stable?.releaseId || null,
    candidateReleaseId: candidate?.releaseId || null,
  });
}

export function assertQualityPhaseClientSlot(runtime, slot) {
  if (!runtime || !PRODUCTION_RUNTIME_BRAND.has(runtime)
    || !isQualityPhaseClientSlot(slot)
    || QUALITY_RUNTIME_SLOT.get(runtime) !== slot) {
    throw new Error('quality runtime phase slot identity conflict');
  }
  return true;
}

export function composeYuqiExecutionRuntime(input = {}) {
  if (input.qualityPhaseClientSlot !== undefined
    && !isQualityPhaseClientSlot(input.qualityPhaseClientSlot)) {
    throw new Error('quality runtime phase slot is not authentic');
  }
  if (input.qualityPhaseClientSlot !== undefined
    && !qualityPhaseClientSlotHasLedger(input.qualityPhaseClientSlot)) {
    throw new Error('quality runtime phase ledger identity is required');
  }
  const qualityRouter = input.qualityPhaseClientSlot === undefined
    ? null
    : createQualityPhaseClientRouter(input.qualityPhaseClientSlot);
  const sourcePipeline = input.cognitivePipeline;
  const cognitivePipeline = qualityRouter && sourcePipeline instanceof CognitivePipeline
    ? new CognitivePipeline({
      store: input.store,
      codexClient: qualityRouter,
      presetRegistry: sourcePipeline.presetRegistry,
      routePolicy: sourcePipeline.routePolicy,
      clock: sourcePipeline.clock,
      diagnostics: sourcePipeline.diagnostics,
      contextBuilder: sourcePipeline.contextBuilder,
    })
    : sourcePipeline;
  const orchestrator = new YuqiOrchestrator({
    ...input,
    codex: qualityRouter || input.codex,
    cognitivePipeline,
    releaseExecutor: null,
    lifePlanningDispatcher: null
  });
  const adapters = createProductionReleaseAdapters({
    orchestrator,
    cognitivePipeline,
  });
  const releaseExecutor = new ReleaseExecutor({
    store: input.store,
    ...adapters
  });
  orchestrator.attachReleaseExecutor(releaseExecutor);
  const turnDispatcher = new TurnDispatcher({
    store: input.store,
    orchestrator
  });
  const lifePlanningDispatcher = new LifePlanningDispatcher({
    store: input.store,
    promotionController: input.promotionController,
    releaseExecutor,
    buildExecution: attempt => orchestrator.buildLifePlanningReleaseExecution(attempt)
  });
  orchestrator.setLifePlanningDispatcher(lifePlanningDispatcher);
  const shadowDispatcher = new ShadowDispatcher({
    store: input.store,
    releaseExecutor,
    promotionController: input.promotionController,
    legacyVersionZeroComparisonExecutor:
      execution => cognitivePipeline.runShadow(execution),
    foregroundActivity: { isBusy: () => turnDispatcher.inflight.size > 0 }
  });
  const runtime = Object.freeze({
    store: input.store,
    releaseExecutor,
    orchestrator,
    turnDispatcher,
    lifePlanningDispatcher,
    shadowDispatcher
  });
  PRODUCTION_RUNTIME_BRAND.add(runtime);
  if (input.qualityPhaseClientSlot !== undefined) {
    QUALITY_RUNTIME_SLOT.set(runtime, input.qualityPhaseClientSlot);
  }
  PRODUCTION_RUNTIME_METADATA.set(runtime, Object.freeze({
    store: input.store,
    sourceHead: assertSourceHead(input.sourceHead),
    releaseExecutor,
    executeTurn: releaseExecutor.executeTurn,
    executeLife: releaseExecutor.executeLife,
    adapterIdsMethod: releaseExecutor.adapterIds,
    getPipelineRelease: input.store?.getPipelineRelease,
  }));
  return runtime;
}
