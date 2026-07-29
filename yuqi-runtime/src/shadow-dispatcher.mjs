export class ShadowDispatcher {
  constructor({
    store,
    cognitivePipeline,
    foregroundActivity,
    clock = Date.now,
    workerId = 'yuqi-shadow'
  }) {
    if (!store || !cognitivePipeline) throw new Error('store and cognitivePipeline are required');
    this.store = store;
    this.cognitivePipeline = cognitivePipeline;
    this.foregroundActivity = foregroundActivity || { isBusy: () => false };
    this.clock = clock;
    this.workerId = workerId;
    this.timer = null;
  }

  start(intervalMs = 1_000) {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.runOnce().catch(() => {});
    }, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.foregroundActivity?.isBusy?.()) return null;
    const claimed = this.store.claimDueConsolidationJob({
      workerId: this.workerId,
      jobTypes: ['shadow_cognition', 'active_canary_compare'],
      now: this.clock(),
      leaseMs: 300_000
    });
    if (!claimed) return null;
    const startedAt = this.clock();
    try {
      const result = await this.cognitivePipeline.runShadow(claimed.payload);
      this.store.completeConsolidationJob({
        jobId: claimed.jobId,
        workerId: this.workerId,
        now: this.clock()
      });
      this.store.putDiagnostic?.({
        turnId: claimed.turnId,
        stage: 'shadow_cognition',
        detail: {
          latencyMs: this.clock() - startedAt,
          draftChecksum: result?.draft?.draftChecksum || '',
          action: result?.draft?.action || ''
        }
      });
      return result;
    } catch (error) {
      const attempt = Number(claimed.attemptCount || 1);
      const delays = [300_000, 1_800_000];
      this.store.failConsolidationJob({
        jobId: claimed.jobId,
        workerId: this.workerId,
        now: this.clock(),
        errorCode: String(error?.code || error?.name || 'SHADOW_FAILED'),
        nextDueAt: attempt <= delays.length ? this.clock() + delays[attempt - 1] : this.clock()
      });
      return null;
    }
  }
}
