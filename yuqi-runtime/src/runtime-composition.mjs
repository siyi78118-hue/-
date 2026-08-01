import { LifePlanningDispatcher } from './life-planning-dispatcher.mjs';
import { YuqiOrchestrator } from './orchestrator.mjs';
import { createProductionReleaseAdapters } from './production-release-adapters.mjs';
import { ReleaseExecutor } from './release-executor.mjs';
import { ShadowDispatcher } from './shadow-dispatcher.mjs';
import { TurnDispatcher } from './turn-dispatcher.mjs';

export function composeYuqiExecutionRuntime(input = {}) {
  const orchestrator = new YuqiOrchestrator({
    ...input,
    releaseExecutor: null,
    lifePlanningDispatcher: null
  });
  const adapters = createProductionReleaseAdapters({
    orchestrator,
    cognitivePipeline: input.cognitivePipeline
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
      execution => input.cognitivePipeline.runShadow(execution),
    foregroundActivity: { isBusy: () => turnDispatcher.inflight.size > 0 }
  });
  return Object.freeze({
    releaseExecutor,
    orchestrator,
    turnDispatcher,
    lifePlanningDispatcher,
    shadowDispatcher
  });
}
