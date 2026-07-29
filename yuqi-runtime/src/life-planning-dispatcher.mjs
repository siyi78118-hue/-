function classifyFailure(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  if (/timeout|temporar|network|capacity|429|503|unavailable/.test(text)) {
    return { retryable: true, failureClass: 'transient_provider' };
  }
  return { retryable: false, failureClass: 'deterministic' };
}

export class LifePlanningDispatcher {
  constructor({
    store,
    promotionController,
    executeAttempt,
    workerId = 'yuqi-life-planning',
    clock = Date.now,
    pollIntervalMs = 5_000,
    leaseMs = 300_000
  }) {
    if (!store || !promotionController || typeof executeAttempt !== 'function') {
      throw new Error('store, promotionController, and executeAttempt are required');
    }
    this.store = store;
    this.promotionController = promotionController;
    this.executeAttempt = executeAttempt;
    this.workerId = workerId;
    this.clock = clock;
    this.pollIntervalMs = pollIntervalMs;
    this.leaseMs = leaseMs;
    this.timer = null;
    this.inflight = null;
    this.stopping = false;
  }

  recover() {
    return this.store.recoverExpiredLifePlanningAttempts({ now: this.clock() });
  }

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => this.poke(), this.pollIntervalMs);
    this.timer.unref?.();
    this.poke();
  }

  poke() {
    if (this.stopping || this.inflight) return this.inflight;
    const operation = this.runOnce().finally(() => {
      if (this.inflight === operation) this.inflight = null;
    });
    this.inflight = operation;
    return operation;
  }

  async runOnce() {
    const attempt = this.store.claimDueLifePlanningAttempt({
      workerId: this.workerId,
      now: this.clock(),
      leaseMs: this.leaseMs
    });
    if (!attempt) return null;
    try {
      const validatedResult = await this.executeAttempt(attempt);
      return this.promotionController.commitLifePlanningAuthoritativeResult({
        planningId: attempt.planningId,
        workerId: this.workerId,
        validatedResult,
        now: this.clock()
      });
    } catch (error) {
      const classification = classifyFailure(error);
      if (classification.retryable && attempt.attemptCount < 3) {
        return this.store.retryLifePlanningAttempt({
          planningId: attempt.planningId,
          workerId: this.workerId,
          errorCode: error?.code || error?.name || 'LIFE_PROVIDER_TRANSIENT',
          nextDueAt: this.clock() + Math.min(10 * 60_000, 30_000 * (2 ** attempt.attemptCount)),
          now: this.clock()
        });
      }
      return this.promotionController.failLifePlanningAttempt({
        planningId: attempt.planningId,
        workerId: this.workerId,
        errorCode: error?.code || error?.name || 'LIFE_PLANNING_FAILED',
        failureClass: classification.failureClass,
        report: { summary: { message: String(error?.message || '').slice(0, 200) } },
        now: this.clock()
      });
    }
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.inflight) {
      try { await this.inflight; } catch {}
    }
  }
}
