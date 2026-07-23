const HOUR = 60 * 60_000;

export class LifeSimulationCoordinator {
  constructor({ store, planningThresholdMs = 6 * HOUR, targetPlanMs = 12 * HOUR } = {}) {
    if (!store) throw new Error('life simulation store is required');
    this.store = store;
    this.planningThresholdMs = Math.max(HOUR, Number(planningThresholdMs) || 6 * HOUR);
    this.targetPlanMs = Math.max(this.planningThresholdMs, Number(targetPlanMs) || 12 * HOUR);
  }

  ensureHorizon(characterId, now = Date.now()) {
    return this.store.listLifeEpisodes(characterId, { from: Number(now) });
  }

  advanceTo(characterId, now = Date.now()) {
    this.store.retireLegacyGeneratedLifeEpisodes(characterId, now);
    this.store.advanceLifeState(characterId, now, { timezone: 'Asia/Shanghai' });
    return this.contextFor(characterId, now);
  }

  contextFor(characterId, now = Date.now()) {
    const episodes = this.store.listLifeEpisodes(characterId);
    const activeEpisodes = episodes.filter(item => item.status !== 'cancelled');
    const current = activeEpisodes.find(item => item.startAt <= now && item.endAt > now) || null;
    const recent = activeEpisodes.filter(item => item.endAt <= now).slice(-3);
    const upcoming = activeEpisodes.filter(item => item.startAt >= now).slice(0, 3);
    const horizonEndAt = activeEpisodes.reduce(
      (maximum, item) => Math.max(maximum, item.endAt),
      0
    ) || null;
    const planWindowStartAt = Math.max(Number(now), Number(horizonEndAt || 0));
    return {
      computedAt: Number(now),
      timezone: 'Asia/Shanghai',
      current,
      recent,
      upcoming,
      revision: this.store.getCharacterLifeState(characterId)?.revision || 0,
      horizonEndAt,
      planWindowStartAt,
      targetPlanEndAt: planWindowStartAt + this.targetPlanMs,
      needsPlan: !horizonEndAt || horizonEndAt - Number(now) < this.planningThresholdMs
    };
  }

  applyAdjustment(characterId, adjustment, turnId, now = Date.now()) {
    return this.store.transaction(() => (
      this.store.applyLifeAdjustment(characterId, adjustment, turnId, now)
    ));
  }
}
