const PROVIDERS = Object.freeze({
  turn: Object.freeze([
    ['legacy-v1', 'executeLegacyReleaseTurnDraft'],
    ['cognition-v2', 'runV2ReleaseDraft'],
    ['cognition-v3', 'runV3ReleaseDraft']
  ]),
  life: Object.freeze([
    ['legacy-v1', 'executeLegacyLifeReleaseDraft'],
    ['cognition-v2', 'executeCognitionV2LifeReleaseDraft'],
    ['cognition-v3', 'executeCognitionV3LifeReleaseDraft']
  ])
});

function boundAdapter(owner, method, adapterMethod) {
  if (!owner || typeof owner[method] !== 'function') {
    throw new Error(`production release provider is unavailable: ${method}`);
  }
  return {
    [adapterMethod]: input => owner[method](input)
  };
}

export function createProductionReleaseAdapters({ orchestrator, cognitivePipeline } = {}) {
  const turnAdapters = new Map(PROVIDERS.turn.map(([adapterId, method]) => [
    adapterId,
    boundAdapter(adapterId === 'legacy-v1' ? orchestrator : cognitivePipeline, method, 'executeTurn')
  ]));
  const lifeAdapters = new Map(PROVIDERS.life.map(([adapterId, method]) => [
    adapterId,
    boundAdapter(orchestrator, method, 'executeLife')
  ]));
  return { turnAdapters, lifeAdapters };
}
